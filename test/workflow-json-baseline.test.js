'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const { formatWorkflowJson, runWorkflowCommand } = require('../lib/workflow');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'workflow-json', 'start-snapshot.json');
const BIN = path.join(__dirname, '..', 'bin', 'drfx.js');
const REQUIRED_COMPACT_ALLOWLIST_ROWS = [
  ['state', 'preflight'],
  ['state', 'start'],
  ['state', 'context'],
  ['state', 'record-review'],
  ['state', 'record-triage'],
  ['fix-lifecycle', 'begin-fix'],
  ['fix-lifecycle', 'refresh-lock'],
  ['fix-lifecycle', 'end-fix'],
  ['fix-lifecycle', 'abort-fix'],
  ['fix-lifecycle', 'record-diff-review'],
  ['fix-lifecycle', 'finalize'],
  ['file-set', 'start-or-resume'],
  ['file-set', 'context'],
  ['file-set', 'record-review'],
  ['file-set', 'record-triage'],
  ['file-set', 'aggregate-review'],
  ['partitioned', 'plan'],
  ['partitioned', 'context'],
  ['partitioned', 'unit-review'],
  ['partitioned', 'crosscutting'],
  ['partitioned', 'aggregate'],
  ['no-state', 'preflight'],
  ['no-state', 'context'],
  ['no-state', 'record-review'],
  ['no-state', 'record-triage'],
  ['no-state', 'finalize']
];
const ALLOWED_COMPACT_PURPOSES = new Set([
  'stdout required',
  'user status',
  'path readable',
  'debug only'
]);
const FULL_OUTPUT_FIELD_PURPOSES = new Map([
  ['ok', 'stdout required'],
  ['status', 'stdout required'],
  ['errorCode', 'user status'],
  ['message', 'user status'],
  ['targetStateDir', 'path readable'],
  ['targetKey', 'user status'],
  ['manifestPath', 'path readable'],
  ['ledgerPath', 'path readable'],
  ['round', 'user status'],
  ['documentType', 'user status'],
  ['strictness', 'user status'],
  ['requestedMode', 'user status'],
  ['mode', 'user status'],
  ['guardMode', 'user status'],
  ['modeSource', 'user status'],
  ['modeNormalizedFrom', 'user status'],
  ['requestedAssurance', 'user status'],
  ['assuranceSource', 'user status'],
  ['assuranceNormalizedFrom', 'user status'],
  ['assurance', 'user status'],
  ['runtimePlatform', 'user status'],
  ['descriptorPlatform', 'user status'],
  ['assuranceProof', 'user status'],
  ['strictProofError', 'user status'],
  ['runtimeCheck', 'debug only'],
  ['contextManifestPath', 'path readable'],
  ['contextPackSkeleton', 'debug only'],
  ['reviewGuard', 'stdout required'],
  ['stateToken', 'stdout required'],
  ['nextAction', 'user status'],
  ['blockingReason', 'user status'],
  ['statusReason', 'user status'],
  ['warnings', 'user status'],
  ['lockOwnerId', 'stdout required'],
  ['leaseId', 'stdout required'],
  ['leaseExpiresAt', 'stdout required'],
  ['refreshAfterSeconds', 'stdout required'],
  ['fixGuardReportPath', 'path readable'],
  ['fixReportPath', 'path readable'],
  ['fixedIssueIds', 'user status'],
  ['currentPhase', 'user status'],
  ['diffReviewReportPath', 'path readable'],
  ['finalResponse', 'user status'],
  ['requiresFullReview', 'user status'],
  ['requiresUserDecision', 'user status'],
  ['conflict', 'user status'],
  ['continuityWarning', 'user status'],
  ['receiptPath', 'path readable'],
  ['originalBlockingReason', 'user status'],
  ['archivedStatePath', 'path readable'],
  ['archiveWarning', 'user status'],
  ['userExcludes', 'debug only'],
  ['scopeIgnoreOverrides', 'debug only'],
  ['reviewMode', 'user status'],
  ['reviewPlanPath', 'path readable'],
  ['reason', 'user status'],
  ['reviewerReportPath', 'path readable'],
  ['unitCount', 'user status'],
  ['unitByteBudget', 'user status'],
  ['units', 'debug only'],
  ['projectReviewFingerprint', 'debug only'],
  ['unitId', 'stdout required'],
  ['oversize', 'user status'],
  ['reused', 'user status'],
  ['reviewCacheKey', 'user status'],
  ['coverageRisk', 'user status'],
  ['backstop', 'stdout required'],
  ['backstops', 'user status'],
  ['summaries', 'debug only'],
  ['verdict', 'user status'],
  ['coverageProof', 'debug only'],
  ['forcedReread', 'user status'],
  ['crosscuttingBackstops', 'user status'],
  ['uncoveredUnitIds', 'user status'],
  ['uncoveredBackstops', 'user status'],
  ['aggregatePath', 'path readable']
]);
const STATUS_COMPACT_FIELDS = [
  'ok',
  'status',
  'errorCode',
  'message',
  'nextAction',
  'blockingReason',
  'statusReason',
  'warnings'
];
const WORKFLOW_IDENTITY_COMPACT_FIELDS = [
  'targetStateDir',
  'targetKey',
  'manifestPath',
  'ledgerPath',
  'round',
  'documentType',
  'strictness',
  'requestedMode',
  'mode',
  'guardMode',
  'modeSource',
  'modeNormalizedFrom',
  'requestedAssurance',
  'assuranceSource',
  'assuranceNormalizedFrom',
  'assurance',
  'runtimePlatform',
  'descriptorPlatform',
  'assuranceProof',
  'strictProofError',
  'currentPhase'
];
const STATE_CONTEXT_FIELDS = ['contextManifestPath'];
const REVIEW_RECORD_FIELDS = ['contextManifestPath', 'reviewerReportPath'];
const FIX_LOCK_FIELDS = ['lockOwnerId', 'leaseId', 'leaseExpiresAt', 'refreshAfterSeconds', 'fixGuardReportPath'];
const FINALIZATION_STATUS_FIELDS = [
  'requiresUserDecision',
  'conflict',
  'continuityWarning',
  'originalBlockingReason'
];
const PARTITION_PLAN_FIELDS = [
  'reviewMode',
  'reviewPlanPath',
  'reason',
  'unitCount',
  'unitByteBudget',
  'oversize',
  'reviewCacheKey',
  'backstops',
  'forcedReread',
  'crosscuttingBackstops'
];
const PARTITION_UNIT_FIELDS = ['reused'];
const NO_STATE_TOKEN_FIELDS = ['reviewGuard', 'stateToken'];
const DEBUG_ONLY_FULL_FIELDS_OMITTED_FROM_COMPACT_MATRIX = new Set([
  'runtimeCheck',
  'contextPackSkeleton',
  'userExcludes',
  'scopeIgnoreOverrides',
  'units',
  'projectReviewFingerprint',
  'summaries',
  'coverageProof'
]);

const REVIEW_FAIL = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: docs/spec.md',
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
  '- docs/spec.md',
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
  'Target: docs/spec.md',
  'Files changed: docs/spec.md',
  'Fixed issue IDs: ISSUE-001',
  'Verification performed: node --test test/workflow-json-baseline.test.js',
  'Deferrals or blockers: none',
  'Blocking reason: none',
  'Status reason: none',
  'Residual risk: none identified',
  'Redaction statement: no sensitive values persisted',
  'Coordinator agreement: approved after full re-review'
].join('\n');

function compactRow(scope, command, fields) {
  return {
    scope,
    command,
    fields: [...new Set(fields)]
  };
}

const COMPACT_ALLOWLIST_MATRIX = [
  compactRow('state', 'preflight', [...STATUS_COMPACT_FIELDS, ...WORKFLOW_IDENTITY_COMPACT_FIELDS]),
  compactRow('state', 'start', [...STATUS_COMPACT_FIELDS, ...WORKFLOW_IDENTITY_COMPACT_FIELDS]),
  compactRow('state', 'context', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...STATE_CONTEXT_FIELDS
  ]),
  compactRow('state', 'record-review', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...REVIEW_RECORD_FIELDS
  ]),
  compactRow('state', 'record-triage', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'ledgerPath'
  ]),
  compactRow('fix-lifecycle', 'begin-fix', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...FIX_LOCK_FIELDS
  ]),
  compactRow('fix-lifecycle', 'refresh-lock', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...FIX_LOCK_FIELDS
  ]),
  compactRow('fix-lifecycle', 'end-fix', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'fixReportPath',
    'fixedIssueIds'
  ]),
  compactRow('fix-lifecycle', 'abort-fix', [...STATUS_COMPACT_FIELDS, ...WORKFLOW_IDENTITY_COMPACT_FIELDS]),
  compactRow('fix-lifecycle', 'record-diff-review', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'diffReviewReportPath',
    'requiresFullReview',
    'requiresUserDecision',
    'continuityWarning'
  ]),
  compactRow('fix-lifecycle', 'finalize', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'finalResponse',
    'fixedIssueIds',
    ...FINALIZATION_STATUS_FIELDS,
    'receiptPath',
    'archivedStatePath',
    'archiveWarning'
  ]),
  compactRow('file-set', 'start-or-resume', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'reviewMode',
    'reviewPlanPath'
  ]),
  compactRow('file-set', 'context', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...STATE_CONTEXT_FIELDS,
    'reviewMode'
  ]),
  compactRow('file-set', 'record-review', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...REVIEW_RECORD_FIELDS,
    'reviewMode'
  ]),
  compactRow('file-set', 'record-triage', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'ledgerPath',
    'reviewMode'
  ]),
  compactRow('file-set', 'aggregate-review', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'verdict',
    'aggregatePath',
    'uncoveredUnitIds',
    'uncoveredBackstops'
  ]),
  compactRow('partitioned', 'plan', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...PARTITION_PLAN_FIELDS
  ]),
  compactRow('partitioned', 'context', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...PARTITION_PLAN_FIELDS,
    'unitId',
    'backstop'
  ]),
  compactRow('partitioned', 'unit-review', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'unitId',
    'coverageRisk',
    'reviewerReportPath',
    ...PARTITION_UNIT_FIELDS
  ]),
  compactRow('partitioned', 'crosscutting', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'backstop',
    'coverageRisk',
    'reviewerReportPath'
  ]),
  compactRow('partitioned', 'aggregate', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'verdict',
    'aggregatePath',
    'uncoveredUnitIds',
    'uncoveredBackstops'
  ]),
  compactRow('no-state', 'preflight', [...STATUS_COMPACT_FIELDS, ...NO_STATE_TOKEN_FIELDS]),
  compactRow('no-state', 'context', [...STATUS_COMPACT_FIELDS, ...STATE_CONTEXT_FIELDS, ...NO_STATE_TOKEN_FIELDS]),
  compactRow('no-state', 'record-review', [
    ...STATUS_COMPACT_FIELDS,
    'reviewerReportPath',
    ...NO_STATE_TOKEN_FIELDS
  ]),
  compactRow('no-state', 'record-triage', [...STATUS_COMPACT_FIELDS, 'ledgerPath', ...NO_STATE_TOKEN_FIELDS]),
  compactRow('no-state', 'finalize', [
    ...STATUS_COMPACT_FIELDS,
    'finalResponse',
    'fixedIssueIds',
    ...NO_STATE_TOKEN_FIELDS
  ])
];

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function freshFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-workflow-json-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);

  const target = path.join(root, 'spec.md');
  fs.writeFileSync(target, '# Spec\n\nbody\n');

  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  return { root, target };
}

function freshRouteFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-workflow-json-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);

  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# Spec\n\nbody\n');

  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  return { root, target: path.join(root, 'docs', 'spec.md') };
}

function jsonFlag(jsonMode) {
  return jsonMode === 'bare' ? '--json' : `--json=${jsonMode}`;
}

function routeArgs({ jsonMode = 'bare', phase = null, root = null, target = 'docs/spec.md' } = {}) {
  return [
    'review-fix-spec',
    ...(root ? [`root=${root}`] : []),
    `target=${target}`,
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
    '--runtime-downgrade-reason',
    'none',
    ...(phase ? ['--phase', phase] : []),
    jsonFlag(jsonMode)
  ];
}

function runWorkflowCli(cwd, subcommand, args, { input = undefined } = {}) {
  const result = spawnSync(process.execPath, [BIN, 'workflow', subcommand, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  assert.equal(result.stderr, '', result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.status, 0, JSON.stringify(parsed));
  return parsed;
}

function workflowFieldValue(field) {
  if (field === 'ok') return true;
  if (field === 'warnings') return [];
  if (field === 'runtimeCheck') return { platform: 'codex' };
  if (field === 'contextPackSkeleton') return { target: 'docs/spec.md', body: 'debug-only body' };
  if (field === 'strictProofError') return { reason: 'debug' };
  if (field === 'finalResponse') return { finalStatus: 'pass' };
  if (field === 'conflict') return { kind: 'conflict' };
  if (field === 'fixedIssueIds') return ['ISSUE-001'];
  if (field === 'userExcludes') return [];
  if (field === 'scopeIgnoreOverrides') return [];
  if (field === 'units') return [{ unit_id: 'unit-001' }];
  if (field === 'backstops') return ['security-redaction'];
  if (field === 'summaries') return [{ unit_id: 'unit-001' }];
  if (field === 'coverageProof') return { reviewed: true };
  if (field === 'crosscuttingBackstops') return ['security-redaction'];
  if (field === 'uncoveredUnitIds') return [];
  if (field === 'uncoveredBackstops') return [];
  if (field === 'requiresFullReview' || field === 'requiresUserDecision') return true;
  if (field === 'oversize' || field === 'reused' || field === 'forcedReread') return false;
  if (field === 'round' || field === 'refreshAfterSeconds' || field === 'unitCount' || field === 'unitByteBudget') return 1;
  if (/Path$/.test(field) || /Dir$/.test(field)) return `/tmp/drfx/${field}`;
  if (/At$/.test(field)) return '2026-06-25T00:00:00.000Z';
  return `${field}-value`;
}

function allFormatterFieldsResult() {
  return new Proxy({}, {
    get(_target, property) {
      return workflowFieldValue(String(property));
    },
    getOwnPropertyDescriptor(_target, property) {
      return {
        configurable: true,
        enumerable: true,
        value: workflowFieldValue(String(property))
      };
    }
  });
}

function compactAllowlistFields() {
  const fields = new Set();
  for (const row of COMPACT_ALLOWLIST_MATRIX) {
    for (const field of row.fields) fields.add(field);
  }
  return fields;
}

function assertRequiredCompactFields(label, response, requiredFields) {
  assert.equal(response.ok, true, `${label} compact response must be ok`);
  for (const field of ['status', 'targetStateDir', ...requiredFields]) {
    assert.equal(Object.hasOwn(response, field), true, `${label} compact response missing ${field}`);
    assert.notEqual(response[field], null, `${label} compact response has null ${field}`);
    if (typeof response[field] === 'string') {
      assert.notEqual(response[field], '', `${label} compact response has empty ${field}`);
    }
    if (Array.isArray(response[field])) {
      assert.ok(response[field].length > 0, `${label} compact response has empty ${field}`);
    }
  }
}

async function runGeneratedRouteContinuationSmoke(t, { jsonMode }) {
  const fixture = freshRouteFixture(t);
  const common = routeArgs({ jsonMode, root: fixture.root, target: fixture.target });
  const start = runWorkflowCli(fixture.root, 'start', common);
  const context = runWorkflowCli(fixture.root, 'context', common);
  const recordReview = runWorkflowCli(fixture.root, 'record-review', [
    ...common,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { input: REVIEW_FAIL });
  const recordTriage = runWorkflowCli(fixture.root, 'record-triage', [
    ...common,
    '--triage-stdin'
  ], { input: TRIAGE_ACCEPT });

  const beginFix = runWorkflowCli(fixture.root, 'begin-fix', [start.targetStateDir, jsonFlag(jsonMode)]);
  fs.writeFileSync(fixture.target, '# Spec\n\nclarified body\n');
  const endFix = runWorkflowCli(fixture.root, 'end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    jsonFlag(jsonMode)
  ], { input: FIX_REPORT });
  const recordDiffReview = runWorkflowCli(fixture.root, 'record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    jsonFlag(jsonMode)
  ], { input: DIFF_OK });
  const fullReviewContext = runWorkflowCli(fixture.root, 'context', routeArgs({
    jsonMode,
    phase: 'full-re-review',
    root: fixture.root,
    target: fixture.target
  }));
  const fullReviewRecordReview = runWorkflowCli(fixture.root, 'record-review', [
    ...routeArgs({
      jsonMode,
      phase: 'full-re-review',
      root: fixture.root,
      target: fixture.target
    }),
    '--result-stdin'
  ], { input: REVIEW_PASS });
  const finalize = runWorkflowCli(fixture.root, 'finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    jsonFlag(jsonMode)
  ], { input: FINAL_PASS });

  return {
    start,
    context,
    recordReview,
    recordTriage,
    beginFix,
    endFix,
    recordDiffReview,
    fullReviewContext,
    fullReviewRecordReview,
    finalize
  };
}

test('workflowJson baseline for start stays byte-for-byte stable', async (t) => {
  const fixture = freshFixture(t);
  const args = [
    'review-fix-spec',
    `target=${fixture.target}`,
    'read-only',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--runtime-downgrade-reason',
    'none',
    '--json'
  ];

  const result = await runWorkflowCommand('start', args, {
    cwd: fixture.root,
    projectRoot: fixture.root,
    now: new Date('2026-05-27T00:00:00Z')
  });
  const expected = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const actual = formatWorkflowJson(result) + '\n';

  assert.equal(actual, expected);
});

test('SCOPE-IN-001 compact allowlist matrix covers every generated-route workflow path', () => {
  const rows = new Set(COMPACT_ALLOWLIST_MATRIX.map((row) => `${row.scope}:${row.command}`));
  for (const [scope, command] of REQUIRED_COMPACT_ALLOWLIST_ROWS) {
    assert.equal(rows.has(`${scope}:${command}`), true, `missing compact allowlist row ${scope}/${command}`);
  }

  for (const row of COMPACT_ALLOWLIST_MATRIX) {
    assert.ok(row.fields.length > 0, `${row.scope}/${row.command} must list compact fields`);
    for (const field of row.fields) {
      assert.ok(FULL_OUTPUT_FIELD_PURPOSES.has(field), `${row.scope}/${row.command} references unclassified field ${field}`);
      assert.ok(
        ALLOWED_COMPACT_PURPOSES.has(FULL_OUTPUT_FIELD_PURPOSES.get(field)),
        `${row.scope}/${row.command}.${field} lacks an allowed compact purpose`
      );
    }
  }
});

test('SCOPE-IN-001 compact formatter matrix classifies every route-automated full-output field', () => {
  const full = JSON.parse(formatWorkflowJson(allFormatterFieldsResult(), { mode: 'full', subcommand: 'context' }));
  const matrixFields = compactAllowlistFields();
  for (const field of Object.keys(full)) {
    assert.ok(FULL_OUTPUT_FIELD_PURPOSES.has(field), `unclassified full-output field: ${field}`);
    const purpose = FULL_OUTPUT_FIELD_PURPOSES.get(field);
    assert.ok(
      ALLOWED_COMPACT_PURPOSES.has(purpose),
      `field ${field} has unsupported compact purpose ${purpose}`
    );
    if (matrixFields.has(field)) continue;
    assert.equal(purpose, 'debug only', `full-output field ${field} is absent from compact allowlist matrix`);
    assert.ok(
      DEBUG_ONLY_FULL_FIELDS_OMITTED_FROM_COMPACT_MATRIX.has(field),
      `debug-only full-output field ${field} is absent from compact matrix without explicit accounting`
    );
  }
  for (const field of DEBUG_ONLY_FULL_FIELDS_OMITTED_FROM_COMPACT_MATRIX) {
    assert.equal(Object.hasOwn(full, field), true, `debug-only compact omission ${field} is not emitted by full output`);
    assert.equal(FULL_OUTPUT_FIELD_PURPOSES.get(field), 'debug only', `${field} omission must stay classified debug only`);
    assert.equal(matrixFields.has(field), false, `${field} is listed as compact-omitted but appears in the matrix`);
  }
});

test('SCOPE-IN-001 compact context output keeps paths and omits skeleton bodies', async (t) => {
  const fixture = freshRouteFixture(t);
  const args = routeArgs({ jsonMode: 'bare', root: fixture.root, target: fixture.target });
  const start = await runWorkflowCommand('start', args, { cwd: fixture.root });
  assert.equal(start.ok, true, JSON.stringify(start));
  const contextResult = await runWorkflowCommand('context', args, { cwd: fixture.root });
  assert.equal(contextResult.ok, true, JSON.stringify(contextResult));

  const full = JSON.parse(formatWorkflowJson(contextResult, { mode: 'full', subcommand: 'context' }));
  const compact = JSON.parse(formatWorkflowJson(contextResult, { mode: 'compact', subcommand: 'context' }));
  assert.ok(full.contextPackSkeleton);
  assert.equal(compact.contextPackSkeleton, undefined);
  assert.ok(compact.contextManifestPath);
});

test('SCOPE-IN-001 compact generated-route continuation keeps next-step artifact paths', async (t) => {
  const sequence = await runGeneratedRouteContinuationSmoke(t, { jsonMode: 'compact' });
  assertRequiredCompactFields('start', sequence.start, ['targetKey']);
  assertRequiredCompactFields('context', sequence.context, ['contextManifestPath']);
  assertRequiredCompactFields('record-review', sequence.recordReview, ['reviewerReportPath']);
  assertRequiredCompactFields('record-triage', sequence.recordTriage, ['ledgerPath']);
  assertRequiredCompactFields('begin-fix', sequence.beginFix, [
    'lockOwnerId',
    'leaseId',
    'leaseExpiresAt',
    'fixGuardReportPath'
  ]);
  assertRequiredCompactFields('end-fix', sequence.endFix, ['fixReportPath', 'fixedIssueIds']);
  assertRequiredCompactFields('record-diff-review', sequence.recordDiffReview, ['diffReviewReportPath']);
  assertRequiredCompactFields('full-re-review context', sequence.fullReviewContext, ['contextManifestPath']);
  assertRequiredCompactFields('full-re-review record-review', sequence.fullReviewRecordReview, ['reviewerReportPath']);
  assertRequiredCompactFields('finalize', sequence.finalize, ['finalResponse', 'receiptPath']);
});
