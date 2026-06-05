'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  validateFinalResponse
} = require('../lib/final-response');
const { formatLedger, parseLedger } = require('../lib/ledger');
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
    ledgerPath: '.drfx/targets/spec-md-aaaaaaaaaaaa/ISSUES.md',
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
  const targetDir = path.join(root, '.drfx', 'targets', metadata.targetKey);
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

function writeFullReviewFailLow(fixture) {
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'full-review-round-001.md'), 'Reviewer Report', {
    round: 1,
    phase: 'full-re-review',
    producer: 'reviewer-subagent',
    normalized: {
      result: 'FAIL',
      summary: 'Low issue remains after fix.',
      findings: [
        {
          id: 'RLOW-001',
          severity: 'low',
          location: 'docs/spec.md:3',
          issue: 'Minor wording ambiguity',
          why_it_matters: 'Strict review requires triage before pass',
          suggested_fix: 'Clarify the wording',
          confidence: 'confirmed',
          sensitive: false
        }
      ],
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

function writeInitialReviewFailHigh(fixture, reviewerId = 'R001') {
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'reviewer-round-001.md'), 'Reviewer Report', {
    round: 1,
    phase: 'initial-review',
    producer: 'reviewer-subagent',
    normalized: {
      result: 'FAIL',
      summary: 'Blocking issue found.',
      findings: [
        {
          id: reviewerId,
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

function writeTriageReport(fixture, decisions = []) {
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'triage-round-001.md'), 'Triage Report', {
    round: 1,
    phase: 'triage',
    producer: 'coordinator',
    normalized: {
      decisions,
      warnings: []
    },
    ledgerIssueIds: decisions.map((decision) => decision.issue_id).filter(Boolean)
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

  const result = await runWorkflowCommand('record-diff-review', [fixture.targetDir, '--result-stdin', '--json'], {
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

test('record-diff-review DIFF-FAIL returns to fix and advances the round', async (t) => {
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

  const first = await runWorkflowCommand('record-diff-review', [fixture.targetDir, '--result-stdin', '--json'], {
    cwd: fixture.root,
    stdin: payload
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'recorded-diff-review');
  let manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.currentPhase, 'fix');
  assert.equal(manifest.currentRound, 2);
  assert.equal(manifest.lastDiffReviewReportPath, 'reports/diff-review-round-001.md');
});

test('record-diff-review DIFF-FAIL stops at the document round limit', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      roundLimit: '1',
      fixAttemptCount: 1
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
  const payload = [
    'DIFF-FAIL',
    'Findings:',
    '- issue_id: ISSUE-001',
    '  problem: Fix missed required detail.',
    '  required_action: Add the missing detail.'
  ].join('\n');

  const result = await runWorkflowCommand('record-diff-review', [fixture.targetDir, '--result-stdin', '--json'], {
    cwd: fixture.root,
    stdin: payload
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'recorded-diff-review');
  assert.equal(result.currentPhase, 'final');
  assert.equal(result.stopReason, 'round-limit');
  assert.equal(result.roundLimit, 1);

  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'stopped-with-deferrals');
  assert.equal(manifest.currentPhase, 'final');
  assert.equal(manifest.statusReason, 'round-limit');
  assert.equal(manifest.currentRound, 1);
  const ledger = parseLedger(fs.readFileSync(fixture.ledgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'deferred');
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
  assert.ok(result.archivedStatePath, 'state dir is archived');
  const manifest = parseManifestV2(fs.readFileSync(path.join(result.archivedStatePath, 'MANIFEST.md'), 'utf8'));
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

test('strict persistent finalize rejects pass when full re-review fails with untriaged low finding', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      status: 'full-re-review',
      currentPhase: 'full-re-review',
      strictness: 'strict',
      assurance: 'strict-verified',
      descriptorPlatform: 'codex',
      assuranceProof: 'capability-descriptor:codex:run-1',
      lastDiffReviewReportPath: 'reports/diff-review-round-001.md',
      lastTriageReportPath: 'none'
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
  writeFullReviewFailLow(fixture);
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'diff-review-round-001.md'), 'Diff Review Report', {
    round: 1,
    normalized: { result: 'DIFF-OK', summary: 'ok', findings: [], warnings: [] }
  });

  const result = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      assurance: 'strict-verified'
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'final-validation-failed');
  assert.match(result.message, /full re-review|PASS|low/i);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.notEqual(manifest.status, 'pass');
});

test('persistent review-and-fix finalize rejects pass with deferred high issue', async (t) => {
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
        status: 'deferred',
        location: 'docs/spec.md:3',
        summary: 'Deferred issue',
        resolution: 'Deferred: needs owner follow-up'
      }
    ]
  });
  writeFixReport(fixture);
  writeFullReviewPass(fixture);
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'diff-review-round-001.md'), 'Diff Review Report', {
    round: 1,
    normalized: { result: 'DIFF-OK', summary: 'ok', findings: [], warnings: [] }
  });

  const pass = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock()
  });

  assert.equal(pass.ok, false);
  assert.equal(pass.status, 'blocked');
  assert.equal(pass.blockingReason, 'final-validation-failed');
  assert.match(pass.message, /deferred|pass/i);

  const wrongReason = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'stopped-with-deferrals',
      filesChanged: 'docs/spec.md',
      fixedIssueIds: 'ISSUE-001',
      deferralsOrBlockers: 'deferred high issue ISSUE-001',
      blockingReason: 'none',
      statusReason: 'none',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(wrongReason.ok, false);
  assert.equal(wrongReason.status, 'blocked');
  assert.equal(wrongReason.blockingReason, 'final-validation-failed');
  assert.match(wrongReason.message, /deferred-findings/i);

  const stopped = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'stopped-with-deferrals',
      filesChanged: 'docs/spec.md',
      fixedIssueIds: 'ISSUE-001',
      deferralsOrBlockers: 'deferred high issue ISSUE-001',
      blockingReason: 'none',
      statusReason: 'deferred-findings',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(stopped.ok, true);
  assert.equal(stopped.status, 'stopped-with-deferrals');
});

test('persistent finalize blocks receipt write through symlinked rounds directory', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      status: 'review',
      currentPhase: 'review',
      currentReportPath: 'none',
      lastReviewerReportPath: 'none',
      lastTriageReportPath: 'none',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    }
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-receipt-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(fixture.targetDir, 'rounds'), 'dir');

  const result = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'blocked',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      deferralsOrBlockers: 'receipt write validation',
      blockingReason: 'state-validation-failed',
      statusReason: 'none',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(result.message, /round receipt|symlink|target state/i);
  assert.equal(fs.existsSync(path.join(outside, '001-final-blocked.md')), false);
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

test('persistent read-only finalize accepts clean when triage rejected reviewer high finding', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      mode: 'read-only',
      status: 'read-only-clean',
      currentPhase: 'final',
      currentReportPath: 'reports/triage-round-001.md',
      lastReviewerReportPath: 'reports/reviewer-round-001.md',
      lastTriageReportPath: 'reports/triage-round-001.md',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    },
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'rejected',
        location: 'docs/spec.md:3',
        summary: 'Rejected reviewer finding',
        resolution: 'Rejected: not applicable'
      }
    ]
  });
  writeInitialReviewFailHigh(fixture);
  writeTriageReport(fixture, [
    {
      reviewer_id: 'R001',
      issue_id: 'ISSUE-001',
      decision: 'rejected',
      severity: 'high',
      original_severity: 'high',
      rationale: 'not applicable',
      merged_into: 'none',
      deferred_owner: 'none',
      deferred_next_action: 'none',
      non_blocking: false
    }
  ]);

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

  assert.equal(result.ok, true);
  assert.equal(result.status, 'read-only-clean');
  assert.ok(result.archivedStatePath, 'state dir is archived');
  const manifest = parseManifestV2(fs.readFileSync(path.join(result.archivedStatePath, 'MANIFEST.md'), 'utf8'));
  assert.equal(manifest.status, 'read-only-clean');
});

test('persistent read-only finalize rejects clean when latest reviewer finding lacks triage coverage', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      mode: 'read-only',
      status: 'read-only-clean',
      currentPhase: 'final',
      currentReportPath: 'reports/triage-round-001.md',
      lastReviewerReportPath: 'reports/reviewer-round-001.md',
      lastTriageReportPath: 'reports/triage-round-001.md',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    },
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'rejected',
        location: 'docs/spec.md:3',
        summary: 'Older rejected reviewer finding',
        resolution: 'Rejected: not applicable'
      }
    ]
  });
  writeInitialReviewFailHigh(fixture, 'R999');
  writeTriageReport(fixture, [
    {
      reviewer_id: 'R001',
      issue_id: 'ISSUE-001',
      decision: 'rejected',
      severity: 'high',
      original_severity: 'high',
      rationale: 'not applicable',
      merged_into: 'none',
      deferred_owner: 'none',
      deferred_next_action: 'none',
      non_blocking: false
    }
  ]);

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
  assert.match(result.message, /R999|blocking/i);
});

test('persistent read-only finalize rejects clean when triage deferred high finding', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      mode: 'read-only',
      status: 'stopped-with-deferrals',
      currentPhase: 'final',
      currentReportPath: 'reports/triage-round-001.md',
      lastReviewerReportPath: 'reports/reviewer-round-001.md',
      lastTriageReportPath: 'reports/triage-round-001.md',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    },
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'deferred',
        location: 'docs/spec.md:3',
        summary: 'Deferred reviewer finding',
        resolution: 'Deferred: needs owner follow-up'
      }
    ]
  });
  writeInitialReviewFailHigh(fixture);
  writeTriageReport(fixture, [
    {
      reviewer_id: 'R001',
      issue_id: 'ISSUE-001',
      decision: 'deferred',
      severity: 'high',
      original_severity: 'high',
      rationale: 'needs owner follow-up',
      merged_into: 'none',
      deferred_owner: 'docs-owner',
      deferred_next_action: 'resolve before clean finalization',
      non_blocking: false
    }
  ]);

  const clean = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'read-only-clean',
      mode: 'read-only',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(clean.ok, false);
  assert.equal(clean.status, 'blocked');
  assert.equal(clean.blockingReason, 'final-validation-failed');
  assert.match(clean.message, /R001|blocking|deferred/i);

  const findings = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'read-only-findings',
      mode: 'read-only',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      statusReason: 'read-only-blocking-findings',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(findings.ok, false);
  assert.equal(findings.status, 'blocked');
  assert.equal(findings.blockingReason, 'final-validation-failed');
  assert.match(findings.message, /read-only-findings|accepted|reopened|downgraded|deferred/i);
});

test('persistent read-only finalize accepts stopped-with-deferrals for deferred high finding', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      mode: 'read-only',
      status: 'stopped-with-deferrals',
      currentPhase: 'final',
      currentReportPath: 'reports/triage-round-001.md',
      lastReviewerReportPath: 'reports/reviewer-round-001.md',
      lastTriageReportPath: 'reports/triage-round-001.md',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    },
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'deferred',
        location: 'docs/spec.md:3',
        summary: 'Deferred reviewer finding',
        resolution: 'Deferred: needs owner follow-up'
      }
    ]
  });
  writeInitialReviewFailHigh(fixture);
  writeTriageReport(fixture, [
    {
      reviewer_id: 'R001',
      issue_id: 'ISSUE-001',
      decision: 'deferred',
      severity: 'high',
      original_severity: 'high',
      rationale: 'needs owner follow-up',
      merged_into: 'none',
      deferred_owner: 'docs-owner',
      deferred_next_action: 'resolve before clean finalization',
      non_blocking: false
    }
  ]);

  const result = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'stopped-with-deferrals',
      mode: 'read-only',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      deferralsOrBlockers: 'deferred high issue ISSUE-001',
      blockingReason: 'none',
      statusReason: 'deferred-findings',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'stopped-with-deferrals');
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'stopped-with-deferrals');
  assert.equal(manifest.statusReason, 'deferred-findings');
});

test('persistent read-only finalize gives deferred findings precedence over blocking findings', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      mode: 'read-only',
      status: 'stopped-with-deferrals',
      currentPhase: 'final',
      currentReportPath: 'reports/triage-round-001.md',
      lastReviewerReportPath: 'reports/reviewer-round-001.md',
      lastTriageReportPath: 'reports/triage-round-001.md',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    },
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'deferred',
        location: 'docs/spec.md:3',
        summary: 'Deferred reviewer finding',
        resolution: 'Deferred: needs owner follow-up'
      },
      {
        id: 'ISSUE-002',
        severity: 'high',
        status: 'accepted',
        location: 'docs/spec.md:8',
        summary: 'Accepted reviewer finding',
        resolution: 'Accepted: blocking issue remains'
      }
    ]
  });
  writeInitialReviewFailHigh(fixture);
  writeTriageReport(fixture, [
    {
      reviewer_id: 'R001',
      issue_id: 'ISSUE-001',
      decision: 'deferred',
      severity: 'high',
      original_severity: 'high',
      rationale: 'needs owner follow-up',
      merged_into: 'none',
      deferred_owner: 'docs-owner',
      deferred_next_action: 'resolve before clean finalization',
      non_blocking: false
    },
    {
      reviewer_id: 'R002',
      issue_id: 'ISSUE-002',
      decision: 'accepted',
      severity: 'high',
      original_severity: 'high',
      rationale: 'valid blocking finding',
      merged_into: 'none',
      deferred_owner: 'none',
      deferred_next_action: 'none',
      non_blocking: false
    }
  ]);

  const findings = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'read-only-findings',
      mode: 'read-only',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      statusReason: 'read-only-blocking-findings',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(findings.ok, false);
  assert.equal(findings.status, 'blocked');
  assert.equal(findings.blockingReason, 'final-validation-failed');
  assert.match(findings.message, /deferred|stopped-with-deferrals/i);

  const stopped = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'stopped-with-deferrals',
      mode: 'read-only',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      deferralsOrBlockers: 'deferred high issue ISSUE-001',
      blockingReason: 'none',
      statusReason: 'deferred-findings',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(stopped.ok, true);
  assert.equal(stopped.status, 'stopped-with-deferrals');
});

test('persistent review-and-fix finalize rejects stopped-with-deferrals without deferred high finding', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      status: 'full-re-review',
      currentPhase: 'full-re-review',
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
      finalStatus: 'stopped-with-deferrals',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      deferralsOrBlockers: 'none',
      blockingReason: 'none',
      statusReason: 'deferred-findings',
      coordinatorAgreement: 'none'
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'final-validation-failed');
  assert.match(result.message, /stopped-with-deferrals|deferred/i);
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

test('resume archives a live passed state and starts a fresh review', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { status: 'pass', currentPhase: 'final' }
  });
  const before = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  fs.writeFileSync(fixture.manifestPath, formatManifestV2({
    ...before,
    lastPassedContentSha256: before.lastKnownContentSha256
  }));
  writeResumeReports(fixture);
  fs.appendFileSync(fixture.target, '\nChanged after pass.\n');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec', `root=${fixture.root}`, `target=${fixture.target}`,
    'review-and-fix', 'resume', 'guard=snapshot',
    '--assurance', 'practical', '--runtime-platform', 'codex',
    '--runtime-subagent-probe', 'ready', '--runtime-stdin-handoff', 'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'review');                 // fresh start
  assert.match(result.archivedStatePath, /\.drfx\/archived\/.+/);
  // fresh manifest recreated at the same target key path by start:
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'review');
  assert.equal(manifest.currentPhase, 'review');
  assert.equal(Number(manifest.currentRound), 1);
});

test('resume preserves archivedStatePath when fresh start fails after archiving a live passed state', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { status: 'pass', currentPhase: 'final' }
  });
  const before = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  fs.writeFileSync(fixture.manifestPath, formatManifestV2({
    ...before,
    lastPassedContentSha256: before.lastKnownContentSha256
  }));
  writeResumeReports(fixture);
  fs.appendFileSync(fixture.target, '\nChanged after pass.\n');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec', `root=${fixture.root}`, `target=${fixture.target}`,
    'review-and-fix', 'resume',
    '--assurance', 'practical', '--runtime-platform', 'codex',
    '--runtime-subagent-probe', 'ready', '--runtime-stdin-handoff', 'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'git-guard-unavailable');
  assert.match(result.archivedStatePath, /\.drfx\/archived\/.+/);
  assert.equal(fs.existsSync(result.archivedStatePath), true);
  assert.equal(fs.existsSync(path.join(result.archivedStatePath, 'MANIFEST.md')), true);
  assert.equal(fs.existsSync(fixture.targetDir), false, 'old passed state was moved before fresh start failed');
});

test('resume archives a live read-only-clean state and starts a fresh read-only review', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { mode: 'read-only', status: 'read-only-clean', currentPhase: 'final' }
  });

  const result = await runWorkflowCommand('start', [
    'review-fix-spec', `root=${fixture.root}`, `target=${fixture.target}`,
    'read-only', 'resume', 'guard=snapshot',
    '--assurance', 'practical', '--runtime-platform', 'codex',
    '--runtime-subagent-probe', 'ready', '--runtime-stdin-handoff', 'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'review');
  assert.match(result.archivedStatePath, /\.drfx\/archived\/.+/);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'review');
  assert.equal(manifest.currentPhase, 'review');
  assert.equal(manifest.mode, 'read-only');
});

test('document resume archive failure blocks with state-validation-failed', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: { status: 'pass', currentPhase: 'final' }
  });
  const before = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  fs.writeFileSync(fixture.manifestPath, formatManifestV2({
    ...before,
    lastPassedContentSha256: before.lastKnownContentSha256
  }));
  writeResumeReports(fixture);
  fs.appendFileSync(fixture.target, '\nChanged after pass.\n');
  // force archive failure: make .drfx/archived a regular file so mkdirSync throws
  fs.writeFileSync(path.join(fixture.root, '.drfx', 'archived'), 'not a dir');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec', `root=${fixture.root}`, `target=${fixture.target}`,
    'review-and-fix', 'resume', 'guard=snapshot',
    '--assurance', 'practical', '--runtime-platform', 'codex',
    '--runtime-subagent-probe', 'ready', '--runtime-stdin-handoff', 'ready'
  ], { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.ok(result.archiveWarning);
  assert.equal(result.archivedStatePath, undefined);
  assert.equal(fs.existsSync(fixture.targetDir), true, 'old passed state remains for operator repair');
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'pass');
  assert.equal(manifest.currentPhase, 'final');
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

test('resume requires receipt for stopped-no-progress', () => {
  const { resumeRequiresReceipt } = require('../lib/workflow/helpers');
  assert.equal(resumeRequiresReceipt('stopped-no-progress'), true);
});

test('final response validation requires no-progress reason for stopped-no-progress', () => {
  const state = {
    persistent: true,
    target: 'docs/spec.md',
    mode: 'review-and-fix',
    assurance: 'practical',
    runtimePlatform: 'codex',
    filesChanged: 'none',
    unresolvedBlockingIssues: ['ISSUE-001']
  };
  const finalResponse = {
    ...baseBlock,
    finalStatus: 'stopped-no-progress',
    filesChanged: 'none',
    fixedIssueIds: 'none',
    deferralsOrBlockers: 'ISSUE-001 unresolved after fix-attempt cap',
    statusReason: 'none',
    coordinatorAgreement: 'none'
  };

  assert.throws(
    () => validateFinalResponse({ finalResponse, state }),
    /no-progress-detected/i
  );

  const accepted = validateFinalResponse({
    finalResponse: { ...finalResponse, statusReason: 'no-progress-detected' },
    state
  });
  assert.equal(accepted.status, 'stopped-no-progress');
});

test('final response validation rejects stopped-no-progress for read-only findings', () => {
  const state = {
    persistent: true,
    target: 'docs/spec.md',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    filesChanged: 'none',
    readOnlyBlockingIssueIds: ['R001']
  };
  const finalResponse = {
    ...baseBlock,
    finalStatus: 'stopped-no-progress',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    mode: 'read-only',
    filesChanged: 'none',
    fixedIssueIds: 'none',
    deferralsOrBlockers: 'R001 blocks read-only clean finalization',
    statusReason: 'no-progress-detected',
    coordinatorAgreement: 'none'
  };

  assert.throws(
    () => validateFinalResponse({ finalResponse, state }),
    /review-and-fix|read-only-findings/i
  );
});

test('persistent finalize archives a passed state dir', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      status: 'full-re-review',
      currentPhase: 'full-re-review',
      lastDiffReviewReportPath: 'reports/diff-review-round-001.md'
    },
    ledgerIssues: [{
      id: 'ISSUE-001', severity: 'high', status: 'fixed',
      location: 'docs/spec.md:3', summary: 'Original issue',
      resolution: 'Fixed: Updated required section.'
    }]
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
  assert.equal(fs.existsSync(fixture.targetDir), false, 'state dir is archived away');
  assert.match(result.archivedStatePath, /\.drfx\/archived\/.+/);
  assert.equal(fs.existsSync(result.archivedStatePath), true);
  assert.equal(fs.existsSync(path.join(result.archivedStatePath, 'MANIFEST.md')), true);

  const fresh = await runWorkflowCommand('start', [
    'review-fix-spec', `root=${fixture.root}`, `target=${fixture.target}`,
    'review-and-fix', 'guard=snapshot',
    '--assurance', 'practical', '--runtime-platform', 'codex',
    '--runtime-subagent-probe', 'ready', '--runtime-stdin-handoff', 'ready'
  ], { cwd: fixture.root });

  assert.equal(fresh.ok, true);
  assert.equal(fresh.status, 'review');
  assert.equal(fresh.errorCode, undefined);
});

test('persistent finalize archives a read-only-clean state dir', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      mode: 'read-only',
      status: 'read-only-clean',
      currentPhase: 'final',
      currentReportPath: 'reports/triage-round-001.md',
      lastReviewerReportPath: 'reports/reviewer-round-001.md',
      lastTriageReportPath: 'reports/triage-round-001.md',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    },
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'rejected',
        location: 'docs/spec.md:3',
        summary: 'Rejected reviewer finding',
        resolution: 'Rejected: not applicable'
      }
    ]
  });
  writeInitialReviewFailHigh(fixture);
  writeTriageReport(fixture, [
    {
      reviewer_id: 'R001',
      issue_id: 'ISSUE-001',
      decision: 'rejected',
      severity: 'high',
      original_severity: 'high',
      rationale: 'not applicable',
      merged_into: 'none',
      deferred_owner: 'none',
      deferred_next_action: 'none',
      non_blocking: false
    }
  ]);

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

  assert.equal(result.ok, true);
  assert.equal(result.status, 'read-only-clean');
  assert.equal(fs.existsSync(fixture.targetDir), false, 'clean read-only state dir is archived away');
  assert.match(result.archivedStatePath, /\.drfx\/archived\/.+/);
  assert.equal(fs.existsSync(path.join(result.archivedStatePath, 'MANIFEST.md')), true);
});

test('persistent finalize does not archive a stopped-with-deferrals state dir', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      mode: 'read-only',
      status: 'stopped-with-deferrals',
      currentPhase: 'final',
      currentReportPath: 'reports/triage-round-001.md',
      lastReviewerReportPath: 'reports/reviewer-round-001.md',
      lastTriageReportPath: 'reports/triage-round-001.md',
      lastFixReportPath: 'none',
      lastDiffReviewReportPath: 'none'
    },
    ledgerIssues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'deferred',
        location: 'docs/spec.md:3',
        summary: 'Deferred reviewer finding',
        resolution: 'Deferred: needs owner follow-up'
      }
    ]
  });
  writeInitialReviewFailHigh(fixture);
  writeTriageReport(fixture, [
    {
      reviewer_id: 'R001',
      issue_id: 'ISSUE-001',
      decision: 'deferred',
      severity: 'high',
      original_severity: 'high',
      rationale: 'needs owner follow-up',
      merged_into: 'none',
      deferred_owner: 'docs-owner',
      deferred_next_action: 'resolve before clean finalization',
      non_blocking: false
    }
  ]);

  const result = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock({
      finalStatus: 'stopped-with-deferrals',
      mode: 'read-only',
      filesChanged: 'none',
      fixedIssueIds: 'none',
      deferralsOrBlockers: 'deferred high issue ISSUE-001',
      blockingReason: 'none',
      statusReason: 'deferred-findings',
      coordinatorAgreement: 'none'
    })
  });

  // after finalize returns status 'stopped-with-deferrals':
  assert.equal(result.ok, true);
  assert.equal(result.status, 'stopped-with-deferrals');
  assert.equal(fs.existsSync(fixture.targetDir), true, 'unfinished state dir is preserved');
  assert.equal(result.archivedStatePath, undefined);
});

test('persistent finalize keeps a passed dir and warns when archive fails', async (t) => {
  const fixture = makeFixture(t, {
    manifestOverrides: {
      status: 'full-re-review',
      currentPhase: 'full-re-review',
      lastDiffReviewReportPath: 'reports/diff-review-round-001.md'
    },
    ledgerIssues: [{
      id: 'ISSUE-001', severity: 'high', status: 'fixed',
      location: 'docs/spec.md:3', summary: 'Original issue',
      resolution: 'Fixed: Updated required section.'
    }]
  });
  writeFixReport(fixture);
  writeFullReviewPass(fixture);
  writeJsonReport(path.join(fixture.targetDir, 'reports', 'diff-review-round-001.md'), 'Diff Review Report', {
    round: 1,
    normalized: { result: 'DIFF-OK', summary: 'ok', findings: [], warnings: [] }
  });
  fs.writeFileSync(path.join(fixture.root, '.drfx', 'archived'), 'not a dir'); // force archive failure

  const result = await runWorkflowCommand('finalize', [fixture.targetDir, '--final-response-stdin', '--json'], {
    cwd: fixture.root,
    stdin: finalResponseBlock()
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'pass');
  assert.equal(fs.existsSync(fixture.targetDir), true, 'dir stays in place on archive failure');
  assert.ok(result.archiveWarning, 'archive failure is surfaced as a warning');
  assert.equal(result.archivedStatePath, undefined);
});

test('final response validation rejects stopped-no-progress for deferred-only findings', () => {
  const state = {
    persistent: true,
    target: 'docs/spec.md',
    mode: 'review-and-fix',
    assurance: 'practical',
    runtimePlatform: 'codex',
    filesChanged: 'none',
    unresolvedBlockingIssues: [],
    deferredBlockingIssueIds: ['ISSUE-001']
  };
  const finalResponse = {
    ...baseBlock,
    finalStatus: 'stopped-no-progress',
    filesChanged: 'none',
    fixedIssueIds: 'none',
    deferralsOrBlockers: 'ISSUE-001 deferred with owner',
    statusReason: 'no-progress-detected',
    coordinatorAgreement: 'none'
  };

  assert.throws(
    () => validateFinalResponse({ finalResponse, state }),
    /stopped-with-deferrals|unresolved/i
  );
});
