'use strict';

const childProcess = require('node:child_process');

const {
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

function runPersistentStart(parsed, options) {
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
  if (fs.existsSync(manifestPath)) {
    fail('ERR_STATE_EXISTS', 'persistent workflow state already exists; use resume');
  }
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
