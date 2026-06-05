'use strict';

// PLAN-TASK-009 (Phase C): file-set (PR/CODE) resume + finalize.
//
// Resume requires the EXPLICIT `resume` token (enforced by the dispatcher) and REFUSES a
// stale identity: the stored manifest identity is compared against the live re-resolved
// identity via comparePrIdentity / compareCodeIdentity. PR remains strict on every
// field; CODE remains strict on roundLimit, guard, scopes, and file-set fingerprint,
// while tolerating default exclusion-list drift when the actual file set is unchanged.
// Unsafe drift ⇒ stale ⇒ refuse (never silent reuse). The resolvers are read-only (no
// git fetch/push/ref mutation).

const {
  ARCHIVE_ON_FINALIZE,
  archiveFailureNextAction,
  archiveTerminalStateBestEffort,
  atomicWriteFile,
  buildPrIdentity,
  buildCodeIdentity,
  comparePrIdentity,
  compareCodeIdentity,
  fail,
  formatLedger,
  nextReportPath,
  padRound,
  parseDiffReview,
  parseFinalResponseBlock,
  path,
  readLedgerIfPresent,
  readManifestReport,
  readStateCommandPayload,
  receiptFailureResult,
  resolveCodeTarget,
  resolveFileSetPersistentMetadata,
  resolveFileSetStateMetadata,
  resolveTargetContext,
  stateCommandBase,
  stateRelativePath,
  stateValidationResult,
  updatePersistentManifest,
  validateFinalResponse,
  withReadOnlyMode,
  workflowBase,
  writeFinalReceipt,
  writeWorkflowSummary,
  acceptedNonBlockingLowIssueIdsFromLedger,
  reportIssueIds,
  reportResult
} = require('./helpers');

function fileSetBase(parsed, metadata, overrides = {}) {
  return {
    ...workflowBase(parsed, { cwd: metadata.projectRoot }),
    targetStateDir: metadata.targetStateDir,
    manifestPath: metadata.manifestPath,
    targetKey: metadata.targetKey,
    routeKind: metadata.routeKind,
    round: Number(metadata.manifest.currentRound || 1),
    ...overrides
  };
}

function manifestIdentityInput(metadata) {
  return {
    guardMode: metadata.manifest.guardMode || 'git',
    roundLimit: metadata.manifest.roundLimit === 'none' || metadata.manifest.roundLimit === undefined
      ? null
      : metadata.manifest.roundLimit
  };
}

function requestedIdentityInput(parsed) {
  return {
    guardMode: parsed.invocation.guardMode || 'git',
    roundLimit: parsed.invocation.roundLimit
  };
}

async function liveIdentityFor(metadata, identityInput, options) {
  const guardMode = identityInput.guardMode;
  const roundLimit = identityInput.roundLimit;
  if (metadata.routeKind === 'pr') {
    const context = await resolveTargetContext({
      routeName: 'review-fix-pr',
      base: metadata.manifest.base,
      cwd: metadata.projectRoot,
      commandLog: options.commandLog
    });
    return buildPrIdentity({ context, guardMode, roundLimit });
  }
  const context = await resolveCodeTarget({
    cwd: metadata.projectRoot,
    scopes: metadata.manifest.normalizedScopes || []
  });
  if (context && context.status === 'blocked') {
    fail('ERR_FILE_SET_RESOLVE', `excluded-scope: ${context.scope}`);
  }
  return buildCodeIdentity({ context, guardMode, roundLimit });
}

// Build the stored identity from the durable manifest, in the same shape buildPrIdentity /
// buildCodeIdentity produce, so the strict compare is field-for-field.
function storedIdentityFor(metadata) {
  const roundLimit = metadata.manifest.roundLimit === undefined ? 'none' : String(metadata.manifest.roundLimit);
  const guardMode = String(metadata.manifest.guardMode || 'git');
  if (metadata.routeKind === 'pr') {
    return {
      targetContextKind: 'pr',
      base: String(metadata.manifest.base),
      baseRevision: String(metadata.manifest.baseRevision),
      mergeBase: String(metadata.manifest.mergeBase),
      head: String(metadata.manifest.head),
      guardMode,
      roundLimit,
      fileSetFingerprint: String(metadata.manifest.fileSetFingerprint)
    };
  }
  return {
    targetContextKind: 'code',
    normalizedScopes: Array.isArray(metadata.manifest.normalizedScopes) ? metadata.manifest.normalizedScopes : [],
    exclusions: Array.isArray(metadata.manifest.exclusions) ? metadata.manifest.exclusions : [],
    guardMode,
    roundLimit,
    fileSetFingerprint: String(metadata.manifest.fileSetFingerprint)
  };
}

async function runFileSetResume(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetPersistentMetadata(parsed, options);
  } catch (error) {
    return stateValidationResult(
      path.join(error && error.targetStateDir ? error.targetStateDir : process.cwd(), '.drfx'),
      error
    );
  }

  // Completed-state anomaly: archive a live pass/read-only-clean and fresh-start, before
  // any stale-identity comparison. (Persistent file-set manifests only reach `pass`;
  // read-only is no-state. The shared set keeps the rule uniform.)
  if (ARCHIVE_ON_FINALIZE.has(metadata.manifest.status)) {
    const { archivedStatePath, archiveWarning } = archiveTerminalStateBestEffort({
      targetStateDir: metadata.targetStateDir,
      options
    });
    if (archiveWarning) {
      return fileSetBase(parsed, metadata, {
        ok: false,
        status: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'none',
        archiveWarning,
        nextAction: 'delete or reset the leftover passed file-set state directory, then retry'
      });
    }
    return { freshStartRequested: true, archivedStatePath };
  }

  let liveIdentity;
  try {
    liveIdentity = await liveIdentityFor(metadata, requestedIdentityInput(parsed), options);
  } catch (error) {
    return {
      ...fileSetBase(parsed, metadata, {
        ok: false,
        status: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'none',
        errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
        message: error && error.message ? error.message : String(error),
        nextAction: 'resolve a valid base/scope file set before resuming'
      })
    };
  }

  const stored = storedIdentityFor(metadata);
  const comparison = metadata.routeKind === 'pr'
    ? comparePrIdentity({ stored, requested: liveIdentity })
    : compareCodeIdentity({ stored, requested: liveIdentity });

  if (!comparison.match) {
    // Stale identity: the live file set / base / scope / round limit drifted from the
    // recorded state. Refuse resume (never silent reuse, never PASS) and report the drift.
    return withReadOnlyMode({
      ...fileSetBase(parsed, metadata, {
        ok: false,
        status: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'none',
        errorCode: 'ERR_FILE_SET_STALE_IDENTITY',
        message: `stale file-set identity; mismatched fields: ${comparison.mismatches.join(', ')}`,
        staleIdentityFields: comparison.mismatches,
        nextAction: 'pass reset to archive the stale state and start a fresh review for the changed file set'
      })
    });
  }

  // Identity matches: resume to the manifest's current phase. The deterministic phase is the
  // persisted status/currentPhase; no single-file fingerprint replay is needed because the
  // file-set fingerprint already matched.
  const nextAction = manifestResumeNextAction(metadata.manifest);
  const ok = !['blocked', 'unsupported', 'externally-changed', 'possible-target-replacement', 'checkpoint'].includes(
    metadata.manifest.status
  );
  return fileSetBase(parsed, metadata, {
    ok,
    status: metadata.manifest.status,
    currentPhase: metadata.manifest.currentPhase,
    mode: metadata.manifest.mode,
    assurance: metadata.manifest.assurance,
    blockingReason: metadata.manifest.blockingReason || 'none',
    statusReason: metadata.manifest.statusReason || 'none',
    fileSetFingerprint: metadata.manifest.fileSetFingerprint,
    nextAction
  });
}

function manifestResumeNextAction(manifest) {
  if (manifest.status === 'review') return 'run workflow context for review';
  if (manifest.status === 'fix') return 'run begin-fix to continue the fix loop';
  if (manifest.status === 'diff-review') return 'run record-diff-review';
  if (manifest.status === 'full-re-review') return 'run full re-review';
  return 'continue from manifest current phase';
}

// ---------------------------------------------------------------------------
// File-set record-diff-review (mirrors diff-review.js for the file set).
// ---------------------------------------------------------------------------

function reopenDiffFailedIssues(metadata, diffReview) {
  const failedIds = new Set((diffReview.findings || []).map((finding) => finding.issue_id));
  if (failedIds.size === 0) return;
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const nextLedger = {
    issues: (ledger.issues || []).map((issue) => {
      if (!failedIds.has(issue.id) || issue.status !== 'fixed') return issue;
      const finding = (diffReview.findings || []).find((item) => item.issue_id === issue.id);
      return {
        ...issue,
        status: 'reopened',
        resolution: `Reopened by diff review: ${finding ? finding.problem : 'diff review failed'}`
      };
    })
  };
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
}

function roundLimitReached(metadata) {
  const rawLimit = metadata.manifest.roundLimit || 'none';
  if (rawLimit === 'none') return false;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return false;
  return Number(metadata.manifest.fixAttemptCount || 0) >= limit;
}

function deferRoundLimitedFindings(metadata) {
  const roundLimit = Number(metadata.manifest.roundLimit);
  const reason = `Round limit reached (rounds=${roundLimit}); deferred for manual follow-up`;
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const nextLedger = {
    issues: (ledger.issues || []).map((issue) => {
      const blocking = ['accepted', 'reopened'].includes(issue.status) &&
        ['high', 'medium'].includes(issue.severity);
      if (!blocking) return issue;
      return { ...issue, status: 'deferred', resolution: `Deferred: ${reason}; owner: none` };
    })
  };
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
}

function writeFileSetDiffReviewReport({ metadata, diffReview }) {
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `diff-review-round-${padRound(round)}`);
  const report = { round, normalized: diffReview };
  atomicWriteFile(reportPath, [
    '# Diff Review Report',
    '',
    `Round: ${round}`,
    `Result: ${diffReview.result}`,
    '',
    '```json',
    `${JSON.stringify(report, null, 2)}`,
    '```',
    ''
  ].join('\n'));
  return reportPath;
}

function runFileSetRecordDiffReview(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
    if (metadata.manifest.status !== 'diff-review' || metadata.manifest.currentPhase !== 'diff-review') {
      const error = new Error('state-validation-failed: record-diff-review requires Status: diff-review and Current phase: diff-review');
      error.code = 'ERR_STATE_VALIDATION_FAILED';
      throw error;
    }
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  let diffReview;
  try {
    const payload = readStateCommandPayload({
      metadata,
      parsed,
      valueFlag: 'result',
      stdinFlag: 'resultStdin',
      label: 'diff review',
      aliasValueFlag: 'diffReview',
      aliasStdinFlag: 'diffReviewStdin',
      options
    });
    diffReview = parseDiffReview(payload);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  const reportPath = writeFileSetDiffReviewReport({ metadata, diffReview });
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);

  if (diffReview.result === 'DIFF-FAIL') {
    try {
      reopenDiffFailedIssues(metadata, diffReview);
    } catch (error) {
      return receiptFailureResult(metadata, error);
    }
    if (roundLimitReached(metadata)) {
      deferRoundLimitedFindings(metadata);
      updatePersistentManifest(metadata, {
        status: 'stopped-with-deferrals',
        currentPhase: 'final',
        blockingReason: 'none',
        statusReason: 'round-limit',
        currentReportPath: relativeReportPath,
        lastDiffReviewReportPath: relativeReportPath
      });
      return stateCommandBase(metadata, {
        ok: true,
        status: 'recorded-diff-review',
        currentPhase: 'final',
        diffReviewReportPath: reportPath,
        normalized: diffReview,
        stopReason: 'round-limit',
        roundLimit: Number(metadata.manifest.roundLimit),
        nextAction: 'round limit reached; review deferred findings manually'
      });
    }
    updatePersistentManifest(metadata, {
      status: 'fix',
      currentPhase: 'fix',
      currentRound: Number(metadata.manifest.currentRound || 1) + 1,
      blockingReason: 'none',
      statusReason: 'none',
      currentReportPath: relativeReportPath,
      lastDiffReviewReportPath: relativeReportPath
    });
    return stateCommandBase(metadata, {
      ok: true,
      status: 'recorded-diff-review',
      currentPhase: 'fix',
      diffReviewReportPath: reportPath,
      normalized: diffReview,
      nextAction: 'repair fix and rerun begin-fix'
    });
  }

  updatePersistentManifest(metadata, {
    status: 'full-re-review',
    currentPhase: 'full-re-review',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: relativeReportPath,
    lastDiffReviewReportPath: relativeReportPath
  });
  return stateCommandBase(metadata, {
    ok: true,
    status: 'recorded-diff-review',
    currentPhase: 'full-re-review',
    diffReviewReportPath: reportPath,
    normalized: diffReview,
    nextAction: 'run full re-review'
  });
}

// ---------------------------------------------------------------------------
// File-set finalize. PASS requires review-and-fix + practical/strict-verified, a completed
// diff review AND full re-review after the fix, and no unresolved/deferred blocking issues —
// never PASS from read-only / advisory / diff-review-only / unverified.
// ---------------------------------------------------------------------------

function unresolvedBlockingIssues(ledger) {
  return (ledger.issues || [])
    .filter((issue) => ['accepted', 'reopened'].includes(issue.status) && ['high', 'medium'].includes(issue.severity))
    .map((issue) => issue.id)
    .sort();
}

function deferredBlockingIssues(ledger) {
  return (ledger.issues || [])
    .filter((issue) => issue.status === 'deferred' && ['high', 'medium'].includes(issue.severity))
    .map((issue) => issue.id)
    .sort();
}

function latestFullReviewComplete({ latestReviewer, round }) {
  if (!latestReviewer) return false;
  const report = latestReviewer.report || {};
  if (Number(report.round || 1) !== Number(round || 1)) return false;
  if (report.phase !== 'full-re-review') return false;
  return (report.normalized || {}).result === 'PASS';
}

function assertLiveFileSetFreshForPass(metadata, liveIdentity) {
  const stored = storedIdentityFor(metadata);
  const comparison = metadata.routeKind === 'pr'
    ? comparePrIdentity({ stored, requested: liveIdentity })
    : compareCodeIdentity({ stored, requested: liveIdentity });
  if (comparison.match) return;
  const error = new Error(`stale file-set identity before final pass; mismatched fields: ${comparison.mismatches.join(', ')}`);
  error.code = 'ERR_FINAL_FILE_SET_STALE_IDENTITY';
  throw error;
}

function buildFileSetFinalValidationState(metadata) {
  const round = Number(metadata.manifest.currentRound || 1);
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const fixReport = readManifestReport(metadata, metadata.manifest.lastFixReportPath, 'Last fix report path');
  const diffReport = readManifestReport(metadata, metadata.manifest.lastDiffReviewReportPath, 'Last diff review report path');
  const latestReviewer = readManifestReport(metadata, metadata.manifest.lastReviewerReportPath, 'Last reviewer report path');
  const hasFixRound = Boolean(fixReport);
  const fixRoundCurrent = !hasFixRound || Number(fixReport.report.round || 1) === round;
  const unresolvedIds = unresolvedBlockingIssues(ledger);
  const deferredIds = deferredBlockingIssues(ledger);
  const changedFiles = hasFixRound
    ? ((fixReport.report.normalized && Array.isArray(fixReport.report.normalized.filesChanged))
      ? fixReport.report.normalized.filesChanged.join(', ')
      : 'none')
    : 'none';
  return {
    persistent: true,
    fileSet: true,
    target: 'none',
    routeKind: metadata.routeKind,
    mode: metadata.manifest.mode,
    assurance: metadata.manifest.assurance,
    runtimePlatform: metadata.manifest.runtimePlatform,
    strictness: metadata.manifest.strictness,
    filesChanged: changedFiles,
    fixedIssueIds: hasFixRound ? reportIssueIds(fixReport.report) : [],
    unresolvedBlockingIssues: unresolvedIds,
    readOnlyBlockingIssueIds: unresolvedIds,
    readOnlyFindingsIssueIds: unresolvedIds,
    deferredBlockingIssueIds: deferredIds,
    acceptedNonBlockingLowIssueIds: acceptedNonBlockingLowIssueIdsFromLedger(ledger),
    requiredDiffReviewComplete: !hasFixRound ? true : Boolean(
      fixRoundCurrent &&
      diffReport &&
      Number(diffReport.report.round || 1) === round &&
      reportResult(diffReport.report) === 'DIFF-OK'
    ),
    requiredFullReReviewComplete: Boolean(
      fixRoundCurrent && latestFullReviewComplete({ latestReviewer, round })
    ),
    // File-set routes (review-fix-pr/code) never accept a strict|normal token, so the
    // manifest strictness is always 'normal' and validatePass's strict-only check is never
    // consulted; the value is fixed true rather than computed. If file-set routes ever gain
    // strict mode, compute this against the latest full-re-review context like the doc path.
    strictAcceptedLowIncludedInLatestFullReview: true
  };
}

function finalizationRequiresReceipt(status) {
  return [
    'blocked', 'checkpoint', 'stopped-with-deferrals', 'stopped-no-progress',
    'read-only-findings', 'read-only-clean', 'unsupported', 'externally-changed',
    'possible-target-replacement'
  ].includes(status);
}

async function runFileSetFinalize(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  let finalResponse;
  let validation;
  try {
    const payload = readStateCommandPayload({
      metadata,
      parsed,
      valueFlag: 'finalResponse',
      stdinFlag: 'finalResponseStdin',
      label: 'final response',
      options
    });
    finalResponse = parseFinalResponseBlock(payload, { allowFileSet: true });
    if (finalResponse.finalStatus === 'pass') {
      assertLiveFileSetFreshForPass(metadata, await liveIdentityFor(metadata, manifestIdentityInput(metadata), options));
    }
    validation = validateFinalResponse({
      finalResponse,
      state: buildFileSetFinalValidationState(metadata)
    });
  } catch (error) {
    try {
      writeFinalReceipt(metadata, {
        finalStatus: 'blocked',
        fixedIssueIds: 'none',
        filesChanged: 'none',
        verificationPerformed: 'final response validation',
        deferralsOrBlockers: 'final validation failed',
        blockingReason: 'final-validation-failed',
        statusReason: 'none'
      }, { kind: 'final-validation-failed', nextAction: 'repair final response or workflow state before retrying finalize' });
    } catch (receiptError) {
      return receiptFailureResult(metadata, receiptError);
    }
    updatePersistentManifest(metadata, {
      status: 'blocked',
      currentPhase: 'final',
      blockingReason: 'final-validation-failed',
      statusReason: 'none'
    });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      currentPhase: 'final',
      blockingReason: 'final-validation-failed',
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FINAL_VALIDATION_FAILED',
      message: error && error.message ? error.message : String(error),
      nextAction: 'repair final response or workflow state before retrying finalize'
    });
  }

  let nextAction = finalResponse.finalStatus === 'pass' ? 'none' : (finalResponse.deferralsOrBlockers || 'none');
  if (finalizationRequiresReceipt(finalResponse.finalStatus)) {
    try {
      writeFinalReceipt(metadata, finalResponse, { nextAction });
    } catch (error) {
      return receiptFailureResult(metadata, error);
    }
  }

  updatePersistentManifest(metadata, {
    status: finalResponse.finalStatus,
    currentPhase: 'final',
    blockingReason: finalResponse.blockingReason,
    statusReason: finalResponse.statusReason
  });
  try {
    writeWorkflowSummary(metadata, nextAction);
  } catch {
    // SUMMARY.md is command-owned and optional; final status has already been validated and persisted.
  }

  let archiveResult = { archivedStatePath: null, archiveWarning: null };
  if (ARCHIVE_ON_FINALIZE.has(finalResponse.finalStatus)) {
    archiveResult = archiveTerminalStateBestEffort({ targetStateDir: metadata.targetStateDir, options });
    if (archiveResult.archiveWarning) {
      nextAction = archiveFailureNextAction({ fileSet: true });
      try {
        writeWorkflowSummary(metadata, nextAction);
      } catch {
        // SUMMARY.md is command-owned and optional; final status has already been validated and persisted.
      }
    }
  }

  return stateCommandBase(metadata, {
    ok: true,
    status: validation.status,
    currentPhase: 'final',
    finalResponse,
    fixedIssueIds: validation.fixedIssueIds,
    nextAction,
    ...(archiveResult.archivedStatePath ? { archivedStatePath: archiveResult.archivedStatePath } : {}),
    ...(archiveResult.archiveWarning ? { archiveWarning: archiveResult.archiveWarning } : {})
  });
}

module.exports = {
  runFileSetResume,
  runFileSetRecordDiffReview,
  runFileSetFinalize,
  storedIdentityFor,
  liveIdentityFor
};
