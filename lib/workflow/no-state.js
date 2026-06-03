'use strict';

const {
  NO_STATE_TOKEN_MAX_AGE_MS,
  assertReadableWritableTarget,
  blockingFindingsFromReviewerResult,
  blockingFindingsFromTriage,
  buildContextPack,
  checkGitRollbackAnchor,
  checkSnapshotRollbackAnchor,
  checkSnapshotTargetOnly,
  checkTargetOnlyWorktree,
  createPreflightToken,
  createReviewGuard,
  deriveTargetKey,
  fail,
  loadMergedRules,
  metadataExpectedGuard,
  nextStateToken,
  noStateBase,
  noStateOutputOrTooLarge,
  noStateValidationFailure,
  normalizeReferences,
  normalizedReferencePath,
  parseFinalResponseBlock,
  parseReviewerResult,
  parseTriageResult,
  path,
  preflightBase,
  readWorkflowPayload,
  resolveNoStateMetadata,
  resolveProjectRoot,
  tokenHasBlockingFindings,
  validateFinalResponse,
  validateNoStateTokenFingerprints,
  validateReviewGuard,
  validateStateToken,
  validateTriageReviewerIds,
  withReadOnlyMode,
  workflowBase
} = require('./helpers');
const { isFileSetRoute } = require('./target-resolution');
const {
  runFileSetNoStateWorkflowCommand,
  runFileSetWriteEligibilityPreflight
} = require('./file-set-no-state');

function runNoStatePreflight(parsed, options) {
  const metadata = resolveNoStateMetadata(parsed, options);
  const runtimeCheck = {
    ...parsed.runtimeCheck,
    fingerprintGuard: { status: 'not-run' }
  };
  return noStateOutputOrTooLarge(parsed, metadata, () => {
    const stateToken = createPreflightToken({
      targetKey: metadata.targetKey,
      normalizedTarget: metadata.normalizedTarget,
      references: metadata.references,
      strictness: parsed.invocation.strictness,
      requestedMode: parsed.invocation.requestedMode,
      mode: 'read-only',
      assurance: parsed.assurance,
      runtimePlatform: parsed.runtimePlatform,
      runtimeDowngradeReason: parsed.runtimeCheck.downgradeReason,
      runtimeCheck,
      terminalStatus: parsed.terminalStatus,
      blockingReason: parsed.blockingReason,
      statusReason: parsed.statusReason
    });
    return {
      ...noStateBase(parsed, metadata, {
        status: parsed.terminalStatus,
        mode: 'read-only',
        runtimeCheck,
        blockingReason: parsed.blockingReason,
        statusReason: parsed.statusReason
      }),
      stateToken
    };
  });
}

async function runWriteEligibilityPreflight(parsed, options) {
  if (isFileSetRoute(parsed)) {
    return runFileSetWriteEligibilityPreflight(parsed, options);
  }
  const { base, error: baseError } = preflightBase(parsed, options);
  if (parsed.invocation.mode !== 'review-and-fix') {
    return {
      ...base,
      ok: true,
      status: 'write-not-required',
      currentPhase: 'review',
      blockingReason: 'none',
      statusReason: 'none',
      nextAction: 'continue read-only review'
    };
  }
  if (parsed.assurance === 'advisory') {
    return withReadOnlyMode({
      ...base,
      ok: false,
      status: 'unsupported',
      assurance: 'advisory',
      assuranceNormalizedFrom: parsed.assurance,
      descriptorPlatform: 'none',
      assuranceProof: 'none',
      statusReason: 'advisory-review-and-fix-unsupported',
      blockingReason: 'none',
      strictProofError: null,
      nextAction: null
    });
  }
  if (baseError) {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      currentPhase: 'review',
      targetStateDir: null,
      blockingReason: 'rollback-unavailable',
      statusReason: 'none',
      message: baseError && baseError.message ? baseError.message : String(baseError),
      nextAction: 'commit or restore the target, or rerun with read-only'
    };
  }

  let projectRoot;
  let targetMetadata;
  try {
    projectRoot = resolveProjectRoot({
      explicitRoot: parsed.invocation.root,
      targetPath: parsed.invocation.target,
      cwd: options.cwd || process.cwd(),
      persistentStateRequired: true
    });
    targetMetadata = deriveTargetKey(projectRoot, parsed.invocation.target);
    const targetPath = path.resolve(projectRoot, targetMetadata.normalizedTarget);
    assertReadableWritableTarget(targetPath);
    const guardMode = parsed.invocation.guardMode || 'git';
    const rollbackAnchor = guardMode === 'snapshot'
      ? checkSnapshotRollbackAnchor({ projectRoot, targetPath })
      : checkGitRollbackAnchor({ projectRoot, targetPath });
    const referencePaths = guardMode === 'snapshot'
      ? normalizeReferences({
        projectRoot,
        references: parsed.invocation.refs,
        targetPath: parsed.invocation.target
      }).map((reference) => normalizedReferencePath(reference, projectRoot))
      : [];
    const targetOnlyGuard = guardMode === 'snapshot'
      ? checkSnapshotTargetOnly({
        projectRoot,
        targetPath,
        allowedStateDir: null,
        expectedNormalizedTarget: rollbackAnchor.normalizedTarget,
        referencePaths
      })
      : checkTargetOnlyWorktree({
        projectRoot,
        targetPath,
        allowedStateDir: null,
        expectedNormalizedTarget: rollbackAnchor.normalizedTarget
      });
    if (targetOnlyGuard.status !== 'passed') {
      return {
        ...base,
        ok: false,
        status: 'blocked',
        currentPhase: 'review',
        projectRoot,
        targetKey: targetMetadata.targetKey,
        normalizedTarget: targetMetadata.normalizedTarget,
        targetStateDir: null,
        blockingReason: targetOnlyGuard.blockingReason,
        statusReason: 'none',
        message: targetOnlyGuard.message || 'write eligibility preflight blocked automatic target writes',
        nextAction: 'commit or restore the target, or rerun with read-only'
      };
    }
    return {
      ...base,
      ok: true,
      status: 'write-eligible',
      currentPhase: 'review',
      projectRoot,
      targetKey: targetMetadata.targetKey,
      normalizedTarget: targetMetadata.normalizedTarget,
      targetStateDir: null,
      rollbackAnchor,
      targetOnlyGuard,
      blockingReason: 'none',
      statusReason: 'none',
      nextAction: 'continue review-and-fix workflow'
    };
  } catch (error) {
    const blockingReason = error && error.blockingReason
      ? error.blockingReason
      : (error && error.reason ? error.reason : 'rollback-unavailable');
    return {
      ...base,
      ok: false,
      status: 'blocked',
      currentPhase: 'review',
      targetStateDir: null,
      blockingReason,
      statusReason: 'none',
      message: error && error.message ? error.message : String(error),
      nextAction: 'commit or restore the target, or rerun with read-only'
    };
  }
}

function runNoStateContext(parsed, options) {
  const metadata = resolveNoStateMetadata(parsed, options);
  const runtimeCheck = {
    ...parsed.runtimeCheck,
    fingerprintGuard: { status: 'passed' }
  };
  return noStateOutputOrTooLarge(parsed, metadata, () => {
    const phase = parsed.phase || 'initial-review';
    const mergedRules = loadMergedRules({
      projectRoot: metadata.projectRoot,
      documentType: parsed.invocation.documentType,
      strictness: parsed.invocation.strictness,
      homeDir: options.homeDir || null
    });
    const contextPackSkeleton = buildContextPack({
      target: metadata.normalizedTarget,
      references: metadata.references.map((reference) => ({ path: reference, readOnly: true })),
      documentType: parsed.invocation.documentType,
      strictness: parsed.invocation.strictness,
      mode: parsed.invocation.mode,
      assurance: parsed.assurance,
      runtimePlatform: parsed.runtimePlatform,
      phase,
      round: 1,
      mergedRules,
      acceptedNonBlockingLowIssueIds: [],
      requiredOutputSchema: 'reviewer-pass-fail',
      reviewerGuardBaseline: {
        target: metadata.targetFingerprint,
        references: metadata.referenceFingerprints
      },
      projectRoot: metadata.projectRoot
    });
    const reviewGuard = createReviewGuard({
      phase,
      round: 1,
      normalizedTarget: metadata.normalizedTarget,
      references: metadata.references,
      targetFingerprint: metadata.targetFingerprint,
      referenceFingerprints: metadata.referenceFingerprints,
      strictness: parsed.invocation.strictness,
      mode: parsed.invocation.mode,
      assurance: parsed.assurance,
      runtimePlatform: parsed.runtimePlatform
    });
    return {
      ...noStateBase(parsed, metadata, {
        status: 'context',
        runtimeCheck
      }),
      warnings: mergedRules.warnings || [],
      contextPackSkeleton: {
        ...contextPackSkeleton,
        targetFingerprint: metadata.targetFingerprint,
        referenceFingerprints: metadata.referenceFingerprints
      },
      reviewGuard
    };
  });
}

function runNoStateRecordReview(parsed, options) {
  const metadata = resolveNoStateMetadata(parsed, options);
  let guard;
  try {
    guard = validateReviewGuard(parsed.reviewGuard, metadataExpectedGuard(parsed, metadata));
  } catch (error) {
    if (error.code === 'ERR_REVIEWER_MUTATED_FILE') {
      return noStateValidationFailure(parsed, metadata, {
        errorCode: 'reviewer-mutated-file',
        message: error.message,
        blockingReason: 'reviewer-mutated-file'
      });
    }
    throw error;
  }
  const payload = readWorkflowPayload({
    parsed,
    metadata,
    valueFlag: 'result',
    stdinFlag: 'resultStdin',
    label: 'review result',
    options
  });
  const reviewerResult = parseReviewerResult(payload);
  const blockingFindings = blockingFindingsFromReviewerResult(reviewerResult);
  return noStateOutputOrTooLarge(parsed, metadata, () => {
    const stateToken = nextStateToken({
      previousToken: null,
      tokenKind: 'review-result',
      targetKey: metadata.targetKey,
      normalizedTarget: metadata.normalizedTarget,
      references: metadata.references,
      phase: parsed.phase || 'initial-review',
      round: 1,
      strictness: parsed.invocation.strictness,
      mode: parsed.invocation.mode,
      assurance: parsed.assurance,
      runtimePlatform: parsed.runtimePlatform,
      runtimeDowngradeReason: parsed.runtimeCheck.downgradeReason,
      guardId: guard.guardId,
      eligibleTerminalStatuses: reviewerResult.result === 'PASS' ? ['read-only-clean'] : [],
      normalized: {
        result: reviewerResult.result,
        summary: reviewerResult.summary,
        findings: reviewerResult.findings,
        warnings: reviewerResult.warnings,
        blockingFindings
      },
      targetFingerprint: metadata.targetFingerprint,
      referenceFingerprints: metadata.referenceFingerprints
    });
    return {
      ...noStateBase(parsed, metadata, { status: 'recorded-review' }),
      normalized: reviewerResult,
      stateToken
    };
  });
}

function runNoStateRecordTriage(parsed, options) {
  const metadata = resolveNoStateMetadata(parsed, options);
  const previous = validateStateToken(parsed.stateToken, {
    allowedKinds: ['review-result'],
    targetKey: metadata.targetKey,
    normalizedTarget: metadata.normalizedTarget,
    references: metadata.references,
    phase: parsed.phase || 'initial-review',
    round: 1,
    strictness: parsed.invocation.strictness,
    mode: parsed.invocation.mode,
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform,
    maxAgeMs: options.maxAgeMs || NO_STATE_TOKEN_MAX_AGE_MS,
    now: options.now
  });
  const stale = validateNoStateTokenFingerprints(parsed, metadata, previous);
  if (stale) return stale;
  const payload = readWorkflowPayload({
    parsed,
    metadata,
    valueFlag: 'triage',
    stdinFlag: 'triageStdin',
    label: 'triage result',
    options
  });
  const triage = parseTriageResult(payload);
  validateTriageReviewerIds(triage, { normalized: previous.normalized });
  const blockingFindings = blockingFindingsFromTriage(triage.decisions);
  return noStateOutputOrTooLarge(parsed, metadata, () => {
    const stateToken = nextStateToken({
      previousToken: parsed.stateToken,
      tokenKind: 'triage-result',
      targetKey: metadata.targetKey,
      normalizedTarget: metadata.normalizedTarget,
      references: metadata.references,
      phase: previous.phase,
      round: previous.round,
      strictness: previous.strictness,
      mode: previous.mode,
      assurance: previous.assurance,
      runtimePlatform: previous.runtimePlatform,
      runtimeDowngradeReason: previous.runtimeDowngradeReason,
      guardId: previous.guardId,
      eligibleTerminalStatuses: blockingFindings.length > 0 ? ['read-only-findings'] : ['read-only-clean'],
      normalized: {
        reviewerSummary: previous.normalized || {},
        decisions: triage.decisions,
        warnings: triage.warnings,
        blockingFindings
      },
      targetFingerprint: metadata.targetFingerprint,
      referenceFingerprints: metadata.referenceFingerprints
    });
    return {
      ...noStateBase(parsed, metadata, { status: 'recorded-triage' }),
      normalized: triage,
      stateToken
    };
  });
}

function runNoStateFinalize(parsed, options) {
  const metadata = resolveNoStateMetadata(parsed, options);
  const tokenValidationBase = {
    allowedKinds: ['preflight-terminal', 'review-result', 'triage-result'],
    targetKey: metadata.targetKey,
    normalizedTarget: metadata.normalizedTarget,
    references: metadata.references,
    strictness: parsed.invocation.strictness,
    mode: parsed.invocation.mode,
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform,
    maxAgeMs: options.maxAgeMs || NO_STATE_TOKEN_MAX_AGE_MS,
    now: options.now
  };
  const token = validateStateToken(parsed.stateToken, tokenValidationBase);
  if (token.tokenKind !== 'preflight-terminal') {
    validateStateToken(parsed.stateToken, {
      ...tokenValidationBase,
      phase: parsed.phase || 'initial-review',
      round: 1
    });
  }
  const stale = validateNoStateTokenFingerprints(parsed, metadata, token);
  if (stale) return stale;
  const payload = readWorkflowPayload({
    parsed,
    metadata,
    valueFlag: 'finalResponse',
    stdinFlag: 'finalResponseStdin',
    label: 'final response',
    options
  });
  let finalResponse;
  try {
    finalResponse = parseFinalResponseBlock(payload);
    validateFinalResponse({
      finalResponse,
      state: {
        noState: true,
        target: token.normalizedTarget,
        assurance: token.assurance,
        runtimePlatform: token.runtimePlatform,
        mode: token.mode
      }
    });
  } catch (error) {
    return noStateValidationFailure(parsed, metadata, {
      errorCode: 'final-validation-failed',
      message: error && error.message ? error.message : String(error)
    });
  }
  if (finalResponse.finalStatus === 'pass') {
    return noStateValidationFailure(parsed, metadata, {
      errorCode: 'no-state-pass-unsupported',
      message: 'no-state finalizer rejects pass'
    });
  }
  if (!['read-only-clean', 'read-only-findings', 'unsupported', 'blocked'].includes(finalResponse.finalStatus)) {
    return noStateValidationFailure(parsed, metadata, {
      message: `no-state finalizer rejects ${finalResponse.finalStatus}`
    });
  }
  if (
    finalResponse.target !== token.normalizedTarget ||
    finalResponse.assurance !== token.assurance ||
    finalResponse.runtimePlatform !== token.runtimePlatform ||
    finalResponse.mode !== token.mode
  ) {
    return noStateValidationFailure(parsed, metadata, {
      message: 'final response does not match no-state token'
    });
  }
  if (!token.eligibleTerminalStatuses.includes(finalResponse.finalStatus)) {
    return noStateValidationFailure(parsed, metadata, {
      message: `state token does not allow ${finalResponse.finalStatus}`
    });
  }

  const hasBlockingFindings = tokenHasBlockingFindings(token);
  if (finalResponse.finalStatus === 'read-only-clean' && hasBlockingFindings) {
    return noStateValidationFailure(parsed, metadata, {
      message: 'read-only-clean is invalid when no-state token contains blocking findings'
    });
  }
  if (finalResponse.finalStatus === 'read-only-findings' && !hasBlockingFindings) {
    return noStateValidationFailure(parsed, metadata, {
      message: 'read-only-findings is invalid when no-state token contains no blocking findings'
    });
  }

  return {
    ...noStateBase(parsed, metadata, {
      status: finalResponse.finalStatus,
      blockingReason: finalResponse.blockingReason,
      statusReason: finalResponse.statusReason
    }),
    finalResponse
  };
}

async function runNoStateWorkflowCommand(parsed, options) {
  if (isFileSetRoute(parsed)) {
    return runFileSetNoStateWorkflowCommand(parsed, options);
  }
  if (parsed.subcommand === 'preflight') return runNoStatePreflight(parsed, options);
  if (parsed.subcommand === 'context') return runNoStateContext(parsed, options);
  if (parsed.subcommand === 'record-review') return runNoStateRecordReview(parsed, options);
  if (parsed.subcommand === 'record-triage') return runNoStateRecordTriage(parsed, options);
  if (parsed.subcommand === 'finalize') return runNoStateFinalize(parsed, options);
  fail('ERR_NO_STATE_COMMAND', `no-state workflow does not support ${parsed.subcommand}`);
}



module.exports = {
  runNoStatePreflight,
  runWriteEligibilityPreflight,
  runNoStateContext,
  runNoStateRecordReview,
  runNoStateRecordTriage,
  runNoStateFinalize,
  runNoStateWorkflowCommand
};
