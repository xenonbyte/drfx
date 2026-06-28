'use strict';

// PLAN-TASK-009 (Phase C2): file-set (PR/CODE) fix lifecycle. This is the file-set analog
// of fix-lifecycle.js. The fixer's write boundary is the resolved PR/CODE file set,
// enforced by the Task-6 file-set guards
// (checkFileSetWorktree for git, captureFileSetBaseline/validateFileSetBaseline/
// restoreFileSetBaseline for snapshot) BEFORE any write. Every
// automatic fix round records a real per-round verification when the optional report section is
// present; when no verification can run, the residual-risk section remains the audit surface.
//
// SAFETY: no file outside the resolved, guarded file set may be written; for guard=snapshot the
// baseline is taken BEFORE the write; never a silent fallback; never PASS from a fix alone.

const {
  acquireLock,
  atomicWriteFile,
  captureFileSetBaseline,
  checkFileSetWorktree,
  computeFingerprint,
  crypto,
  fail,
  failStateValidation,
  formatLedger,
  fs,
  fixableIssuesFromLedger,
  normalizeFileSetEntry,
  padRound,
  parseFixReport,
  persistFileSetBaseline,
  path,
  readFixReportPayload,
  readLedgerIfPresent,
  readPersistedFileSetBaseline,
  resolvedFileSetMemberSet,
  refreshLock,
  releaseLock,
  resolveCodeTarget,
  resolveFileSetStateMetadata,
  resolveTargetContext,
  restoreFileSetBaseline,
  stableJson,
  stateCommandBase,
  stateRelativePath,
  stateValidationResult,
  updateFixedIssues,
  updatePersistentManifest,
  validateFixedIssueIds,
  validateFileSetBaseline,
  writeFixReceipt,
  writeNormalizedFixReport
} = require('./helpers');
const { readLease } = require('../lock');
const { describeCodeBlock, hasCodeExcludedDirectory } = require('../target-context');
const {
  liveFileSetFingerprint,
  readActivePartitionedPlan,
  resolveActivePartitionedLiveFileSet
} = require('./file-set-partitioned-live');
const { applyPartitionedIncrement } = require('./file-set-partitioned-increment');
const {
  snapshotForceIncludeDirs,
  resolveR2pLiveFileSet,
  revalidateR2pGate,
  beginGateBlockArgs,
  endGateBlockArgs,
  RESTORE_BEFORE_CONTINUE
} = require('./file-set-r2p-gate');

const MAX_FIX_ATTEMPTS = 5;
const LOCK_ANCHOR_BASENAME = 'file-set.lock-anchor';

function guardModeFor(metadata) {
  return metadata.manifest.guardMode || 'git';
}

// Re-resolve the LIVE file set from the durable manifest identity (read-only).
async function resolveLiveFileSet(metadata, options) {
  if (metadata.routeKind === 'pr') {
    const context = await resolveTargetContext({
      routeName: 'review-fix-pr',
      base: metadata.manifest.base,
      cwd: metadata.projectRoot,
      commandLog: options.commandLog
    });
    return { routeKind: 'pr', files: context.files };
  }
  if (metadata.routeKind === 'r2p') {
    // r2p precedes the partitioned/CODE fallback so it never inherits the whole-project CODE
    // write boundary. See file-set-r2p-gate.js.
    return resolveR2pLiveFileSet(metadata, options);
  }
  const partitioned = await resolveActivePartitionedLiveFileSet(metadata, options);
  if (partitioned) return partitioned;
  const context = await resolveCodeTarget({
    cwd: metadata.projectRoot,
    scopes: metadata.manifest.normalizedScopes || []
  });
  if (context && context.status === 'blocked') {
    fail('ERR_FILE_SET_RESOLVE', describeCodeBlock(context).message);
  }
  return { routeKind: 'code', files: context.files };
}

function monitoredSetFor(metadata, liveFileSet) {
  // The monitored set is the resolved PR/CODE file-set members, each validated in-root.
  return resolvedFileSetMemberSet({
    projectRoot: metadata.projectRoot,
    liveFileSet
  });
}

function lockAnchorPath(metadata) {
  return path.join(metadata.targetStateDir, LOCK_ANCHOR_BASENAME);
}

// The lock anchor is a state-owned file holding the file-set fingerprint. It gives the
// single-file lock primitive a stable, owned content anchor for a file SET without
// retrofitting the lock module. It is written once per fix round and never mutated mid-round.
function writeLockAnchor(metadata, fingerprint) {
  const anchor = lockAnchorPath(metadata);
  atomicWriteFile(anchor, `${fingerprint}\n`);
  return anchor;
}

function fileSetStateValidation(parsed) {
  return (error) => stateValidationResult(parsed.targetStateDir, error);
}

function assertFileSetFixEligible(metadata) {
  if (metadata.manifest.mode !== 'review-and-fix') {
    failStateValidation('begin-fix requires Mode: review-and-fix');
  }
  if (metadata.manifest.assurance === 'advisory') {
    failStateValidation('begin-fix rejects Assurance: advisory');
  }
  if (
    (metadata.manifest.status !== 'fix' || metadata.manifest.currentPhase !== 'fix') &&
    !isBlockedFixRetry(metadata.manifest)
  ) {
    failStateValidation('begin-fix requires Status: fix and Current phase: fix');
  }
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  if (fixableIssuesFromLedger(ledger).length === 0) {
    failStateValidation('begin-fix requires accepted or reopened issue IDs');
  }
  return ledger;
}

function isBlockedFixRetry(manifest) {
  return Boolean(
    manifest &&
    manifest.status === 'blocked' &&
    manifest.currentPhase === 'fix' &&
    ['fix-report-mismatch', 'unexpected-worktree-change'].includes(manifest.blockingReason)
  );
}

function writeFileSetGuardReport(metadata, { round, monitoredSet, guardResult, baselineStatus, status, blockingReason }) {
  const reportsDir = path.join(metadata.targetStateDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `fix-guard-round-${padRound(round)}.md`);
  const report = {
    round,
    monitoredFiles: monitoredSet.map((entry) => entry.path),
    guardResult,
    baselineStatus,
    status,
    blockingReason
  };
  atomicWriteFile(reportPath, [
    '# File-Set Fix Guard Report',
    '',
    `Round: ${round}`,
    `Status: ${status}`,
    `Blocking reason: ${blockingReason}`,
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    ''
  ].join('\n'));
  return reportPath;
}

function beginFixBlocked(metadata, lease, { round, monitoredSet, guardResult, blockingReason, summary, nextAction }) {
  let reportPath = null;
  try {
    reportPath = writeFileSetGuardReport(metadata, {
      round,
      monitoredSet,
      guardResult: guardResult || null,
      baselineStatus: 'not-run',
      status: 'blocked',
      blockingReason
    });
  } catch {
    // fall through; the manifest still records the block
  }
  try {
    writeFixReceipt(metadata, { status: 'blocked', blockingReason, summary, nextAction });
  } catch {
    // best-effort receipt
  }
  if (lease) {
    try {
      releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
    } catch {
      // a stale lock is repaired by a later end/abort
    }
  }
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    ...(reportPath ? { currentReportPath: stateRelativePath(metadata.targetStateDir, reportPath) } : {})
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    fixGuardReportPath: reportPath,
    nextAction
  });
}

function beginFixCorruptLock(metadata, error) {
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason: 'corrupt-lock',
    statusReason: 'none'
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason: 'corrupt-lock',
    statusReason: 'none',
    errorCode: error && error.code ? error.code : 'ERR_CORRUPT_LOCK',
    message: error && error.message ? error.message : String(error),
    nextAction: 'repair or remove the corrupt target lock before retrying begin-fix'
  });
}

function beginFixActiveLeaseResult(metadata, lease) {
  return stateCommandBase(metadata, {
    ok: true,
    status: 'begin-fix',
    lockOwnerId: lease.ownerId,
    leaseId: lease.leaseId,
    leaseExpiresAt: lease.expiresAt,
    refreshAfterSeconds: 60,
    nextAction: 'continue the in-progress fix'
  });
}

function beginFixLockHeld(metadata, error) {
  if (error && error.lease) return beginFixActiveLeaseResult(metadata, error.lease);
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason: 'lock-held',
    statusReason: 'none',
    errorCode: error && error.code ? error.code : 'ERR_LOCK_HELD',
    message: error && error.message ? error.message : String(error),
    nextAction: 'wait for the in-progress fix to finish or retry begin-fix after the lock expires'
  });
}

function retryBlockedFixBeginFix(metadata, options, round) {
  const persistedBaseline = readPersistedFileSetBaseline(metadata);
  const monitoredSet = monitoredSetFromBaseline(persistedBaseline, { routeKind: metadata.routeKind });
  if (!monitoredSet) {
    return beginFixBlocked(metadata, null, {
      round,
      monitoredSet: [],
      guardResult: null,
      blockingReason: 'target-only-guard-unavailable',
      summary: 'persisted begin-fix file-set baseline is unavailable',
      nextAction: 'restart the fix from a valid begin-fix baseline before retrying end-fix'
    });
  }

  const guardMode = guardModeFor(metadata);
  const guardResult = guardMode === 'git'
    ? checkFileSetWorktree({
      projectRoot: metadata.projectRoot,
      allowedFiles: monitoredSet,
      allowedStateDir: metadata.targetStateDir,
      allowAllowedFileChanges: true
    })
    : validateFileSetBaseline({
      projectRoot: metadata.projectRoot,
      monitoredFiles: monitoredSet,
      baseline: persistedBaseline,
      allowedStateDir: metadata.targetStateDir,
      forceIncludeDirs: snapshotForceIncludeDirs(metadata)
    });
  if (guardResult.status === 'blocked') {
    return beginFixBlocked(metadata, null, {
      round,
      monitoredSet,
      guardResult,
      blockingReason: guardResult.blockingReason || 'unexpected-worktree-change',
      summary: 'blocked fix retry guard blocked unexpected worktree changes',
      nextAction: 'restore unrelated worktree changes before retrying end-fix'
    });
  }

  // CHECKPOINT 1 (before begin-fix, blocked-retry path): the same gate revalidation as the
  // primary begin-fix, since this path also reacquires the lock and reopens the write phase.
  const retryGateDrift = revalidateR2pGate(metadata);
  if (retryGateDrift) {
    return beginFixBlocked(metadata, null, beginGateBlockArgs(retryGateDrift, { round, monitoredSet }));
  }

  let lease = null;
  try {
    const anchorPath = writeLockAnchor(metadata, metadata.manifest.fileSetFingerprint || 'none');
    const ownerId = `drfx-${crypto.randomUUID()}`;
    lease = acquireLock({
      projectRoot: metadata.projectRoot,
      targetKey: metadata.targetKey,
      targetPath: anchorPath,
      ownerId,
      mode: metadata.manifest.mode,
      strictness: metadata.manifest.strictness,
      now: options.now || new Date(),
      lastKnownContentSha256: computeFingerprint(anchorPath).sha256,
      manifest: metadata.manifest
    });
    const reportPath = writeFileSetGuardReport(metadata, {
      round,
      monitoredSet,
      guardResult: { status: 'passed', retry: metadata.manifest.blockingReason },
      baselineStatus: 'passed',
      status: 'passed',
      blockingReason: 'none'
    });
    updatePersistentManifest(metadata, {
      status: 'fix',
      currentPhase: 'fix',
      blockingReason: 'none',
      statusReason: 'none',
      currentReportPath: stateRelativePath(metadata.targetStateDir, reportPath),
      runtimeFingerprintGuard: 'passed'
    });
    return stateCommandBase(metadata, {
      ok: true,
      status: 'begin-fix',
      lockOwnerId: lease.ownerId,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.expiresAt,
      refreshAfterSeconds: 60,
      fixGuardReportPath: reportPath,
      monitoredFileCount: monitoredSet.length,
      nextAction: 'retry end-fix with a valid fix report'
    });
  } catch (error) {
    if (lease) {
      try {
        releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
      } catch { /* repaired later */ }
    }
    const blockingReason = (error && (error.blockingReason || error.reason)) || 'state-validation-failed';
    return beginFixBlocked(metadata, null, {
      round,
      monitoredSet,
      guardResult: null,
      blockingReason,
      summary: 'unable to reacquire file-set fix lock for blocked fix retry',
      nextAction: 'repair the target lock and retry begin-fix'
    });
  }
}

async function runBeginFix(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
    // Throws (failStateValidation) when the manifest is not fix-eligible; the
    // returned ledger is re-read later where needed, so the call is void here.
    assertFileSetFixEligible(metadata);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  const now = options.now || new Date();
  const round = Number(metadata.manifest.currentRound || 1);
  const priorAttempts = Number(metadata.manifest.fixAttemptCount || 0);

  // Resume an in-progress fix if a live lease exists.
  let existingLease;
  try {
    existingLease = readLease({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey });
  } catch (error) {
    if (error && error.reason === 'corrupt-lock') return beginFixCorruptLock(metadata, error);
    throw error;
  }
  if (existingLease && Date.parse(existingLease.expiresAt) > now.getTime()) {
    return beginFixActiveLeaseResult(metadata, existingLease);
  }

  if (isBlockedFixRetry(metadata.manifest)) {
    return retryBlockedFixBeginFix(metadata, options, round);
  }

  if (priorAttempts >= MAX_FIX_ATTEMPTS) {
    updatePersistentManifest(metadata, {
      status: 'stopped-no-progress',
      currentPhase: 'final',
      blockingReason: 'none',
      statusReason: 'no-progress-detected'
    });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'stopped-no-progress',
      blockingReason: 'none',
      statusReason: 'no-progress-detected',
      nextAction: 'fix-attempt cap reached; review unresolved findings manually or accept/defer them'
    });
  }

  // CHECKPOINT 1 (before begin-fix): revalidate the r2p run.md gate before resolving the live
  // file set or opening the write path; a drifted/deleted/incomplete gate blocks here. See
  // file-set-r2p-gate.js.
  const beginGateDrift = revalidateR2pGate(metadata);
  if (beginGateDrift) {
    return beginFixBlocked(metadata, null, beginGateBlockArgs(beginGateDrift, { round }));
  }

  let liveFileSet;
  let monitoredSet;
  try {
    liveFileSet = await resolveLiveFileSet(metadata, options);
    monitoredSet = monitoredSetFor(metadata, liveFileSet);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  const liveFingerprint = liveFileSetFingerprint(liveFileSet);
  if (liveFingerprint !== String(metadata.manifest.fileSetFingerprint || 'none')) {
    return beginFixBlocked(metadata, null, {
      round,
      monitoredSet,
      guardResult: {
        status: 'blocked',
        blockingReason: 'unexpected-worktree-change',
        expectedFileSetFingerprint: metadata.manifest.fileSetFingerprint || 'none',
        actualFileSetFingerprint: liveFingerprint
      },
      blockingReason: 'unexpected-worktree-change',
      summary: priorAttempts > 0
        ? 'file-set content changed since the last recorded fix result'
        : 'file-set content changed since the reviewed fix baseline',
      nextAction: priorAttempts > 0
        ? 'restore the file set to the last recorded fix result before retrying begin-fix'
        : 'rerun context, review, and triage for the current file set before retrying begin-fix'
    });
  }

  const guardMode = guardModeFor(metadata);
  let lease = null;
  try {
    // PRE-WRITE worktree guard: first-round dirty monitored files are user work and block.
    // Only later rounds may carry route-owned prior-round in-set changes.
    if (guardMode === 'git') {
      const guardResult = checkFileSetWorktree({
        projectRoot: metadata.projectRoot,
        allowedFiles: monitoredSet,
        allowedStateDir: metadata.targetStateDir,
        allowAllowedFileChanges: priorAttempts > 0
      });
      if (guardResult.status === 'blocked') {
        return beginFixBlocked(metadata, null, {
          round,
          monitoredSet,
          guardResult,
          blockingReason: guardResult.blockingReason || 'unexpected-worktree-change',
          summary: 'pre-fix file-set guard blocked unexpected worktree changes',
          nextAction: 'commit, stash, or restore unrelated worktree changes before retrying begin-fix'
        });
      }
    }

    // Capture the snapshot baseline BEFORE any write so abort-fix can restore exactly the
    // monitored set.
    const baseline = captureFileSetBaseline({
      projectRoot: metadata.projectRoot,
      monitoredFiles: monitoredSet,
      allowedStateDir: metadata.targetStateDir,
      forceIncludeDirs: snapshotForceIncludeDirs(metadata)
    });
    if (baseline.status !== 'passed') {
      return beginFixBlocked(metadata, null, {
        round,
        monitoredSet,
        guardResult: baseline,
        blockingReason: 'rollback-unavailable',
        summary: 'unable to capture a file-set baseline for rollback',
        nextAction: 'restore the monitored files to regular in-root files before retrying'
      });
    }
    // Persist the metadata baseline (for end-fix validation) plus raw bodies of the monitored
    // set in target-local body files, so abort-fix can restore the exact monitored content.
    // Bodies cover only the resolved file set, never the whole CODE tree, and the body
    // dir is reset each begin-fix; the JSON baseline stays reviewable.
    persistFileSetBaseline(metadata, baseline);

    const anchorPath = writeLockAnchor(metadata, liveFingerprint);
    const ownerId = `drfx-${crypto.randomUUID()}`;
    lease = acquireLock({
      projectRoot: metadata.projectRoot,
      targetKey: metadata.targetKey,
      targetPath: anchorPath,
      ownerId,
      mode: metadata.manifest.mode,
      strictness: metadata.manifest.strictness,
      now,
      lastKnownContentSha256: computeFingerprint(anchorPath).sha256,
      manifest: metadata.manifest
    });

    const reportPath = writeFileSetGuardReport(metadata, {
      round,
      monitoredSet,
      guardResult: { status: 'passed' },
      baselineStatus: 'passed',
      status: 'passed',
      blockingReason: 'none'
    });
    updatePersistentManifest(metadata, {
      status: 'fix',
      currentPhase: 'fix',
      blockingReason: 'none',
      statusReason: 'none',
      currentReportPath: stateRelativePath(metadata.targetStateDir, reportPath),
      runtimeFingerprintGuard: 'passed',
      fixAttemptCount: priorAttempts + 1
    });
    return stateCommandBase(metadata, {
      ok: true,
      status: 'begin-fix',
      lockOwnerId: lease.ownerId,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.expiresAt,
      refreshAfterSeconds: 60,
      fixGuardReportPath: reportPath,
      monitoredFileCount: monitoredSet.length
    });
  } catch (error) {
    if (lease) {
      try {
        releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
      } catch { /* repaired later */ }
    }
    const blockingReason = (error && (error.blockingReason || error.reason)) || 'state-validation-failed';
    if (blockingReason === 'lock-held') return beginFixLockHeld(metadata, error);
    updatePersistentManifest(metadata, { status: 'blocked', blockingReason, statusReason: 'none' });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      blockingReason,
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FILE_SET_FIX_GUARD',
      message: error && error.message ? error.message : String(error),
      nextAction: 'restore the monitored file set and retry begin-fix'
    });
  }
}

function hasCodeExcludedSegment(filePath) {
  return hasCodeExcludedDirectory(filePath);
}

function monitoredSetFromBaseline(baseline, { routeKind = null } = {}) {
  if (!baseline || !Array.isArray(baseline.entries)) return null;
  return baseline.entries
    .filter((entry) => !(routeKind === 'code' && hasCodeExcludedSegment(entry.path)))
    .map((entry) => ({
      path: entry.path,
      status: entry.missing ? 'deleted' : 'present'
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function runRefreshLock(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
    const lease = readLease({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey });
    if (!lease) {
      const error = new Error('corrupt-lock: no active lease to refresh');
      error.code = 'ERR_CORRUPT_LOCK';
      error.reason = 'corrupt-lock';
      throw error;
    }
    if (Date.parse(lease.expiresAt) <= (options.now || new Date()).getTime()) {
      const error = new Error('corrupt-lock: active lease is stale');
      error.code = 'ERR_CORRUPT_LOCK';
      error.reason = 'corrupt-lock';
      throw error;
    }
    // CHECKPOINT 2 (before a lock refresh that precedes writes): refreshing the lease keeps
    // the fixer's write window open, so a drifted/deleted/incomplete run.md gate blocks here.
    const refreshGateDrift = revalidateR2pGate(metadata);
    if (refreshGateDrift) {
      releaseLeaseQuietly(metadata);
      updatePersistentManifest(metadata, {
        status: 'blocked',
        blockingReason: refreshGateDrift.blockingReason,
        statusReason: 'none'
      });
      return stateCommandBase(metadata, {
        ok: false,
        status: 'blocked',
        blockingReason: refreshGateDrift.blockingReason,
        statusReason: 'none',
        summary: refreshGateDrift.summary,
        nextAction: RESTORE_BEFORE_CONTINUE
      });
    }
    const refreshed = refreshLock({
      projectRoot: metadata.projectRoot,
      targetKey: metadata.targetKey,
      ownerId: lease.ownerId,
      now: options.now || new Date()
    });
    return stateCommandBase(metadata, {
      ok: true,
      status: 'refresh-lock',
      lockOwnerId: refreshed.ownerId,
      leaseId: refreshed.leaseId,
      leaseExpiresAt: refreshed.expiresAt,
      refreshAfterSeconds: 60
    });
  } catch (error) {
    if (!metadata) return stateValidationResult(parsed.targetStateDir, error);
    const blockingReason = error && error.reason ? error.reason : 'corrupt-lock';
    updatePersistentManifest(metadata, { status: 'blocked', blockingReason, statusReason: 'none' });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      blockingReason,
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_LOCK_REFRESH_FAILED',
      message: error && error.message ? error.message : String(error),
      nextAction: 'restart fix after repairing the target lock'
    });
  }
}

function endFixBlocked(metadata, blockingReason, { summary, nextAction = 'repair fix output and rerun end-fix', issueIds = [], filesChanged = 'none' }) {
  try {
    writeFixReceipt(metadata, { status: 'blocked', issueIds, filesChanged, blockingReason, summary, nextAction });
  } catch { /* best-effort */ }
  releaseLeaseQuietly(metadata);
  updatePersistentManifest(metadata, { status: 'blocked', blockingReason, statusReason: 'none' });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    nextAction
  });
}

function releaseLeaseQuietly(metadata) {
  const lease = readLease({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey });
  if (!lease) return;
  try {
    releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
  } catch { /* repaired later */ }
}


async function runEndFix(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
    if (metadata.manifest.status !== 'fix' || metadata.manifest.currentPhase !== 'fix') {
      failStateValidation('end-fix requires Status: fix and Current phase: fix');
    }
    const lease = readLease({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey });
    if (!lease) failStateValidation('end-fix requires an active fix lease');
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  let fixReport;
  try {
    const payload = readFixReportPayload(parsed, metadata, options);
    fixReport = parseFixReport(payload, { allowVerification: true });
  } catch {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      summary: 'fix report was unparseable',
      nextAction: 'submit a valid normalized fix report'
    });
  }

  let ledger;
  try {
    ledger = readLedgerIfPresent(metadata.ledgerPath);
    validateFixedIssueIds(fixReport, ledger);
  } catch {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      issueIds: (fixReport.fixed || []).map((fixed) => fixed.issue_id),
      summary: 'fix report issue IDs do not match accepted or reopened ledger issues',
      nextAction: 'submit a fix report containing only accepted or reopened issue IDs'
    });
  }

  const persistedBaseline = readPersistedFileSetBaseline(metadata);
  const monitoredSet = monitoredSetFromBaseline(persistedBaseline, { routeKind: metadata.routeKind });
  if (!monitoredSet) {
    return endFixBlocked(metadata, 'target-only-guard-unavailable', {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      summary: 'persisted begin-fix file-set baseline is unavailable',
      nextAction: 'rerun begin-fix to establish the monitored file set before ending the fix'
    });
  }

  // Declared filesChanged must be a subset of the resolved, guarded file set.
  const allowedPaths = new Set(monitoredSet.map((entry) => entry.path));
  let declaredFiles;
  try {
    declaredFiles = (fixReport.filesChanged || [])
      .map((file) => normalizeFileSetEntry(metadata.projectRoot, file, { allowExcludedDirectories: true }).path);
  } catch (error) {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      summary: `declared changed file is not a safe in-root path: ${error && error.message ? error.message : String(error)}`
    });
  }
  const outsideSet = declaredFiles.filter((file) => !allowedPaths.has(file));
  if (outsideSet.length > 0) {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: declaredFiles.join(', '),
      summary: `fix report declared files outside the resolved file set: ${outsideSet.join(', ')}`
    });
  }

  // ACTUAL changed-file inspection against the begin-fix baseline. Git status is still
  // used as a live out-of-set guard, but the files credited to this round must be the
  // content delta since begin-fix, not all route-owned dirt relative to HEAD.
  const guardMode = guardModeFor(metadata);
  let actualChanged;
  if (guardMode === 'git') {
    const guardResult = checkFileSetWorktree({
      projectRoot: metadata.projectRoot,
      allowedFiles: monitoredSet,
      allowedStateDir: metadata.targetStateDir
    });
    if (guardResult.status === 'blocked') {
      return endFixBlocked(metadata, guardResult.blockingReason || 'unexpected-worktree-change', {
        issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
        filesChanged: declaredFiles.join(', '),
        summary: 'actual worktree changes fall outside the resolved file set'
      });
    }
    const validation = validateFileSetBaseline({
      projectRoot: metadata.projectRoot,
      monitoredFiles: monitoredSet,
      baseline: persistedBaseline,
      allowedStateDir: metadata.targetStateDir,
      forceIncludeDirs: snapshotForceIncludeDirs(metadata)
    });
    if (validation.status === 'blocked') {
      return endFixBlocked(metadata, validation.blockingReason || 'unexpected-worktree-change', {
        issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
        filesChanged: declaredFiles.join(', '),
        summary: 'begin-fix baseline validation blocked end-fix'
      });
    }
    actualChanged = validation.changedFiles || [];
  } else {
    const validation = validateFileSetBaseline({
      projectRoot: metadata.projectRoot,
      monitoredFiles: monitoredSet,
      baseline: persistedBaseline,
      allowedStateDir: metadata.targetStateDir,
      forceIncludeDirs: snapshotForceIncludeDirs(metadata)
    });
    if (validation.status === 'blocked') {
      return endFixBlocked(metadata, validation.blockingReason || 'unexpected-worktree-change', {
        issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
        filesChanged: declaredFiles.join(', '),
        summary: 'snapshot baseline validation blocked end-fix'
      });
    }
    actualChanged = validation.changedFiles || [];
  }

  // The actual changed set must equal the declared set (a real, scoped fix was applied).
  if (stableJson([...new Set(actualChanged)].sort()) !== stableJson([...new Set(declaredFiles)].sort())) {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: actualChanged.join(', ') || 'none',
      summary: 'actual changed files differ from the fix report'
    });
  }
  if (declaredFiles.length === 0) {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: 'none',
      summary: 'no file in the recorded set changed; no real fix was applied'
    });
  }

  // CHECKPOINT 3 (after end-fix): the in-set fix delta is validated, but run.md may have
  // drifted/been deleted/become incomplete DURING the fix. Revalidate before recording the
  // fix or transitioning toward diff-review/PASS. Closing backstop for the Task-9 residual:
  // under guard=snapshot a DELETE-only of run.md is NOT caught by the file-set guard (run.md
  // is not a monitored member), but the re-read here fails and BLOCKS. See file-set-r2p-gate.js.
  const endGateDrift = revalidateR2pGate(metadata);
  if (endGateDrift) {
    return endFixBlocked(metadata, endGateDrift.blockingReason, endGateBlockArgs(endGateDrift, {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: declaredFiles.join(', ')
    }));
  }

  // Plan B fork: an ACTIVE partition plan owns this target. The guard chain above
  // already proved the worktree delta == declared, in-set, route-owned fix, so this
  // is the one proven point at which we may re-stamp the partition plan and bounded
  // re-review only the affected units. A non-partitioned (or stale/inactive) target
  // falls through to the unchanged diff-review transition below.
  const activePartitionPlan = readActivePartitionedPlan(metadata);
  if (activePartitionPlan) {
    try {
      return await applyPartitionedIncrement({
        metadata,
        declaredFiles,
        fixReport,
        ledger,
        options,
        oldPlan: activePartitionPlan,
      });
    } finally {
      releaseLeaseQuietly(metadata);
    }
  }

  let liveFileSet;
  try {
    liveFileSet = await resolveLiveFileSet(metadata, options);
  } catch (error) {
    return endFixBlocked(metadata, 'state-validation-failed', {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: declaredFiles.join(', '),
      summary: `unable to resolve the live file set after fix: ${error && error.message ? error.message : String(error)}`
    });
  }

  const reportPath = writeNormalizedFixReport({ metadata, fixReport });
  const nextLedger = updateFixedIssues(ledger, fixReport);
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
  const fingerprint = liveFileSetFingerprint(liveFileSet);
  updatePersistentManifest(metadata, {
    status: 'diff-review',
    currentPhase: 'diff-review',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: stateRelativePath(metadata.targetStateDir, reportPath),
    lastFixReportPath: stateRelativePath(metadata.targetStateDir, reportPath),
    fileSetFingerprint: fingerprint,
    lastModifiedAt: new Date().toISOString()
  });
  if (Array.isArray(fixReport.verification)) {
    // Record per-round verification only when the optional section is present.
    try {
      writeFixReceipt(metadata, {
        kind: 'fix-applied',
        status: 'end-fix',
        issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
        filesChanged: declaredFiles.join(', '),
        verification: fixReport.verification.join('; '),
        summary: 'file-set fix applied within the resolved file set'
      });
    } catch { /* receipt is best-effort */ }
  }
  releaseLeaseQuietly(metadata);

  // PLAN-TASK-011: a partitioned target that reached this point passed the live
  // projectReviewFingerprint freshness gate above. A content-changing fix always moves
  // that fingerprint, so a partitioned end-fix blocks there and requires a fresh
  // partition (the cache then re-reviews only the changed units). For an ACTIVE partition
  // plan the fix loop is already refused at begin-fix (the primary read-only gate); this
  // freshness gate stays as the backstop for an inactive/stale plan. The legacy
  // non-partitioned end-fix transition is unchanged.
  return stateCommandBase(metadata, {
    ok: true,
    status: 'end-fix',
    fixReportPath: reportPath,
    fixedIssueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
    ...(Array.isArray(fixReport.verification) ? { verification: fixReport.verification } : {}),
    nextAction: 'run record-diff-review'
  });
}

function runAbortFix(parsed) {
  let metadata;
  try {
    metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }
  const { BLOCKING_REASONS, STATUS_REASONS } = require('../workflow-state');
  const status = parsed.payloadFlags.status;
  const reason = parsed.payloadFlags.reason;
  const nextAction = parsed.payloadFlags.nextAction || 'none';
  if (!['blocked', 'checkpoint'].includes(status)) {
    return stateValidationResult(parsed.targetStateDir, new Error('abort-fix requires --status blocked|checkpoint'));
  }
  if (status === 'blocked' && (!reason || reason === 'none' || !BLOCKING_REASONS.includes(reason))) {
    return stateValidationResult(parsed.targetStateDir, new Error('abort-fix blocked status requires an allowed blocking reason'));
  }
  if (status === 'checkpoint' && (!reason || !STATUS_REASONS.includes(reason) || reason === 'none')) {
    return stateValidationResult(parsed.targetStateDir, new Error('abort-fix checkpoint status requires an allowed status reason'));
  }

  // Persisted file-set baselines are metadata-only. Abort can only restore entries that have
  // a restorable body from a non-persisted caller; otherwise it blocks rather than guessing.
  const baseline = readPersistedFileSetBaseline(metadata);
  if (!baseline) {
    updatePersistentManifest(metadata, { status: 'blocked', blockingReason: 'rollback-unavailable', statusReason: 'none' });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      blockingReason: 'rollback-unavailable',
      statusReason: 'none',
      nextAction: 'restore the monitored file set before continuing'
    });
  }
  const monitoredSet = monitoredSetFromBaseline(baseline, { routeKind: metadata.routeKind });
  const monitoredFiles = monitoredSet ? monitoredSet.map((entry) => entry.path) : [];
  const restored = restoreFileSetBaseline({
    projectRoot: metadata.projectRoot,
    monitoredFiles,
    baseline
  });
  if (restored.status !== 'passed') {
    updatePersistentManifest(metadata, { status: 'blocked', blockingReason: 'rollback-unavailable', statusReason: 'none' });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      blockingReason: 'rollback-unavailable',
      statusReason: 'none',
      nextAction: 'restore the monitored file set before continuing'
    });
  }

  try {
    writeFixReceipt(metadata, {
      kind: 'abort',
      status,
      blockingReason: status === 'blocked' ? reason : 'none',
      statusReason: status === 'checkpoint' ? reason : 'none',
      summary: 'file-set fix aborted by coordinator',
      nextAction
    });
  } catch { /* best-effort */ }
  updatePersistentManifest(metadata, {
    status,
    blockingReason: status === 'blocked' ? reason : 'none',
    statusReason: status === 'checkpoint' ? reason : 'none'
  });
  releaseLeaseQuietly(metadata);
  return stateCommandBase(metadata, {
    ok: true,
    status,
    blockingReason: status === 'blocked' ? reason : 'none',
    statusReason: status === 'checkpoint' ? reason : 'none',
    nextAction,
    receiptKind: 'abort'
  });
}

function runFileSetFixLifecycleCommand(parsed, options) {
  try {
    const metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
    if (metadata.routeKind === 'r2p') {
      return {
        ...stateCommandBase(metadata, { status: 'blocked' }),
        ok: false,
        blockingReason: 'r2p-direct-artifact-write-forbidden',
        statusReason: 'none',
        nextAction: 'run record-r2p-repair-plan or apply-r2p-repair instead of direct artifact writes'
      };
    }
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }
  if (parsed.subcommand === 'begin-fix') return runBeginFix(parsed, options);
  if (parsed.subcommand === 'refresh-lock') return runRefreshLock(parsed, options);
  if (parsed.subcommand === 'end-fix') return runEndFix(parsed, options);
  if (parsed.subcommand === 'abort-fix') return runAbortFix(parsed, options);
  fail('ERR_WORKFLOW_COMMAND', `unsupported file-set fix lifecycle command: ${parsed.subcommand}`);
}

module.exports = {
  runFileSetFixLifecycleCommand,
  fileSetStateValidation
};
