'use strict';

// PLAN-TASK-006: bounded per-unit review lifecycle for the partitioned CODE
// project-review path. This module is the file-set analog of the document
// reviewer/fixer loop, but the unit of review is ONE partition unit (a bounded
// subset of the project's files) rather than the whole file set.
//
// It composes five already-shipped pieces:
//   - T3 lib/workflow/file-set-context.js : writeProjectReviewPlan / PROJECT_REVIEW_DIRNAME
//     wrote units.json; this module ADDS the readers (units.json / summaries / findings).
//   - T5 lib/context-pack.js             : buildFileSetContextPack partitioned mode +
//                                           mergedRulesFingerprint.
//   - T1 lib/project-review.js           : reviewCacheKey (pure cache-key derivation).
//   - T8 lib/semantic-parsers.js         : parseUnitReviewReport (coverage receipt) +
//                                           parseReviewerResult (reviewer pass/fail findings).
//   - target-context                     : resolveCodeInventory (drift recompute),
//                                           streamingContentId (extraReads re-validation).
//
// SAFETY / BINDING CONSTRAINTS (task brief):
//   - "PASS is earned, never assumed." Oversize / metadata-only / drifted units force
//     coverage_risk:high; never a silent pass. A clean unit is NOT a project PASS
//     (aggregation is Task 7 / project-review.aggregate).
//   - BOUNDED context: a unit's reviewer context contains only the unit's files ∪ its
//     suggestedRefs (buildFileSetContextPack receives ONLY unit.files).
//   - No bodies persisted: summaries/findings carry only paths/contentIds/findings.
//   - Frozen contentId namespace: extraReads re-validation reuses streamingContentId.
//   - ADDITIVE: this module changes no existing file's behavior.

const {
  atomicWriteFile,
  fail,
  fs,
  loadRouteRuleContext,
  parseReviewerResult,
  path,
  stableJson
} = require('./helpers');
const { parseUnitReviewReport } = require('../semantic-parsers');
const { buildFileSetContextPack, mergedRulesFingerprint } = require('../context-pack');
const { reviewCacheKey } = require('../project-review');
const { resolveCodeInventory, streamingContentId } = require('../target-context');
const { validateTargetStateOwnedPath } = require('../target-state');

const PROJECT_REVIEW_DIRNAME = 'project-review';

// ---------------------------------------------------------------------------
// Path helpers — every read/write stays inside the target key, no symlink escape
// (validateTargetStateOwnedPath enforces the allowlist + no-symlink + no-escape).
// ---------------------------------------------------------------------------

function unitsJsonPath(targetStateDir) {
  return validateTargetStateOwnedPath({
    targetStateDir,
    relativePath: path.posix.join(PROJECT_REVIEW_DIRNAME, 'units.json'),
    allowedDirectories: [PROJECT_REVIEW_DIRNAME],
    label: 'Project review units plan'
  });
}

function assertUnitId(unitId) {
  if (typeof unitId !== 'string' || !/^unit-\d{3,}$/.test(unitId)) {
    fail('ERR_UNIT_REVIEW_UNIT_ID', `unit id must match unit-NNN: ${unitId}`);
  }
  return unitId;
}

function summaryPath(targetStateDir, unitId) {
  return validateTargetStateOwnedPath({
    targetStateDir,
    relativePath: path.posix.join(PROJECT_REVIEW_DIRNAME, 'summaries', `${assertUnitId(unitId)}.json`),
    allowedDirectories: [PROJECT_REVIEW_DIRNAME],
    label: 'Unit summary path'
  });
}

function findingsPath(targetStateDir, unitId) {
  return validateTargetStateOwnedPath({
    targetStateDir,
    relativePath: path.posix.join(PROJECT_REVIEW_DIRNAME, 'findings', `${assertUnitId(unitId)}.json`),
    allowedDirectories: [PROJECT_REVIEW_DIRNAME],
    label: 'Unit findings path'
  });
}

function unitContextManifestPath(targetStateDir, unitId) {
  return validateTargetStateOwnedPath({
    targetStateDir,
    relativePath: path.posix.join(PROJECT_REVIEW_DIRNAME, 'context', `${assertUnitId(unitId)}.md`),
    allowedDirectories: [PROJECT_REVIEW_DIRNAME],
    label: 'Unit context manifest path'
  });
}

// ---------------------------------------------------------------------------
// Readers (ADDED — T3 wrote the plan but shipped no reader)
// ---------------------------------------------------------------------------

function readUnitsPlan(targetStateDir) {
  const planPath = unitsJsonPath(targetStateDir);
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (error) {
    fail('ERR_UNIT_REVIEW_PLAN', `unable to read project-review units.json: ${error && error.message ? error.message : error}`);
  }
  if (!plan || plan.reviewMode !== 'partitioned' || !Array.isArray(plan.units)) {
    fail('ERR_UNIT_REVIEW_PLAN', 'project-review units.json is not a partitioned plan');
  }
  return plan;
}

function findUnit(plan, unitId) {
  const unit = plan.units.find((candidate) => candidate.unit_id === assertUnitId(unitId));
  if (!unit) fail('ERR_UNIT_REVIEW_UNIT_NOT_FOUND', `unit not found in plan: ${unitId}`);
  return unit;
}

function readSummaryIfPresent(targetStateDir, unitId) {
  const filePath = summaryPath(targetStateDir, unitId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // A corrupt summary is treated as absent: the unit needs re-review, never a
    // silent reuse of unparseable state.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rules — load the merged CODE rule set for the context pack AND its fingerprint.
// Mirrors loadFileSetRules (file-set-context.js) but takes an explicit projectRoot
// so the lifecycle functions stay free of a persistent-metadata object.
// ---------------------------------------------------------------------------

function readBuiltInRubric(routeKind) {
  const rubricPath = path.join(__dirname, '..', '..', 'shared', 'rubrics', `${routeKind}.md`);
  try {
    return fs.readFileSync(rubricPath, 'utf8');
  } catch {
    return '';
  }
}

function loadMergedRulesForRoot(projectRoot, options = {}) {
  const ruleContext = loadRouteRuleContext({
    routeKind: 'code',
    builtInRubric: readBuiltInRubric('code'),
    homeDir: options.homeDir,
    projectRoot
  });
  const layers = Array.isArray(ruleContext.layers) ? ruleContext.layers : [];
  return {
    text: layers.map((layer) => layer.text).filter(Boolean).join('\n\n'),
    layers,
    sources: layers.map((layer) => layer.source),
    warnings: Array.isArray(ruleContext.warnings) ? ruleContext.warnings : []
  };
}

// ---------------------------------------------------------------------------
// Cache-key derivation (T1 reviewCacheKey) — the single source of truth used by
// both recordUnitReview (cache skip) and nextUnit (valid-summary check).
// ---------------------------------------------------------------------------

function computeUnitCacheKey({ unit, rules, extraReads }) {
  return reviewCacheKey({
    memberDigest: unit.member_digest,
    mergedRulesFingerprint: mergedRulesFingerprint(rules),
    suggestedRefs: Array.isArray(unit.suggestedRefs) ? unit.suggestedRefs : [],
    extraReads: Array.isArray(extraReads) ? extraReads : []
  });
}

// Re-validate that every stored extraRead {path,contentId} still matches the
// current on-disk content (frozen sha256 namespace via streamingContentId). A
// missing file or a moved contentId means the cache is stale → no reuse.
async function extraReadsStillMatch(projectRoot, extraReads) {
  for (const read of Array.isArray(extraReads) ? extraReads : []) {
    const absolute = path.join(projectRoot, read.path);
    let actual;
    try {
      actual = await streamingContentId(absolute);
    } catch {
      return false;
    }
    if (actual !== read.contentId) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// unitContext — build ONE unit's bounded reviewer context.
//
//   unitContext({ targetStateDir, projectRoot, unitId, homeDir? })
//
//   - oversize_file unit  → metadata-only outcome (NO body read, NO context pack);
//     nextAction:'record oversize coverage blocker', coverageRisk:'high'.
//   - normal unit         → partitioned context pack (ONLY this unit's files +
//     merged rules + suggestedRefs as read-only references), written to a per-unit
//     context manifest under project-review/context/<unit_id>.md.
// ---------------------------------------------------------------------------

function unitContext({ targetStateDir, projectRoot, unitId, homeDir = null }) {
  const plan = readUnitsPlan(targetStateDir);
  const unit = findUnit(plan, unitId);

  if (unit.oversize_file === true) {
    // The oversize body is NEVER loaded. The reviewer cannot positively confirm
    // coverage, so this is forced to a coverage blocker, not a pass.
    return {
      ok: true,
      unitId: unit.unit_id,
      oversize: true,
      coverageRisk: 'high',
      nextAction: 'record oversize coverage blocker',
      memberFiles: unit.files.map((file) => file.path)
    };
  }

  const rules = loadMergedRulesForRoot(projectRoot, { homeDir });
  const contextPack = buildFileSetContextPack({
    routeKind: 'code',
    // Bounded: ONLY the unit's files. normalizedScopes:[] keeps the descriptor in
    // whole-root form; the context pack pulls no other file from disk.
    fileSet: { routeKind: 'code', files: unit.files, normalizedScopes: [] },
    phase: 'initial-review',
    round: 1,
    mergedRules: rules,
    requiredOutputSchema: 'reviewer-pass-fail',
    reviewMode: 'partitioned',
    unitId: unit.unit_id,
    suggestedRefs: unit.suggestedRefs,
    projectRoot
  });
  const contextManifestPath = writeUnitContextManifest(targetStateDir, unit.unit_id, contextPack);
  return {
    ok: true,
    unitId: unit.unit_id,
    oversize: false,
    contextManifestPath,
    contextPackSkeleton: contextPack,
    warnings: rules.warnings || []
  };
}

function formatUnitContextManifest(pack) {
  return ['# Unit Review Context Manifest', '', '```json', stableJson(pack), '```', ''].join('\n');
}

function writeUnitContextManifest(targetStateDir, unitId, contextPack) {
  const manifestPath = unitContextManifestPath(targetStateDir, unitId);
  atomicWriteFile(manifestPath, formatUnitContextManifest(contextPack));
  return manifestPath;
}

// ---------------------------------------------------------------------------
// recordUnitReview — write findings/<id>.json + summaries/<id>.json.
//
//   recordUnitReview({
//     targetStateDir, projectRoot, unitId,
//     coverageReceipt,   // raw unit-review text OR a pre-parsed parseUnitReviewReport object
//     reviewerFindings,  // raw reviewer pass/fail text OR a pre-parsed parseReviewerResult object
//     homeDir?
//   })
//
//   TASK 7 INTERFACE: the coverage receipt and the reviewer findings are TWO
//   SEPARATE payloads (their wire formats differ: parseUnitReviewReport vs
//   parseReviewerResult), mirroring runFileSetRecordReview which parses the
//   reviewer result separately from the context. Either may be passed as raw text
//   (this module parses it) or pre-parsed (the controller already parsed it).
//
//   CACHE SKIP: when a prior summaries/<id>.json exists AND its reviewCacheKey
//   recomputes IDENTICAL AND every stored extraRead {path,contentId} still matches
//   current content, the prior summary is REUSED — the unit need not be re-reviewed.
//   Editing any contract file (a suggestedRef/extraRead) moves its contentId, so the
//   key changes ⇒ forced re-review.
//
//   OVERSIZE: writes the FIXED high-risk summary + a blocker findings entry; never
//   claims coverage.
// ---------------------------------------------------------------------------

function parseCoverageReceipt(coverageReceipt) {
  if (coverageReceipt && typeof coverageReceipt === 'object') return coverageReceipt;
  if (typeof coverageReceipt !== 'string' || coverageReceipt.trim() === '') {
    fail('ERR_UNIT_REVIEW_RECEIPT', 'coverage receipt text or object is required');
  }
  return parseUnitReviewReport(coverageReceipt);
}

function parseReviewerFindings(reviewerFindings) {
  if (reviewerFindings && typeof reviewerFindings === 'object') return reviewerFindings;
  if (typeof reviewerFindings !== 'string' || reviewerFindings.trim() === '') {
    fail('ERR_UNIT_REVIEW_FINDINGS', 'reviewer findings text or object is required');
  }
  return parseReviewerResult(reviewerFindings);
}

function writeSummary(targetStateDir, unitId, summary) {
  atomicWriteFile(summaryPath(targetStateDir, unitId), `${JSON.stringify(summary, null, 2)}\n`);
}

function writeFindings(targetStateDir, unitId, findings) {
  atomicWriteFile(findingsPath(targetStateDir, unitId), `${JSON.stringify(findings, null, 2)}\n`);
}

async function recordUnitReview({
  targetStateDir,
  projectRoot,
  unitId,
  coverageReceipt,
  reviewerFindings,
  homeDir = null
}) {
  const plan = readUnitsPlan(targetStateDir);
  const unit = findUnit(plan, unitId);

  // Oversize: FIXED high-risk summary + a blocker findings entry. No coverage claim.
  if (unit.oversize_file === true) {
    const summary = {
      reviewed: false,
      coverage_risk: 'high',
      skipped_reason: 'single-file-over-budget'
    };
    writeSummary(targetStateDir, unit.unit_id, summary);
    writeFindings(targetStateDir, unit.unit_id, {
      result: 'FAIL',
      summary: null,
      findings: [{
        id: `${unit.unit_id}-oversize`,
        severity: 'high',
        location: unit.files[0] ? unit.files[0].path : 'unknown',
        issue: 'Unit exceeds the per-unit byte budget; its body was not reviewed.',
        why_it_matters: 'An unreviewed oversize file cannot be confirmed safe; coverage is incomplete.',
        suggested_fix: 'Split the file or review it manually; do not claim coverage for this unit.',
        confidence: 'confirmed',
        sensitive: false,
        coverageBlocker: true
      }],
      warnings: []
    });
    return { ok: true, reused: false, oversize: true, unitId: unit.unit_id, coverageRisk: 'high' };
  }

  const receipt = parseCoverageReceipt(coverageReceipt);
  const findings = parseReviewerFindings(reviewerFindings);
  const rules = loadMergedRulesForRoot(projectRoot, { homeDir });
  const cacheKey = computeUnitCacheKey({ unit, rules, extraReads: receipt.extraReads });

  // CACHE SKIP: reuse the prior summary iff its reviewCacheKey is identical AND every
  // stored extraRead still matches current content. The contract-edit case fails this
  // because the changed contentId moves the cache key (and/or breaks extraReadsStillMatch).
  const prior = readSummaryIfPresent(targetStateDir, unit.unit_id);
  if (
    prior &&
    prior.reviewCacheKey === cacheKey &&
    await extraReadsStillMatch(projectRoot, prior.extraReads)
  ) {
    return {
      ok: true,
      reused: true,
      oversize: false,
      unitId: unit.unit_id,
      reviewCacheKey: cacheKey,
      coverageRisk: prior.coverage_risk
    };
  }

  const summary = {
    reviewed: Boolean(receipt.reviewed),
    skipped: Array.isArray(receipt.skipped) ? receipt.skipped : [],
    extraReads: Array.isArray(receipt.extraReads) ? receipt.extraReads : [],
    coverage_risk: receipt.coverageRisk === 'high' ? 'high' : 'none',
    reviewCacheKey: cacheKey,
    contractsTouched: Array.isArray(receipt.contractsTouched) ? receipt.contractsTouched : []
  };
  writeSummary(targetStateDir, unit.unit_id, summary);
  writeFindings(targetStateDir, unit.unit_id, findings);
  return {
    ok: true,
    reused: false,
    oversize: false,
    unitId: unit.unit_id,
    reviewCacheKey: cacheKey,
    coverageRisk: summary.coverage_risk
  };
}

// ---------------------------------------------------------------------------
// nextUnit — drift gate + resume cursor.
//
//   nextUnit(units|targetStateDir, summaries, { projectRoot, commandLog?, homeDir? })
//
//   1. Recompute the current projectReviewFingerprint (resolveCodeInventory, whole
//      root) and compare to units.json's. On DRIFT → a stale/blocked outcome reusing
//      the existing STATUS_REASON 'stale-fingerprint-mismatch' (never a silent continue).
//   2. No drift → return the next unit (in plan order) lacking a VALID summary: no
//      summaries/<id>.json, OR its reviewCacheKey no longer matches the recomputed key.
//      When every unit has a valid summary → 'all-units-reviewed'.
//
//   The first arg is the targetStateDir (the plan is the source of truth); the
//   `summaries` arg is accepted for signature parity with the brief skeleton but the
//   on-disk summaries are authoritative.
// ---------------------------------------------------------------------------

async function nextUnit(targetStateDir, _summaries, options = {}) {
  const projectRoot = options.projectRoot;
  if (!projectRoot) fail('ERR_UNIT_REVIEW_ROOT', 'nextUnit requires options.projectRoot');
  const plan = readUnitsPlan(targetStateDir);

  // Drift gate: recompute the live whole-root fingerprint and compare.
  const { projectReviewFingerprint } = await resolveCodeInventory({
    cwd: projectRoot,
    scopes: [],
    commandLog: options.commandLog
  });
  if (projectReviewFingerprint !== plan.projectReviewFingerprint) {
    return {
      ok: false,
      status: 'blocked',
      statusReason: 'stale-fingerprint-mismatch',
      blockingReason: 'state-validation-failed',
      nextAction: 're-run partition planning; the project tree drifted since the plan was written'
    };
  }

  const rules = loadMergedRulesForRoot(projectRoot, { homeDir: options.homeDir });
  for (const unit of plan.units) {
    if (!unitHasValidSummary(targetStateDir, unit, rules)) {
      return { ok: true, status: 'next-unit', unitId: unit.unit_id, oversize: unit.oversize_file === true };
    }
  }
  return { ok: true, status: 'all-units-reviewed' };
}

// A summary is VALID when it exists and (for normal units) its reviewCacheKey still
// recomputes to the stored value. An oversize unit's summary is valid as soon as the
// FIXED high-risk summary is present (there is no body cache key to revalidate).
function unitHasValidSummary(targetStateDir, unit, rules) {
  const summary = readSummaryIfPresent(targetStateDir, unit.unit_id);
  if (!summary) return false;
  if (unit.oversize_file === true) {
    return summary.coverage_risk === 'high' && summary.skipped_reason === 'single-file-over-budget';
  }
  if (typeof summary.reviewCacheKey !== 'string') return false;
  const expected = computeUnitCacheKey({ unit, rules, extraReads: summary.extraReads });
  return summary.reviewCacheKey === expected;
}

// ---------------------------------------------------------------------------
// unitsToReReview — units affected by a set of changed files (post-fix re-aggregation,
// consumed by Task 11).
//
//   unitsToReReview(changedFiles, units|plan, summaries|targetStateDir)
//
//   Returns the deterministic, deduped, sorted set of unit ids that are:
//     (a) directly changed   — a unit member file ∈ changedFiles, ∪
//     (b) suggestedRefs-hit   — a unit whose suggestedRefs include a changed file, ∪
//     (c) extraReads-hit      — a unit whose stored summary.extraReads include a changed file.
//
//   `units` may be a plan object ({units:[...]}) or the units array directly.
//   The third arg may be a targetStateDir string (summaries read from disk) or a
//   Map/object of unit_id → summary (already-loaded summaries).
// ---------------------------------------------------------------------------

function unitsArrayFrom(units) {
  if (Array.isArray(units)) return units;
  if (units && Array.isArray(units.units)) return units.units;
  fail('ERR_UNIT_REVIEW_UNITS', 'unitsToReReview requires a units array or plan');
}

function summaryLookup(unitId, summaries, targetStateDir) {
  if (summaries instanceof Map) return summaries.get(unitId) || null;
  if (summaries && typeof summaries === 'object') return summaries[unitId] || null;
  if (typeof targetStateDir === 'string') return readSummaryIfPresent(targetStateDir, unitId);
  return null;
}

function unitsToReReview(changedFiles, units, summariesOrTargetStateDir) {
  const changed = new Set(Array.isArray(changedFiles) ? changedFiles : []);
  const unitList = unitsArrayFrom(units);
  const targetStateDir = typeof summariesOrTargetStateDir === 'string' ? summariesOrTargetStateDir : null;
  const summaries = typeof summariesOrTargetStateDir === 'string' ? null : summariesOrTargetStateDir;
  const hits = new Set();

  for (const unit of unitList) {
    // (a) directly changed member file.
    const directlyChanged = (Array.isArray(unit.files) ? unit.files : [])
      .some((file) => changed.has(file.path));
    // (b) suggestedRefs hit.
    const refHit = (Array.isArray(unit.suggestedRefs) ? unit.suggestedRefs : [])
      .some((ref) => changed.has(ref.path));
    // (c) stored extraReads hit.
    const summary = summaryLookup(unit.unit_id, summaries, targetStateDir);
    const extraHit = summary && Array.isArray(summary.extraReads)
      ? summary.extraReads.some((read) => changed.has(read.path))
      : false;

    if (directlyChanged || refHit || extraHit) hits.add(unit.unit_id);
  }

  return [...hits].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

module.exports = {
  unitContext,
  recordUnitReview,
  nextUnit,
  unitsToReReview,
  // Readers + helpers exported for Task 7 / Task 11 composition.
  readUnitsPlan,
  readSummaryIfPresent,
  PROJECT_REVIEW_DIRNAME
};
