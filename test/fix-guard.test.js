'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const test = require('node:test');
const {
  checkGitRollbackAnchor,
  checkTargetOnlyWorktree,
  inspectActualChangedFiles,
  formatFixGuardReport
} = require('../lib/fix-guard');
const { formatLedger, parseLedger } = require('../lib/ledger');
const { readLease } = require('../lib/lock');
const { computeFingerprint, deriveTargetKey } = require('../lib/target-state');
const { runWorkflowCommand } = require('../lib/workflow');
const { formatManifestV2, parseManifestV2 } = require('../lib/workflow-state');

function git(root, args) {
  execSync(`git ${args}`, {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
}

function makeGitRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fix-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(root, 'docs', 'target.md');
  fs.writeFileSync(target, '# Target\n');
  git(root, 'init');
  git(root, 'add docs/target.md');
  git(root, 'commit -m init');
  return { root, target };
}

function makeManifest(overrides = {}) {
  return {
    manifestSchema: 2,
    target: 'docs/spec.md',
    normalizedTarget: 'docs/spec.md',
    documentType: 'SPEC',
    strictness: 'normal',
    mode: 'review-and-fix',
    targetKey: 'spec-md-aaaaaaaaaaaa',
    ledgerPath: '.docs-review-fix/targets/spec-md-aaaaaaaaaaaa/ISSUES.md',
    status: 'fix',
    currentPhase: 'fix',
    currentRound: 1,
    assurance: 'practical',
    runtimePlatform: 'codex',
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    runtimeSubagentProbe: 'ready',
    runtimeSubagentProbeEvidence: 'route-asserted-ready',
    runtimeFingerprintGuard: 'passed',
    runtimeStdinHandoff: 'ready',
    runtimeStdinHandoffEvidence: 'route-asserted-ready',
    runtimeDowngradeReason: 'none',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: 'none',
    lastReviewerReportPath: 'reports/reviewer-round-001.md',
    lastTriageReportPath: 'reports/triage-round-001.md',
    lastFixReportPath: 'none',
    lastDiffReviewReportPath: 'none',
    initialContentSha256: 'a'.repeat(64),
    lastKnownContentSha256: 'a'.repeat(64),
    lastReviewedContentSha256: 'a'.repeat(64),
    lastPassedContentSha256: 'none',
    lastModifiedAt: '2026-05-21T00:00:00.000Z',
    fileSize: 10,
    references: [],
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    ...overrides
  };
}

function makeWorkflowFixture(t, { manifestOverrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fix-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(root, 'docs', 'spec.md');
  fs.writeFileSync(target, '# Spec\n\nOriginal.\n');
  git(root, 'init');
  git(root, 'add docs/spec.md');
  git(root, 'commit -m init');

  const metadata = deriveTargetKey(root, target);
  const targetDir = path.join(root, '.docs-review-fix', 'targets', metadata.targetKey);
  const manifestPath = path.join(targetDir, 'MANIFEST.md');
  const ledgerPath = path.join(targetDir, 'ISSUES.md');
  const fingerprint = computeFingerprint(target);
  const manifest = makeManifest({
    target,
    normalizedTarget: metadata.normalizedTarget,
    targetKey: metadata.targetKey,
    ledgerPath: path.relative(root, ledgerPath).split(path.sep).join('/'),
    initialContentSha256: fingerprint.sha256,
    lastKnownContentSha256: fingerprint.sha256,
    lastReviewedContentSha256: fingerprint.sha256,
    lastModifiedAt: new Date(0).toISOString(),
    fileSize: fingerprint.size,
    ...manifestOverrides
  });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(manifestPath, formatManifestV2(manifest));
  fs.writeFileSync(ledgerPath, formatLedger({
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'accepted',
        location: 'docs/spec.md:3',
        summary: 'Original issue',
        resolution: 'Pending fix'
      }
    ]
  }));

  return { root, target, targetDir, manifestPath, ledgerPath, metadata };
}

function validFixReport(targetPath = 'docs/spec.md') {
  return [
    'Fixed:',
    '- ISSUE-001: Updated the required section.',
    '',
    'Files changed:',
    `- ${targetPath}`,
    '',
    'Not fixed:',
    '- none',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
}

async function beginFix(fixture) {
  return runWorkflowCommand('begin-fix', [fixture.targetDir, '--json'], {
    cwd: fixture.root,
    now: new Date('2026-05-21T00:00:00.000Z')
  });
}

test('git rollback anchor passes for clean tracked target', (t) => {
  const { root, target } = makeGitRepo(t);
  const result = checkGitRollbackAnchor({ projectRoot: root, targetPath: target });
  assert.equal(result.status, 'passed');
});

test('git rollback anchor blocks dirty target as rollback-unavailable', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.appendFileSync(target, '\nDirty\n');
  assert.throws(
    () => checkGitRollbackAnchor({ projectRoot: root, targetPath: target }),
    (error) => error.blockingReason === 'rollback-unavailable'
  );
});

test('target-only worktree blocks non-target dirty entry with redacted metadata', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.writeFileSync(path.join(root, 'other.md'), '# Other\n');
  const result = checkTargetOnlyWorktree({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: path.join(root, '.docs-review-fix', 'targets', 'target-md-aaaaaaaaaaaa')
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  assert.match(result.entries[0].pathSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result.entries[0], 'path'), false);
  assert.equal(Object.hasOwn(result.entries[0], 'fileSize'), false);
});

test('target-only worktree allows current target-state files', (t) => {
  const { root, target } = makeGitRepo(t);
  const stateDir = path.join(root, '.docs-review-fix', 'targets', 'target-md-aaaaaaaaaaaa');
  fs.mkdirSync(path.join(stateDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'reports', 'fix-guard-round-001.md'), '# Guard\n');
  const result = checkTargetOnlyWorktree({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: stateDir
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.allowedStateEntryCount, 1);
});

test('actual changed-file inspection allows only target and current state', (t) => {
  const { root, target } = makeGitRepo(t);
  const stateDir = path.join(root, '.docs-review-fix', 'targets', 'target-md-aaaaaaaaaaaa');
  fs.mkdirSync(path.join(stateDir, 'reports'), { recursive: true });
  fs.appendFileSync(target, '\nFixed\n');
  fs.writeFileSync(path.join(stateDir, 'reports', 'fix-round-001.md'), '# Fix\n');
  const result = inspectActualChangedFiles({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: stateDir
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.changedFiles, ['docs/target.md']);
});

test('fix guard report is machine-parseable without non-target paths', (t) => {
  const { root, target } = makeGitRepo(t);
  const text = formatFixGuardReport({
    round: 1,
    normalizedTarget: 'docs/target.md',
    targetFingerprint: computeFingerprint(target),
    referenceFingerprints: [],
    rollbackAnchor: { status: 'passed', head: 'abc123' },
    targetOnlyGuard: {
      status: 'blocked',
      blockingReason: 'unexpected-worktree-change',
      entries: [{ pathSha256: 'f'.repeat(64), statusCode: '??', kind: 'untracked' }]
    },
    lock: { ownerId: 'owner-a', leaseId: 'lease-a', expiresAt: '2026-05-21T00:15:00.000Z' },
    status: 'blocked',
    blockingReason: 'unexpected-worktree-change'
  });
  assert.match(text, /```json/);
  assert.doesNotMatch(text, /other\.md/);
  assert.doesNotMatch(text, /# Target/);
});

test('workflow begin-fix returns persisted lock metadata and guard report path', async (t) => {
  const fixture = makeWorkflowFixture(t);
  const result = await beginFix(fixture);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'begin-fix');
  assert.equal(typeof result.lockOwnerId, 'string');
  assert.equal(typeof result.leaseId, 'string');
  assert.equal(typeof result.leaseExpiresAt, 'string');
  assert.equal(result.refreshAfterSeconds, 60);
  assert.equal(result.fixGuardReportPath, path.join(fixture.targetDir, 'reports', 'fix-guard-round-001.md'));
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }).leaseId, result.leaseId);
});

test('workflow refresh-lock reads persisted owner and lease identity', async (t) => {
  const fixture = makeWorkflowFixture(t);
  const begin = await beginFix(fixture);
  const result = await runWorkflowCommand('refresh-lock', [fixture.targetDir, '--json'], {
    cwd: fixture.root,
    now: new Date('2026-05-21T00:01:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'refresh-lock');
  assert.equal(result.lockOwnerId, begin.lockOwnerId);
  assert.equal(result.leaseId, begin.leaseId);
  assert.notEqual(result.leaseExpiresAt, begin.leaseExpiresAt);
});

test('workflow end-fix detects fix-report-mismatch and releases the lock', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport('docs/other.md')
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'fix-report-mismatch');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
});

test('workflow end-fix maps release failure to lock-release-failed', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');
  fs.writeFileSync(path.join(fixture.targetDir, 'LOCK', 'unexpected.tmp'), 'keep\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'lock-release-failed');
  assert.equal(result.originalBlockingReason, 'none');
  assert.equal(fs.existsSync(path.join(fixture.targetDir, 'LOCK', 'unexpected.tmp')), true);
});

test('workflow end-fix maps required receipt write failure to state-validation-failed', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');
  fs.writeFileSync(path.join(fixture.targetDir, 'rounds'), 'not a directory\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport('docs/other.md')
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.equal(result.statusReason, 'none');
});

test('workflow end-fix writes normalized report, marks issues fixed, updates manifest, and releases lock', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport()
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'end-fix');
  assert.equal(result.fixReportPath, path.join(fixture.targetDir, 'reports', 'fix-round-001.md'));
  assert.equal(parseLedger(fs.readFileSync(fixture.ledgerPath, 'utf8')).issues[0].status, 'fixed');
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'diff-review');
  assert.equal(manifest.currentPhase, 'diff-review');
  assert.equal(manifest.lastFixReportPath, 'reports/fix-round-001.md');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
});
