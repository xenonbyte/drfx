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
  describeCodeBlock,
  fileSetReviewFingerprintSummary,
  loadRouteRuleContext,
  nextStateToken,
  noStateOutputOrTooLarge,
  parseFinalResponseBlock,
  parseReviewerResult,
  parseTriageResult,
  path,
  loadMergedRules,
  readWorkflowPayload,
  resolvedFileSetMemberSet,
  resolveCodeTarget,
  resolveR2pWorkIdTarget,
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
  resolveFileSetProjectRoot,
  resolveRouteTargetMetadata
} = require('./target-resolution');
const { assemblePartitionPlan } = require('./file-set-context');
const { resolveCodeInventory } = require('../target-context');

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

async function resolveNoStateFileSetReviewMetadata(parsed, options) {
  const routeKind = routeKindFor(parsed);
  const projectRoot = resolveFileSetProjectRoot(parsed, options);
  const base = withReadOnlyMode(workflowBase(parsed, {
    ...options,
    cwd: projectRoot,
    rootCwd: options.cwd || process.cwd()
  }));

  let liveFileSet;
  let r2pContext = null;
  if (routeKind === 'pr') {
    const context = await resolveTargetContext({
      routeName: 'review-fix-pr',
      base: parsed.invocation.base,
      cwd: projectRoot,
      commandLog: options.commandLog
    });
    liveFileSet = { routeKind: 'pr', base: context.base, mergeBase: context.mergeBase, head: context.head, files: context.files };
  } else if (routeKind === 'r2p') {
    // r2p resolves an active workId, NOT a CODE scope traversal: it enforces the
    // active-run preflight and surfaces the read-only 03–07 review set. Any
    // gate/shape failure throws (ERR_R2P_*) and surfaces as a clean blocked
    // result via the caller's catch — it never reaches reviewer-recording.
    const targetMetadata = resolveRouteTargetMetadata(parsed, {
      ...options,
      cwd: projectRoot,
      rootCwd: options.cwd || process.cwd()
    });
    const context = resolveR2pWorkIdTarget({
      projectRoot,
      workId: targetMetadata.workId
    });
    r2pContext = context;
    const files = (context.reviewFileEntries || []).map((file) => ({
      path: file.path,
      requirementRelativePath: file.requirementRelativePath,
      status: file.status,
      contentId: file.contentId
    }));
    liveFileSet = {
      routeKind: 'r2p',
      workId: context.workId,
      runDir: context.runDir,
      runLocation: context.runLocation,
      runMdPath: context.runMdPath,
      reviewSetFingerprint: context.fileSetFingerprint,
      // The review anchor is 07-plan.md, but the reviewer needs the full 03–07
      // requirement-doc chain to judge backing, contradictions, and owner-doc fixes.
      files,
      protectedDependencies: [{
        path: path.relative(projectRoot, context.runMdPath).split(path.sep).join('/'),
        readOnly: true,
        sha256: context.runMdSha256
      }]
    };
  } else {
    const context = await resolveCodeTarget({ cwd: projectRoot, scopes: parsed.invocation.scopes || [] });
    if (context && context.status === 'blocked') {
      const blocked = describeCodeBlock(context);
      const error = new Error(blocked.message);
      error.code = 'ERR_FILE_SET_RESOLVE';
      error.blockingReason = 'state-validation-failed';
      error.nextAction = blocked.nextAction;
      // PLAN-TASK-003 (D-A site #2): a whole-root over-cap no-state CODE review is the
      // review-entry concern, so it routes to partitioned review (handled by the caller).
      // `file-set-too-large` only fires for whole-root, so it is the discriminator;
      // `excluded-scope` keeps throwing a normal block. We surface the reason + projectRoot
      // so runFileSetNoStateContext can assemble the no-state plan WITHOUT writing state.
      error.reason = context.reason;
      error.projectRoot = projectRoot;
      throw error;
    }
    liveFileSet = {
      routeKind: 'code',
      normalizedScopes: context.normalizedScopes,
      userExcludes: context.userExcludes,
      userExcludePatterns: context.userExcludePatterns,
      scopeIgnoreOverrides: context.scopeIgnoreOverrides,
      versionIgnoreSource: context.versionIgnoreSource,
      files: context.files
    };
  }

  // r2p's identity + drift fingerprint covers the full editable 03–07 set (the
  // resolver's fileSetFingerprint), even though the read-only review anchor is
  // just 07-plan.md. Other file-set routes fingerprint exactly their reviewed set.
  const fileSetFingerprint = r2pContext
    ? r2pContext.fileSetFingerprint
    : computeFileSetFingerprint(liveFileSet.files);
  return {
    base,
    projectRoot,
    routeKind,
    targetKey: base.targetKey,
    normalizedTarget: 'none',
    references: [],
    targetFingerprint: fileSetReviewFingerprintSummary(projectRoot, fileSetFingerprint, liveFileSet),
    referenceFingerprints: [],
    liveFileSet,
    fileSetFingerprint
  };
}

function resolveNoStateFileSetPreflightMetadata(parsed, options) {
  const projectRoot = resolveFileSetProjectRoot(parsed, options);
  const base = withReadOnlyMode(workflowBase(parsed, {
    ...options,
    cwd: projectRoot,
    rootCwd: options.cwd || process.cwd()
  }));
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

// PLAN-TASK-003 (SPEC-BEHAVIOR-006): a one-shot read-only --no-state whole-root over-cap
// CODE review returns a no-state partition PLAN and writes NOTHING under .drfx/targets/.
// It assembles the same partition plan as the persistent path (uncapped inventory →
// partitioned units) but never persists it. This is plan/advisory only — it can NEVER
// claim a workflow PASS (no PASS-earning status, mode pinned read-only).
async function noStateFileSetPartitionPlan(parsed, options, error) {
  const projectRoot = error.projectRoot || resolveFileSetProjectRoot(parsed, options);
  const base = withReadOnlyMode(workflowBase(parsed, {
    ...options,
    cwd: projectRoot,
    rootCwd: options.cwd || process.cwd()
  }));
  const { inventory, projectReviewFingerprint, userExcludes } = await resolveCodeInventory({
    cwd: projectRoot,
    scopes: [],
    commandLog: options.commandLog
  });
  const plan = assemblePartitionPlan({ inventory, projectReviewFingerprint, userExcludes, projectRoot });
  return {
    ...fileSetNoStateBase(parsed, { base }, { status: 'partitioned-review', mode: 'read-only' }),
    ok: true,
    status: 'partitioned-review',
    reviewMode: plan.reviewMode,
    unitCount: plan.units.length,
    unitByteBudget: plan.unitByteBudget,
    units: plan.units,
    crosscuttingBackstops: plan.crosscuttingBackstops,
    projectReviewFingerprint: plan.projectReviewFingerprint,
    userExcludes: plan.userExcludes,
    contextManifestPath: null,
    assurance: parsed.assurance,
    assuranceNormalizedFrom: null,
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    blockingReason: 'none',
    // No-state assembles the plan but writes NO checkpoint, so it carries no
    // checkpoint-requested status reason — it is plan/advisory only, never a PASS.
    statusReason: 'none',
    nextAction: 'run a read-only partitioned project review unit by unit; do not claim PASS and do not auto-fix'
  };
}

async function runFileSetNoStateContext(parsed, options) {
  let metadata;
  try {
    metadata = await resolveNoStateFileSetReviewMetadata(parsed, options);
  } catch (error) {
    // Whole-root over-cap CODE → no-state partition plan (writes nothing). Any other
    // resolve failure (excluded-scope, bad base, etc.) stays a clean blocked result.
    if (error && error.reason === 'file-set-too-large') {
      return noStateFileSetPartitionPlan(parsed, options, error);
    }
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
      blockingReason: parsed.invocation.routeKind === 'r2p' && error && error.blockingReason
        ? error.blockingReason
        : 'state-validation-failed',
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
      message: error && error.message ? error.message : String(error),
      nextAction: (error && error.nextAction) || 'resolve a valid base/scope file set before reviewing'
    };
  }

  // r2p is a DOCUMENT-rubric route (documentType PLAN): it merges the COMMON+PLAN
  // document rule stack via loadMergedRules, NOT the self-contained PR/CODE
  // route-rubric stack (loadRouteRuleContext rejects 'r2p' as an unknown route
  // kind). PR/CODE keep their route-kind rule stack.
  let mergedRules;
  let ruleWarnings;
  if (metadata.routeKind === 'r2p') {
    const merged = loadMergedRules({
      projectRoot: metadata.projectRoot,
      documentType: 'PLAN',
      strictness: fileSetStrictness(parsed),
      homeDir: options.homeDir || null
    });
    mergedRules = { text: merged.text, layers: merged.layers, sources: merged.sources };
    ruleWarnings = merged.warnings || [];
  } else {
    const ruleContext = loadRouteRuleContext({
      routeKind: metadata.routeKind,
      builtInRubric: readBuiltInRubric(metadata.routeKind),
      homeDir: options.homeDir,
      projectRoot: metadata.projectRoot
    });
    const layers = Array.isArray(ruleContext.layers) ? ruleContext.layers : [];
    mergedRules = {
      text: layers.map((layer) => layer.text).filter(Boolean).join('\n\n'),
      layers,
      sources: layers.map((layer) => layer.source)
    };
    ruleWarnings = ruleContext.warnings || [];
  }
  const contextPackSkeleton = buildFileSetContextPack({
    routeKind: metadata.routeKind,
    fileSet: metadata.liveFileSet,
    strictness: fileSetStrictness(parsed),
    mode: 'read-only',
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform,
    phase: parsed.phase || 'initial-review',
    round: 1,
    mergedRules,
    requiredOutputSchema: 'reviewer-pass-fail',
    reviewerGuardBaseline: null,
    protectedDependencies: Array.isArray(metadata.liveFileSet.protectedDependencies)
      ? metadata.liveFileSet.protectedDependencies
      : null,
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
    assurance: parsed.assurance,
    assuranceNormalizedFrom: null,
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    warnings: ruleWarnings,
    contextPackSkeleton: {
      ...contextPackSkeleton,
      fileSetFingerprint: metadata.fileSetFingerprint
    },
    reviewGuard,
    fileSetFingerprint: metadata.fileSetFingerprint,
    blockingReason: 'none',
    statusReason: 'none',
    nextAction: 'run a read-only file-set review; do not claim PASS and do not auto-fix'
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
      nextAction: (error && error.nextAction) || 'resolve a valid base/scope file set before reviewing'
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
  const targetMetadata = resolveRouteTargetMetadata(parsed, options);
  const projectRoot = targetMetadata.projectRoot;
  const routeKind = routeKindFor(parsed);
  const base = workflowBase(parsed, {
    ...options,
    cwd: projectRoot,
    rootCwd: options.cwd || process.cwd()
  });
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
  const guardMode = parsed.invocation.guardMode || 'git';
  try {
    if (routeKind === 'pr') {
      const context = await resolveTargetContext({
        routeName: 'review-fix-pr',
        base: parsed.invocation.base,
        cwd: projectRoot,
        commandLog: options.commandLog
      });
      liveFileSet = { routeKind: 'pr', files: context.files };
    } else if (routeKind === 'r2p') {
      // r2p write eligibility resolves via the active workId review set, NOT
      // resolveCodeTarget. Any gate/shape failure throws ERR_R2P_* and is
      // surfaced as a clean blocked result by the catch below.
      const context = resolveR2pWorkIdTarget({
        projectRoot,
        workId: targetMetadata.workId
      });
      liveFileSet = {
        routeKind: 'r2p',
        files: (context.reviewFileEntries || []).map((file) => ({
          path: file.path,
          requirementRelativePath: file.requirementRelativePath,
          status: file.status,
          contentId: file.contentId
        }))
      };
      return {
        ...base,
        ok: true,
        status: 'write-eligible',
        currentPhase: 'review',
        projectRoot,
        targetStateDir: null,
        fileSetFingerprint: computeFileSetFingerprint(liveFileSet.files),
        targetOnlyGuard: {
          status: 'not-applicable',
          guardMode: 'r2p-lifecycle',
          monitoredFileCount: liveFileSet.files.length,
          reason: 'r2p-repair-uses-lifecycle-commands'
        },
        blockingReason: 'none',
        statusReason: 'none',
        nextAction: 'continue review-and-fix workflow'
      };
    } else {
      const context = await resolveCodeTarget({ cwd: projectRoot, scopes: parsed.invocation.scopes || [] });
      if (context && context.status === 'blocked') {
        if (context.reason === 'file-set-too-large' && Array.isArray(base.scopes) && base.scopes.length === 0) {
          return {
            ...base,
            ok: true,
            status: 'write-eligible',
            currentPhase: 'review',
            projectRoot,
            targetStateDir: null,
            fileSetFingerprint: null,
            targetOnlyGuard: {
              status: 'partitioning-deferred',
              guardMode,
              reason: 'whole-root-over-cap',
              fileCount: context.fileCount,
              totalBytes: context.totalBytes
            },
            blockingReason: 'none',
            statusReason: 'none',
            nextAction: 'continue workflow start so the over-cap whole-root CODE review can enter partitioned project review'
          };
        }
        const blocked = describeCodeBlock(context);
        return {
          ...base,
          ok: false,
          status: 'blocked',
          currentPhase: 'review',
          targetStateDir: null,
          blockingReason: 'state-validation-failed',
          statusReason: 'none',
          message: blocked.message,
          nextAction: blocked.nextAction
        };
      }
      liveFileSet = { routeKind: 'code', files: context.files };
    }
    const monitoredSet = resolvedFileSetMemberSet({ projectRoot, liveFileSet });
    const guardResult = guardMode === 'snapshot'
      ? captureFileSetBaseline({ projectRoot, monitoredFiles: monitoredSet, allowedStateDir: null })
      : checkFileSetWorktree({
        projectRoot,
        allowedFiles: monitoredSet,
        allowedStateDir: null,
        allowAllowedFileChanges: false
      });
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
      nextAction: (error && error.nextAction) || 'resolve a valid base/scope file set before reviewing'
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
      nextAction: (error && error.nextAction) || 'resolve a valid base/scope file set before reviewing'
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
      nextAction: (error && error.nextAction) || 'resolve a valid base/scope file set before reviewing'
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
