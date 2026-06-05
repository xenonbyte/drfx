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
  describeCodeBlock,
  buildPrIdentity,
  buildCodeIdentity
} = require('../target-context');
const { loadRouteRuleContext } = require('../rulebook');

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
  const projectRoot = resolveFileSetProjectRoot(parsed, options);
  const targetMetadata = resolveRouteTargetMetadata(parsed, { ...options, cwd: projectRoot });
  const routeKind = targetMetadata.routeKind;
  const targetKey = targetMetadata.targetKey;
  const targetStateDir = targetStateDirectory(projectRoot, targetKey);
  const manifestPath = path.join(targetStateDir, 'MANIFEST.md');
  const base = workflowBase(parsed, { ...options, cwd: projectRoot });
  const guardMode = parsed.invocation.guardMode || 'git';

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
  // rule-file warnings without failing start when no custom rule files exist.
  try {
    const ruleContext = loadRouteRuleContext({
      routeKind,
      builtInRubric: '',
      homeDir: options.homeDir,
      projectRoot
    });
    base.warnings = Array.isArray(ruleContext.warnings) ? ruleContext.warnings : [];
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
  try {
    if (routeKind === 'pr') {
      context = await resolveTargetContext({
        routeName: 'review-fix-pr',
        base: parsed.invocation.base,
        cwd: projectRoot,
        commandLog: options.commandLog
      });
      identity = buildPrIdentity({ context, guardMode, roundLimit: parsed.invocation.roundLimit });
    } else {
      context = await resolveCodeTarget({ cwd: projectRoot, scopes: parsed.invocation.scopes || [] });
      if (context && context.status === 'blocked') {
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
      identity = buildCodeIdentity({ context, guardMode, roundLimit: parsed.invocation.roundLimit });
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
      blockingReason: 'state-validation-failed',
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
      message: error && error.message ? error.message : String(error),
      nextAction: 'resolve a valid base/scope file set before starting workflow'
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

  const manifest = routeKind === 'pr'
    ? {
      ...commonManifest,
      base: identity.base,
      baseRevision: identity.baseRevision,
      mergeBase: identity.mergeBase,
      head: identity.head,
      fileSetFingerprint: identity.fileSetFingerprint
    }
    : {
      ...commonManifest,
      fileSetFingerprint: identity.fileSetFingerprint,
      normalizedScopes: identity.normalizedScopes,
      exclusions: identity.exclusions,
      userExcludes: identity.userExcludes
    };

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
    fileSetFileCount: Array.isArray(context.files) ? context.files.length : 0,
    ...(Array.isArray(context.userExcludes) && context.userExcludes.length > 0
      ? { userExcludes: context.userExcludes }
      : {}),
    ...(Array.isArray(context.overriddenUserExcludes) && context.overriddenUserExcludes.length > 0
      ? { overriddenUserExcludes: context.overriddenUserExcludes }
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
