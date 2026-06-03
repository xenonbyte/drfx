'use strict';

const {
  blockingFindingsFromReviewerResult,
  blockingFindingsFromTriage,
  buildFileSetContextPack,
  captureFileSetBaseline,
  checkFileSetWorktree,
  computeFileSetFingerprint,
  createPreflightToken,
  createReviewGuard,
  loadRouteRuleContext,
  nextStateToken,
  noStateOutputOrTooLarge,
  parseFinalResponseBlock,
  parseReviewerResult,
  parseTriageResult,
  path,
  readWorkflowPayload,
  recordedDependencySet,
  resolveCodeTarget,
  resolveTargetContext,
  tokenHasBlockingFindings,
  validateFinalResponse,
  validateNoStateTokenFingerprints,
  validateReviewGuard,
  validateStateToken,
  validateTriageReviewerIds,
  withReadOnlyMode,
  workflowBase
} = require('./helpers');
const {
  routeKindFor,
  resolveFileSetProjectRoot
} = require('./target-resolution');

const NO_STATE_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function fileSetNoStateUnsupported(parsed, options) {
  const base = withReadOnlyMode(workflowBase(parsed, options));
  return {
    ...base,
    ok: false,
    status: 'unsupported',
    targetStateDir: null,
    manifestPath: null,
    ledgerPath: null,
    contextManifestPath: null,
    assurance: 'advisory',
    assuranceNormalizedFrom: parsed.assurance,
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    blockingReason: 'none',
    statusReason: 'unsupported-runtime-capability',
    nextAction: 'run the PR/CODE no-state advisory review through workflow context (read-only), or use persistent review-and-fix state'
  };
}

function readBuiltInRubric(routeKind) {
  const rubricPath = path.join(__dirname, '..', '..', 'shared', 'rubrics', `${routeKind}.md`);
  try {
    return require('node:fs').readFileSync(rubricPath, 'utf8');
  } catch {
    return '';
  }
}

function fileSetFingerprintSummary(fingerprint, files = []) {
  return {
    normalizedPath: 'none',
    sha256: fingerprint,
    size: Array.isArray(files) ? files.length : 0,
    mtimeMs: 0
  };
}

async function resolveNoStateFileSetReviewMetadata(parsed, options) {
  const routeKind = routeKindFor(parsed);
  const projectRoot = resolveFileSetProjectRoot(parsed, options);
  const base = withReadOnlyMode(workflowBase(parsed, { ...options, cwd: projectRoot }));

  let liveFileSet;
  if (routeKind === 'pr') {
    const context = await resolveTargetContext({
      routeName: 'review-fix-pr',
      base: parsed.invocation.base,
      cwd: projectRoot,
      commandLog: options.commandLog
    });
    liveFileSet = { routeKind: 'pr', base: context.base, mergeBase: context.mergeBase, head: context.head, files: context.files };
  } else {
    const context = await resolveCodeTarget({ cwd: projectRoot, scopes: parsed.invocation.scopes || [] });
    if (context && context.status === 'blocked') {
      const error = new Error(`excluded-scope: ${context.scope}`);
      error.code = 'ERR_FILE_SET_RESOLVE';
      error.blockingReason = 'state-validation-failed';
      throw error;
    }
    liveFileSet = { routeKind: 'code', normalizedScopes: context.normalizedScopes, files: context.files };
  }

  const fileSetFingerprint = computeFileSetFingerprint(liveFileSet.files);
  return {
    base,
    projectRoot,
    routeKind,
    targetKey: base.targetKey,
    normalizedTarget: 'none',
    references: [],
    targetFingerprint: fileSetFingerprintSummary(fileSetFingerprint, liveFileSet.files),
    referenceFingerprints: [],
    liveFileSet,
    fileSetFingerprint
  };
}

function resolveNoStateFileSetPreflightMetadata(parsed, options) {
  const projectRoot = resolveFileSetProjectRoot(parsed, options);
  const base = withReadOnlyMode(workflowBase(parsed, { ...options, cwd: projectRoot }));
  return {
    base,
    projectRoot,
    routeKind: routeKindFor(parsed),
    targetKey: base.targetKey,
    normalizedTarget: 'none',
    references: [],
    targetFingerprint: null,
    referenceFingerprints: []
  };
}

function fileSetNoStateBase(parsed, metadata, overrides = {}) {
  const mode = overrides.mode || parsed.invocation.mode;
  return {
    ...metadata.base,
    ok: true,
    status: overrides.status || 'started',
    targetStateDir: null,
    manifestPath: null,
    ledgerPath: null,
    contextManifestPath: null,
    round: overrides.round || 1,
    mode,
    modeNormalizedFrom: mode === parsed.invocation.mode ? parsed.invocation.modeNormalizedFrom : parsed.invocation.mode,
    runtimeCheck: overrides.runtimeCheck || parsed.runtimeCheck,
    blockingReason: overrides.blockingReason || parsed.blockingReason || 'none',
    statusReason: overrides.statusReason || parsed.statusReason || 'none',
    nextAction: Object.hasOwn(overrides, 'nextAction') ? overrides.nextAction : null
  };
}

function fileSetStrictness(parsed) {
  return parsed.invocation.strictness || 'normal';
}

function fileSetNoStateValidationFailure(parsed, metadata, {
  errorCode = 'final-validation-failed',
  message,
  blockingReason = 'final-validation-failed',
  statusReason = 'none',
  nextAction = null
} = {}) {
  return {
    ...fileSetNoStateBase(parsed, metadata, {
      status: 'blocked',
      blockingReason,
      statusReason,
      nextAction
    }),
    ok: false,
    errorCode,
    message
  };
}

function fallbackFileSetNoStateBase(parsed) {
  return withReadOnlyMode({
    ok: true,
    status: 'started',
    entrySkill: parsed.entrySkill,
    routeKind: routeKindFor(parsed),
    documentType: 'none',
    target: null,
    base: parsed.invocation.base || null,
    scopes: Array.isArray(parsed.invocation.scopes) ? parsed.invocation.scopes.slice() : null,
    targetKey: null,
    requestedMode: parsed.invocation.requestedMode,
    mode: parsed.invocation.mode,
    guardMode: parsed.invocation.guardMode || 'git',
    modeSource: parsed.invocation.modeSource,
    modeNormalizedFrom: parsed.invocation.modeNormalizedFrom,
    strictness: fileSetStrictness(parsed),
    requestedAssurance: parsed.invocation.requestedAssurance || parsed.assurance,
    assurance: parsed.assurance,
    assuranceSource: parsed.payloadFlags.assurance ? 'explicit' : (parsed.invocation.assuranceSource || 'default'),
    assuranceNormalizedFrom: null,
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    runtimePlatform: parsed.runtimePlatform,
    runtimeCheck: parsed.runtimeCheck,
    blockingReason: parsed.blockingReason || 'none',
    statusReason: parsed.statusReason || 'none'
  });
}

function fallbackFileSetNoStateMetadata(parsed, options) {
  try {
    return resolveNoStateFileSetPreflightMetadata(parsed, options);
  } catch {
    return {
      base: fallbackFileSetNoStateBase(parsed),
      projectRoot: options.cwd || process.cwd(),
      routeKind: routeKindFor(parsed),
      targetKey: null,
      normalizedTarget: 'none',
      references: [],
      targetFingerprint: null,
      referenceFingerprints: []
    };
  }
}

function fileSetExpectedGuard(parsed, metadata) {
  return {
    phase: parsed.phase || 'initial-review',
    round: 1,
    normalizedTarget: metadata.normalizedTarget,
    references: metadata.references,
    targetFingerprint: metadata.targetFingerprint,
    referenceFingerprints: metadata.referenceFingerprints,
    strictness: fileSetStrictness(parsed),
    mode: parsed.invocation.mode,
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform
  };
}

async function runFileSetNoStateContext(parsed, options) {
  let metadata;
  try {
    metadata = await resolveNoStateFileSetReviewMetadata(parsed, options);
  } catch (error) {
    let base;
    try {
      const fallback = resolveNoStateFileSetPreflightMetadata(parsed, options);
      base = fallback.base;
    } catch {
      base = fallbackFileSetNoStateBase(parsed);
    }
    return {
      ...base,
      ok: false,
      status: 'blocked',
      targetStateDir: null,
      manifestPath: null,
      ledgerPath: null,
      contextManifestPath: null,
      blockingReason: 'state-validation-failed',
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
      message: error && error.message ? error.message : String(error),
      nextAction: 'resolve a valid base/scope file set before reviewing'
    };
  }

  const ruleContext = loadRouteRuleContext({
    routeKind: metadata.routeKind,
    builtInRubric: readBuiltInRubric(metadata.routeKind),
    homeDir: options.homeDir || null,
    projectRoot: metadata.projectRoot
  });
  const layers = Array.isArray(ruleContext.layers) ? ruleContext.layers : [];
  const mergedRules = {
    text: layers.map((layer) => layer.text).filter(Boolean).join('\n\n'),
    layers,
    sources: layers.map((layer) => layer.source)
  };
  const contextPackSkeleton = buildFileSetContextPack({
    routeKind: metadata.routeKind,
    fileSet: metadata.liveFileSet,
    strictness: fileSetStrictness(parsed),
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: parsed.runtimePlatform,
    phase: parsed.phase || 'initial-review',
    round: 1,
    mergedRules,
    requiredOutputSchema: 'reviewer-pass-fail',
    reviewerGuardBaseline: null,
    projectRoot: metadata.projectRoot
  });
  const reviewGuard = createReviewGuard({
    phase: parsed.phase || 'initial-review',
    round: 1,
    normalizedTarget: metadata.normalizedTarget,
    references: metadata.references,
    targetFingerprint: metadata.targetFingerprint,
    referenceFingerprints: metadata.referenceFingerprints,
    strictness: fileSetStrictness(parsed),
    mode: parsed.invocation.mode,
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform
  });

  return {
    ...fileSetNoStateBase(parsed, metadata, { status: 'context' }),
    ok: true,
    status: 'context',
    createdTargetState: false,
    assurance: 'advisory',
    assuranceNormalizedFrom: parsed.assurance !== 'advisory' ? parsed.assurance : null,
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    warnings: ruleContext.warnings || [],
    contextPackSkeleton: {
      ...contextPackSkeleton,
      fileSetFingerprint: metadata.fileSetFingerprint
    },
    reviewGuard,
    fileSetFingerprint: metadata.fileSetFingerprint,
    blockingReason: 'none',
    statusReason: 'none',
    nextAction: 'run a read-only advisory file-set review; do not claim PASS and do not auto-fix'
  };
}

function runFileSetNoStatePreflight(parsed, options) {
  let metadata;
  try {
    metadata = resolveNoStateFileSetPreflightMetadata(parsed, options);
  } catch (error) {
    const base = fallbackFileSetNoStateBase(parsed);
    return {
      ...base,
      ok: false,
      status: 'blocked',
      targetStateDir: null,
      manifestPath: null,
      ledgerPath: null,
      contextManifestPath: null,
      blockingReason: 'state-validation-failed',
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
      message: error && error.message ? error.message : String(error),
      nextAction: 'resolve a valid base/scope file set before reviewing'
    };
  }
  const runtimeCheck = {
    ...parsed.runtimeCheck,
    fingerprintGuard: { status: 'not-run' }
  };
  return noStateOutputOrTooLarge(parsed, metadata, () => {
    const stateToken = createPreflightToken({
      targetKey: metadata.targetKey,
      normalizedTarget: metadata.normalizedTarget,
      references: metadata.references,
      strictness: fileSetStrictness(parsed),
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
      ...fileSetNoStateBase(parsed, metadata, {
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

async function runFileSetWriteEligibilityPreflight(parsed, options) {
  const projectRoot = resolveFileSetProjectRoot(parsed, options);
  const base = workflowBase(parsed, { ...options, cwd: projectRoot });
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

  let liveFileSet;
  try {
    if (routeKindFor(parsed) === 'pr') {
      const context = await resolveTargetContext({
        routeName: 'review-fix-pr',
        base: parsed.invocation.base,
        cwd: projectRoot,
        commandLog: options.commandLog
      });
      liveFileSet = { routeKind: 'pr', files: context.files };
    } else {
      const context = await resolveCodeTarget({ cwd: projectRoot, scopes: parsed.invocation.scopes || [] });
      if (context && context.status === 'blocked') {
        return {
          ...base,
          ok: false,
          status: 'blocked',
          currentPhase: 'review',
          targetStateDir: null,
          blockingReason: 'state-validation-failed',
          statusReason: 'none',
          message: `excluded-scope: ${context.scope}`,
          nextAction: 'choose a source scope outside excluded directories'
        };
      }
      liveFileSet = { routeKind: 'code', files: context.files };
    }
    const monitoredSet = recordedDependencySet({ projectRoot, liveFileSet, extraDependencies: [] });
    const guardMode = parsed.invocation.guardMode || 'git';
    const guardResult = guardMode === 'snapshot'
      ? captureFileSetBaseline({ projectRoot, monitoredFiles: monitoredSet, allowedStateDir: null })
      : checkFileSetWorktree({ projectRoot, allowedFiles: monitoredSet, allowedStateDir: null });
    if (guardResult.status === 'blocked') {
      return {
        ...base,
        ok: false,
        status: 'blocked',
        currentPhase: 'review',
        projectRoot,
        targetStateDir: null,
        blockingReason: guardResult.blockingReason || 'unexpected-worktree-change',
        statusReason: 'none',
        message: guardResult.message || 'write eligibility preflight blocked automatic file-set writes',
        nextAction: 'commit, stash, or restore unrelated worktree changes before retrying'
      };
    }
    return {
      ...base,
      ok: true,
      status: 'write-eligible',
      currentPhase: 'review',
      projectRoot,
      targetStateDir: null,
      fileSetFingerprint: computeFileSetFingerprint(liveFileSet.files),
      targetOnlyGuard: {
        status: 'passed',
        guardMode,
        monitoredFileCount: monitoredSet.length
      },
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
      nextAction: 'commit or restore the file set, or rerun with read-only'
    };
  }
}

async function runFileSetNoStateRecordReview(parsed, options) {
  let metadata;
  try {
    metadata = await resolveNoStateFileSetReviewMetadata(parsed, options);
  } catch (error) {
    const fallback = fallbackFileSetNoStateMetadata(parsed, options);
    return fileSetNoStateValidationFailure(parsed, fallback, {
      errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
      message: error && error.message ? error.message : String(error),
      blockingReason: 'state-validation-failed',
      nextAction: 'resolve a valid base/scope file set before reviewing'
    });
  }
  let guard;
  try {
    guard = validateReviewGuard(parsed.reviewGuard, fileSetExpectedGuard(parsed, metadata));
  } catch (error) {
    if (error.code === 'ERR_REVIEWER_MUTATED_FILE') {
      return fileSetNoStateValidationFailure(parsed, metadata, {
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
      strictness: fileSetStrictness(parsed),
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
      ...fileSetNoStateBase(parsed, metadata, { status: 'recorded-review' }),
      normalized: reviewerResult,
      stateToken
    };
  });
}

async function runFileSetNoStateRecordTriage(parsed, options) {
  let metadata;
  try {
    metadata = await resolveNoStateFileSetReviewMetadata(parsed, options);
  } catch (error) {
    const fallback = fallbackFileSetNoStateMetadata(parsed, options);
    return fileSetNoStateValidationFailure(parsed, fallback, {
      errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
      message: error && error.message ? error.message : String(error),
      blockingReason: 'state-validation-failed',
      nextAction: 'resolve a valid base/scope file set before reviewing'
    });
  }
  const previous = validateStateToken(parsed.stateToken, {
    allowedKinds: ['review-result'],
    targetKey: metadata.targetKey,
    normalizedTarget: metadata.normalizedTarget,
    references: metadata.references,
    phase: parsed.phase || 'initial-review',
    round: 1,
    strictness: fileSetStrictness(parsed),
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
      ...fileSetNoStateBase(parsed, metadata, { status: 'recorded-triage' }),
      normalized: triage,
      stateToken
    };
  });
}

async function runFileSetNoStateFinalize(parsed, options) {
  let metadata;
  try {
    metadata = await resolveNoStateFileSetReviewMetadata(parsed, options);
  } catch (error) {
    const fallback = fallbackFileSetNoStateMetadata(parsed, options);
    return fileSetNoStateValidationFailure(parsed, fallback, {
      errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
      message: error && error.message ? error.message : String(error),
      blockingReason: 'state-validation-failed',
      nextAction: 'resolve a valid base/scope file set before reviewing'
    });
  }
  const tokenValidationBase = {
    allowedKinds: ['preflight-terminal', 'review-result', 'triage-result'],
    targetKey: metadata.targetKey,
    normalizedTarget: metadata.normalizedTarget,
    references: metadata.references,
    strictness: fileSetStrictness(parsed),
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
    finalResponse = parseFinalResponseBlock(payload, { allowFileSet: true });
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
    return fileSetNoStateValidationFailure(parsed, metadata, {
      errorCode: 'final-validation-failed',
      message: error && error.message ? error.message : String(error)
    });
  }
  if (finalResponse.finalStatus === 'pass') {
    return fileSetNoStateValidationFailure(parsed, metadata, {
      errorCode: 'no-state-pass-unsupported',
      message: 'no-state finalizer rejects pass'
    });
  }
  if (!['read-only-clean', 'read-only-findings', 'unsupported', 'blocked'].includes(finalResponse.finalStatus)) {
    return fileSetNoStateValidationFailure(parsed, metadata, {
      message: `no-state finalizer rejects ${finalResponse.finalStatus}`
    });
  }
  if (
    finalResponse.target !== token.normalizedTarget ||
    finalResponse.assurance !== token.assurance ||
    finalResponse.runtimePlatform !== token.runtimePlatform ||
    finalResponse.mode !== token.mode
  ) {
    return fileSetNoStateValidationFailure(parsed, metadata, {
      message: 'final response does not match no-state token'
    });
  }
  if (!token.eligibleTerminalStatuses.includes(finalResponse.finalStatus)) {
    return fileSetNoStateValidationFailure(parsed, metadata, {
      message: `state token does not allow ${finalResponse.finalStatus}`
    });
  }

  const hasBlockingFindings = tokenHasBlockingFindings(token);
  if (finalResponse.finalStatus === 'read-only-clean' && hasBlockingFindings) {
    return fileSetNoStateValidationFailure(parsed, metadata, {
      message: 'read-only-clean is invalid when no-state token contains blocking findings'
    });
  }
  if (finalResponse.finalStatus === 'read-only-findings' && !hasBlockingFindings) {
    return fileSetNoStateValidationFailure(parsed, metadata, {
      message: 'read-only-findings is invalid when no-state token contains no blocking findings'
    });
  }

  return {
    ...fileSetNoStateBase(parsed, metadata, {
      status: finalResponse.finalStatus,
      blockingReason: finalResponse.blockingReason,
      statusReason: finalResponse.statusReason
    }),
    finalResponse
  };
}

async function runFileSetNoStateWorkflowCommand(parsed, options) {
  if (parsed.subcommand === 'preflight') return runFileSetNoStatePreflight(parsed, options);
  if (parsed.subcommand === 'context') return runFileSetNoStateContext(parsed, options);
  if (parsed.subcommand === 'record-review') return runFileSetNoStateRecordReview(parsed, options);
  if (parsed.subcommand === 'record-triage') return runFileSetNoStateRecordTriage(parsed, options);
  if (parsed.subcommand === 'finalize') return runFileSetNoStateFinalize(parsed, options);
  return fileSetNoStateUnsupported(parsed, options);
}

module.exports = {
  runFileSetWriteEligibilityPreflight,
  runFileSetNoStateWorkflowCommand
};
