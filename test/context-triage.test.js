'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildContextPack } = require('../lib/context-pack');
const {
  applyTriageDecisions,
  parseLedger
} = require('../lib/ledger');
const { computeFingerprint, deriveTargetKey } = require('../lib/target-state');
const { runWorkflowCommand } = require('../lib/workflow');
const { formatManifestV2, parseManifestV2 } = require('../lib/workflow-state');

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
    status: 'review',
    currentPhase: 'review',
    currentRound: 1,
    assurance: 'practical',
    runtimePlatform: 'codex',
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    runtimeSubagentProbe: 'ready',
    runtimeSubagentProbeEvidence: 'route-asserted-ready',
    runtimeFingerprintGuard: 'not-run',
    runtimeStdinHandoff: 'ready',
    runtimeStdinHandoffEvidence: 'route-asserted-ready',
    runtimeDowngradeReason: 'none',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: 'none',
    lastReviewerReportPath: 'none',
    lastTriageReportPath: 'none',
    lastFixReportPath: 'none',
    lastDiffReviewReportPath: 'none',
    initialContentSha256: 'a'.repeat(64),
    lastKnownContentSha256: 'a'.repeat(64),
    lastReviewedContentSha256: 'none',
    lastPassedContentSha256: 'none',
    lastModifiedAt: '2026-05-21T00:00:00.000Z',
    fileSize: 10,
    references: [],
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    ...overrides
  };
}

function makePersistentFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-context-triage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(root, 'docs', 'spec.md');
  const reference = path.join(root, 'docs', 'ref.md');
  fs.writeFileSync(target, '# Target\n\nTarget body sentinel must stay out of manifests.\n');
  fs.writeFileSync(reference, '# Reference\n\nReference body sentinel must stay out of manifests.\n');

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
    lastModifiedAt: new Date(0).toISOString(),
    fileSize: fingerprint.size,
    references: ['docs/ref.md']
  });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(manifestPath, formatManifestV2(manifest));

  return { root, target, reference, targetDir, manifestPath, ledgerPath };
}

function workflowArgs({ root, target, reference, phase = 'initial-review' }) {
  return [
    'review-fix-spec',
    `root=${root}`,
    `target=${target}`,
    `ref=${reference}`,
    'review-and-fix',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--phase',
    phase,
    '--json'
  ];
}

function reviewerFailPayload() {
  return [
    'FAIL',
    'Findings:',
    '- id: R001',
    '  severity: high',
    '  location: docs/spec.md:3',
    '  issue: Missing deterministic triage persistence',
    '  why_it_matters: repeated runs could assign unstable IDs',
    '  suggested_fix: Persist a normalized ledger update',
    '  confidence: confirmed',
    '  sensitive: false'
  ].join('\n');
}

function triageAcceptedPayload(reviewerId = 'R001') {
  return [
    'Triage:',
    `- reviewer_id: ${reviewerId}`,
    '  issue_id: ISSUE-001',
    '  decision: accepted',
    '  severity: high',
    '  original_severity: high',
    '  rationale: none',
    '  merged_into: none',
    '  deferred_owner: none',
    '  deferred_next_action: none',
    '  non_blocking: false'
  ].join('\n');
}

test('context pack includes merged rule set and deterministic rules source list', () => {
  const pack = buildContextPack({
    target: 'docs/spec.md',
    references: [{ path: 'docs/ref.md', readOnly: true }],
    documentType: 'SPEC',
    strictness: 'normal',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    phase: 'initial-review',
    round: 1,
    mergedRules: {
      text: '### hard\nWorkflow hard constraints',
      sources: ['hard', 'built-in-SPEC', 'user-COMMON', 'project-SPEC']
    },
    acceptedNonBlockingLowIssueIds: [],
    requiredOutputSchema: 'reviewer-pass-fail',
    reviewerGuardBaseline: { target: { sha256: 'a'.repeat(64), size: 1, mtimeMs: 1 }, references: [] }
  });

  assert.equal(pack.contentPolicy, 'read-in-memory-only');
  assert.deepEqual(pack.rulesSourceList.map((entry) => entry.category), [
    'package built-in',
    'package built-in',
    'user-global',
    'project-local'
  ]);
  assert.equal(pack.acceptedNonBlockingLowIssueIds, 'none');
  assert.doesNotMatch(JSON.stringify(pack), /Target body/);
});

test('triage maps accepted reopened merged downgraded rejected deferred decisions', () => {
  const ledger = {
    issues: [
      { id: 'ISSUE-001', severity: 'medium', status: 'fixed', location: 'A', summary: 'Old', resolution: 'Fixed' }
    ]
  };
  const next = applyTriageDecisions(ledger, [
    { reviewer_id: 'R001', decision: 'accepted', severity: 'high', location: 'B', summary: 'New', rationale: 'Valid' },
    { reviewer_id: 'R002', decision: 'reopened', issue_id: 'ISSUE-001', severity: 'medium', rationale: 'Regression' },
    { reviewer_id: 'R003', decision: 'merged', issue_id: 'ISSUE-003', severity: 'low', merged_into: 'ISSUE-001', rationale: 'Duplicate' },
    { reviewer_id: 'R004', decision: 'downgraded', issue_id: 'ISSUE-004', severity: 'low', original_severity: 'medium', rationale: 'Low impact' },
    { reviewer_id: 'R005', decision: 'rejected', issue_id: 'ISSUE-005', severity: 'low', rationale: 'Not applicable' },
    { reviewer_id: 'R006', decision: 'deferred', issue_id: 'ISSUE-006', severity: 'medium', rationale: 'Needs owner', deferred_owner: 'user', deferred_next_action: 'Decide scope' }
  ]);

  assert.equal(next.issues.find((issue) => issue.id === 'ISSUE-001').status, 'reopened');
  assert.equal(next.issues.some((issue) => issue.status === 'downgraded'), false);
  assert.equal(next.issues.find((issue) => issue.status === 'merged').resolution.includes('Merged into ISSUE-001'), true);
  assert.deepEqual(next.issues.map((issue) => issue.id), [
    'ISSUE-001',
    'ISSUE-002',
    'ISSUE-003',
    'ISSUE-004',
    'ISSUE-005',
    'ISSUE-006'
  ]);
});

test('triage records non-blocking low accepted issue ids only for low severity', () => {
  const next = applyTriageDecisions({ issues: [] }, [
    {
      reviewer_id: 'R001',
      issue_id: 'ISSUE-001',
      decision: 'accepted',
      severity: 'low',
      location: 'A',
      summary: 'Low issue',
      rationale: 'Accepted but not blocking',
      non_blocking: true
    }
  ]);

  assert.deepEqual(next.acceptedNonBlockingLowIssueIds, ['ISSUE-001']);
  assert.match(next.issues[0].resolution, /Accepted as non-blocking low/i);
  assert.throws(
    () => applyTriageDecisions({ issues: [] }, [
      {
        reviewer_id: 'R001',
        issue_id: 'ISSUE-001',
        decision: 'accepted',
        severity: 'medium',
        location: 'A',
        summary: 'Medium issue',
        rationale: 'Cannot be non-blocking',
        non_blocking: true
      }
    ]),
    /non-blocking|low/i
  );
});

test('persistent workflow context writes reviewer manifest without target body', async (t) => {
  const fixture = makePersistentFixture(t);
  const result = await runWorkflowCommand('context', workflowArgs(fixture), { cwd: fixture.root });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'context');
  assert.equal(result.contextManifestPath, path.join(result.targetStateDir, 'context', 'current-reviewer-context-manifest.md'));
  const text = fs.readFileSync(result.contextManifestPath, 'utf8');
  assert.match(text, /"contentPolicy": "read-in-memory-only"/);
  assert.match(text, /Workflow hard constraints/);
  assert.match(text, /"requiredOutputSchema": "reviewer-pass-fail"/);
  assert.doesNotMatch(text, /Target body sentinel|Reference body sentinel/);
});

test('persistent record-review blocks when reviewer guard fingerprints change', async (t) => {
  const fixture = makePersistentFixture(t);
  await runWorkflowCommand('context', workflowArgs(fixture), { cwd: fixture.root });
  fs.appendFileSync(fixture.target, '\nReviewer mutation attempt.\n');

  const result = await runWorkflowCommand('record-review', [
    ...workflowArgs(fixture),
    '--result-stdin'
  ], {
    cwd: fixture.root,
    stdin: reviewerFailPayload()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'reviewer-mutated-file');
  assert.equal(fs.existsSync(path.join(fixture.targetDir, 'reports', 'reviewer-round-001.md')), false);
});

test('persistent record-review stores producer metadata and record-triage updates ledger', async (t) => {
  const fixture = makePersistentFixture(t);
  await runWorkflowCommand('context', workflowArgs(fixture), { cwd: fixture.root });

  const review = await runWorkflowCommand('record-review', [
    ...workflowArgs(fixture),
    '--result-stdin'
  ], {
    cwd: fixture.root,
    stdin: reviewerFailPayload()
  });
  assert.equal(review.ok, true);
  assert.equal(review.status, 'recorded-review');
  const reviewerReport = fs.readFileSync(path.join(fixture.targetDir, 'reports', 'reviewer-round-001.md'), 'utf8');
  assert.match(reviewerReport, /Producer: reviewer-subagent/);
  assert.doesNotMatch(reviewerReport, /^FAIL$/m);

  const triage = await runWorkflowCommand('record-triage', [
    ...workflowArgs(fixture),
    '--triage-stdin'
  ], {
    cwd: fixture.root,
    stdin: triageAcceptedPayload()
  });
  assert.equal(triage.ok, true);
  assert.equal(triage.status, 'recorded-triage');
  assert.deepEqual(parseLedger(fs.readFileSync(fixture.ledgerPath, 'utf8')).issues, [
    {
      id: 'ISSUE-001',
      severity: 'high',
      status: 'accepted',
      location: 'docs/spec.md:3',
      summary: 'Missing deterministic triage persistence',
      resolution: 'Persist a normalized ledger update'
    }
  ]);
  assert.equal(fs.existsSync(path.join(fixture.targetDir, 'reports', 'triage-round-001.md')), true);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.currentPhase, 'fix');
  assert.equal(manifest.lastReviewerReportPath, 'reports/reviewer-round-001.md');
  assert.equal(manifest.lastTriageReportPath, 'reports/triage-round-001.md');
});

test('persistent record-triage rejects reviewer ids absent from latest normalized report', async (t) => {
  const fixture = makePersistentFixture(t);
  await runWorkflowCommand('context', workflowArgs(fixture), { cwd: fixture.root });
  await runWorkflowCommand('record-review', [
    ...workflowArgs(fixture),
    '--result-stdin'
  ], {
    cwd: fixture.root,
    stdin: reviewerFailPayload()
  });

  await assert.rejects(
    () => runWorkflowCommand('record-triage', [
      ...workflowArgs(fixture),
      '--triage-stdin'
    ], {
      cwd: fixture.root,
      stdin: triageAcceptedPayload('R999')
    }),
    /reviewer_id|R999/i
  );
  assert.equal(fs.existsSync(fixture.ledgerPath), false);
});
