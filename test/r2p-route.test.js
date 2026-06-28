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
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getRouteDescriptor } = require('../lib/routes');
const { runWorkflowCommand, parseWorkflowArgs } = require('../lib/workflow');
const {
  resolveR2pCommands,
  probeJsonContract,
  readRunStatus,
  mapRepairMode,
  buildRepairPlan,
  driftGuard,
  runRepairCommand,
  writeReceipt
} = require('../lib/workflow/r2p-repair');
const { resolveRouteTargetMetadata } = require('../lib/workflow/target-resolution');
const { computeFileSetFingerprint } = require('../lib/target-context');

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

const TRIAGE_ACCEPT_MULTI = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: accepted',
  '  severity: high',
  '  original_severity: high',
  '  rationale: The requirement brief gap is real and should route upstream.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false',
  '- reviewer_id: R002',
  '  issue_id: ISSUE-002',
  '  decision: accepted',
  '  severity: medium',
  '  original_severity: medium',
  '  rationale: The design-stage gap is also real and should aggregate into the same repair plan.',
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

function captureRunFingerprints(runDir) {
  const runMdSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(runDir, 'run.md'), 'utf8'))
    .digest('hex');
  return {
    runMdSha256,
    fileSetFingerprint: computeFileSetFingerprint(R2P_ARTIFACTS.map((artifact) => ({
      path: artifact,
      status: 'modified',
      contentId: crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(runDir, artifact), 'utf8'))
        .digest('hex')
    })))
  };
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
      stdin: overrides.stdin || TRIAGE_ACCEPT,
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

test('descriptor fields expose r2p repair policy and no defaultGuard', () => {
  const descriptor = getRouteDescriptor('review-fix-r2p');
  assert.equal(descriptor.routeName, 'review-fix-r2p');
  assert.equal(descriptor.artifactWritePolicy, 'forbidden');
  assert.equal(descriptor.repairPolicy, 'r2p-lifecycle');
  assert.deepEqual(descriptor.repairCommands, ['r2p-reopen', 'r2p-gap-open']);
  assert.equal('defaultGuard' in descriptor, false);
});

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
    const blocked = await runWorkflowCommand('start', runtimeArgs(tokens), { cwd: root, homeDir });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockingReason, 'invalid-r2p-invocation');
    assert.equal(blocked.nextAction, 'rerun as review-fix-r2p workId=<WF-...>');
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

  fs.rmSync(path.join(root, '.req-to-plan'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'real-workspace'), { recursive: true });
  fs.symlinkSync(path.join(root, 'real-workspace'), path.join(root, '.req-to-plan'));
  const symlinkWorkspace = await startFor(root, homeDir, workId, [], { env });
  assert.equal(symlinkWorkspace.ok, false);
  assert.equal(symlinkWorkspace.blockingReason, 'unsafe-r2p-workspace');

  fs.rmSync(path.join(root, '.req-to-plan'), { recursive: true, force: true });
  makeRun(root, workId, { underArchive: true });
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

test('gate4 stable target key stays content-independent for the same workId', async (t) => {
  const { root } = makeSandbox(t);
  const workId = 'WF-20260627-stable-key';
  const otherWorkId = 'WF-20260627-stable-key-r1';
  const runDir = makeRun(root, workId);
  makeRun(root, otherWorkId);

  const parsed = parseWorkflowArgs('start', workflowInvocation(workId));
  const first = resolveRouteTargetMetadata(parsed, { cwd: root, rootCwd: root });
  fs.appendFileSync(path.join(runDir, '07-plan.md'), '\nregenerated content\n');
  const second = resolveRouteTargetMetadata(parsed, { cwd: root, rootCwd: root });

  assert.equal(first.targetKey, second.targetKey);

  const otherParsed = parseWorkflowArgs('start', workflowInvocation(otherWorkId));
  const other = resolveRouteTargetMetadata(otherParsed, { cwd: root, rootCwd: root });
  assert.notEqual(first.targetKey, other.targetKey);
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

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));

  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true);
  assert.equal(context.contextPackSkeleton.runLocation, `.req-to-plan/${workId}`);
  assert.deepEqual(context.contextPackSkeleton.reviewFiles, [
    '03-requirement-brief.md',
    '04-risk-discovery.md',
    '05-design.md',
    '06-spec.md',
    '07-plan.md'
  ]);
  assert.equal(context.contextPackSkeleton.editableFiles.length, 0);
  assert.equal(context.contextPackSkeleton.directArtifactWrites, 'forbidden');
  assert.equal(context.contextPackSkeleton.repairMode.command_kind, 'r2p-reopen');

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

  const originalPlan = fs.readFileSync(path.join(runDir, '07-plan.md'), 'utf8');
  fs.appendFileSync(path.join(runDir, '07-plan.md'), '\ndrifted after triage\n');
  const driftedApply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(driftedApply.ok, false, JSON.stringify(driftedApply));
  assert.equal(driftedApply.blockingReason, 'r2p-drift-detected');
  fs.writeFileSync(path.join(runDir, '07-plan.md'), originalPlan);
});

test('gate5 r2p-authored change after apply-r2p-repair is allowed', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5-apply';
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
      `printf "%s\\n" '${JSON.stringify({ new_work_id: 'WF-20260627-gate5-apply-r1' })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const { triage } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
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
  const workId = 'WF-20260627-gate6-reopen';
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(root, 'fake-r2p-logs', 'r2p-status.log')}"`,
      `printf "%s\\n" '${JSON.stringify([{
        work_id: workId,
        status: 'closed_at_plan_checkpoint',
        current_stage: 'plan',
        open_routes_detail: []
      }])}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  makeRun(root, workId);
  const paths = resolveR2pCommands({ env, homeDir });
  await probeJsonContract(paths, { cwd: root, env, homeDir });
  const reopenStatus = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  const reopenFindings = [
    { issue_id: 'ISSUE-001', owner_stage: 'design', reason: 'Need upstream design repair.' }
  ];
  const reopenMode = mapRepairMode(reopenStatus, reopenStatus.currentStage, reopenFindings);
  const reopenPlan = buildRepairPlan(reopenFindings, reopenMode, reopenStatus.currentStage, { workId });
  assert.equal(reopenPlan.command_kind, 'r2p-reopen');

  const apply = await runRepairCommand(paths, reopenPlan, { cwd: root, env, homeDir });
  assert.equal(apply.status, 'checkpoint');
  assert.equal(apply.statusReason, 'r2p-repair-applied');
  assert.equal(apply.newWorkId, 'WF-20260627-demo-r1');
  assert.match(apply.nextAction, /r2p-continue/);

  const reopenLog = fs.readFileSync(path.join(fake.logDir, 'r2p-reopen.log'), 'utf8');
  assert.match(reopenLog, /r2p-reopen/);
  assert.match(reopenLog, /R2P_JSON=1/);
  assert.match(reopenLog, new RegExp(`--from ${workId}`));

  const gapWorkId = 'WF-20260627-gate6-gap-open';
  makeRun(root, gapWorkId);
  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(fake.logDir, 'r2p-status.log')}"`,
      `printf "%s\\n" '${JSON.stringify([{
        work_id: gapWorkId,
        status: 'active_stage_draft',
        current_stage: 'plan',
        open_routes_detail: [
          { route_id: 'ROUTE-001', owner_stage: 'design', required_action: 'clarify design constraints' }
        ]
    }])}'`
  ].join('\n'));
  const gapStatus = await readRunStatus(paths, gapWorkId, { cwd: root, env, homeDir });
  const gapFindings = [
    { issue_id: 'ISSUE-001', owner_stage: 'design', required_action: 'Clarify design constraints.' }
  ];
  const gapMode = mapRepairMode(gapStatus, gapStatus.currentStage, gapFindings);
  const gapPlan = buildRepairPlan(gapFindings, gapMode, gapStatus.currentStage, { workId: gapWorkId });
  assert.equal(gapPlan.command_kind, 'r2p-gap-open');

  const gapApply = await runRepairCommand(paths, gapPlan, { cwd: root, env, homeDir });
  assert.equal(gapApply.status, 'checkpoint');
  assert.equal(gapApply.statusReason, 'r2p-repair-applied');
  assert.equal(gapApply.routeId, 'ROUTE-001');
  assert.match(gapApply.nextAction, new RegExp(`review-fix-r2p workId=${gapWorkId}`));
  assert.match(gapApply.nextAction, /r2p-continue/);

  const gapOpenLog = fs.readFileSync(path.join(fake.logDir, 'r2p-gap-open.log'), 'utf8');
  assert.match(gapOpenLog, /r2p-gap-open/);
  assert.match(gapOpenLog, /R2P_JSON=1/);
  assert.match(gapOpenLog, new RegExp(`--work-id ${gapWorkId}`));
  assert.match(gapOpenLog, /--confirm/);
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

  const maliciousFinalizeBody = [
    '# Round 001 R2p-repair Receipt',
    '',
    '- Round: 1',
    '- Kind: r2p-repair',
    '- Status: checkpoint',
    `- Target: workId=${workId}`,
    '',
    '## Summary',
    `New work ID: ${apply.newWorkId || workId}`,
    '',
    '## Next Action',
    'run MALICIOUS finalize next action',
    ''
  ].join('\n');
  const maliciousFinalizeTarget = path.join(root, 'malicious-finalize-receipt.md');
  fs.writeFileSync(maliciousFinalizeTarget, maliciousFinalizeBody);
  fs.symlinkSync(
    maliciousFinalizeTarget,
    path.join(start.targetStateDir, 'rounds', '001-aaa-malicious.md')
  );

  const sameRoundFinal = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'], {
    cwd: root,
    homeDir,
    stdin: FINAL_PASS,
    env
  });
  assert.notEqual(sameRoundFinal.status, 'pass');
  assert.equal(sameRoundFinal.statusReason, 'r2p-repair-applied');
  assert.notEqual(sameRoundFinal.nextAction, 'run MALICIOUS finalize next action');

  const rerunWorkId = apply.newWorkId || workId;
  assert.ok(apply.receiptId, 'expected apply-r2p-repair to expose a stable receipt id');
  const rogueTargetDir = path.join(root, '.drfx', 'targets', 'rogue-target');
  const rogueRoundsDir = path.join(rogueTargetDir, 'rounds');
  fs.mkdirSync(rogueRoundsDir, { recursive: true });
  const maliciousLinkBody = [
    '# Round 001 R2p-repair Receipt',
    '',
    '- Round: 1',
    '- Kind: r2p-repair',
    '- Status: checkpoint',
    '- Target: workId=WF-malicious-prior',
    '',
    '## Summary',
    `New work ID: ${rerunWorkId}`,
    '',
    '## Next Action',
    'run MALICIOUS reopen linkage',
    ''
  ].join('\n');
  const maliciousLinkTarget = path.join(root, 'malicious-link-receipt.md');
  fs.writeFileSync(maliciousLinkTarget, maliciousLinkBody);
  fs.symlinkSync(maliciousLinkTarget, path.join(rogueRoundsDir, '001-r2p-repair.md'));
  makeRun(root, rerunWorkId);
  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: rerunWorkId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const rerunStart = await startFor(root, homeDir, rerunWorkId, [], { env });
  assert.equal(rerunStart.ok, true, JSON.stringify(rerunStart));
  if (rerunWorkId !== workId) {
    assert.equal(rerunStart.priorWorkId, workId);
    assert.equal(rerunStart.priorReceiptId, apply.receiptId);
    assert.equal(fs.existsSync(rerunStart.linkageReceiptPath), true);
  }

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

test('gate7 resume keeps same-workId r2p repair receipts across regenerated artifacts', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate7-gap-open';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'active_stage_draft',
      current_stage: 'plan',
      open_routes_detail: [
        { route_id: 'ROUTE-001', owner_stage: 'design', required_action: 'clarify design constraints' }
      ]
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const { start } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));
  const receiptDir = path.join(start.targetStateDir, 'rounds');
  const beforeResumeReceipts = fs.readdirSync(receiptDir).filter((entry) => /r2p-repair/.test(entry));
  assert.ok(beforeResumeReceipts.length > 0);

  fs.appendFileSync(path.join(root, '.req-to-plan', workId, '07-plan.md'), '\nregenerated by r2p\n');
  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: workId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const resumed = await startFor(root, homeDir, workId, ['resume'], { env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.status, 'review');
  assert.equal(resumed.statusReason, 'r2p-repair-applied');
  assert.equal(resumed.targetStateDir, start.targetStateDir);
  const afterResumeReceipts = fs.readdirSync(receiptDir).filter((entry) => /r2p-repair/.test(entry));
  assert.deepEqual(afterResumeReceipts, beforeResumeReceipts);
});

test('gate7 Gemini remains advisory-only and never enters persistent PASS flow', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate7-gemini';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root);
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await runWorkflowCommand('start', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    'review-and-fix'
  ], {
    assurance: 'advisory',
    runtimePlatform: 'gemini',
    subagent: 'not-required',
    stdin: 'not-required'
  }), {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(start.status, 'unsupported');
  assert.equal(start.targetStateDir, undefined);
});

test('gate8 status-contract parses multiple owner stages; missing contract blocks', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate8';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" '${JSON.stringify([{
        work_id: workId,
        status: 'checkpoint_review',
        current_stage: 'plan',
        open_routes_detail: [
          { route_id: 'ROUTE-001', owner_stage: 'design', required_action: 'clarify design' },
          { route_id: 'ROUTE-002', owner_stage: 'spec', required_action: 'tighten spec' }
        ]
      }])}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const paths = resolveR2pCommands({ env, homeDir });
  const status = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  assert.deepEqual(status.openRouteOwnerStages, ['design', 'spec']);
  const mode = mapRepairMode(status, status.currentStage, [
    { issue_id: 'ISSUE-001', owner_stage: 'design', required_action: 'Clarify design.' }
  ]);
  assert.equal(mode.command_kind, 'r2p-gap-open');

  writeExecutable(path.join(fake.binDir, 'r2p-status'), '#!/bin/sh\nset -eu\nprintf "oops\\n"\n');
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      current_stage: 'plan',
      open_routes_detail: []
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      status: 'checkpoint_review',
      current_stage: 'bogus',
      open_routes_detail: []
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      status: 'checkpoint_review',
      current_stage: 'plan'
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      status: 'checkpoint_review',
      current_stage: 'plan',
      open_routes_detail: {}
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      status: 'checkpoint_review',
      current_stage: 'plan',
      open_routes_detail: [
        { route_id: 'ROUTE-003', owner_stage: 'bogus', required_action: 'bad owner stage' }
      ]
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      status: 'checkpoint_review',
      current_stage: 'plan',
      open_routes_detail: [
        { route_id: 'ROUTE-004', required_action: 'missing owner stage' }
      ]
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );
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
      `printf "%s\\n" '${JSON.stringify([{
        work_id: workId,
        status: 'open',
        current_stage: 'plan',
        open_routes_detail: [
          { route_id: 'ROUTE-001', owner_stage: 'requirement_brief', required_action: 'clarify scope' },
          { route_id: 'ROUTE-002', owner_stage: 'design', required_action: 'tighten architecture' }
        ]
      }])}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const paths = resolveR2pCommands({ env, homeDir });
  const status = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  const findings = [
    { issue_id: 'ISSUE-001', owner_stage: 'requirement_brief', required_action: 'Clarify scope.' },
    { issue_id: 'ISSUE-002', owner_stage: 'design', required_action: 'Tighten architecture.' }
  ];
  const mode = mapRepairMode(status, status.currentStage, findings);
  const aggregated = buildRepairPlan(findings, mode, status.currentStage, { workId });
  assert.equal(aggregated.owner_stage, 'requirement_brief');
  assert.deepEqual(aggregated.issue_ids, ['ISSUE-001', 'ISSUE-002']);

  assert.throws(
    () => buildRepairPlan(
      [{ issue_id: 'ISSUE-001', owner_stage: 'unknown-stage', required_action: 'broken' }],
      mode,
      status.currentStage,
      { workId }
    ),
    (error) => error && error.blockingReason === 'r2p-repair-plan-ambiguous'
  );
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
  const paths = resolveR2pCommands({ env, homeDir });
  const status = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  const findings = [
    { issue_id: 'ISSUE-001', owner_stage: 'design', reason: 'reason=super-secret-password' }
  ];
  const mode = mapRepairMode(status, status.currentStage, findings);
  const plan = buildRepairPlan(findings, mode, status.currentStage, { workId });
  const apply = await runRepairCommand(paths, plan, { cwd: root, env, homeDir });
  const receiptPath = path.join(root, 'r2p-repair-receipt.md');
  const receipt = writeReceipt({ ...apply, receiptPath }).receiptText;
  assert.doesNotMatch(receipt, /SECRET_TOKEN|sk-live|password/i);
  assert.doesNotMatch(receipt, /raw required_action/i);
  assert.equal(fs.existsSync(receiptPath), true);
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
  const paths = resolveR2pCommands({ env, homeDir });
  const status = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  const findings = [
    { issue_id: 'ISSUE-001', owner_stage: 'design', reason: 'Need upstream design repair.' }
  ];
  const mode = mapRepairMode(status, status.currentStage, findings);
  const repairPlan = buildRepairPlan(findings, mode, status.currentStage, { workId });
  const fingerprint = captureRunFingerprints(runDir);

  fs.appendFileSync(path.join(runDir, '07-plan.md'), '\ndrifted after review\n');
  const apply = await driftGuard({
    cwd: root,
    env,
    homeDir,
    workId,
    runDir,
    archiveRunDir: path.join(root, '.req-to-plan', 'archive', workId),
    command_kind: repairPlan.command_kind,
    runMdSha256: fingerprint.runMdSha256,
    fileSetFingerprint: fingerprint.fileSetFingerprint
  });
  assert.equal(apply.ok, false);
  assert.equal(apply.blockingReason, 'r2p-drift-detected');
});
