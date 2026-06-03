'use strict';

// PLAN-TASK-009 (Phase A): the workflow dispatcher must resolve a FILE-SET target
// context for PR/CODE routes instead of calling deriveTargetKey/computeFingerprint on
// the undefined single-file `parsed.invocation.target`. These tests prove the
// dispatch fallthrough, advisory-downgrade-to-unsupported, and blocked paths resolve a
// route-kind-aware target key (e.g. `pr-<hash>` / `code-<hash>`) and never crash with
// an "undefined target" file-system error.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runWorkflowCommand } = require('../lib/workflow');
const {
  deriveFileSetTargetKey,
  resolveRouteTargetMetadata,
  isFileSetRoute
} = require('../lib/workflow/target-resolution');
const { parseInvocation } = require('../lib/input');

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

function freshRepo(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fileset-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function parsedFor(entrySkill, tokens) {
  const invocation = parseInvocation(entrySkill, tokens, {
    defaultMode: 'read-only',
    defaultAssurance: null,
    includeMetadata: true
  });
  return { invocation };
}

test('resolveRouteTargetMetadata derives a pr-<hash> file-set key, never deriveTargetKey on undefined target', (t) => {
  const root = freshRepo(t);
  const parsed = parsedFor('review-fix-pr', ['base=main', 'read-only']);
  assert.equal(isFileSetRoute(parsed), true);
  const metadata = resolveRouteTargetMetadata(parsed, { cwd: root });
  assert.equal(metadata.routeKind, 'pr');
  assert.match(metadata.targetKey, /^pr-[0-9a-f]{12}$/);
  assert.equal(metadata.normalizedTarget, null);
  assert.equal(metadata.projectRoot, root);
});

test('resolveRouteTargetMetadata derives a code-<hash> file-set key from sorted scopes', (t) => {
  const root = freshRepo(t);
  const parsedA = parsedFor('review-fix-code', ['scope=src', 'scope=lib', 'read-only']);
  const parsedB = parsedFor('review-fix-code', ['scope=lib', 'scope=src', 'read-only']);
  const keyA = deriveFileSetTargetKey(parsedA);
  const keyB = deriveFileSetTargetKey(parsedB);
  assert.match(keyA, /^code-[0-9a-f]{12}$/);
  assert.equal(keyA, keyB, 'scope order must not change the file-set target key');

  const metadata = resolveRouteTargetMetadata(parsedA, { cwd: root });
  assert.equal(metadata.routeKind, 'code');
  assert.deepEqual(metadata.scopes.slice().sort(), ['lib', 'src']);
});

test('a different PR base produces a different file-set target key', (t) => {
  const keyMain = deriveFileSetTargetKey(parsedFor('review-fix-pr', ['base=main']));
  const keyDev = deriveFileSetTargetKey(parsedFor('review-fix-pr', ['base=develop']));
  assert.notEqual(keyMain, keyDev);
});

test('advisory review-and-fix PR start dispatches to unsupported (file-set context resolved, no crash)', async (t) => {
  const root = freshRepo(t);
  const result = await runWorkflowCommand('start', [
    'review-fix-pr',
    'base=main',
    'review-and-fix',
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
  assert.equal(result.status, 'unsupported');
  assert.equal(result.routeKind, 'pr');
  assert.match(result.targetKey, /^pr-[0-9a-f]{12}$/);
  // No document-only identity leaks into a file-set route base.
  assert.equal(result.documentType, 'none');
  assert.equal(result.target, null);
  assert.equal(result.base, 'main');
});

test('read-only PR start falls through to workflowBase with a resolved file-set key', async (t) => {
  const root = freshRepo(t);
  const result = await runWorkflowCommand('start', [
    'review-fix-pr',
    'base=main',
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
  assert.equal(result.routeKind, 'pr');
  assert.match(result.targetKey, /^pr-[0-9a-f]{12}$/);
  assert.equal(result.documentType, 'none');
});

test('read-only CODE start falls through to workflowBase with a resolved file-set key', async (t) => {
  const root = freshRepo(t);
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
  assert.equal(result.routeKind, 'code');
  assert.match(result.targetKey, /^code-[0-9a-f]{12}$/);
  assert.equal(result.documentType, 'none');
  assert.deepEqual(result.scopes, ['src']);
});

test('unavailable stdin handoff blocks a read-only PR start without crashing on undefined target', async (t) => {
  const root = freshRepo(t);
  const result = await runWorkflowCommand('start', [
    'review-fix-pr',
    'base=main',
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'unavailable',
    '--json'
  ], { cwd: root });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unsafe-handoff-file');
  assert.equal(result.routeKind, 'pr');
  assert.match(result.targetKey, /^pr-[0-9a-f]{12}$/);
});
