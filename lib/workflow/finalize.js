'use strict';

const {
  ARCHIVE_ON_FINALIZE,
  archiveTerminalStateBestEffort,
  buildFinalValidationState,
  computeFingerprint,
  currentProofForResume,
  finalizationRequiresReceipt,
  parseFinalResponseBlock,
  path,
  readOptionalContinuity,
  readResumeDeterministicInputs,
  readStateCommandPayload,
  receiptFailureResult,
  resolvePersistentMetadata,
  resolveStateCommandMetadata,
  resumeRequiresReceipt,
  resumeStateValidationFailure,
  stateCommandBase,
  stateValidationResult,
  updatePersistentManifest,
  validateFinalResponse,
  validateResumeState,
  writeFinalReceipt,
  writeResumeReceipt,
  writeWorkflowSummary
} = require('./helpers');

function runPersistentFinalize(parsed, options) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
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
    finalResponse = parseFinalResponseBlock(payload);
    validation = validateFinalResponse({
      finalResponse,
      state: buildFinalValidationState(metadata)
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
      }, {
        kind: 'final-validation-failed',
        nextAction: 'repair final response or workflow state before retrying finalize'
      });
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

  const nextAction = finalResponse.finalStatus === 'pass' ? 'none' : (finalResponse.deferralsOrBlockers || 'none');
  if (finalizationRequiresReceipt(finalResponse.finalStatus)) {
    try {
      writeFinalReceipt(metadata, finalResponse, { nextAction });
    } catch (error) {
      return receiptFailureResult(metadata, error);
    }
  }

  const updates = {
    status: finalResponse.finalStatus,
    currentPhase: 'final',
    blockingReason: finalResponse.blockingReason,
    statusReason: finalResponse.statusReason
  };
  if (finalResponse.finalStatus === 'pass') {
    const targetFingerprint = computeFingerprint(metadata.targetPath);
    updates.lastKnownContentSha256 = targetFingerprint.sha256;
    updates.lastReviewedContentSha256 = targetFingerprint.sha256;
    updates.lastPassedContentSha256 = targetFingerprint.sha256;
    updates.fileSize = targetFingerprint.size;
    updates.lastModifiedAt = new Date().toISOString();
  }
  updatePersistentManifest(metadata, updates);
  try {
    writeWorkflowSummary(metadata, nextAction);
  } catch {
    // SUMMARY.md is command-owned and optional; final status has already been validated and persisted.
  }

  // Archive the completed state dir so a re-run starts fresh without `reset`. Best-effort:
  // a validated PASS is never downgraded to an error if the rename fails (dir then stays
  // in place and a bare start falls back to ERR_STATE_EXISTS -> reset).
  let archiveResult = { archivedStatePath: null, archiveWarning: null };
  if (ARCHIVE_ON_FINALIZE.has(finalResponse.finalStatus)) {
    archiveResult = archiveTerminalStateBestEffort({ targetStateDir: metadata.targetStateDir, options });
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

function runPersistentResume(parsed, options) {
  let metadata;
  try {
    metadata = resolvePersistentMetadata(parsed, options);
  } catch (error) {
    return resumeStateValidationFailure(parsed, options, error);
  }

  const continuityWarning = readOptionalContinuity(metadata.targetStateDir);
  try {
    readResumeDeterministicInputs(metadata);
  } catch (error) {
    return stateValidationResult(metadata.targetStateDir, error);
  }
  let resumeState;
  try {
    resumeState = validateResumeState({
      manifest: metadata.manifest,
      currentFingerprint: computeFingerprint(parsed.invocation.target),
      requestedStrictness: parsed.strictnessExplicit ? parsed.invocation.strictness : null,
      requestedMode: parsed.invocation.modeSource === 'explicit' ? parsed.invocation.mode : null,
      currentProof: currentProofForResume(parsed)
    });
  } catch (error) {
    return stateValidationResult(metadata.targetStateDir, error);
  }

  const nextAction = resumeState.status === 'review'
    ? 'run workflow context for review'
    : (resumeState.status === 'externally-changed'
      ? 'confirm external edits before restarting review'
      : (resumeState.status === 'possible-target-replacement'
        ? 'confirm same-path target replacement before continuing'
        : (resumeState.status === 'unsupported'
          ? 'rerun with practical assurance or provide current strict proof'
          : 'continue from manifest current phase')));

  if (
    resumeState.status !== metadata.manifest.status ||
    resumeState.currentPhase !== metadata.manifest.currentPhase ||
    resumeState.assurance !== metadata.manifest.assurance ||
    resumeState.mode !== metadata.manifest.mode ||
    resumeState.statusReason !== metadata.manifest.statusReason ||
    resumeState.blockingReason !== metadata.manifest.blockingReason ||
    resumeState.lastPassedContentSha256 !== metadata.manifest.lastPassedContentSha256
  ) {
    if (resumeRequiresReceipt(resumeState.status)) {
      try {
        writeResumeReceipt(metadata, resumeState, nextAction);
      } catch (error) {
        return receiptFailureResult(metadata, error);
      }
    }
    updatePersistentManifest(metadata, {
      status: resumeState.status,
      currentPhase: resumeState.currentPhase,
      mode: resumeState.mode,
      assurance: resumeState.assurance,
      descriptorPlatform: resumeState.descriptorPlatform,
      assuranceProof: resumeState.assuranceProof,
      runtimeSubagentProbe: resumeState.runtimeSubagentProbe,
      runtimeSubagentProbeEvidence: resumeState.runtimeSubagentProbeEvidence,
      runtimeStdinHandoff: resumeState.runtimeStdinHandoff,
      runtimeStdinHandoffEvidence: resumeState.runtimeStdinHandoffEvidence,
      runtimeDowngradeReason: resumeState.runtimeDowngradeReason,
      blockingReason: resumeState.blockingReason || 'none',
      statusReason: resumeState.statusReason || 'none',
      lastKnownContentSha256: resumeState.lastKnownContentSha256 || metadata.manifest.lastKnownContentSha256,
      lastPassedContentSha256: resumeState.lastPassedContentSha256 || metadata.manifest.lastPassedContentSha256,
      fileSize: resumeState.fileSize || metadata.manifest.fileSize
    });
  }
  try {
    writeWorkflowSummary(metadata, nextAction);
  } catch {
    // Optional derived summary must not influence deterministic resume phase selection.
  }

  const ok = !['blocked', 'unsupported', 'externally-changed', 'possible-target-replacement', 'checkpoint'].includes(
    resumeState.status
  );
  return stateCommandBase(metadata, {
    ok,
    status: resumeState.status,
    currentPhase: resumeState.currentPhase,
    blockingReason: resumeState.blockingReason || 'none',
    statusReason: resumeState.statusReason || 'none',
    strictProofError: resumeState.strictProofError || null,
    stalePass: Boolean(resumeState.stalePass),
    requiresFullReview: Boolean(resumeState.requiresFullReview),
    requiresUserDecision: Boolean(resumeState.requiresUserDecision),
    conflict: resumeState.conflict || null,
    continuityWarning,
    nextAction
  });
}

module.exports = {
  runPersistentFinalize,
  runPersistentResume
};
