'use strict';

// PLAN-TASK-009 (Phase A): route-kind-aware target resolution.
//
// Document routes resolve a SINGLE-FILE target identity (deriveTargetKey over the
// normalized target path) exactly as before — unchanged behavior. PR/CODE routes
// resolve a FILE-SET target identity instead: the parser exposes `invocation.base`
// (PR) or `invocation.scopes` (CODE), NOT `invocation.target`, so calling
// deriveTargetKey/computeFingerprint on the undefined single-file target would crash
// or misbehave. This module is the single source of truth both `index.js` and
// `helpers.js` consume so neither dispatcher path reaches a single-file resolver
// with `target: undefined`.
//
// The file-set TARGET KEY derived here is intentionally cheap and synchronous: it
// hashes the route kind plus the stable base/scope identity (NOT the live git diff
// or working-tree file set). The live file set + its fingerprint are resolved and
// persisted only in start.js (Phase B), through the PLAN-TASK-003/004 helpers. This
// keeps workflowBase() synchronous so every existing document-route call path stays
// byte-for-byte unchanged.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  deriveTargetKey,
  deriveR2pTargetKey,
  resolveProjectRoot
} = require('../target-state');
const {
  normalizeCodeScopesForIdentity,
  normalizeCodeUserExcludesForIdentity,
  hasSymlinkSegmentFromReqToPlan,
  isRequirementDirShape,
  projectRootFromRequirementDir
} = require('../target-context');
const { stableJson } = require('./serialization');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function failR2pPreflight(blockingReason, message, nextAction, code = 'ERR_R2P_PREFLIGHT') {
  const error = new Error(message);
  error.code = code;
  error.blockingReason = blockingReason;
  error.nextAction = nextAction;
  throw error;
}

function routeKindFor(parsed) {
  return (parsed && parsed.invocation && parsed.invocation.routeKind) || 'document';
}

function isFileSetRoute(parsed) {
  const kind = routeKindFor(parsed);
  return kind === 'pr' || kind === 'code' || kind === 'r2p';
}

function resolveExistingDirectory(candidate) {
  let stats;
  try {
    stats = fs.statSync(candidate);
  } catch {
    fail('ERR_FILE_SET_ROOT_MISSING', `project root must exist: ${candidate}`);
  }
  if (!stats.isDirectory()) {
    fail('ERR_FILE_SET_ROOT_MISSING', `project root must be a directory: ${candidate}`);
  }
  return fs.realpathSync.native(candidate);
}

function resolveExistingRealDirectory(candidate, { blockingReason, missingMessage, unsafeMessage, nextAction, code }) {
  let stats;
  try {
    stats = fs.lstatSync(candidate);
  } catch {
    failR2pPreflight(blockingReason, missingMessage, nextAction, code);
  }
  if (stats.isSymbolicLink()) {
    failR2pPreflight(blockingReason, unsafeMessage, nextAction, code);
  }
  if (!stats.isDirectory()) {
    failR2pPreflight(blockingReason, missingMessage, nextAction, code);
  }
  return fs.realpathSync.native(candidate);
}

function assertDirectChildPath(candidatePath, parentPath, code) {
  const relative = path.relative(parentPath, candidatePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    fail(code, `unsafe r2p path outside expected parent: ${candidatePath}`);
  }
}

function gitTopLevel(candidate) {
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: candidate,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return topLevel ? fs.realpathSync.native(topLevel) : null;
  } catch {
    return null;
  }
}

function pathMissing(candidate) {
  try {
    fs.statSync(candidate);
    return false;
  } catch (error) {
    return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
  }
}

function directoryExists(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function resolvePrProjectRoot(parsed, options = {}) {
  const cwd = options.cwd || process.cwd();
  const explicitRoot = parsed.invocation.root;
  const candidate = explicitRoot ? path.resolve(explicitRoot) : path.resolve(cwd);
  const candidateRoot = resolveExistingDirectory(candidate);
  const repoRoot = gitTopLevel(candidateRoot);
  if (!repoRoot) {
    fail('ERR_PR_ROOT_NOT_GIT_WORKTREE', `review-fix-pr requires a git worktree root: ${candidateRoot}`);
  }
  if (explicitRoot && candidateRoot !== repoRoot) {
    fail(
      'ERR_PR_ROOT_NOT_GIT_TOP_LEVEL',
      `review-fix-pr root= must point to the git repository top level: ${repoRoot}`
    );
  }
  return repoRoot;
}

function resolveR2pProjectRoot(parsed, options = {}) {
  const cwd = options.cwd || process.cwd();
  const explicitRoot = parsed.invocation.root;
  const candidate = explicitRoot ? path.resolve(explicitRoot) : path.resolve(cwd);
  return resolveExistingRealDirectory(candidate, {
    blockingReason: 'invalid-project-root',
    missingMessage: `project root must exist and be a real directory: ${candidate}`,
    unsafeMessage: `project root must not be a symlink: ${candidate}`,
    nextAction: 'rerun with root=<project-root> that exists as a real directory',
    code: 'ERR_R2P_PROJECT_ROOT'
  });
}

function resolveR2pWorkspaceTarget(parsed, projectRoot) {
  const workId = String(parsed.invocation.workId || '');
  const workspacePath = path.join(projectRoot, '.req-to-plan');
  const workspaceRealPath = resolveExistingRealDirectory(workspacePath, {
    blockingReason: 'r2p-workspace-not-found',
    missingMessage: `r2p workspace not found: ${workspacePath}`,
    unsafeMessage: `r2p workspace must not be a symlink: ${workspacePath}`,
    nextAction: 'create or restore the active .req-to-plan workspace before rerunning',
    code: 'ERR_R2P_WORKSPACE'
  });
  const archivePath = path.join(workspaceRealPath, 'archive');
  const activePath = path.join(workspaceRealPath, workId);
  const archivedPath = path.join(archivePath, workId);
  assertDirectChildPath(activePath, workspaceRealPath, 'ERR_R2P_WORK_ID_SHAPE');
  assertDirectChildPath(archivedPath, archivePath, 'ERR_R2P_WORK_ID_SHAPE');

  const activeExists = pathMissing(activePath) ? false : fs.existsSync(activePath);
  const archiveExists = pathMissing(archivedPath) ? false : fs.existsSync(archivedPath);

  if (activeExists && archiveExists) {
    failR2pPreflight(
      'r2p-work-id-conflict',
      `workId exists in both active and archive workspaces: ${workId}`,
      'remove the duplicate active/archive workId before rerunning',
      'ERR_R2P_WORK_ID_CONFLICT'
    );
  }
  if (archiveExists && !activeExists) {
    failR2pPreflight(
      'r2p-run-archived',
      `workId exists only in archive: ${workId}`,
      'rerun review-fix-r2p with an active workId',
      'ERR_R2P_WORK_ID_ARCHIVED'
    );
  }
  if (!activeExists) {
    failR2pPreflight(
      'r2p-run-not-found',
      `active workId not found: ${workId}`,
      'rerun review-fix-r2p with an existing active workId',
      'ERR_R2P_WORK_ID_MISSING'
    );
  }

  let activeStats;
  try {
    activeStats = fs.lstatSync(activePath);
  } catch {
    failR2pPreflight(
      'r2p-run-not-found',
      `active workId not found: ${workId}`,
      'rerun review-fix-r2p with an existing active workId',
      'ERR_R2P_WORK_ID_MISSING'
    );
  }
  if (activeStats.isSymbolicLink() || !activeStats.isDirectory()) {
    failR2pPreflight(
      'unsafe-r2p-run-dir',
      `active r2p run directory must be a real directory: ${activePath}`,
      'repair the active run directory before rerunning',
      'ERR_R2P_RUN_DIR_UNSAFE'
    );
  }

  return {
    workId,
    workspacePath: workspaceRealPath,
    runDir: fs.realpathSync.native(activePath)
  };
}

function cwdAnchoredR2pProjectRoot(parsed, cwd) {
  const target = parsed.invocation.target;
  if (!parsed.invocation.root || path.isAbsolute(parsed.invocation.root)) return null;
  if (!target || path.isAbsolute(target)) return null;
  const requirementDir = path.resolve(cwd, target);
  if (!isRequirementDirShape(requirementDir) || !directoryExists(requirementDir)) return null;
  const projectRoot = projectRootFromRequirementDir(requirementDir);
  if (!projectRoot || !directoryExists(projectRoot)) return null;
  let projectRootReal;
  let cwdReal;
  try {
    projectRootReal = fs.realpathSync.native(projectRoot);
    cwdReal = fs.realpathSync.native(cwd);
  } catch {
    return null;
  }
  return projectRootReal === cwdReal ? projectRootReal : null;
}

function r2pRootDir(parsed, options = {}) {
  const cwd = options.cwd || process.cwd();
  const root = parsed.invocation.root;
  if (!root) return options.originalCwd || options.rootCwd || cwd;
  const explicitRootBase = options.rootCwd || options.originalCwd || cwd;
  const explicitRootDir = path.resolve(explicitRootBase, root);
  if (
    !path.isAbsolute(root) &&
    !options.rootCwd &&
    !options.originalCwd &&
    pathMissing(explicitRootDir)
  ) {
    const cwdProjectRoot = cwdAnchoredR2pProjectRoot(parsed, cwd);
    if (cwdProjectRoot) return cwdProjectRoot;
  }
  return explicitRootDir;
}

// Lexically resolve the absolute requirement directory for an r2p route. When root=
// is supplied, relative target= values are resolved from that explicit project root
// because the generated route grammar advertises root=<project-root>. Without root=,
// relative target= values stay anchored to the original invocation cwd even after the
// resolver has discovered and threaded the project root through later workflow calls.
function r2pRequirementDir(parsed, options = {}) {
  const target = parsed.invocation.target;
  if (!target) fail('ERR_R2P_TARGET_SHAPE', 'review-fix-r2p requires target=<requirement-dir>');
  const baseDir = r2pRootDir(parsed, options);
  return path.resolve(baseDir, target);
}

// Resolve the project root for a file-set (PR/CODE/r2p) route. CODE routes keep the
// explicit root=/cwd semantics because their scope traversal is project-root relative.
// PR routes always use the git repository top level because git diff name-status paths
// are repo-root-relative even when invoked from a subdirectory. r2p derives the project
// root from the requirement directory shape (the dir that contains the .req-to-plan tree).
function resolveFileSetProjectRoot(parsed, options = {}) {
  const kind = routeKindFor(parsed);
  if (kind === 'pr') return resolvePrProjectRoot(parsed, options);
  if (kind === 'r2p') return resolveR2pProjectRoot(parsed, options);
  const cwd = options.cwd || process.cwd();
  const explicitRoot = parsed.invocation.root;
  const candidate = explicitRoot ? path.resolve(explicitRoot) : path.resolve(cwd);
  return resolveExistingDirectory(candidate);
}

// Stable, order-independent identity string for a file-set route. PR identity is the
// base ref; CODE identity is the sorted scope list (empty ⇒ whole-root). This is the
// stable seed for the target key (which is content-independent on purpose — the same
// base/scope selection always maps to the same target-state directory, and a changed
// base/scope is a different review target). Live content drift is detected separately
// via the file-set fingerprint stored in the manifest.
function fileSetIdentitySeed(parsed, options = {}) {
  const kind = routeKindFor(parsed);
  if (kind === 'pr') {
    const base = String(parsed.invocation.base || '');
    return stableJson({ kind, base });
  }
  if (kind === 'code') {
    const scopes = Array.isArray(options.normalizedScopes)
      ? options.normalizedScopes.map((scope) => String(scope)).sort()
      : (Array.isArray(parsed.invocation.scopes)
        ? parsed.invocation.scopes.map((scope) => String(scope)).sort()
        : []);
    // .drfxignore patterns are part of what the file set IS, so their ordered
    // digests are part of the target identity. Order matters because gitignore
    // negation is last-match-wins; digests keep raw pattern text out of state
    // and output. CONDITIONAL: an empty list keeps the seed byte-identical to
    // its pre-.drfxignore form so existing CODE target keys stay valid.
    const userExcludes = Array.isArray(options.normalizedUserExcludes)
      ? options.normalizedUserExcludes.map((entry) => String(entry))
      : [];
    if (userExcludes.length > 0) return stableJson({ kind, scopes, userExcludes });
    return stableJson({ kind, scopes });
  }
  if (kind === 'r2p') {
    const workId = options.workId !== undefined
      ? String(options.workId)
      : String(parsed.invocation.workId || '');
    return stableJson({ kind, workId });
  }
  fail('ERR_FILE_SET_ROUTE', `fileSetIdentitySeed requires a pr, code, or r2p route, got: ${kind}`);
}

// Derive a deterministic file-set target key: `${routeKind}-${hash12}`. Mirrors the
// document slug-hash shape (`<slug>-<hash12>`) so the target-state directory layout
// stays uniform across kinds and the manifest Target key invariant holds.
function deriveFileSetTargetKey(parsed, options = {}) {
  const seed = fileSetIdentitySeed(parsed, options);
  const hash12 = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return `${routeKindFor(parsed)}-${hash12}`;
}

// Route-kind-aware target metadata. Document ⇒ the single-file metadata
// (normalizedTarget/targetKey/slug/hash12) exactly as deriveTargetKey returns it.
// PR/CODE ⇒ file-set metadata: a route-kind target key, the resolved project root,
// and the route kind. There is NO normalizedTarget for file-set routes (the unit of
// review is a set, not one path), and NO single-file fingerprint.
function resolveRouteTargetMetadata(parsed, options = {}) {
  if (!isFileSetRoute(parsed)) {
    const projectRoot = resolveProjectRoot({
      explicitRoot: parsed.invocation.root,
      targetPath: parsed.invocation.target,
      cwd: options.cwd || process.cwd(),
      persistentStateRequired: true
    });
    return {
      routeKind: 'document',
      projectRoot,
      ...deriveTargetKey(projectRoot, parsed.invocation.target)
    };
  }
  const projectRoot = resolveFileSetProjectRoot(parsed, options);
  if (routeKindFor(parsed) === 'r2p') {
    const resolved = resolveR2pWorkspaceTarget(parsed, projectRoot);
    const relativeRequirementDir = path.relative(projectRoot, resolved.runDir).split(path.sep).join('/');
    return {
      routeKind: 'r2p',
      projectRoot,
      targetKey: deriveR2pTargetKey({ projectRoot, workId: resolved.workId }).targetKey,
      normalizedTarget: null,
      workId: resolved.workId,
      requirementDir: relativeRequirementDir,
      runDir: resolved.runDir
    };
  }
  const normalizedScopes = routeKindFor(parsed) === 'code'
    ? normalizeCodeScopesForIdentity({ cwd: projectRoot, scopes: parsed.invocation.scopes || [] })
    : null;
  const normalizedUserExcludes = routeKindFor(parsed) === 'code'
    ? normalizeCodeUserExcludesForIdentity({ cwd: projectRoot })
    : null;
  return {
    routeKind: routeKindFor(parsed),
    projectRoot,
    targetKey: deriveFileSetTargetKey(
      parsed,
      normalizedScopes ? { normalizedScopes, normalizedUserExcludes } : {}
    ),
    normalizedTarget: null,
    base: parsed.invocation.base || null,
    scopes: normalizedScopes || (Array.isArray(parsed.invocation.scopes) ? parsed.invocation.scopes.slice() : null)
  };
}

module.exports = {
  routeKindFor,
  isFileSetRoute,
  resolveFileSetProjectRoot,
  resolveR2pProjectRoot,
  resolveR2pWorkspaceTarget,
  fileSetIdentitySeed,
  deriveFileSetTargetKey,
  resolveRouteTargetMetadata
};
