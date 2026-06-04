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
const { formatManifestV2, parseManifestV2 } = require('../lib/workflow-state');
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

function makePrRepoWithDeletedFile(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fs-delete-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'remove-me.js'), 'module.exports = "remove";\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.rmSync(path.join(root, 'src', 'remove-me.js'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'feature deletes a file']);
  return root;
}

function makePrRepoWithDistFile(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fs-dist-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'module.exports = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'module.exports = 2;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'feature updates dist']);
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

test('CODE file-set record-review blocks when scoped content changes after context', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true);

  await runWorkflowCommand('context', args, { cwd: root });
  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// reviewer-side mutation\n');

  const review = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });

  assert.equal(review.ok, false);
  assert.equal(review.status, 'blocked');
  assert.equal(review.blockingReason, 'reviewer-mutated-file');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'reports', 'reviewer-round-001.md')), false);
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

function finalPassWithoutFixes() {
  return [
    'Final status: pass',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: none',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: full file-set re-review',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: none identified',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: approved after full re-review'
  ].join('\n');
}

function noStateReadOnlyFindings() {
  return [
    'Final status: read-only-findings',
    'Assurance: advisory',
    'Runtime platform: codex',
    'Mode: read-only',
    'Target: none',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: full file-set read-only review',
    'Deferrals or blockers: read-only findings',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: unresolved read-only findings remain',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');
}

async function reachFileSetFixStage(root, args) {
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));
  await runWorkflowCommand('context', args, { cwd: root });
  await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...args,
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  return start;
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
  const archivedManifestPath = path.join(final.archivedStatePath, path.relative(start.targetStateDir, start.manifestPath));
  assert.equal(parseManifestV2(fs.readFileSync(archivedManifestPath, 'utf8')).status, 'pass');

  const archivedLedgerPath = path.join(final.archivedStatePath, path.relative(start.targetStateDir, start.ledgerPath));
  const ledger = parseLedger(fs.readFileSync(archivedLedgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'fixed');
});

test('PR file-set finalize rejects a concrete Target in the final machine block', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  await runWorkflowCommand('context', [
    ...args,
    '--phase',
    'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js').replace('Target: none', 'Target: src/a.js') });
  assert.equal(final.ok, false);
  assert.equal(final.status, 'blocked');
  assert.equal(final.errorCode, 'ERR_FINAL_TARGET_MISMATCH');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'pass');
});

test('PR file-set end-fix records the uncommitted worktree content fingerprint', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const before = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fileSetFingerprint;

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { return 42; };\n');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  const after = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fileSetFingerprint;
  assert.notEqual(after, before);
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

test('PR file-set cannot pass from an initial PASS before the required full re-review', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));

  await runWorkflowCommand('context', args, { cwd: root });
  const initialPass = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(initialPass.ok, true, JSON.stringify(initialPass));
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'full-re-review');
  assert.equal(manifest.currentPhase, 'full-re-review');

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPassWithoutFixes() });
  assert.equal(final.ok, false);
  assert.equal(final.status, 'blocked');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'pass');
});

test('PR file-set finalize pass revalidates the live file-set fingerprint', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });
  await runWorkflowCommand('context', [
    ...args,
    '--phase',
    'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  fs.appendFileSync(path.join(root, 'src', 'b.js'), '\n// changed after full re-review\n');
  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });
  assert.equal(final.ok, false);
  assert.equal(final.status, 'blocked');
  assert.equal(final.blockingReason, 'final-validation-failed');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'pass');
});

test('CODE file-set full re-review refreshes stale policy identity before final pass', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });

  const staleManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  staleManifest.fileSetFingerprint = '0'.repeat(64);
  staleManifest.exclusions = staleManifest.exclusions.filter((entry) => ![
    '.claude',
    '.codex',
    '.codegraph',
    '.gemini',
    '.req-to-plan'
  ].includes(entry));
  fs.writeFileSync(start.manifestPath, formatManifestV2(staleManifest));

  await runWorkflowCommand('context', [
    ...args,
    '--phase',
    'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  const refreshedManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.notEqual(refreshedManifest.fileSetFingerprint, '0'.repeat(64));
  assert.ok(refreshedManifest.exclusions.includes('.codegraph'));

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
});

test('PR file-set full re-review refreshes stale identity (incl head) before final pass', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });

  // Corrupt the stored PR identity: zero the fingerprint AND the head revision, so a pass can
  // only be reached if record-review re-anchors the full PR identity, not just the fingerprint.
  const staleManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  staleManifest.fileSetFingerprint = '0'.repeat(64);
  staleManifest.head = '0'.repeat(40);
  fs.writeFileSync(start.manifestPath, formatManifestV2(staleManifest));

  await runWorkflowCommand('context', [...args, '--phase', 'full-re-review'], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  const refreshedManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.notEqual(refreshedManifest.fileSetFingerprint, '0'.repeat(64));
  assert.notEqual(refreshedManifest.head, '0'.repeat(40));
  assert.match(refreshedManifest.head, /^[0-9a-f]{40}$/);

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
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

test('PR file-set snapshot begin-fix supports deleted files in the PR file set', async (t) => {
  const root = makePrRepoWithDeletedFile(t);
  const args = practicalArgs(['review-fix-pr', 'base=main', 'guard=snapshot']);
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));

  await runWorkflowCommand('context', args, { cwd: root });
  await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...args,
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'begin-fix');
});

test('PR file-set git begin-fix rejects dirty PR members before the first route-owned fix', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);

  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// local dirty edit before first fix\n');
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, false);
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'unexpected-worktree-change');
});

test('PR file-set snapshot begin-fix rejects clean file-set commits after triage before first fix', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main', 'guard=snapshot']);
  const start = await reachFileSetFixStage(root, args);
  const reviewedManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 22;\n');
  git(root, ['add', 'src/a.js']);
  git(root, ['commit', '-m', 'unreviewed follow-up']);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });

  assert.equal(beginFix.ok, false);
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'unexpected-worktree-change');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'file-set-baseline.json')), false);
  const blockedManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(blockedManifest.fixAttemptCount, 0);
  assert.equal(blockedManifest.fileSetFingerprint, reviewedManifest.fileSetFingerprint);
});

test('PR file-set begin-fix allows diff members inside CODE-excluded directories', async (t) => {
  const root = makePrRepoWithDistFile(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });

  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'begin-fix');
  assert.equal(typeof beginFix.fixGuardReportPath, 'string');
  assert.match(fs.readFileSync(beginFix.fixGuardReportPath, 'utf8'), /"dist\/app\.js"/);
});

test('CODE file-set abort-fix restores monitored files from persisted baseline bodies', async (t) => {
  const root = makePrRepo(t);
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
  const persistedBaseline = JSON.parse(fs.readFileSync(path.join(start.targetStateDir, 'file-set-baseline.json'), 'utf8'));
  assert.equal(persistedBaseline.entries.every((entry) => !Object.hasOwn(entry, 'body')), true);
  assert.equal(persistedBaseline.entries.every((entry) => entry.missing || typeof entry.bodyPath === 'string'), true);

  const targetPath = path.join(root, 'src', 'a.js');
  const before = fs.readFileSync(targetPath, 'utf8');
  const edited = 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n';
  fs.writeFileSync(targetPath, edited);

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
  assert.equal(fs.readFileSync(targetPath, 'utf8'), before, 'abort must restore the monitored file body');
});

test('CODE file-set abort-fix blocks rollback when the persisted baseline is missing', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  const targetPath = path.join(root, 'src', 'a.js');
  const before = fs.readFileSync(targetPath, 'utf8');
  const edited = `${before}\n// partial fixer edit without readable baseline\n`;
  fs.writeFileSync(targetPath, edited);
  fs.rmSync(path.join(start.targetStateDir, 'file-set-baseline.json'));

  const aborted = await runWorkflowCommand('abort-fix', [
    start.targetStateDir,
    '--status',
    'checkpoint',
    '--reason',
    'checkpoint-requested',
    '--json'
  ], { cwd: root });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.status, 'blocked');
  assert.equal(aborted.blockingReason, 'rollback-unavailable');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), edited, 'abort must not claim rollback when baseline is missing');
});

test('CODE file-set abort-fix blocks rollback when a persisted baseline body is corrupt', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  const targetPath = path.join(root, 'src', 'a.js');
  const before = fs.readFileSync(targetPath, 'utf8');
  const edited = `${before}\n// partial fixer edit before corrupt rollback\n`;
  fs.writeFileSync(targetPath, edited);
  const baseline = JSON.parse(fs.readFileSync(path.join(start.targetStateDir, 'file-set-baseline.json'), 'utf8'));
  const targetEntry = baseline.entries.find((entry) => entry.path === 'src/a.js');
  assert.ok(targetEntry && targetEntry.bodyPath, 'baseline must persist a body path for src/a.js');
  fs.writeFileSync(path.join(start.targetStateDir, targetEntry.bodyPath), 'corrupt rollback body\n');

  const aborted = await runWorkflowCommand('abort-fix', [
    start.targetStateDir,
    '--status',
    'checkpoint',
    '--reason',
    'checkpoint-requested',
    '--json'
  ], { cwd: root });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.status, 'blocked');
  assert.equal(aborted.blockingReason, 'rollback-unavailable');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), edited, 'abort must not restore a corrupt baseline body');
});

test('CODE file-set abort-fix restores an originally empty monitored file', async (t) => {
  const root = makePrRepo(t);
  fs.writeFileSync(path.join(root, 'src', 'empty.js'), '');
  git(root, ['add', 'src/empty.js']);
  git(root, ['commit', '-m', 'add empty source']);
  const args = practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  const emptyPath = path.join(root, 'src', 'empty.js');
  fs.writeFileSync(emptyPath, 'module.exports = "filled";\n');
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
  assert.equal(fs.readFileSync(emptyPath, 'utf8'), '');
});

test('PR file-set DIFF-FAIL stops at the round limit instead of scheduling another fix', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main', 'rounds=1']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });

  const diffFail = [
    'DIFF-FAIL',
    'Findings:',
    '- issue_id: ISSUE-001',
    '  problem: Fix still misses the required behavior.',
    '  required_action: Rework the fix manually.'
  ].join('\n');
  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: diffFail });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.equal(diff.stopReason, 'round-limit');
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'stopped-with-deferrals');
  assert.equal(manifest.currentPhase, 'final');
  assert.equal(manifest.statusReason, 'round-limit');
  assert.equal(manifest.currentRound, 1);
  const ledger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'deferred');
});

test('CODE file-set snapshot end-fix blocks writes outside the recorded file set', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']);

  const start = await runWorkflowCommand('start', args, { cwd: root });
  await runWorkflowCommand('context', args, { cwd: root });
  await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...args,
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 42;\n');
  fs.writeFileSync(path.join(root, 'outside.js'), 'module.exports = "outside";\n');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, false);
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'unexpected-worktree-change');
});

test('CODE file-set git end-fix blocks files created in scope after begin-fix', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 42;\n');
  fs.writeFileSync(path.join(root, 'src', 'created-after-begin.js'), 'module.exports = "late";\n');

  const reportDeclaringLateFile = [
    'Fixed:',
    '- ISSUE-001: Restored the error handling.',
    '',
    'Files changed:',
    '- src/a.js',
    '- src/created-after-begin.js',
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
  ], { cwd: root, stdin: reportDeclaringLateFile });

  assert.equal(endFix.ok, false);
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'fix-report-mismatch');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

test('CODE file-set git end-fix compares changes against the current begin-fix baseline', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const firstBegin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(firstBegin.ok, true, JSON.stringify(firstBegin));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 42;\n');
  const firstEnd = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(firstEnd.ok, true, JSON.stringify(firstEnd));

  const diffFail = [
    'DIFF-FAIL',
    'Findings:',
    '- issue_id: ISSUE-001',
    '  problem: Fix still misses the required behavior.',
    '  required_action: Rework the fix.'
  ].join('\n');
  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: diffFail });
  assert.equal(diff.ok, true, JSON.stringify(diff));

  const secondBegin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:05:00.000Z')
  });
  assert.equal(secondBegin.ok, true, JSON.stringify(secondBegin));

  const secondEnd = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(secondEnd.ok, false);
  assert.equal(secondEnd.status, 'blocked');
  assert.equal(secondEnd.blockingReason, 'fix-report-mismatch');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

test('CODE file-set retry begin-fix recovers after a transient out-of-set end-fix block', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(beginFix.status, 'begin-fix');

  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// fixed transient guard case\n');
  fs.writeFileSync(path.join(root, 'outside.js'), 'module.exports = "temporary";\n');
  const blocked = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockingReason, 'unexpected-worktree-change');

  fs.rmSync(path.join(root, 'outside.js'));
  const retry = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(retry.status, 'begin-fix');
  assert.equal(retry.nextAction, 'retry end-fix with a valid fix report');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.status, 'end-fix');
});

test('CODE file-set retry begin-fix recovers after a fix-report-mismatch end-fix block', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(beginFix.status, 'begin-fix');
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fixAttemptCount, 1);

  // The report credits src/a.js but no edit was actually written, so the actual changed set
  // is empty and end-fix blocks as a (correctable) fix-report-mismatch rather than a guard breach.
  const blocked = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockingReason, 'fix-report-mismatch');

  // begin-fix retries the still-counted round and returns to fix WITHOUT burning a new fix
  // attempt; once the declared edit is actually applied, end-fix succeeds.
  const retry = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(retry.status, 'begin-fix');
  assert.equal(retry.nextAction, 'retry end-fix with a valid fix report');
  assert.equal(
    parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fixAttemptCount,
    1,
    'a blocked-fix retry must not consume a new fix attempt'
  );

  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// applied the declared fix on retry\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.status, 'end-fix');
});

test('CODE file-set later begin-fix rejects user edits to the prior-round allowed set', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const firstBegin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(firstBegin.ok, true, JSON.stringify(firstBegin));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 42;\n');
  const firstEnd = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(firstEnd.ok, true, JSON.stringify(firstEnd));

  const diffFail = [
    'DIFF-FAIL',
    'Findings:',
    '- issue_id: ISSUE-001',
    '  problem: Fix still misses the required behavior.',
    '  required_action: Rework the fix.'
  ].join('\n');
  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: diffFail });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'fix');

  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// user edit before next begin-fix\n');
  const secondBegin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:05:00.000Z')
  });
  assert.equal(secondBegin.ok, false);
  assert.equal(secondBegin.status, 'blocked');
  assert.equal(secondBegin.blockingReason, 'unexpected-worktree-change');
});

test('CODE file-set begin-fix returns corrupt-lock workflow JSON for invalid leases', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const lockDir = path.join(start.targetStateDir, 'LOCK');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'lease.json'), '{not json');

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });

  assert.equal(beginFix.ok, false);
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'corrupt-lock');
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'blocked');
});

test('PR file-set concurrent begin-fix attempts preserve the active fix manifest', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const beginArgs = [start.targetStateDir, '--json'];
  const now = new Date('2026-06-03T00:00:00.000Z');

  const results = await Promise.all([
    runWorkflowCommand('begin-fix', beginArgs, { cwd: root, now }),
    runWorkflowCommand('begin-fix', beginArgs, { cwd: root, now })
  ]);

  assert.equal(results.every((result) => result.ok === true), true, JSON.stringify(results));
  assert.equal(results.every((result) => result.status === 'begin-fix'), true, JSON.stringify(results));
  assert.equal(new Set(results.map((result) => result.leaseId)).size, 1);
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.blockingReason, 'none');
  assert.equal(manifest.fixAttemptCount, 1);
});

test('CODE file-set refresh-lock returns corrupt-lock workflow JSON for invalid leases', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  const lockDir = path.join(start.targetStateDir, 'LOCK');
  fs.writeFileSync(path.join(lockDir, 'lease.json'), '{not json');

  const refresh = await runWorkflowCommand('refresh-lock', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:01:00.000Z')
  });

  assert.equal(refresh.ok, false);
  assert.equal(refresh.status, 'blocked');
  assert.equal(refresh.blockingReason, 'corrupt-lock');
  assert.equal(refresh.errorCode, 'ERR_CORRUPT_LOCK');
  assert.equal(refresh.targetStateDir, start.targetStateDir);
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.blockingReason, 'corrupt-lock');
});

test('no-state read-only CODE advisory review runs without auto-fix state and never claims pass', async (t) => {
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
  assert.equal(result.ok, true);
  assert.equal(result.status, 'context');
  assert.equal(result.mode, 'read-only');
  assert.notEqual(result.status, 'pass');
  assert.equal(result.createdTargetState, false);
  assert.equal(result.targetStateDir, null);
  assert.equal(result.contextPackSkeleton.fileSet.routeKind, 'code');
  assert.ok(result.contextPackSkeleton.fileSet.fileCount >= 2);
  assert.equal(typeof result.reviewGuard, 'string');
  assert.equal(fs.existsSync(path.join(root, '.drfx', 'targets')), false);
});

test('no-state read-only CODE practical review preserves practical assurance', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('context', [
    'review-fix-code',
    'scope=src',
    'read-only',
    '--no-state',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ], { cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'context');
  assert.equal(result.assurance, 'practical');
  assert.equal(result.assuranceNormalizedFrom, null);
  assert.equal(result.contextPackSkeleton.assurance, 'practical');
  assert.equal(typeof result.reviewGuard, 'string');
});

test('no-state PR advisory read-only records review, triage, and finalize without persistent state', async (t) => {
  const root = makePrRepo(t);
  const context = await runWorkflowCommand('context', [
    'review-fix-pr',
    'base=main',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--phase',
    'initial-review',
    '--json'
  ], { cwd: root });
  assert.equal(context.ok, true);
  assert.equal(typeof context.reviewGuard, 'string');

  const review = await runWorkflowCommand('record-review', [
    'review-fix-pr',
    'base=main',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--phase',
    'initial-review',
    '--review-guard',
    context.reviewGuard,
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  assert.equal(review.ok, true);
  assert.equal(review.status, 'recorded-review');
  assert.equal(typeof review.stateToken, 'string');

  const triage = await runWorkflowCommand('record-triage', [
    'review-fix-pr',
    'base=main',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--phase',
    'initial-review',
    '--state-token',
    review.stateToken,
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  assert.equal(triage.ok, true);
  assert.equal(triage.status, 'recorded-triage');

  const final = await runWorkflowCommand('finalize', [
    'review-fix-pr',
    'base=main',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--state-token',
    triage.stateToken,
    '--final-response-stdin'
  ], { cwd: root, stdin: noStateReadOnlyFindings() });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'read-only-findings');
  assert.notEqual(final.status, 'pass');
  assert.equal(fs.existsSync(path.join(root, '.drfx', 'targets')), false);
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

test('PR file-set finalize archives the state dir on pass', async (t) => {
  const root = makePrRepo(t);
  const start = await reachFileSetFixStage(root, practicalArgs(['review-fix-pr', 'base=main']));
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });

  await runWorkflowCommand('context', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase', 'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase', 'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  const targetStateDir = start.targetStateDir;
  const final = await runWorkflowCommand('finalize', [
    targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });

  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  assert.equal(fs.existsSync(targetStateDir), false);
  assert.match(final.archivedStatePath, /\.drfx\/archived\/.+/);
  assert.equal(fs.existsSync(final.archivedStatePath), true);
  assert.equal(fs.existsSync(path.join(final.archivedStatePath, 'MANIFEST.md')), true);
});
