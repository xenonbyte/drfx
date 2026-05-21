'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { parseLedger } = require('../lib/ledger');
const { readLease } = require('../lib/lock');
const { runWorkflowCommand } = require('../lib/workflow');
const { parseManifestV2 } = require('../lib/workflow-state');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'workflow');

const REVIEW_FAIL = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: docs/practical-target.md#practical-workflow-target',
  '  issue: Target wording is unclear.',
  '  why_it_matters: The document requirement can be misread by implementers.',
  '  suggested_fix: Rewrite the sentence to name the expected behavior.',
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
  '  rationale: The unclear wording blocks implementation.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

const FIX_REPORT = [
  'Fixed:',
  '- ISSUE-001: Clarified the target wording.',
  '',
  'Files changed:',
  '- docs/practical-target.md',
  '',
  'Not fixed:',
  '- none',
  '',
  'Residual risk:',
  '- none identified'
].join('\n');

const DIFF_OK = 'DIFF-OK\nSummary: Target-only edit addresses ISSUE-001.\n';
const REVIEW_PASS = 'PASS\nSummary: No blocking findings.\n';

const FINAL_PASS = [
  'Final status: pass',
  'Assurance: practical',
  'Runtime platform: codex',
  'Mode: review-and-fix',
  'Target: docs/practical-target.md',
  'Files changed: docs/practical-target.md',
  'Fixed issue IDs: ISSUE-001',
  'Verification performed: node --test test/workflow-e2e.test.js',
  'Deferrals or blockers: none',
  'Blocking reason: none',
  'Status reason: none',
  'Residual risk: none identified',
  'Redaction statement: no sensitive values persisted',
  'Coordinator agreement: approved after full re-review'
].join('\n');

const FINAL_CLEAN = [
  'Final status: read-only-clean',
  'Assurance: advisory',
  'Runtime platform: manual',
  'Mode: read-only',
  'Target: docs/practical-target.md',
  'Files changed: none',
  'Fixed issue IDs: none',
  'Verification performed: node --test test/workflow-e2e.test.js',
  'Deferrals or blockers: none',
  'Blocking reason: none',
  'Status reason: none',
  'Residual risk: none identified',
  'Redaction statement: no sensitive values persisted',
  'Coordinator agreement: none'
].join('\n');

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
}

function makeWorkflowRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-e2e-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-e2e-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_ROOT, 'practical-target.md'), path.join(root, 'docs', 'practical-target.md'));
  fs.copyFileSync(path.join(FIXTURE_ROOT, 'reference.md'), path.join(root, 'docs', 'reference.md'));
  git(root, ['init']);
  git(root, ['add', 'docs/practical-target.md', 'docs/reference.md']);
  git(root, ['commit', '-m', 'init']);
  return {
    root,
    homeDir,
    target: path.join(root, 'docs', 'practical-target.md'),
    reference: path.join(root, 'docs', 'reference.md')
  };
}

function workflowStartArgs(fixture, mode, assurance, runtimePlatform) {
  return [
    'review-fix-design',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    `ref=${fixture.reference}`,
    mode,
    '--assurance',
    assurance,
    '--runtime-platform',
    runtimePlatform,
    '--runtime-subagent-probe',
    runtimePlatform === 'manual' ? 'not-required' : 'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ];
}

function workflowOptions(fixture, overrides = {}) {
  return {
    cwd: fixture.root,
    homeDir: fixture.homeDir,
    ...overrides
  };
}

function manifestAt(manifestPath) {
  return parseManifestV2(fs.readFileSync(manifestPath, 'utf8'));
}

function assertManifestPhase(manifestPath, status, currentPhase) {
  const manifest = manifestAt(manifestPath);
  assert.equal(manifest.status, status);
  assert.equal(manifest.currentPhase, currentPhase);
  return manifest;
}

function assertFileExists(filePath) {
  assert.equal(fs.existsSync(filePath), true, filePath);
}

test('deterministic practical workflow reaches pass with target-only diff', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const start = await runWorkflowCommand('start', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), workflowOptions(fixture));
  assert.equal(start.ok, true);
  assert.equal(start.status, 'review');
  assert.equal(fs.existsSync(start.targetStateDir), true);
  assertManifestPhase(start.manifestPath, 'review', 'review');

  const context = await runWorkflowCommand('context', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), workflowOptions(fixture));
  assert.equal(context.ok, true);
  assert.equal(context.status, 'context');
  assertFileExists(context.contextManifestPath);

  const review = await runWorkflowCommand('record-review', [
    ...workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  assert.equal(review.ok, true);
  assertFileExists(review.reviewerReportPath);
  assertManifestPhase(start.manifestPath, 'triage', 'triage');

  const triage = await runWorkflowCommand('record-triage', [
    ...workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'),
    '--triage-stdin'
  ], workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  assert.equal(triage.ok, true);
  assertFileExists(triage.triageReportPath);
  assertManifestPhase(start.manifestPath, 'fix', 'fix');

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], workflowOptions(fixture, {
    now: new Date('2026-05-21T00:00:00.000Z')
  }));
  assert.equal(beginFix.ok, true);
  assert.equal(beginFix.status, 'begin-fix');
  assertFileExists(beginFix.fixGuardReportPath);

  const fixContext = await runWorkflowCommand('context', [
    ...workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'),
    '--phase',
    'fix'
  ], workflowOptions(fixture));
  assert.equal(fixContext.ok, true);
  assert.equal(fixContext.contextPackSkeleton.phase, 'fix');
  assertFileExists(fixContext.contextManifestPath);

  fs.writeFileSync(
    fixture.target,
    [
      '# Practical Workflow Target',
      '',
      'The document now states the expected behavior directly for implementers.',
      '',
      '## Acceptance',
      '',
      '- The final wording names the expected behavior.',
      ''
    ].join('\n')
  );

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: FIX_REPORT }));
  assert.equal(endFix.ok, true);
  assert.equal(endFix.status, 'end-fix');
  assertFileExists(endFix.fixReportPath);
  assertManifestPhase(start.manifestPath, 'diff-review', 'diff-review');

  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: DIFF_OK }));
  assert.equal(diff.ok, true);
  assert.equal(diff.status, 'recorded-diff-review');
  assertFileExists(diff.diffReviewReportPath);
  assertManifestPhase(start.manifestPath, 'full-re-review', 'full-re-review');

  const fullReviewContext = await runWorkflowCommand('context', [
    ...workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'),
    '--phase',
    'full-re-review'
  ], workflowOptions(fixture));
  assert.equal(fullReviewContext.ok, true);
  assert.equal(fullReviewContext.contextPackSkeleton.phase, 'full-re-review');
  assertFileExists(fullReviewContext.contextManifestPath);

  const fullReview = await runWorkflowCommand('record-review', [
    ...workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'),
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_PASS }));
  assert.equal(fullReview.ok, true);
  assertFileExists(fullReview.reviewerReportPath);

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: FINAL_PASS }));
  assert.equal(final.ok, true);
  assert.equal(final.status, 'pass');
  assert.equal(final.assurance, 'practical');

  const finalManifest = assertManifestPhase(start.manifestPath, 'pass', 'final');
  assert.equal(finalManifest.assurance, 'practical');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: start.targetKey }), null);

  const ledger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'fixed');

  const statusLines = git(fixture.root, ['status', '--porcelain'])
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(statusLines.length > 0, true);
  assert.equal(statusLines.every((line) => (
    line.includes('docs/practical-target.md') ||
    line.includes('.docs-review-fix/')
  )), true, statusLines.join('\n'));
  assert.deepEqual(git(fixture.root, ['diff', '--name-only']).trim().split('\n').filter(Boolean), [
    'docs/practical-target.md'
  ]);
});

test('persistent start rejects stale project RULE.md before writing target state', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const projectStateDir = path.join(fixture.root, '.docs-review-fix');
  fs.mkdirSync(projectStateDir, { recursive: true });
  fs.writeFileSync(path.join(projectStateDir, 'RULE.md'), '## COMMON\nOld config\n');

  const result = await runWorkflowCommand('start', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), workflowOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /RULE\.md|stale/i);
  assert.equal(fs.existsSync(path.join(projectStateDir, 'targets')), false);
  if (result.targetStateDir) {
    assert.equal(fs.existsSync(result.targetStateDir), false);
  }
});

test('persistent start uses stale project RULE.md as root marker before falling back to outer cwd', async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-e2e-outer-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-e2e-home-'));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const projectRoot = path.join(outer, 'project');
  const docsDir = path.join(projectRoot, 'docs');
  const projectStateDir = path.join(projectRoot, '.docs-review-fix');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(projectStateDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_ROOT, 'practical-target.md'), path.join(docsDir, 'practical-target.md'));
  fs.copyFileSync(path.join(FIXTURE_ROOT, 'reference.md'), path.join(docsDir, 'reference.md'));
  fs.writeFileSync(path.join(projectStateDir, 'RULE.md'), '## COMMON\nOld config\n');

  const result = await runWorkflowCommand('start', [
    'review-fix-design',
    `target=${path.join(docsDir, 'practical-target.md')}`,
    `ref=${path.join(docsDir, 'reference.md')}`,
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
  ], {
    cwd: outer,
    homeDir
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /RULE\.md|stale/i);
  assert.equal(fs.existsSync(path.join(projectStateDir, 'targets')), false);
  assert.equal(fs.existsSync(path.join(outer, '.docs-review-fix', 'targets')), false);
});

test('persistent start rejects symlinked target state directory before outside writes', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-e2e-outside-state-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const probe = await runWorkflowCommand('start', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), workflowOptions(fixture));
  const targetStateDir = probe.targetStateDir;
  fs.rmSync(path.join(fixture.root, '.docs-review-fix'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetStateDir), { recursive: true });
  fs.symlinkSync(outside, targetStateDir, 'dir');

  const result = await runWorkflowCommand('start', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), workflowOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /symlink|target state/i);
  assert.equal(fs.existsSync(path.join(outside, 'MANIFEST.md')), false);
  assert.equal(fs.existsSync(path.join(outside, 'ISSUES.md')), false);
});

test('persistent start rejects stale global RULE.md before writing target state', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const poisonedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-e2e-poison-home-'));
  t.after(() => fs.rmSync(poisonedHome, { recursive: true, force: true }));
  fs.mkdirSync(path.join(poisonedHome, '.docs-review-fix'), { recursive: true });
  fs.writeFileSync(path.join(poisonedHome, '.docs-review-fix', 'RULE.md'), '## COMMON\nOld global config\n');

  const result = await runWorkflowCommand('start', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), {
    ...workflowOptions(fixture),
    homeDir: poisonedHome
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /RULE\.md|stale/i);
  assert.equal(fs.existsSync(path.join(fixture.root, '.docs-review-fix', 'targets')), false);
});

test('persistent start rejects unknown markdown file under project rules', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const rulesDir = path.join(fixture.root, '.docs-review-fix', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'SPEC-RULE.md'), 'Wrong filename\n');

  const result = await runWorkflowCommand('start', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), workflowOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /unknown custom rule file|SPEC-RULE\.md/i);
  assert.equal(fs.existsSync(path.join(fixture.root, '.docs-review-fix', 'targets')), false);
});

test('no-state read-only fixture finalizes read-only-clean without state', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const context = await runWorkflowCommand('context', [
    '--no-state',
    ...workflowStartArgs(fixture, 'read-only', 'advisory', 'manual'),
    '--phase',
    'initial-review'
  ], workflowOptions(fixture));
  assert.equal(context.ok, true);
  assert.equal(context.targetStateDir, null);
  assert.equal(typeof context.reviewGuard, 'string');
  assert.equal(fs.existsSync(path.join(fixture.root, '.docs-review-fix')), false);

  const review = await runWorkflowCommand('record-review', [
    '--no-state',
    ...workflowStartArgs(fixture, 'read-only', 'advisory', 'manual'),
    '--review-guard',
    context.reviewGuard,
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_PASS }));
  assert.equal(review.ok, true);
  assert.equal(review.status, 'recorded-review');
  assert.equal(typeof review.stateToken, 'string');
  assert.equal(fs.existsSync(path.join(fixture.root, '.docs-review-fix')), false);

  const finalized = await runWorkflowCommand('finalize', [
    '--no-state',
    ...workflowStartArgs(fixture, 'read-only', 'advisory', 'manual'),
    '--state-token',
    review.stateToken,
    '--final-response-stdin'
  ], workflowOptions(fixture, { stdin: FINAL_CLEAN }));
  assert.equal(finalized.ok, true);
  assert.equal(finalized.status, 'read-only-clean');
  assert.notEqual(finalized.status, 'pass');
  assert.equal(fs.existsSync(path.join(fixture.root, '.docs-review-fix')), false);
});
