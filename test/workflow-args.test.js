'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  formatWorkflowError,
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

test('formatWorkflowError stable JSON has targetKey and runtime/status fields', () => {
  const formatted = formatWorkflowError({
    error: new Error('boom'),
    targetKey: 'docs-spec-md',
    runtimeCheck: {
      platform: 'codex',
      subagentProbe: { status: 'failed' },
      stdinHandoff: { status: 'unavailable' }
    },
    blockingReason: 'fingerprint-guard-unavailable',
    statusReason: 'runtime-check-failed'
  });

  assert.deepEqual(formatted, {
    ok: false,
    status: 'blocked',
    targetKey: 'docs-spec-md',
    runtimeCheck: {
      platform: 'codex',
      subagentProbe: { status: 'failed' },
      stdinHandoff: { status: 'unavailable' }
    },
    blockingReason: 'fingerprint-guard-unavailable',
    statusReason: 'runtime-check-failed',
    error: 'boom'
  });
});
