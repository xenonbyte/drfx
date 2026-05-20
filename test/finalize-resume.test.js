'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  validateFinalResponse
} = require('../lib/final-response');
const { formatLedger } = require('../lib/ledger');
const { parseDiffReview } = require('../lib/semantic-parsers');
const { computeFingerprint, deriveTargetKey } = require('../lib/target-state');
const { runWorkflowCommand } = require('../lib/workflow');
const { formatManifestV2, parseManifestV2 } = require('../lib/workflow-state');

const baseBlock = {
  finalStatus: 'pass',
  assurance: 'practical',
  runtimePlatform: 'codex',
  mode: 'review-and-fix',
  target: 'docs/spec.md',
  filesChanged: 'docs/spec.md',
  fixedIssueIds: ['ISSUE-001'],
  verificationPerformed: 'node --test test/finalize-resume.test.js',
  deferralsOrBlockers: 'none',
  blockingReason: 'none',
  statusReason: 'none',
  residualRisk: 'none identified',
  redactionStatement: 'no sensitive values persisted',
  coordinatorAgreement: 'approved after full re-review'
};

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
    status: 'diff-review',
    currentPhase: 'diff-review',
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
    currentReportPath: 'reports/fix-round-001.md',
    lastReviewerReportPath: 'reports/full-review-round-001.md',
    lastTriageReportPath: 'reports/triage-round-001.md',
    lastFixReportPath: 'reports/fix-round-001.md',
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

function makeFixture(t, { manifestOverrides = {}, ledgerIssues = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-finalize-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(root, 'docs', 'spec.md');
  fs.writeFileSync(target, '# Spec\n\nBody.\n');
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
  fs.mkdirSync(path.join(targetDir, 'reports'), { recursive: true });
  fs.writeFileSync(manifestPath, formatManifestV2(manifest));
  fs.writeFileSync(ledgerPath, formatLedger({ issues: ledgerIssues }));
  return { root, target, targetDir, manifestPath, ledgerPath, metadata };
}

function writeJsonReport(filePath, heading, report) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    `# ${heading}`,
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    ''
  ].join('\n'));
}

function writeFixReport(fixture) {
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'fix-round-001.md'), 'Fix Report', {
    round: 1,
    normalized: {
      fixed: [{ issue_id: 'ISSUE-001', summary: 'Updated required section.' }],
      filesChanged: ['docs/spec.md'],
      notFixed: [],
      residualRisk: [],
      warnings: []
    }
  });
}

function writeFullReviewPass(fixture) {
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'full-review-round-001.md'), 'Reviewer Report', {
    round: 1,
    phase: 'full-re-review',
    producer: 'reviewer-subagent',
    normalized: {
      result: 'PASS',
      summary: 'Clean after fix.',
      findings: [],
      warnings: []
    }
  });
}

function writeInitialReviewPass(fixture) {
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'reviewer-round-001.md'), 'Reviewer Report', {
    round: 1,
    phase: 'initial-review',
    producer: 'reviewer-subagent',
    normalized: {
      result: 'PASS',
      summary: 'Clean read-only review.',
      findings: [],
      warnings: []
    }
  });
}

function writeInitialReviewFailHigh(fixture) {
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'reviewer-round-001.md'), 'Reviewer Report', {
    round: 1,
    phase: 'initial-review',
    producer: 'reviewer-subagent',
    normalized: {
      result: 'FAIL',
      summary: 'Blocking issue found.',
      findings: [
        {
          id: 'R001',
          severity: 'high',
          location: 'docs/spec.md:3',
          issue: 'Missing required section',
          why_it_matters: 'Readers cannot verify required behavior',
          suggested_fix: 'Add the required section',
          confidence: 'confirmed',
          sensitive: false
        }
      ],
      warnings: []
    }
  });
}

function writeTriageReport(fixture) {
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'triage-round-001.md'), 'Triage Report', {
    round: 1,
    phase: 'triage',
    producer: 'coordinator',
    normalized: {
      decisions: [],
      warnings: []
    },
    ledgerIssueIds: []
  });
}

function writeResumeReports(fixture) {
  writeFixReport(fixture);
  writeFullReviewPass(fixture);
  writeTriageReport(fixture);
}

function finalResponseBlock(overrides = {}) {
  const block = { ...baseBlock, ...overrides };
  const fixedIssueIds = Array.isArray(block.fixedIssueIds)
    ? block.fixedIssueIds.join(', ')
    : block.fixedIssueIds;
  return [
    `Final status: ${block.finalStatus}`,
    `Assurance: ${block.assurance}`,
    `Runtime platform: ${block.runtimePlatform}`,
    `Mode: ${block.mode}`,
    `Target: ${block.target}`,
    `Files changed: ${block.filesChanged}`,
    `Fixed issue IDs: ${fixedIssueIds}`,
    `Verification performed: ${block.verificationPerformed}`,
    `Deferrals or blockers: ${block.deferralsOrBlockers}`,
    `Blocking reason: ${block.blockingReason}`,
    `Status reason: ${block.statusReason}`,
    `Residual risk: ${block.residualRisk}`,
    `Redaction statement: ${block.redactionStatement}`,
    `Coordinator agreement: ${block.coordinatorAgreement}`
  ].join('\n');
}

test('persistent finalize accepts practical pass only with required state', () => {
  const result = validateFinalResponse({
    finalResponse: baseBlock,
    state: {
      persistent: true,
      mode: 'review-and-fix',
      assurance: 'practical',
      runtimePlatform: 'codex',
      target: 'docs/spec.md',
      filesChanged: 'docs/spec.md',
      fixedIssueIds: ['ISSUE-001'],
      unresolvedBlockingIssues: [],
      requiredDiffReviewComplete: true,
      requiredFullReReviewComplete: true,
      strictAcceptedLowIncludedInLatestFullReview: true
    }
  });
  assert.equal(result.status, 'pass');
});

test('persistent finalize rejects advisory pass', () => {
  assert.throws(
    () => validateFinalResponse({
      finalResponse: { ...baseBlock, assurance: 'advisory' },
      state: { persistent: true, mode: 'review-and-fix', assurance: 'advisory' }
    }),
    /advisory.*pass/i
  );
});

test('read-only finalization cannot pass', () => {
  assert.throws(
    () => validateFinalResponse({
      finalResponse: { ...baseBlock, mode: 'read-only' },
      state: { persistent: true, mode: 'read-only', assurance: 'practical' }
    }),
    /read-only.*pass/i
  );
});

test('pass requires diff review and full re-review after fix', () => {
  assert.throws(
    () => validateFinalResponse({
      finalResponse: baseBlock,
      state: {
        persistent: true,
        mode: 'review-and-fix',
        assurance: 'practical',
        requiredDiffReviewComplete: false,
        requiredFullReReviewComplete: true,
        unresolvedBlockingIssues: []
      }
    }),
    /diff review/i
  );
  assert.throws(
    () => validateFinalResponse({
      finalResponse: baseBlock,
      state: {
        persistent: true,
        mode: 'review-and-fix',
        assurance: 'practical',
        requiredDiffReviewComplete: true,
        requiredFullReReviewComplete: false,
        unresolvedBlockingIssues: []
      }
    }),
    /full re-review/i
  );
});

test('pass rejects unresolved high or medium accepted issues', () => {
  assert.throws(
    () => validateFinalResponse({
      finalResponse: baseBlock,
      state: {
        persistent: true,
        mode: 'review-and-fix',
        assurance: 'practical',
        requiredDiffReviewComplete: true,
        requiredFullReReviewComplete: true,
        unresolvedBlockingIssues: ['ISSUE-002']
      }
    }),
    /unresolved.*ISSUE-002/i
  );
});

test('strict accepted low issue ids must be included in latest full re-review context', () => {
  assert.throws(
    () => validateFinalResponse({
      finalResponse: { ...baseBlock, assurance: 'strict-verified' },
      state: {
        persistent: true,
        mode: 'review-and-fix',
        assurance: 'strict-verified',
        strictness: 'strict',
        acceptedNonBlockingLowIssueIds: ['ISSUE-003'],
        requiredDiffReviewComplete: true,
        requiredFullReReviewComplete: true,
        strictAcceptedLowIncludedInLatestFullReview: false,
        unresolvedBlockingIssues: []
      }
    }),
    /non-blocking low.*full re-review/i
  );
});

test('no-state finalization never accepts pass', () => {
  assert.throws(
    () => validateFinalResponse({
      finalResponse: baseBlock,
      state: { noState: true, mode: 'read-only', assurance: 'advisory' }
    }),
    /no-state.*pass/i
  );
});

test('blocked final response requires blocker and no status reason', () => {
  assert.throws(
    () => validateFinalResponse({
      finalResponse: {
        ...baseBlock,
        finalStatus: 'blocked',
        blockingReason: 'none',
        coordinatorAgreement: 'none'
      },
      state: { persistent: true, mode: 'review-and-fix', assurance: 'practical' }
    }),
    /blocked.*blocking reason/i
  );
  assert.throws(
    () => validateFinalResponse({
      finalResponse: {
        ...baseBlock,
        finalStatus: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'checkpoint-requested',
        coordinatorAgreement: 'none'
      },
      state: { persistent: true, mode: 'review-and-fix', assurance: 'practical' }
    }),
    /blocked.*status reason/i
  );
});

test('diff review OK permits full re-review but not pass', () => {
  const parsed = parseDiffReview('DIFF-OK\nSummary: Target-only fix matches accepted issue.\n');
  assert.equal(parsed.result, 'DIFF-OK');
});

test('diff review FAIL records blocker mapping', () => {
  const parsed = parseDiffReview([
    'DIFF-FAIL',
    'Findings:',
    '- issue_id: ISSUE-001',
    '  problem: Fix changed unrelated scope.',
    '  required_action: Revert unrelated edit.'
  ].join('\n'));
  assert.equal(parsed.result, 'DIFF-FAIL');
  assert.equal(parsed.findings[0].required_action, 'Revert unrelated edit.');
});

test('record-diff-review DIFF-OK enters full re-review without pass', async (t) => {
  const fixture = makeFixture(t, {
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'fixed',
        location: 'docs/spec.md:3',
        summary: 'Original issue',
        resolution: 'Fixed: Updated required section.'
      }
    ]
  });
  writeFixReport(fixture);

  const result = await runWorkflowCommand('record-diff-review', [fixture.targetDir, '--diff-review-stdin', '--json'], {
    cwd: fixture.root,
    stdin: 'DIFF-OK\nSummary: Target-only fix matches accepted issue.\n'
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'recorded-diff-review');
  assert.notEqual(result.status, 'pass');
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'full-re-review');
  assert.equal(manifest.currentPhase, 'full-re-review');
  assert.equal(manifest.lastDiffReviewReportPath, 'reports/diff-review-round-001.md');
});

test('record-diff-review DIFF-FAIL returns to fix and uses attempt suffixes', async (t) => {
  const fixture = makeFixture(t, {
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'fixed',
        location: 'docs/spec.md:3',
        summary: 'Original issue',
        resolution: 'Fixed: Updated required section.'
      }
    ]
  });
  writeFixReport(fixture);
  const payload = [
    'DIFF-FAIL',
    'Findings:',
    '- issue_id: ISSUE-001',
    '  problem: Fix missed required detail.',
    '  required_action: Add the missing detail.'
  ].join('\n');

  const first = await runWorkflowCommand('record-diff-review', [fixture.targetDir, '--diff-review-stdin', '--json'], {
    cwd: fixture.root,
    stdin: payload
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'recorded-diff-review');
  let manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.currentPhase, 'fix');
  assert.equal(manifest.lastDiffReviewReportPath, 'reports/diff-review-round-001.md');

  fs.writeFileSync(fixture.manifestPath, formatManifestV2({
    ...manifest,
    status: 'diff-review',
    currentPhase: 'diff-review'
  }));
  const second = await runWorkflowCommand('record-diff-review', [fixture.targetDir, '--diff-review-stdin', '--json'], {
    cwd: fixture.root,
    stdin: payload
  });
  assert.equal(second.ok, true);
  manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.lastDiffReviewReportPath, 'reports/diff-review-round-001-attempt-002.md');
});

test('persistent finalize validates response before persisting pass', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      status: 'full-re-review',
      currentPhase: 'full-re-review',
      lastDiffReviewReportPath: 'reports/diff-review-round-001.md'
    },
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'fixed',
        location: 'docs/spec.md:3',
        summary: 'Original issue',
        resolution: 'Fixed: Updated required section.'
      }
    ]
  });
  writeFixReport(fixture);
  writeFullReviewPass(fixture);
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'diff-review-round-001.md'), 'Diff Review Report', {
    round: 1,
    normalized: { result: 'DIFF-OK', summary: 'ok', findings: [], warnings: [] }
  });

  const result = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock()
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'pass');
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'pass');
  assert.equal(manifest.currentPhase, 'final');
  assert.notEqual(manifest.lastPassedContentSha256, 'none');
});

test('persistent finalize rejects pass when fix round has no diff review report', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      status: 'full-re-review',
      currentPhase: 'full-re-review',
      lastDiffReviewReportPath: 'none'
    },
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'fixed',
        location: 'docs/spec.md:3',
        summary: 'Original issue',
        resolution: 'Fixed: Updated required section.'
      }
    ]
  });
  writeFixReport(fixture);
  writeFullReviewPass(fixture);

  const result = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'final-validation-failed');
  assert.match(result.message, /diff review/i);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.notEqual(manifest.status, 'pass');
});

test('persistent read-only finalize rejects clean when reviewer has blocking findings', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      mode: 'read-only',
      status: 'triage',
      currentPhase: 'triage',
      currentReportPath: 'reports/reviewer-round-001.md',
      lastReviewerReportPath: 'reports/reviewer-round-001.md',
      lastTriageReportPath: 'none',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    }
  });
  writeInitialReviewFailHigh(fixture);

  const result = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'read-only-clean',
      mode: 'read-only',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'final-validation-failed');
  assert.match(result.message, /read-only-clean|blocking/i);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.notEqual(manifest.status, 'read-only-clean');
});

test('persistent read-only finalize rejects clean when ledger has accepted high issue', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      mode: 'read-only',
      status: 'read-only-clean',
      currentPhase: 'final',
      currentReportPath: 'reports/reviewer-round-001.md',
      lastReviewerReportPath: 'reports/reviewer-round-001.md',
      lastTriageReportPath: 'none',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    },
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'accepted',
        location: 'docs/spec.md:3',
        summary: 'Blocking read-only issue',
        resolution: 'Accepted: blocking issue remains'
      }
    ]
  });
  writeInitialReviewPass(fixture);

  const result = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'read-only-clean',
      mode: 'read-only',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'final-validation-failed');
  assert.match(result.message, /read-only-clean|blocking/i);
});

test('persistent read-only finalize rejects findings when no blocking issues exist', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      mode: 'read-only',
      status: 'read-only-clean',
      currentPhase: 'final',
      currentReportPath: 'reports/reviewer-round-001.md',
      lastReviewerReportPath: 'reports/reviewer-round-001.md',
      lastTriageReportPath: 'none',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    }
  });
  writeInitialReviewPass(fixture);

  const result = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'read-only-findings',
      mode: 'read-only',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'final-validation-failed');
  assert.match(result.message, /read-only-findings|blocking/i);
});

test('resume blocks corrupt schema-2 manifest as state-validation-failed', async (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(fixture.manifestPath, '# Review Target Manifest\n\nManifest schema: 2\nTarget: docs/spec.md\n');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    'resume',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ], { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
});

test('resume blocks missing ledger as state-validation-failed', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { status: 'fix', currentPhase: 'fix' }
  });
  fs.rmSync(fixture.ledgerPath);

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    'resume',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /ledger|ISSUES/i);
});

test('resume blocks corrupt ledger as state-validation-failed', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { status: 'fix', currentPhase: 'fix' }
  });
  fs.writeFileSync(fixture.ledgerPath, 'not a ledger\n');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    'resume',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /ledger|header/i);
});

test('resume blocks missing referenced report as state-validation-failed', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { status: 'full-re-review', currentPhase: 'full-re-review' }
  });
  writeFixReport(fixture);

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    'resume',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /report/i);
});

test('resume blocks corrupt referenced report as state-validation-failed', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { status: 'full-re-review', currentPhase: 'full-re-review' }
  });
  writeFixReport(fixture);
  fs.writeFileSync(path.join(fixture.targetDir, 'reports', 'full-review-round-001.md'), '# Bad report\n');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    'resume',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /report/i);
});

test('resume clears stale pass and restarts review', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      status: 'pass',
      currentPhase: 'final'
    }
  });
  const before = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  fs.writeFileSync(fixture.manifestPath, formatManifestV2({
    ...before,
    lastPassedContentSha256: before.lastKnownContentSha256
  }));
  writeResumeReports(fixture);
  fs.appendFileSync(fixture.target, '\nChanged after pass.\n');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    'resume',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'review');
  assert.equal(result.stalePass, true);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'review');
  assert.equal(manifest.currentPhase, 'review');
  assert.equal(manifest.lastPassedContentSha256, 'none');
});

test('resume maps stale non-pass state to externally-changed', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { status: 'fix', currentPhase: 'fix' }
  });
  writeResumeReports(fixture);
  fs.appendFileSync(fixture.target, '\nExternal edit.\n');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    'resume',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'externally-changed');
  assert.equal(result.statusReason, 'stale-fingerprint-mismatch');
});

test('resume maps same-path replacement suspicion to possible-target-replacement', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { status: 'fix', currentPhase: 'fix' }
  });
  writeResumeReports(fixture);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  fs.writeFileSync(fixture.target, 'X'.repeat(Number(manifest.fileSize)));

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    'resume',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'possible-target-replacement');
  assert.equal(result.statusReason, 'same-path-replacement-suspected');
});

test('resume converts strict-verified state without current proof to unsupported', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      status: 'review',
      currentPhase: 'review',
      assurance: 'strict-verified',
      descriptorPlatform: 'codex',
      assuranceProof: 'capability-descriptor:codex:prior-run'
    }
  });
  writeResumeReports(fixture);

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    'resume',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'strict-proof-validation-failed');
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.assurance, 'advisory');
  assert.equal(manifest.assuranceProof, 'none');
});

test('resume ignores missing summary and malformed continuity for deterministic phase selection', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { status: 'fix', currentPhase: 'fix' }
  });
  writeResumeReports(fixture);
  fs.writeFileSync(path.join(fixture.targetDir, 'CONTINUITY.md'), '\0 malformed optional handoff');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'review-and-fix',
    'resume',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'fix');
  assert.equal(result.currentPhase, 'fix');
});

test('no-state finalize rejects blocked response without blocking reason', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { mode: 'read-only', status: 'review', currentPhase: 'review' }
  });
  const preflight = await runWorkflowCommand('preflight', [
    '--no-state',
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--terminal-status',
    'blocked',
    '--blocking-reason',
    'state-validation-failed',
    '--status-reason',
    'none'
  ], { cwd: fixture.root });

  const result = await runWorkflowCommand('finalize', [
    '--no-state',
    'review-fix-spec',
    `root=${fixture.root}`,
    `target=${fixture.target}`,
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'ready',
    '--state-token',
    preflight.stateToken,
    '--final-response-stdin',
    '--json'
  ], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'blocked',
      assurance: 'advisory',
      runtimePlatform: 'manual',
      mode: 'read-only',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      blockingReason: 'none',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.match(result.errorCode || result.blockingReason, /final-validation|blocked/i);
});
