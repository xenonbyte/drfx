'use strict';

// ---------------------------------------------------------------------------
// review-fix-r2p — PERSISTENT (stateful) context resolution.
//
// These tests are DETERMINISTIC: no LLM / CLI semantic reviewer runs. The test
// harness builds a real WF-* run directory (03–07 + run.md), drives the
// PERSISTENT `start` then `context` workflow commands, and asserts the assembled
// r2p context + the persisted V2 manifest directly.
//
// What they pin:
//   - The assembled r2p context's review file set is EXACTLY the five 03–07
//     *.md files (run.md is NOT among them).
//   - run.md appears as a PROTECTED read-only dependency (its sha256 fingerprint
//     is carried in the context pack) and is NEVER part of the review set.
//   - The persisted V2 MANIFEST.md round-trips with targetContextKind:'r2p' and
//     the correct workId + runMdSha256 + reviewSetFingerprint.
//   - r2p is dispatched as its own route kind — never mislabeled 'code'.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runWorkflowCommand } = require('../lib/workflow');
const { parseManifestV2 } = require('../lib/workflow-state');
const { resolveR2pWorkIdTarget } = require('../lib/target-context');

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

const R2P_EDITABLE_DOCS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

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

function writeExecutable(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o755 });
}

function installFakeR2pCli(root, workId) {
  const binDir = path.join(root, 'fake-r2p-bin');
  const scripts = {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" '[{"work_id":"${workId}","status":"closed_at_plan_checkpoint","current_stage":"plan","open_routes_detail":[]}]'`
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

// A git-backed project root (default guard=git for the persistent path) containing
// an active <root>/.req-to-plan/WF-* requirement directory with run.md + 03–07.
function makeR2pProject(t, name = 'WF-20260624-context') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-context-')));
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-context-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  git(root, ['init', '-b', 'main']);
  const wfDir = path.join(root, '.req-to-plan', name);
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'run.md'), planApprovedRunMd);
  for (const doc of R2P_EDITABLE_DOCS) {
    fs.writeFileSync(path.join(wfDir, doc), `# ${doc}\nContent of ${doc}\n`);
  }
  // Commit so the default git guard sees a clean worktree at start.
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed requirement']);
  return { root, homeDir, wfDir, env: installFakeR2pCli(root, name) };
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
    'review-and-fix',
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

function r2pArgsForWorkId(workId) {
  return [
    'review-fix-r2p',
    `workId=${workId}`,
    'review-and-fix',
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

// ---------------------------------------------------------------------------
// Persistent context: the read-only review set is exactly 03–07; run.md is protected
// and no artifact is editable (direct writes forbidden).
// ---------------------------------------------------------------------------

test('r2p persistent start + context assembles the 03–07 read-only review set with run.md protected', async (t) => {
  const workId = 'WF-20260624-context';
  const { root, homeDir, wfDir, env } = makeR2pProject(t, workId);
  const opts = { cwd: root, homeDir, env };
  const args = r2pArgs(workId);
  const before = snapshotProtectedFiles(wfDir);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.status, 'review');
  assert.equal(start.routeKind, 'r2p', 'r2p must dispatch as its own route kind');
  assert.equal(typeof start.manifestPath, 'string');

  const context = await runWorkflowCommand('context', args, opts);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(context.status, 'context');
  const pack = context.contextPackSkeleton;
  assert.equal(pack.routeKind, 'r2p');
  assert.equal(pack.workId, workId);
  assert.equal(pack.runLocation, `.req-to-plan/${workId}`);
  assert.deepEqual(pack.reviewFiles, R2P_EDITABLE_DOCS);
  assert.deepEqual(pack.editableFiles, []);
  assert.equal(pack.directArtifactWrites, 'forbidden');

  // run.md appears as a PROTECTED read-only dependency, fingerprinted.
  assert.deepEqual(pack.protectedDependencies, ['run.md']);

  // Nothing under the requirement directory was mutated by start/context.
  assert.deepEqual(changedFiles(wfDir, before), []);
});

test('r2p persistent start resolves relative target from explicit root outside cwd', async (t) => {
  const workId = 'WF-20260624-root';
  const { root, homeDir, env } = makeR2pProject(t, workId);
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const args = [
    'review-fix-r2p',
    `workId=${workId}`,
    'review-and-fix',
    `root=${root}`,
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

  const start = await runWorkflowCommand('start', args, { cwd: outside, homeDir, env });
  assert.equal(start.ok, true, JSON.stringify(start));
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.targetContextKind, 'r2p');
  assert.equal(manifest.workId, workId);
});

test('r2p persistent record-review blocks when context has not established reviewer guard baseline', async (t) => {
  const workId = 'WF-20260624-context-required';
  const { root, homeDir, env } = makeR2pProject(t, workId);
  const opts = { cwd: root, homeDir, env };
  const args = r2pArgs(workId);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));

  const review = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], {
    ...opts,
    stdin: [
      'PASS',
      'Summary: no blocking findings'
    ].join('\n')
  });

  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.status, 'blocked');
  assert.equal(review.blockingReason, 'state-validation-failed');
  assert.equal(review.errorCode, 'ERR_R2P_CONTEXT_REQUIRED');

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.blockingReason, 'state-validation-failed');
  assert.equal(manifest.lastReviewerReportPath, 'none');
});

// ---------------------------------------------------------------------------
// Persisted manifest round-trips as targetContextKind:'r2p' with run.md
// fingerprint + read-only review-set fingerprint.
// ---------------------------------------------------------------------------

test('r2p persistent manifest round-trips with targetContextKind r2p + run.md fingerprint', async (t) => {
  const workId = 'WF-20260624-manifest';
  const { root, homeDir, wfDir, env } = makeR2pProject(t, workId);
  const opts = { cwd: root, homeDir, env };
  const args = r2pArgs(workId);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));

  const expected = resolveR2pWorkIdTarget({ projectRoot: root, workId });
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));

  assert.equal(manifest.targetContextKind, 'r2p');
  assert.equal(manifest.documentType, 'none');
  assert.equal(manifest.workId, workId);
  assert.equal(manifest.runMdSha256, expected.runMdSha256);
  assert.equal(manifest.reviewSetFingerprint, expected.fileSetFingerprint);

  // The manifest has NO CODE/PR identity fields: r2p is neither.
  assert.ok(!Object.hasOwn(manifest, 'base'), 'r2p manifest must not carry a PR base');
  assert.ok(!Object.hasOwn(manifest, 'normalizedScopes'), 'r2p manifest must not carry CODE scopes');
  assert.ok(!Object.hasOwn(manifest, 'requirementDir'), 'r2p manifest must not carry the retired requirementDir field');

  // run.md is the protected gate, never a review-set member: its sha256 is the
  // manifest runMdSha256 and differs from the review-set fingerprint.
  assert.equal(manifest.runMdSha256, sha256OfFile(path.join(wfDir, 'run.md')));
  assert.notEqual(manifest.runMdSha256, manifest.reviewSetFingerprint);
});

test('r2p persistent record-review blocks when protected run.md drifts after context', async (t) => {
  const workId = 'WF-20260624-context-drift';
  const { root, homeDir, wfDir, env } = makeR2pProject(t, workId);
  const opts = { cwd: root, homeDir, env };
  const args = r2pArgs(workId);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));

  const context = await runWorkflowCommand('context', args, opts);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(
    context.contextPackSkeleton.protectedDependencies[0],
    'run.md'
  );

  fs.appendFileSync(path.join(wfDir, 'run.md'), '\nchanged after reviewer context\n');

  const review = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], {
    ...opts,
    stdin: [
      'PASS',
      'Summary: correctness, regression, safety, tests, contracts, maintainability, platform checked'
    ].join('\n')
  });

  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.status, 'blocked');
  assert.equal(review.blockingReason, 'reviewer-mutated-file');
});

test('r2p persistent record-review blocks structurally when a review artifact disappears after context', async (t) => {
  const workId = 'WF-20260624-context-artifact-missing';
  const { root, homeDir, wfDir, env } = makeR2pProject(t, workId);
  const opts = { cwd: root, homeDir, env };
  const args = r2pArgs(workId);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await runWorkflowCommand('context', args, opts);
  assert.equal(context.ok, true, JSON.stringify(context));

  fs.rmSync(path.join(wfDir, '06-spec.md'));

  const review = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], {
    ...opts,
    stdin: [
      'PASS',
      'Summary: no blocking findings'
    ].join('\n')
  });

  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.status, 'blocked');
  assert.equal(review.blockingReason, 'r2p-artifact-missing-or-unsafe');
  assert.equal(review.errorCode, 'ERR_R2P_ARTIFACT_MISSING');

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.blockingReason, 'r2p-artifact-missing-or-unsafe');
  assert.equal(manifest.runtimeFingerprintGuard, 'not-run');
});

test('r2p persistent record-review blocks structurally when the run is archived after context', async (t) => {
  const workId = 'WF-20260624-context-archived';
  const { root, homeDir, wfDir, env } = makeR2pProject(t, workId);
  const opts = { cwd: root, homeDir, env };
  const args = r2pArgs(workId);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await runWorkflowCommand('context', args, opts);
  assert.equal(context.ok, true, JSON.stringify(context));

  const archiveRoot = path.join(root, '.req-to-plan', 'archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.renameSync(wfDir, path.join(archiveRoot, workId));

  const review = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], {
    ...opts,
    stdin: [
      'PASS',
      'Summary: no blocking findings'
    ].join('\n')
  });

  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.status, 'blocked');
  assert.equal(review.blockingReason, 'r2p-run-archived');
  assert.equal(review.errorCode, 'ERR_R2P_WORK_ID_ARCHIVED');

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.blockingReason, 'r2p-run-archived');
  assert.equal(manifest.runtimeFingerprintGuard, 'not-run');
});

// ---------------------------------------------------------------------------
// Persistent context re-resolves the active run on each step and reports
// structured blockers when the review evidence disappears.
// ---------------------------------------------------------------------------

test('r2p persistent start accepts an incomplete-plan run.md when the active workId exists', async (t) => {
  const workId = 'WF-20260624-incomplete';
  const { root, homeDir, wfDir, env } = makeR2pProject(t, workId);
  fs.writeFileSync(path.join(wfDir, 'run.md'), [
    '# Requirement Run',
    '',
    '## Status',
    'active_at_spec_stage',
    '',
    '## Active Artifacts',
    '- spec: active',
    ''
  ].join('\n'));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'demote run.md']);

  const opts = { cwd: root, homeDir, env };
  const start = await runWorkflowCommand('start', r2pArgs(workId), opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.status, 'review');
  assert.equal(fs.existsSync(start.manifestPath), true);
});

test('r2p persistent context blocks when run.md is deleted after start', async (t) => {
  const workId = 'WF-20260624-missing-run';
  const { root, homeDir, wfDir, env } = makeR2pProject(t, workId);
  const opts = { cwd: root, homeDir, env };
  const args = r2pArgs(workId);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  fs.rmSync(path.join(wfDir, 'run.md'));

  const context = await runWorkflowCommand('context', args, opts);
  assert.equal(context.ok, false, JSON.stringify(context));
  assert.equal(context.status, 'blocked');
  assert.equal(context.blockingReason, 'r2p-artifact-missing-or-unsafe');
  assert.equal(context.errorCode, 'ERR_R2P_ARTIFACT_MISSING');

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.blockingReason, 'r2p-artifact-missing-or-unsafe');
  assert.equal(manifest.runtimeFingerprintGuard, 'not-run');
});

test('r2p persistent context blocks when an owner doc is deleted after start', async (t) => {
  const workId = 'WF-20260624-missing-doc';
  const { root, homeDir, wfDir, env } = makeR2pProject(t, workId);
  const opts = { cwd: root, homeDir, env };
  const args = r2pArgs(workId);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  fs.rmSync(path.join(wfDir, '05-design.md'));

  const context = await runWorkflowCommand('context', args, opts);
  assert.equal(context.ok, false, JSON.stringify(context));
  assert.equal(context.status, 'blocked');
  assert.equal(context.blockingReason, 'r2p-artifact-missing-or-unsafe');
  assert.equal(context.errorCode, 'ERR_R2P_ARTIFACT_MISSING');

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.blockingReason, 'r2p-artifact-missing-or-unsafe');
  assert.equal(manifest.runtimeFingerprintGuard, 'not-run');
});
