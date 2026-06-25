'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  formatWorkflowJson,
  runWorkflowCommand,
  FULL_OUTPUT_FIELD_PURPOSES: PRODUCTION_FIELD_PURPOSES,
  COMPACT_ALLOWLIST_MATRIX: PRODUCTION_COMPACT_ALLOWLIST_MATRIX
} = require('../lib/workflow');

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
  ['no-state', 'partitioned-context'],
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
  ['contextPackSkeleton', 'stdout required'],
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
  ['units', 'stdout required'],
  ['projectReviewFingerprint', 'stdout required'],
  ['unitId', 'stdout required'],
  ['oversize', 'user status'],
  ['reused', 'user status'],
  ['reviewCacheKey', 'user status'],
  ['coverageRisk', 'user status'],
  ['backstop', 'stdout required'],
  ['backstops', 'user status'],
  ['summaries', 'stdout required'],
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
const NO_STATE_PARTITION_PLAN_FIELDS = [
  ...PARTITION_PLAN_FIELDS,
  'units',
  'projectReviewFingerprint'
];
const NO_STATE_TOKEN_FIELDS = ['reviewGuard', 'stateToken'];
const DEBUG_ONLY_FULL_FIELDS_OMITTED_FROM_COMPACT_MATRIX = new Set([
  'runtimeCheck',
  'userExcludes',
  'scopeIgnoreOverrides',
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
    'fixedIssueIds',
    'reviewMode'
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
    ...STATE_CONTEXT_FIELDS,
    'unitId',
    'backstop',
    'summaries'
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
    'reason',
    'reviewerReportPath',
    'aggregatePath',
    'uncoveredUnitIds',
    'uncoveredBackstops'
  ]),
  compactRow('no-state', 'partitioned-context', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...NO_STATE_PARTITION_PLAN_FIELDS
  ]),
  compactRow('no-state', 'preflight', [...STATUS_COMPACT_FIELDS, ...NO_STATE_TOKEN_FIELDS]),
  compactRow('no-state', 'context', [
    ...STATUS_COMPACT_FIELDS,
    ...STATE_CONTEXT_FIELDS,
    'contextPackSkeleton',
    ...NO_STATE_TOKEN_FIELDS
  ]),
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

function compactAllowlistRow(scope, command) {
  const row = COMPACT_ALLOWLIST_MATRIX.find((candidate) => (
    candidate.scope === scope && candidate.command === command
  ));
  assert.ok(row, `missing compact allowlist row ${scope}/${command}`);
  return row;
}

function assertCompactResponseFields(label, response, { scope, command, requiredFields }) {
  const row = compactAllowlistRow(scope, command);
  const allowedFields = new Set(row.fields);
  assert.equal(response.ok, true, `${label} compact response must be ok`);
  for (const field of ['ok', 'status', ...requiredFields]) {
    assert.equal(
      allowedFields.has(field),
      true,
      `${label} compact required field ${field} missing from ${scope}/${command} allowlist`
    );
    assert.equal(Object.hasOwn(response, field), true, `${label} compact response missing ${field}`);
    assert.notEqual(response[field], null, `${label} compact response has null ${field}`);
    if (typeof response[field] === 'string') {
      assert.notEqual(response[field], '', `${label} compact response has empty ${field}`);
    }
    if (Array.isArray(response[field])) {
      assert.ok(response[field].length > 0, `${label} compact response has empty ${field}`);
    }
  }
  for (const field of Object.keys(response)) {
    assert.equal(
      allowedFields.has(field),
      true,
      `${label} compact response leaked ${field}; ${scope}/${command} compact allowlist is ${row.fields.join(', ')}`
    );
    assert.notEqual(
      FULL_OUTPUT_FIELD_PURPOSES.get(field),
      'debug only',
      `${label} compact response leaked debug-only full field ${field}`
    );
  }
  for (const field of DEBUG_ONLY_FULL_FIELDS_OMITTED_FROM_COMPACT_MATRIX) {
    assert.equal(
      Object.hasOwn(response, field),
      false,
      `${label} compact response leaked debug-only full field ${field}`
    );
  }
}

function assertCompactByteRatio(label, fullText, compactText, maxRatio) {
  const fullBytes = Buffer.byteLength(fullText, 'utf8');
  const compactBytes = Buffer.byteLength(compactText, 'utf8');
  const allowedBytes = Math.ceil(fullBytes * maxRatio);
  assert.ok(
    compactBytes <= allowedBytes,
    `${label} compact/full byte ratio too large: fullBytes=${fullBytes} compactBytes=${compactBytes} allowedBytes=${allowedBytes} maxRatio=${maxRatio}`
  );
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

// No-state (advisory) partitioned context has no manifest to persist the partition plan,
// so it is the ONLY compact row allowed to carry the large `units` array and the
// `projectReviewFingerprint`. State-backed partitioned context reads them from the
// manifest. This invariant locks the widening to that single row so a future edit cannot
// silently leak the full unit plan into every partitioned/file-set/state compact output.
test('SCOPE-IN-001 units and projectReviewFingerprint are compact-allowlisted for no-state partitioned context ONLY', () => {
  for (const field of ['units', 'projectReviewFingerprint']) {
    const rowsWithField = COMPACT_ALLOWLIST_MATRIX
      .filter((row) => row.fields.includes(field))
      .map((row) => `${row.scope}:${row.command}`);
    assert.deepEqual(
      rowsWithField,
      ['no-state:partitioned-context'],
      `${field} must appear in exactly the no-state:partitioned-context compact row, not ${rowsWithField.join(', ') || 'none'}`
    );
  }
});

// `contextPackSkeleton` and `summaries` are large evidence carriers that compact output
// normally omits (A2/A3): state-backed context exposes them through contextManifestPath
// instead. They are inlined ONLY where there is no manifest path to read them from --
// no-state context (no state dir) for the skeleton, and partitioned crosscutting context
// (which returns no contextManifestPath) for the per-unit summaries. This invariant locks
// each to that single row so a future edit cannot silently re-inline them into the
// manifest-backed context rows the token optimization was built to keep small.
test('SCOPE-IN-001 contextPackSkeleton and summaries are compact-allowlisted for their no-manifest rows ONLY', () => {
  const expectedRowsByField = {
    contextPackSkeleton: ['no-state:context'],
    summaries: ['partitioned:context']
  };
  for (const [field, expectedRows] of Object.entries(expectedRowsByField)) {
    const rowsWithField = COMPACT_ALLOWLIST_MATRIX
      .filter((row) => row.fields.includes(field))
      .map((row) => `${row.scope}:${row.command}`);
    assert.deepEqual(
      rowsWithField,
      expectedRows,
      `${field} must appear in exactly ${expectedRows.join(', ')}, not ${rowsWithField.join(', ') || 'none'}`
    );
  }
});

// This file keeps an independent spec copy of the field-purpose classification and the
// compact allowlist matrix so reviewers must look at both sides when either changes.
// These parity assertions anchor that copy to the production source of truth in
// lib/workflow/index.js: if production drifts from the spec (or vice versa), the diff is
// forced into this file instead of passing silently against a stale local copy.
test('SCOPE-IN-001 test field-purpose spec matches the production source of truth', () => {
  assert.deepEqual(
    FULL_OUTPUT_FIELD_PURPOSES,
    PRODUCTION_FIELD_PURPOSES,
    'test FULL_OUTPUT_FIELD_PURPOSES drifted from lib/workflow/index.js — sync both sides intentionally'
  );
});

test('SCOPE-IN-001 test compact allowlist matrix matches the production source of truth', () => {
  assert.deepEqual(
    COMPACT_ALLOWLIST_MATRIX,
    PRODUCTION_COMPACT_ALLOWLIST_MATRIX,
    'test COMPACT_ALLOWLIST_MATRIX drifted from lib/workflow/index.js — sync both sides intentionally'
  );
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

test('SCOPE-IN-001 compact no-state context keeps inline skeleton continuation data', () => {
  const noStateContext = {
    ok: true,
    status: 'context',
    targetStateDir: null,
    documentType: 'SPEC',
    requestedMode: 'read-only',
    mode: 'read-only',
    guardMode: 'snapshot',
    strictness: 'normal',
    requestedAssurance: 'advisory',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    runtimeCheck: { stdinHandoff: { status: 'ready' } },
    contextManifestPath: null,
    contextPackSkeleton: {
      target: 'docs/spec.md',
      references: [{ path: 'docs/ref.md', readOnly: true }],
      requiredOutputSchema: 'reviewer-pass-fail'
    },
    reviewGuard: 'review-guard-token'
  };
  const compact = JSON.parse(formatWorkflowJson(noStateContext, { mode: 'compact', subcommand: 'context' }));

  assert.deepEqual(compact.contextPackSkeleton, noStateContext.contextPackSkeleton);
  assert.equal(compact.reviewGuard, 'review-guard-token');
  assert.equal(compact.contextManifestPath, undefined);
  assert.equal(compact.runtimeCheck, undefined);
});

test('SCOPE-IN-001 compact partitioned context keeps unit and crosscutting evidence carriers', () => {
  const unitContext = {
    ok: true,
    status: 'unit-context',
    targetStateDir: '/tmp/drfx/state',
    targetKey: 'project',
    manifestPath: '/tmp/drfx/state/MANIFEST.md',
    ledgerPath: '/tmp/drfx/state/ledger.json',
    round: 1,
    documentType: 'none',
    strictness: 'normal',
    requestedMode: 'review-and-fix',
    mode: 'review-and-fix',
    guardMode: 'snapshot',
    requestedAssurance: 'practical',
    assurance: 'practical',
    runtimePlatform: 'codex',
    runtimeCheck: { subagentProbe: { status: 'ready' } },
    reviewMode: 'partitioned',
    unitId: 'unit-001',
    contextManifestPath: '/tmp/drfx/state/context/unit-001.md',
    contextPackSkeleton: { body: 'manifest-backed body omitted from compact stdout' }
  };
  const compactUnit = JSON.parse(formatWorkflowJson(unitContext, { mode: 'compact', subcommand: 'context' }));

  assert.equal(compactUnit.reviewMode, 'partitioned');
  assert.equal(compactUnit.unitId, 'unit-001');
  assert.equal(compactUnit.contextManifestPath, '/tmp/drfx/state/context/unit-001.md');
  assert.equal(compactUnit.contextPackSkeleton, undefined);

  const crosscuttingContext = {
    ...unitContext,
    status: 'crosscutting-context',
    unitId: null,
    contextManifestPath: null,
    backstop: 'security-redaction',
    summaries: [{ unit_id: 'unit-001', reviewed: true }]
  };
  const compactCrosscutting = JSON.parse(formatWorkflowJson(crosscuttingContext, { mode: 'compact', subcommand: 'context' }));

  assert.equal(compactCrosscutting.reviewMode, 'partitioned');
  assert.equal(compactCrosscutting.backstop, 'security-redaction');
  assert.deepEqual(compactCrosscutting.summaries, [{ unit_id: 'unit-001', reviewed: true }]);
  assert.equal(compactCrosscutting.contextPackSkeleton, undefined);
});

test('SCOPE-IN-003 compact context output stays within the full-output byte ratio budget', async (t) => {
  const fixture = freshRouteFixture(t);
  const args = routeArgs({ jsonMode: 'bare', root: fixture.root, target: fixture.target });
  const start = await runWorkflowCommand('start', args, { cwd: fixture.root });
  assert.equal(start.ok, true, JSON.stringify(start));
  const contextResult = await runWorkflowCommand('context', args, { cwd: fixture.root });
  assert.equal(contextResult.ok, true, JSON.stringify(contextResult));

  assertCompactByteRatio(
    'persistent context',
    formatWorkflowJson(contextResult, { mode: 'full', subcommand: 'context' }),
    formatWorkflowJson(contextResult, { mode: 'compact', subcommand: 'context' }),
    0.72
  );
});

test('SCOPE-IN-001 compact no-state partitioned context keeps partition plan fields', () => {
  const partitionedContext = {
    ok: true,
    status: 'partitioned-review',
    targetStateDir: null,
    documentType: 'none',
    requestedMode: 'read-only',
    mode: 'read-only',
    guardMode: 'snapshot',
    strictness: 'normal',
    requestedAssurance: 'practical',
    assurance: 'practical',
    runtimePlatform: 'codex',
    runtimeCheck: { subagentProbe: { status: 'ready' } },
    contextManifestPath: '/tmp/drfx/context.json',
    contextPackSkeleton: { body: 'debug-only context body' },
    userExcludes: ['dist'],
    reviewMode: 'partitioned',
    unitCount: 2,
    unitByteBudget: 128000,
    units: [{ unit_id: 'unit-001' }, { unit_id: 'unit-002' }],
    crosscuttingBackstops: ['security-redaction'],
    projectReviewFingerprint: 'project-fingerprint'
  };
  const compact = JSON.parse(formatWorkflowJson(partitionedContext, { mode: 'compact', subcommand: 'context' }));

  assert.equal(compact.reviewMode, 'partitioned');
  assert.equal(compact.unitCount, 2);
  assert.equal(compact.unitByteBudget, 128000);
  assert.deepEqual(compact.units, [{ unit_id: 'unit-001' }, { unit_id: 'unit-002' }]);
  assert.deepEqual(compact.crosscuttingBackstops, ['security-redaction']);
  assert.equal(compact.projectReviewFingerprint, 'project-fingerprint');
  assert.equal(compact.userExcludes, undefined);
  assert.equal(compact.runtimeCheck, undefined);
  assert.equal(compact.contextPackSkeleton, undefined);
});

test('SCOPE-IN-001 compact finalize prefers PASS summary over stale round receipts', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-final-pass-artifact-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateDir, 'rounds'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'rounds', '001-fix-blocked.md'), '# stale fix blocker\n');
  const summaryPath = path.join(stateDir, 'SUMMARY.md');
  fs.writeFileSync(summaryPath, '# Final summary\n');

  const compact = JSON.parse(formatWorkflowJson({
    ok: true,
    status: 'pass',
    targetStateDir: stateDir,
    finalResponse: { finalStatus: 'pass' },
    fixedIssueIds: ['ISSUE-001']
  }, { mode: 'compact', subcommand: 'finalize' }));

  assert.equal(compact.receiptPath, summaryPath);
});

test('SCOPE-IN-001 compact finalize prefers matching final receipt over stale later-sorting receipts', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-final-receipt-artifact-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateDir, 'rounds'), { recursive: true });
  const finalReceiptPath = path.join(stateDir, 'rounds', '001-final-blocked.md');
  fs.writeFileSync(finalReceiptPath, '# final blocker\n');
  fs.writeFileSync(path.join(stateDir, 'rounds', '001-fix-applied.md'), '# stale fix receipt\n');
  fs.writeFileSync(path.join(stateDir, 'SUMMARY.md'), '# Final summary\n');

  const compact = JSON.parse(formatWorkflowJson({
    ok: false,
    status: 'blocked',
    targetStateDir: stateDir,
    finalResponse: { finalStatus: 'blocked' }
  }, { mode: 'compact', subcommand: 'finalize' }));

  assert.equal(compact.receiptPath, finalReceiptPath);
});

test('SCOPE-IN-001 compact finalize ignores stale gate-drift receipt for validation blockers', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-final-validation-artifact-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateDir, 'rounds'), { recursive: true });
  const finalReceiptPath = path.join(stateDir, 'rounds', '001-final-validation-failed.md');
  fs.writeFileSync(finalReceiptPath, '# final validation blocker\n');
  fs.writeFileSync(path.join(stateDir, 'rounds', '001-gate-drift.md'), '# stale gate drift\n');

  const compact = JSON.parse(formatWorkflowJson({
    ok: false,
    status: 'blocked',
    targetStateDir: stateDir,
    blockingReason: 'final-validation-failed'
  }, { mode: 'compact', subcommand: 'finalize' }));

  assert.equal(compact.receiptPath, finalReceiptPath);
});

test('SCOPE-IN-001 compact finalize keeps gate-drift receipt for gate blockers', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-final-gate-drift-artifact-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateDir, 'rounds'), { recursive: true });
  const gateReceiptPath = path.join(stateDir, 'rounds', '001-gate-drift.md');
  fs.writeFileSync(path.join(stateDir, 'rounds', '001-final-blocked.md'), '# stale final blocker\n');
  fs.writeFileSync(gateReceiptPath, '# gate drift blocker\n');

  const compact = JSON.parse(formatWorkflowJson({
    ok: false,
    status: 'blocked',
    targetStateDir: stateDir,
    blockingReason: 'unexpected-worktree-change',
    nextAction: 'restore the run.md gate to its reviewed state before retrying finalize'
  }, { mode: 'compact', subcommand: 'finalize' }));

  assert.equal(compact.receiptPath, gateReceiptPath);
});

test('SCOPE-IN-001 compact partitioned end-fix keeps the partitioned lifecycle marker', () => {
  const compact = JSON.parse(formatWorkflowJson({
    ok: true,
    status: 'end-fix',
    targetStateDir: '/tmp/drfx/state',
    documentType: 'none',
    reviewMode: 'partitioned',
    fixReportPath: '/tmp/drfx/state/rounds/001-fix.md',
    fixedIssueIds: ['ISSUE-001']
  }, { mode: 'compact', subcommand: 'end-fix' }));

  assert.equal(compact.reviewMode, 'partitioned');
  assert.equal(compact.fixReportPath, '/tmp/drfx/state/rounds/001-fix.md');
  assert.deepEqual(compact.fixedIssueIds, ['ISSUE-001']);
});

test('SCOPE-IN-001 compact partitioned aggregate keeps continuation routing signals', () => {
  const compact = JSON.parse(formatWorkflowJson({
    ok: true,
    status: 'aggregated-review',
    targetStateDir: '/tmp/drfx/state',
    documentType: 'none',
    reviewMode: 'partitioned',
    verdict: 'stopped-with-deferrals',
    reason: 'coverage-incomplete',
    reviewerReportPath: '/tmp/drfx/state/reports/aggregate-review-round-001.md',
    aggregatePath: '/tmp/drfx/state/project-review/aggregate.json',
    uncoveredUnitIds: ['unit-002'],
    uncoveredBackstops: ['security-redaction'],
    coverageProof: { residualRisk: 'present' }
  }, { mode: 'compact', subcommand: 'aggregate-review' }));

  assert.equal(compact.verdict, 'stopped-with-deferrals');
  assert.equal(compact.reason, 'coverage-incomplete');
  assert.equal(compact.reviewerReportPath, '/tmp/drfx/state/reports/aggregate-review-round-001.md');
  assert.equal(compact.aggregatePath, '/tmp/drfx/state/project-review/aggregate.json');
  assert.deepEqual(compact.uncoveredUnitIds, ['unit-002']);
  assert.deepEqual(compact.uncoveredBackstops, ['security-redaction']);
  assert.equal(compact.coverageProof, undefined);
});

test('SCOPE-IN-004 compact partitioned context output stays within the full-output byte ratio budget', () => {
  const partitionedContext = {
    ok: true,
    status: 'partitioned-review',
    targetStateDir: '/tmp/drfx/state',
    targetKey: 'project',
    manifestPath: '/tmp/drfx/state/MANIFEST.md',
    ledgerPath: '/tmp/drfx/state/ledger.json',
    round: 1,
    documentType: 'none',
    strictness: 'normal',
    requestedMode: 'review-and-fix',
    mode: 'review-and-fix',
    guardMode: 'snapshot',
    requestedAssurance: 'practical',
    assurance: 'practical',
    runtimePlatform: 'codex',
    runtimeCheck: { subagentProbe: { status: 'ready' }, stdinHandoff: { status: 'ready' } },
    contextManifestPath: '/tmp/drfx/state/context.json',
    contextPackSkeleton: {
      targetContext: 'partitioned',
      body: 'debug-only context body '.repeat(300)
    },
    userExcludes: ['dist', 'coverage'],
    reviewMode: 'partitioned',
    unitCount: 12,
    unitByteBudget: 128000,
    units: Array.from({ length: 12 }, (_, index) => ({
      unit_id: `unit-${String(index + 1).padStart(3, '0')}`,
      members: [`src/file-${index + 1}.js`]
    })),
    crosscuttingBackstops: ['security-redaction', 'state-machine'],
    projectReviewFingerprint: 'project-fingerprint'
  };

  assertCompactByteRatio(
    'partitioned context',
    formatWorkflowJson(partitionedContext, { mode: 'full', subcommand: 'context' }),
    formatWorkflowJson(partitionedContext, { mode: 'compact', subcommand: 'context' }),
    0.35
  );
});

test('SCOPE-IN-001 compact formatter fails closed without workflow subcommand', () => {
  assert.throws(
    () => formatWorkflowJson({
      ok: true,
      status: 'started',
      runtimeCheck: { subagentProbe: { status: 'ready' } },
      contextPackSkeleton: { body: 'debug-only context body' }
    }, { mode: 'compact' }),
    { code: 'ERR_WORKFLOW_JSON_COMPACT' }
  );
});

test('SCOPE-IN-001 compact generated-route continuation keeps next-step artifact paths', async (t) => {
  const sequence = await runGeneratedRouteContinuationSmoke(t, { jsonMode: 'compact' });
  assertCompactResponseFields('start', sequence.start, {
    scope: 'state',
    command: 'start',
    requiredFields: ['targetStateDir', 'targetKey']
  });
  assertCompactResponseFields('context', sequence.context, {
    scope: 'state',
    command: 'context',
    requiredFields: ['targetStateDir', 'contextManifestPath']
  });
  assertCompactResponseFields('record-review', sequence.recordReview, {
    scope: 'state',
    command: 'record-review',
    requiredFields: ['targetStateDir', 'reviewerReportPath']
  });
  assertCompactResponseFields('record-triage', sequence.recordTriage, {
    scope: 'state',
    command: 'record-triage',
    requiredFields: ['targetStateDir', 'ledgerPath']
  });
  assertCompactResponseFields('begin-fix', sequence.beginFix, {
    scope: 'fix-lifecycle',
    command: 'begin-fix',
    requiredFields: [
      'targetStateDir',
      'lockOwnerId',
      'leaseId',
      'leaseExpiresAt',
      'fixGuardReportPath'
    ]
  });
  assertCompactResponseFields('end-fix', sequence.endFix, {
    scope: 'fix-lifecycle',
    command: 'end-fix',
    requiredFields: ['targetStateDir', 'fixReportPath', 'fixedIssueIds']
  });
  assertCompactResponseFields('record-diff-review', sequence.recordDiffReview, {
    scope: 'fix-lifecycle',
    command: 'record-diff-review',
    requiredFields: ['targetStateDir', 'diffReviewReportPath']
  });
  assertCompactResponseFields('full-re-review context', sequence.fullReviewContext, {
    scope: 'state',
    command: 'context',
    requiredFields: ['targetStateDir', 'contextManifestPath']
  });
  assertCompactResponseFields('full-re-review record-review', sequence.fullReviewRecordReview, {
    scope: 'state',
    command: 'record-review',
    requiredFields: ['targetStateDir', 'reviewerReportPath']
  });
  assertCompactResponseFields('finalize', sequence.finalize, {
    scope: 'fix-lifecycle',
    command: 'finalize',
    requiredFields: ['targetStateDir', 'finalResponse', 'receiptPath']
  });
});
