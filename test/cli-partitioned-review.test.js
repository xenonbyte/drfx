'use strict';

// PLAN-TASK-007: partitioned-review CLI subcommands wired into the workflow
// dispatcher. These tests drive the real runWorkflowCommand (and bin/drfx.js for
// the stdin path) over a real over-cap partitioned-review state created by the
// existing `start` path, asserting:
//   - context --phase unit-review --unit <id> → that unit's bounded context
//   - record-review --phase unit-review --unit <id> --result-stdin --payload-file
//     → writes findings/<id>.json + summaries/<id>.json (two-payload contract)
//   - context --phase crosscutting --backstop <id> → summaries only, no bodies
//   - record-review --phase crosscutting --backstop <id> → honest coverage_risk
//   - aggregate-review <dir> → verdict + coverageProof + aggregate.json
//   - --no-state partitioned subcommands reject cleanly
//   - non-partitioned context/record-review dispatch UNCHANGED
//   - --json carries the new whitelist fields
//   - aggregate-review only PASSes when aggregate's gate is satisfied

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runWorkflowCommand } = require('../lib/workflow');
const { readSummaryIfPresent } = require('../lib/workflow/file-set-unit-review');

const BIN = path.join(__dirname, '..', 'bin', 'drfx.js');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

// A real over-cap CODE repo: 301 small files trip the partition path the same way
// the file-set start tests do.
function makeOverCapRepo(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-cli-part-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  for (let i = 0; i < 301; i++) fs.writeFileSync(path.join(root, `oversize-${i}.js`), 'x\n');
  return root;
}

// A repo that bin-packs into MULTIPLE units: four ~600KB files each land in their
// own unit because two of them exceed the 1MB unit budget. Needed to exercise the
// "strict subset of units reviewed" reconciliation, which a single-unit repo cannot.
function makeMultiUnitRepo(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-cli-multi-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  const big = 'x'.repeat(600 * 1024) + '\n';
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(root, `big-${i}.js`), big);
  return root;
}

function practicalArgs(extra) {
  return [
    ...extra,
    'review-and-fix',
    'guard=snapshot',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ];
}

async function startPartitioned(root) {
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-code']), { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.status, 'partitioned-review');
  return start;
}

function unitReviewReceipt({ unit, reviewed = 'true', coverageRisk = 'none', cacheKey }) {
  return [
    `Unit: ${unit}`,
    `Reviewed: ${reviewed}`,
    `Coverage risk: ${coverageRisk}`,
    `Review cache key: ${cacheKey || 'none'}`,
    'Skipped:',
    '- none',
    '',
    'Extra reads:',
    '- none',
    '',
    'Contracts touched:',
    '- none'
  ].join('\n');
}

const REVIEWER_PASS = 'PASS\nSummary: correctness, architecture, state-and-io, safety, tests, contracts, maintainability, platform.\n';

// Write the coverage receipt to a safe OS-temp file (outside project root, no
// symlink) — the contract the record-review --payload-file expects.
function writeReceiptTempFile(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'receipt.txt');
  fs.writeFileSync(file, text);
  return file;
}

function runBin(args, { cwd, input } = {}) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

// ---------------------------------------------------------------------------
// context --phase unit-review
// ---------------------------------------------------------------------------

test('context --phase unit-review --unit returns that unit bounded context (--json carries unit + plan fields)', async (t) => {
  const root = makeOverCapRepo(t);
  await startPartitioned(root);

  const result = await runWorkflowCommand('context', [
    ...practicalArgs(['review-fix-code']),
    '--phase',
    'unit-review',
    '--unit',
    'unit-001'
  ], { cwd: root });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'unit-context');
  assert.equal(result.reviewMode, 'partitioned');
  assert.equal(result.unitId, 'unit-001');
  assert.equal(result.oversize, false);
  assert.ok(result.contextManifestPath, 'must surface a context manifest path');
  assert.ok(result.contextPackSkeleton, 'must surface the bounded context pack');
  // The bounded pack only contains this unit's files, never the whole project.
  assert.equal(result.contextPackSkeleton.reviewMode, 'partitioned');
  assert.equal(result.contextPackSkeleton.unit_id, 'unit-001');
});

test('context --phase unit-review WITHOUT --unit resolves the next unverified unit', async (t) => {
  const root = makeOverCapRepo(t);
  await startPartitioned(root);

  const result = await runWorkflowCommand('context', [
    ...practicalArgs(['review-fix-code']),
    '--phase',
    'unit-review'
  ], { cwd: root });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'unit-context');
  assert.equal(result.unitId, 'unit-001', 'first unverified unit is unit-001');
});

// ---------------------------------------------------------------------------
// record-review --phase unit-review (two-payload contract)
// ---------------------------------------------------------------------------

test('record-review --phase unit-review writes findings + summaries from the two payloads', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);

  const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: 'unit-001' }));
  const result = await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-code']),
    '--phase',
    'unit-review',
    '--unit',
    'unit-001',
    '--result-stdin',
    '--payload-file',
    receiptFile
  ], { cwd: root, stdin: REVIEWER_PASS });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'recorded-unit-review');
  assert.equal(result.unitId, 'unit-001');
  assert.equal(result.reviewMode, 'partitioned');
  assert.equal(result.coverageRisk, 'none');

  // The summary + findings were persisted under the target key (no bodies).
  const summary = readSummaryIfPresent(start.targetStateDir, 'unit-001');
  assert.ok(summary, 'summaries/unit-001.json must exist');
  assert.equal(summary.coverage_risk, 'none');
  assert.equal(
    fs.existsSync(path.join(start.targetStateDir, 'project-review', 'findings', 'unit-001.json')),
    true
  );
});

test('record-review --phase unit-review forwards stdin findings + safe payload-file receipt through bin/drfx.js', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);

  const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: 'unit-001' }));
  const out = runBin(['workflow', 'record-review',
    ...practicalArgs(['review-fix-code']),
    '--phase', 'unit-review',
    '--unit', 'unit-001',
    '--result-stdin',
    '--payload-file', receiptFile
  ], { cwd: root, input: REVIEWER_PASS });
  assert.equal(out.code, 0, out.stderr || out.stdout);
  const result = JSON.parse(out.stdout);
  assert.equal(result.ok, true, out.stdout);
  assert.equal(result.status, 'recorded-unit-review');
  assert.equal(
    fs.existsSync(path.join(start.targetStateDir, 'project-review', 'summaries', 'unit-001.json')),
    true
  );
});

test('record-review --phase unit-review rejects a project-local payload-file receipt', async (t) => {
  const root = makeOverCapRepo(t);
  await startPartitioned(root);
  const localReceipt = path.join(root, 'receipt.txt');
  fs.writeFileSync(localReceipt, unitReviewReceipt({ unit: 'unit-001' }));

  await assert.rejects(
    runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'unit-review',
      '--unit', 'unit-001',
      '--result-stdin',
      '--payload-file', localReceipt
    ], { cwd: root, stdin: REVIEWER_PASS }),
    (error) => /project-local|unsafe-handoff/.test(String(error.message))
  );
});

// ---------------------------------------------------------------------------
// crosscutting backstop
// ---------------------------------------------------------------------------

test('context --phase crosscutting --backstop returns unit summaries only (no bodies)', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);

  // Record one unit summary so the backstop has something to read.
  const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: 'unit-001' }));
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-code']),
    '--phase', 'unit-review', '--unit', 'unit-001',
    '--result-stdin', '--payload-file', receiptFile
  ], { cwd: root, stdin: REVIEWER_PASS });

  const result = await runWorkflowCommand('context', [
    ...practicalArgs(['review-fix-code']),
    '--phase', 'crosscutting',
    '--backstop', 'security-redaction'
  ], { cwd: root });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'crosscutting-context');
  assert.equal(result.backstop, 'security-redaction');
  assert.ok(Array.isArray(result.summaries), 'must return a summaries array');
  // Summaries-only: no file body text leaks into the backstop context.
  const serialized = JSON.stringify(result.summaries);
  assert.doesNotMatch(serialized, /module\.exports/, 'no member body text may appear');
  for (const s of result.summaries) {
    assert.ok(Object.hasOwn(s, 'coverage_risk'), 'each summary carries coverage_risk');
    assert.equal(Object.hasOwn(s, 'body'), false, 'no body field on a summary');
  }
  assert.ok(start.targetStateDir);
});

test('record-review --phase crosscutting writes an honest high coverage_risk when evidence is absent', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);

  // A backstop receipt that does NOT positively confirm cross-unit none stays high.
  const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({
    unit: 'unit-001',
    reviewed: 'false',
    coverageRisk: 'high'
  }));
  const result = await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-code']),
    '--phase', 'crosscutting',
    '--backstop', 'security-redaction',
    '--result-stdin',
    '--payload-file', receiptFile
  ], { cwd: root, stdin: REVIEWER_PASS });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'recorded-crosscutting');
  assert.equal(result.backstop, 'security-redaction');
  assert.equal(result.coverageRisk, 'high', 'unconfirmable backstop ends high, never a silent none');

  const summaryPath = path.join(
    start.targetStateDir, 'project-review', 'summaries', 'backstop-security-redaction.json'
  );
  assert.equal(fs.existsSync(summaryPath), true);
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.coverage_risk, 'high');
});

// ---------------------------------------------------------------------------
// aggregate-review
// ---------------------------------------------------------------------------

test('aggregate-review surfaces verdict + coverageProof and writes aggregate.json', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);

  // Record clean summaries for every unit so the gate can be satisfied structurally.
  const plan = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'units.json'), 'utf8'
  ));
  for (const unit of plan.units) {
    const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: unit.unit_id }));
    await runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'unit-review', '--unit', unit.unit_id,
      '--result-stdin', '--payload-file', receiptFile
    ], { cwd: root, stdin: REVIEWER_PASS });
  }

  const result = await runWorkflowCommand('aggregate-review', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'aggregated-review');
  assert.ok(['PASS', 'stopped-with-deferrals'].includes(result.verdict));
  assert.ok(result.coverageProof, 'must carry the coverage proof');
  assert.equal(typeof result.coverageProof.discovered, 'number');
  assert.ok(result.aggregatePath, 'must surface the written aggregate.json path');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'project-review', 'aggregate.json')), true);
});

test('aggregate-review never claims PASS when a unit summary carries coverage_risk high', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);

  const plan = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'units.json'), 'utf8'
  ));
  // First unit high-risk, rest clean.
  let first = true;
  for (const unit of plan.units) {
    const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({
      unit: unit.unit_id,
      reviewed: first ? 'false' : 'true',
      coverageRisk: first ? 'high' : 'none'
    }));
    await runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'unit-review', '--unit', unit.unit_id,
      '--result-stdin', '--payload-file', receiptFile
    ], { cwd: root, stdin: REVIEWER_PASS });
    first = false;
  }

  const result = await runWorkflowCommand('aggregate-review', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verdict, 'stopped-with-deferrals');
  assert.notEqual(result.verdict, 'PASS');
  assert.equal(result.coverageProof.residualRisk, 'present');
});

test('aggregate-review never claims PASS when only a STRICT SUBSET of units is reviewed', async (t) => {
  const root = makeMultiUnitRepo(t);
  const start = await startPartitioned(root);

  const plan = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'units.json'), 'utf8'
  ));
  assert.ok(plan.units.length >= 2, 'multi-unit repo must partition into multiple units');

  // Record clean coverage_risk:none summaries for every unit EXCEPT the last one.
  // aggregate() over the present summaries would be vacuously all-none and PASS;
  // the workflow-layer reconciliation against units.json must block it.
  const reviewed = plan.units.slice(0, -1);
  const omitted = plan.units[plan.units.length - 1];
  for (const unit of reviewed) {
    const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: unit.unit_id }));
    await runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'unit-review', '--unit', unit.unit_id,
      '--result-stdin', '--payload-file', receiptFile
    ], { cwd: root, stdin: REVIEWER_PASS });
  }

  const result = await runWorkflowCommand('aggregate-review', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.verdict, 'PASS', 'a partial unit set can never earn a project PASS');
  assert.equal(result.verdict, 'stopped-with-deferrals');
  assert.equal(result.reason, 'coverage-incomplete');
  assert.ok(Array.isArray(result.uncoveredUnitIds), 'must surface the uncovered unit ids');
  assert.ok(result.uncoveredUnitIds.includes(omitted.unit_id),
    `omitted unit ${omitted.unit_id} must surface as uncovered`);
  assert.equal(result.coverageProof.residualRisk, 'present');
  // The coverage proof's discovered count reflects the EXPECTED unit set, not the
  // present-summaries count.
  assert.equal(result.coverageProof.discovered, plan.units.length);

  // The honest verdict is what gets persisted into aggregate.json.
  const persisted = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'aggregate.json'), 'utf8'
  ));
  assert.equal(persisted.verdict, 'stopped-with-deferrals');
  assert.equal(persisted.reason, 'coverage-incomplete');
});

test('aggregate-review never claims PASS over ZERO recorded summaries (empty set is not vacuous PASS)', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);

  const plan = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'units.json'), 'utf8'
  ));

  // No record-review calls at all: zero summaries on disk. aggregate()'s
  // allNoneCoverage is vacuously true over the empty array — the workflow-layer
  // reconciliation must still refuse PASS because no planned unit is covered.
  const result = await runWorkflowCommand('aggregate-review', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.verdict, 'PASS', 'zero reviewed units can never earn a project PASS');
  assert.equal(result.verdict, 'stopped-with-deferrals');
  assert.equal(result.reason, 'coverage-incomplete');
  assert.deepEqual(
    result.uncoveredUnitIds.slice().sort(),
    plan.units.map((unit) => unit.unit_id).slice().sort(),
    'every planned unit is uncovered when nothing was reviewed'
  );
  assert.equal(result.coverageProof.discovered, plan.units.length);

  const persisted = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'aggregate.json'), 'utf8'
  ));
  assert.equal(persisted.verdict, 'stopped-with-deferrals');
  assert.equal(persisted.reason, 'coverage-incomplete');
});

test('aggregate-review never claims PASS when every unit is none but backstop summaries are MISSING', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);

  const plan = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'units.json'), 'utf8'
  ));
  assert.equal(plan.crosscuttingBackstops.length, 7, 'plan declares the 7 fixed backstops');

  // Every unit coverage_risk:none, but record ZERO backstop summaries. aggregate()'s
  // all-none gate is vacuously satisfied (no backstop summary on disk to violate it);
  // the workflow-layer backstop reconciliation must still refuse PASS — this is the
  // symmetric hole to the unit-coverage hole.
  for (const unit of plan.units) {
    const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: unit.unit_id }));
    await runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'unit-review', '--unit', unit.unit_id,
      '--result-stdin', '--payload-file', receiptFile
    ], { cwd: root, stdin: REVIEWER_PASS });
  }

  const result = await runWorkflowCommand('aggregate-review', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.verdict, 'PASS', 'full unit coverage without backstops can never earn a project PASS');
  assert.equal(result.verdict, 'stopped-with-deferrals');
  assert.equal(result.reason, 'coverage-incomplete');
  assert.deepEqual(result.uncoveredUnitIds, [], 'every unit is covered');
  assert.deepEqual(
    result.uncoveredBackstops.slice().sort(),
    plan.crosscuttingBackstops.slice().sort(),
    'every backstop is uncovered when none were recorded'
  );
  assert.equal(result.coverageProof.residualRisk, 'present');

  // The honest verdict is what gets persisted into aggregate.json.
  const persisted = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'aggregate.json'), 'utf8'
  ));
  assert.equal(persisted.verdict, 'stopped-with-deferrals');
  assert.equal(persisted.reason, 'coverage-incomplete');
  assert.deepEqual(
    persisted.uncoveredBackstops.slice().sort(),
    plan.crosscuttingBackstops.slice().sort()
  );
});

test('aggregate-review never claims PASS when a backstop summary is present-but-high', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);

  const plan = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'units.json'), 'utf8'
  ));

  for (const unit of plan.units) {
    const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: unit.unit_id }));
    await runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'unit-review', '--unit', unit.unit_id,
      '--result-stdin', '--payload-file', receiptFile
    ], { cwd: root, stdin: REVIEWER_PASS });
  }

  // Record every backstop as none EXCEPT one left high (no positive evidence).
  for (const backstop of plan.crosscuttingBackstops) {
    const high = backstop === plan.crosscuttingBackstops[0];
    const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({
      unit: 'unit-001',
      reviewed: high ? 'false' : 'true',
      coverageRisk: high ? 'high' : 'none'
    }));
    await runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'crosscutting', '--backstop', backstop, '--unit', 'unit-001',
      '--result-stdin', '--payload-file', receiptFile
    ], { cwd: root, stdin: REVIEWER_PASS });
  }

  const result = await runWorkflowCommand('aggregate-review', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.verdict, 'PASS', 'a high backstop can never earn a project PASS');
  assert.equal(result.verdict, 'stopped-with-deferrals');
  assert.deepEqual(result.uncoveredBackstops, [plan.crosscuttingBackstops[0]],
    'the present-but-high backstop surfaces as uncovered');
});

test('aggregate-review never claims PASS when a backstop spans only a subset of units', async (t) => {
  const root = makeMultiUnitRepo(t);
  const start = await startPartitioned(root);

  const plan = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'units.json'), 'utf8'
  ));
  assert.ok(plan.units.length > 1, 'multi-unit plan');

  for (const unit of plan.units) {
    const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: unit.unit_id }));
    await runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'unit-review', '--unit', unit.unit_id,
      '--result-stdin', '--payload-file', receiptFile
    ], { cwd: root, stdin: REVIEWER_PASS });
  }

  const partialBackstop = plan.crosscuttingBackstops[0];
  const partialReceipt = writeReceiptTempFile(t, unitReviewReceipt({ unit: 'unit-001' }));
  const recorded = await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-code']),
    '--phase', 'crosscutting', '--backstop', partialBackstop, '--unit', 'unit-001',
    '--result-stdin', '--payload-file', partialReceipt
  ], { cwd: root, stdin: REVIEWER_PASS });
  assert.equal(recorded.coverageRisk, 'high', 'partial unit span cannot earn crosscutting none');

  for (const backstop of plan.crosscuttingBackstops.slice(1)) {
    const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: 'unit-001' }));
    await runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'crosscutting', '--backstop', backstop,
      '--result-stdin', '--payload-file', receiptFile
    ], { cwd: root, stdin: REVIEWER_PASS });
  }

  const result = await runWorkflowCommand('aggregate-review', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verdict, 'stopped-with-deferrals');
  assert.deepEqual(result.uncoveredBackstops, [partialBackstop]);
});

test('aggregate-review reaches PASS only when every unit AND all 7 backstops report coverage_risk none', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);

  const plan = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'units.json'), 'utf8'
  ));

  // Every unit none.
  for (const unit of plan.units) {
    const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: unit.unit_id }));
    await runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'unit-review', '--unit', unit.unit_id,
      '--result-stdin', '--payload-file', receiptFile
    ], { cwd: root, stdin: REVIEWER_PASS });
  }

  // Every backstop earns none via positive cross-unit evidence: all planned units have
  // clean summaries, and the receipt confirms reviewed:true + coverage_risk:none.
  for (const backstop of plan.crosscuttingBackstops) {
    const receiptFile = writeReceiptTempFile(t, unitReviewReceipt({ unit: 'unit-001' }));
    const recorded = await runWorkflowCommand('record-review', [
      ...practicalArgs(['review-fix-code']),
      '--phase', 'crosscutting', '--backstop', backstop,
      '--result-stdin', '--payload-file', receiptFile
    ], { cwd: root, stdin: REVIEWER_PASS });
    assert.equal(recorded.coverageRisk, 'none', `backstop ${backstop} must earn none`);
  }

  const result = await runWorkflowCommand('aggregate-review', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  // Full unit AND full backstop coverage, no open high/medium findings → PASS reachable.
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.equal(result.coverageProof.residualRisk, 'none');

  const persisted = JSON.parse(fs.readFileSync(
    path.join(start.targetStateDir, 'project-review', 'aggregate.json'), 'utf8'
  ));
  assert.equal(persisted.verdict, 'PASS');
});

// ---------------------------------------------------------------------------
// PERSISTENT-only: --no-state partitioned subcommands reject cleanly
// ---------------------------------------------------------------------------

test('--no-state context --phase unit-review rejects cleanly', async (t) => {
  const root = makeOverCapRepo(t);
  await assert.rejects(
    runWorkflowCommand('context', [
      'review-fix-code', 'read-only', `root=${root}`, 'guard=snapshot',
      '--no-state',
      '--runtime-platform', 'codex',
      '--runtime-subagent-probe', 'ready',
      '--runtime-stdin-handoff', 'ready',
      '--phase', 'unit-review', '--unit', 'unit-001'
    ], { cwd: root }),
    (error) => error.code === 'ERR_NO_STATE_PHASE'
  );
});

test('--no-state aggregate-review rejects cleanly', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);
  await assert.rejects(
    runWorkflowCommand('aggregate-review', [start.targetStateDir, '--no-state', '--json'], { cwd: root }),
    (error) => error.code === 'ERR_NO_STATE_COMMAND'
  );
});

// ---------------------------------------------------------------------------
// ADDITIVE: non-partitioned context/record-review dispatch is UNCHANGED
// ---------------------------------------------------------------------------

test('non-partitioned no-state context (no unit-review/crosscutting phase) dispatches unchanged', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-cli-nonpart-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');

  const commonArgs = [
    'review-fix-code', 'read-only', `root=${root}`, 'guard=snapshot',
    '--assurance', 'advisory',
    '--runtime-platform', 'manual',
    '--runtime-subagent-probe', 'not-required',
    '--runtime-stdin-handoff', 'ready',
    '--runtime-downgrade-reason', 'none',
    '--phase', 'initial-review',
    '--json'
  ];
  const context = await runWorkflowCommand('context', ['--no-state', ...commonArgs], { cwd: root });
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(typeof context.reviewGuard, 'string');
  // The partitioned result fields must be absent on the unchanged path.
  assert.equal(context.unitId === undefined || context.unitId === null, true);
});
