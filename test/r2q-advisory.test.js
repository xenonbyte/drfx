'use strict';

// ---------------------------------------------------------------------------
// review-fix-r2q — advisory / read-only review lifecycle (no-state path).
//
// These tests are DETERMINISTIC: no LLM / CLI semantic reviewer runs. The test
// harness supplies the explicit reviewer FAIL payload, the triage payload, and
// the final-response payload, and drives the SAME no-state workflow commands the
// generated r2q route uses (context -> record-review -> record-triage -> finalize).
//
// What they pin:
//   - r2q resolves via resolveR2qTarget (run.md gate + 03–07 chain), NOT the
//     CODE/PR file-set resolvers.
//   - The advisory path returns ONLY read-only statuses (read-only-findings here),
//     never `pass`, and writes NOTHING (no 03–07 / run.md mutation, no .drfx state).
//   - The validated final output references the owning upstream doc for a finding
//     whose root cause is upstream (acceptance/behavior -> 06-spec.md).
//   - The generated route prompt/package carries the finding->owner-doc map.
//   - run.md gate failures (incomplete plan / archived dir) surface as blockers and
//     never reach reviewer-recording.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runWorkflowCommand } = require('../lib/workflow');
const { generatePlatformFiles, renderPlatformRoute } = require('../lib/generator');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const planApprovedRunMd = [
  '# Requirement Run',
  '',
  '## Status',
  'closed_at_plan_checkpoint',
  '',
  '## Active Artifacts',
  '- plan: approved',
  ''
].join('\n');

const planIncompleteRunMd = [
  '# Requirement Run',
  '',
  '## Status',
  'active_at_spec_stage',
  '',
  '## Active Artifacts',
  '- spec: active',
  ''
].join('\n');

const R2Q_EDITABLE_DOCS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

// Explicit reviewer FAIL payload: a PLAN-rubric finding whose ROOT CAUSE is an
// acceptance/behavior gap. Per the finding->owner-doc map that owner is 06-spec.md.
const REVIEW_FAIL = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: 07-plan.md#step-3',
  '  issue: Step 3 implements acceptance behavior that 06-spec.md never states.',
  '  why_it_matters: The plan executes behavior with no spec backing, so it can drift from intended behavior.',
  '  suggested_fix: Add the acceptance criterion to 06-spec.md, then reference it from the plan step.',
  '  confidence: confirmed',
  '  sensitive: false'
].join('\n');

const TRIAGE_ACCEPT = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: accepted',
  '  severity: high',
  '  original_severity: high',
  '  rationale: Acceptance/behavior gap whose owner doc is 06-spec.md.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

// Final response references the owning upstream doc (06-spec.md) for the finding.
const FINAL_FINDINGS = [
  'Final status: read-only-findings',
  'Assurance: advisory',
  'Runtime platform: manual',
  'Mode: read-only',
  'Target: none',
  'Files changed: none',
  'Fixed issue IDs: none',
  'Verification performed: read-only review of 07-plan.md against COMMON+PLAN',
  'Deferrals or blockers: ISSUE-001 acceptance/behavior gap owned by 06-spec.md; next action fix backward in 06-spec.md',
  'Blocking reason: none',
  'Status reason: none',
  'Residual risk: 07-plan.md step 3 lacks spec backing in 06-spec.md',
  'Redaction statement: no sensitive values persisted',
  'Coordinator agreement: none'
].join('\n');

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2q-advisory-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2q-advisory-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { root, homeDir };
}

function makeWfDir(root, name, { runMd = planApprovedRunMd, underArchive = false } = {}) {
  const parent = underArchive
    ? path.join(root, '.req-to-plan', 'archive')
    : path.join(root, '.req-to-plan');
  const wfDir = path.join(parent, name);
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'run.md'), runMd);
  for (const doc of R2Q_EDITABLE_DOCS) {
    fs.writeFileSync(path.join(wfDir, doc), `# ${doc}\nContent of ${doc}\n`);
  }
  return wfDir;
}

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotProtectedFiles(wfDir) {
  const watched = ['run.md', ...R2Q_EDITABLE_DOCS];
  return Object.fromEntries(watched.map((name) => [name, sha256OfFile(path.join(wfDir, name))]));
}

function changedFiles(wfDir, before) {
  return Object.keys(before).filter((name) => before[name] !== sha256OfFile(path.join(wfDir, name)));
}

function projectRelative(root, wfDir, name) {
  return path.relative(root, path.join(wfDir, name)).split(path.sep).join('/');
}

function r2qArgs(wfDir) {
  return [
    'review-fix-r2q',
    `target=${wfDir}`,
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'ready',
    '--runtime-downgrade-reason',
    'none',
    '--phase',
    'initial-review',
    '--json'
  ];
}

// ---------------------------------------------------------------------------
// Advisory e2e: FAIL finding -> read-only-findings, nothing written, owner doc named.
// ---------------------------------------------------------------------------

test('r2q advisory review finalizes read-only-findings without editing any 03–07 file or run.md', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260624-advisory');
  const before = snapshotProtectedFiles(wfDir);
  const commonArgs = r2qArgs(wfDir);
  const opts = { cwd: root, homeDir };

  const context = await runWorkflowCommand('context', ['--no-state', ...commonArgs], opts);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(context.status, 'context');
  assert.equal(context.routeKind, 'r2q');
  assert.equal(context.targetStateDir, null);
  assert.equal(typeof context.reviewGuard, 'string');
  assert.deepEqual(
    context.contextPackSkeleton.fileSet.files.map((file) => file.path).sort(),
    R2Q_EDITABLE_DOCS.map((doc) => projectRelative(root, wfDir, doc)).sort()
  );
  assert.deepEqual(
    context.contextPackSkeleton.protectedDependencies.map((dep) => dep.path),
    [projectRelative(root, wfDir, 'run.md')]
  );

  const review = await runWorkflowCommand('record-review', [
    '--no-state',
    ...commonArgs,
    '--review-guard',
    context.reviewGuard,
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_FAIL });
  assert.equal(review.ok, true, JSON.stringify(review));
  assert.equal(review.status, 'recorded-review');
  assert.equal(typeof review.stateToken, 'string');

  const triage = await runWorkflowCommand('record-triage', [
    '--no-state',
    ...commonArgs,
    '--state-token',
    review.stateToken,
    '--triage-stdin'
  ], { ...opts, stdin: TRIAGE_ACCEPT });
  assert.equal(triage.ok, true, JSON.stringify(triage));
  assert.equal(triage.status, 'recorded-triage');

  const finalized = await runWorkflowCommand('finalize', [
    '--no-state',
    ...commonArgs,
    '--state-token',
    triage.stateToken,
    '--final-response-stdin'
  ], { ...opts, stdin: FINAL_FINDINGS });

  // Final status is read-only-findings, never pass.
  assert.equal(finalized.ok, true, JSON.stringify(finalized));
  assert.equal(finalized.status, 'read-only-findings');
  assert.notEqual(finalized.status, 'pass');

  // The validated final output references the owning upstream doc for the finding.
  assert.match(finalized.finalResponse.deferralsOrBlockers, /06-spec\.md/);

  // NOTHING was modified: no 03–07 file, no run.md, no .drfx state.
  assert.deepEqual(changedFiles(wfDir, before), []);
  assert.equal(fs.existsSync(path.join(root, '.drfx')), false);
});

test('r2q advisory record-review blocks when protected run.md drifts after context', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260624-advisory-drift');
  const commonArgs = r2qArgs(wfDir);
  const opts = { cwd: root, homeDir };

  const context = await runWorkflowCommand('context', ['--no-state', ...commonArgs], opts);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(typeof context.reviewGuard, 'string');

  fs.appendFileSync(path.join(wfDir, 'run.md'), '\nchanged after no-state context\n');

  const review = await runWorkflowCommand('record-review', [
    '--no-state',
    ...commonArgs,
    '--review-guard',
    context.reviewGuard,
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_FAIL });

  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.status, 'blocked');
  assert.equal(review.blockingReason, 'reviewer-mutated-file');
});

// ---------------------------------------------------------------------------
// Generated route prompt/package carries the finding->owner-doc map.
// ---------------------------------------------------------------------------

function renderedR2qRoutePackage(platform) {
  if (platform !== 'codex') {
    return renderPlatformRoute(platform, 'review-fix-r2q', { packageVersion: '0.0.0-snapshot' });
  }

  const packageFiles = generatePlatformFiles('codex', { packageVersion: '0.0.0-snapshot' });
  const r2qSkill = packageFiles.find((entry) => entry.routeName === 'review-fix-r2q');
  assert.ok(r2qSkill, 'codex r2q skill package exists');
  return r2qSkill.files.map((file) => file.content).join('\n');
}

test('generated r2q route prompt/package carries the finding-to-owner-doc map', () => {
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    const rendered = renderedR2qRoutePackage(platform);
    assert.match(rendered, /finding-to-owner-doc map/i, `${platform} r2q prompt must carry the map heading`);
    assert.match(rendered, /acceptance criteria \/ observable behavior gap -> `06-spec\.md`/, `${platform}: 06-spec mapping`);
    assert.match(rendered, /architecture, interface, or sequencing gap -> `05-design\.md`/, `${platform}: 05-design mapping`);
    assert.match(rendered, /unmitigated risk or missing rollback -> `04-risk-discovery\.md`/, `${platform}: 04-risk mapping`);
    assert.match(rendered, /scope or requirement ambiguity -> `03-requirement-brief\.md`/, `${platform}: 03-requirement mapping`);
    assert.match(rendered, /local to the plan -> `07-plan\.md` only/, `${platform}: 07-plan-only mapping`);
  }
});

// ---------------------------------------------------------------------------
// run.md gating: incomplete plan and archived dir surface as blockers and never
// reach reviewer-recording.
// ---------------------------------------------------------------------------

test('r2q advisory blocks on an incomplete-plan run.md before reviewer-recording', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260624-incomplete', { runMd: planIncompleteRunMd });
  const commonArgs = r2qArgs(wfDir);
  const opts = { cwd: root, homeDir };

  const context = await runWorkflowCommand('context', ['--no-state', ...commonArgs], opts);
  assert.equal(context.ok, false, JSON.stringify(context));
  assert.equal(context.status, 'blocked');
  assert.equal(context.errorCode, 'ERR_R2Q_GATE_PLAN_INCOMPLETE');
  assert.equal(context.blockingReason, 'state-validation-failed');

  // record-review must ALSO refuse: the gate error never reaches reviewer-recording.
  const review = await runWorkflowCommand('record-review', [
    '--no-state',
    ...commonArgs,
    '--review-guard',
    'placeholder-guard',
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_FAIL });
  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.status, 'blocked');
  assert.equal(review.errorCode, 'ERR_R2Q_GATE_PLAN_INCOMPLETE');
  assert.notEqual(review.status, 'recorded-review');
});

test('r2q advisory blocks on an archived requirement directory before reviewer-recording', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260624-archived', { underArchive: true });
  const commonArgs = r2qArgs(wfDir);
  const opts = { cwd: root, homeDir };

  const context = await runWorkflowCommand('context', ['--no-state', ...commonArgs], opts);
  assert.equal(context.ok, false, JSON.stringify(context));
  assert.equal(context.status, 'blocked');
  assert.equal(context.errorCode, 'ERR_R2Q_GATE_ARCHIVED');
  assert.equal(context.blockingReason, 'state-validation-failed');

  const review = await runWorkflowCommand('record-review', [
    '--no-state',
    ...commonArgs,
    '--review-guard',
    'placeholder-guard',
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_FAIL });
  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.status, 'blocked');
  assert.equal(review.errorCode, 'ERR_R2Q_GATE_ARCHIVED');
  assert.notEqual(review.status, 'recorded-review');
});
