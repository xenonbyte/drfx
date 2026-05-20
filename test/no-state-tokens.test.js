'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  encodeCanonical,
  decodeCanonical,
  createReviewGuard,
  validateReviewGuard,
  createPreflightToken,
  validateStateToken,
  nextStateToken
} = require('../lib/no-state');
const { deriveTargetKey } = require('../lib/target-state');
const { parseWorkflowArgs, runWorkflowCommand } = require('../lib/workflow');

const ROOT = path.join(__dirname, '..');

function readOnlyCleanBlock(target = 'README.md') {
  return [
    'Final status: read-only-clean',
    'Assurance: advisory',
    'Runtime platform: manual',
    'Mode: read-only',
    `Target: ${target}`,
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: node --test test/no-state-tokens.test.js',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: none identified',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');
}

test('canonical encoding rejects padding standard base64 and unknown fields', () => {
  const encoded = encodeCanonical({ b: 'two', a: 1 });
  assert.equal(encoded, encodeCanonical({ a: 1, b: 'two' }));
  assert.doesNotMatch(encoded, /=/);
  assert.doesNotMatch(encoded, /[+/]/);
  assert.deepEqual(decodeCanonical(encoded, { allowedFields: ['a', 'b'] }), { a: 1, b: 'two' });
  assert.throws(() => decodeCanonical(`${encoded}=`, { allowedFields: ['a', 'b'] }), /canonical|padding/i);
  assert.throws(() => decodeCanonical(`${encoded}+`, { allowedFields: ['a', 'b'] }), /base64url|standard|canonical/i);
  assert.throws(() => decodeCanonical(encoded, { allowedFields: ['a'] }), /unknown field/i);
});

test('preflight token supports only matching terminal status', () => {
  const token = createPreflightToken({
    targetKey: 'spec-md-aaaaaaaaaaaa',
    normalizedTarget: 'docs/spec.md',
    references: [],
    strictness: 'normal',
    requestedMode: 'review-and-fix',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'gemini',
    runtimeDowngradeReason: 'none',
    terminalStatus: 'unsupported',
    blockingReason: 'none',
    statusReason: 'unsupported-runtime-capability'
  });
  const decoded = validateStateToken(token, { allowedKinds: ['preflight-terminal'] });
  assert.equal(decoded.tokenKind, 'preflight-terminal');
  assert.deepEqual(decoded.eligibleTerminalStatuses, ['unsupported']);
  assert.equal(decoded.contentPolicy, 'redacted-normalized-state-only');
  assert.equal(Object.hasOwn(decoded, 'reviewGuard'), false);
  assert.equal(Object.hasOwn(decoded, 'rawBody'), false);
});

test('state token lineage uses previous canonical bytes sha256', () => {
  const first = nextStateToken({
    previousToken: null,
    tokenKind: 'review-result',
    targetKey: 'spec-md-aaaaaaaaaaaa',
    normalizedTarget: 'docs/spec.md',
    references: [],
    phase: 'initial-review',
    round: 1,
    strictness: 'normal',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    guardId: 'guard-1',
    eligibleTerminalStatuses: ['read-only-clean'],
    normalized: { result: 'PASS', blockingFindings: [] },
    targetFingerprint: { sha256: 'a'.repeat(64), size: 10, mtimeMs: 1 },
    referenceFingerprints: []
  });
  const second = nextStateToken({
    previousToken: first,
    tokenKind: 'triage-result',
    targetKey: 'spec-md-aaaaaaaaaaaa',
    normalizedTarget: 'docs/spec.md',
    references: [],
    phase: 'initial-review',
    round: 1,
    strictness: 'normal',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    guardId: 'guard-1',
    eligibleTerminalStatuses: ['read-only-clean'],
    normalized: { decisions: [], blockingFindings: [] },
    targetFingerprint: { sha256: 'a'.repeat(64), size: 10, mtimeMs: 1 },
    referenceFingerprints: []
  });
  assert.notEqual(validateStateToken(second).previousTokenSha256, 'none');
  assert.doesNotThrow(() => validateStateToken(second, { previousToken: first }));
});

test('review guard rejects padding wrong target unknown fields and fingerprint mismatch', () => {
  const guard = createReviewGuard({
    guardId: 'guard-1',
    phase: 'initial-review',
    round: 1,
    normalizedTarget: 'docs/spec.md',
    references: [],
    targetFingerprint: { sha256: 'a'.repeat(64), size: 10, mtimeMs: 1 },
    referenceFingerprints: [],
    strictness: 'normal',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual'
  });
  const expected = {
    phase: 'initial-review',
    round: 1,
    normalizedTarget: 'docs/spec.md',
    references: [],
    targetFingerprint: { sha256: 'a'.repeat(64), size: 10, mtimeMs: 1 },
    referenceFingerprints: [],
    strictness: 'normal',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual'
  };
  assert.throws(() => validateReviewGuard(`${guard}=`, expected), /padding|canonical/i);
  assert.throws(() => validateReviewGuard(guard, { ...expected, normalizedTarget: 'docs/other.md' }), /target/i);
  assert.throws(
    () => validateReviewGuard(guard, { ...expected, targetFingerprint: { sha256: 'b'.repeat(64), size: 10, mtimeMs: 1 } }),
    /fingerprint|reviewer-mutated-file/i
  );
  const decoded = decodeCanonical(guard);
  const withUnknown = encodeCanonical({ ...decoded, rawPrompt: 'must not be accepted' });
  assert.throws(() => validateReviewGuard(withUnknown, expected), /unknown field/i);
});

test('state token rejects wrong kind wrong target wrong lineage stale and oversized values', () => {
  const first = nextStateToken({
    previousToken: null,
    tokenKind: 'review-result',
    targetKey: 'spec-md-aaaaaaaaaaaa',
    normalizedTarget: 'docs/spec.md',
    references: [],
    phase: 'initial-review',
    round: 1,
    strictness: 'normal',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    guardId: 'guard-1',
    eligibleTerminalStatuses: ['read-only-clean'],
    normalized: { result: 'PASS', blockingFindings: [] },
    targetFingerprint: { sha256: 'a'.repeat(64), size: 10, mtimeMs: 1 },
    referenceFingerprints: []
  });
  const other = nextStateToken({
    previousToken: null,
    tokenKind: 'review-result',
    targetKey: 'other-md-bbbbbbbbbbbb',
    normalizedTarget: 'docs/other.md',
    references: [],
    phase: 'initial-review',
    round: 1,
    strictness: 'normal',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    guardId: 'guard-2',
    eligibleTerminalStatuses: ['read-only-clean'],
    normalized: { result: 'PASS', blockingFindings: [] },
    targetFingerprint: { sha256: 'b'.repeat(64), size: 10, mtimeMs: 1 },
    referenceFingerprints: []
  });
  const second = nextStateToken({
    previousToken: first,
    tokenKind: 'triage-result',
    targetKey: 'spec-md-aaaaaaaaaaaa',
    normalizedTarget: 'docs/spec.md',
    references: [],
    phase: 'initial-review',
    round: 1,
    strictness: 'normal',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    guardId: 'guard-1',
    eligibleTerminalStatuses: ['read-only-clean'],
    normalized: { decisions: [], blockingFindings: [] },
    targetFingerprint: { sha256: 'a'.repeat(64), size: 10, mtimeMs: 1 },
    referenceFingerprints: []
  });
  assert.throws(() => validateStateToken(first, { allowedKinds: ['triage-result'] }), /kind/i);
  assert.throws(() => validateStateToken(first, { normalizedTarget: 'docs/other.md' }), /target/i);
  assert.throws(() => validateStateToken(second, { previousToken: other }), /lineage/i);
  assert.throws(() => validateStateToken(first, { now: new Date('2030-01-01T00:00:00.000Z'), maxAgeMs: 1 }), /stale/i);
  assert.throws(
    () => nextStateToken({
      previousToken: null,
      tokenKind: 'review-result',
      targetKey: 'spec-md-aaaaaaaaaaaa',
      normalizedTarget: 'docs/spec.md',
      references: [],
      phase: 'initial-review',
      round: 1,
      strictness: 'normal',
      mode: 'read-only',
      assurance: 'advisory',
      runtimePlatform: 'manual',
      guardId: 'guard-1',
      eligibleTerminalStatuses: ['read-only-findings'],
      normalized: { summary: 'x'.repeat(40000), blockingFindings: [] },
      targetFingerprint: { sha256: 'a'.repeat(64), size: 10, mtimeMs: 1 },
      referenceFingerprints: []
    }),
    /state-token-too-large|32768/i
  );
});

test('workflow context no-state returns review guard for real tracked target', async () => {
  const result = await runWorkflowCommand('context', [
    '--no-state',
    'review-fix-doc',
    'target=README.md',
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'ready',
    '--phase',
    'initial-review',
    '--json'
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.targetStateDir, null);
  assert.equal(typeof result.reviewGuard, 'string');
  const guard = decodeCanonical(result.reviewGuard);
  assert.equal(Number.isInteger(guard.targetFingerprint.mtimeMs), true);
});

test('malformed hand-built state token missing required fields is rejected by helper and workflow finalize', async () => {
  const targetKey = deriveTargetKey(ROOT, path.join(ROOT, 'README.md')).targetKey;
  const malformed = encodeCanonical({
    tokenVersion: 1,
    tokenKind: 'review-result',
    contentPolicy: 'redacted-normalized-state-only',
    eligibleTerminalStatuses: ['read-only-clean'],
    targetKey,
    normalizedTarget: 'README.md',
    references: [],
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    normalized: { result: 'PASS', blockingFindings: [] }
  });

  assert.throws(() => validateStateToken(malformed), /missing|required|previousTokenSha256|phase|round|guardId/i);

  await assert.rejects(
    () => runWorkflowCommand('finalize', [
      '--no-state',
      'review-fix-doc',
      'target=README.md',
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
      malformed,
      '--final-response-stdin',
      '--json'
    ], { stdin: readOnlyCleanBlock() }),
    /missing|required|previousTokenSha256|phase|round|guardId/i
  );
});

test('oversized no-state preflight token output maps to state-token-too-large blocker', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-no-state-large-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.md');
  fs.writeFileSync(target, '# Target\n');
  const args = [
    '--no-state',
    'review-fix-doc',
    `root=${root}`,
    `target=${target}`,
    'review-and-fix',
    '--terminal-status',
    'unsupported',
    '--status-reason',
    'unsupported-runtime-capability',
    '--blocking-reason',
    'none',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'gemini',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--json'
  ];
  for (let index = 0; index < 420; index += 1) {
    const name = `reference-${String(index).padStart(3, '0')}-${'x'.repeat(80)}.md`;
    const reference = path.join(root, name);
    fs.writeFileSync(reference, '# Reference\n');
    args.splice(4, 0, `ref=${reference}`);
  }

  const result = await runWorkflowCommand('preflight', args);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-token-too-large');
  assert.equal(result.stateToken, undefined);
  assert.match(result.nextAction, /ledger=|persistent/i);
});

test('workflow preflight rejects observable semantic inputs', () => {
  assert.throws(
    () => parseWorkflowArgs('preflight', [
      '--no-state',
      'review-fix-design',
      'target=design/DESIGN-v2.md',
      'review-and-fix',
      '--terminal-status',
      'unsupported',
      '--status-reason',
      'unsupported-runtime-capability',
      '--blocking-reason',
      'none',
      '--assurance',
      'advisory',
      '--runtime-platform',
      'gemini',
      '--runtime-subagent-probe',
      'not-required',
      '--runtime-stdin-handoff',
      'not-required',
      '--final-response-stdin'
    ]),
    /semantic|final-response/i
  );
});

test('no-state commands reject strict verified resume ledger full re-review and fix', () => {
  assert.throws(
    () => parseWorkflowArgs('context', [
      '--no-state',
      'review-fix-design',
      'target=design/DESIGN-v2.md',
      'read-only',
      '--assurance',
      'strict-verified',
      '--runtime-platform',
      'manual',
      '--runtime-subagent-probe',
      'not-required',
      '--runtime-stdin-handoff',
      'ready',
      '--phase',
      'initial-review'
    ]),
    /strict-verified/i
  );
  assert.throws(
    () => parseWorkflowArgs('context', [
      '--no-state',
      'review-fix-design',
      'target=design/DESIGN-v2.md',
      'read-only',
      'resume',
      'ledger=custom/ISSUES.md',
      '--assurance',
      'advisory',
      '--runtime-platform',
      'manual',
      '--runtime-subagent-probe',
      'not-required',
      '--runtime-stdin-handoff',
      'ready',
      '--phase',
      'full-re-review'
    ]),
    /resume|ledger|full-re-review/i
  );
  assert.throws(
    () => parseWorkflowArgs('context', [
      '--no-state',
      'review-fix-design',
      'target=design/DESIGN-v2.md',
      'review-and-fix',
      '--assurance',
      'advisory',
      '--runtime-platform',
      'manual',
      '--runtime-subagent-probe',
      'not-required',
      '--runtime-stdin-handoff',
      'ready',
      '--phase',
      'fix'
    ]),
    /fix|no-state/i
  );
});

test('no-state finalizer rejects pass and validates clean versus findings', async () => {
  const targetKey = deriveTargetKey(ROOT, path.join(ROOT, 'README.md')).targetKey;
  const token = nextStateToken({
    previousToken: null,
    tokenKind: 'review-result',
    targetKey,
    normalizedTarget: 'README.md',
    references: [],
    phase: 'initial-review',
    round: 1,
    strictness: 'normal',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    guardId: 'guard-1',
    eligibleTerminalStatuses: ['read-only-clean'],
    normalized: { result: 'PASS', blockingFindings: [] },
    targetFingerprint: { sha256: 'a'.repeat(64), size: 10, mtimeMs: 1 },
    referenceFingerprints: []
  });
  const passBlock = [
    'Final status: pass',
    'Assurance: advisory',
    'Runtime platform: manual',
    'Mode: read-only',
    'Target: README.md',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: node --test test/no-state-tokens.test.js',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: none identified',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: approved'
  ].join('\n');
  const pass = await runWorkflowCommand('finalize', [
    '--no-state',
    'review-fix-doc',
    'target=README.md',
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
    token,
    '--final-response-stdin',
    '--json'
  ], { stdin: passBlock });
  assert.equal(pass.ok, false);
  assert.match(pass.errorCode || pass.blockingReason, /no-state-pass-unsupported|final-validation/i);

  const findingsBlock = passBlock
    .replace('Final status: pass', 'Final status: read-only-findings')
    .replace('Coordinator agreement: approved', 'Coordinator agreement: none');
  const findings = await runWorkflowCommand('finalize', [
    '--no-state',
    'review-fix-doc',
    'target=README.md',
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
    token,
    '--final-response-stdin',
    '--json'
  ], { stdin: findingsBlock });
  assert.equal(findings.ok, false);
  assert.match(findings.errorCode || findings.statusReason, /read-only-findings|final-validation/i);
});
