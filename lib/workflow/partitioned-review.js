'use strict';

// PLAN-TASK-007: CLI dispatch for the partitioned project-review lifecycle.
//
// This is the thin workflow-layer wiring between the strict arg parser
// (lib/workflow/index.js) and the already-shipped lifecycle pieces:
//   - Task 6 (lib/workflow/file-set-unit-review.js): unitContext / nextUnit /
//     recordUnitReview, plus the Task 7 crosscutting reader/recorder added there.
//   - Task 1 (lib/project-review.js): the pure `aggregate` (dedup + coverage proof
//     + forced-high re-read + earned-PASS gate).
//   - Task 8 (lib/semantic-parsers.js): parseUnitReviewReport / parseReviewerResult
//     consumed through recordUnitReview.
//
// BINDING CONSTRAINTS (task brief):
//   - PERSISTENT-only. These run only off a real checkpoint state dir (--no-state is
//     rejected upstream by the parser, never reaching here).
//   - "PASS is earned, never assumed." The CLI never elevates a result to PASS;
//     aggregate's gate is authoritative and its verdict is surfaced verbatim.
//   - No bodies persisted. Redaction preserved (the lifecycle owns it).
//   - ADDITIVE: a context/record-review WITHOUT --phase unit-review|crosscutting
//     never reaches this module (index.js intercepts only those two phase values).
//
// TWO-PAYLOAD record-review CLI CONTRACT (design decision, documented):
//   recordUnitReview needs BOTH the reviewer PASS/FAIL findings AND the coverage
//   receipt, but stdin is a single stream. We reuse the EXISTING safe payload
//   machinery (readWorkflowPayload → readSemanticPayload):
//     - the reviewer PASS/FAIL findings arrive on --result-stdin (parseReviewerResult
//       wire format),
//     - the coverage receipt arrives via --payload-file <tempPath> (parseUnitReviewReport
//       wire format), validated by readSemanticPayload's OS-temp-only / no-symlink /
//       not-under-project-root / not-under-.drfx rules.
//   Exactly-one is enforced per slot by readWorkflowPayload, so a missing or
//   doubled payload fails loudly. No payload text is ever persisted.

const {
  persistentBase,
  readWorkflowPayload,
  resolveFileSetPersistentMetadata,
  isStateValidationError,
  blockPersistentStateValidation,
  atomicWriteFile,
  nextReportPath,
  padRound,
  path,
  fail,
  producerForAssurance,
  resolveFileSetStateMetadata,
  stateRelativePath,
  updatePersistentManifest,
  writeReviewerReport
} = require('./helpers');
const {
  unitContext,
  recordUnitReview,
  nextUnit,
  crosscuttingContext,
  recordCrosscuttingReview,
  readAllSummaries,
  readAllFindings,
  extraReadsStillMatch,
  readUnitsPlan,
  PROJECT_REVIEW_DIRNAME
} = require('./file-set-unit-review');
const { aggregate } = require('../project-review');
const { validateTargetStateOwnedPath } = require('../target-state');
const { resolveCodeInventory } = require('../target-context');

const REVIEWER_FINDING_ID_RE = /^R\d{3,}$/;

function orderedStringList(value) {
  return (Array.isArray(value) ? value : []).map((entry) => String(entry));
}

function orderedStringListsEqual(a, b) {
  const left = orderedStringList(a);
  const right = orderedStringList(b);
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

// ---------------------------------------------------------------------------
// context --phase unit-review|crosscutting
// ---------------------------------------------------------------------------

async function runPartitionedContext(parsed, options) {
  const metadata = resolveFileSetPersistentMetadata(parsed, options);
  try {
    if (parsed.phase === 'crosscutting') {
      return crosscuttingContextResult(parsed, metadata);
    }
    return await unitContextResult(parsed, metadata, options);
  } catch (error) {
    if (isStateValidationError(error)) return blockPersistentStateValidation(parsed, metadata, error);
    throw error;
  }
}

async function unitContextResult(parsed, metadata, options) {
  const projectRoot = metadata.projectRoot;
  let unitId = parsed.unit;

  // WITHOUT --unit: resolve the next unverified unit (drift gate + resume cursor).
  // This drift-blocks on a fingerprint mismatch and signals all-reviewed when done.
  if (!unitId) {
    const next = await nextUnit(metadata.targetStateDir, null, {
      projectRoot,
      commandLog: options.commandLog,
      homeDir: options.homeDir
    });
    if (next.status === 'blocked') {
      return persistentBase(parsed, metadata, {
        ok: false,
        status: 'blocked',
        reviewMode: 'partitioned',
        blockingReason: next.blockingReason || 'state-validation-failed',
        statusReason: next.statusReason || 'none',
        nextAction: next.nextAction || null
      });
    }
    if (next.status === 'all-units-reviewed') {
      return persistentBase(parsed, metadata, {
        ok: true,
        status: 'all-units-reviewed',
        reviewMode: 'partitioned',
        nextAction: 'run workflow aggregate-review <targetStateDir> to compute the project verdict'
      });
    }
    unitId = next.unitId;
  }

  const context = unitContext({
    targetStateDir: metadata.targetStateDir,
    projectRoot,
    unitId,
    homeDir: options.homeDir
  });
  return persistentBase(parsed, metadata, {
    ok: true,
    status: 'unit-context',
    reviewMode: 'partitioned',
    unitId: context.unitId,
    oversize: Boolean(context.oversize),
    coverageRisk: context.coverageRisk || null,
    contextManifestPath: context.contextManifestPath || null,
    contextPackSkeleton: context.contextPackSkeleton || null,
    warnings: context.warnings || [],
    nextAction: context.nextAction || null
  });
}

function crosscuttingContextResult(parsed, metadata) {
  const context = crosscuttingContext({
    targetStateDir: metadata.targetStateDir,
    backstop: parsed.backstop
  });
  return persistentBase(parsed, metadata, {
    ok: true,
    status: 'crosscutting-context',
    reviewMode: 'partitioned',
    backstop: context.backstop,
    summaries: context.summaries,
    backstops: context.backstops,
    nextAction: 'review cross-unit coverage, then record-review --phase crosscutting --backstop ' + context.backstop
  });
}

// ---------------------------------------------------------------------------
// record-review --phase unit-review|crosscutting (two-payload contract)
// ---------------------------------------------------------------------------

async function runPartitionedRecordReview(parsed, options) {
  const metadata = resolveFileSetPersistentMetadata(parsed, options);
  try {
    // Reviewer PASS/FAIL findings on --result-stdin (or a safe --result file).
    const reviewerFindings = readWorkflowPayload({
      parsed,
      metadata,
      valueFlag: 'result',
      stdinFlag: 'resultStdin',
      label: 'reviewer findings',
      options
    });
    // Coverage receipt on --payload-file (safe OS-temp file) or --payload-stdin.
    const coverageReceipt = readWorkflowPayload({
      parsed,
      metadata,
      valueFlag: 'payloadFile',
      stdinFlag: 'payloadStdin',
      label: 'coverage receipt',
      options
    });

    if (parsed.phase === 'crosscutting') {
      const recorded = recordCrosscuttingReview({
        targetStateDir: metadata.targetStateDir,
        backstop: parsed.backstop,
        coverageReceipt,
        reviewerFindings,
        spannedUnitIds: parsed.unit ? [parsed.unit] : []
      });
      return persistentBase(parsed, metadata, {
        ok: true,
        status: 'recorded-crosscutting',
        reviewMode: 'partitioned',
        backstop: recorded.backstop,
        coverageRisk: recorded.coverageRisk,
        nextAction: 'record remaining backstops, then aggregate-review'
      });
    }

    const recorded = await recordUnitReview({
      targetStateDir: metadata.targetStateDir,
      projectRoot: metadata.projectRoot,
      unitId: parsed.unit,
      coverageReceipt,
      reviewerFindings,
      homeDir: options.homeDir,
      commandLog: options.commandLog
    });
    return persistentBase(parsed, metadata, {
      ok: true,
      status: 'recorded-unit-review',
      reviewMode: 'partitioned',
      unitId: recorded.unitId,
      oversize: Boolean(recorded.oversize),
      reused: Boolean(recorded.reused),
      reviewCacheKey: recorded.reviewCacheKey || null,
      coverageRisk: recorded.coverageRisk,
      nextAction: 'run workflow context --phase unit-review for the next unit, or aggregate-review when all units are reviewed'
    });
  } catch (error) {
    if (isStateValidationError(error)) return blockPersistentStateValidation(parsed, metadata, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// aggregate-review <targetStateDir>
// ---------------------------------------------------------------------------

function aggregatePath(targetStateDir) {
  return validateTargetStateOwnedPath({
    targetStateDir,
    relativePath: path.posix.join(PROJECT_REVIEW_DIRNAME, 'aggregate.json'),
    allowedDirectories: [PROJECT_REVIEW_DIRNAME],
    label: 'Project review aggregate path'
  });
}

function recordAggregatePassAsFullReview(metadata) {
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `full-review-round-${padRound(round)}`);
  const reviewerResult = {
    result: 'PASS',
    summary: 'Partitioned aggregate coverage gate earned PASS.',
    findings: [],
    warnings: []
  };
  writeReviewerReport({
    reportPath,
    phase: 'full-re-review',
    round,
    producer: producerForAssurance(metadata.manifest.assurance),
    reviewerResult
  });
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
  updatePersistentManifest(metadata, {
    status: 'full-re-review',
    currentPhase: 'full-re-review',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: relativeReportPath,
    lastReviewerReportPath: relativeReportPath,
    runtimeFingerprintGuard: 'passed'
  });
  return reportPath;
}

function isBlockingFinding(finding) {
  return finding && (
    finding.severity === 'high' ||
    finding.severity === 'medium' ||
    finding.severity === 'P0' ||
    finding.severity === 'P1'
  );
}

function formatReviewerFindingId(index) {
  return 'R' + String(index).padStart(3, '0');
}

function nextUnusedReviewerFindingId(used, startIndex) {
  let index = startIndex;
  let candidate = formatReviewerFindingId(index);
  while (used.has(candidate)) {
    index += 1;
    candidate = formatReviewerFindingId(index);
  }
  return { id: candidate, nextIndex: index + 1 };
}

function ensureUniqueReviewerFindingIds(findings) {
  const used = new Set();
  let nextIndex = 1;
  return findings.map((finding) => {
    const currentId = finding && finding.id != null ? String(finding.id) : '';
    if (REVIEWER_FINDING_ID_RE.test(currentId) && !used.has(currentId)) {
      used.add(currentId);
      return finding;
    }
    const next = nextUnusedReviewerFindingId(used, nextIndex);
    nextIndex = next.nextIndex;
    used.add(next.id);
    return { ...finding, id: next.id };
  });
}

function aggregateWithUniqueReviewerFindingIds(summaries, findings) {
  const result = aggregate(summaries, findings);
  return {
    ...result,
    findings: ensureUniqueReviewerFindingIds(result.findings)
  };
}

function recordAggregateFailAsInitialReview(metadata, result) {
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `aggregate-review-round-${padRound(round)}`);
  const reviewerResult = {
    result: 'FAIL',
    summary: 'Partitioned aggregate review found blocking reviewer findings.',
    findings: result.findings,
    warnings: []
  };
  writeReviewerReport({
    reportPath,
    phase: 'initial-review',
    round,
    producer: producerForAssurance(metadata.manifest.assurance),
    reviewerResult
  });
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
  updatePersistentManifest(metadata, {
    status: 'triage',
    currentPhase: 'triage',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: relativeReportPath,
    lastReviewerReportPath: relativeReportPath,
    runtimeFingerprintGuard: 'passed'
  });
  return reportPath;
}

async function runAggregateReview(parsed, options) {
  const targetStateDir = parsed.targetStateDir;
  if (!targetStateDir) fail('ERR_AGGREGATE_REVIEW_TARGET', 'aggregate-review requires a target-state directory');
  const metadata = resolveFileSetStateMetadata(targetStateDir);

  // Read ALL summaries (units + backstops) and findings from the target key. The
  // readers validate path ownership (no symlink escape) and fail loudly on a
  // corrupt file — stale review state is never aggregated as if absent. Each entry
  // is { id, body } where id is the basename (a unit's id is its unit_id).
  const summaryEntries = readAllSummaries(targetStateDir);
  const summaries = summaryEntries.map((entry) => entry.body);
  const findings = readAllFindings(targetStateDir).flatMap((entry) => {
    const body = entry.body;
    return Array.isArray(body && body.findings) ? body.findings : [];
  });

  // "PASS is earned, never assumed." aggregate() computes allNoneCoverage over the
  // summaries that HAPPEN to be on disk — which is vacuously true for an empty set
  // and true for any reviewed subset (unreviewed units OR unreviewed backstops are
  // simply absent). Before any PASS can surface we MUST reconcile against the plan:
  // every unit declared in units.json AND every crosscutting backstop has to carry a
  // coverage_risk:'none' summary (SPEC-BEHAVIOR-005, DES-GATE-001).
  const plan = readUnitsPlan(targetStateDir);

  // Fail-fast freshness gate (B): recompute the live inventory fingerprint and compare to
  // the plan. If the project tree drifted since the units were reviewed, the persisted
  // summaries describe stale content, so refuse to aggregate -- never record a stale PASS
  // as full-re-review. recordUnitReview/nextUnit guard each unit at review time, and
  // finalize's identity recompute is a further backstop; this blocks before any verdict
  // is written for the window between the last unit review and aggregate.
  const liveInventory = await resolveCodeInventory({
    cwd: metadata.projectRoot,
    scopes: [],
    commandLog: options.commandLog
  });
  if (!orderedStringListsEqual(plan.userExcludes, liveInventory.userExcludes)) {
    return {
      ok: false,
      status: 'blocked',
      reviewMode: 'partitioned',
      targetStateDir: path.resolve(targetStateDir),
      statusReason: 'stale-fingerprint-mismatch',
      blockingReason: 'state-validation-failed',
      nextAction: '.drfxignore rules drifted since the partition plan; reset and rerun partitioned project review before aggregate-review'
    };
  }
  if (String(liveInventory.projectReviewFingerprint || '') !== String(plan.projectReviewFingerprint || '')) {
    return {
      ok: false,
      status: 'blocked',
      reviewMode: 'partitioned',
      targetStateDir: path.resolve(targetStateDir),
      statusReason: 'stale-fingerprint-mismatch',
      blockingReason: 'state-validation-failed',
      nextAction: 'project tree drifted since the partition plan; reset and rerun partitioned project review before aggregate-review'
    };
  }

  for (const entry of summaryEntries) {
    if (!await extraReadsStillMatch(metadata.projectRoot, entry.body && entry.body.extraReads)) {
      return {
        ok: false,
        status: 'blocked',
        reviewMode: 'partitioned',
        targetStateDir: path.resolve(targetStateDir),
        statusReason: 'stale-fingerprint-mismatch',
        blockingReason: 'state-validation-failed',
        nextAction: 'extra-read evidence drifted since unit review; re-review affected units before aggregate-review'
      };
    }
  }

  const plannedUnitIds = plan.units.map((unit) => unit.unit_id);
  const noneCoveredIds = new Set(
    summaryEntries
      .filter((entry) => entry.body && entry.body.coverage_risk === 'none')
      .map((entry) => entry.id)
  );
  const uncoveredUnitIds = plannedUnitIds.filter((unitId) => !noneCoveredIds.has(unitId));

  // Backstop reconciliation (symmetric to the unit reconcile). Backstop summaries are
  // keyed `backstop-<id>.json` (recordCrosscuttingReview), so a backstop's summary id
  // is `backstop-<name>`; reconcile each of the 7 fixed plan.crosscuttingBackstops
  // against THAT key. A backstop with no summary, or a present-but-'high' summary, is
  // uncovered. Units (`unit-NNN`) and backstops (`backstop-<name>`) share the same
  // summaries/ directory but never collide on id, so this partition is exact.
  const plannedBackstops = Array.isArray(plan.crosscuttingBackstops) ? plan.crosscuttingBackstops : [];
  const plannedUnitIdSet = new Set(plannedUnitIds);
  const summaryById = new Map(summaryEntries.map((entry) => [entry.id, entry.body]));
  const uncoveredBackstops = plannedBackstops.filter(
    (backstop) => {
      const summary = summaryById.get(`backstop-${backstop}`);
      if (!summary || summary.coverage_risk !== 'none') return true;
      const spanned = Array.isArray(summary.spannedUnitIds) ? summary.spannedUnitIds : [];
      if (spanned.length !== plannedUnitIds.length) return true;
      return spanned.some((unitId) => !plannedUnitIdSet.has(unitId));
    }
  );

  const outPath = aggregatePath(targetStateDir);

  if (uncoveredUnitIds.length > 0 || uncoveredBackstops.length > 0) {
    // Missing entirely OR present-but-high, for a unit OR a backstop. Never call
    // aggregate-and-report-PASS over a partial/empty set: force the honest verdict and
    // persist THAT. The coverage proof's discovered count is reconciled against the
    // EXPECTED unit set (plan.units.length), not just the present summaries, so the
    // proof matches reality. Backstop coverage is now reconciled HERE against the plan,
    // because aggregate()'s own all-none gate is vacuously satisfied when a backstop
    // summary is simply absent from disk — it cannot see the 7 expected backstops.
    const forcedHigh = aggregateWithUniqueReviewerFindingIds(summaries, findings);
    const result = {
      verdict: 'stopped-with-deferrals',
      reason: 'coverage-incomplete',
      uncoveredUnitIds,
      uncoveredBackstops,
      findings: forcedHigh.findings,
      coverageProof: {
        ...forcedHigh.coverageProof,
        discovered: plannedUnitIds.length,
        residualRisk: 'present'
      },
      crosscuttingBackstops: forcedHigh.crosscuttingBackstops
    };
    atomicWriteFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
    const forcedReread = result.findings.filter((finding) => finding.forceReread);
    return {
      ok: true,
      status: 'aggregated-review',
      reviewMode: 'partitioned',
      targetStateDir: path.resolve(targetStateDir),
      verdict: result.verdict,
      reason: result.reason,
      uncoveredUnitIds,
      uncoveredBackstops,
      coverageProof: result.coverageProof,
      forcedReread,
      crosscuttingBackstops: result.crosscuttingBackstops,
      aggregatePath: outPath,
      nextAction: 'coverage incomplete; review the uncovered units and backstops before claiming a project PASS'
    };
  }

  // Full coverage holds: every planned unit AND every one of the 7 crosscutting
  // backstops carries a coverage_risk:'none' summary (both reconciled above against
  // units.json). Only now is PASS reachable. Task 1 pure aggregate is authoritative
  // for the verdict and PASS is allowed iff its gate also holds (no open high/medium
  // finding, etc.). The CLI never elevates to PASS.
  const result = aggregateWithUniqueReviewerFindingIds(summaries, findings);

  atomicWriteFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  const reviewerReportPath = result.verdict === 'PASS'
    ? recordAggregatePassAsFullReview(metadata)
    : (result.findings.some(isBlockingFinding) ? recordAggregateFailAsInitialReview(metadata, result) : null);

  // The forced-high-severity re-read list the model must re-read before finalize.
  const forcedReread = result.findings.filter((finding) => finding.forceReread);

  return {
    ok: true,
    status: 'aggregated-review',
    reviewMode: 'partitioned',
    targetStateDir: path.resolve(targetStateDir),
    verdict: result.verdict,
    coverageProof: result.coverageProof,
    forcedReread,
    crosscuttingBackstops: result.crosscuttingBackstops,
    aggregatePath: outPath,
    ...(reviewerReportPath ? { reviewerReportPath } : {}),
    // The verdict is authoritative; the CLI status never says 'pass'.
    nextAction: result.verdict === 'PASS'
      ? 'verdict PASS earned; proceed to finalize'
      : (reviewerReportPath
        ? 'verdict FAIL recorded; record-triage the accepted findings, then begin-fix. The partitioned fix loop re-reviews only the affected units before re-aggregating for an earned PASS.'
        : 'coverage incomplete; resolve deferrals before claiming a project PASS')
  };
}

module.exports = {
  runPartitionedContext,
  runPartitionedRecordReview,
  runAggregateReview
};
