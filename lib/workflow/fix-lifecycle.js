'use strict';

const {
  BLOCKING_REASONS,
  STATUS_REASONS,
  acquireLock,
  activeLeaseOrBlock,
  assertFixEligible,
  assertPreFixFingerprint,
  assertReferencesUnchanged,
  atomicWriteFile,
  beginFixBlocked,
  captureSnapshot,
  checkGitRollbackAnchor,
  checkSnapshotTargetOnly,
  checkTargetOnlyWorktree,
  computeFingerprint,
  crypto,
  endFixBlocked,
  fail,
  failStateValidation,
  fixableIssuesFromLedger,
  formatLedger,
  fs,
  inspectActualChangedFiles,
  inspectActualChangedFilesSnapshot,
  lockReleaseFailureResult,
  path,
  parseFixReport,
  readFixReportPayload,
  readLatestFixGuardBaseline,
  readLedgerIfPresent,
  receiptFailureResult,
  refreshLock,
  releaseLock,
  releasePersistedLease,
  restoreSnapshot,
  resolveStateCommandMetadata,
  stableJson,
  stateCommandBase,
  stateRelativePath,
  stateValidationResult,
  updateFixedIssues,
  updatePersistentManifest,
  validateDeclaredFilesChanged,
  validateFixedIssueIds,
  writeBeginFixGuardReport,
  writeFixReceipt,
  writeNormalizedFixReport,
  targetStatePathFromManifest
} = require('./helpers');
const { readLease } = require('../lock');

const MAX_FIX_ATTEMPTS = 5;
const FIX_REPORT_RETRY_NEXT_ACTION = 'retry end-fix with a valid fix report';
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function guardModeFor(metadata) {
  return metadata.manifest.guardMode || 'git';
}

function referencePathsForSnapshot(metadata) {
  return (metadata.manifest.references || []).map((referencePath) => (
    path.isAbsolute(referencePath) ? referencePath : path.resolve(metadata.projectRoot, referencePath)
  ));
}

function activeBeginFixResult(metadata, now) {
  const lease = readLease({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey });
  if (!lease) return null;
  const expiresAtMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) return null;
  if (
    lease.targetKey !== metadata.targetKey ||
    path.resolve(lease.targetPath) !== path.resolve(metadata.targetPath)
  ) {
    const error = new Error('corrupt-lock: active lease does not match target');
    error.code = 'ERR_CORRUPT_LOCK';
    error.reason = 'corrupt-lock';
    throw error;
  }

  const guardBaseline = readLatestFixGuardBaseline(metadata);
  if (!guardBaseline.ok) return stateValidationResult(metadata.targetStateDir, guardBaseline.error);
  return stateCommandBase(metadata, {
    ok: true,
    status: 'begin-fix',
    lockOwnerId: lease.ownerId,
    leaseId: lease.leaseId,
    leaseExpiresAt: lease.expiresAt,
    refreshAfterSeconds: 60,
    fixGuardReportPath: guardBaseline.reportPath,
    nextAction: 'continue the in-progress fix'
  });
}

function isFixReportMismatchRetryManifest(manifest) {
  return Boolean(
    manifest &&
    (manifest.targetContextKind || 'document') === 'document' &&
    manifest.status === 'blocked' &&
    manifest.currentPhase === 'fix' &&
    manifest.blockingReason === 'fix-report-mismatch'
  );
}

function currentRoundFixBlockedReceiptPath(metadata) {
  const round = Number(metadata.manifest.currentRound || 1);
  return path.join(metadata.targetStateDir, 'rounds', `${String(round).padStart(3, '0')}-fix-blocked.md`);
}

function currentRoundFixBlockedReceiptPaths(metadata) {
  const basePath = currentRoundFixBlockedReceiptPath(metadata);
  const roundsDir = path.dirname(basePath);
  const baseName = path.basename(basePath);
  const prefix = baseName.slice(0, -'.md'.length);
  let names;
  try {
    names = fs.readdirSync(roundsDir);
  } catch {
    return [basePath];
  }
  const attemptPattern = new RegExp(`^${prefix}-attempt-(\\d{3})\\.md$`);
  return names
    .map((name) => {
      if (name === baseName) return { attempt: 0, path: path.join(roundsDir, name) };
      const match = name.match(attemptPattern);
      if (!match) return null;
      return { attempt: Number(match[1]), path: path.join(roundsDir, name) };
    })
    .filter(Boolean)
    .sort((a, b) => b.attempt - a.attempt)
    .map((entry) => entry.path);
}

function receiptField(text, label) {
  const prefix = `- ${label}: `;
  const line = String(text).split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

function hasCurrentRoundFixReportMismatchReceipt(metadata) {
  for (const receiptPath of currentRoundFixBlockedReceiptPaths(metadata)) {
    let text;
    try {
      text = fs.readFileSync(receiptPath, 'utf8');
    } catch {
      continue;
    }
    if (
      receiptField(text, 'Kind') === 'fix-blocked' &&
      receiptField(text, 'Status') === 'blocked' &&
      receiptField(text, 'Blocking reason') === 'fix-report-mismatch'
    ) {
      return true;
    }
  }
  return false;
}

function assertFixReportMismatchRetryEligible(metadata) {
  if (metadata.manifest.mode !== 'review-and-fix') {
    failStateValidation('begin-fix retry requires Mode: review-and-fix');
  }
  if (metadata.manifest.assurance === 'advisory') {
    failStateValidation('begin-fix retry rejects Assurance: advisory');
  }
  if (!isFixReportMismatchRetryManifest(metadata.manifest)) {
    failStateValidation('begin-fix retry requires Status: blocked, Current phase: fix, and Blocking reason: fix-report-mismatch');
  }
  if (!hasCurrentRoundFixReportMismatchReceipt(metadata)) {
    failStateValidation('begin-fix retry requires the current round fix-report-mismatch end-fix receipt');
  }
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const fixableIssues = fixableIssuesFromLedger(ledger);
  if (fixableIssues.length === 0) {
    failStateValidation('begin-fix retry requires accepted or reopened issue IDs');
  }
  return { ledger, fixableIssues };
}

function retryBlockedResult(metadata, blockingReason, {
  summary,
  nextAction,
  errorCode = null,
  message = null
} = {}) {
  try {
    writeFixReceipt(metadata, {
      status: 'blocked',
      blockingReason,
      summary,
      nextAction
    });
  } catch (error) {
    return receiptFailureResult(metadata, error);
  }
  updatePersistentManifest(metadata, {
    status: 'blocked',
    currentPhase: 'fix',
    blockingReason,
    statusReason: 'none'
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    currentPhase: 'fix',
    blockingReason,
    statusReason: 'none',
    errorCode,
    message,
    nextAction
  });
}

function retryGuardUnavailable(metadata, error) {
  return retryBlockedResult(metadata, 'target-only-guard-unavailable', {
    summary: 'persisted passed begin-fix guard baseline is unavailable or unsafe',
    nextAction: 'restart the fix from a valid begin-fix guard baseline before retrying end-fix',
    errorCode: error && error.code ? error.code : 'ERR_FIX_GUARD_BASELINE',
    message: error && error.message ? error.message : String(error)
  });
}

function inspectRetryChangedFiles(metadata, guardReport) {
  if (guardModeFor(metadata) === 'snapshot') {
    return inspectActualChangedFilesSnapshot({
      projectRoot: metadata.projectRoot,
      targetPath: metadata.targetPath,
      allowedStateDir: metadata.targetStateDir,
      expectedNormalizedTarget: metadata.normalizedTarget,
      targetOnlyGuard: guardReport.targetOnlyGuard
    });
  }
  return inspectActualChangedFiles({
    projectRoot: metadata.projectRoot,
    targetPath: metadata.targetPath,
    allowedStateDir: metadata.targetStateDir,
    expectedNormalizedTarget: metadata.normalizedTarget
  });
}

function retryTargetMutation(metadata) {
  const expectedSha = metadata.manifest.lastKnownContentSha256;
  if (!expectedSha || expectedSha === 'none') return null;
  try {
    return computeFingerprint(metadata.targetPath).sha256 === expectedSha
      ? null
      : 'unexpected-worktree-change';
  } catch {
    return 'unexpected-worktree-change';
  }
}

function fixReportMismatchTargetUpdates(metadata) {
  try {
    const targetFingerprint = computeFingerprint(metadata.targetPath);
    return {
      lastKnownContentSha256: targetFingerprint.sha256,
      fileSize: targetFingerprint.size,
      lastModifiedAt: new Date(targetFingerprint.mtimeMs).toISOString()
    };
  } catch {
    return {};
  }
}

function endFixReportMismatchBlocked(metadata, options = {}) {
  return endFixBlocked(metadata, 'fix-report-mismatch', {
    ...options,
    manifestUpdates: fixReportMismatchTargetUpdates(metadata)
  });
}

function snapshotBodyFingerprint(absolutePath) {
  let body;
  try {
    body = fs.readFileSync(absolutePath);
  } catch (error) {
    failStateValidation(`Rollback snapshot body is missing or unreadable: ${error && error.message ? error.message : String(error)}`);
  }
  return {
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    size: body.length
  };
}

function validateSnapshotBodyFingerprint(actual, expected) {
  if (
    !expected ||
    typeof expected.sha256 !== 'string' ||
    !SHA256_HEX_PATTERN.test(expected.sha256) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0
  ) {
    failStateValidation('Rollback snapshot expected fingerprint is missing or invalid');
  }
  if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
    failStateValidation('Rollback snapshot body fingerprint does not match begin-fix target fingerprint');
  }
}

function validateSnapshotRollbackBody(metadata, guardReport = {}) {
  const rollbackAnchor = guardReport.rollbackAnchor || {};
  if (!rollbackAnchor.snapshotPath) failStateValidation('Rollback snapshot path is missing');
  const snapshotPath = rollbackAnchor.snapshotPath;
  const absolutePath = targetStatePathFromManifest(metadata.targetStateDir, snapshotPath, null, {
    allowedDirectories: ['snapshots'],
    label: 'Rollback snapshot path'
  });
  let stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch (error) {
    failStateValidation(`Rollback snapshot body is missing or unreadable: ${error && error.message ? error.message : String(error)}`);
  }
  if (stats.isSymbolicLink()) failStateValidation('Rollback snapshot body must not be a symlink');
  if (!stats.isFile()) failStateValidation('Rollback snapshot body must be a regular file');
  validateSnapshotBodyFingerprint(snapshotBodyFingerprint(absolutePath), guardReport.targetFingerprint);
}

function fixReportMismatchRetryResult(metadata, options) {
  try {
    assertFixReportMismatchRetryEligible(metadata);
  } catch (error) {
    return stateValidationResult(metadata.targetStateDir, error);
  }

  const guardBaseline = readLatestFixGuardBaseline(metadata);
  if (!guardBaseline.ok) return retryGuardUnavailable(metadata, guardBaseline.error);

  try {
    validateSnapshotRollbackBody(metadata, guardBaseline.report);
  } catch (error) {
    return retryGuardUnavailable(metadata, error);
  }

  const referenceMutation = assertReferencesUnchanged(metadata, guardBaseline.report);
  if (referenceMutation) {
    return retryBlockedResult(metadata, referenceMutation, {
      summary: 'reference fingerprints changed before fix-report retry',
      nextAction: 'restore reference documents to the persisted begin-fix fingerprints before retrying'
    });
  }

  const targetMutation = retryTargetMutation(metadata);
  if (targetMutation) {
    return retryBlockedResult(metadata, targetMutation, {
      summary: 'target fingerprint changed after the fix-report mismatch was recorded',
      nextAction: 'restore the target file to the fix-report-mismatch state before retrying end-fix'
    });
  }

  const actual = inspectRetryChangedFiles(metadata, guardBaseline.report);
  if (actual.status === 'blocked') {
    const blockingReason = actual.blockingReason || 'unexpected-worktree-change';
    return retryBlockedResult(metadata, blockingReason, {
      summary: 'blocked fix-report retry guard blocked unexpected worktree changes',
      nextAction: blockingReason === 'target-only-guard-unavailable'
        ? 'restart the fix from a valid begin-fix guard baseline before retrying end-fix'
        : 'restore unrelated worktree changes before retrying end-fix'
    });
  }

  let lease;
  try {
    const ownerId = `drfx-${crypto.randomUUID()}`;
    lease = acquireLock({
      projectRoot: metadata.projectRoot,
      targetKey: metadata.targetKey,
      targetPath: metadata.targetPath,
      ownerId,
      mode: metadata.manifest.mode,
      strictness: metadata.manifest.strictness,
      now: options.now || new Date(),
      lastKnownContentSha256: metadata.manifest.lastKnownContentSha256,
      manifest: metadata.manifest
    });
    assertPreFixFingerprint({
      targetPath: metadata.targetPath,
      lease,
      manifest: metadata.manifest
    });
    updatePersistentManifest(metadata, {
      status: 'fix',
      currentPhase: 'fix',
      blockingReason: 'none',
      statusReason: 'none',
      currentReportPath: stateRelativePath(metadata.targetStateDir, guardBaseline.reportPath),
      runtimeFingerprintGuard: 'passed'
    });
    return stateCommandBase(metadata, {
      ok: true,
      status: 'begin-fix',
      lockOwnerId: lease.ownerId,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.expiresAt,
      refreshAfterSeconds: 60,
      fixGuardReportPath: guardBaseline.reportPath,
      nextAction: FIX_REPORT_RETRY_NEXT_ACTION
    });
  } catch (error) {
    if (lease) {
      try {
        releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
      } catch {
        // The retry remains blocked; a later begin-fix/abort-fix can repair stale lock state.
      }
    }
    const blockingReason = (error && (error.blockingReason || error.reason)) || 'state-validation-failed';
    return retryBlockedResult(metadata, blockingReason, {
      summary: 'unable to reacquire document fix lock for fix-report retry',
      nextAction: 'repair the target lock and retry begin-fix',
      errorCode: error && error.code ? error.code : 'ERR_FIX_RETRY_LOCK',
      message: error && error.message ? error.message : String(error)
    });
  }
}

function abortRollbackUnavailable(metadata, error) {
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason: 'rollback-unavailable',
    statusReason: 'none'
  });
  const message = error && error.message
    ? `rollback-unavailable: ${error.message}`
    : 'rollback-unavailable: fix guard baseline is unavailable';
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason: 'rollback-unavailable',
    statusReason: 'none',
    errorCode: 'ERR_ROLLBACK_UNAVAILABLE',
    message,
    nextAction: 'restore target snapshot before continuing'
  });
}

function runBeginFix(parsed, options) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
    if (isFixReportMismatchRetryManifest(metadata.manifest)) {
      return fixReportMismatchRetryResult(metadata, options);
    }
    assertFixEligible(metadata);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  const ownerId = `drfx-${crypto.randomUUID()}`;
  let lease;
  try {
    const now = options.now || new Date();
    const activeResult = activeBeginFixResult(metadata, now);
    if (activeResult) return activeResult;

    const priorAttempts = Number(metadata.manifest.fixAttemptCount || 0);
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
    lease = acquireLock({
      projectRoot: metadata.projectRoot,
      targetKey: metadata.targetKey,
      targetPath: metadata.targetPath,
      ownerId,
      mode: metadata.manifest.mode,
      strictness: metadata.manifest.strictness,
      now,
      lastKnownContentSha256: metadata.manifest.lastKnownContentSha256,
      manifest: metadata.manifest
    });
    assertPreFixFingerprint({
      targetPath: metadata.targetPath,
      lease,
      manifest: metadata.manifest
    });
    const guardMode = guardModeFor(metadata);
    const priorFix = Boolean(
      metadata.manifest.lastKnownContentSha256 &&
      metadata.manifest.initialContentSha256 &&
      metadata.manifest.lastKnownContentSha256 !== metadata.manifest.initialContentSha256
    );
    const snapshotRound = Number(metadata.manifest.currentRound || 1);

    let rollbackAnchor;
    let targetOnlyGuard;
    if (guardMode === 'snapshot') {
      rollbackAnchor = captureSnapshot({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        targetStateDir: metadata.targetStateDir,
        round: snapshotRound,
        expectedNormalizedTarget: metadata.normalizedTarget
      });
      targetOnlyGuard = checkSnapshotTargetOnly({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        allowedStateDir: metadata.targetStateDir,
        expectedNormalizedTarget: metadata.normalizedTarget,
        referencePaths: referencePathsForSnapshot(metadata)
      });
    } else {
      const gitAnchor = checkGitRollbackAnchor({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        expectedNormalizedTarget: metadata.normalizedTarget,
        priorFix
      });
      // git mode also takes a per-fix body snapshot so abort-fix can restore (Task 3).
      const snapshot = captureSnapshot({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        targetStateDir: metadata.targetStateDir,
        round: snapshotRound,
        expectedNormalizedTarget: metadata.normalizedTarget
      });
      rollbackAnchor = { ...gitAnchor, guardMode: 'git', snapshotPath: snapshot.snapshotPath };
      targetOnlyGuard = priorFix
        ? inspectActualChangedFiles({
          projectRoot: metadata.projectRoot,
          targetPath: metadata.targetPath,
          allowedStateDir: metadata.targetStateDir,
          expectedNormalizedTarget: metadata.normalizedTarget
        })
        : checkTargetOnlyWorktree({
          projectRoot: metadata.projectRoot,
          targetPath: metadata.targetPath,
          allowedStateDir: metadata.targetStateDir,
          expectedNormalizedTarget: metadata.normalizedTarget
        });
    }
    if (targetOnlyGuard.status === 'blocked') {
      return beginFixBlocked(metadata, lease, {
        blockingReason: targetOnlyGuard.blockingReason,
        rollbackAnchor,
        targetOnlyGuard,
        summary: 'pre-fix target-only guard blocked automatic target writes',
        nextAction: 'restore non-target worktree changes before retrying begin-fix'
      });
    }
    const reportPath = writeBeginFixGuardReport(metadata, {
      lease,
      rollbackAnchor,
      targetOnlyGuard,
      status: 'passed',
      blockingReason: 'none'
    });
    const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
    updatePersistentManifest(metadata, {
      status: 'fix',
      currentPhase: 'fix',
      blockingReason: 'none',
      statusReason: 'none',
      currentReportPath: relativeReportPath,
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
      fixGuardReportPath: reportPath
    });
  } catch (error) {
    const blockingReason = error && (error.blockingReason || error.reason);
    const mappedReason = blockingReason === 'rollback-unavailable' ||
      ['target-fingerprint-mismatch', 'manifest-fingerprint-mismatch'].includes(blockingReason) ||
      ['ENOENT', 'EACCES', 'ERR_FILE_MISSING'].includes(error && error.code)
      ? 'rollback-unavailable'
      : (blockingReason === 'target-only-guard-unavailable' ? 'target-only-guard-unavailable' : 'state-validation-failed');
    if (['rollback-unavailable', 'target-only-guard-unavailable'].includes(mappedReason)) {
      return beginFixBlocked(metadata, lease, {
        blockingReason: mappedReason,
        rollbackAnchor: mappedReason === 'rollback-unavailable'
          ? {
            status: 'blocked',
            blockingReason: mappedReason,
            entries: Array.isArray(error && error.entries) ? error.entries : []
          }
          : { status: 'not-run' },
        targetOnlyGuard: mappedReason === 'target-only-guard-unavailable'
          ? { status: 'blocked', blockingReason: mappedReason, entries: [] }
          : { status: 'not-run' },
        summary: `${mappedReason} blocked automatic target writes before fix`,
        nextAction: mappedReason === 'rollback-unavailable'
          ? 'restore a clean tracked target with git HEAD before retrying begin-fix'
          : 'restore target state and retry begin-fix',
        errorCode: error && error.code ? error.code : 'ERR_FIX_GUARD',
        message: error && error.message ? error.message : String(error)
      });
    }
    if (lease) {
      try {
        releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
      } catch {
        // The original pre-write guard failure is more useful here; a later end/abort can repair stale locks.
      }
    }
    updatePersistentManifest(metadata, {
      status: 'blocked',
      blockingReason: mappedReason,
      statusReason: 'none'
    });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      blockingReason: mappedReason,
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FIX_GUARD',
      message: error && error.message ? error.message : String(error),
      nextAction: mappedReason === 'rollback-unavailable'
        ? 'restore a clean tracked target with git HEAD before retrying begin-fix'
        : 'restore target state and retry begin-fix'
    });
  }
}

function runRefreshLock(parsed, options) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
    const lease = activeLeaseOrBlock(metadata);
    if (Date.parse(lease.expiresAt) <= (options.now || new Date()).getTime()) {
      const error = new Error('corrupt-lock: active lease is stale');
      error.code = 'ERR_CORRUPT_LOCK';
      error.status = 'blocked';
      error.reason = 'corrupt-lock';
      throw error;
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
    updatePersistentManifest(metadata, {
      status: 'blocked',
      blockingReason,
      statusReason: 'none'
    });
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

function runEndFix(parsed, options) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
    if (metadata.manifest.status !== 'fix' || metadata.manifest.currentPhase !== 'fix') {
      failStateValidation('end-fix requires Status: fix and Current phase: fix');
    }
    activeLeaseOrBlock(metadata);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  const guardBaseline = readLatestFixGuardBaseline(metadata);
  if (!guardBaseline.ok) {
    return endFixBlocked(metadata, 'target-only-guard-unavailable', {
      summary: 'persisted fix guard baseline is unavailable or unparseable',
      nextAction: 'rerun begin-fix before submitting end-fix'
    });
  }

  let fixReport;
  try {
    const payload = readFixReportPayload(parsed, metadata, options);
    fixReport = parseFixReport(payload, { allowVerification: true });
  } catch (error) {
    return endFixReportMismatchBlocked(metadata, {
      summary: 'fix report was unparseable',
      nextAction: 'submit a valid normalized fix report'
    });
  }

  let ledger;
  try {
    ledger = readLedgerIfPresent(metadata.ledgerPath);
    validateFixedIssueIds(fixReport, ledger);
  } catch (error) {
    return endFixReportMismatchBlocked(metadata, {
      issueIds: (fixReport.fixed || []).map((fixed) => fixed.issue_id),
      filesChanged: Array.isArray(fixReport.filesChanged) ? fixReport.filesChanged.join(', ') : 'none',
      summary: 'fix report issue IDs do not match accepted or reopened ledger issues',
      nextAction: 'submit a fix report containing only accepted or reopened issue IDs'
    });
  }

  const declaredMismatch = validateDeclaredFilesChanged(fixReport, metadata.normalizedTarget);
  if (declaredMismatch) {
    return endFixReportMismatchBlocked(metadata, {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: fixReport.filesChanged.join(', '),
      summary: 'fix report declared files changed outside the target'
    });
  }

  const actual = guardModeFor(metadata) === 'snapshot'
    ? inspectActualChangedFilesSnapshot({
      projectRoot: metadata.projectRoot,
      targetPath: metadata.targetPath,
      allowedStateDir: metadata.targetStateDir,
      expectedNormalizedTarget: metadata.normalizedTarget,
      targetOnlyGuard: guardBaseline.report.targetOnlyGuard
    })
    : inspectActualChangedFiles({
      projectRoot: metadata.projectRoot,
      targetPath: metadata.targetPath,
      allowedStateDir: metadata.targetStateDir,
      expectedNormalizedTarget: metadata.normalizedTarget
    });
  if (actual.status === 'blocked') {
    return endFixBlocked(metadata, actual.blockingReason, {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: fixReport.filesChanged.join(', '),
      summary: 'actual changed-file inspection blocked end-fix'
    });
  }
  if (stableJson(actual.changedFiles) !== stableJson([metadata.normalizedTarget])) {
    return endFixReportMismatchBlocked(metadata, {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: actual.changedFiles.join(', ') || 'none',
      summary: 'actual changed files differ from fix report'
    });
  }

  // The change-detection above is relative to the rollback anchor (git HEAD), so on a
  // subsequent fix it still reports the target as changed even when this round's fixer
  // changed nothing. Compare against this round's pre-fix fingerprint (captured at
  // begin-fix) to require the target actually differs from how it entered this round.
  const baselineTargetFingerprint = guardBaseline.report.targetFingerprint;
  if (baselineTargetFingerprint && baselineTargetFingerprint.sha256) {
    let currentTargetFingerprint;
    try {
      currentTargetFingerprint = computeFingerprint(metadata.targetPath);
    } catch {
      currentTargetFingerprint = null;
    }
    if (currentTargetFingerprint && currentTargetFingerprint.sha256 === baselineTargetFingerprint.sha256) {
      return endFixReportMismatchBlocked(metadata, {
        issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
        filesChanged: 'none',
        summary: 'target is unchanged from this round pre-fix state; no real fix was applied'
      });
    }
  }

  const guardReport = guardBaseline.report;
  const referenceMutation = assertReferencesUnchanged(metadata, guardReport);
  if (referenceMutation) {
    return endFixBlocked(metadata, referenceMutation, {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: fixReport.filesChanged.join(', '),
      summary: 'reference fingerprints changed during fix'
    });
  }

  const reportPath = writeNormalizedFixReport({ metadata, fixReport });
  const nextLedger = updateFixedIssues(ledger, fixReport);
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
  const targetFingerprint = computeFingerprint(metadata.targetPath);
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
  updatePersistentManifest(metadata, {
    status: 'diff-review',
    currentPhase: 'diff-review',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: relativeReportPath,
    lastFixReportPath: relativeReportPath,
    lastKnownContentSha256: targetFingerprint.sha256,
    fileSize: targetFingerprint.size,
    lastModifiedAt: new Date().toISOString()
  });
  try {
    releasePersistedLease(metadata);
  } catch (error) {
    return lockReleaseFailureResult(metadata, error, 'none');
  }
  return stateCommandBase(metadata, {
    ok: true,
    status: 'end-fix',
    fixReportPath: reportPath,
    fixedIssueIds: fixReport.fixed.map((fixed) => fixed.issue_id)
  });
}

function runAbortFix(parsed) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }
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

  let restoredFingerprint = null;
  const abortGuardMode = guardModeFor(metadata);
  if (['snapshot', 'git'].includes(abortGuardMode)) {
    const guardBaseline = readLatestFixGuardBaseline(metadata);
    if (!guardBaseline.ok) return abortRollbackUnavailable(metadata, guardBaseline.error);
    const rollbackAnchor = guardBaseline.report.rollbackAnchor;
    // Current snapshot/git fixes require a readable baseline to locate the rollback
    // snapshot. A valid git baseline without snapshotPath is legacy no-restore state.
    if (rollbackAnchor && (abortGuardMode === 'snapshot' || rollbackAnchor.snapshotPath)) {
      try {
        const restored = restoreSnapshot({
          projectRoot: metadata.projectRoot,
          targetPath: metadata.targetPath,
          targetStateDir: metadata.targetStateDir,
          round: Number(metadata.manifest.currentRound || 1),
          expectedNormalizedTarget: metadata.normalizedTarget,
          rollbackAnchor
        });
        if (restored.status === 'missing') {
          const error = new Error('rollback-unavailable: snapshot is missing');
          error.code = 'ERR_ROLLBACK_UNAVAILABLE';
          throw error;
        }
        restoredFingerprint = computeFingerprint(metadata.targetPath);
      } catch (error) {
        updatePersistentManifest(metadata, {
          status: 'blocked',
          blockingReason: 'rollback-unavailable',
          statusReason: 'none'
        });
        return stateCommandBase(metadata, {
          ok: false,
          status: 'blocked',
          blockingReason: 'rollback-unavailable',
          statusReason: 'none',
          errorCode: error && error.code ? error.code : 'ERR_ROLLBACK_UNAVAILABLE',
          message: error && error.message ? error.message : String(error),
          nextAction: 'restore target snapshot before continuing'
        });
      }
    }
  }

  try {
    writeFixReceipt(metadata, {
      kind: 'abort',
      status,
      blockingReason: status === 'blocked' ? reason : 'none',
      statusReason: status === 'checkpoint' ? reason : 'none',
      summary: 'fix aborted by coordinator',
      nextAction
    });
  } catch (error) {
    return receiptFailureResult(metadata, error);
  }
  updatePersistentManifest(metadata, {
    status,
    blockingReason: status === 'blocked' ? reason : 'none',
    statusReason: status === 'checkpoint' ? reason : 'none',
    ...(restoredFingerprint ? {
      lastKnownContentSha256: restoredFingerprint.sha256,
      fileSize: restoredFingerprint.size,
      lastModifiedAt: new Date(restoredFingerprint.mtimeMs).toISOString()
    } : {})
  });
  try {
    releasePersistedLease(metadata);
  } catch (error) {
    return lockReleaseFailureResult(metadata, error, reason || 'none');
  }
  return stateCommandBase(metadata, {
    ok: true,
    status,
    blockingReason: status === 'blocked' ? reason : 'none',
    statusReason: status === 'checkpoint' ? reason : 'none',
    nextAction,
    receiptKind: 'abort'
  });
}

function runFixLifecycleCommand(parsed, options) {
  if (parsed.subcommand === 'begin-fix') return runBeginFix(parsed, options);
  if (parsed.subcommand === 'refresh-lock') return runRefreshLock(parsed, options);
  if (parsed.subcommand === 'end-fix') return runEndFix(parsed, options);
  if (parsed.subcommand === 'abort-fix') return runAbortFix(parsed, options);
  fail('ERR_WORKFLOW_COMMAND', `unsupported fix lifecycle command: ${parsed.subcommand}`);
}

module.exports = {
  runBeginFix,
  runRefreshLock,
  runEndFix,
  runAbortFix,
  runFixLifecycleCommand
};
