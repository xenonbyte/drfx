'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  formatWorkflowError,
  runWorkflowCommand,
  parseWorkflowArgs
} = require('../lib/workflow');

test('parses practical start flags with runtime platform, subagent, stdin, and json', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-spec',
    'target=docs/spec.md',
    'review-and-fix',
    '--json',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ]);

  assert.equal(parsed.subcommand, 'start');
  assert.equal(parsed.json, true);
  assert.equal(parsed.invocation.target, 'docs/spec.md');
  assert.equal(parsed.invocation.mode, 'review-and-fix');
  assert.equal(parsed.assurance, 'practical');
  assert.equal(parsed.runtimePlatform, 'codex');
  assert.equal(parsed.runtimeCheck.subagentProbe.status, 'ready');
  assert.equal(parsed.runtimeCheck.stdinHandoff.status, 'ready');
});

test('practical without ready assertions rejects', () => {
  assert.throws(
    () =>
      parseWorkflowArgs('start', [
        'review-fix-spec',
        'target=docs/spec.md',
        '--assurance',
        'practical',
        '--runtime-platform',
        'codex',
        '--runtime-subagent-probe',
        'ready',
        '--runtime-stdin-handoff',
        'unavailable'
      ]),
    /practical.*ready/i
  );
});

test('codex strict verified start requires descriptor and proof', () => {
  assert.throws(
    () =>
      parseWorkflowArgs('start', [
        'review-fix-spec',
        'target=docs/spec.md',
        'assurance=strict-verified',
        '--assurance',
        'strict-verified',
        '--runtime-platform',
        'codex',
        '--runtime-subagent-probe',
        'ready',
        '--runtime-stdin-handoff',
        'ready'
      ]),
    /capability descriptor.*proof run id|proof run id.*capability descriptor/i
  );
});

test('direct Gemini strict verified start parses for unsupported handling', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-design',
    'target=design/DESIGN-v2.md',
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
  ]);

  assert.equal(parsed.assurance, 'strict-verified');
  assert.equal(parsed.runtimePlatform, 'gemini');
  assert.equal(parsed.runtimeCheck.subagentProbe.status, 'not-required');
  assert.equal(parsed.runtimeCheck.stdinHandoff.status, 'not-required');
});

test('advisory review-and-fix start returns unsupported validation result', async () => {
  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    'target=docs/spec.md',
    'review-and-fix',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required'
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'advisory-review-and-fix-unsupported');
  assert.equal(result.mode, 'read-only');
  assert.equal(result.modeNormalizedFrom, 'review-and-fix');
  assert.equal(result.assurance, 'advisory');
});

test('runtime downgrade advisory review-and-fix normalizes to read-only without unsupported reason', async () => {
  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    'target=docs/spec.md',
    'review-and-fix',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'unavailable',
    '--runtime-stdin-handoff',
    'ready',
    '--runtime-downgrade-reason',
    'subagent-delegation-unavailable'
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'started');
  assert.equal(result.statusReason, 'none');
  assert.equal(result.mode, 'read-only');
  assert.equal(result.modeNormalizedFrom, 'review-and-fix');
  assert.equal(result.assurance, 'advisory');
  assert.notEqual(result.statusReason, 'advisory-review-and-fix-unsupported');
});

test('invalid runtime downgrade reason always rejects', () => {
  assert.throws(
    () =>
      parseWorkflowArgs('start', [
        'review-fix-spec',
        'target=docs/spec.md',
        '--assurance',
        'advisory',
        '--runtime-platform',
        'manual',
        '--runtime-subagent-probe',
        'not-required',
        '--runtime-stdin-handoff',
        'not-required',
        '--runtime-downgrade-reason',
        'bogus'
      ]),
    /downgrade reason/i
  );
});

test('unavailable stdin handoff maps to blocked unsafe handoff result', async () => {
  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    'target=docs/spec.md',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'unavailable'
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unsafe-handoff-file');
  assert.equal(result.statusReason, 'none');
});

test('formatWorkflowError stable JSON includes full error contract fields', () => {
  const error = new Error('boom');
  error.code = 'ERR_BOOM';
  const formatted = formatWorkflowError({
    error,
    targetKey: 'docs-spec-md',
    targetStateDir: '/tmp/state',
    manifestPath: '/tmp/state/MANIFEST.md',
    runtimeCheck: {
      platform: 'codex',
      subagentProbe: { status: 'failed' },
      stdinHandoff: { status: 'unavailable' }
    },
    blockingReason: 'fingerprint-guard-unavailable',
    statusReason: 'none',
    nextAction: 'fix runtime'
  });

  assert.deepEqual(formatted, {
    ok: false,
    status: 'blocked',
    errorCode: 'ERR_BOOM',
    message: 'boom',
    targetKey: 'docs-spec-md',
    targetStateDir: '/tmp/state',
    manifestPath: '/tmp/state/MANIFEST.md',
    runtimeCheck: {
      platform: 'codex',
      subagentProbe: { status: 'failed' },
      stdinHandoff: { status: 'unavailable' }
    },
    blockingReason: 'fingerprint-guard-unavailable',
    statusReason: 'none',
    nextAction: 'fix runtime'
  });
});

test('CLI workflow --json errors emit one stable JSON object', () => {
  const bin = path.join(__dirname, '..', 'bin', 'drfx.js');
  const result = spawnSync(process.execPath, [bin, 'workflow', 'start', '--json'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, 'blocked');
  assert.equal(parsed.errorCode, 'ERR_WORKFLOW_ENTRY_SKILL');
  assert.match(parsed.message, /entry skill/i);
  assert.equal(parsed.targetStateDir, null);
  assert.equal(parsed.manifestPath, null);
  assert.equal(parsed.nextAction, null);
});
