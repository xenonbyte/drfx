'use strict';

// PLAN-TASK-010: r2p gate-freshness (TOCTOU) revalidation.
//
// The r2p eligibility decision — run.md unchanged AND still satisfies the gate — is made
// once, at resolve time. But the fix lifecycle then writes and PASSes
// across several later commands. Between the gate decision and each write/PASS checkpoint,
// run.md can be edited (fingerprint drift), mutated to an archived/incomplete state (the
// gate is no longer satisfied), or DELETED (unreadable). Without a recheck, a fixer could
// write or claim PASS from STALE eligibility.
//
// revalidateR2pGate re-reads run.md from the stored requirementDir, recomputes its sha256
// against the protected `runMdSha256` (Task 8), and re-runs parseRunMdGate. It is called at
// FOUR checkpoints (see file-set-fix.js / file-set-finalize.js): before begin-fix, before a
// lock refresh that precedes writes, after end-fix, and before final PASS. Any drift stops
// the run as a guarded blocker reusing the file-set guard's `unexpected-worktree-change`
// plumbing (the same reason out-of-set worktree drift uses).
//
// This is also the closing backstop for the Task-9 residual: under guard=snapshot a
// DELETE-only of run.md is NOT caught by the snapshot file-set guard (run.md is not a
// monitored member), but here the re-read fails (missing/unreadable) and BLOCKS.
//
// PR/CODE carry no run.md, so revalidateR2pGate returns null for them and the byte-stable
// PR/CODE paths are unaffected.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseRunMdGate, resolveR2pWorkIdTarget } = require('../target-context');

// r2p force-includes the whole requirement directory into the snapshot tree walk so an
// out-of-set fixer write under the globally-pruned `.req-to-plan` (run.md or a sibling
// non-monitored 03–07 doc) is caught as an out-of-set change under guard=snapshot — the
// same protection git status gives under guard=git. PR/CODE pass no force-include dirs.
function snapshotForceIncludeDirs(metadata) {
  if (metadata.routeKind !== 'r2p' || !metadata.manifest.workId) return [];
  return [path.join(metadata.projectRoot, '.req-to-plan', metadata.manifest.workId)];
}

// Re-resolve the LIVE r2p review set from the durable manifest identity (read-only). r2p
// re-resolves the active workId (run.md gate + 03–07 chain) — NOT a CODE scope walk and
// NEVER a partition plan. The fixer's writable boundary is EXACTLY the 03–07 docs: run.md
// is carried as a PROTECTED read-only dependency and is NOT in `files`, so the file-set
// guard already refuses it (and any non-03–07 path) as out-of-set.
//
// The fix guard resolves monitored members against the PROJECT ROOT and reads them on disk,
// so the writable set carries project-root-relative POSIX paths (the docs live under the
// run directory). The doc-name-relative paths are kept on each member as
// `requirementRelativePath` so liveFileSetFingerprint can match the persisted
// r2p review-set fingerprint.
function resolveR2pLiveFileSet(metadata, options) {
  const context = resolveR2pWorkIdTarget({
    projectRoot: metadata.projectRoot,
    workId: metadata.manifest.workId
  });
  return {
    routeKind: 'r2p',
    workId: context.workId,
    projectRoot: context.projectRoot,
    runMdPath: context.runMdPath,
    runMdSha256: context.runMdSha256,
    files: (context.reviewFileEntries || []).map((file) => ({
      path: file.path,
      requirementRelativePath: file.requirementRelativePath,
      status: file.status,
      contentId: file.contentId
    })),
    protectedDependencies: [{
      path: path.relative(metadata.projectRoot, context.runMdPath).split(path.sep).join('/'),
      readOnly: true,
      sha256: context.runMdSha256
    }]
  };
}

const GATE_DRIFT_REASON = 'unexpected-worktree-change';

function drift(summary) {
  return { blockingReason: GATE_DRIFT_REASON, summary };
}

// Returns null when the r2p run.md gate is still fresh (or the route is not r2p), and a
// drift descriptor `{ blockingReason, summary }` otherwise.
function revalidateR2pGate(metadata) {
  if (!metadata || metadata.routeKind !== 'r2p') return null;

  const storedSha256 = metadata.manifest && metadata.manifest.runMdSha256;
  if (!storedSha256 || storedSha256 === 'none') {
    return drift('r2p manifest is missing the protected run.md fingerprint; cannot revalidate the gate');
  }

  const runDir = metadata.manifest.workId
    ? path.join(metadata.projectRoot, '.req-to-plan', metadata.manifest.workId)
    : null;
  if (!runDir) {
    return drift('r2p manifest is missing the workId; cannot revalidate the run.md gate');
  }
  const runMdPath = path.join(runDir, 'run.md');

  // run.md must still be a regular (non-symlink, non-directory) file. A DELETE leaves lstat
  // throwing ENOENT — the backstop for the snapshot DELETE-only residual.
  let stats;
  try {
    stats = fs.lstatSync(runMdPath);
  } catch {
    return drift('protected run.md gate is missing or unreadable since the fix baseline');
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return drift('protected run.md gate is no longer a regular file');
  }

  let runMdText;
  try {
    runMdText = fs.readFileSync(runMdPath, 'utf8');
  } catch {
    return drift('protected run.md gate is missing or unreadable since the fix baseline');
  }

  const currentSha256 = crypto.createHash('sha256').update(runMdText).digest('hex');
  if (currentSha256 !== String(storedSha256)) {
    return drift('protected run.md gate changed since the fix baseline (fingerprint mismatch)');
  }

  // Even a byte-stable run.md must still SATISFY the gate. parseRunMdGate throws when run.md
  // is unrecognizable/invalid, and returns planApproved:false when the plan stage is no
  // longer generated/approved (incomplete/archived). Either way the run is no longer
  // fix-eligible.
  let gate;
  try {
    gate = parseRunMdGate(runMdText);
  } catch {
    return drift('protected run.md gate is no longer recognizable/valid');
  }
  if (!gate.planApproved) {
    return drift('protected run.md gate no longer indicates a generated/approved plan (incomplete/archived)');
  }
  return null;
}

const RESTORE_BEFORE_BEGIN = 'restore the run.md gate to its reviewed state before retrying begin-fix';
const RESTORE_BEFORE_END = 'restore the run.md gate to its reviewed state before retrying end-fix';
const RESTORE_BEFORE_CONTINUE = 'restore the run.md gate to its reviewed state before continuing the fix';

// Shape the beginFixBlocked(...) options for a CHECKPOINT-1 gate drift (primary or
// blocked-retry begin-fix). monitoredSet is [] when the drift is detected before the live
// file set is resolved.
function beginGateBlockArgs(gateDrift, { round, monitoredSet = [] } = {}) {
  return {
    round,
    monitoredSet,
    guardResult: { status: 'blocked', blockingReason: gateDrift.blockingReason },
    blockingReason: gateDrift.blockingReason,
    summary: gateDrift.summary,
    nextAction: RESTORE_BEFORE_BEGIN
  };
}

// Shape the endFixBlocked(...) options for a CHECKPOINT-3 gate drift.
function endGateBlockArgs(gateDrift, { issueIds = [], filesChanged = 'none' } = {}) {
  return {
    issueIds,
    filesChanged,
    summary: gateDrift.summary,
    nextAction: RESTORE_BEFORE_END
  };
}

module.exports = {
  snapshotForceIncludeDirs,
  resolveR2pLiveFileSet,
  revalidateR2pGate,
  beginGateBlockArgs,
  endGateBlockArgs,
  RESTORE_BEFORE_CONTINUE
};
