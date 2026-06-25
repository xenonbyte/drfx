'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { parseLedger } = require('../lib/ledger');
const { acquireLock, readLease } = require('../lib/lock');
const { runWorkflowCommand } = require('../lib/workflow');
const { formatManifestV2, parseManifestV2 } = require('../lib/workflow-state');

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

const TRIAGE_REOPEN = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: reopened',
  '  severity: high',
  '  original_severity: high',
  '  rationale: The re-review shows the issue is not yet resolved.',
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

const FIX_REPORT_WITH_VERIFICATION = [
  'Fixed:',
  '- ISSUE-001: Clarified the target wording.',
  '',
  'Files changed:',
  '- docs/practical-target.md',
  '',
  'Not fixed:',
  '- none',
  '',
  'Verification:',
  '- node --test test/workflow-e2e.test.js: passed',
  '',
  'Residual risk:',
  '- none identified'
].join('\n');
const INVALID_FIX_REPORT = 'this is not a normalized fix report';

const DIFF_OK = 'DIFF-OK\nSummary: Target-only edit addresses ISSUE-001.\n';
const DIFF_FAIL = [
  'DIFF-FAIL',
  'Findings:',
  '- issue_id: ISSUE-001',
  '  problem: The change still leaves ambiguous wording.',
  '  required_action: Rewrite the sentence again.'
].join('\n');
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

function makeNonGitWorkflowFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-e2e-non-git-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-e2e-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_ROOT, 'practical-target.md'), path.join(root, 'docs', 'practical-target.md'));
  fs.copyFileSync(path.join(FIXTURE_ROOT, 'reference.md'), path.join(root, 'docs', 'reference.md'));
  return {
    root,
    homeDir,
    target: path.join(root, 'docs', 'practical-target.md'),
    reference: path.join(root, 'docs', 'reference.md')
  };
}

function workflowStartArgs(fixture, mode, assurance, runtimePlatform, options = {}) {
  const guardToken = options.guardMode ? [`guard=${options.guardMode}`] : [];
  const roundsToken = options.rounds ? [`rounds=${options.rounds}`] : [];
  return [
    'review-fix-design',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    `ref=${fixture.reference}`,
    mode,
    ...guardToken,
    ...roundsToken,
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

function writeManifest(manifestPath, mutator) {
  const manifest = manifestAt(manifestPath);
  const next = mutator({ ...manifest });
  fs.writeFileSync(manifestPath, formatManifestV2(next));
  return manifestAt(manifestPath);
}

function readJsonReport(reportPath) {
  const text = fs.readFileSync(reportPath, 'utf8');
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, `missing json block in ${reportPath}`);
  return JSON.parse(match[1]);
}

function writeJsonReport(reportPath, report) {
  const text = fs.readFileSync(reportPath, 'utf8');
  fs.writeFileSync(
    reportPath,
    text.replace(/```json\n[\s\S]*?\n```/, '```json\n' + JSON.stringify(report, null, 2) + '\n```')
  );
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

function fixedTargetBody(body = 'The document now states the expected behavior directly for implementers.') {
  return [
    '# Practical Workflow Target',
    '',
    body,
    '',
    '## Acceptance',
    '',
    '- The final wording names the expected behavior.',
    ''
  ].join('\n');
}

async function reachFixReportMismatchBlock(t, options = {}) {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', {
    guardMode: options.guardMode || 'git'
  });
  const opts = (overrides = {}) => workflowOptions(fixture, {
    now: new Date('2026-05-21T00:00:00.000Z'),
    ...overrides
  });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal(start.ok, true, JSON.stringify(start));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [
    ...startArgs,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [
    ...startArgs,
    '--triage-stdin'
  ], workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  const baselinePath = beginFix.fixGuardReportPath;
  const beforeBlockManifest = manifestAt(start.manifestPath);
  const beforeBlockLedger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));

  fs.writeFileSync(fixture.target, fixedTargetBody(options.targetBody));
  const blocked = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: INVALID_FIX_REPORT }));

  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockingReason, 'fix-report-mismatch');
  assert.doesNotMatch(JSON.stringify(blocked), /this is not a normalized fix report/);
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: start.targetKey }), null);

  return {
    fixture,
    start,
    startArgs,
    opts,
    beginFix,
    baselinePath,
    beforeBlockManifest,
    beforeBlockLedger,
    blocked
  };
}

async function retryBeginFix(state) {
  return runWorkflowCommand('begin-fix', [state.start.targetStateDir, '--json'], state.opts());
}

function assertBlockedRetry(result, expectedReason) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, expectedReason);
  assert.notEqual(result.nextAction, null);
}

async function reachPersistentPassReady(fixture) {
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex');
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal(start.ok, true, JSON.stringify(start));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [
    ...startArgs,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [
    ...startArgs,
    '--triage-stdin'
  ], workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], workflowOptions(fixture, {
    now: new Date('2026-05-21T00:00:00.000Z')
  }));
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
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
  await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: DIFF_OK }));
  await runWorkflowCommand('context', [
    ...startArgs,
    '--phase',
    'full-re-review'
  ], workflowOptions(fixture));
  await runWorkflowCommand('record-review', [
    ...startArgs,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_PASS }));
  return start;
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
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
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
  assert.ok(final.archivedStatePath, 'state dir is archived on pass');
  assert.match(final.archivedStatePath, /\.drfx\/archived\/.+/);

  const archivedManifestPath = path.join(final.archivedStatePath, 'MANIFEST.md');
  const finalManifest = assertManifestPhase(archivedManifestPath, 'pass', 'final');
  assert.equal(finalManifest.assurance, 'practical');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: start.targetKey }), null);

  const archivedLedgerPath = path.join(final.archivedStatePath, path.relative(start.targetStateDir, start.ledgerPath));
  const ledger = parseLedger(fs.readFileSync(archivedLedgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'fixed');

  const statusLines = git(fixture.root, ['status', '--porcelain'])
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(statusLines.length > 0, true);
  assert.equal(statusLines.every((line) => (
    line.includes('docs/practical-target.md') ||
    line.includes('.drfx/')
  )), true, statusLines.join('\n'));
  assert.deepEqual(git(fixture.root, ['diff', '--name-only']).trim().split('\n').filter(Boolean), [
    'docs/practical-target.md'
  ]);
});

test('document end-fix accepts optional Verification in the fix report', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex');
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal(start.ok, true, JSON.stringify(start));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [
    ...startArgs,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [
    ...startArgs,
    '--triage-stdin'
  ], workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], workflowOptions(fixture, {
    now: new Date('2026-05-21T00:00:00.000Z')
  }));
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
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
  ], workflowOptions(fixture, { stdin: FIX_REPORT_WITH_VERIFICATION }));
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.status, 'end-fix');
  assertFileExists(endFix.fixReportPath);
  const normalizedReport = fs.readFileSync(endFix.fixReportPath, 'utf8');
  assert.match(normalizedReport, /"verification": \[\n\s+"node --test test\/workflow-e2e\.test\.js: passed"\n\s+\]/);
});

test('fix-report-mismatch begin-fix retry reuses original guard baseline and returns only to diff-review', async (t) => {
  const state = await reachFixReportMismatchBlock(t);
  const beforeRetryManifest = manifestAt(state.start.manifestPath);
  const beforeRetryLedger = parseLedger(fs.readFileSync(state.start.ledgerPath, 'utf8'));

  const retry = await retryBeginFix(state);

  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.status, 'begin-fix');
  assert.equal(retry.nextAction, 'retry end-fix with a valid fix report');
  assert.equal(retry.fixGuardReportPath, state.baselinePath);
  assert.notEqual(retry.lockOwnerId, state.beginFix.lockOwnerId);
  assert.notEqual(readLease({ projectRoot: state.fixture.root, targetKey: state.start.targetKey }), null);

  const afterRetryManifest = assertManifestPhase(state.start.manifestPath, 'fix', 'fix');
  assert.equal(afterRetryManifest.blockingReason, 'none');
  assert.equal(Number(afterRetryManifest.fixAttemptCount), Number(beforeRetryManifest.fixAttemptCount));
  assert.equal(Number(afterRetryManifest.currentRound), Number(beforeRetryManifest.currentRound));
  assert.equal(afterRetryManifest.currentReportPath, beforeRetryManifest.currentReportPath);

  const afterRetryLedger = parseLedger(fs.readFileSync(state.start.ledgerPath, 'utf8'));
  assert.deepEqual(afterRetryLedger.issues.map((issue) => [issue.id, issue.status]), [
    ['ISSUE-001', 'accepted']
  ]);
  assert.deepEqual(afterRetryLedger.issues.map((issue) => issue.id), beforeRetryLedger.issues.map((issue) => issue.id));
  assert.deepEqual(afterRetryLedger.issues.map((issue) => issue.status), beforeRetryLedger.issues.map((issue) => issue.status));

  const correctedEndFix = await runWorkflowCommand('end-fix', [
    state.start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], workflowOptions(state.fixture, { stdin: FIX_REPORT }));

  assert.equal(correctedEndFix.ok, true, JSON.stringify(correctedEndFix));
  assert.equal(correctedEndFix.status, 'end-fix');
  const afterEndManifest = assertManifestPhase(state.start.manifestPath, 'diff-review', 'diff-review');
  assert.notEqual(afterEndManifest.status, 'pass');

  const diff = await runWorkflowCommand('record-diff-review', [
    state.start.targetStateDir,
    '--result-stdin',
    '--json'
  ], workflowOptions(state.fixture, { stdin: DIFF_OK }));
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assertManifestPhase(state.start.manifestPath, 'full-re-review', 'full-re-review');

  await runWorkflowCommand('context', [
    ...state.startArgs,
    '--phase',
    'full-re-review'
  ], workflowOptions(state.fixture));
  const fullReview = await runWorkflowCommand('record-review', [
    ...state.startArgs,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], workflowOptions(state.fixture, { stdin: REVIEW_PASS }));
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  const final = await runWorkflowCommand('finalize', [
    state.start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], workflowOptions(state.fixture, { stdin: FINAL_PASS }));
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
});

const FIX_REPORT_RETRY_BASELINE_CASES = [
  {
    name: 'missing baseline',
    expectedReason: 'target-only-guard-unavailable',
    mutate: ({ baselinePath }) => fs.rmSync(baselinePath, { force: true })
  },
  {
    name: 'unparseable baseline',
    expectedReason: 'target-only-guard-unavailable',
    mutate: ({ baselinePath }) => fs.writeFileSync(baselinePath, '# Fix Guard Report\n\nnot json\n')
  },
  {
    name: 'failed baseline',
    expectedReason: 'target-only-guard-unavailable',
    mutate: ({ baselinePath }) => {
      const report = readJsonReport(baselinePath);
      report.status = 'blocked';
      writeJsonReport(baselinePath, report);
    }
  },
  {
    name: 'baseline target mismatch',
    expectedReason: 'target-only-guard-unavailable',
    mutate: ({ baselinePath }) => {
      const report = readJsonReport(baselinePath);
      report.normalizedTarget = 'docs/other.md';
      writeJsonReport(baselinePath, report);
    }
  },
  {
    name: 'missing passed rollback anchor',
    expectedReason: 'target-only-guard-unavailable',
    mutate: ({ baselinePath }) => {
      const report = readJsonReport(baselinePath);
      report.rollbackAnchor = { status: 'blocked', blockingReason: 'rollback-unavailable' };
      writeJsonReport(baselinePath, report);
    }
  },
  {
    name: 'missing rollback snapshot path',
    expectedReason: 'target-only-guard-unavailable',
    mutate: ({ baselinePath }) => {
      const report = readJsonReport(baselinePath);
      delete report.rollbackAnchor.snapshotPath;
      writeJsonReport(baselinePath, report);
    }
  },
  {
    name: 'missing rollback snapshot body',
    expectedReason: 'target-only-guard-unavailable',
    mutate: ({ baselinePath, start }) => {
      const report = readJsonReport(baselinePath);
      fs.rmSync(path.join(start.targetStateDir, report.rollbackAnchor.snapshotPath), { force: true });
    }
  },
  {
    name: 'corrupted rollback snapshot body',
    expectedReason: 'target-only-guard-unavailable',
    mutate: ({ baselinePath, start }) => {
      const report = readJsonReport(baselinePath);
      fs.writeFileSync(path.join(start.targetStateDir, report.rollbackAnchor.snapshotPath), 'corrupted rollback body\n');
    }
  },
  {
    name: 'string rollback snapshot expected size',
    expectedReason: 'target-only-guard-unavailable',
    mutate: ({ baselinePath }) => {
      const report = readJsonReport(baselinePath);
      report.targetFingerprint.size = String(report.targetFingerprint.size);
      writeJsonReport(baselinePath, report);
    }
  },
  {
    name: 'missing passed target-only guard result',
    expectedReason: 'target-only-guard-unavailable',
    mutate: ({ baselinePath }) => {
      const report = readJsonReport(baselinePath);
      report.targetOnlyGuard = { status: 'blocked', blockingReason: 'unexpected-worktree-change' };
      writeJsonReport(baselinePath, report);
    }
  }
];

for (const entry of FIX_REPORT_RETRY_BASELINE_CASES) {
  test(`begin-fix retry fails closed for fix-report-mismatch ${entry.name}`, async (t) => {
    const state = await reachFixReportMismatchBlock(t);
    const before = manifestAt(state.start.manifestPath);
    entry.mutate(state);

    const retry = await retryBeginFix(state);

    assertBlockedRetry(retry, entry.expectedReason);
    const after = assertManifestPhase(state.start.manifestPath, 'blocked', 'fix');
    assert.equal(after.blockingReason, entry.expectedReason);
    assert.equal(Number(after.fixAttemptCount), Number(before.fixAttemptCount));
    assert.equal(Number(after.currentRound), Number(before.currentRound));
  });
}

test('begin-fix retry fails closed for fix-report-mismatch reference mutation', async (t) => {
  const state = await reachFixReportMismatchBlock(t);
  fs.writeFileSync(state.fixture.reference, '# Reference\n\nTampered during blocked retry.\n');

  const retry = await retryBeginFix(state);

  assertBlockedRetry(retry, 'reference-mutated-file');
  assertManifestPhase(state.start.manifestPath, 'blocked', 'fix');
});

test('begin-fix retry fails closed for fix-report-mismatch non-target mutation', async (t) => {
  const state = await reachFixReportMismatchBlock(t);
  fs.writeFileSync(path.join(state.fixture.root, 'docs', 'unrelated.md'), '# Unrelated\n');

  const retry = await retryBeginFix(state);

  assertBlockedRetry(retry, 'unexpected-worktree-change');
  assertManifestPhase(state.start.manifestPath, 'blocked', 'fix');
});

test('begin-fix retry fails closed for fix-report-mismatch target mutation', async (t) => {
  const state = await reachFixReportMismatchBlock(t);
  fs.writeFileSync(state.fixture.target, fixedTargetBody('Tampered after the failed end-fix released the lease.'));

  const retry = await retryBeginFix(state);

  assertBlockedRetry(retry, 'unexpected-worktree-change');
  assertManifestPhase(state.start.manifestPath, 'blocked', 'fix');
  assert.equal(readLease({ projectRoot: state.fixture.root, targetKey: state.start.targetKey }), null);
});

test('begin-fix retry fails closed for fix-report-mismatch target-only guard unavailable', async (t) => {
  const state = await reachFixReportMismatchBlock(t, { guardMode: 'snapshot' });
  const report = readJsonReport(state.baselinePath);
  delete report.targetOnlyGuard.entries;
  writeJsonReport(state.baselinePath, report);

  const retry = await retryBeginFix(state);

  assertBlockedRetry(retry, 'target-only-guard-unavailable');
  assertManifestPhase(state.start.manifestPath, 'blocked', 'fix');
});

test('begin-fix retry preserves fix counters and ledger before corrected end-fix', async (t) => {
  const state = await reachFixReportMismatchBlock(t);
  const beforeManifest = manifestAt(state.start.manifestPath);
  const beforeLedger = parseLedger(fs.readFileSync(state.start.ledgerPath, 'utf8'));

  const retry = await retryBeginFix(state);

  assert.equal(retry.ok, true, JSON.stringify(retry));
  const afterManifest = manifestAt(state.start.manifestPath);
  const afterLedger = parseLedger(fs.readFileSync(state.start.ledgerPath, 'utf8'));
  assert.equal(Number(afterManifest.fixAttemptCount), Number(state.beforeBlockManifest.fixAttemptCount));
  assert.equal(Number(afterManifest.fixAttemptCount), Number(beforeManifest.fixAttemptCount));
  assert.equal(Number(afterManifest.currentRound), Number(beforeManifest.currentRound));
  assert.deepEqual(afterLedger.issues.map((issue) => issue.id), beforeLedger.issues.map((issue) => issue.id));
  assert.deepEqual(afterLedger.issues.map((issue) => issue.status), ['accepted']);
  assert.deepEqual(afterLedger.issues.map((issue) => issue.status), state.beforeBlockLedger.issues.map((issue) => issue.status));
});

test('begin-fix retry fails closed when lock reacquisition fails after fix-report-mismatch', async (t) => {
  const state = await reachFixReportMismatchBlock(t);
  acquireLock({
    projectRoot: state.fixture.root,
    targetKey: state.start.targetKey,
    targetPath: state.fixture.target,
    ownerId: 'external-owner',
    now: new Date('2026-05-21T00:01:00.000Z'),
    manifest: manifestAt(state.start.manifestPath)
  });

  const retry = await retryBeginFix(state);

  assertBlockedRetry(retry, 'lock-held');
  assertManifestPhase(state.start.manifestPath, 'blocked', 'fix');
  const lease = readLease({ projectRoot: state.fixture.root, targetKey: state.start.targetKey });
  assert.equal(lease.ownerId, 'external-owner');
});

test('begin-fix retry is unavailable for non-retryable fix-report-mismatch manifest states', async (t) => {
  const cases = [
    {
      name: 'non-retryable status',
      mutate: (manifest) => ({
        ...manifest,
        status: 'review',
        currentPhase: 'review',
        blockingReason: 'none'
      })
    },
    {
      name: 'wrong currentPhase',
      mutate: (manifest) => ({ ...manifest, currentPhase: 'diff-review' })
    },
    {
      name: 'wrong blockingReason',
      mutate: (manifest) => ({ ...manifest, blockingReason: 'diff-review-failed' })
    },
    {
      name: 'missing immediately preceding invalid end-fix receipt',
      mutate: (manifest, state) => {
        fs.rmSync(path.join(state.start.targetStateDir, 'rounds', '001-fix-blocked.md'), { force: true });
        return manifest;
      }
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const state = await reachFixReportMismatchBlock(t);
      writeManifest(state.start.manifestPath, (manifest) => entry.mutate(manifest, state));

      const retry = await retryBeginFix(state);

      assert.equal(retry.ok, false, JSON.stringify(retry));
      assert.notEqual(retry.nextAction, 'retry end-fix with a valid fix report');
      assert.equal(readLease({ projectRoot: state.fixture.root, targetKey: state.start.targetKey }), null);
    });
  }
});

test('persistent finalize refuses a symlinked archive root and reports repair action', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const start = await reachPersistentPassReady(fixture);
  const archiveSink = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-archive-sink-'));
  t.after(() => fs.rmSync(archiveSink, { recursive: true, force: true }));
  fs.symlinkSync(archiveSink, path.join(fixture.root, '.drfx', 'archived'), 'dir');

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: FINAL_PASS }));

  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  assert.equal(final.archivedStatePath, undefined);
  assert.match(final.archiveWarning, /archive root directory.*symlink/i);
  assert.match(final.nextAction, /delete or reset.*retry/i);
  assert.equal(fs.existsSync(start.targetStateDir), true);
  assert.deepEqual(fs.readdirSync(archiveSink), []);

  const summary = fs.readFileSync(path.join(start.targetStateDir, 'SUMMARY.md'), 'utf8');
  assert.match(summary, /Status: pass/);
  assert.match(summary, /Next action: delete or reset the leftover terminal state directory, then retry/);
});

test('persistent start rejects stale project RULE.md before writing target state', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const projectStateDir = path.join(fixture.root, '.drfx');
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
  const projectStateDir = path.join(projectRoot, '.drfx');
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
    'guard=snapshot',
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
  assert.equal(fs.existsSync(path.join(outer, '.drfx', 'targets')), false);
});

test('persistent start rejects symlinked target state directory before outside writes', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-e2e-outside-state-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const probe = await runWorkflowCommand('start', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), workflowOptions(fixture));
  const targetStateDir = probe.targetStateDir;
  fs.rmSync(path.join(fixture.root, '.drfx'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetStateDir), { recursive: true });
  fs.symlinkSync(outside, targetStateDir, 'dir');

  const args = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex');
  args.splice(4, 0, 'strict');
  const result = await runWorkflowCommand('start', args, workflowOptions(fixture));

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
  fs.mkdirSync(path.join(poisonedHome, '.drfx'), { recursive: true });
  fs.writeFileSync(path.join(poisonedHome, '.drfx', 'RULE.md'), '## COMMON\nOld global config\n');

  const result = await runWorkflowCommand('start', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), {
    ...workflowOptions(fixture),
    homeDir: poisonedHome
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /RULE\.md|stale/i);
  assert.equal(fs.existsSync(path.join(fixture.root, '.drfx', 'targets')), false);
});

test('persistent start rejects unknown markdown file under project rules', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const rulesDir = path.join(fixture.root, '.drfx', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'SPEC-RULE.md'), 'Wrong filename\n');

  const strictArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex');
  strictArgs.splice(4, 0, 'strict');
  const result = await runWorkflowCommand('start', strictArgs, workflowOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /unknown custom rule file|SPEC-RULE\.md/i);
  assert.equal(fs.existsSync(path.join(fixture.root, '.drfx', 'targets')), false);
});

test('persistent start rejects default git guard outside a git worktree', async (t) => {
  const fixture = makeNonGitWorkflowFixture(t);

  const result = await runWorkflowCommand('start', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), workflowOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'git-guard-unavailable');
  assert.equal(result.blockingReason, 'none');
  assert.equal(fs.existsSync(path.join(fixture.root, '.drfx')), false);
});

test('non-git snapshot guard workflow reaches pass with target-only diff', async (t) => {
  const fixture = makeNonGitWorkflowFixture(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'snapshot' });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal(start.ok, true);
  assert.equal(start.status, 'review');
  assert.equal(start.guardMode, 'snapshot');
  assertManifestPhase(start.manifestPath, 'review', 'review');
  assert.equal(manifestAt(start.manifestPath).guardMode, 'snapshot');

  assert.equal((await runWorkflowCommand('context', startArgs, workflowOptions(fixture))).ok, true);
  assert.equal((await runWorkflowCommand('record-review', [
    ...startArgs,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_FAIL }))).ok, true);
  assert.equal((await runWorkflowCommand('record-triage', [
    ...startArgs,
    '--triage-stdin'
  ], workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }))).ok, true);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], workflowOptions(fixture, {
    now: new Date('2026-05-27T00:00:00.000Z')
  }));
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assertFileExists(path.join(start.targetStateDir, 'snapshots', 'round-001', 'target.body'));

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
  assertManifestPhase(start.manifestPath, 'diff-review', 'diff-review');

  assert.equal((await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: DIFF_OK }))).ok, true);
  assert.equal((await runWorkflowCommand('context', [
    ...startArgs,
    '--phase',
    'full-re-review'
  ], workflowOptions(fixture))).ok, true);
  assert.equal((await runWorkflowCommand('record-review', [
    ...startArgs,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_PASS }))).ok, true);

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: FINAL_PASS }));
  assert.equal(final.ok, true);
  assert.equal(final.status, 'pass');
  assert.ok(final.archivedStatePath, 'state dir is archived on pass');
  assert.match(final.archivedStatePath, /\.drfx\/archived\/.+/);
  assert.equal(assertManifestPhase(path.join(final.archivedStatePath, 'MANIFEST.md'), 'pass', 'final').guardMode, 'snapshot');
});

test('non-git snapshot guard abort-fix restores the second fix attempt snapshot', async (t) => {
  const fixture = makeNonGitWorkflowFixture(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'snapshot' });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal((await runWorkflowCommand('context', startArgs, workflowOptions(fixture))).ok, true);
  assert.equal((await runWorkflowCommand('record-review', [
    ...startArgs,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_FAIL }))).ok, true);
  assert.equal((await runWorkflowCommand('record-triage', [
    ...startArgs,
    '--triage-stdin'
  ], workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }))).ok, true);

  {
    const begin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], workflowOptions(fixture));
    assert.equal(begin.ok, true, JSON.stringify(begin));
  }
  const firstFixedBody = [
    '# Practical Workflow Target',
    '',
    'First fix still needs another pass.',
    ''
  ].join('\n');
  fs.writeFileSync(fixture.target, firstFixedBody);
  assert.equal((await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: FIX_REPORT }))).ok, true);

  const diffFail = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], workflowOptions(fixture, { stdin: DIFF_FAIL }));
  assert.equal(diffFail.ok, true);
  assert.equal(diffFail.currentPhase, 'fix');

  const secondBegin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], workflowOptions(fixture));
  assert.equal(secondBegin.ok, true, JSON.stringify(secondBegin));
  assert.equal(secondBegin.round, 2);
  const round2SnapshotPath = path.join(start.targetStateDir, 'snapshots', 'round-002', 'target.body');
  assertFileExists(round2SnapshotPath);
  fs.writeFileSync(fixture.target, '# Practical Workflow Target\n\nSecond attempt should be reverted.\n');

  const aborted = await runWorkflowCommand('abort-fix', [
    start.targetStateDir,
    '--status',
    'blocked',
    '--reason',
    'diff-review-failed',
    '--next-action',
    'manual repair',
    '--json'
  ], workflowOptions(fixture));

  assert.equal(aborted.ok, true);
  assert.equal(aborted.status, 'blocked');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), firstFixedBody);
  assert.equal(fs.existsSync(round2SnapshotPath), false);
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: start.targetKey }), null);
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
  assert.equal(fs.existsSync(path.join(fixture.root, '.drfx')), false);

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
  assert.equal(fs.existsSync(path.join(fixture.root, '.drfx')), false);

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
  assert.equal(fs.existsSync(path.join(fixture.root, '.drfx')), false);
});

test('begin-fix still blocks if target becomes dirty after route preflight passes', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const preflight = await runWorkflowCommand('preflight', [
    'review-fix-design',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--runtime-downgrade-reason',
    'none',
    '--json'
  ], workflowOptions(fixture));

  assert.equal(preflight.ok, true);
  assert.equal(preflight.status, 'write-eligible');
  assert.equal(fs.existsSync(path.join(fixture.root, '.drfx', 'targets')), false);

  const start = await runWorkflowCommand('start', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), workflowOptions(fixture));
  assert.equal(start.ok, true);
  assert.equal(start.status, 'review');

  const context = await runWorkflowCommand('context', workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'), workflowOptions(fixture));
  assert.equal(context.ok, true);

  const review = await runWorkflowCommand('record-review', [
    ...workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  assert.equal(review.ok, true);

  const triage = await runWorkflowCommand('record-triage', [
    ...workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex'),
    '--triage-stdin'
  ], workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  assert.equal(triage.ok, true);

  fs.appendFileSync(fixture.target, '\nDirty after route preflight.\n');

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], workflowOptions(fixture, {
    now: new Date('2026-05-21T00:00:00.000Z')
  }));

  assert.equal(beginFix.ok, false);
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'rollback-unavailable');
  assertFileExists(path.join(start.targetStateDir, 'reports', 'fix-guard-round-001.md'));
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: start.targetKey }), null);
});

test('guard=git allows a second fix after DIFF-OK -> full re-review FAIL', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal(start.ok, true);

  // --- Round 1: review -> triage -> fix -> DIFF-OK -> full re-review FAIL ---
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));

  const beginFix1 = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix1.ok, true, JSON.stringify(beginFix1));

  fs.writeFileSync(fixture.target,
    '# Practical Workflow Target\n\nFirst fix clarified the wording.\n\n## Acceptance\n\n- Names the expected behavior.\n');
  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));

  // currentRound is still 1 here (DIFF-OK does not increment it).
  const afterDiff = manifestAt(start.manifestPath);
  assert.equal(Number(afterDiff.currentRound), 1);

  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  const reReview = await runWorkflowCommand('record-review',
    [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  assert.equal(reReview.ok, true);

  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_REOPEN }));
  assertManifestPhase(start.manifestPath, 'fix', 'fix');

  // --- The headline: the SECOND begin-fix must NOT be blocked under guard=git ---
  const beginFix2 = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix2.ok, true, JSON.stringify(beginFix2));
  assert.equal(beginFix2.status, 'begin-fix');
  // currentRound is still 1; the prior-fix path is selected by lastKnown != initial.
  assert.equal(Number(manifestAt(start.manifestPath).currentRound), 1);

  fs.writeFileSync(fixture.target,
    '# Practical Workflow Target\n\nSecond fix fully names the expected behavior.\n\n## Acceptance\n\n- Names the expected behavior.\n- Preserves git guard multi-cycle behavior.\n');
  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));
  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  await runWorkflowCommand('record-review',
    [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_PASS }));
  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'],
    workflowOptions(fixture, { stdin: FINAL_PASS }));
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  assert.ok(final.archivedStatePath, 'state dir is archived on pass');
  assert.match(final.archivedStatePath, /\.drfx\/archived\/.+/);
  assert.equal(assertManifestPhase(path.join(final.archivedStatePath, 'MANIFEST.md'), 'pass', 'final').guardMode, 'git');
});

test('guard=git abort-fix restores the target from the per-fix snapshot', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });
  const before = fs.readFileSync(fixture.target, 'utf8');

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // Make a partial edit, then abort.
  fs.writeFileSync(fixture.target, before + '\nPartial, aborted edit.\n');
  const abort = await runWorkflowCommand('abort-fix', [
    start.targetStateDir, '--status', 'blocked', '--reason', 'lock-held', '--json'
  ], opts());
  assert.equal(abort.ok, true, JSON.stringify(abort));

  // The target is restored to its pre-fix body.
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), before);
});

test('guard=git abort-fix blocks rollback when the fix guard baseline is missing', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });
  const before = fs.readFileSync(fixture.target, 'utf8');

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.rmSync(path.join(start.targetStateDir, 'reports'), { recursive: true, force: true });
  fs.writeFileSync(fixture.target, before + '\nPartial edit without readable baseline.\n');

  const abort = await runWorkflowCommand('abort-fix', [
    start.targetStateDir, '--status', 'blocked', '--reason', 'lock-held', '--json'
  ], opts());

  assert.equal(abort.ok, false, JSON.stringify(abort));
  assert.equal(abort.status, 'blocked');
  assert.equal(abort.blockingReason, 'rollback-unavailable');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), before + '\nPartial edit without readable baseline.\n');
  assert.notEqual(readLease({ projectRoot: fixture.root, targetKey: start.targetKey }), null);
  const manifest = manifestAt(start.manifestPath);
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.blockingReason, 'rollback-unavailable');
});

async function driveToSecondFixPhase(fixture) {
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  fs.writeFileSync(fixture.target, '# Practical Workflow Target\n\nFirst fix output.\n');
  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));
  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_REOPEN }));
  return { start, opts };
}

test('guard=git second fix still rejects an external target change', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const { start, opts } = await driveToSecondFixPhase(fixture);
  // Simulate an out-of-band edit to the target before the second begin-fix.
  fs.appendFileSync(fixture.target, '\nUnexpected external edit.\n');
  const beginFix2 = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix2.ok, false);
  // G5 leaves the existing fingerprint-mismatch -> rollback-unavailable mapping unchanged
  // (re-categorizing it as externally-changed is out of scope for G5 — see "Out of scope").
  assert.equal(beginFix2.status, 'blocked');
  assert.equal(beginFix2.blockingReason, 'rollback-unavailable');
});

test('guard=git second fix still rejects a non-target worktree change', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const { start, opts } = await driveToSecondFixPhase(fixture);
  // Dirty a NON-target file in the worktree.
  fs.writeFileSync(path.join(fixture.root, 'docs', 'reference.md'), '# Reference\n\nTampered.\n');
  const beginFix2 = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix2.ok, false);
  assert.equal(beginFix2.blockingReason, 'unexpected-worktree-change');
});

// PLAN-TASK-006 compatibility: the selected guard must never silently switch. Under
// guard=snapshot inside a git repo, a non-target change made DURING the fix is blocked by
// the SNAPSHOT guard (monitored-tree fingerprints diffed against the begin-fix baseline),
// NOT by git, and the persisted guardMode stays 'snapshot' throughout.
test('guard=snapshot in a git repo blocks a non-target change without switching to git', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'snapshot' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal(start.ok, true);
  assert.equal(start.guardMode, 'snapshot');
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));

  // An unrelated (non-target, non-reference) project file exists at baseline.
  const unrelated = path.join(fixture.root, 'docs', 'unrelated.md');
  fs.writeFileSync(unrelated, '# Unrelated\n');

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(manifestAt(start.manifestPath).guardMode, 'snapshot');

  // The fixer edits the target AND tampers the unrelated project file during the fix.
  fs.writeFileSync(fixture.target, '# Practical Workflow Target\n\nFix output names the expected behavior.\n');
  fs.writeFileSync(unrelated, '# Unrelated\n\nTampered mid-fix.\n');

  const endFix = await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  assert.equal(endFix.ok, false, JSON.stringify(endFix));
  assert.equal(endFix.blockingReason, 'unexpected-worktree-change');
  // The guard did not fall back to git: guardMode is unchanged in the manifest.
  assert.equal(manifestAt(start.manifestPath).guardMode, 'snapshot');
});

test('guard=git second fix rejects an empty fix that did not change the target this round', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const { start, opts } = await driveToSecondFixPhase(fixture);
  // Second begin-fix succeeds; the target is still the (dirty vs HEAD) first-fix output.
  const beginFix2 = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix2.ok, true, JSON.stringify(beginFix2));

  // The fixer changes nothing this round, but submits a fix report claiming ISSUE-001 fixed.
  const endFix = await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  // It must be rejected: relative to HEAD the target looks changed, but it is identical
  // to this round's pre-fix snapshot, so no real fix happened.
  assert.equal(endFix.ok, false, JSON.stringify(endFix));
  assert.equal(endFix.blockingReason, 'fix-report-mismatch');
});

test('guard=git abort-fix without a snapshot anchor still completes (legacy fix state)', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // Simulate a pre-upgrade git fix-guard report: strip the snapshotPath and drop the snapshot.
  const reportPath = path.join(start.targetStateDir, 'reports', 'fix-guard-round-001.md');
  const reportText = fs.readFileSync(reportPath, 'utf8');
  const report = JSON.parse(reportText.match(/```json\n([\s\S]*?)\n```/)[1]);
  delete report.rollbackAnchor.snapshotPath;
  fs.writeFileSync(reportPath,
    reportText.replace(/```json\n[\s\S]*?\n```/, '```json\n' + JSON.stringify(report, null, 2) + '\n```'));
  fs.rmSync(path.join(start.targetStateDir, 'snapshots'), { recursive: true, force: true });

  // A partial edit then abort: abort must still complete (write receipt + release lock), no restore.
  fs.appendFileSync(fixture.target, '\nPartial edit.\n');
  const abort = await runWorkflowCommand('abort-fix', [
    start.targetStateDir, '--status', 'blocked', '--reason', 'lock-held', '--json'
  ], opts());
  assert.equal(abort.ok, true, JSON.stringify(abort));
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: start.targetKey }), null);
});

test('begin-fix refuses the attempt past the fix-attempt cap with stopped-no-progress', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));

  // Seed the manifest at the cap (5) so the next begin-fix is the refused 6th attempt.
  const manifestPath = start.manifestPath;
  const text = fs.readFileSync(manifestPath, 'utf8').replace(/^Fix attempt count: \d+$/m, 'Fix attempt count: 5');
  fs.writeFileSync(manifestPath, text);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, false, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'stopped-no-progress');
  assert.equal(beginFix.statusReason, 'no-progress-detected');
  // The target was not modified by the refused attempt, but the route must still
  // finalize to write the final receipt/summary through the validated final path.
  assert.equal(manifestAt(manifestPath).status, 'stopped-no-progress');

  const FINAL_NO_PROGRESS = [
    'Final status: stopped-no-progress',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/practical-target.md',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: begin-fix cap refusal',
    'Deferrals or blockers: ISSUE-001 unresolved after fix-attempt cap',
    'Blocking reason: none',
    'Status reason: no-progress-detected',
    'Residual risk: ISSUE-001 remains unresolved',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');
  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'],
    workflowOptions(fixture, { stdin: FINAL_NO_PROGRESS }));
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'stopped-no-progress');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'rounds', '001-final-stopped-no-progress.md')), true);
});

test('begin-fix at the cap returns the active in-progress fix instead of stopping no-progress', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  const text = fs.readFileSync(start.manifestPath, 'utf8').replace(/^Fix attempt count: \d+$/m, 'Fix attempt count: 5');
  fs.writeFileSync(start.manifestPath, text);

  const duplicateBegin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(duplicateBegin.ok, true, JSON.stringify(duplicateBegin));
  assert.equal(duplicateBegin.status, 'begin-fix');
  assert.equal(duplicateBegin.lockOwnerId, beginFix.lockOwnerId);
  assert.equal(duplicateBegin.leaseId, beginFix.leaseId);
  assert.equal(duplicateBegin.fixGuardReportPath, beginFix.fixGuardReportPath);
  const manifest = manifestAt(start.manifestPath);
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.currentPhase, 'fix');
  assert.equal(manifest.statusReason, 'none');
  assert.notEqual(readLease({ projectRoot: fixture.root, targetKey: start.targetKey }), null);
});

test('finalize accepts a stopped-no-progress final response', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));

  // Seed the manifest at the cap so begin-fix is refused
  const text = fs.readFileSync(start.manifestPath, 'utf8').replace(/^Fix attempt count: \d+$/m, 'Fix attempt count: 5');
  fs.writeFileSync(start.manifestPath, text);
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'],
    workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') }));

  const FINAL_NO_PROGRESS = [
    'Final status: stopped-no-progress',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/practical-target.md',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: node --test test/workflow-e2e.test.js',
    'Deferrals or blockers: ISSUE-001 unresolved after fix-attempt cap',
    'Blocking reason: none',
    'Status reason: no-progress-detected',
    'Residual risk: ISSUE-001 remains unresolved',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');

  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'],
    workflowOptions(fixture, { stdin: FINAL_NO_PROGRESS }));
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'stopped-no-progress');
});

test('recurring high finding after full re-review finalizes stopped-no-progress', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'],
    workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') }));

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

  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));
  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_REOPEN }));

  const FINAL_NO_PROGRESS = [
    'Final status: stopped-no-progress',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/practical-target.md',
    'Files changed: docs/practical-target.md',
    'Fixed issue IDs: ISSUE-001',
    'Verification performed: full re-review found recurring ISSUE-001',
    'Deferrals or blockers: ISSUE-001 recurred at docs/practical-target.md#practical-workflow-target',
    'Blocking reason: none',
    'Status reason: no-progress-detected',
    'Residual risk: ISSUE-001 remains unresolved after recurrence',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');

  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'],
    workflowOptions(fixture, { stdin: FINAL_NO_PROGRESS }));
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'stopped-no-progress');
  const manifest = manifestAt(start.manifestPath);
  assert.equal(manifest.status, 'stopped-no-progress');
  assert.equal(manifest.statusReason, 'no-progress-detected');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'rounds', '001-final-stopped-no-progress.md')), true);
});

test('rounds=N persists Round limit in the start manifest as durable workflow metadata', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git', rounds: 5 });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal(start.ok, true, JSON.stringify(start));

  const manifestText = fs.readFileSync(start.manifestPath, 'utf8');
  assert.match(manifestText, /^Round limit: 5$/m);
  const manifest = manifestAt(start.manifestPath);
  assert.equal(manifest.roundLimit, '5');
  // roundLimit is NOT derived from currentRound or any receipt rounds/ directory.
  assert.equal(manifest.currentRound, 1);
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'rounds')), false);
});

test('no-rounds start manifest stays free of any Round limit line', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.doesNotMatch(fs.readFileSync(start.manifestPath, 'utf8'), /Round limit:/);
  assert.equal(manifestAt(start.manifestPath).roundLimit, 'none');
});

test('rounds=1 stops with deferrals when findings remain after the post-fix full re-review', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git', rounds: 1 });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal(start.ok, true);

  // Round 1: review FAIL -> triage accept -> fix -> DIFF-OK -> full re-review FAIL.
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  fs.writeFileSync(fixture.target, '# Practical Workflow Target\n\nFirst fix output.\n');
  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));
  // One repair round is now complete (fixAttemptCount = 1 == roundLimit).
  assert.equal(Number(manifestAt(start.manifestPath).fixAttemptCount), 1);

  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));

  // The triage that WOULD start round 2 must stop with deferrals instead.
  const triage = await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_REOPEN }));
  assert.equal(triage.status, 'recorded-triage');
  assert.equal(triage.stopReason, 'round-limit');
  assert.equal(triage.roundLimit, 1);

  const manifest = manifestAt(start.manifestPath);
  assert.equal(manifest.status, 'stopped-with-deferrals');
  assert.equal(manifest.currentPhase, 'final');
  assert.equal(manifest.statusReason, 'round-limit');
  // It is NOT presented as a clean pass.
  assert.notEqual(manifest.status, 'pass');
  // currentRound semantics are untouched: DIFF-OK never incremented it.
  assert.equal(manifest.currentRound, 1);
  // The roundLimit stays durable workflow metadata distinct from currentRound.
  assert.equal(manifest.roundLimit, '1');

  // The residual blocking finding is DEFERRED (not dropped, not fixed, not a pass).
  const ledger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'deferred');

  // The terminal round-limit stop finalizes through the validated deferral path.
  const FINAL_ROUND_LIMIT = [
    'Final status: stopped-with-deferrals',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/practical-target.md',
    'Files changed: docs/practical-target.md',
    'Fixed issue IDs: ISSUE-001',
    'Verification performed: full re-review after the round limit',
    'Deferrals or blockers: ISSUE-001 deferred after rounds=1 limit',
    'Blocking reason: none',
    'Status reason: round-limit',
    'Residual risk: ISSUE-001 remains for manual follow-up',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');
  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'],
    workflowOptions(fixture, { stdin: FINAL_ROUND_LIMIT }));
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'stopped-with-deferrals');
  assert.equal(manifestAt(start.manifestPath).statusReason, 'round-limit');
});

test('rounds=2 still allows a second fix cycle (limit is a maximum, not an off-by-one)', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git', rounds: 2 });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));

  // Round 1: fix -> DIFF-OK -> full re-review FAIL -> triage REOPEN.
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  fs.writeFileSync(fixture.target, '# Practical Workflow Target\n\nFirst fix output.\n');
  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));
  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));

  // fixAttemptCount = 1 < roundLimit = 2: a SECOND fix cycle is permitted.
  const triage = await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_REOPEN }));
  assert.equal(triage.stopReason, 'none');
  assertManifestPhase(start.manifestPath, 'fix', 'fix');
});

test('rounds=1 still passes when the first full re-review is clean (early clean stop)', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git', rounds: 1 });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));

  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  fs.writeFileSync(fixture.target,
    '# Practical Workflow Target\n\nThe document now states the expected behavior directly for implementers.\n\n## Acceptance\n\n- The final wording names the expected behavior.\n');
  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));
  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  // Clean full re-review BEFORE the limit bites: terminates normally.
  const reReview = await runWorkflowCommand('record-review',
    [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_PASS }));
  assert.equal(reReview.ok, true);
  assertManifestPhase(start.manifestPath, 'full-re-review', 'full-re-review');

  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'],
    workflowOptions(fixture, { stdin: FINAL_PASS }));
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  assert.ok(final.archivedStatePath, 'state dir is archived on pass');
  assert.match(final.archivedStatePath, /\.drfx\/archived\/.+/);
  assert.equal(assertManifestPhase(path.join(final.archivedStatePath, 'MANIFEST.md'), 'pass', 'final').roundLimit, '1');
});

test('begin-fix increments fixAttemptCount on a successful attempt', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));

  assert.equal(Number(manifestAt(start.manifestPath).fixAttemptCount), 0);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(Number(manifestAt(start.manifestPath).fixAttemptCount), 1);
});
