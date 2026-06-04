'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildDescriptor, createRunId } = require('../lib/capability');
const { formatWorkflowJson, runWorkflowCommand } = require('../lib/workflow');
const { formatManifestV2, parseManifestV2 } = require('../lib/workflow-state');

const PACKAGE_VERSION = '0.1.1';
const REAL_TARGET = path.join(__dirname, '..', 'README.md');

function verifiedCapability(runId, proof = 'adapter-descriptor') {
  return {
    status: 'verified',
    proof,
    proofRunId: runId,
    detail: 'Verified by test fixture.'
  };
}

function verifiedDescriptor({ platform = 'codex', runId = createRunId() } = {}) {
  return buildDescriptor({
    platform,
    packageVersion: PACKAGE_VERSION,
    runId,
    adapterCapabilities: {
      can_spawn_isolated_reviewer: verifiedCapability(runId),
      reviewer_write_blocked: verifiedCapability(runId)
    },
    fingerprintGuard: verifiedCapability(runId, 'node-crypto-stat-probe')
  });
}

function writeDescriptor(t, descriptor, basename = `${descriptor.platform}.json`) {
  const descriptorDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-doctor-'));
  const descriptorPath = path.join(descriptorDirectory, basename);
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  t.after(() => {
    fs.rmSync(descriptorDirectory, { recursive: true, force: true });
  });
  return { descriptorDirectory, descriptorPath };
}

async function runStrictStart(args, options) {
  return runWorkflowCommand('start', [
    'review-fix-spec',
    `target=${REAL_TARGET}`,
    'read-only',
    'assurance=strict-verified',
    '--assurance',
    'strict-verified',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    ...args
  ], {
    packageVersion: PACKAGE_VERSION,
    ...options
  });
}

test('wrong descriptor basename returns advisory unsupported strict proof failure', async (t) => {
  const runId = createRunId();
  const { descriptorDirectory, descriptorPath } = writeDescriptor(t, verifiedDescriptor({ runId }), 'wrong.json');

  const result = await runStrictStart([
    '--capability-descriptor',
    descriptorPath,
    '--proof-run-id',
    runId
  ], { descriptorDirectory });

  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'strict-proof-validation-failed');
  assert.equal(result.assurance, 'advisory');
  assert.equal(result.assuranceProof, 'none');
});

test('descriptor outside supplied descriptorDirectory returns strict proof failure', async (t) => {
  const runId = createRunId();
  const outside = writeDescriptor(t, verifiedDescriptor({ runId }));
  const descriptorDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-doctor-'));
  t.after(() => {
    fs.rmSync(descriptorDirectory, { recursive: true, force: true });
  });

  const result = await runStrictStart([
    '--capability-descriptor',
    outside.descriptorPath,
    '--proof-run-id',
    runId
  ], { descriptorDirectory });

  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'strict-proof-validation-failed');
  assert.equal(result.assurance, 'advisory');
  assert.equal(result.assuranceProof, 'none');
});

test('missing descriptorDirectory binding returns strict proof failure', async (t) => {
  const runId = createRunId();
  const { descriptorPath } = writeDescriptor(t, verifiedDescriptor({ runId }));

  const result = await runStrictStart([
    '--capability-descriptor',
    descriptorPath,
    '--proof-run-id',
    runId
  ]);

  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'strict-proof-validation-failed');
  assert.equal(result.assurance, 'advisory');
  assert.equal(result.assuranceProof, 'none');
});

test('strict proof downgrade from review-and-fix normalizes mode metadata', async (t) => {
  const runId = createRunId();
  const { descriptorDirectory, descriptorPath } = writeDescriptor(t, verifiedDescriptor({ runId }), 'wrong.json');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `target=${REAL_TARGET}`,
    'review-and-fix',
    'assurance=strict-verified',
    '--assurance',
    'strict-verified',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--capability-descriptor',
    descriptorPath,
    '--proof-run-id',
    runId
  ], {
    packageVersion: PACKAGE_VERSION,
    descriptorDirectory
  });

  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'strict-proof-validation-failed');
  assert.equal(result.mode, 'read-only');
  assert.equal(result.modeNormalizedFrom, 'review-and-fix');
  assert.equal(result.assurance, 'advisory');
  assert.equal(result.assuranceNormalizedFrom, 'strict-verified');
});

test('stale run id or non-verified descriptor returns strict proof failure and advisory assurance', async (t) => {
  const runId = createRunId();
  const staleRunId = createRunId();
  const { descriptorDirectory, descriptorPath } = writeDescriptor(t, verifiedDescriptor({ runId: staleRunId }));

  const result = await runStrictStart([
    '--capability-descriptor',
    descriptorPath,
    '--proof-run-id',
    runId
  ], { descriptorDirectory });

  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'strict-proof-validation-failed');
  assert.equal(result.assurance, 'advisory');
  assert.equal(result.assuranceProof, 'none');
});

test('strict verified success emits schema-2 compatible proof fields', async (t) => {
  const runId = createRunId();
  const { descriptorDirectory, descriptorPath } = writeDescriptor(t, verifiedDescriptor({ runId }));

  const result = await runStrictStart([
    '--capability-descriptor',
    descriptorPath,
    '--proof-run-id',
    runId
  ], { descriptorDirectory });
  const output = JSON.parse(formatWorkflowJson(result));

  assert.equal(output.ok, true);
  assert.equal(output.assurance, 'strict-verified');
  assert.equal(output.descriptorPlatform, 'codex');
  assert.equal(output.assuranceProof, `capability-descriptor:codex:${runId}`);

  const manifestText = formatManifestV2({
    manifestSchema: 2,
    target: REAL_TARGET,
    normalizedTarget: 'README.md',
    documentType: output.documentType,
    strictness: output.strictness,
    mode: output.mode,
    targetKey: output.targetKey,
    ledgerPath: `.drfx/targets/${output.targetKey}/ISSUES.md`,
    status: 'review',
    currentPhase: 'review',
    currentRound: 1,
    assurance: output.assurance,
    runtimePlatform: output.runtimePlatform,
    descriptorPlatform: output.descriptorPlatform,
    assuranceProof: output.assuranceProof,
    runtimeSubagentProbe: output.runtimeCheck.subagentProbe.status,
    runtimeSubagentProbeEvidence: output.runtimeCheck.subagentProbe.evidence,
    runtimeFingerprintGuard: 'not-run',
    runtimeStdinHandoff: output.runtimeCheck.stdinHandoff.status,
    runtimeStdinHandoffEvidence: output.runtimeCheck.stdinHandoff.evidence,
    runtimeDowngradeReason: output.runtimeCheck.downgradeReason,
    blockingReason: output.blockingReason,
    statusReason: output.statusReason,
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
    updatedAt: '2026-05-21T00:00:00.000Z'
  });

  assert.equal(parseManifestV2(manifestText).assuranceProof, `capability-descriptor:codex:${runId}`);
});

test('direct Gemini strict verified start returns advisory unsupported read-only', async () => {
  const result = await runWorkflowCommand('start', [
    'review-fix-design',
    `target=${REAL_TARGET}`,
    'read-only',
    'assurance=strict-verified',
    '--assurance',
    'strict-verified',
    '--runtime-platform',
    'gemini',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required'
  ], { packageVersion: PACKAGE_VERSION });

  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'unsupported-runtime-capability');
  assert.equal(result.assurance, 'advisory');
  assert.equal(result.mode, 'read-only');
});
