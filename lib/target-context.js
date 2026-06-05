'use strict';

// PLAN-TASK-003: PR target resolver + PR state-identity helpers.
//
// PURE / read-only by construction:
//   - resolveTargetContext() runs LOCAL read-only git plumbing and working-tree
//     content reads only. It NEVER fetches, pushes, mutates refs, or contacts a remote.
//   - The identity helpers (buildPrIdentity / format / parse / compare) are pure
//     functions over plain objects. No file-set MANIFEST.md is written here;
//     live persistence is PLAN-TASK-009.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { stableJson } = require('./workflow/serialization');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// Read-only git plumbing allowlist. resolveTargetContext refuses to spawn any
// git subcommand outside this set, so a future edit cannot accidentally
// introduce fetch/push/remote/branch mutations.
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'rev-parse',
  'symbolic-ref',
  'merge-base',
  'diff'
]);

/**
 * Run a single read-only git command and resolve with { stdout, status }.
 * Records the full argv into commandLog (when provided) so tests can assert no
 * forbidden subcommand (fetch/push/...) was ever spawned.
 */
function runGit(args, { cwd, commandLog }) {
  const subcommand = args[0];
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    fail('ERR_PR_GIT_SUBCOMMAND_FORBIDDEN', `refusing to run non-read-only git subcommand: ${subcommand}`);
  }
  if (Array.isArray(commandLog)) commandLog.push(['git', ...args].join(' '));
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, stdout: '', status: typeof error.code === 'number' ? error.code : 1 });
        return;
      }
      resolve({ ok: true, stdout, status: 0 });
    });
  });
}

async function resolveRevision(ref, ctx) {
  // `<ref>^{commit}` resolves branches, tags, and commit-ish revisions to a
  // commit sha, and fails for anything that is not a real local commit.
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], ctx);
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

async function currentBranchName(ctx) {
  const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], ctx);
  if (!result.ok) return null; // detached HEAD
  const name = result.stdout.trim();
  return name === '' ? null : name;
}

function parseNameStatus(stdout, { nulDelimited = false } = {}) {
  if (nulDelimited) return parseNameStatusNul(stdout);
  const files = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line === '') continue;
    const parts = line.split('\t');
    const code = parts[0];
    if (code.startsWith('R')) {
      // Rename: "R<score>\t<from>\t<to>"
      files.push({ path: parts[2], fromPath: parts[1], status: 'renamed' });
    } else if (code.startsWith('C')) {
      // Copy: "C<score>\t<from>\t<to>"
      files.push({ path: parts[2], fromPath: parts[1], status: 'copied' });
    } else if (code === 'A') {
      files.push({ path: parts[1], status: 'added' });
    } else if (code === 'D') {
      files.push({ path: parts[1], status: 'deleted' });
    } else if (code === 'M') {
      files.push({ path: parts[1], status: 'modified' });
    } else if (code === 'T') {
      files.push({ path: parts[1], status: 'type-changed' });
    } else {
      files.push({ path: parts[parts.length - 1], status: 'modified' });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

function parseNameStatusNul(stdout) {
  const files = [];
  const fields = stdout.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    if (!code) continue;
    if (code.startsWith('R')) {
      const fromPath = fields[index++];
      const nextPath = fields[index++];
      if (!fromPath || !nextPath) fail('ERR_PR_DIFF_PARSE', 'malformed rename entry in PR diff');
      files.push({ path: nextPath, fromPath, status: 'renamed' });
    } else if (code.startsWith('C')) {
      const fromPath = fields[index++];
      const nextPath = fields[index++];
      if (!fromPath || !nextPath) fail('ERR_PR_DIFF_PARSE', 'malformed copy entry in PR diff');
      files.push({ path: nextPath, fromPath, status: 'copied' });
    } else {
      const filePath = fields[index++];
      if (!filePath) fail('ERR_PR_DIFF_PARSE', 'malformed path entry in PR diff');
      if (code === 'A') {
        files.push({ path: filePath, status: 'added' });
      } else if (code === 'D') {
        files.push({ path: filePath, status: 'deleted' });
      } else if (code === 'M') {
        files.push({ path: filePath, status: 'modified' });
      } else if (code === 'T') {
        files.push({ path: filePath, status: 'type-changed' });
      } else {
        files.push({ path: filePath, status: 'modified' });
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

function gitBlobOid(buffer) {
  return crypto
    .createHash('sha1')
    .update(Buffer.from(`blob ${buffer.length}\0`))
    .update(buffer)
    .digest('hex');
}

function worktreeBlobSha(filePath, ctx) {
  const root = path.resolve(ctx.cwd || process.cwd());
  if (typeof filePath !== 'string' || filePath === '' || filePath.includes('\0')) {
    fail('ERR_PR_WORKTREE_PATH', 'unsafe PR diff path');
  }
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    fail('ERR_PR_WORKTREE_PATH', 'PR diff path must be project-relative');
  }
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('ERR_PR_WORKTREE_PATH', 'PR diff path must stay inside the project root');
  }

  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'none';
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return gitBlobOid(Buffer.from(fs.readlinkSync(absolute)));
  }
  if (!stats.isFile()) return 'none';
  return gitBlobOid(fs.readFileSync(absolute));
}

/**
 * Resolve a PR target context from LOCAL git state only.
 *
 * @param {object} input
 * @param {string} input.routeName - must be 'review-fix-pr'
 * @param {string} input.base - base ref (branch / tag / commit-ish), local only
 * @param {string} input.cwd - repo working directory
 * @param {string[]} [input.commandLog] - optional sink for the git command log
 * @returns {Promise<object>} resolved PR context
 */
async function resolveTargetContext({ routeName, base, cwd, commandLog } = {}) {
  if (routeName !== 'review-fix-pr') {
    fail('ERR_PR_ROUTE', `resolveTargetContext only supports review-fix-pr, got: ${routeName}`);
  }
  const ctx = { cwd, commandLog };
  const baseRef = typeof base === 'string' ? base.trim() : '';
  if (baseRef === '') fail('ERR_PR_BASE_MISSING', 'review-fix-pr requires a base ref');

  const head = await resolveRevision('HEAD', ctx);
  if (!head) fail('ERR_PR_HEAD_UNRESOLVABLE', 'unable to resolve current HEAD commit');

  const currentBranch = await currentBranchName(ctx);
  if (currentBranch !== null && currentBranch === baseRef) {
    fail('ERR_PR_BASE_IS_CURRENT_BRANCH', `base cannot equal the current branch: ${baseRef}`);
  }

  const baseRevision = await resolveRevision(baseRef, ctx);
  if (!baseRevision) fail('ERR_PR_BASE_UNRESOLVABLE', `unable to resolve base ref to a local commit: ${baseRef}`);
  if (baseRevision === head) {
    fail('ERR_PR_BASE_IS_HEAD', `base cannot resolve to the current HEAD commit: ${baseRef}`);
  }

  const mergeBaseResult = await runGit(['merge-base', baseRevision, head], ctx);
  if (!mergeBaseResult.ok) fail('ERR_PR_NO_MERGE_BASE', `no merge base between ${baseRef} and HEAD`);
  const mergeBase = mergeBaseResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) {
    fail('ERR_PR_NO_MERGE_BASE', `no merge base between ${baseRef} and HEAD`);
  }

  const diffResult = await runGit(['diff', '--name-status', '-z', '--find-renames', `${mergeBase}..${head}`], ctx);
  if (!diffResult.ok) fail('ERR_PR_DIFF_FAILED', 'unable to compute PR diff between merge base and HEAD');
  const rawFiles = parseNameStatus(diffResult.stdout, { nulDelimited: true });

  const files = [];
  for (const entry of rawFiles) {
    // Per-file identity token for the file set. For PR routes this is the git
    // blob OID (40-hex) of the CURRENT WORKTREE content. Fix rounds are
    // intentionally uncommitted, so HEAD blobs would leave file-set state stale
    // after end-fix. Missing worktree paths use 'none'.
    const contentId = worktreeBlobSha(entry.path, ctx);
    files.push({ ...entry, contentId });
  }

  return {
    routeKind: 'pr',
    base: baseRef,
    baseRevision,
    head,
    mergeBase,
    currentBranch,
    files
  };
}

/**
 * Deterministic, order-independent fingerprint over a file set.
 * Each entry contributes { path, status, contentId }, where contentId is the
 * per-file identity token (a git blob OID for PR, a content hash for CODE).
 * Sorting + stableJson make the same logical set always hash to the same value.
 */
function computeFileSetFingerprint(files) {
  const canonical = (Array.isArray(files) ? files : [])
    .map((entry) => ({
      path: String(entry.path),
      status: String(entry.status || 'modified'),
      contentId: String(entry.contentId || 'none')
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return crypto.createHash('sha256').update(stableJson(canonical)).digest('hex');
}

// ---------------------------------------------------------------------------
// CODE target resolver (PLAN-TASK-004)
//
// Deterministic working-tree traversal under in-root scopes, with mandatory
// exclusions for non-source / build / cache / temp directories. PURE/read-only:
// it only reads file content + stats; it never writes, spawns git, or contacts
// a remote. No new npm dependency — node:fs/node:path/node:crypto only.
// ---------------------------------------------------------------------------

// Whole-root (no narrowing scope) CODE review must stay verifiably readable.
// Over these limits the route blocks and asks for a narrower scope instead of
// claiming a full review it cannot prove. Tunable constants, not load-bearing.
const MAX_WHOLE_ROOT_FILES = 300;
const MAX_WHOLE_ROOT_BYTES = 1_500_000;

// Mandatory exclusions for CODE source discovery. Owned here (single source of
// truth) and EXPORTED so route descriptors/prompts reference it instead of
// duplicating the list. These are working-tree directory basenames pruned at
// every traversal level. This is intentionally distinct from
// target-state.js's RESERVED_DIRECTORIES (which names .drfx-internal
// subdirs): CODE excludes the whole current/legacy state tree plus VCS,
// dependency, build-output, cache, and temp directories from source review.
const CODE_EXCLUDED_DIRECTORIES = Object.freeze(new Set([
  // VCS + this tool's own current/legacy state trees
  '.git',
  '.hg',
  '.svn',
  '.drfx',
  '.docs-review-fix',
  // Local agent/tool state and generated workflow artifacts
  '.claude',
  '.codex',
  '.codegraph',
  '.gemini',
  '.req-to-plan',
  // dependency trees + language/package caches
  'node_modules',
  'bower_components',
  'vendor',
  '.pnp',
  '.yarn',
  '.pnpm-store',
  '.gradle',
  '.m2',
  // build / distribution outputs
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  // coverage + test/build caches
  'coverage',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  // temp / OS / editor scratch
  'tmp',
  'temp',
  '.tmp',
  '.idea',
  '.vscode'
]));

// Excluded working-tree FILE basenames (OS/editor scratch files). Unlike the
// directory set above, these are matched against regular files during traversal
// so they never enter the CODE file set or its fingerprint.
const CODE_EXCLUDED_FILES = Object.freeze(new Set([
  '.DS_Store',
  'Thumbs.db'
]));

function isExcludedBasename(basename) {
  return CODE_EXCLUDED_DIRECTORIES.has(basename);
}

function isExcludedFile(basename) {
  return CODE_EXCLUDED_FILES.has(basename);
}

// Resolve a requested scope to a real, in-root, posix root-relative path.
// Throws a coded error for missing / outside-root / symlink-escaping scopes.
function resolveScope(rootRealPath, scope) {
  const raw = typeof scope === 'string' ? scope.trim() : '';
  if (raw === '') fail('ERR_CODE_SCOPE_MISSING', 'review-fix-code scope must not be empty');

  const absolute = path.resolve(rootRealPath, raw);
  // Lexical escape check FIRST: a scope whose normalized form steps outside the
  // root (via `..` or an absolute path) is rejected as outside-root regardless
  // of whether the escaping path happens to exist on disk.
  const lexicalRelative = path.relative(rootRealPath, absolute);
  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    fail('ERR_CODE_SCOPE_OUTSIDE_ROOT', `scope resolves outside project root: ${scope}`);
  }
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch {
    fail('ERR_CODE_SCOPE_MISSING', `scope path must exist: ${scope}`);
  }
  // Reject a scope that IS a symlink up front; we never traverse through one.
  if (stats.isSymbolicLink()) {
    const linkReal = fs.realpathSync.native(absolute);
    if (!isInsideOrEqualRoot(rootRealPath, linkReal)) {
      fail('ERR_CODE_SCOPE_OUTSIDE_ROOT', `scope resolves outside project root: ${scope}`);
    }
  }

  let realPath;
  try {
    realPath = fs.realpathSync.native(absolute);
  } catch {
    fail('ERR_CODE_SCOPE_MISSING', `scope path must exist: ${scope}`);
  }
  if (!isInsideOrEqualRoot(rootRealPath, realPath)) {
    fail('ERR_CODE_SCOPE_OUTSIDE_ROOT', `scope resolves outside project root: ${scope}`);
  }
  // A scope must name a directory to review; a file scope would otherwise walk
  // to an empty set and silently mislead. Fail loudly instead.
  if (!fs.statSync(realPath).isDirectory()) {
    fail('ERR_CODE_SCOPE_NOT_DIRECTORY', `scope must be a directory: ${scope}`);
  }

  const relative = path.relative(rootRealPath, realPath);
  // Empty relative ⇒ the scope is the root itself ⇒ treat as whole-root (no scope).
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('ERR_CODE_SCOPE_OUTSIDE_ROOT', `scope resolves outside project root: ${scope}`);
  }
  return relative.split(path.sep).join('/');
}

function isInsideOrEqualRoot(rootRealPath, candidateRealPath) {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Walk one directory (root-relative posix prefix) and append regular-file
// entries to `out`. Excluded dirs are pruned; symlinks are never followed
// (so an escaping link can never leak content outside the root); device /
// fifo / socket files are skipped.
function walkDirectory(rootRealPath, relativePrefix, out, wholeRootStats) {
  if (wholeRootStats && wholeRootStats.blocked) return;
  const absoluteDir = relativePrefix === '' ? rootRealPath : path.join(rootRealPath, relativePrefix);
  let dirents;
  try {
    dirents = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch (error) {
    const displayPath = relativePrefix === '' ? '.' : relativePrefix;
    fail('ERR_CODE_SCOPE_UNREADABLE', `unable to read in-scope directory: ${displayPath}`);
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of dirents) {
    const name = dirent.name;
    const childRelative = relativePrefix === '' ? name : `${relativePrefix}/${name}`;
    if (dirent.isSymbolicLink()) {
      // Never follow symlinks: they can escape the root and break determinism.
      continue;
    }
    if (dirent.isDirectory()) {
      if (isExcludedBasename(name)) continue;
      walkDirectory(rootRealPath, childRelative, out, wholeRootStats);
      if (wholeRootStats && wholeRootStats.blocked) return;
    } else if (dirent.isFile()) {
      if (isExcludedFile(name)) continue;
      if (wholeRootStats) {
        wholeRootStats.fileCount += 1;
        wholeRootStats.totalBytes += fs.statSync(path.join(rootRealPath, childRelative)).size;
        if (
          wholeRootStats.fileCount > MAX_WHOLE_ROOT_FILES ||
          wholeRootStats.totalBytes > MAX_WHOLE_ROOT_BYTES
        ) {
          wholeRootStats.blocked = true;
          return;
        }
      }
      out.push(childRelative);
    }
    // Anything else (device/fifo/socket) is skipped.
  }
}

function hashFileContent(absolutePath) {
  const content = fs.readFileSync(absolutePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Resolve a CODE target context from the local working tree.
 *
 * @param {object} input
 * @param {string} input.cwd - project root working directory
 * @param {string[]} [input.scopes] - optional repeated in-root scope paths;
 *   empty ⇒ whole project root.
 * @returns {Promise<object>} { routeKind:'code', normalizedScopes, exclusions, files }
 *   or { status:'blocked', reason:'excluded-scope', ... } when a scope IS an
 *   excluded directory.
 */
async function resolveCodeTarget({ cwd, scopes } = {}) {
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(path.resolve(cwd || '.'));
  } catch {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code requires an existing project root');
  }
  if (!fs.statSync(rootRealPath).isDirectory()) {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code project root must be a directory');
  }

  const requestedScopes = Array.isArray(scopes) ? scopes : [];
  const normalizedSet = new Set();
  let rootScopeRequested = false;
  for (const scope of requestedScopes) {
    const relative = resolveScope(rootRealPath, scope);
    // Refuse a scope that IS, or descends into, an excluded directory at ANY
    // path segment (e.g. `node_modules` or `node_modules/foo`) before review
    // starts — the walk root itself cannot be pruned by walkDirectory.
    const excludedSegment = relative.split('/').find((segment) => isExcludedBasename(segment));
    if (excludedSegment) {
      return { status: 'blocked', reason: 'excluded-scope', scope: relative };
    }
    if (relative === '') {
      // The root itself means whole-project traversal and covers any narrower
      // scopes collected before it.
      rootScopeRequested = true;
      normalizedSet.clear();
      continue;
    }
    if (!rootScopeRequested) normalizedSet.add(relative);
  }

  const normalizedScopes = [...normalizedSet].sort();
  const walkRoots = normalizedScopes.length > 0 ? normalizedScopes : [''];
  const wholeRootStats = normalizedScopes.length === 0
    ? { fileCount: 0, totalBytes: 0, blocked: false }
    : null;

  const seen = new Set();
  const relativeFiles = [];
  for (const scopeRelative of walkRoots) {
    walkDirectory(rootRealPath, scopeRelative, relativeFiles, wholeRootStats);
    if (wholeRootStats && wholeRootStats.blocked) {
      return {
        status: 'blocked',
        reason: 'file-set-too-large',
        fileCount: wholeRootStats.fileCount,
        totalBytes: wholeRootStats.totalBytes
      };
    }
  }
  for (const relative of relativeFiles) {
    if (seen.has(relative)) continue;
    seen.add(relative);
  }

  const files = [...seen]
    .sort()
    .map((relative) => ({
      path: relative,
      status: 'present',
      contentId: hashFileContent(path.join(rootRealPath, relative))
    }));

  return {
    routeKind: 'code',
    normalizedScopes,
    exclusions: [...CODE_EXCLUDED_DIRECTORIES].sort(),
    files
  };
}

// Ordered identity fields. This order is also the manifest field order for the
// PR/file-set branch so format/parse stay deterministic.
const PR_IDENTITY_FIELDS = Object.freeze([
  ['targetContextKind', 'Target context kind'],
  ['base', 'Base'],
  ['baseRevision', 'Base revision'],
  ['mergeBase', 'Merge base'],
  ['head', 'Head'],
  ['guardMode', 'Guard mode'],
  ['roundLimit', 'Round limit'],
  ['fileSetFingerprint', 'File set fingerprint']
]);

/**
 * Build a PR identity object from a resolved context + guard mode + round limit.
 * roundLimit is stored as a string ('none' when unset) so it round-trips
 * through the text manifest and compares strictly.
 */
function buildPrIdentity({ context, guardMode, roundLimit } = {}) {
  if (!context || context.routeKind !== 'pr') {
    fail('ERR_PR_IDENTITY', 'buildPrIdentity requires a resolved pr context');
  }
  return {
    targetContextKind: 'pr',
    base: String(context.base),
    baseRevision: String(context.baseRevision),
    mergeBase: String(context.mergeBase),
    head: String(context.head),
    guardMode: String(guardMode),
    roundLimit: roundLimit === null || roundLimit === undefined ? 'none' : String(roundLimit),
    fileSetFingerprint: computeFileSetFingerprint(context.files)
  };
}

function formatPrIdentityFields(identity) {
  const fields = {};
  for (const [key] of PR_IDENTITY_FIELDS) {
    fields[key] = identity[key];
  }
  return fields;
}

function parsePrIdentityFields(fields) {
  const identity = {};
  for (const [key] of PR_IDENTITY_FIELDS) {
    identity[key] = fields[key];
  }
  return identity;
}

/**
 * Compare a stored PR identity against a requested one for explicit resume.
 * STRICT equality on every identity field; ANY drift (including roundLimit)
 * makes the stored state stale. Returns { match, mismatches:[...] }.
 */
function comparePrIdentity({ stored, requested } = {}) {
  const mismatches = [];
  for (const [key] of PR_IDENTITY_FIELDS) {
    if (String(stored && stored[key]) !== String(requested && requested[key])) {
      mismatches.push(key);
    }
  }
  return { match: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// CODE identity helpers (PLAN-TASK-004) — PURE, mirror the PR helpers.
//
// Scalar fields compare like PR. The scope/exclusion LIST fields are sorted
// before serialize/compare so list ordering never causes false staleness.
// ---------------------------------------------------------------------------

// Scalar identity fields (ordered). The scope/exclusion lists are handled
// separately as list fields, so they are NOT in this scalar list.
const CODE_IDENTITY_SCALAR_FIELDS = Object.freeze([
  ['targetContextKind', 'Target context kind'],
  ['guardMode', 'Guard mode'],
  ['roundLimit', 'Round limit'],
  ['fileSetFingerprint', 'File set fingerprint']
]);
const CODE_IDENTITY_LIST_FIELDS = Object.freeze(['normalizedScopes', 'exclusions']);

function sortedStringList(value) {
  return (Array.isArray(value) ? value : []).map((entry) => String(entry)).sort();
}

// Map a blocked CODE resolution to a user-facing message + next action. Keeps
// every CODE blocked exit reason-aware instead of hardcoding excluded-scope.
function describeCodeBlock(context) {
  if (context && context.reason === 'file-set-too-large') {
    return {
      message: `file-set-too-large: ${context.fileCount} files / ${context.totalBytes} bytes exceed the whole-root review limit (max ${MAX_WHOLE_ROOT_FILES} files, ${MAX_WHOLE_ROOT_BYTES} bytes)`,
      nextAction: 'pass scope=<path> to narrow the review to a smaller part of the project'
    };
  }
  // Only two blocked reasons exist today (file-set-too-large above, excluded-scope
  // here). Add a dedicated branch when a new blocked reason is introduced so it is
  // not silently misreported as excluded-scope.
  return {
    message: `excluded-scope: ${context && context.scope}`,
    nextAction: 'choose a source scope outside excluded directories'
  };
}

function normalizeCodeScopesForIdentity({ cwd, scopes } = {}) {
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(path.resolve(cwd || '.'));
  } catch {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code requires an existing project root');
  }
  if (!fs.statSync(rootRealPath).isDirectory()) {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code project root must be a directory');
  }

  const requestedScopes = Array.isArray(scopes) ? scopes : [];
  const normalizedSet = new Set();
  let rootScopeRequested = false;
  for (const scope of requestedScopes) {
    // Identity-only normalization must NEVER throw on an invalid scope. The target-state key
    // is derived before the resolver enforces scope validity, so an unsafe/outside-root scope
    // must not surface here as an uncaught throw (which would diverge from the excluded-scope
    // case that returns a clean blocked result). Fall back to the raw token: the invalid scope
    // still yields a deterministic (throwaway) key, and the resolver layer reports the scope
    // error uniformly as a clean blocked result. Valid equivalent spellings still collapse.
    let relative;
    try {
      relative = resolveScope(rootRealPath, scope);
    } catch {
      relative = String(scope == null ? '' : scope).trim();
    }
    if (relative === '') {
      rootScopeRequested = true;
      normalizedSet.clear();
      continue;
    }
    if (!rootScopeRequested) normalizedSet.add(relative);
  }
  return [...normalizedSet].sort();
}

/**
 * Build a CODE identity from a resolved code context + guard mode + round
 * limit. Scope/exclusion lists are sorted so identity is order-stable.
 */
function buildCodeIdentity({ context, guardMode, roundLimit } = {}) {
  if (!context || context.routeKind !== 'code') {
    fail('ERR_CODE_IDENTITY', 'buildCodeIdentity requires a resolved code context');
  }
  return {
    targetContextKind: 'code',
    normalizedScopes: sortedStringList(context.normalizedScopes),
    exclusions: sortedStringList(context.exclusions),
    guardMode: String(guardMode),
    roundLimit: roundLimit === null || roundLimit === undefined ? 'none' : String(roundLimit),
    fileSetFingerprint: computeFileSetFingerprint(context.files)
  };
}

function formatCodeIdentityFields(identity) {
  const fields = {};
  for (const [key] of CODE_IDENTITY_SCALAR_FIELDS) {
    fields[key] = identity[key];
  }
  for (const key of CODE_IDENTITY_LIST_FIELDS) {
    fields[key] = sortedStringList(identity[key]);
  }
  return fields;
}

function parseCodeIdentityFields(fields) {
  const identity = {};
  for (const [key] of CODE_IDENTITY_SCALAR_FIELDS) {
    identity[key] = fields[key];
  }
  for (const key of CODE_IDENTITY_LIST_FIELDS) {
    identity[key] = sortedStringList(fields[key]);
  }
  return identity;
}

/**
 * Compare a stored CODE identity against a requested one for explicit resume.
 * Round limit, guard mode, scopes, and the actual file-set fingerprint remain
 * strict. Exclusions are versioned resolver policy; when the live file set is
 * identical, additive/default exclusion drift alone must not strand resumable
 * state. Lists compare in normalized, order-stable form.
 */
function compareCodeIdentity({ stored, requested } = {}) {
  const mismatches = [];
  const storedFingerprint = stored && stored.fileSetFingerprint != null ? String(stored.fileSetFingerprint) : '';
  const requestedFingerprint = requested && requested.fileSetFingerprint != null ? String(requested.fileSetFingerprint) : '';
  const sameFileSet = storedFingerprint !== '' && storedFingerprint === requestedFingerprint;
  for (const [key] of CODE_IDENTITY_SCALAR_FIELDS) {
    if (String(stored && stored[key]) !== String(requested && requested[key])) {
      mismatches.push(key);
    }
  }
  for (const key of CODE_IDENTITY_LIST_FIELDS) {
    const a = stableJson(sortedStringList(stored && stored[key]));
    const b = stableJson(sortedStringList(requested && requested[key]));
    if (key === 'exclusions' && sameFileSet) continue;
    if (a !== b) mismatches.push(key);
  }
  return { match: mismatches.length === 0, mismatches };
}

module.exports = {
  resolveTargetContext,
  resolveCodeTarget,
  describeCodeBlock,
  normalizeCodeScopesForIdentity,
  CODE_EXCLUDED_DIRECTORIES,
  computeFileSetFingerprint,
  buildPrIdentity,
  formatPrIdentityFields,
  parsePrIdentityFields,
  comparePrIdentity,
  buildCodeIdentity,
  formatCodeIdentityFields,
  parseCodeIdentityFields,
  compareCodeIdentity
};
