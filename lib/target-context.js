'use strict';

// PLAN-TASK-003: PR target resolver + PR state-identity helpers.
//
// PURE / read-only by construction:
//   - resolveTargetContext() runs LOCAL read-only git plumbing only. It NEVER
//     fetches, pushes, mutates refs, or contacts a remote.
//   - The identity helpers (buildPrIdentity / format / parse / compare) are pure
//     functions over plain objects. No file-set MANIFEST.md is written here;
//     live persistence is PLAN-TASK-009.

const crypto = require('node:crypto');
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
  'cat-file',
  'diff',
  'hash-object'
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

function parseNameStatus(stdout) {
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

async function blobSha(commitish, filePath, ctx) {
  // Resolve the blob OID of a path at a given commit. Returns 'none' when the
  // path does not exist at that commit (e.g. an added file at the base, or a
  // deleted file at HEAD).
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${commitish}:${filePath}`], ctx);
  if (!result.ok) return 'none';
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : 'none';
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

  const mergeBaseResult = await runGit(['merge-base', baseRevision, head], ctx);
  if (!mergeBaseResult.ok) fail('ERR_PR_NO_MERGE_BASE', `no merge base between ${baseRef} and HEAD`);
  const mergeBase = mergeBaseResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) {
    fail('ERR_PR_NO_MERGE_BASE', `no merge base between ${baseRef} and HEAD`);
  }

  const diffResult = await runGit(['diff', '--name-status', '--find-renames', `${mergeBase}..${head}`], ctx);
  if (!diffResult.ok) fail('ERR_PR_DIFF_FAILED', 'unable to compute PR diff between merge base and HEAD');
  const rawFiles = parseNameStatus(diffResult.stdout);

  const files = [];
  for (const entry of rawFiles) {
    // Identity sha for the file set: for deletions, fall back to the base blob
    // so the deletion still contributes a stable, change-sensitive value.
    let sha256;
    if (entry.status === 'deleted') {
      sha256 = await blobSha(mergeBase, entry.path, ctx);
    } else {
      sha256 = await blobSha(head, entry.path, ctx);
    }
    files.push({ ...entry, sha256 });
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
 * Each entry contributes { path, status, sha256 }. Sorting + stableJson make
 * the same logical set always hash to the same value.
 */
function computeFileSetFingerprint(files) {
  const canonical = (Array.isArray(files) ? files : [])
    .map((entry) => ({
      path: String(entry.path),
      status: String(entry.status || 'modified'),
      sha256: String(entry.sha256 || 'none')
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return crypto.createHash('sha256').update(stableJson(canonical)).digest('hex');
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

module.exports = {
  resolveTargetContext,
  computeFileSetFingerprint,
  buildPrIdentity,
  formatPrIdentityFields,
  parsePrIdentityFields,
  comparePrIdentity
};
