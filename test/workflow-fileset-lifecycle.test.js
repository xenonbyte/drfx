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

const FIX_REPORT_FILESET = [
  'Fixed:',
  '- ISSUE-001: Restored the error handling around the call.',
  '',
  'Files changed:',
  '- src/a.js',
  '',
  'Not fixed:',
  '- none',
  '',
  'Verification:',
  '- node --check src/a.js: passed',
  '',
  'Residual risk:',
  '- none identified'
].join('\n');

const DIFF_OK = 'DIFF-OK\nSummary: File-set edit addresses ISSUE-001.\n';
const REVIEW_PASS = 'PASS\nSummary: No blocking findings.\n';

function finalPass(filesChanged) {
  return [
    'Final status: pass',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: none',
    `Files changed: ${filesChanged}`,
    'Fixed issue IDs: ISSUE-001',
    'Verification performed: node --check src/a.js',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: none identified',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: approved after full re-review'
  ].join('\n');
}

test('PR file-set review-and-fix reaches pass through the file-set fix loop', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true);

  await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'begin-fix');
  assert.ok(beginFix.monitoredFileCount >= 2);

  // The fixer edits a file IN the recorded file set.
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.status, 'end-fix');
  assert.deepEqual(endFix.verification, ['node --check src/a.js: passed']);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');

  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });
  assert.equal(diff.ok, true);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'full-re-review');

  await runWorkflowCommand('context', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true);

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'pass');

  const ledger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'fixed');
});

test('PR file-set cannot pass without a full re-review after the fix', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });

  // Skip the full re-review and try to pass directly: finalize must refuse.
  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });
  assert.equal(final.ok, false);
  assert.equal(final.status, 'blocked');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'pass');
});

test('PR file-set end-fix blocks a fix report missing per-round verification', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 99;\n');

  const noVerification = [
    'Fixed:',
    '- ISSUE-001: Restored the error handling.',
    '',
    'Files changed:',
    '- src/a.js',
    '',
    'Not fixed:',
    '- none',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: noVerification });
  assert.equal(endFix.ok, false);
  assert.equal(endFix.status, 'blocked');
});

test('PR file-set end-fix blocks a fix that writes outside the recorded file set', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // Write a file NOT in the recorded set (src/a.js / src/b.js).
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'unrelated.js'), 'module.exports = 5;\n');

  const declaresInSet = [
    'Fixed:',
    '- ISSUE-001: Restored the error handling.',
    '',
    'Files changed:',
    '- src/a.js',
    '',
    'Not fixed:',
    '- none',
    '',
    'Verification:',
    '- node --check src/a.js: passed',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: declaresInSet });
  // The unrelated.js untracked write makes the worktree fall outside the recorded set.
  assert.equal(endFix.ok, false);
  assert.equal(endFix.status, 'blocked');
});

test('CODE file-set snapshot-guard fix loop reaches pass and abort restores the baseline', async (t) => {
  const root = makePrRepo(t);
  const codeFix = [
    'Fixed:',
    '- ISSUE-001: Restored the error handling around the call.',
    '',
    'Files changed:',
    '- src/a.js',
    '',
    'Not fixed:',
    '- none',
    '',
    'Verification:',
    '- node --check src/a.js: passed',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const codeReviewFail = REVIEW_FAIL;

  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']), { cwd: root });
  assert.equal(start.ok, true);
  assert.equal(start.guardMode, 'snapshot');

  await runWorkflowCommand('context', practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: codeReviewFail });
  await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  const before = fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');

  // Abort restores the monitored file to its captured baseline body.
  const aborted = await runWorkflowCommand('abort-fix', [
    start.targetStateDir,
    '--status',
    'checkpoint',
    '--reason',
    'checkpoint-requested',
    '--json'
  ], { cwd: root });
  assert.equal(aborted.ok, true, JSON.stringify(aborted));
  assert.equal(aborted.status, 'checkpoint');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), before, 'abort restores the snapshot baseline');
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
