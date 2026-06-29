'use strict';

// ---------------------------------------------------------------------------
// review-fix-r2p — advisory / read-only review lifecycle (no-state path).
//
// These tests are DETERMINISTIC: no LLM / CLI semantic reviewer runs. The test
// harness supplies the explicit reviewer FAIL payload, the triage payload, and
// the final-response payload, and drives the SAME no-state workflow commands the
// generated r2p route uses (context -> record-review -> record-triage -> finalize).
//
// What they pin:
//   - r2p resolves via active workId + fake req-to-plan CLI status, NOT the
//     CODE/PR file-set resolvers.
//   - The advisory path returns ONLY read-only statuses (read-only-findings here),
//     never `pass`, and writes NOTHING (no 03–07 / run.md mutation, no .drfx state).
//   - The validated final output references the owning upstream stage for a finding
//     whose root cause is upstream (acceptance/behavior -> spec).
//   - The generated route prompt/package carries the finding->ownerStage map.
//   - The route follows the req-to-plan status contract, not run.md prose, and
//     archive-only workIds block before reviewer-recording.
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

const R2P_EDITABLE_DOCS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

// Explicit reviewer FAIL payload: a PLAN-rubric finding whose ROOT CAUSE is an
// acceptance/behavior gap. Per the finding->ownerStage map that owner is spec.
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
  '  rationale: Acceptance/behavior gap whose owner stage is spec.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

// Final response references the owning upstream stage (spec) for the finding.
const FINAL_FINDINGS = [
  'Final status: read-only-findings',
  'Assurance: advisory',
  'Runtime platform: manual',
  'Mode: read-only',
  'Target: none',
  'Files changed: none',
  'Fixed issue IDs: none',
  'Verification performed: read-only review of 07-plan.md against COMMON+PLAN',
  'Deferrals or blockers: ISSUE-001 acceptance/behavior gap owned by spec; next action repair the spec stage and regenerate the plan artifacts',
  'Blocking reason: none',
  'Status reason: none',
  'Residual risk: 07-plan.md step 3 lacks spec backing in 06-spec.md',
  'Redaction statement: no sensitive values persisted',
  'Coordinator agreement: none'
].join('\n');

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-advisory-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-advisory-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { root, homeDir };
}

function writeExecutable(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o755 });
}

function installFakeR2pCli(root, workId, status = 'closed_at_plan_checkpoint') {
  const binDir = path.join(root, 'fake-r2p-bin');
  const scripts = {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" '[{"work_id":"${workId}","status":"${status}","current_stage":"plan","open_routes_detail":[]}]'`
    ].join('\n'),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      'printf "%s\\n" \'{"new_work_id":"WF-fake-reopen"}\''
    ].join('\n'),
    'r2p-gap-open': [
      '#!/bin/sh',
      'set -eu',
      'printf "%s\\n" \'{"route_id":"route-fake","staled_stages":["plan"]}\''
    ].join('\n'),
    'r2p-continue': [
      '#!/bin/sh',
      'set -eu',
      'printf "%s\\n" \'{"ok":true}\''
    ].join('\n')
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeExecutable(path.join(binDir, name), body);
  }
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`
  };
}

function makeWfDir(root, name, { runMd = planApprovedRunMd, underArchive = false } = {}) {
  const parent = underArchive
    ? path.join(root, '.req-to-plan', 'archive')
    : path.join(root, '.req-to-plan');
  const wfDir = path.join(parent, name);
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'run.md'), runMd);
  for (const doc of R2P_EDITABLE_DOCS) {
    fs.writeFileSync(path.join(wfDir, doc), `# ${doc}\nContent of ${doc}\n`);
  }
  return wfDir;
}

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotProtectedFiles(wfDir) {
  const watched = ['run.md', ...R2P_EDITABLE_DOCS];
  return Object.fromEntries(watched.map((name) => [name, sha256OfFile(path.join(wfDir, name))]));
}

function changedFiles(wfDir, before) {
  return Object.keys(before).filter((name) => before[name] !== sha256OfFile(path.join(wfDir, name)));
}

function projectRelative(root, wfDir, name) {
  return path.relative(root, path.join(wfDir, name)).split(path.sep).join('/');
}

function r2pArgs(workId) {
  return [
    'review-fix-r2p',
    `workId=${workId}`,
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
// Advisory e2e: FAIL finding -> read-only-findings, nothing written, owner stage named.
// ---------------------------------------------------------------------------

test('r2p advisory review finalizes read-only-findings without editing any 03–07 file or run.md', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260624-advisory';
  const wfDir = makeWfDir(root, workId);
  const before = snapshotProtectedFiles(wfDir);
  const commonArgs = r2pArgs(workId);
  const opts = { cwd: root, homeDir, env: installFakeR2pCli(root, workId) };

  const context = await runWorkflowCommand('context', ['--no-state', ...commonArgs], opts);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(context.status, 'context');
  assert.equal(context.routeKind, 'r2p');
  assert.equal(context.targetStateDir, null);
  assert.equal(typeof context.reviewGuard, 'string');
  assert.equal(context.contextPackSkeleton.fileSet.requirementDir, `.req-to-plan/${workId}`);
  assert.notEqual(context.contextPackSkeleton.fileSet.requirementDir, 'unknown');
  assert.deepEqual(
    context.contextPackSkeleton.fileSet.files.map((file) => file.path).sort(),
    R2P_EDITABLE_DOCS.map((doc) => projectRelative(root, wfDir, doc)).sort()
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

  // The validated final output references the owning upstream stage for the finding.
  assert.match(finalized.finalResponse.deferralsOrBlockers, /\bspec\b/);

  // NOTHING was modified: no 03–07 file, no run.md, no .drfx state.
  assert.deepEqual(changedFiles(wfDir, before), []);
  assert.equal(fs.existsSync(path.join(root, '.drfx')), false);
});

test('r2p advisory record-review blocks when protected run.md drifts after context', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260624-advisory-drift';
  const wfDir = makeWfDir(root, workId);
  const commonArgs = r2pArgs(workId);
  const opts = { cwd: root, homeDir, env: installFakeR2pCli(root, workId) };

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
// Generated route prompt/package carries the finding->ownerStage map.
// ---------------------------------------------------------------------------

function renderedR2pRoutePackage(platform) {
  if (platform !== 'codex') {
    return renderPlatformRoute(platform, 'review-fix-r2p', { packageVersion: '0.0.0-snapshot' });
  }

  const packageFiles = generatePlatformFiles('codex', { packageVersion: '0.0.0-snapshot' });
  const r2pSkill = packageFiles.find((entry) => entry.routeName === 'review-fix-r2p');
  assert.ok(r2pSkill, 'codex r2p skill package exists');
  return r2pSkill.files.map((file) => file.content).join('\n');
}

test('generated r2p route prompt/package carries the finding-to-ownerStage map', () => {
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    const rendered = renderedR2pRoutePackage(platform);
    assert.match(rendered, /finding-to-ownerStage map/i, `${platform} r2p prompt must carry the map heading`);
    assert.match(rendered, /raw requirement conflict[\s\S]*?-> `raw_requirement`/, `${platform}: raw_requirement mapping`);
    assert.match(rendered, /unclear scope, goal, non-goal, or acceptance direction[\s\S]*?-> `requirement_brief`/, `${platform}: requirement_brief mapping`);
    assert.match(rendered, /risk, rollback, change-management, security, or dependency gap[\s\S]*?-> `risk_discovery`/, `${platform}: risk_discovery mapping`);
    assert.match(rendered, /architecture, interface, module-boundary, or implementation-strategy issue[\s\S]*?-> `design`/, `${platform}: design mapping`);
    assert.match(rendered, /insufficient observable behavior, acceptance, or verification criteria[\s\S]*?-> `spec`/, `${platform}: spec mapping`);
    assert.match(rendered, /pure task decomposition, ordering, command, or plan-local issue[\s\S]*?-> `plan`/, `${platform}: plan mapping`);
  }
});

// ---------------------------------------------------------------------------
// Status-contract / workspace gating.
// ---------------------------------------------------------------------------

test('r2p advisory follows the status command and does not gate on run.md prose alone', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260624-incomplete';
  makeWfDir(root, workId, { runMd: planIncompleteRunMd });
  const commonArgs = r2pArgs(workId);
  const opts = { cwd: root, homeDir, env: installFakeR2pCli(root, workId) };

  const context = await runWorkflowCommand('context', ['--no-state', ...commonArgs], opts);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(context.status, 'context');

  const review = await runWorkflowCommand('record-review', [
    '--no-state',
    ...commonArgs,
    '--review-guard',
    context.reviewGuard,
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_FAIL });
  assert.equal(review.ok, true, JSON.stringify(review));
  assert.equal(review.status, 'recorded-review');
});

test('r2p advisory blocks on an archive-only workId before reviewer-recording', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260624-archived';
  makeWfDir(root, workId, { underArchive: true });
  const commonArgs = r2pArgs(workId);
  const opts = { cwd: root, homeDir, env: installFakeR2pCli(root, workId) };

  const context = await runWorkflowCommand('context', ['--no-state', ...commonArgs], opts);
  assert.equal(context.ok, false, JSON.stringify(context));
  assert.equal(context.status, 'blocked');
  assert.equal(context.errorCode, 'ERR_R2P_WORK_ID_ARCHIVED');
  assert.equal(context.blockingReason, 'r2p-run-archived');

  const review = await runWorkflowCommand('record-review', [
    '--no-state',
    ...commonArgs,
    '--review-guard',
    'placeholder-guard',
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_FAIL });
  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.status, 'blocked');
  assert.equal(review.errorCode, 'ERR_R2P_WORK_ID_ARCHIVED');
  assert.notEqual(review.status, 'recorded-review');
});

test('r2p advisory context preserves resolver-specific blockers', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const missingWorkId = 'WF-20260624-missing';
  const missingArgs = r2pArgs(missingWorkId);
  const missingContext = await runWorkflowCommand('context', ['--no-state', ...missingArgs], {
    cwd: root,
    homeDir,
    env: installFakeR2pCli(root, missingWorkId)
  });
  assert.equal(missingContext.ok, false, JSON.stringify(missingContext));
  assert.equal(missingContext.blockingReason, 'r2p-workspace-not-found');

  const unsafeWorkId = 'WF-20260624-unsafe-artifact';
  const wfDir = makeWfDir(root, unsafeWorkId);
  fs.rmSync(path.join(wfDir, '06-spec.md'));
  fs.symlinkSync(path.join(wfDir, '07-plan.md'), path.join(wfDir, '06-spec.md'));
  const unsafeContext = await runWorkflowCommand('context', ['--no-state', ...r2pArgs(unsafeWorkId)], {
    cwd: root,
    homeDir,
    env: installFakeR2pCli(root, unsafeWorkId)
  });
  assert.equal(unsafeContext.ok, false, JSON.stringify(unsafeContext));
  assert.equal(unsafeContext.blockingReason, 'r2p-artifact-missing-or-unsafe');
});
