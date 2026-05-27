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
  workflowJson
} = require('../lib/workflow-state');
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

test('explicit audit trail is enabled only by original ledger token', () => {
  assert.equal(shouldCreatePersistentState({ mode: 'read-only', ledger: null, resume: false, round: 1 }), false);
  assert.equal(shouldCreatePersistentState({ mode: 'read-only', ledger: 'custom/ISSUES.md', resume: false, round: 1 }), true);
  assert.equal(shouldWriteRoundReceipt({ auditTrail: false, round: 1, stopReason: null, phaseCompleted: 'review' }), false);
  assert.equal(shouldWriteRoundReceipt({ auditTrail: true, round: 1, stopReason: null, phaseCompleted: 'review' }), true);
  assert.equal(shouldWriteRoundReceipt({ originalLedgerToken: 'ledger=custom/ISSUES.md', round: 1, stopReason: null, phaseCompleted: 'review' }), true);
  assert.equal(shouldWriteRoundReceipt({ ledgerPath: 'ISSUES.md', round: 1, stopReason: null, phaseCompleted: 'review' }), false);
});
