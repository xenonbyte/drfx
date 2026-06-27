'use strict';

// PLAN-TASK-001
//
// RED contract suite for the new workId-based review-fix-r2p route. These tests
// are intentionally ahead of the implementation tasks that will make them pass.
// Their job in this task is to:
// 1. name the gate 1-10 / redaction / drift cases explicitly;
// 2. provide a fake req-to-plan CLI harness that emits documented R2P_JSON payloads;
// 3. execute under `node --test test/r2p-route.test.js` so later tasks can turn the
//    suite green incrementally.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runWorkflowCommand, parseWorkflowArgs } = require('../lib/workflow');

const REVIEW_FAIL = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: 07-plan.md#repair',
  '  issue: The plan depends on an upstream decision that is not owned by the current stage.',
  '  why_it_matters: The run cannot truthfully PASS until r2p regenerates the staged artifacts.',
  '  suggested_fix: Route the finding back to the owning stage through the r2p lifecycle.',
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
  '  rationale: The finding is real and should drive an r2p repair command.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

const REVIEW_PASS = 'PASS\nSummary: No blocking findings after r2p regeneration.\n';

const FINAL_PASS = [
  'Final status: pass',
  'Assurance: practical',
  'Runtime platform: codex',
  'Mode: review-and-fix',
  'Target: none',
  'Files changed: none',
  'Fixed issue IDs: none',
  'Verification performed: full re-review after r2p regeneration',
  'Deferrals or blockers: none',
  'Blocking reason: none',
  'Status reason: none',
  'Residual risk: none identified',
  'Redaction statement: no sensitive values persisted',
  'Coordinator agreement: approved after full re-review'
].join('\n');

const R2P_ARTIFACTS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

function makeSandbox(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-route-')));
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-route-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { root, homeDir };
}

function makeRun(root, workId, options = {}) {
  const {
    underArchive = false,
    runMd = '# Requirement Run\n',
    artifactNames = R2P_ARTIFACTS
  } = options;
  const parent = underArchive
    ? path.join(root, '.req-to-plan', 'archive')
    : path.join(root, '.req-to-plan');
  const runDir = path.join(parent, workId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.md'), runMd);
  for (const artifact of artifactNames) {
    fs.writeFileSync(path.join(runDir, artifact), `# ${artifact}\ncontent for ${artifact}\n`);
  }
  return runDir;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function installFakeR2pCli(root, scripts = {}) {
  const binDir = path.join(root, 'fake-r2p-bin');
  const logDir = path.join(root, 'fake-r2p-logs');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const defaults = {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(logDir, 'r2p-status.log')}"`,
      'if [ "${R2P_JSON:-}" != "1" ]; then',
      '  printf "status without json\\n"',
      '  exit 0',
      'fi',
      `printf "%s\\n" '${JSON.stringify({
        work_id: 'WF-20260627-demo',
        status: 'closed_at_plan_checkpoint',
        current_stage: 'plan',
        open_routes_detail: []
      })}'`
    ].join('\n'),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(logDir, 'r2p-reopen.log')}"`,
      `printf "%s\\n" '${JSON.stringify({ new_work_id: 'WF-20260627-demo-r1' })}'`
    ].join('\n'),
    'r2p-gap-open': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(logDir, 'r2p-gap-open.log')}"`,
      `printf "%s\\n" '${JSON.stringify({
        route_id: 'ROUTE-001',
        staled_stages: ['design', 'spec', 'plan']
      })}'`
    ].join('\n'),
    'r2p-continue': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(logDir, 'r2p-continue.log')}"`,
      'printf "%s\\n" "{\\"ok\\":true}"'
    ].join('\n')
  };

  for (const command of ['r2p-status', 'r2p-reopen', 'r2p-gap-open', 'r2p-continue']) {
    writeExecutable(path.join(binDir, command), scripts[command] || defaults[command]);
  }

  return { binDir, logDir };
}

function statusScript(payload, options = {}) {
  const lines = ['#!/bin/sh', 'set -eu'];
  if (options.stderr) {
    lines.push(`printf "%s\\n" '${options.stderr}' 1>&2`);
  }
  lines.push(`printf "%s\\n" '${JSON.stringify(payload)}'`);
  return lines.join('\n');
}

function runtimeArgs(routeTokens, overrides = {}) {
  const {
    assurance = 'practical',
    runtimePlatform = 'codex',
    subagent = 'ready',
    stdin = 'ready'
  } = overrides;
  return [
    ...routeTokens,
    '--assurance',
    assurance,
    '--runtime-platform',
    runtimePlatform,
    '--runtime-subagent-probe',
    subagent,
    '--runtime-stdin-handoff',
    stdin,
    '--json'
  ];
}

function workflowInvocation(workId, extraTokens = []) {
  return runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    'review-and-fix',
    ...extraTokens
  ]);
}

async function startFor(root, homeDir, workId, extraTokens = [], overrides = {}) {
  return runWorkflowCommand(
    'start',
    workflowInvocation(workId, extraTokens),
    {
      cwd: root,
      homeDir,
      env: overrides.env
    }
  );
}

async function contextFor(root, homeDir, workId, extraTokens = [], overrides = {}) {
  return runWorkflowCommand(
    'context',
    workflowInvocation(workId, extraTokens),
    {
      cwd: root,
      homeDir,
      env: overrides.env
    }
  );
}

async function recordReviewFor(root, homeDir, workId, extraTokens = [], overrides = {}) {
  return runWorkflowCommand(
    'record-review',
    [
      ...workflowInvocation(workId, extraTokens),
      '--phase',
      'initial-review',
      '--result-stdin'
    ],
    {
      cwd: root,
      homeDir,
      stdin: REVIEW_FAIL,
      env: overrides.env
    }
  );
}

async function recordReviewPassFor(root, homeDir, workId, extraTokens = [], overrides = {}) {
  return runWorkflowCommand(
    'record-review',
    [
      ...workflowInvocation(workId, extraTokens),
      '--phase',
      'initial-review',
      '--result-stdin'
    ],
    {
      cwd: root,
      homeDir,
      stdin: REVIEW_PASS,
      env: overrides.env
    }
  );
}

async function recordTriageFor(root, homeDir, workId, extraTokens = [], overrides = {}) {
  return runWorkflowCommand(
    'record-triage',
    [
      ...workflowInvocation(workId, extraTokens),
      '--triage-stdin'
    ],
    {
      cwd: root,
      homeDir,
      stdin: TRIAGE_ACCEPT,
      env: overrides.env
    }
  );
}

async function reachAcceptedRepairState(root, homeDir, workId, extraTokens = [], overrides = {}) {
  const start = await startFor(root, homeDir, workId, extraTokens, overrides);
  assert.equal(start.ok, true, JSON.stringify(start));

  const review = await recordReviewFor(root, homeDir, workId, extraTokens, overrides);
  assert.equal(review.ok, true, JSON.stringify(review));

  const triage = await recordTriageFor(root, homeDir, workId, extraTokens, overrides);
  assert.equal(triage.ok, true, JSON.stringify(triage));

  return { start, review, triage };
}

test('gate1 invocation accept/reject incl. archive-bypass and flag-injection', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate1';
  makeRun(root, workId);

  const accepted = parseWorkflowArgs('start', workflowInvocation(workId));
  assert.equal(accepted.invocation.routeKind, 'r2p');
  assert.equal(accepted.invocation.workId, workId);

  const shorthand = parseWorkflowArgs('start', runtimeArgs([
    'review-fix-r2p',
    workId,
    'review-and-fix'
  ]));
  assert.equal(shorthand.invocation.workId, workId);

  for (const tokens of [
    ['review-fix-r2p', `target=.req-to-plan/${workId}`, 'review-and-fix'],
    ['review-fix-r2p', `.req-to-plan/${workId}`, 'review-and-fix'],
    ['review-fix-r2p', '07-plan.md', 'review-and-fix'],
    ['review-fix-r2p', `workId=archive/${workId}`, 'review-and-fix'],
    ['review-fix-r2p', `workId=../${workId}`, 'review-and-fix'],
    ['review-fix-r2p', 'workId=--from=WF-evil', 'review-and-fix'],
    ['review-fix-r2p', `workId=${workId}`, `workId=${workId}-dup`, 'review-and-fix'],
    ['review-fix-r2p', workId, `${workId}-dup`, 'review-and-fix'],
    ['review-fix-r2p', `workId=${workId}`, 'read-only', 'review-and-fix'],
    ['review-fix-r2p', `workId=${workId}`, 'resume', 'reset'],
    ['review-fix-r2p', `workId=${workId}`, 'rounds=2']
  ]) {
    await assert.rejects(async () => runWorkflowCommand('start', runtimeArgs(tokens), { cwd: root, homeDir }));
  }
});

test('gate2 command-env + R2P_JSON probe', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate2';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      'printf "not-json\\n"'
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const blocked = await startFor(root, homeDir, workId, [], { env });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockingReason, 'r2p-json-contract-unavailable');

  fs.rmSync(path.join(fake.binDir, 'r2p-gap-open'));
  const missing = await startFor(root, homeDir, workId, [], { env });
  assert.equal(missing.ok, false);
  assert.equal(missing.blockingReason, 'r2p-command-unavailable');
});

test('gate3 workspace preflight', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate3';
  const fake = installFakeR2pCli(root);
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const missingWorkspace = await startFor(root, homeDir, workId, [], { env });
  assert.equal(missingWorkspace.ok, false);
  assert.equal(missingWorkspace.blockingReason, 'r2p-workspace-not-found');

  makeRun(root, workId, { underArchive: true });
  const archiveOnly = await startFor(root, homeDir, workId, [], { env });
  assert.equal(archiveOnly.ok, false);
  assert.equal(archiveOnly.blockingReason, 'r2p-run-archived');

  makeRun(root, workId);
  const conflict = await startFor(root, homeDir, workId, [], { env });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.blockingReason, 'r2p-work-id-conflict');
});

test('gate4 artifact preflight', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate4';
  const fake = installFakeR2pCli(root);
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const runDir = makeRun(root, workId);

  fs.rmSync(path.join(runDir, '06-spec.md'));
  const missingArtifact = await startFor(root, homeDir, workId, [], { env });
  assert.equal(missingArtifact.ok, false);
  assert.equal(missingArtifact.blockingReason, 'r2p-artifact-missing-or-unsafe');

  fs.writeFileSync(path.join(runDir, '06-spec.md'), '# 06-spec.md\nrestored\n');
  fs.rmSync(path.join(runDir, 'run.md'));
  fs.symlinkSync(path.join(runDir, '07-plan.md'), path.join(runDir, 'run.md'));
  const symlinkArtifact = await startFor(root, homeDir, workId, [], { env });
  assert.equal(symlinkArtifact.ok, false);
  assert.equal(symlinkArtifact.blockingReason, 'r2p-artifact-missing-or-unsafe');
});

test('gate5 no-direct-write both directions (drfx fails; r2p-authored change allowed)', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5';
  const runDir = makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    }),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(root, 'fake-r2p-logs', 'r2p-reopen.log')}"`,
      `printf "%s\\n" "r2p-side-effect" >> "${path.join(runDir, '07-plan.md')}"`,
      `printf "%s\\n" '${JSON.stringify({ new_work_id: 'WF-20260627-gate5-r1' })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true);
  assert.equal(context.contextPackSkeleton.editableFiles.length, 0);
  assert.equal(context.contextPackSkeleton.directArtifactWrites, 'forbidden');

  const review = await recordReviewFor(root, homeDir, workId, [], { env });
  assert.equal(review.ok, true);
  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, true);

  const beginFix = await runWorkflowCommand('begin-fix', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(beginFix.ok, false);
  assert.equal(beginFix.blockingReason, 'r2p-direct-artifact-write-forbidden');

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true, JSON.stringify(repairPlan));

  const apply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.match(fs.readFileSync(path.join(runDir, '07-plan.md'), 'utf8'), /r2p-side-effect/);
});

test('gate6 repair exec argv shell:false; capture new_work_id/route_id; checkpoint, no PASS', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate6';
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(root, 'fake-r2p-logs', 'r2p-status.log')}"`,
      `printf "%s\\n" '${JSON.stringify({
        work_id: workId,
        status: 'closed_at_plan_checkpoint',
        current_stage: 'plan',
        open_routes_detail: []
      })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  makeRun(root, workId);

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true);
  const review = await recordReviewFor(root, homeDir, workId, [], { env });
  assert.equal(review.ok, true);
  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, true);

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true);
  assert.equal(repairPlan.commandKind, 'r2p-reopen');

  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true);
  assert.equal(apply.status, 'checkpoint');
  assert.equal(apply.statusReason, 'r2p-repair-applied');
  assert.equal(apply.newWorkId, 'WF-20260627-demo-r1');
});

test('gate7 rerun-PASS only after clean re-review', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate7';
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  makeRun(root, workId);

  const { start } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true, JSON.stringify(repairPlan));

  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));

  const sameRoundFinal = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'], {
    cwd: root,
    homeDir,
    stdin: FINAL_PASS,
    env
  });
  assert.notEqual(sameRoundFinal.status, 'pass');
  assert.equal(sameRoundFinal.statusReason, 'r2p-repair-applied');

  const rerunWorkId = apply.newWorkId || workId;
  makeRun(root, rerunWorkId);
  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: rerunWorkId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const rerunStart = await startFor(root, homeDir, rerunWorkId, [], { env });
  assert.equal(rerunStart.ok, true, JSON.stringify(rerunStart));

  const rerunContext = await contextFor(root, homeDir, rerunWorkId, [], { env });
  assert.equal(rerunContext.ok, true, JSON.stringify(rerunContext));

  const rerunReview = await recordReviewPassFor(root, homeDir, rerunWorkId, [], { env });
  assert.equal(rerunReview.ok, true, JSON.stringify(rerunReview));

  const rerunFinal = await runWorkflowCommand('finalize', [rerunStart.targetStateDir, '--final-response-stdin', '--json'], {
    cwd: root,
    homeDir,
    stdin: FINAL_PASS,
    env
  });
  assert.equal(rerunFinal.ok, true, JSON.stringify(rerunFinal));
  assert.equal(rerunFinal.status, 'pass');
});

test('gate8 status-contract parses multiple owner stages; missing contract blocks', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate8';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" '${JSON.stringify({
        work_id: workId,
        status: 'open',
        current_stage: 'plan',
        open_routes_detail: [
          { route_id: 'ROUTE-001', owner_stage: 'design', required_action: 'clarify design' },
          { route_id: 'ROUTE-002', owner_stage: 'spec', required_action: 'tighten spec' }
        ]
      })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true);
  assert.deepEqual(context.contextPackSkeleton.openRouteOwnerStages, ['design', 'spec']);

  writeExecutable(path.join(fake.binDir, 'r2p-status'), '#!/bin/sh\nset -eu\nprintf "oops\\n"\n');
  const blocked = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockingReason, 'r2p-json-contract-unavailable');
});

test('gate9 current-stage checkpoint', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate9';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" '${JSON.stringify({
        work_id: workId,
        status: 'open',
        current_stage: 'spec',
        open_routes_detail: [
          { route_id: 'ROUTE-001', owner_stage: 'spec', required_action: 'tighten spec wording' }
        ]
      })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true);
  const review = await recordReviewFor(root, homeDir, workId, [], { env });
  assert.equal(review.ok, true);
  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, true);

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true);
  assert.equal(repairPlan.status, 'checkpoint');
  assert.equal(repairPlan.statusReason, 'r2p-current-stage-repair-required');
});

test('gate10 earliest-stage aggregation + r2p-repair-plan-ambiguous', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate10';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" '${JSON.stringify({
        work_id: workId,
        status: 'open',
        current_stage: 'plan',
        open_routes_detail: [
          { route_id: 'ROUTE-001', owner_stage: 'requirement_brief', required_action: 'clarify scope' },
          { route_id: 'ROUTE-002', owner_stage: 'design', required_action: 'tighten architecture' }
        ]
      })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true);
  const review = await recordReviewFor(root, homeDir, workId, [], { env });
  assert.equal(review.ok, true);
  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, true);

  const aggregated = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(aggregated.ok, true);
  assert.equal(aggregated.ownerStage, 'requirement_brief');
  assert.deepEqual(aggregated.issueIds, ['ISSUE-001']);

  const ambiguous = await runWorkflowCommand('record-r2p-repair-plan', [
    start.targetStateDir,
    '--payload-stdin',
    '--json'
  ], {
    cwd: root,
    homeDir,
    env,
    stdin: JSON.stringify({
      accepted_findings: [
        { issue_id: 'ISSUE-001', owner_stage: 'unknown-stage' }
      ]
    })
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.blockingReason, 'r2p-repair-plan-ambiguous');
});

test('redaction receipt omits raw reason/secrets', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-redaction';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    }),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      'printf "%s\\n" "SECRET_TOKEN=sk-live-redaction raw required_action=password" 1>&2',
      `printf "%s\\n" '${JSON.stringify({ new_work_id: 'WF-20260627-redaction-r1' })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const { start } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true, JSON.stringify(repairPlan));

  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true);
  const receipt = fs.readFileSync(apply.receiptPath, 'utf8');
  assert.doesNotMatch(receipt, /SECRET_TOKEN|sk-live|password/i);
  assert.doesNotMatch(receipt, /raw required_action/i);
});

test('drift guard blocks instead of executing', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-drift';
  const runDir = makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const { start } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true, JSON.stringify(repairPlan));

  fs.appendFileSync(path.join(runDir, '07-plan.md'), '\ndrifted after review\n');

  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, false);
  assert.equal(apply.blockingReason, 'r2p-drift-detected');
});
