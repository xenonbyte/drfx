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
  formatLedger,
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
  writeNormalizedFixReport
} = require('./helpers');

function guardModeFor(metadata) {
  return metadata.manifest.guardMode || 'git';
}

function referencePathsForSnapshot(metadata) {
  return (metadata.manifest.references || []).map((referencePath) => (
    path.isAbsolute(referencePath) ? referencePath : path.resolve(metadata.projectRoot, referencePath)
  ));
}

function runBeginFix(parsed, options) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
    assertFixEligible(metadata);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  const ownerId = `drfx-${crypto.randomUUID()}`;
  let lease;
  try {
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
    const guardMode = guardModeFor(metadata);
    const rollbackAnchor = guardMode === 'snapshot'
      ? captureSnapshot({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        targetStateDir: metadata.targetStateDir,
        round: Number(metadata.manifest.currentRound || 1),
        expectedNormalizedTarget: metadata.normalizedTarget
      })
      : checkGitRollbackAnchor({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        expectedNormalizedTarget: metadata.normalizedTarget
      });
    const targetOnlyGuard = guardMode === 'snapshot'
      ? checkSnapshotTargetOnly({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        allowedStateDir: metadata.targetStateDir,
        expectedNormalizedTarget: metadata.normalizedTarget,
        referencePaths: referencePathsForSnapshot(metadata)
      })
      : checkTargetOnlyWorktree({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        allowedStateDir: metadata.targetStateDir,
        expectedNormalizedTarget: metadata.normalizedTarget
      });
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
      runtimeFingerprintGuard: 'passed'
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
    fixReport = parseFixReport(payload);
  } catch (error) {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      summary: 'fix report was unparseable',
      nextAction: 'submit a valid normalized fix report'
    });
  }

  let ledger;
  try {
    ledger = readLedgerIfPresent(metadata.ledgerPath);
    validateFixedIssueIds(fixReport, ledger);
  } catch (error) {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      issueIds: (fixReport.fixed || []).map((fixed) => fixed.issue_id),
      filesChanged: Array.isArray(fixReport.filesChanged) ? fixReport.filesChanged.join(', ') : 'none',
      summary: 'fix report issue IDs do not match accepted or reopened ledger issues',
      nextAction: 'submit a fix report containing only accepted or reopened issue IDs'
    });
  }

  const declaredMismatch = validateDeclaredFilesChanged(fixReport, metadata.normalizedTarget);
  if (declaredMismatch) {
    return endFixBlocked(metadata, declaredMismatch, {
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
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: actual.changedFiles.join(', ') || 'none',
      summary: 'actual changed files differ from fix report'
    });
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
  if (guardModeFor(metadata) === 'snapshot') {
    const guardBaseline = readLatestFixGuardBaseline(metadata);
    if (!guardBaseline.ok) {
      return stateValidationResult(parsed.targetStateDir, guardBaseline.error);
    }
    try {
      const restored = restoreSnapshot({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        targetStateDir: metadata.targetStateDir,
        round: Number(metadata.manifest.currentRound || 1),
        expectedNormalizedTarget: metadata.normalizedTarget,
        rollbackAnchor: guardBaseline.report.rollbackAnchor
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
