'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildDescriptor, createRunId } = require('../lib/capability');
const { runWorkflowCommand } = require('../lib/workflow');

const PACKAGE_VERSION = '0.1.0';
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
  const descriptorDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-check-'));
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
  const descriptorDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-check-'));
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
