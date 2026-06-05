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
  resolveProjectRoot
} = require('../target-state');
const {
  normalizeCodeScopesForIdentity,
  normalizeCodeUserExcludesForIdentity
} = require('../target-context');
const { stableJson } = require('./serialization');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function routeKindFor(parsed) {
  return (parsed && parsed.invocation && parsed.invocation.routeKind) || 'document';
}

function isFileSetRoute(parsed) {
  const kind = routeKindFor(parsed);
  return kind === 'pr' || kind === 'code';
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

// Resolve the project root for a file-set (PR/CODE) route. CODE routes keep the
// explicit root=/cwd semantics because their scope traversal is project-root relative.
// PR routes always use the git repository top level because git diff name-status paths
// are repo-root-relative even when invoked from a subdirectory.
function resolveFileSetProjectRoot(parsed, options = {}) {
  if (routeKindFor(parsed) === 'pr') return resolvePrProjectRoot(parsed, options);
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
    // .drfxignore patterns are part of what the file set IS, so they are part
    // of the target identity — in FILE ORDER (gitignore negation is
    // last-match-wins, so reordering means a different exclusion semantics).
    // CONDITIONAL: an empty pattern list keeps the seed byte-identical to its
    // pre-.drfxignore form so every existing CODE target key (and its
    // on-disk state directory) stays valid.
    const userExcludes = Array.isArray(options.normalizedUserExcludes)
      ? options.normalizedUserExcludes.map((entry) => String(entry))
      : [];
    if (userExcludes.length > 0) return stableJson({ kind, scopes, userExcludes });
    return stableJson({ kind, scopes });
  }
  fail('ERR_FILE_SET_ROUTE', `fileSetIdentitySeed requires a pr or code route, got: ${kind}`);
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
  fileSetIdentitySeed,
  deriveFileSetTargetKey,
  resolveRouteTargetMetadata
};
