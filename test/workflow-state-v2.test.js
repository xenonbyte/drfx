'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  formatManifestV2,
  parseManifestV2,
  atomicWriteFile,
  writeReceiptOrBlock,
  workflowJson,
  STATUS_REASONS: STATUS_REASONS_COPY1
} = require('../lib/workflow-state');
const { STATUS_REASONS: STATUS_REASONS_COPY2 } = require('../lib/semantic-parsers');
const { shouldCreatePersistentState } = require('../lib/target-state');
const { shouldWriteRoundReceipt } = require('../lib/receipts');

function makeManifest(overrides = {}) {
  return {
    manifestSchema: 2,
    target: 'docs/spec.md',
    normalizedTarget: 'docs/spec.md',
    documentType: 'SPEC',
    strictness: 'normal',
    mode: 'review-and-fix',
    guardMode: 'git',
    targetKey: 'spec-md-aaaaaaaaaaaa',
    ledgerPath: '.drfx/targets/spec-md-aaaaaaaaaaaa/ISSUES.md',
    status: 'review',
    currentPhase: 'review',
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

test('formats and parses schema-2 manifest with required runtime fields', () => {
  const manifest = makeManifest();
  const text = formatManifestV2(manifest);
  const parsed = parseManifestV2(text);

  assert.equal(parsed.manifestSchema, 2);
  assert.equal(parsed.status, 'review');
  assert.equal(parsed.currentPhase, 'review');
  assert.equal(parsed.guardMode, 'git');
  assert.equal(parsed.assurance, 'practical');
  assert.equal(parsed.runtimePlatform, 'codex');
  assert.equal(parsed.runtimeSubagentProbeEvidence, 'route-asserted-ready');
  assert.equal(formatManifestV2(parsed), text);
});

test('schema-2 manifest rejects illegal blocked reason pairing', () => {
  assert.throws(
    () => formatManifestV2(makeManifest({ status: 'blocked', blockingReason: 'none', statusReason: 'none' })),
    /blocking reason/i
  );
  assert.throws(
    () => formatManifestV2(makeManifest({
      status: 'blocked',
      currentPhase: 'review',
      blockingReason: 'state-validation-failed',
      statusReason: 'strict-proof-validation-failed'
    })),
    /status reason/i
  );
});

test('schema-2 manifest rejects duplicates, missing fields, unknown enums, and illegal phases', () => {
  const validText = formatManifestV2(makeManifest());
  assert.throws(
    () => parseManifestV2(`${validText}Status: review\n`),
    /duplicate/i
  );
  assert.throws(
    () => parseManifestV2(validText.replace('Status: review\n', '')),
    /missing field/i
  );
  assert.throws(
    () => parseManifestV2(validText.replace('Runtime platform: codex', 'Runtime platform: browser')),
    /unknown enum/i
  );
  assert.throws(
    () => parseManifestV2(validText.replace('Guard mode: git', 'Guard mode: unknown')),
    /guard mode/i
  );
  assert.throws(
    () => formatManifestV2(makeManifest({ status: 'fix', currentPhase: 'review' })),
    /current phase/i
  );
  assert.throws(
    () => formatManifestV2(makeManifest({ status: 'pass', currentPhase: 'review' })),
    /current phase/i
  );
});

test('schema-2 manifest defaults missing legacy guard mode to git', () => {
  const text = formatManifestV2(makeManifest()).replace('Guard mode: git\n', '');
  const parsed = parseManifestV2(text);
  assert.equal(parsed.guardMode, 'git');
  assert.match(formatManifestV2(parsed), /Guard mode: git/);
});

test('schema-2 manifest rejects illegal mode and assurance combinations', () => {
  assert.throws(
    () => formatManifestV2(makeManifest({ mode: 'review-and-fix', assurance: 'advisory' })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /advisory.*review-and-fix/i.test(error.message)
  );
  assert.throws(
    () => formatManifestV2(makeManifest({
      status: 'pass',
      currentPhase: 'final',
      mode: 'read-only',
      assurance: 'practical'
    })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /pass.*review-and-fix/i.test(error.message)
  );
  assert.throws(
    () => formatManifestV2(makeManifest({
      status: 'pass',
      currentPhase: 'final',
      mode: 'review-and-fix',
      assurance: 'advisory'
    })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /pass.*assurance/i.test(error.message)
  );
});

test('schema-2 manifest rejects illegal assurance proof combinations', () => {
  assert.throws(
    () => formatManifestV2(makeManifest({
      assurance: 'strict-verified',
      descriptorPlatform: 'codex',
      assuranceProof: 'none'
    })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /strict-verified.*Assurance proof/i.test(error.message)
  );
  assert.throws(
    () => formatManifestV2(makeManifest({
      assurance: 'practical',
      descriptorPlatform: 'none',
      assuranceProof: 'capability-descriptor:codex:run-123'
    })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /practical.*Assurance proof: none/i.test(error.message)
  );
  assert.throws(
    () => formatManifestV2(makeManifest({
      assurance: 'advisory',
      mode: 'read-only',
      descriptorPlatform: 'codex',
      assuranceProof: 'none'
    })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /advisory.*Descriptor platform: none/i.test(error.message)
  );
  assert.throws(
    () => parseManifestV2(formatManifestV2(makeManifest()).replace('Descriptor platform: none', 'Descriptor platform: codex')),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /practical.*Descriptor platform: none/i.test(error.message)
  );
});

test('schema-2 manifest accepts a strict-verified opencode capability descriptor', () => {
  // Regression: descriptorPlatformFor('opencode') === 'opencode', so a strict-verified
  // opencode run writes Descriptor platform: opencode. DESCRIPTOR_PLATFORMS must allow it,
  // or every opencode strict-verified workflow fails state validation.
  const manifest = makeManifest({
    assurance: 'strict-verified',
    runtimePlatform: 'opencode',
    descriptorPlatform: 'opencode',
    assuranceProof: 'capability-descriptor:opencode:run-123'
  });
  const parsed = parseManifestV2(formatManifestV2(manifest));
  assert.equal(parsed.descriptorPlatform, 'opencode');
  assert.equal(parsed.runtimePlatform, 'opencode');
  assert.equal(parsed.assuranceProof, 'capability-descriptor:opencode:run-123');
});

test('atomicWriteFile does not leave a valid-looking partial file on failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-atomic-'));
  const filePath = path.join(root, 'MANIFEST.md');

  assert.throws(
    () => atomicWriteFile(filePath, '# Review Target Manifest\n', { failBeforeRename: true }),
    /forced atomic write failure/i
  );
  assert.equal(fs.existsSync(filePath), false);
});

test('workflowJson includes stable blocker and reason fields', () => {
  const output = workflowJson({
    ok: true,
    status: 'unsupported',
    targetStateDir: null,
    targetKey: 'spec-md-aaaaaaaaaaaa',
    manifestPath: null,
    ledgerPath: null,
    round: 1,
    documentType: 'SPEC',
    strictness: 'normal',
    requestedMode: 'review-and-fix',
    mode: 'read-only',
    guardMode: 'snapshot',
    modeSource: 'explicit',
    modeNormalizedFrom: 'review-and-fix',
    requestedAssurance: 'strict-verified',
    assuranceSource: 'explicit',
    assuranceNormalizedFrom: 'strict-verified',
    assurance: 'advisory',
    runtimePlatform: 'codex',
    descriptorPlatform: 'codex',
    assuranceProof: 'none',
    strictProofError: 'descriptor-not-verified',
    runtimeCheck: { subagent: 'ready', stdin: 'ready', fingerprintGuard: 'passed' },
    contextManifestPath: null,
    contextPackSkeleton: null,
    reviewGuard: null,
    stateToken: null,
    nextAction: 'rerun without strict-verified or supply current proof',
    blockingReason: 'none',
    statusReason: 'strict-proof-validation-failed'
  });

  assert.equal(output.ok, true);
  assert.equal(output.targetKey, 'spec-md-aaaaaaaaaaaa');
  assert.equal(output.ledgerPath, null);
  assert.equal(output.requestedMode, 'review-and-fix');
  assert.equal(output.mode, 'read-only');
  assert.equal(output.guardMode, 'snapshot');
  assert.equal(output.requestedAssurance, 'strict-verified');
  assert.equal(output.assurance, 'advisory');
  assert.equal(output.descriptorPlatform, 'codex');
  assert.equal(output.assuranceProof, 'none');
  assert.equal(output.strictProofError, 'descriptor-not-verified');
  assert.deepEqual(output.runtimeCheck, { subagent: 'ready', stdin: 'ready', fingerprintGuard: 'passed' });
  assert.equal(Object.hasOwn(output, 'contextPackSkeleton'), true);
  assert.equal(Object.hasOwn(output, 'reviewGuard'), true);
  assert.equal(Object.hasOwn(output, 'stateToken'), true);
  assert.equal(output.blockingReason, 'none');
  assert.equal(output.statusReason, 'strict-proof-validation-failed');
});

test('writeReceiptOrBlock maps receipt write failures to state-validation blocker', () => {
  const result = writeReceiptOrBlock({
    writeReceipt: () => {
      throw new Error('disk full');
    },
    result: {
      ok: false,
      status: 'blocked',
      blockingReason: 'unsafe-handoff-file',
      statusReason: 'none'
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.equal(result.statusReason, 'none');
});

test('fixAttemptCount round-trips through format/parse', () => {
  const text = formatManifestV2(makeManifest({ fixAttemptCount: 3 }));
  assert.match(text, /^Fix attempt count: 3$/m);
  const parsed = parseManifestV2(text);
  assert.equal(parsed.fixAttemptCount, 3);
});

test('parseManifestV2 defaults fixAttemptCount to 0 when the line is absent (back-compat)', () => {
  const legacy = formatManifestV2(makeManifest())
    .split('\n').filter((line) => !line.startsWith('Fix attempt count:')).join('\n');
  const parsed = parseManifestV2(legacy);
  assert.equal(parsed.fixAttemptCount, 0);
});

test('explicit audit trail is enabled only by original ledger token', () => {
  assert.equal(shouldCreatePersistentState({ mode: 'read-only', ledger: null, resume: false, round: 1 }), false);
  assert.equal(shouldCreatePersistentState({ mode: 'read-only', ledger: 'custom/ISSUES.md', resume: false, round: 1 }), true);
  assert.equal(shouldWriteRoundReceipt({ auditTrail: false, round: 1, stopReason: null, phaseCompleted: 'review' }), false);
  assert.equal(shouldWriteRoundReceipt({ auditTrail: true, round: 1, stopReason: null, phaseCompleted: 'review' }), true);
  assert.equal(shouldWriteRoundReceipt({ originalLedgerToken: 'ledger=custom/ISSUES.md', round: 1, stopReason: null, phaseCompleted: 'review' }), true);
  assert.equal(shouldWriteRoundReceipt({ ledgerPath: 'ISSUES.md', round: 1, stopReason: null, phaseCompleted: 'review' }), false);
});

test('stopped-no-progress is a valid manifest status with no-progress-detected reason', () => {
  const text = formatManifestV2(makeManifest({
    status: 'stopped-no-progress',
    currentPhase: 'final',
    statusReason: 'no-progress-detected'
  }));
  const parsed = parseManifestV2(text);
  assert.equal(parsed.status, 'stopped-no-progress');
  assert.equal(parsed.statusReason, 'no-progress-detected');
});

// --- PLAN-TASK-003: targetContextKind schema extension ---

test('document manifests default targetContextKind to document and stay byte-identical', () => {
  const text = formatManifestV2(makeManifest());
  // No new file-set lines leak into a document manifest.
  assert.doesNotMatch(text, /Target context kind:/);
  assert.doesNotMatch(text, /File set fingerprint:/);
  assert.doesNotMatch(text, /Base revision:/);
  assert.doesNotMatch(text, /Round limit:/);

  const parsed = parseManifestV2(text);
  assert.equal(parsed.targetContextKind, 'document');
  assert.equal(formatManifestV2(parsed), text);
});

test('explicit document targetContextKind is accepted and still byte-identical to absent', () => {
  const explicit = formatManifestV2(makeManifest({ targetContextKind: 'document' }));
  const implicit = formatManifestV2(makeManifest());
  assert.equal(explicit, implicit);
});

function makePrManifest(overrides = {}) {
  return makeManifest({
    targetContextKind: 'pr',
    documentType: 'none',
    target: 'none',
    normalizedTarget: 'none',
    base: 'main',
    baseRevision: '1'.repeat(40),
    mergeBase: '2'.repeat(40),
    head: '3'.repeat(40),
    fileSetFingerprint: 'f'.repeat(64),
    roundLimit: '5',
    initialContentSha256: 'none',
    lastKnownContentSha256: 'none',
    lastReviewedContentSha256: 'none',
    lastPassedContentSha256: 'none',
    fileSize: 0,
    ...overrides
  });
}

test('pr-kind manifest formats and parses file-set identity fields', () => {
  const text = formatManifestV2(makePrManifest());
  assert.match(text, /Target context kind: pr/);
  assert.match(text, /Base: main/);
  assert.match(text, /Base revision: 1{40}/);
  assert.match(text, /Merge base: 2{40}/);
  assert.match(text, /Head: 3{40}/);
  assert.match(text, /File set fingerprint: f{64}/);
  assert.match(text, /Round limit: 5/);

  const parsed = parseManifestV2(text);
  assert.equal(parsed.targetContextKind, 'pr');
  assert.equal(parsed.documentType, 'none');
  assert.equal(parsed.base, 'main');
  assert.equal(parsed.baseRevision, '1'.repeat(40));
  assert.equal(parsed.mergeBase, '2'.repeat(40));
  assert.equal(parsed.head, '3'.repeat(40));
  assert.equal(parsed.fileSetFingerprint, 'f'.repeat(64));
  assert.equal(parsed.roundLimit, '5');
  assert.equal(formatManifestV2(parsed), text);
});

test('pr-kind manifest does not emit single-file identity fields', () => {
  const text = formatManifestV2(makePrManifest());
  // The single-file content identity block is replaced by the file-set block.
  assert.doesNotMatch(text, /^Initial content sha256:/m);
  assert.doesNotMatch(text, /^Last known content sha256:/m);
  assert.doesNotMatch(text, /^Last reviewed content sha256:/m);
  assert.doesNotMatch(text, /^Last passed content sha256:/m);
  assert.doesNotMatch(text, /^File size:/m);
  // Document type / Target are common head fields pinned to none for file-set kinds.
  assert.match(text, /^Document type: none$/m);
  assert.match(text, /^Target: none$/m);
  assert.match(text, /^Normalized target: none$/m);
});

test('pr-kind manifest rejects a missing file-set fingerprint', () => {
  assert.throws(
    () => formatManifestV2(makePrManifest({ fileSetFingerprint: undefined })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /file set fingerprint/i.test(error.message)
  );
});

test('pr-kind manifest rejects a non-sha file-set fingerprint', () => {
  assert.throws(
    () => formatManifestV2(makePrManifest({ fileSetFingerprint: 'not-a-hash' })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /file set fingerprint/i.test(error.message)
  );
});

test('pr-kind manifest still enforces route-agnostic status/phase pairing', () => {
  assert.throws(
    () => formatManifestV2(makePrManifest({ status: 'fix', currentPhase: 'review' })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /current phase/i.test(error.message)
  );
});

test('pr-kind manifest still enforces route-agnostic blocked/reason pairing', () => {
  assert.throws(
    () => formatManifestV2(makePrManifest({ status: 'blocked', blockingReason: 'none', statusReason: 'none' })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /blocking reason/i.test(error.message)
  );
});

test('unknown targetContextKind is rejected', () => {
  assert.throws(
    () => formatManifestV2(makeManifest({ targetContextKind: 'banana' })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /target context kind/i.test(error.message)
  );
});

test('roundLimit round-trips on a pr manifest and is omitted (not "none") when absent', () => {
  const withLimit = formatManifestV2(makePrManifest({ roundLimit: '7' }));
  assert.match(withLimit, /Round limit: 7/);
  assert.equal(parseManifestV2(withLimit).roundLimit, '7');

  // roundLimit is a MAXIMUM-only field: when unset it must never emit a
  // `Round limit: none` line (conditional emission), but it still parses back
  // to 'none' for back-compat (like guardMode / fixAttemptCount defaults).
  const noLimit = formatManifestV2(makePrManifest({ roundLimit: 'none' }));
  assert.doesNotMatch(noLimit, /Round limit:/);
  assert.equal(parseManifestV2(noLimit).roundLimit, 'none');
});

// --- PLAN-TASK-004: code targetContextKind schema extension ---

function makeCodeManifest(overrides = {}) {
  return makeManifest({
    targetContextKind: 'code',
    documentType: 'none',
    target: 'none',
    normalizedTarget: 'none',
    fileSetFingerprint: 'f'.repeat(64),
    roundLimit: '5',
    normalizedScopes: ['lib', 'src'],
    exclusions: ['.git', 'node_modules'],
    initialContentSha256: 'none',
    lastKnownContentSha256: 'none',
    lastReviewedContentSha256: 'none',
    lastPassedContentSha256: 'none',
    fileSize: 0,
    ...overrides
  });
}

test('code-kind manifest formats and parses file-set identity with scope/exclusion lists', () => {
  const text = formatManifestV2(makeCodeManifest());
  assert.match(text, /Target context kind: code/);
  assert.match(text, /File set fingerprint: f{64}/);
  assert.match(text, /Round limit: 5/);
  assert.match(text, /Normalized scopes:/);
  assert.match(text, /^- lib$/m);
  assert.match(text, /^- src$/m);
  assert.match(text, /Exclusions:/);
  assert.match(text, /^- \.git$/m);
  assert.match(text, /^- node_modules$/m);

  const parsed = parseManifestV2(text);
  assert.equal(parsed.targetContextKind, 'code');
  assert.equal(parsed.documentType, 'none');
  assert.equal(parsed.fileSetFingerprint, 'f'.repeat(64));
  assert.equal(parsed.roundLimit, '5');
  assert.deepEqual(parsed.normalizedScopes, ['lib', 'src']);
  assert.deepEqual(parsed.exclusions, ['.git', 'node_modules']);
  assert.equal(formatManifestV2(parsed), text);
});

test('code-kind manifest does not emit PR-only base/merge-base/head fields', () => {
  const text = formatManifestV2(makeCodeManifest());
  assert.doesNotMatch(text, /^Base:/m);
  assert.doesNotMatch(text, /^Base revision:/m);
  assert.doesNotMatch(text, /^Merge base:/m);
  assert.doesNotMatch(text, /^Head:/m);
  // ...nor the single-file identity block.
  assert.doesNotMatch(text, /^Initial content sha256:/m);
  assert.doesNotMatch(text, /^File size:/m);
});

test('code-kind manifest accepts empty scopes (whole project root)', () => {
  const text = formatManifestV2(makeCodeManifest({ normalizedScopes: [] }));
  assert.match(text, /Normalized scopes:/);
  const parsed = parseManifestV2(text);
  assert.deepEqual(parsed.normalizedScopes, []);
  assert.equal(formatManifestV2(parsed), text);
});

test('code-kind manifest sorts scope/exclusion lists for byte-stable output', () => {
  const unsorted = formatManifestV2(makeCodeManifest({ normalizedScopes: ['src', 'lib'], exclusions: ['node_modules', '.git'] }));
  const sorted = formatManifestV2(makeCodeManifest({ normalizedScopes: ['lib', 'src'], exclusions: ['.git', 'node_modules'] }));
  assert.equal(unsorted, sorted);
});

test('code-kind manifest rejects duplicate scope entries', () => {
  const text = formatManifestV2(makeCodeManifest());
  const dup = text.replace('Normalized scopes:\n- lib\n', 'Normalized scopes:\n- lib\n- lib\n');
  assert.throws(
    () => parseManifestV2(dup),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED'
  );
});

test('code-kind manifest rejects absolute or escaping scope entries', () => {
  assert.throws(
    () => formatManifestV2(makeCodeManifest({ normalizedScopes: ['/abs/path'] })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED'
  );
  assert.throws(
    () => formatManifestV2(makeCodeManifest({ normalizedScopes: ['../escape'] })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED'
  );
});

test('code-kind manifest rejects a missing file-set fingerprint', () => {
  assert.throws(
    () => formatManifestV2(makeCodeManifest({ fileSetFingerprint: undefined })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /file set fingerprint/i.test(error.message)
  );
});

test('code-kind manifest still enforces route-agnostic status/phase pairing', () => {
  assert.throws(
    () => formatManifestV2(makeCodeManifest({ status: 'fix', currentPhase: 'review' })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /current phase/i.test(error.message)
  );
});

test('code-kind manifest still enforces route-agnostic blocked/reason pairing', () => {
  assert.throws(
    () => formatManifestV2(makeCodeManifest({ status: 'blocked', blockingReason: 'none', statusReason: 'none' })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /blocking reason/i.test(error.message)
  );
});

test('roundLimit round-trips on a code manifest and is omitted (not "none") when absent', () => {
  const withLimit = formatManifestV2(makeCodeManifest({ roundLimit: '9' }));
  assert.match(withLimit, /Round limit: 9/);
  assert.equal(parseManifestV2(withLimit).roundLimit, '9');

  const noLimit = formatManifestV2(makeCodeManifest({ roundLimit: 'none' }));
  assert.doesNotMatch(noLimit, /Round limit:/);
  assert.equal(parseManifestV2(noLimit).roundLimit, 'none');
});

// --- PLAN-TASK-005: roundLimit as durable workflow metadata across all kinds ---

test('a document manifest WITHOUT rounds stays byte-identical and parses roundLimit none', () => {
  // SPEC-COMPAT-001 / Task-3 byte-stability: an unset roundLimit must add NO
  // line to a document manifest, and roundLimit defaults to 'none' on parse.
  const text = formatManifestV2(makeManifest());
  assert.doesNotMatch(text, /Round limit:/);
  const parsed = parseManifestV2(text);
  assert.equal(parsed.roundLimit, 'none');
  assert.equal(formatManifestV2(parsed), text);
});

test('a document manifest carries a positive roundLimit as durable workflow metadata', () => {
  // SPEC-STATE-002: roundLimit is invocation/workflow metadata; it lives in the
  // manifest as its own line, NOT derived from currentRound or receipt paths.
  const baseline = formatManifestV2(makeManifest());
  const withLimit = formatManifestV2(makeManifest({ roundLimit: '3' }));
  assert.match(withLimit, /^Round limit: 3$/m);
  assert.notEqual(withLimit, baseline);

  const parsed = parseManifestV2(withLimit);
  assert.equal(parsed.roundLimit, '3');
  // roundLimit is distinct from currentRound: the counter stays at its own value.
  assert.equal(parsed.currentRound, 1);
  assert.equal(formatManifestV2(parsed), withLimit);
});

test('roundLimit is never emitted as "none" on a document manifest (conditional emission)', () => {
  const explicitNone = formatManifestV2(makeManifest({ roundLimit: 'none' }));
  const implicit = formatManifestV2(makeManifest());
  // Explicitly-none must produce the SAME bytes as omitting roundLimit entirely.
  assert.equal(explicitNone, implicit);
  assert.doesNotMatch(explicitNone, /Round limit:/);
});

test('roundLimit rejects a non-positive or non-integer value on any kind', () => {
  assert.throws(
    () => formatManifestV2(makeManifest({ roundLimit: '0' })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /round limit/i.test(error.message)
  );
  assert.throws(
    () => formatManifestV2(makeManifest({ roundLimit: 'abc' })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /round limit/i.test(error.message)
  );
});

test('a unified Round limit line round-trips identically across document, pr, and code kinds', () => {
  for (const make of [makeManifest, makePrManifest, makeCodeManifest]) {
    const text = formatManifestV2(make({ roundLimit: '4' }));
    assert.match(text, /^Round limit: 4$/m);
    const parsed = parseManifestV2(text);
    assert.equal(parsed.roundLimit, '4');
    assert.equal(formatManifestV2(parsed), text);
  }
});

test('code-kind manifest round-trips User excludes and defaults absent label to empty', () => {
  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  const text = formatManifestV2(makeCodeManifest({ userExcludes: [digestA, digestB] }));
  assert.match(text, /User excludes:/);
  assert.match(text, new RegExp(`^- ${digestA}$`, 'm'));
  assert.match(text, new RegExp(`^- ${digestB}$`, 'm'));

  const parsed = parseManifestV2(text);
  assert.deepEqual(parsed.userExcludes, [digestA, digestB]);
  assert.equal(formatManifestV2(parsed), text);

  // Pre-.drfxignore manifests carry no "User excludes:" label: parse defaults to [].
  const legacy = formatManifestV2(makeCodeManifest())
    .split('\n')
    .filter((line) => line !== 'User excludes:')
    .join('\n');
  assert.deepEqual(parseManifestV2(legacy).userExcludes, []);
});

test('code-kind manifest keeps User excludes as ORDERED sha256 pattern digests', () => {
  // Order is semantic (negation is last-match-wins): never sorted.
  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  const ordered = formatManifestV2(makeCodeManifest({ userExcludes: [digestA, digestB] }));
  const lines = ordered.split('\n');
  const start = lines.indexOf('User excludes:');
  assert.deepEqual(lines.slice(start + 1, start + 3), [`- ${digestA}`, `- ${digestB}`]);

  const reversed = formatManifestV2(makeCodeManifest({ userExcludes: [digestB, digestA] }));
  assert.notEqual(ordered, reversed, 'pattern digest order must survive the manifest');

  // Duplicate digests stay semantic; raw pattern text and empty entries are rejected.
  const parsed = parseManifestV2(
    formatManifestV2(makeCodeManifest({ userExcludes: [digestA, digestB, digestA] }))
  );
  assert.deepEqual(parsed.userExcludes, [digestA, digestB, digestA]);

  assert.throws(
    () => formatManifestV2(makeCodeManifest({ userExcludes: ['   '] })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED'
  );
  assert.throws(
    () => formatManifestV2(makeCodeManifest({ userExcludes: ['*.log'] })),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED'
  );
});

// PLAN-TASK-009: STATUS_REASONS parity test
//
// There are two copies of STATUS_REASONS:
//   copy 1 — lib/workflow-state.js   (Array, frozen)  — manifest/start-time reasons
//   copy 2 — lib/semantic-parsers.js (Set)            — final-response-block reasons
//
// They are intentionally NOT strictly equal. `git-guard-unavailable` lives only in
// copy 1 because it is emitted at START time (start.js status:'unsupported') and
// never appears in a reviewer/coordinator final-response machine block. Adding it
// to copy 2 would loosen parseFinalResponseBlock validation to accept a reason
// that cannot legitimately appear there — a regression in strictness (D2 decision).
//
// The invariant asserted here is the honest, stricter form:
//   1. 'coverage-incomplete' ∈ BOTH copies        (catches one-sided additions)
//   2. copy2 ⊆ copy1                              (every final-response reason is a valid manifest reason)
//   3. copy1 \ copy2 === exactly {'git-guard-unavailable'}  (no other undocumented divergence)
test('STATUS_REASONS parity: coverage-incomplete in both copies; copy2 ⊆ copy1; copy1\\copy2 === {git-guard-unavailable}', () => {
  // Normalize copy 1 (Array) and copy 2 (Set) to plain Sets for comparison.
  const set1 = new Set(STATUS_REASONS_COPY1);
  const set2 = STATUS_REASONS_COPY2 instanceof Set
    ? STATUS_REASONS_COPY2
    : new Set(STATUS_REASONS_COPY2);

  // 1. 'coverage-incomplete' must be in both copies.
  assert.ok(set1.has('coverage-incomplete'), "'coverage-incomplete' must be in copy 1 (workflow-state.js)");
  assert.ok(set2.has('coverage-incomplete'), "'coverage-incomplete' must be in copy 2 (semantic-parsers.js)");

  // 2. copy2 ⊆ copy1 — every final-response reason is also a valid manifest reason.
  for (const reason of set2) {
    assert.ok(set1.has(reason), `copy2 reason '${reason}' is missing from copy1 (workflow-state.js) — all final-response reasons must be valid manifest reasons`);
  }

  // 3. copy1 \ copy2 must be EXACTLY {'git-guard-unavailable'}.
  //    Any other copy-1-exclusive reason indicates an undocumented divergence that needs a deliberate decision.
  const onlyInCopy1 = new Set([...set1].filter((r) => !set2.has(r)));
  assert.deepEqual(
    onlyInCopy1,
    new Set(['git-guard-unavailable']),
    "copy1 \\ copy2 must be exactly {'git-guard-unavailable'} — any other copy-1-exclusive reason indicates undocumented divergence"
  );
});
