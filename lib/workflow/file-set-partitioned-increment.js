'use strict';

// Plan B: the partitioned end-fix incremental exit. Called ONLY from runEndFix
// after its guard chain has proven the worktree delta equals the declared,
// in-set, route-owned fix (file-set-fix.js). At that one proven point we may
// safely re-stamp the partition plan with the new content and re-review only the
// affected units. Membership/bucket/refs drift = out of scope -> block + reset.

const {
  atomicWriteFile,
  formatLedger,
  stateCommandBase,
  stateRelativePath,
  updateFixedIssues,
  updatePersistentManifest,
  writeFixReceipt,
  writeNormalizedFixReport,
} = require('./helpers');
const { describeCodeBlock, resolveCodeInventory } = require('../target-context');
const { refreshPartitionPlanContent, suggestRefsFor } = require('../project-review');
const {
  invalidateUnitReviews,
  invalidateAllBackstopReviews,
  unitsToReReview,
} = require('./file-set-unit-review');
const { writeProjectReviewPlan, readMemberTextForRefs, splitOversizeFile } = require('./file-set-context');

function endFixIncrementBlocked(metadata, fixReport, declaredFiles, summary, nextAction) {
  // Mirrors endFixBlocked from file-set-fix.js but is reused here to keep the
  // increment self-contained. The caller releases the lease after this function
  // returns, so blocked-state persistence still happens under the active lease.
  try {
    writeFixReceipt(metadata, {
      status: 'blocked',
      issueIds: (fixReport.fixed || []).map((f) => f.issue_id),
      filesChanged: declaredFiles.join(', '),
      blockingReason: 'state-validation-failed',
      summary,
      nextAction,
    });
  } catch { /* best-effort */ }
  updatePersistentManifest(metadata, { status: 'blocked', blockingReason: 'state-validation-failed', statusReason: 'none' });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    nextAction,
  });
}

function orderedStringList(value) {
  return (Array.isArray(value) ? value : []).map((entry) => String(entry));
}

function orderedStringListsEqual(a, b) {
  const left = orderedStringList(a);
  const right = orderedStringList(b);
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function chunkSourcePaths(plan) {
  const paths = new Set();
  for (const unit of Array.isArray(plan && plan.units) ? plan.units : []) {
    if (unit.oversize_chunk === true && typeof unit.sourcePath === 'string') {
      paths.add(unit.sourcePath);
    }
  }
  return [...paths].sort();
}

function firstChunkForSource(plan, sourcePath) {
  return (Array.isArray(plan && plan.units) ? plan.units : [])
    .find((unit) => unit.oversize_chunk === true && unit.sourcePath === sourcePath) || null;
}

function legacyOversizeFileSources(plan) {
  const sources = [];
  for (const unit of Array.isArray(plan && plan.units) ? plan.units : []) {
    if (unit.oversize_file !== true) continue;
    const file = Array.isArray(unit.files) ? unit.files[0] : null;
    if (file && typeof file.path === 'string') {
      sources.push({ sourcePath: file.path, sourceContentId: file.contentId });
    }
  }
  return sources.sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0));
}

function persistedPlanPathError(plan, inventoryByPath) {
  const units = Array.isArray(plan && plan.units) ? plan.units : [];
  for (const unit of units) {
    if (unit.oversize_chunk === true) {
      if (typeof unit.sourcePath !== 'string' || !inventoryByPath.has(unit.sourcePath)) {
        return `persisted partition source is outside the live inventory: ${unit.sourcePath || '<missing>'}`;
      }
      continue;
    }
    for (const file of Array.isArray(unit.files) ? unit.files : []) {
      if (!file || typeof file.path !== 'string' || !inventoryByPath.has(file.path)) {
        return `persisted partition member is outside the live inventory: ${file && file.path ? file.path : '<missing>'}`;
      }
    }
  }
  return null;
}

async function applyPartitionedIncrement({ metadata, declaredFiles, fixReport, ledger, options, oldPlan }) {
  // (1) Re-resolve the inventory using the DURABLE manifest scope identity, never
  // whole-root. A scoped CODE review must keep its scope or membership/fingerprint
  // would be judged against the wrong file set.
  const inventoryResult = await resolveCodeInventory({
    cwd: metadata.projectRoot,
    scopes: metadata.manifest.normalizedScopes || [],
    commandLog: options.commandLog,
  });
  if (inventoryResult && inventoryResult.status === 'blocked') {
    const blocked = describeCodeBlock(inventoryResult);
    return endFixIncrementBlocked(metadata, fixReport, declaredFiles, blocked.message,
      blocked.nextAction || 'reset and rerun partitioned project review before bounded re-review');
  }
  if (!orderedStringListsEqual(oldPlan.userExcludes, inventoryResult.userExcludes)) {
    return endFixIncrementBlocked(metadata, fixReport, declaredFiles,
      'partitioned increment refused: .drfxignore rules drifted since the partition plan was written',
      'reset and rerun partitioned project review before bounded re-review');
  }
  const newInventory = inventoryResult.inventory;
  const fingerprintF1 = String(inventoryResult.projectReviewFingerprint || '');
  const newInventoryByPath = new Map(newInventory.map((row) => [row.path, row]));
  const persistedPathError = persistedPlanPathError(oldPlan, newInventoryByPath);
  if (persistedPathError) {
    return endFixIncrementBlocked(metadata, fixReport, declaredFiles,
      `partitioned increment refused: ${persistedPathError}`,
      'reset and rerun partitioned project review before bounded re-review');
  }

  // (2) Re-resolve suggestedRefs for every non-chunk unit on the NEW inventory.
  // refs reading needs file bodies = IO here (the pure refresh is IO-free).
  const inRootSet = new Map(newInventory.map((row) => [row.path, row.contentId]));
  const nextSuggestedRefsByUnit = {};
  for (const unit of oldPlan.units) {
    if (unit.oversize_chunk === true || unit.oversize_file === true) continue;
    const unitFiles = readMemberTextForRefs(metadata.projectRoot, unit.files);
    nextSuggestedRefsByUnit[unit.unit_id] = suggestRefsFor(unitFiles, inRootSet);
  }
  const nextOversizeChunksByPath = new Map();
  const unitByteBudget = Number(oldPlan.unitByteBudget) || undefined;
  for (const sourcePath of chunkSourcePaths(oldPlan)) {
    const oldChunk = firstChunkForSource(oldPlan, sourcePath);
    const source = newInventoryByPath.get(sourcePath);
    if (!oldChunk || !source || String(source.contentId) === String(oldChunk.sourceContentId)) continue;
    if (unitByteBudget && Number(source.size) <= unitByteBudget) {
      return endFixIncrementBlocked(metadata, fixReport, declaredFiles,
        `partitioned increment refused: changed oversize chunk source is no longer oversize: ${sourcePath}`,
        'reset and rerun partitioned project review for the changed code before re-reviewing units');
    }
    const chunks = splitOversizeFile({
      projectRoot: metadata.projectRoot,
      file: source,
      chunkByteBudget: unitByteBudget,
    });
    if (!chunks) {
      return endFixIncrementBlocked(metadata, fixReport, declaredFiles,
        `partitioned increment refused: changed oversize chunk source can no longer be split safely: ${sourcePath}`,
        'reset and rerun partitioned project review for the changed code before re-reviewing units');
    }
    nextOversizeChunksByPath.set(sourcePath, chunks);
  }
  for (const { sourcePath, sourceContentId } of legacyOversizeFileSources(oldPlan)) {
    const source = newInventoryByPath.get(sourcePath);
    if (!source || String(source.contentId) === String(sourceContentId)) continue;
    if (unitByteBudget && Number(source.size) <= unitByteBudget) {
      return endFixIncrementBlocked(metadata, fixReport, declaredFiles,
        `partitioned increment refused: changed oversize blocker source is no longer oversize: ${sourcePath}`,
        'reset and rerun partitioned project review for the changed code before re-reviewing units');
    }
    const chunks = splitOversizeFile({
      projectRoot: metadata.projectRoot,
      file: source,
      chunkByteBudget: unitByteBudget,
    });
    if (!chunks) {
      return endFixIncrementBlocked(metadata, fixReport, declaredFiles,
        `partitioned increment refused: changed oversize blocker source can no longer be split safely: ${sourcePath}`,
        'reset and rerun partitioned project review for the changed code before re-reviewing units');
    }
    nextOversizeChunksByPath.set(sourcePath, chunks);
  }

  // (3) Pure refresh (membership/bucket/refs drift throws -> block + reset).
  let refreshedPlan;
  let refsChangedUnitIds;
  try {
    ({ refreshedPlan, refsChangedUnitIds } = refreshPartitionPlanContent(oldPlan, newInventory, {
      nextSuggestedRefsByUnit,
      nextOversizeChunksByPath,
      projectReviewFingerprint: fingerprintF1,
    }));
  } catch (error) {
    return endFixIncrementBlocked(metadata, fixReport, declaredFiles,
      `partitioned increment refused: ${error && error.message ? error.message : String(error)}`,
      'reset and rerun partitioned project review for the changed code before re-reviewing units');
  }

  // (4) Persist the refreshed plan (units.json + inventory.jsonl), atomic.
  writeProjectReviewPlan(metadata.targetStateDir, refreshedPlan);

  // (5) Affected = changed-member ∪ suggestedRef-hit ∪ extraRead-hit (over BOTH old
  // and refreshed plans) ∪ refs-topology-changed. Old plan catches units that
  // referenced the changed file before refresh; refreshed catches new references.
  const affected = new Set([
    ...unitsToReReview(declaredFiles, oldPlan, metadata.targetStateDir),
    ...unitsToReReview(declaredFiles, refreshedPlan, metadata.targetStateDir),
    ...refsChangedUnitIds,
  ]);
  invalidateUnitReviews(metadata.targetStateDir, [...affected]);
  // Backstops reason cross-unit; any content change invalidates all 7 (v1 safe default).
  invalidateAllBackstopReviews(metadata.targetStateDir);

  // (6) Record the fix exactly like non-partitioned end-fix (normalized report +
  // ledger advance + receipt), but transition to the partitioned checkpoint/review
  // state instead of diff-review. currentRound and fixAttemptCount are unchanged.
  const reportPath = writeNormalizedFixReport({ metadata, fixReport });
  const nextLedger = updateFixedIssues(ledger, fixReport);
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
  updatePersistentManifest(metadata, {
    status: 'checkpoint',
    currentPhase: 'review',
    blockingReason: 'none',
    statusReason: 'checkpoint-requested',
    currentReportPath: stateRelativePath(metadata.targetStateDir, reportPath),
    lastFixReportPath: stateRelativePath(metadata.targetStateDir, reportPath),
    fileSetFingerprint: fingerprintF1,
    lastModifiedAt: new Date().toISOString(),
  });
  if (Array.isArray(fixReport.verification)) {
    try {
      writeFixReceipt(metadata, {
        kind: 'fix-applied',
        status: 'end-fix',
        issueIds: (fixReport.fixed || []).map((f) => f.issue_id),
        filesChanged: declaredFiles.join(', '),
        verification: fixReport.verification.join('; '),
        summary: 'partitioned file-set fix applied; affected units and all backstops invalidated for bounded re-review',
      });
    } catch { /* receipt is best-effort */ }
  }

  return stateCommandBase(metadata, {
    ok: true,
    status: 'end-fix',
    reviewMode: 'partitioned',
    fixReportPath: reportPath,
    fixedIssueIds: (fixReport.fixed || []).map((f) => f.issue_id),
    ...(Array.isArray(fixReport.verification) ? { verification: fixReport.verification } : {}),
    invalidatedUnitIds: [...affected].sort(),
    nextAction: 'run context --phase unit-review to re-review the affected units, rerun required backstops, then aggregate-review',
  });
}

module.exports = { applyPartitionedIncrement };
