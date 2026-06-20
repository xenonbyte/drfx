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
  path,
  fail
} = require('./helpers');
const {
  unitContext,
  recordUnitReview,
  nextUnit,
  crosscuttingContext,
  recordCrosscuttingReview,
  readAllSummaries,
  readAllFindings,
  readUnitsPlan,
  PROJECT_REVIEW_DIRNAME
} = require('./file-set-unit-review');
const { aggregate } = require('../project-review');
const { validateTargetStateOwnedPath } = require('../target-state');

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
      homeDir: options.homeDir
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

function runAggregateReview(parsed, options) {
  const targetStateDir = parsed.targetStateDir;
  if (!targetStateDir) fail('ERR_AGGREGATE_REVIEW_TARGET', 'aggregate-review requires a target-state directory');

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
  const uncoveredBackstops = plannedBackstops.filter(
    (backstop) => !noneCoveredIds.has(`backstop-${backstop}`)
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
    const forcedHigh = aggregate(summaries, findings);
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
  const result = aggregate(summaries, findings);

  atomicWriteFile(outPath, `${JSON.stringify(result, null, 2)}\n`);

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
    // The verdict is authoritative; the CLI status never says 'pass'.
    nextAction: result.verdict === 'PASS'
      ? 'verdict PASS earned; proceed to finalize'
      : 'coverage incomplete; resolve deferrals before claiming a project PASS'
  };
}

module.exports = {
  runPartitionedContext,
  runPartitionedRecordReview,
  runAggregateReview
};
