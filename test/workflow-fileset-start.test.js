'use strict';

// PLAN-TASK-009 (Phase B): live PR/CODE file-set state is created in workflow start and
// ONLY there, through the schema/identity helpers. These tests prove a valid file-set
// MANIFEST.md (targetContextKind pr/code) is written and re-parses, that PR/CODE start
// persists practical (never advisory) assurance for review-and-fix, and that a fresh
// start over existing state is refused (ERR_STATE_EXISTS) rather than silently reused.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runWorkflowCommand } = require('../lib/workflow');
const { parseManifestV2 } = require('../lib/workflow-state');

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

function makePrRepo(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fs-start-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 3;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'feature work']);
  return root;
}

function practicalArgs(extra) {
  return [
    ...extra,
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

test('PR review-and-fix start writes a parseable pr file-set MANIFEST.md and never advisory', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'review');
  assert.equal(result.routeKind, 'pr');
  assert.match(result.targetKey, /^pr-[0-9a-f]{12}$/);
  assert.ok(result.fileSetFingerprint && /^[0-9a-f]{64}$/.test(result.fileSetFingerprint));

  const manifest = parseManifestV2(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.targetContextKind, 'pr');
  assert.equal(manifest.documentType, 'none');
  assert.equal(manifest.mode, 'review-and-fix');
  assert.equal(manifest.assurance, 'practical');
  assert.equal(manifest.base, 'main');
  assert.match(manifest.head, /^[0-9a-f]{40}$/);
  assert.match(manifest.mergeBase, /^[0-9a-f]{40}$/);
  assert.equal(manifest.fileSetFingerprint, result.fileSetFingerprint);
});

test('CODE review-and-fix start writes a parseable code file-set MANIFEST.md with normalized scopes', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=src']), { cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.routeKind, 'code');
  assert.match(result.targetKey, /^code-[0-9a-f]{12}$/);

  const manifest = parseManifestV2(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.targetContextKind, 'code');
  assert.equal(manifest.documentType, 'none');
  assert.equal(manifest.assurance, 'practical');
  assert.deepEqual(manifest.normalizedScopes, ['src']);
  assert.ok(Array.isArray(manifest.exclusions) && manifest.exclusions.includes('node_modules'));
  assert.match(manifest.fileSetFingerprint, /^[0-9a-f]{64}$/);
});

test('a second fresh PR start over existing state is refused (no silent resume)', async (t) => {
  const root = makePrRepo(t);
  const first = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(first.ok, true);
  await assert.rejects(
    runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root }),
    (error) => error.code === 'ERR_STATE_EXISTS'
  );
});

test('CODE start with an excluded scope is blocked, not silently empty', async (t) => {
  const root = makePrRepo(t);
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=node_modules']), { cwd: root });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.match(String(result.message), /excluded-scope/);
});

test('rounds=<n> round limit round-trips into the file-set manifest', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'rounds=3']), { cwd: root });
  assert.equal(result.ok, true);
  const manifest = parseManifestV2(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.roundLimit, '3');
});

test('read-only CODE start creates no automatic-fix target state and claims no pass', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('start', [
    'review-fix-code',
    'scope=src',
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ], { cwd: root });
  assert.notEqual(result.status, 'pass');
  assert.equal(fs.existsSync(path.join(root, '.docs-review-fix', 'targets')), false);
});

test('PR persistent lifecycle commands refuse cleanly after start (no crash, no pass)', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true);

  // context (invocation-based) refuses cleanly rather than crashing on undefined target.
  const context = await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(context.ok, false);
  assert.equal(context.status, 'unsupported');
  assert.notEqual(context.status, 'pass');

  // begin-fix (state-dir-based) refuses cleanly via the file-set manifest guard.
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(beginFix.ok, false);
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'state-validation-failed');

  // explicit resume refuses cleanly (no silent reuse, no crash) until the lifecycle lands.
  const resume = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'resume']), { cwd: root });
  assert.equal(resume.ok, false);
  assert.equal(resume.status, 'unsupported');
});

test('read-only no-state CODE review never creates auto-fix state and never claims pass', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('context', [
    'review-fix-code',
    'scope=src',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ], { cwd: root });
  assert.notEqual(result.status, 'pass');
  assert.equal(result.mode, 'read-only');
  assert.equal(fs.existsSync(path.join(root, '.docs-review-fix', 'targets')), false);
});
