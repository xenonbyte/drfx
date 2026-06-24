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
  failStateValidation,
  formatLedger,
  isStateValidationError,
  loadMergedRules,
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
  resolveR2qTarget,
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
  buildR2qIdentity,
  contextManifestPathFor,
  buildFileSetContextPack,
  buildFileSetFixerGuard,
  buildPrIdentity,
  contextPhase,
  stableJson
} = require('./helpers');
const { resolveCodeInventory } = require('../target-context');
const {
  partitionInventory,
  suggestRefsFor,
  CROSSCUTTING_BACKSTOPS,
  MAX_UNIT_BYTES,
  computeOversizeChunks,
  formatUnitId,
  CHUNK_LINES,
  CHUNK_OVERLAP_LINES,
} = require('../project-review');
const { validateTargetStateOwnedPath } = require('../target-state');
const {
  activePartitionedPlanFreshness,
  liveFileSetFingerprint
} = require('./file-set-partitioned-live');

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
  // r2q is a DOCUMENT-rubric (PLAN) route: it merges the COMMON+PLAN document rule
  // stack via loadMergedRules, NOT the self-contained PR/CODE route-rubric stack
  // (loadRouteRuleContext rejects 'r2q' as an unknown route kind). PR/CODE keep the
  // route-kind rule stack below.
  if (metadata.routeKind === 'r2q') {
    const merged = loadMergedRules({
      projectRoot: metadata.projectRoot,
      documentType: 'PLAN',
      strictness: metadata.manifest.strictness || 'normal',
      homeDir: options.homeDir || null
    });
    return {
      text: merged.text,
      layers: merged.layers,
      sources: merged.sources,
      warnings: Array.isArray(merged.warnings) ? merged.warnings : []
    };
  }
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

const MAX_CHUNKABLE_OVERSIZE_CHUNKS = 8;

function chunkableOversizeByteCap(chunkByteBudget) {
  const budget = Number.isFinite(chunkByteBudget) && chunkByteBudget > 0
    ? chunkByteBudget
    : MAX_UNIT_BYTES;
  return budget * MAX_CHUNKABLE_OVERSIZE_CHUNKS;
}

// Expand ONE oversize text file into deterministic chunk-as-sub-units. IO lives here
// (reads the in-root file body once). Returns null to keep the legacy oversize blocker
// when the file is too large to safely materialize, is not UTF-8 text, cannot be read,
// would exceed the chunk-count cap, or is unsplittable (single huge line).
function splitOversizeFile({ projectRoot, file, chunkLines, overlapLines, chunkByteBudget } = {}) {
  let text;
  try {
    const absolutePath = path.join(projectRoot, file.path);
    const maxChunkableBytes = chunkableOversizeByteCap(chunkByteBudget);
    const stats = fsExtra.statSync(absolutePath);
    if (!stats.isFile() || stats.size > maxChunkableBytes) return null;

    const buf = fsExtra.readFileSync(absolutePath);
    // Reject binary/non-UTF-8: round-trip and compare, and reject NUL bytes.
    if (buf.includes(0)) return null;
    text = buf.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') !== buf.length) return null;
  } catch {
    return null;
  }
  const chunks = computeOversizeChunks({
    text,
    chunkLines,
    overlapLines,
    chunkByteBudget,
    maxChunks: MAX_CHUNKABLE_OVERSIZE_CHUNKS,
  });
  if (!chunks) return null;
  // computeOversizeChunks already enforced maxChunks (returns null past the cap),
  // so chunks.length <= MAX_CHUNKABLE_OVERSIZE_CHUNKS here.
  const chunkCount = chunks.length;
  return chunks.map((chunk, index) => {
    const chunkContentId = sha256Buffer(chunk.sliceText);
    const member = {
      path: file.path,
      primaryLineRange: chunk.primaryLineRange,
      contextLineRange: chunk.contextLineRange,
      size: chunk.byteLength,
      contentId: chunkContentId,
    };
    return {
      unit_id: null, // assigned by assemblePartitionPlan
      oversize_chunk: true,
      sourcePath: file.path,
      sourceContentId: file.contentId,
      files: [member],
      chunkIndex: index,
      chunkCount,
      member_count: 1,
      member_bytes: chunk.byteLength,
      member_digest: sha256Buffer(chunkContentId),
      suggestedRefs: [],
    };
  });
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

function protectedDependencyFingerprints(projectRoot, protectedDependencies = []) {
  return (Array.isArray(protectedDependencies) ? protectedDependencies : [])
    .map((entry) => {
      const relativePath = normalizeFileSetBaselinePath(projectRoot, entry);
      return {
        path: relativePath,
        readOnly: entry && entry.readOnly !== false,
        contentId: String((entry && entry.sha256) || (entry && entry.contentId) || 'none'),
        ...fileSetMemberFingerprint(projectRoot, relativePath)
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
  const protectedDependencies = protectedDependencyFingerprints(projectRoot, liveFileSet.protectedDependencies);
  const baseline = {
    kind: 'file-set',
    routeKind: liveFileSet.routeKind,
    fileSetFingerprint: computeFileSetFingerprint(liveFileSet.files),
    files
  };
  if (protectedDependencies.length > 0) baseline.protectedDependencies = protectedDependencies;
  return baseline;
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
  if (stableJson(expected.protectedDependencies || []) !== stableJson(actualBaseline.protectedDependencies || [])) {
    return 'reviewer-mutated-file';
  }
  return null;
}

async function partitionedAggregateTriageReady(metadata, options) {
  if (metadata.manifest.status !== 'triage') return false;
  const lastReport = String(metadata.manifest.lastReviewerReportPath || '');
  if (!lastReport.startsWith('reports/aggregate-review-round-')) return false;
  const freshness = await activePartitionedPlanFreshness(metadata, options);
  if (!freshness) return false;
  if (freshness.stale) {
    failStateValidation('partitioned aggregate triage plan is stale; rerun partitioned project review before triage');
  }
  return true;
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
  if (metadata.routeKind === 'r2q') {
    // r2q re-resolves the requirement directory (run.md gate + 03–07 chain) from the
    // stored relative requirementDir — NOT a CODE scope walk. The editable file set is
    // EXACTLY the 03–07 docs; run.md is carried separately as a PROTECTED read-only
    // dependency (its sha256 enters the identity/manifest, never the editable set).
    const requirementTarget = path.resolve(metadata.projectRoot, metadata.manifest.requirementDir);
    const context = resolveR2qTarget({
      cwd: metadata.projectRoot,
      target: requirementTarget,
      commandLog: options.commandLog
    });
    return {
      routeKind: 'r2q',
      requirementDir: context.requirementDir,
      projectRoot: context.projectRoot,
      runMdPath: context.runMdPath,
      runMdSha256: context.runMdSha256,
      files: context.editableFiles.map((file) => ({
        path: path.relative(metadata.projectRoot, file.absolutePath).split(path.sep).join('/'),
        requirementRelativePath: file.relativePath,
        status: 'modified',
        contentId: file.sha256
      })),
      // run.md is read-only context the reviewer/fixer must respect but never edit.
      protectedDependencies: [{
        path: path.relative(metadata.projectRoot, context.runMdPath).split(path.sep).join('/'),
        readOnly: true,
        sha256: context.runMdSha256
      }]
    };
  }
  const context = await resolveCodeTarget({
    cwd: metadata.projectRoot,
    scopes: metadata.manifest.normalizedScopes || []
  });
  if (context && context.status === 'blocked') {
    const blocked = describeCodeBlock(context);
    const error = new Error(blocked.message);
    error.code = 'ERR_FILE_SET_RESOLVE';
    error.nextAction = blocked.nextAction;
    throw error;
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
  return error && (
    error.code === 'ERR_FILE_SET_RESOLVE' ||
    (typeof error.code === 'string' && error.code.startsWith('ERR_R2Q_'))
  );
}

function blockFileSetResolve(parsed, metadata, error) {
  const isR2qResolveError = error && typeof error.code === 'string' && error.code.startsWith('ERR_R2Q_');
  return persistentBase(parsed, metadata, {
    ok: false,
    status: 'blocked',
    errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
    message: error && error.message ? error.message : String(error),
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    nextAction: (error && error.nextAction) || (isR2qResolveError
      ? 'restore the r2q requirement directory before continuing'
      : 'resolve a valid base/scope file set before continuing')
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
  if (metadata.routeKind === 'r2q') {
    // r2q may re-anchor only the editable 03-07 fingerprint after review. run.md is a
    // protected gate captured at start, so keeping its original sha256 lets finalize
    // catch gate drift that happens before a later full-re-review context.
    const identity = buildR2qIdentity({
      context: {
        routeKind: 'r2q',
        projectRoot: liveFileSet.projectRoot,
        requirementDir: liveFileSet.requirementDir,
        runMdSha256: liveFileSet.runMdSha256,
        fileSetFingerprint: liveFileSetFingerprint(liveFileSet)
      },
      guardMode: identityInput.guardMode,
      roundLimit: identityInput.roundLimit
    });
    return {
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
    const liveFingerprint = liveFileSetFingerprint(liveFileSet);
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
      // r2q carries run.md as a protected read-only dependency; other file-set
      // routes have none, so the pack stays byte-identical (absent ⇒ omitted).
      protectedDependencies: Array.isArray(liveFileSet.protectedDependencies)
        ? liveFileSet.protectedDependencies
        : null,
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
    const skipContextGuard = await partitionedAggregateTriageReady(metadata, options);
    if (!skipContextGuard) {
      const contextManifestPath = contextManifestPathFor(metadata.targetStateDir, phase);
      const contextPack = readContextManifest(contextManifestPath);
      const liveFileSet = await resolveLiveFileSet(metadata, options);
      const actualBaseline = buildFileSetReviewerGuardBaseline({ projectRoot: metadata.projectRoot, liveFileSet });
      const mutation = compareFileSetReviewerBaseline(contextPack, actualBaseline);
      if (mutation) return blockPersistentReviewerMutation(parsed, metadata, mutation);
    }
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

// ---------------------------------------------------------------------------
// PLAN-TASK-003: partition-plan assembly + write (SPEC-DATA-001).
//
// D-B: lib/project-review.js stays PURE; the partition-plan ASSEMBLY (turning
// an uncapped inventory into units.json data) and the FS WRITE of the
// project-review/ plan files live in this workflow layer. assemblePartitionPlan
// returns DATA only (it reads member file bodies to fill suggestedRefs, but
// never touches .drfx) so the no-state path can assemble WITHOUT writing;
// writeProjectReviewPlan is the only function that writes under the target key.
// ---------------------------------------------------------------------------

const PROJECT_REVIEW_DIRNAME = 'project-review';

// JS/TS member bodies are read so suggestRefsFor can resolve in-root imports.
// Oversize-file units (oversize_file:true) never have their body read — their
// suggestedRefs stay [] — matching the project-review contract.
function readMemberTextForRefs(projectRoot, files) {
  return (Array.isArray(files) ? files : []).map((file) => {
    let text = '';
    try {
      text = fsExtra.readFileSync(path.join(projectRoot, file.path), 'utf8');
    } catch {
      text = '';
    }
    return { path: file.path, contentId: file.contentId, ext: file.ext, text };
  });
}

/**
 * Assemble a partition plan from an uncapped CODE inventory. PURE w.r.t. state:
 * reads member bodies from the working tree (to fill suggestedRefs) but writes
 * NOTHING. Returns the data the persistent writer and the no-state plan share.
 *
 * @param {object} input
 * @param {Array<{path,size,ext,contentId}>} input.inventory - uncapped inventory rows
 * @param {string} input.projectReviewFingerprint - the contentId drift token (D-C), carried verbatim
 * @param {string} input.projectRoot - project root for reading member bodies
 * @param {number} [input.unitByteBudget] - defaults to MAX_UNIT_BYTES
 * @returns {{ reviewMode:'partitioned', unitByteBudget:number,
 *   units:Array, crosscuttingBackstops:string[], projectReviewFingerprint:string,
 *   userExcludes:string[], inventoryRows:Array<{path,size,ext,contentId,unit_id}> }}
 */
function assemblePartitionPlan({ inventory, projectReviewFingerprint, userExcludes = [], projectRoot, unitByteBudget = MAX_UNIT_BYTES }) {
  const rawUnits = partitionInventory(inventory, { unitByteBudget });
  // inRootSet: every inventory path → contentId, for in-root import resolution.
  const inRootSet = new Map((Array.isArray(inventory) ? inventory : []).map((row) => [row.path, row.contentId]));

  // Expand oversize text files into chunk-units; keep legacy oversize blocker when
  // splitOversizeFile declines (binary / unsplittable). Then renumber unit_ids.
  const expanded = [];
  for (const unit of rawUnits) {
    if (unit.oversize_file === true) {
      const chunks = splitOversizeFile({
        projectRoot,
        file: unit.files[0],
        chunkLines: CHUNK_LINES,
        overlapLines: CHUNK_OVERLAP_LINES,
        chunkByteBudget: unitByteBudget,
      });
      if (chunks) { expanded.push(...chunks); continue; }
    }
    expanded.push(unit);
  }
  const units = expanded.map((unit, idx) => {
    const unit_id = formatUnitId(idx + 1);
    const files = unit.files.map((f) => ({ ...f, unit_id }));
    return { ...unit, unit_id, files };
  });

  for (const unit of units) {
    if (unit.oversize_chunk === true) continue;       // chunk refs stay []
    if (unit.oversize_file === true) { unit.suggestedRefs = []; continue; }
    const unitFiles = readMemberTextForRefs(projectRoot, unit.files);
    unit.suggestedRefs = suggestRefsFor(unitFiles, inRootSet);
  }

  // inventoryRows: FILE-LEVEL — one row per source path from the inventory (NOT
  // flattened from units, which would duplicate a chunked file's path). unit_id is
  // the owning unit; for a chunked file every chunk shares the sourcePath, so map it
  // to the first chunk's unit_id.
  const pathToUnit = new Map();
  for (const unit of units) {
    if (unit.oversize_chunk === true) {
      if (!pathToUnit.has(unit.sourcePath)) pathToUnit.set(unit.sourcePath, unit.unit_id);
      continue;
    }
    for (const file of unit.files) pathToUnit.set(file.path, unit.unit_id);
  }
  const inventoryRows = (Array.isArray(inventory) ? inventory : [])
    .map((row) => ({ path: row.path, size: row.size, ext: row.ext, contentId: row.contentId, unit_id: pathToUnit.get(row.path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    reviewMode: 'partitioned',
    unitByteBudget,
    units,
    crosscuttingBackstops: CROSSCUTTING_BACKSTOPS,
    projectReviewFingerprint,
    // Ordered .drfxignore pattern digests (never raw text); part of the partitioned CODE
    // identity so a rule-only change is detected on resume even when the file set is unchanged.
    userExcludes: Array.isArray(userExcludes) ? userExcludes : [],
    inventoryRows,
  };
}

// Deterministic units.json body. Explicit top-level key order; the unit objects
// keep the partitionInventory field order + the filled suggestedRefs. Two-space
// indent matches the repo's JSON report style; atomicWriteFile normalizes EOLs.
function formatUnitsJson(plan) {
  return `${JSON.stringify({
    reviewMode: plan.reviewMode,
    unitByteBudget: plan.unitByteBudget,
    units: plan.units,
    crosscuttingBackstops: plan.crosscuttingBackstops,
    projectReviewFingerprint: plan.projectReviewFingerprint,
    userExcludes: Array.isArray(plan.userExcludes) ? plan.userExcludes : []
  }, null, 2)}\n`;
}

// inventory.jsonl: one compact JSON object per line, no bodies, fixed key order.
function formatInventoryJsonl(plan) {
  return `${plan.inventoryRows
    .map((row) => JSON.stringify({
      path: row.path,
      size: row.size,
      ext: row.ext,
      contentId: row.contentId,
      unit_id: row.unit_id
    }))
    .join('\n')}\n`;
}

/**
 * Write the project-review/ plan files (inventory.jsonl + units.json) under a
 * resolved CODE target state directory. Atomic writes; the caller owns the
 * target key/manifest. Returns the project-review-relative units.json path.
 */
function writeProjectReviewPlan(targetStateDir, plan) {
  const inventoryPath = validateTargetStateOwnedPath({
    targetStateDir,
    relativePath: path.posix.join(PROJECT_REVIEW_DIRNAME, 'inventory.jsonl'),
    allowedDirectories: [PROJECT_REVIEW_DIRNAME],
    label: 'Project review inventory plan'
  });
  const unitsPath = validateTargetStateOwnedPath({
    targetStateDir,
    relativePath: path.posix.join(PROJECT_REVIEW_DIRNAME, 'units.json'),
    allowedDirectories: [PROJECT_REVIEW_DIRNAME],
    label: 'Project review units plan'
  });
  const planDir = path.dirname(unitsPath);
  fsExtra.mkdirSync(planDir, { recursive: true });
  atomicWriteFile(inventoryPath, formatInventoryJsonl(plan));
  atomicWriteFile(unitsPath, formatUnitsJson(plan));
  return path.posix.join(PROJECT_REVIEW_DIRNAME, 'units.json');
}

/**
 * Resolve the uncapped whole-root inventory and assemble the partition plan.
 * Shared by the persistent start over-cap branch and the no-state over-cap
 * path. Whole-root only: scopes are pinned to [] (an explicit scope= never
 * partitions). Returns the assembled plan (no writes).
 */
async function resolveWholeRootPartitionPlan({ projectRoot, commandLog }) {
  const { inventory, projectReviewFingerprint, userExcludes } = await resolveCodeInventory({
    cwd: projectRoot,
    scopes: [],
    commandLog
  });
  return assemblePartitionPlan({ inventory, projectReviewFingerprint, userExcludes, projectRoot });
}

module.exports = {
  resolveLiveFileSet,
  runFileSetContext,
  runFileSetRecordReview,
  runFileSetRecordTriage,
  assemblePartitionPlan,
  writeProjectReviewPlan,
  readMemberTextForRefs,
  resolveWholeRootPartitionPlan,
  PROJECT_REVIEW_DIRNAME,
  splitOversizeFile
};
