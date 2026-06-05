'use strict';

// PLAN-TASK-009 (Phase C): live file-set resolution + reviewer/fixer context for the
// PR/CODE persistent lifecycle. This is the file-set analog of persistent-context.js. It
// re-resolves the live file set from the durable manifest identity (PR base / CODE scopes)
// using the PLAN-TASK-003/004 read-only resolvers, builds a reviewer context-pack that
// describes the file SET (not a single document body), and records review/triage exactly
// like the document path but with file-set identity and the round-limit gate intact.
//
// SAFETY: the resolvers are read-only (no git fetch/push/ref mutation, no writes). The
// reviewer subagent stays read-only; PASS requires a full re-review and is never claimed
// from read-only/advisory/diff-review-only/unverified.

const {
  acceptedNonBlockingLowIssueIdsFromLedger,
  applyTriageDecisions,
  atomicWriteFile,
  blockPersistentReviewerMutation,
  computeFileSetFingerprint,
  crypto,
  describeCodeBlock,
  enrichTriageDecisions,
  fail,
  failStateValidation,
  formatLedger,
  isStateValidationError,
  loadRouteRuleContext,
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
  resolveCodeTarget,
  resolveFileSetPersistentMetadata,
  resolveTargetContext,
  statePathFromManifest,
  stateRelativePath,
  targetStatePathFromManifest,
  triageOutcome,
  updatePersistentManifest,
  writeContextManifest,
  writeReviewerReport,
  writeTriageReport,
  blockPersistentStateValidation,
  buildCodeIdentity,
  contextManifestPathFor,
  buildFileSetContextPack,
  buildFileSetFixerGuard,
  buildPrIdentity,
  contextPhase,
  stableJson
} = require('./helpers');

const fsExtra = require('node:fs');

function readBuiltInRubric(routeKind) {
  // The route-kind rubric is the built-in layer for the no-COMMON 4-layer stack. A missing
  // rubric file yields an empty built-in layer (custom layers still load), never a throw.
  const rubricPath = path.join(__dirname, '..', '..', 'shared', 'rubrics', `${routeKind}.md`);
  try {
    return fsExtra.readFileSync(rubricPath, 'utf8');
  } catch {
    return '';
  }
}

function loadFileSetRules(metadata, options) {
  const ruleContext = loadRouteRuleContext({
    routeKind: metadata.routeKind,
    builtInRubric: readBuiltInRubric(metadata.routeKind),
    homeDir: options.homeDir,
    projectRoot: metadata.projectRoot
  });
  const layers = Array.isArray(ruleContext.layers) ? ruleContext.layers : [];
  return {
    // The reviewer rule set is the concatenation of the ordered route layers (no COMMON
    // layer). context-pack redacts this before persisting.
    text: layers.map((layer) => layer.text).filter(Boolean).join('\n\n'),
    layers,
    sources: layers.map((layer) => layer.source),
    warnings: Array.isArray(ruleContext.warnings) ? ruleContext.warnings : []
  };
}

function normalizeFileSetBaselinePath(projectRoot, entry) {
  const raw = typeof entry === 'string' ? entry : (entry && entry.path);
  if (typeof raw !== 'string' || raw.trim() === '') {
    failStateValidation('file-set member path must be a non-empty path');
  }
  if (raw.includes('\0')) failStateValidation('file-set member path must not contain null bytes');
  if (path.win32.isAbsolute(raw)) failStateValidation(`file-set member path must be project-relative: ${raw}`);
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    failStateValidation(`file-set member path must be inside project root: ${raw}`);
  }
  return relative.split(path.sep).join('/');
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileSetMemberFingerprint(projectRoot, relativePath) {
  const absolute = path.resolve(projectRoot, relativePath);
  let stats;
  try {
    stats = fsExtra.lstatSync(absolute);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { kind: 'missing', sha256: 'none', size: 0, mtimeMs: 0 };
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const linkTarget = fsExtra.readlinkSync(absolute);
    return {
      kind: 'symlink',
      sha256: sha256Buffer(Buffer.from(linkTarget)),
      size: Buffer.byteLength(linkTarget),
      mtimeMs: stats.mtimeMs
    };
  }
  if (!stats.isFile()) {
    return {
      kind: stats.isDirectory() ? 'directory' : 'other',
      sha256: 'none',
      size: stats.size,
      mtimeMs: stats.mtimeMs
    };
  }
  return {
    kind: 'file',
    sha256: sha256Buffer(fsExtra.readFileSync(absolute)),
    size: stats.size,
    mtimeMs: stats.mtimeMs
  };
}

function buildFileSetReviewerGuardBaseline({ projectRoot, liveFileSet }) {
  const files = (Array.isArray(liveFileSet.files) ? liveFileSet.files : [])
    .map((entry) => {
      const relativePath = normalizeFileSetBaselinePath(projectRoot, entry);
      return {
        path: relativePath,
        status: String((entry && entry.status) || 'present'),
        contentId: String((entry && entry.contentId) || 'none'),
        ...fileSetMemberFingerprint(projectRoot, relativePath)
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    kind: 'file-set',
    routeKind: liveFileSet.routeKind,
    fileSetFingerprint: computeFileSetFingerprint(liveFileSet.files),
    files
  };
}

function compareFileSetReviewerBaseline(contextPack, actualBaseline) {
  const expected = contextPack.reviewerGuardBaseline || null;
  if (!expected || expected.kind !== 'file-set') return 'reviewer-mutated-file';
  if (String(expected.fileSetFingerprint) !== String(actualBaseline.fileSetFingerprint)) {
    return 'reviewer-mutated-file';
  }
  if (stableJson(expected.files || []) !== stableJson(actualBaseline.files || [])) {
    return 'reviewer-mutated-file';
  }
  return null;
}

// Re-resolve the LIVE file set from the durable manifest identity. PR routes re-run the
// read-only local git diff from the stored base; CODE routes re-walk the stored scopes.
// This is read-only and never mutates refs or the working tree.
async function resolveLiveFileSet(metadata, options) {
  if (metadata.routeKind === 'pr') {
    const context = await resolveTargetContext({
      routeName: 'review-fix-pr',
      base: metadata.manifest.base,
      cwd: metadata.projectRoot,
      commandLog: options.commandLog
    });
    return {
      routeKind: 'pr',
      base: context.base,
      baseRevision: context.baseRevision,
      mergeBase: context.mergeBase,
      head: context.head,
      files: context.files
    };
  }
  const context = await resolveCodeTarget({
    cwd: metadata.projectRoot,
    scopes: metadata.manifest.normalizedScopes || []
  });
  if (context && context.status === 'blocked') {
    fail('ERR_FILE_SET_RESOLVE', describeCodeBlock(context).message);
  }
  return {
    routeKind: 'code',
    normalizedScopes: context.normalizedScopes,
    exclusions: context.exclusions,
    userExcludes: context.userExcludes,
    userExcludePatterns: context.userExcludePatterns,
    scopeIgnoreOverrides: context.scopeIgnoreOverrides,
    versionIgnoreSource: context.versionIgnoreSource,
    files: context.files
  };
}

function isFileSetResolveError(error) {
  return error && error.code === 'ERR_FILE_SET_RESOLVE';
}

function blockFileSetResolve(parsed, metadata, error) {
  return persistentBase(parsed, metadata, {
    ok: false,
    status: 'blocked',
    errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
    message: error && error.message ? error.message : String(error),
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    nextAction: 'resolve a valid base/scope file set before continuing'
  });
}

function manifestIdentityInput(manifest) {
  return {
    guardMode: manifest.guardMode || 'git',
    roundLimit: manifest.roundLimit === 'none' || manifest.roundLimit === undefined
      ? null
      : manifest.roundLimit
  };
}

function reviewedIdentityManifestUpdates(metadata, liveFileSet) {
  const identityInput = manifestIdentityInput(metadata.manifest);
  if (metadata.routeKind === 'pr') {
    const identity = buildPrIdentity({
      context: liveFileSet,
      guardMode: identityInput.guardMode,
      roundLimit: identityInput.roundLimit
    });
    return {
      base: identity.base,
      baseRevision: identity.baseRevision,
      mergeBase: identity.mergeBase,
      head: identity.head,
      fileSetFingerprint: identity.fileSetFingerprint
    };
  }
  const identity = buildCodeIdentity({
    context: liveFileSet,
    guardMode: identityInput.guardMode,
    roundLimit: identityInput.roundLimit
  });
  return {
    normalizedScopes: identity.normalizedScopes,
    exclusions: identity.exclusions,
    userExcludes: identity.userExcludes,
    fileSetFingerprint: identity.fileSetFingerprint
  };
}

async function runFileSetContext(parsed, options) {
  const metadata = resolveFileSetPersistentMetadata(parsed, options);
  try {
    const phase = contextPhase(parsed, metadata.manifest);
    const round = Number(metadata.manifest.currentRound || 1);
    const ledgerPath = statePathFromManifest(
      metadata.projectRoot,
      metadata.targetStateDir,
      metadata.targetKey,
      metadata.manifest.ledgerPath,
      'ISSUES.md'
    );
    const ledger = readLedgerIfPresent(ledgerPath);
    const rules = loadFileSetRules(metadata, options);
    const liveFileSet = await resolveLiveFileSet(metadata, options);

    // The stored fileSetFingerprint is the last reviewed identity (captured at start, then
    // refreshed by each recorded review). If the live set has drifted since, surface it as the
    // context-pack changedSinceLastReview so the reviewer sees the current set, but identity-level
    // staleness for resume is handled by resume's strict identity compare, not here.
    const liveFingerprint = computeFileSetFingerprint(liveFileSet.files);
    const fixerGuard = phase === 'fix'
      ? buildFileSetFixerGuard({ metadata, ledger, liveFileSet, round })
      : null;
    const contextPack = buildFileSetContextPack({
      routeKind: metadata.routeKind,
      fileSet: liveFileSet,
      strictness: metadata.manifest.strictness,
      mode: metadata.manifest.mode,
      assurance: metadata.manifest.assurance,
      runtimePlatform: metadata.manifest.runtimePlatform,
      phase,
      round,
      mergedRules: rules,
      acceptedNonBlockingLowIssueIds: acceptedNonBlockingLowIssueIdsFromLedger(ledger),
      changedSinceLastReview: liveFingerprint !== metadata.manifest.fileSetFingerprint
        ? { fileSetFingerprintChanged: true }
        : null,
      requiredOutputSchema: requiredSchemaForPhase(phase),
      reviewerGuardBaseline: phase === 'fix'
        ? null
        : buildFileSetReviewerGuardBaseline({ projectRoot: metadata.projectRoot, liveFileSet }),
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
      warnings: rules.warnings || [],
      contextManifestPath,
      contextPackSkeleton: contextPack,
      fileSetFingerprint: liveFingerprint,
      runtimeCheck: {
        ...parsed.runtimeCheck,
        fingerprintGuard: { status: 'passed' }
      }
    });
  } catch (error) {
    if (isFileSetResolveError(error)) return blockFileSetResolve(parsed, metadata, error);
    if (isStateValidationError(error)) return blockPersistentStateValidation(parsed, metadata, error);
    throw error;
  }
}

async function runFileSetRecordReview(parsed, options) {
  const metadata = resolveFileSetPersistentMetadata(parsed, options);
  try {
    const phase = contextPhase(parsed, metadata.manifest);
    const contextManifestPath = contextManifestPathFor(metadata.targetStateDir, phase);
    const contextPack = readContextManifest(contextManifestPath);
    const liveFileSet = await resolveLiveFileSet(metadata, options);
    const actualBaseline = buildFileSetReviewerGuardBaseline({ projectRoot: metadata.projectRoot, liveFileSet });
    const mutation = compareFileSetReviewerBaseline(contextPack, actualBaseline);
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
    writeReviewerReport({ reportPath, phase, round, producer, reviewerResult });
    const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
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
      runtimeFingerprintGuard: 'passed',
      ...reviewedIdentityManifestUpdates(metadata, liveFileSet)
    });
    return persistentBase(parsed, metadata, {
      ok: true,
      status: 'recorded-review',
      contextManifestPath,
      reviewerReportPath: reportPath,
      normalized: reviewerResult
    });
  } catch (error) {
    if (isFileSetResolveError(error)) return blockFileSetResolve(parsed, metadata, error);
    if (isStateValidationError(error)) return blockPersistentStateValidation(parsed, metadata, error);
    throw error;
  }
}

async function runFileSetRecordTriage(parsed, options) {
  const metadata = resolveFileSetPersistentMetadata(parsed, options);
  const phase = parsed.phase || 'initial-review';
  const round = Number(metadata.manifest.currentRound || 1);
  let reviewerReportPath;
  let ledgerPath;
  try {
    const contextManifestPath = contextManifestPathFor(metadata.targetStateDir, phase);
    const contextPack = readContextManifest(contextManifestPath);
    const liveFileSet = await resolveLiveFileSet(metadata, options);
    const actualBaseline = buildFileSetReviewerGuardBaseline({ projectRoot: metadata.projectRoot, liveFileSet });
    const mutation = compareFileSetReviewerBaseline(contextPack, actualBaseline);
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
    if (isFileSetResolveError(error)) return blockFileSetResolve(parsed, metadata, error);
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
  let ledger = applyTriageDecisions(readLedgerIfPresent(ledgerPath), enrichedDecisions);

  const baseName = `triage-round-${padRound(round)}`;
  const reportPath = nextReportPath(metadata.targetStateDir, baseName);
  writeTriageReport({
    reportPath,
    phase,
    round,
    triage: { decisions: enrichedDecisions, warnings: triage.warnings },
    ledger
  });
  const roundLimit = metadata.manifest.roundLimit || 'none';
  const outcome = triageOutcome({
    decisions: enrichedDecisions,
    mode: metadata.manifest.mode,
    strictness: metadata.manifest.strictness,
    roundLimit,
    roundsCompleted: Number(metadata.manifest.fixAttemptCount || 0)
  });
  const stoppedByRoundLimit = outcome.statusReason === 'round-limit';
  if (stoppedByRoundLimit) {
    ledger = deferRoundLimitedFindings(ledger, Number(roundLimit));
  }
  atomicWriteFile(ledgerPath, formatLedger(ledger));
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
    normalized: { decisions: enrichedDecisions, warnings: triage.warnings },
    stopReason: stoppedByRoundLimit ? 'round-limit' : 'none',
    roundLimit: roundLimit === 'none' ? null : Number(roundLimit)
  });
}

// Mirror of persistent-context.js deferRoundLimitedFindings (file-set routes share the
// identical deferral contract: round-limited blocking findings are deferred, never dropped,
// never a clean pass).
function deferRoundLimitedFindings(ledger, roundLimit) {
  const reason = `Round limit reached (rounds=${roundLimit}); deferred for manual follow-up`;
  return {
    issues: (ledger.issues || []).map((issue) => {
      const blocking = ['accepted', 'reopened'].includes(issue.status) &&
        ['high', 'medium'].includes(issue.severity);
      if (!blocking) return issue;
      return { ...issue, status: 'deferred', resolution: `Deferred: ${reason}; owner: none` };
    })
  };
}

module.exports = {
  resolveLiveFileSet,
  runFileSetContext,
  runFileSetRecordReview,
  runFileSetRecordTriage
};
