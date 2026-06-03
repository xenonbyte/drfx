'use strict';

// PLAN-TASK-009 (Phase C): file-set (PR/CODE) persistent review lifecycle executes
// end-to-end. These tests drive start → context → record-review → record-triage over a
// real PR diff / CODE scope and assert the reviewer context-pack describes the file SET,
// the round-limit gate holds, and read-only file-set review never claims PASS.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runWorkflowCommand } = require('../lib/workflow');
const { parseManifestV2 } = require('../lib/workflow-state');
const { parseLedger } = require('../lib/ledger');

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
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fs-life-')));
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

function practicalArgs(extra, mode = 'review-and-fix') {
  return [
    ...extra,
    mode,
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

const REVIEW_FAIL = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: src/a.js',
  '  issue: The change drops error handling.',
  '  why_it_matters: A failure path now throws unhandled.',
  '  suggested_fix: Restore the try/catch around the call.',
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
  '  rationale: The missing error handling blocks merge.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

test('PR file-set review path runs context → record-review → record-triage to a fix decision', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true);
  assert.equal(start.status, 'review');

  const context = await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(context.ok, true);
  assert.equal(context.status, 'context');
  assert.equal(context.contextPackSkeleton.fileSet.routeKind, 'pr');
  assert.equal(context.contextPackSkeleton.fileSet.base, 'main');
  // The file set carries the PR diff member files, not a single document body.
  const memberPaths = context.contextPackSkeleton.fileSet.files.map((file) => file.path).sort();
  assert.deepEqual(memberPaths, ['src/a.js', 'src/b.js']);
  assert.equal(context.contextPackSkeleton.target, 'none');

  const review = await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  assert.equal(review.ok, true);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'triage');

  const triage = await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  assert.equal(triage.ok, true);
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.currentPhase, 'fix');

  const ledger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'accepted');
});

test('CODE file-set context describes the scoped file set, never a single document body', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=src']), { cwd: root });
  assert.equal(start.ok, true);

  const context = await runWorkflowCommand('context', practicalArgs(['review-fix-code', 'scope=src']), { cwd: root });
  assert.equal(context.ok, true);
  assert.equal(context.contextPackSkeleton.fileSet.routeKind, 'code');
  assert.deepEqual(context.contextPackSkeleton.fileSet.scopes, ['src']);
  assert.ok(context.contextPackSkeleton.fileSet.fileCount >= 2);
  assert.equal(context.contextPackSkeleton.documentType, 'none');
});

test('PR file-set round-limit gate stops with deferrals instead of a clean pass', async (t) => {
  const root = makePrRepo(t);
  // rounds=1 with one already-completed fix attempt forces the limit at the loop boundary.
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'rounds=1']), { cwd: root });
  assert.equal(start.ok, true);

  // Simulate a prior completed fix round so the round-limit gate bites on the next triage.
  const manifestPath = start.manifestPath;
  const original = fs.readFileSync(manifestPath, 'utf8');
  fs.writeFileSync(manifestPath, original.replace('Fix attempt count: 0', 'Fix attempt count: 1'));

  await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main', 'rounds=1']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main', 'rounds=1']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  const triage = await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main', 'rounds=1']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  assert.equal(triage.ok, true);
  assert.equal(triage.stopReason, 'round-limit');
  const manifest = parseManifestV2(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.status, 'stopped-with-deferrals');
  assert.notEqual(manifest.status, 'pass');
});
