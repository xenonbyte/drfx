'use strict';

// PLAN-TASK-009 (Phase C2): file-set (PR/CODE) fix lifecycle. This is the file-set analog
// of fix-lifecycle.js. The fixer's write boundary is the RECORDED dependency set (file-set
// members + recorded necessary dependencies), enforced by the Task-6 file-set guards
// (checkFileSetWorktree for git, captureFileSetBaseline/validateFileSetBaseline/
// restoreFileSetBaseline + ensureDependencyBaseline for snapshot) BEFORE any write. Every
// automatic fix round records a real per-round verification (method + result, or an honest
// "none could run").
//
// SAFETY: no file outside the recorded, guarded set may be written; for guard=snapshot the
// baseline is taken BEFORE the write; never a silent fallback; never PASS from a fix alone.

const {
  acquireLock,
  atomicWriteFile,
  captureFileSetBaseline,
  checkFileSetWorktree,
  computeFileSetFingerprint,
  computeFingerprint,
  crypto,
  fail,
  failStateValidation,
  formatLedger,
  fs,
  fixableIssuesFromLedger,
  normalizeDependencyEntry,
  padRound,
  parseFixReport,
  path,
  readFixReportPayload,
  readLedgerIfPresent,
  recordedDependencySet,
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

const MAX_FIX_ATTEMPTS = 5;
const LOCK_ANCHOR_BASENAME = 'file-set.lock-anchor';
const BASELINE_BASENAME = 'file-set-baseline.json';

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
  const context = await resolveCodeTarget({
    cwd: metadata.projectRoot,
    scopes: metadata.manifest.normalizedScopes || []
  });
  if (context && context.status === 'blocked') {
    fail('ERR_FILE_SET_RESOLVE', `excluded-scope: ${context.scope}`);
  }
  return { routeKind: 'code', files: context.files };
}

function monitoredSetFor(metadata, liveFileSet) {
  // The monitored set is the recorded dependency set: live file-set members + any recorded
  // necessary dependencies, each validated in-root + non-excluded.
  return recordedDependencySet({
    projectRoot: metadata.projectRoot,
    liveFileSet,
    extraDependencies: Array.isArray(metadata.manifest.recordedDependencies)
      ? metadata.manifest.recordedDependencies
      : []
  });
}

function lockAnchorPath(metadata) {
  return path.join(metadata.targetStateDir, LOCK_ANCHOR_BASENAME);
}

function baselinePath(metadata) {
  return path.join(metadata.targetStateDir, BASELINE_BASENAME);
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
  if (metadata.manifest.status !== 'fix' || metadata.manifest.currentPhase !== 'fix') {
    failStateValidation('begin-fix requires Status: fix and Current phase: fix');
  }
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  if (fixableIssuesFromLedger(ledger).length === 0) {
    failStateValidation('begin-fix requires accepted or reopened issue IDs');
  }
  return ledger;
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
    return stateCommandBase(metadata, {
      ok: true,
      status: 'begin-fix',
      lockOwnerId: existingLease.ownerId,
      leaseId: existingLease.leaseId,
      leaseExpiresAt: existingLease.expiresAt,
      refreshAfterSeconds: 60,
      nextAction: 'continue the in-progress fix'
    });
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

  let liveFileSet;
  let monitoredSet;
  try {
    liveFileSet = await resolveLiveFileSet(metadata, options);
    monitoredSet = monitoredSetFor(metadata, liveFileSet);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  const liveFingerprint = computeFileSetFingerprint(liveFileSet.files);
  if (priorAttempts > 0 && liveFingerprint !== String(metadata.manifest.fileSetFingerprint || 'none')) {
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
      summary: 'file-set content changed since the last recorded fix result',
      nextAction: 'restore the file set to the last recorded fix result before retrying begin-fix'
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
    // monitored set, and so a newly-recorded dependency is baselined before its first write.
    const baseline = captureFileSetBaseline({
      projectRoot: metadata.projectRoot,
      monitoredFiles: monitoredSet,
      allowedStateDir: metadata.targetStateDir
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
    // Persist the baseline (without bodies for size) plus an in-memory body cache for restore
    // within abort-fix. Store the captured baseline alongside the state.
    persistBaseline(metadata, baseline);

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
    const blockingReason = (error && error.blockingReason) || 'state-validation-failed';
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

// Persist the baseline (with bodies) so abort-fix can restore even after lock release. Bodies
// are buffers; serialize to base64 in the state file.
function persistBaseline(metadata, baseline) {
  const serializable = {
    status: baseline.status,
    guardMode: baseline.guardMode,
    entries: baseline.entries.map((entry) => ({
      path: entry.path,
      pathSha256: entry.pathSha256,
      missing: entry.missing === true,
      sha256: entry.sha256,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      body: entry.body !== null && entry.body !== undefined
        ? Buffer.from(entry.body).toString('base64')
        : null
    })),
    treeEntries: Array.isArray(baseline.treeEntries) ? baseline.treeEntries : [],
    excludedDirectories: Array.isArray(baseline.excludedDirectories) ? baseline.excludedDirectories : []
  };
  atomicWriteFile(baselinePath(metadata), JSON.stringify(serializable));
}

function readPersistedBaseline(metadata) {
  const file = baselinePath(metadata);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.status !== 'passed' || !Array.isArray(parsed.entries)) return null;
  return {
    status: 'passed',
    guardMode: parsed.guardMode || 'snapshot',
    entries: parsed.entries.map((entry) => ({
      ...entry,
      body: entry.body !== null && entry.body !== undefined
        ? Buffer.from(entry.body, 'base64')
        : undefined
    })),
    treeEntries: Array.isArray(parsed.treeEntries) ? parsed.treeEntries : [],
    excludedDirectories: Array.isArray(parsed.excludedDirectories) ? parsed.excludedDirectories : []
  };
}

function monitoredSetFromBaseline(baseline) {
  if (!baseline || !Array.isArray(baseline.entries)) return null;
  return baseline.entries
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
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }
  const lease = readLease({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey });
  if (!lease) {
    return stateValidationResult(parsed.targetStateDir, new Error('corrupt-lock: no active lease to refresh'));
  }
  if (Date.parse(lease.expiresAt) <= (options.now || new Date()).getTime()) {
    updatePersistentManifest(metadata, { status: 'blocked', blockingReason: 'corrupt-lock', statusReason: 'none' });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      blockingReason: 'corrupt-lock',
      statusReason: 'none',
      nextAction: 'restart fix after repairing the target lock'
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

  // Per-round verification MUST be recorded for an automatic fix round (real method + result,
  // or an honest "none could run"). A missing verification section blocks (never a silent skip).
  if (!Array.isArray(fixReport.verification) || fixReport.verification.length === 0) {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      issueIds: (fixReport.fixed || []).map((fixed) => fixed.issue_id),
      summary: 'fix report is missing the required per-round Verification section',
      nextAction: 'add a Verification section recording the command/inspection method and its result (or that none could run)'
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

  const persistedBaseline = readPersistedBaseline(metadata);
  const monitoredSet = monitoredSetFromBaseline(persistedBaseline);
  if (!monitoredSet) {
    return endFixBlocked(metadata, 'target-only-guard-unavailable', {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      summary: 'persisted begin-fix file-set baseline is unavailable',
      nextAction: 'rerun begin-fix to establish the monitored file set before ending the fix'
    });
  }

  // Declared filesChanged must be a subset of the recorded, guarded dependency set.
  const allowedPaths = new Set(monitoredSet.map((entry) => entry.path));
  let declaredFiles;
  try {
    declaredFiles = (fixReport.filesChanged || [])
      .map((file) => normalizeDependencyEntry(metadata.projectRoot, file, { allowExcludedDirectories: true }).path);
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
      summary: `fix report declared files outside the recorded file set: ${outsideSet.join(', ')}`
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
        summary: 'actual worktree changes fall outside the recorded file set'
      });
    }
    const validation = validateFileSetBaseline({
      projectRoot: metadata.projectRoot,
      monitoredFiles: monitoredSet,
      baseline: persistedBaseline,
      allowedStateDir: metadata.targetStateDir
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
      allowedStateDir: metadata.targetStateDir
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
  const fingerprint = computeFileSetFingerprint(liveFileSet.files);
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
  // Record the per-round verification in a receipt so the audit trail captures the method.
  try {
    writeFixReceipt(metadata, {
      kind: 'fix-applied',
      status: 'end-fix',
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: declaredFiles.join(', '),
      verification: fixReport.verification.join('; '),
      summary: 'file-set fix applied within the recorded dependency set'
    });
  } catch { /* receipt is best-effort */ }
  releaseLeaseQuietly(metadata);
  return stateCommandBase(metadata, {
    ok: true,
    status: 'end-fix',
    fixReportPath: reportPath,
    fixedIssueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
    verification: fixReport.verification,
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

  // Restore the monitored set from the captured baseline (snapshot semantics; writes ONLY
  // monitored files). A missing baseline blocks as rollback-unavailable.
  const baseline = readPersistedBaseline(metadata);
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
  const monitoredFiles = baseline.entries.map((entry) => entry.path);
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
