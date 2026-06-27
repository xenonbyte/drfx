'use strict';

const childProcess = require('node:child_process');

const {
  archiveTargetState,
  atomicWriteFile,
  computeFingerprint,
  deriveTargetKey,
  fail,
  failStartStateValidation,
  formatLedger,
  formatManifestV2,
  fs,
  loadMergedRules,
  normalizeReferences,
  normalizedReferencePath,
  path,
  resolveProjectRoot,
  targetStateDirectory,
  validateLedgerPath,
  validatePersistentStartStatePaths,
  workflowBase
} = require('./helpers');
const {
  isFileSetRoute,
  resolveFileSetProjectRoot,
  resolveRouteTargetMetadata
} = require('./target-resolution');
const {
  resolveTargetContext,
  resolveCodeTarget,
  resolveR2pTarget,
  resolveR2pWorkIdTarget,
  describeCodeBlock,
  buildPrIdentity,
  buildCodeIdentity,
  buildR2pIdentity,
  codeExcludedDirectoryEntries
} = require('../target-context');
const { loadRouteRuleContext } = require('../rulebook');
const {
  resolveWholeRootPartitionPlan,
  writeProjectReviewPlan
} = require('./file-set-context');

function hasGitGuard(projectRoot) {
  try {
    return childProcess.execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() === 'true';
  } catch {
    return false;
  }
}

// Existing persistent state gates a fresh start. Without `reset` it refuses (ERR_STATE_EXISTS,
// never a silent reuse). With the explicit `reset` token it ARCHIVES the prior target state
// (rename to .drfx/archived/<key>-<ts>, never delete/overwrite) so a fresh start can recompute
// identity under the current resolver policy. This is the explicit escape from the
// start(ERR_STATE_EXISTS) ⇄ resume(stale-identity) deadlock. Returns the archived path or null.
function ensureFreshStartState({ targetStateDir, manifestPath, reset, options }) {
  if (!fs.existsSync(manifestPath)) return null;
  if (!reset) {
    fail('ERR_STATE_EXISTS', 'persistent workflow state already exists; use resume (or reset to archive it and start over)');
  }
  return archiveTargetState({ targetStateDir, options });
}

// PLAN-TASK-009 (Phase B): live PR/CODE file-set state is created here and ONLY here,
// through the PLAN-TASK-003/004 schema/identity helpers. The resolver runs LOCAL
// read-only git (PR) or working-tree traversal (CODE) — no fetch, no remote, no ref
// mutation. The file-set MANIFEST.md is written with targetContextKind pr/code so the
// schema-2 parser routes it to the file-set branch. PR/CODE start requires the explicit
// `resume` token to reuse matching state (handled upstream); a fresh start with existing
// state fails ERR_STATE_EXISTS exactly like the document path — never a silent reuse.
async function runFileSetStart(parsed, options) {
  const originalCwd = options.cwd || process.cwd();
  let projectRoot;
  let targetMetadata;
  try {
    projectRoot = resolveFileSetProjectRoot(parsed, options);
    targetMetadata = resolveRouteTargetMetadata(parsed, { ...options, cwd: projectRoot, rootCwd: originalCwd });
  } catch (error) {
    return {
      ok: false,
      status: 'blocked',
      entrySkill: parsed.entrySkill,
      routeKind: 'r2p',
      documentType: 'none',
      target: null,
      base: null,
      scopes: null,
      normalizedTarget: null,
      targetKey: null,
      requestedMode: parsed.invocation.mode,
      mode: parsed.invocation.mode,
      guardMode: parsed.invocation.guardMode || 'snapshot',
      runtimePlatform: parsed.runtimePlatform,
      descriptorPlatform: 'none',
      assuranceProof: 'none',
      targetStateDir: null,
      manifestPath: null,
      ledgerPath: null,
      round: null,
      currentPhase: 'review',
      blockingReason: (error && error.blockingReason) || 'state-validation-failed',
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
      message: error && error.message ? error.message : String(error),
      nextAction: (error && error.nextAction) || 'resolve a valid base/scope file set before starting workflow'
    };
  }
  const routeKind = targetMetadata.routeKind;
  const targetKey = targetMetadata.targetKey;
  const targetStateDir = targetStateDirectory(projectRoot, targetKey);
  const manifestPath = path.join(targetStateDir, 'MANIFEST.md');
  const base = workflowBase(parsed, { ...options, cwd: projectRoot, rootCwd: originalCwd });
  const guardMode = routeKind === 'r2p' ? 'snapshot' : (parsed.invocation.guardMode || 'git');

  // git guard-mode requires a working git tree (PR routes always need git; a CODE
  // route on git guard does too). Mirror the document git-guard-unavailable path.
  if (guardMode === 'git' && !hasGitGuard(projectRoot)) {
    return {
      ...base,
      ok: false,
      status: 'unsupported',
      targetStateDir: null,
      manifestPath: null,
      ledgerPath: null,
      round: null,
      currentPhase: 'review',
      blockingReason: 'none',
      statusReason: 'git-guard-unavailable',
      nextAction: 'pass guard=snapshot to use file snapshot rollback'
    };
  }

  // File-set routes use the PLAN-TASK-007 route-kind rule stack (no COMMON layer), loaded
  // by the reviewer/fixer context step rather than gating state creation here. Surface any
  // rule-file warnings without failing start when no custom rule files exist. r2p is the
  // exception: it is a DOCUMENT-rubric (PLAN) route and merges the COMMON+PLAN stack via
  // loadMergedRules (loadRouteRuleContext rejects 'r2p' as an unknown route kind).
  try {
    if (routeKind === 'r2p') {
      const merged = loadMergedRules({
        projectRoot,
        documentType: 'PLAN',
        strictness: parsed.invocation.strictness || 'normal',
        homeDir: options.homeDir || null
      });
      base.warnings = Array.isArray(merged.warnings) ? merged.warnings : [];
    } else {
      const ruleContext = loadRouteRuleContext({
        routeKind,
        builtInRubric: '',
        homeDir: options.homeDir,
        projectRoot
      });
      base.warnings = Array.isArray(ruleContext.warnings) ? ruleContext.warnings : [];
    }
  } catch (error) {
    return failStartStateValidation(base, {
      targetStateDir,
      manifestPath,
      message: `rulebook validation failed: ${error && error.message ? error.message : String(error)}`,
      nextAction: 'repair rulebook before starting workflow'
    });
  }

  // Resolve the LIVE file set + identity. The resolver is pure/read-only (PLAN-TASK-003/004).
  let context;
  let identity;
  // PLAN-TASK-003: a whole-root CODE review that exceeds the cap no longer hard-blocks;
  // it enters partitioned project review. `reason:'file-set-too-large'` ONLY fires for
  // whole-root (the cap is null-guarded for scoped runs), so it is itself the discriminator.
  // `excluded-scope` stays a normal block. The uncapped inventory + partition plan are
  // assembled here (read-only) and the checkpoint manifest is written after the shared preamble.
  let partitionPlan = null;
  try {
    if (routeKind === 'pr') {
      context = await resolveTargetContext({
        routeName: 'review-fix-pr',
        base: parsed.invocation.base,
        cwd: projectRoot,
        commandLog: options.commandLog
      });
      identity = buildPrIdentity({ context, guardMode, roundLimit: parsed.invocation.roundLimit });
    } else if (routeKind === 'r2p') {
      context = resolveR2pWorkIdTarget({
        projectRoot,
        workId: targetMetadata.workId
      });
      identity = buildR2pIdentity({ context, guardMode, roundLimit: parsed.invocation.roundLimit });
    } else {
      context = await resolveCodeTarget({ cwd: projectRoot, scopes: parsed.invocation.scopes || [] });
      if (context && context.status === 'blocked') {
        if (context.reason === 'file-set-too-large') {
          partitionPlan = await resolveWholeRootPartitionPlan({
            projectRoot,
            commandLog: options.commandLog
          });
        } else {
          const blocked = describeCodeBlock(context);
          return {
            ...base,
            ok: false,
            status: 'blocked',
            targetStateDir: null,
            manifestPath: null,
            ledgerPath: null,
            round: null,
            currentPhase: 'review',
            blockingReason: 'state-validation-failed',
            statusReason: 'none',
            message: blocked.message,
            nextAction: blocked.nextAction
          };
        }
      } else {
        identity = buildCodeIdentity({ context, guardMode, roundLimit: parsed.invocation.roundLimit });
      }
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      targetStateDir: null,
      manifestPath: null,
      ledgerPath: null,
      round: null,
      currentPhase: 'review',
      blockingReason: (error && error.blockingReason) || 'state-validation-failed',
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
      message: error && error.message ? error.message : String(error),
      nextAction: (error && error.nextAction) || 'resolve a valid base/scope file set before starting workflow'
    };
  }

  let ledgerPath;
  try {
    ledgerPath = parsed.invocation.ledger
      ? validateLedgerPath({ projectRoot, targetKey, ledgerPath: parsed.invocation.ledger })
      : path.join(targetStateDir, 'ISSUES.md');
    validatePersistentStartStatePaths({ projectRoot, targetStateDir, manifestPath, ledgerPath });
  } catch (error) {
    return failStartStateValidation(base, {
      targetStateDir,
      manifestPath,
      message: error && error.message ? error.message : String(error)
    });
  }

  // No silent resume: a fresh start with existing state is refused (reuse requires the explicit
  // `resume` token, dispatched before reaching here) unless `reset` archives the prior state.
  const archivedStatePath = ensureFreshStartState({
    targetStateDir,
    manifestPath,
    reset: parsed.invocation.reset,
    options
  });
  const ledgerRelativePath = path.relative(projectRoot, ledgerPath).split(path.sep).join('/');
  const now = (options.now || new Date()).toISOString();

  // PLAN-TASK-003: whole-root over-cap → partitioned project review. Mirror the normal
  // file-set start preamble above (rules, ledger validation, persistent-path validation,
  // reset/archive, ISSUES.md), then write a CODE checkpoint manifest + the project-review/
  // plan files (inventory.jsonl + units.json) and return partitioned-review. The checkpoint
  // is a PLAN, never a PASS. fileSetFingerprint is the contentId projectReviewFingerprint
  // (D-C), carried verbatim — the same drift token Task 6 resume will recompute and compare.
  if (partitionPlan) {
    const reviewPlanPath = writeProjectReviewPlan(targetStateDir, partitionPlan);
    const checkpointManifest = {
      manifestSchema: 2,
      targetContextKind: 'code',
      target: 'none',
      normalizedTarget: 'none',
      documentType: 'none',
      strictness: parsed.invocation.strictness || 'normal',
      mode: parsed.invocation.mode,
      guardMode,
      targetKey,
      ledgerPath: ledgerRelativePath,
      status: 'checkpoint',
      currentPhase: 'review',
      currentRound: 1,
      roundLimit: parsed.invocation.roundLimit === null || parsed.invocation.roundLimit === undefined
        ? 'none'
        : String(parsed.invocation.roundLimit),
      assurance: parsed.assurance,
      runtimePlatform: parsed.runtimePlatform,
      descriptorPlatform: base.descriptorPlatform,
      assuranceProof: base.assuranceProof,
      runtimeSubagentProbe: parsed.runtimeCheck.subagentProbe.status,
      runtimeSubagentProbeEvidence: parsed.runtimeCheck.subagentProbe.evidence,
      runtimeFingerprintGuard: 'not-run',
      runtimeStdinHandoff: parsed.runtimeCheck.stdinHandoff.status,
      runtimeStdinHandoffEvidence: parsed.runtimeCheck.stdinHandoff.evidence,
      runtimeDowngradeReason: parsed.runtimeCheck.downgradeReason,
      blockingReason: 'none',
      statusReason: 'checkpoint-requested',
      currentReportPath: 'none',
      lastReviewerReportPath: 'none',
      lastTriageReportPath: 'none',
      lastFixReportPath: 'none',
      fixAttemptCount: 0,
      lastDiffReviewReportPath: 'none',
      fileSetFingerprint: partitionPlan.projectReviewFingerprint,
      // Whole-root partition has no narrowing scope. exclusions mirror the resolver's
      // built-in exclusion list (sorted) so the checkpoint manifest carries the same CODE
      // identity shape as a normal CODE start. userExcludes carries the ordered .drfxignore
      // pattern digests (never raw text) so resume detects a rule-only change that does not
      // move the content fingerprint (a git-ignored .drfxignore edit).
      normalizedScopes: [],
      exclusions: codeExcludedDirectoryEntries(),
      userExcludes: Array.isArray(partitionPlan.userExcludes) ? partitionPlan.userExcludes : [],
      references: [],
      lastModifiedAt: now,
      createdAt: now,
      updatedAt: now
    };
    atomicWriteFile(ledgerPath, formatLedger({ issues: [] }));
    atomicWriteFile(manifestPath, formatManifestV2(checkpointManifest));
    return {
      ...base,
      status: 'partitioned-review',
      reviewMode: 'partitioned',
      guardMode,
      targetStateDir,
      manifestPath,
      ledgerPath,
      round: 1,
      currentPhase: 'review',
      reviewPlanPath,
      unitCount: partitionPlan.units.length,
      fileSetFingerprint: partitionPlan.projectReviewFingerprint,
      ...(archivedStatePath ? { archivedStatePath } : {}),
      runtimeCheck: {
        ...base.runtimeCheck,
        fingerprintGuard: { status: 'not-run' }
      },
      warnings: base.warnings || [],
      blockingReason: 'none',
      statusReason: 'checkpoint-requested',
      nextAction: 'run workflow context review-fix-code review-and-fix --phase unit-review --unit unit-001'
    };
  }

  // Code routes do review-and-fix with a materialized assurance; the manifest pairing
  // rules reject advisory + review-and-fix, so file-set review-and-fix must persist
  // practical/strict-verified (never advisory). The dispatcher already rejected advisory
  // review-and-fix as unsupported before reaching start, so parsed.assurance is materialized here.
  const commonManifest = {
    manifestSchema: 2,
    targetContextKind: routeKind,
    target: 'none',
    normalizedTarget: 'none',
    documentType: 'none',
    // PR/CODE parsers carry no strictness token (document-only); the manifest schema
    // requires the field, so file-set routes pin it to the default 'normal'.
    strictness: parsed.invocation.strictness || 'normal',
    mode: parsed.invocation.mode,
    guardMode,
    targetKey,
    ledgerPath: ledgerRelativePath,
    status: 'review',
    currentPhase: 'review',
    currentRound: 1,
    roundLimit: parsed.invocation.roundLimit === null || parsed.invocation.roundLimit === undefined
      ? 'none'
      : String(parsed.invocation.roundLimit),
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform,
    descriptorPlatform: base.descriptorPlatform,
    assuranceProof: base.assuranceProof,
    runtimeSubagentProbe: parsed.runtimeCheck.subagentProbe.status,
    runtimeSubagentProbeEvidence: parsed.runtimeCheck.subagentProbe.evidence,
    runtimeFingerprintGuard: 'not-run',
    runtimeStdinHandoff: parsed.runtimeCheck.stdinHandoff.status,
    runtimeStdinHandoffEvidence: parsed.runtimeCheck.stdinHandoff.evidence,
    runtimeDowngradeReason: parsed.runtimeCheck.downgradeReason,
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: 'none',
    lastReviewerReportPath: 'none',
    lastTriageReportPath: 'none',
    lastFixReportPath: 'none',
    fixAttemptCount: 0,
    lastDiffReviewReportPath: 'none',
    references: [],
    createdAt: now,
    updatedAt: now,
    lastModifiedAt: now
  };

  let manifest;
  if (routeKind === 'pr') {
    manifest = {
      ...commonManifest,
      base: identity.base,
      baseRevision: identity.baseRevision,
      mergeBase: identity.mergeBase,
      head: identity.head,
      fileSetFingerprint: identity.fileSetFingerprint
    };
  } else if (routeKind === 'r2p') {
    // r2p identity: a relative requirement directory, the protected run.md sha256,
    // and the editable 03–07 fingerprint. No PR base/head, no CODE scope list.
    manifest = {
      ...commonManifest,
      requirementDir: identity.requirementDir,
      runMdSha256: identity.runMdSha256,
      fileSetFingerprint: identity.fileSetFingerprint
    };
  } else {
    manifest = {
      ...commonManifest,
      fileSetFingerprint: identity.fileSetFingerprint,
      normalizedScopes: identity.normalizedScopes,
      exclusions: identity.exclusions,
      userExcludes: identity.userExcludes
    };
  }

  atomicWriteFile(ledgerPath, formatLedger({ issues: [] }));
  atomicWriteFile(manifestPath, formatManifestV2(manifest));

  return {
    ...base,
    status: 'review',
    guardMode,
    targetStateDir,
    manifestPath,
    ledgerPath,
    round: 1,
    currentPhase: 'review',
    fileSetFingerprint: identity.fileSetFingerprint,
    fileSetFileCount: Array.isArray(context.files)
      ? context.files.length
      : (Array.isArray(context.editableFiles) ? context.editableFiles.length : 0),
    ...(Array.isArray(context.userExcludePatterns) && context.userExcludePatterns.length > 0
      ? { userExcludes: context.userExcludePatterns }
      : {}),
    ...(Array.isArray(context.scopeIgnoreOverrides) && context.scopeIgnoreOverrides.length > 0
      ? { scopeIgnoreOverrides: context.scopeIgnoreOverrides }
      : {}),
    ...(archivedStatePath ? { archivedStatePath } : {}),
    runtimeCheck: {
      ...base.runtimeCheck,
      fingerprintGuard: { status: 'not-run' }
    },
    warnings: base.warnings || [],
    nextAction: 'run workflow context for initial review'
  };
}

function runPersistentStart(parsed, options) {
  if (isFileSetRoute(parsed)) {
    return runFileSetStart(parsed, options);
  }
  const projectRoot = resolveProjectRoot({
    explicitRoot: parsed.invocation.root,
    targetPath: parsed.invocation.target,
    cwd: options.cwd || process.cwd(),
    persistentStateRequired: true
  });
  const targetMetadata = deriveTargetKey(projectRoot, parsed.invocation.target);
  const targetStateDir = targetStateDirectory(projectRoot, targetMetadata.targetKey);
  const manifestPath = path.join(targetStateDir, 'MANIFEST.md');
  const base = workflowBase(parsed, { ...options, cwd: projectRoot });
  if ((parsed.invocation.guardMode || 'git') === 'git' && !hasGitGuard(projectRoot)) {
    return {
      ...base,
      ok: false,
      status: 'unsupported',
      targetStateDir: null,
      manifestPath: null,
      ledgerPath: null,
      round: null,
      currentPhase: 'review',
      blockingReason: 'none',
      statusReason: 'git-guard-unavailable',
      nextAction: 'pass guard=snapshot to use file snapshot rollback'
    };
  }
  try {
    const mergedRules = loadMergedRules({
      projectRoot,
      documentType: parsed.invocation.documentType,
      strictness: parsed.invocation.strictness,
      homeDir: options.homeDir || null
    });
    base.warnings = mergedRules.warnings || [];
  } catch (error) {
    return failStartStateValidation(base, {
      targetStateDir,
      manifestPath,
      message: `rulebook validation failed: ${error && error.message ? error.message : String(error)}`,
      nextAction: 'repair rulebook before starting workflow'
    });
  }

  const targetPath = path.resolve(projectRoot, targetMetadata.normalizedTarget);
  const targetFingerprint = computeFingerprint(targetPath);
  const referenceRecords = normalizeReferences({
    projectRoot,
    references: parsed.invocation.refs,
    targetPath: parsed.invocation.target
  });
  const references = referenceRecords.map((reference) => normalizedReferencePath(reference, projectRoot));
  let ledgerPath;
  try {
    ledgerPath = parsed.invocation.ledger
      ? validateLedgerPath({
        projectRoot,
        targetKey: targetMetadata.targetKey,
        ledgerPath: parsed.invocation.ledger
      })
      : path.join(targetStateDir, 'ISSUES.md');
    validatePersistentStartStatePaths({ projectRoot, targetStateDir, manifestPath, ledgerPath });
  } catch (error) {
    return failStartStateValidation(base, {
      targetStateDir,
      manifestPath,
      message: error && error.message ? error.message : String(error)
    });
  }
  const archivedStatePath = ensureFreshStartState({
    targetStateDir,
    manifestPath,
    reset: parsed.invocation.reset,
    options
  });
  const ledgerRelativePath = path.relative(projectRoot, ledgerPath).split(path.sep).join('/');

  const now = (options.now || new Date()).toISOString();
  const manifest = {
    manifestSchema: 2,
    target: targetPath,
    normalizedTarget: targetMetadata.normalizedTarget,
    documentType: parsed.invocation.documentType,
    strictness: parsed.invocation.strictness,
    mode: parsed.invocation.mode,
    guardMode: parsed.invocation.guardMode || 'git',
    targetKey: targetMetadata.targetKey,
    ledgerPath: ledgerRelativePath,
    status: 'review',
    currentPhase: 'review',
    currentRound: 1,
    // roundLimit (PLAN-TASK-005) is the validated `rounds=<n>` loop maximum from
    // the parser, carried as durable workflow metadata. It is NOT currentRound and
    // is enforced only as a MAXIMUM at the loop boundary. Absent ⇒ 'none' (no line).
    roundLimit: parsed.invocation.roundLimit === null || parsed.invocation.roundLimit === undefined
      ? 'none'
      : String(parsed.invocation.roundLimit),
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform,
    descriptorPlatform: base.descriptorPlatform,
    assuranceProof: base.assuranceProof,
    runtimeSubagentProbe: parsed.runtimeCheck.subagentProbe.status,
    runtimeSubagentProbeEvidence: parsed.runtimeCheck.subagentProbe.evidence,
    runtimeFingerprintGuard: 'not-run',
    runtimeStdinHandoff: parsed.runtimeCheck.stdinHandoff.status,
    runtimeStdinHandoffEvidence: parsed.runtimeCheck.stdinHandoff.evidence,
    runtimeDowngradeReason: parsed.runtimeCheck.downgradeReason,
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: 'none',
    lastReviewerReportPath: 'none',
    lastTriageReportPath: 'none',
    lastFixReportPath: 'none',
    fixAttemptCount: 0,
    lastDiffReviewReportPath: 'none',
    initialContentSha256: targetFingerprint.sha256,
    lastKnownContentSha256: targetFingerprint.sha256,
    lastReviewedContentSha256: 'none',
    lastPassedContentSha256: 'none',
    lastModifiedAt: new Date(targetFingerprint.mtimeMs).toISOString(),
    fileSize: targetFingerprint.size,
    references,
    createdAt: now,
    updatedAt: now
  };

  atomicWriteFile(ledgerPath, formatLedger({ issues: [] }));
  atomicWriteFile(manifestPath, formatManifestV2(manifest));

  return {
    ...base,
    status: 'review',
    guardMode: parsed.invocation.guardMode || 'git',
    targetStateDir,
    manifestPath,
    ledgerPath,
    round: 1,
    currentPhase: 'review',
    ...(archivedStatePath ? { archivedStatePath } : {}),
    runtimeCheck: {
      ...base.runtimeCheck,
      fingerprintGuard: { status: 'not-run' }
    },
    warnings: base.warnings || [],
    nextAction: 'run workflow context for initial review'
  };
}

module.exports = {
  runPersistentStart
};
