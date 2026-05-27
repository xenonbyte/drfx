'use strict';

const {
  acceptedNonBlockingLowIssueIdsFromLedger,
  applyTriageDecisions,
  atomicWriteFile,
  blockPersistentReviewerMutation,
  blockPersistentStateValidation,
  buildContextPack,
  buildFixerGuard,
  compareGuardBaseline,
  computeFingerprint,
  contextManifestPathFor,
  contextPhase,
  enrichTriageDecisions,
  formatLedger,
  guardBaselineFor,
  isStateValidationError,
  loadMergedRules,
  nextReportPath,
  padRound,
  parseReviewerResult,
  parseTriageResult,
  path,
  persistentBase,
  producerForAssurance,
  readContextManifest,
  readLedgerIfPresent,
  readReviewerReport,
  readWorkflowPayload,
  requiredSchemaForPhase,
  resolvePersistentMetadata,
  statePathFromManifest,
  stateRelativePath,
  targetStatePathFromManifest,
  triageOutcome,
  updatePersistentManifest,
  writeContextManifest,
  writeReviewerReport,
  writeTriageReport
} = require('./helpers');

function runPersistentContext(parsed, options) {
  const metadata = resolvePersistentMetadata(parsed, options);
  try {
    const phase = contextPhase(parsed, metadata.manifest);
    const round = Number(metadata.manifest.currentRound || 1);
    const guard = guardBaselineFor(parsed, metadata);
    const ledgerPath = statePathFromManifest(
      metadata.projectRoot,
      metadata.targetStateDir,
      metadata.targetKey,
      metadata.manifest.ledgerPath,
      'ISSUES.md'
    );
    const ledger = readLedgerIfPresent(ledgerPath);
    const mergedRules = loadMergedRules({
      projectRoot: metadata.projectRoot,
      documentType: metadata.manifest.documentType,
      strictness: metadata.manifest.strictness,
      homeDir: options.homeDir || null
    });
    const fixerGuard = phase === 'fix'
      ? buildFixerGuard({
        projectRoot: metadata.projectRoot,
        metadata,
        ledger,
        round
      })
      : null;
    const contextPack = buildContextPack({
      target: metadata.normalizedTarget,
      references: guard.references,
      documentType: metadata.manifest.documentType,
      strictness: metadata.manifest.strictness,
      mode: metadata.manifest.mode,
      assurance: metadata.manifest.assurance,
      runtimePlatform: metadata.manifest.runtimePlatform,
      phase,
      round,
      mergedRules,
      acceptedNonBlockingLowIssueIds: acceptedNonBlockingLowIssueIdsFromLedger(ledger),
      requiredOutputSchema: requiredSchemaForPhase(phase),
      reviewerGuardBaseline: phase === 'fix' ? null : guard.reviewerGuardBaseline,
      fixerGuard,
      projectRoot: metadata.projectRoot
    });
    const contextManifestPath = writeContextManifest({
      targetStateDir: metadata.targetStateDir,
      phase,
      contextPack
    });
    return persistentBase(parsed, metadata, {
      ok: true,
      status: 'context',
      warnings: mergedRules.warnings || [],
      contextManifestPath,
      contextPackSkeleton: contextPack,
      runtimeCheck: {
        ...parsed.runtimeCheck,
        fingerprintGuard: { status: 'passed' }
      }
    });
  } catch (error) {
    if (isStateValidationError(error)) return blockPersistentStateValidation(parsed, metadata, error);
    throw error;
  }
}

function runPersistentRecordReview(parsed, options) {
  const metadata = resolvePersistentMetadata(parsed, options);
  try {
    const phase = contextPhase(parsed, metadata.manifest);
    const contextManifestPath = contextManifestPathFor(metadata.targetStateDir, phase);
    const contextPack = readContextManifest(contextManifestPath);
    const actualBaseline = guardBaselineFor(parsed, metadata);
    const mutation = compareGuardBaseline(contextPack, actualBaseline);
    if (mutation) return blockPersistentReviewerMutation(parsed, metadata, mutation);

    const payload = readWorkflowPayload({
      parsed,
      metadata,
      valueFlag: 'result',
      stdinFlag: 'resultStdin',
      label: 'review result',
      options
    });
    const reviewerResult = parseReviewerResult(payload);
    const round = Number(metadata.manifest.currentRound || 1);
    const baseName = phase === 'full-re-review'
      ? `full-review-round-${padRound(round)}`
      : `reviewer-round-${padRound(round)}`;
    const reportPath = nextReportPath(metadata.targetStateDir, baseName);
    const producer = producerForAssurance(metadata.manifest.assurance);
    writeReviewerReport({
      reportPath,
      phase,
      round,
      producer,
      reviewerResult
    });
    const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
    const targetFingerprint = computeFingerprint(parsed.invocation.target);
    const passStatus = metadata.manifest.mode === 'read-only' ? 'read-only-clean' : 'full-re-review';
    updatePersistentManifest(metadata, {
      status: reviewerResult.result === 'FAIL' ? 'triage' : passStatus,
      currentPhase: reviewerResult.result === 'FAIL'
        ? 'triage'
        : (passStatus === 'read-only-clean' ? 'final' : 'full-re-review'),
      blockingReason: 'none',
      statusReason: 'none',
      currentReportPath: relativeReportPath,
      lastReviewerReportPath: relativeReportPath,
      lastKnownContentSha256: targetFingerprint.sha256,
      lastReviewedContentSha256: targetFingerprint.sha256,
      runtimeFingerprintGuard: 'passed'
    });
    return persistentBase(parsed, metadata, {
      ok: true,
      status: 'recorded-review',
      contextManifestPath,
      reviewerReportPath: reportPath,
      normalized: reviewerResult
    });
  } catch (error) {
    if (isStateValidationError(error)) return blockPersistentStateValidation(parsed, metadata, error);
    throw error;
  }
}

function runPersistentRecordTriage(parsed, options) {
  const metadata = resolvePersistentMetadata(parsed, options);
  const phase = parsed.phase || 'initial-review';
  const round = Number(metadata.manifest.currentRound || 1);
  let reviewerReportPath;
  let ledgerPath;
  try {
    const contextManifestPath = contextManifestPathFor(metadata.targetStateDir, phase);
    const contextPack = readContextManifest(contextManifestPath);
    const actualBaseline = guardBaselineFor(parsed, metadata);
    const mutation = compareGuardBaseline(contextPack, actualBaseline);
    if (mutation) return blockPersistentReviewerMutation(parsed, metadata, mutation);
    reviewerReportPath = targetStatePathFromManifest(
      metadata.targetStateDir,
      metadata.manifest.lastReviewerReportPath,
      path.posix.join('reports', `reviewer-round-${padRound(round)}.md`),
      { allowedDirectories: ['reports'], label: 'Last reviewer report path' }
    );
    ledgerPath = statePathFromManifest(
      metadata.projectRoot,
      metadata.targetStateDir,
      metadata.targetKey,
      metadata.manifest.ledgerPath,
      'ISSUES.md'
    );
  } catch (error) {
    if (isStateValidationError(error)) return blockPersistentStateValidation(parsed, metadata, error);
    throw error;
  }
  const reviewerReport = readReviewerReport(reviewerReportPath);
  const payload = readWorkflowPayload({
    parsed,
    metadata,
    valueFlag: 'triage',
    stdinFlag: 'triageStdin',
    label: 'triage result',
    options
  });
  const triage = parseTriageResult(payload);
  const enrichedDecisions = enrichTriageDecisions(triage, reviewerReport);
  const ledger = applyTriageDecisions(readLedgerIfPresent(ledgerPath), enrichedDecisions);
  atomicWriteFile(ledgerPath, formatLedger(ledger));

  const baseName = `triage-round-${padRound(round)}`;
  const reportPath = nextReportPath(metadata.targetStateDir, baseName);
  writeTriageReport({
    reportPath,
    phase,
    round,
    triage: { decisions: enrichedDecisions, warnings: triage.warnings },
    ledger
  });
  const outcome = triageOutcome({
    decisions: enrichedDecisions,
    mode: metadata.manifest.mode,
    strictness: metadata.manifest.strictness
  });
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
  updatePersistentManifest(metadata, {
    status: outcome.status,
    currentPhase: outcome.currentPhase,
    blockingReason: 'none',
    statusReason: outcome.statusReason,
    currentReportPath: relativeReportPath,
    lastTriageReportPath: relativeReportPath
  });

  return persistentBase(parsed, metadata, {
    ok: true,
    status: 'recorded-triage',
    ledgerPath,
    triageReportPath: reportPath,
    normalized: { decisions: enrichedDecisions, warnings: triage.warnings }
  });
}

module.exports = {
  runPersistentContext,
  runPersistentRecordReview,
  runPersistentRecordTriage
};
