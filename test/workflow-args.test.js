'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const { deriveTargetKey } = require('../lib/target-state');

const {
  formatWorkflowError,
  runWorkflowCommand,
  parseWorkflowArgs,
  parseWorkflowJsonMode
} = require('../lib/workflow');
const { BLOCKING_REASONS, STATUS_REASONS, workflowJson } = require('../lib/workflow-state');

const ROOT = path.join(__dirname, '..');
const REAL_TARGET = path.join(ROOT, 'README.md');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeGitFixture(t, { commit = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-v3-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(root, 'docs', 'target.md');
  fs.writeFileSync(target, '# Target\n');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['add', 'docs/target.md']);
  if (commit) git(root, ['commit', '-m', 'initial']);
  return { root, target };
}

function makeNonGitFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-v3-preflight-non-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(root, 'docs', 'target.md');
  fs.writeFileSync(target, '# Target\n');
  return { root, target };
}

function writePreflightArgs(target, assurance = 'practical', options = {}) {
  const guardToken = options.guardMode ? [`guard=${options.guardMode}`] : [];
  return [
    'review-fix-spec',
    `target=${target}`,
    'review-and-fix',
    ...guardToken,
    '--assurance',
    assurance,
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--runtime-downgrade-reason',
    'none',
    '--json'
  ];
}

function assertNoPreflightState(root) {
  assert.equal(fs.existsSync(path.join(root, '.drfx', 'targets')), false);
}

function makeUnmergedTarget(t) {
  const fixture = makeGitFixture(t);
  git(fixture.root, ['checkout', '-b', 'left']);
  fs.writeFileSync(fixture.target, '# Left\n');
  git(fixture.root, ['commit', '-am', 'left edit']);
  git(fixture.root, ['checkout', '-b', 'right', 'HEAD~1']);
  fs.writeFileSync(fixture.target, '# Right\n');
  git(fixture.root, ['commit', '-am', 'right edit']);
  assert.throws(
    () => git(fixture.root, ['merge', 'left']),
    /merge|conflict|Automatic merge failed/i
  );
  return fixture;
}

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

function workflowJsonModeArgs(jsonFlag) {
  return [
    'review-fix-spec',
    'target=docs/spec.md',
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    jsonFlag
  ];
}

test('SCOPE-IN-001 workflow JSON mode accepts full and compact while preserving bare json', () => {
  assert.equal(parseWorkflowJsonMode(['--json']), 'full');
  assert.equal(parseWorkflowJsonMode(['--json=full']), 'full');
  assert.equal(parseWorkflowJsonMode(['--json=compact']), 'compact');
  assert.throws(() => parseWorkflowJsonMode(['--json=bad']), /ERR_WORKFLOW_FLAG/);

  const bare = parseWorkflowArgs('context', workflowJsonModeArgs('--json'));
  assert.equal(bare.json, true);
  assert.equal(bare.jsonMode, 'full');

  const full = parseWorkflowArgs('context', workflowJsonModeArgs('--json=full'));
  assert.equal(full.json, true);
  assert.equal(full.jsonMode, 'full');

  const compact = parseWorkflowArgs('context', workflowJsonModeArgs('--json=compact'));
  assert.equal(compact.json, true);
  assert.equal(compact.jsonMode, 'compact');

  assert.throws(
    () => parseWorkflowArgs('context', workflowJsonModeArgs('--json=bad')),
    (error) => {
      assert.equal(error.code, 'ERR_WORKFLOW_FLAG');
      assert.match(error.message, /--json/);
      return true;
    }
  );
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
  ]);

  assert.equal(parsed.assurance, 'strict-verified');
  assert.equal(parsed.runtimePlatform, 'gemini');
  assert.equal(parsed.runtimeCheck.subagentProbe.status, 'not-required');
  assert.equal(parsed.runtimeCheck.stdinHandoff.status, 'not-required');
});

// opencode is a full review-and-fix platform: it must pass the practical and
// strict-verified runtime trust allowlists (the "full vs advisory" switch),
// exactly like codex/claude-code and unlike advisory-only Gemini.
test('practical start accepts opencode as a full review-and-fix runtime platform', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-spec',
    'target=docs/spec.md',
    'review-and-fix',
    '--assurance',
    'practical',
    '--runtime-platform',
    'opencode',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ]);

  assert.equal(parsed.assurance, 'practical');
  assert.equal(parsed.runtimePlatform, 'opencode');
  assert.equal(parsed.runtimeCheck.subagentProbe.status, 'ready');
  assert.equal(parsed.runtimeCheck.stdinHandoff.status, 'ready');
});

test('opencode strict verified start passes the platform allowlist and then requires descriptor and proof', () => {
  // If opencode were dropped from the strict-verified allowlist this would throw
  // ERR_STRICT_RUNTIME_PLATFORM ("requires runtime platform codex, claude-code, or
  // opencode") instead of the descriptor/proof error, failing this regex.
  assert.throws(
    () =>
      parseWorkflowArgs('start', [
        'review-fix-spec',
        'target=docs/spec.md',
        'assurance=strict-verified',
        '--assurance',
        'strict-verified',
        '--runtime-platform',
        'opencode',
        '--runtime-subagent-probe',
        'ready',
        '--runtime-stdin-handoff',
        'ready'
      ]),
    /capability descriptor.*proof run id|proof run id.*capability descriptor/i
  );
});

test('advisory review-and-fix start returns unsupported validation result', async () => {
  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `target=${REAL_TARGET}`,
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
    `target=${REAL_TARGET}`,
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

test('advisory review-and-fix user request is unsupported without runtime downgrade', async () => {
  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    'target=test/fixtures/workflow/practical-target.md',
    'review-and-fix',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--runtime-downgrade-reason',
    'none',
    '--json'
  ], { cwd: path.join(__dirname, '..') });

  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'advisory-review-and-fix-unsupported');
  assert.equal(result.mode, 'read-only');
  assert.equal(result.requestedMode, 'review-and-fix');
});

test('advisory without mode stays read-only and does not enter unsupported review-and-fix path', async () => {
  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    'target=test/fixtures/workflow/practical-target.md',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--runtime-downgrade-reason',
    'none',
    '--json'
  ], { cwd: path.join(__dirname, '..') });

  assert.notEqual(result.statusReason, 'advisory-review-and-fix-unsupported');
  assert.equal(result.mode, 'read-only');
  assert.equal(result.requestedMode, 'read-only');
  assert.equal(result.assurance, 'advisory');
});

test('workflow start returns canonical target key from target-state', async () => {
  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `target=${REAL_TARGET}`,
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ]);

  assert.equal(result.targetKey, deriveTargetKey(ROOT, REAL_TARGET).targetKey);
});

test('workflow start exposes normal rule warnings in json', async (t) => {
  const fixture = makeGitFixture(t);
  fs.mkdirSync(path.join(fixture.root, '.drfx', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.drfx', 'rules', 'CHECKLIST.md'), '# Checklist\n');

  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    fixture.target,
    'review-and-fix',
    'normal',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ], {
    cwd: fixture.root,
    homeDir: path.join(fixture.root, 'home')
  });
  const json = workflowJson(result);

  assert.equal(result.status, 'review');
  assert.equal(json.warnings.length, 1);
  assert.equal(json.warnings[0].code, 'WARN_UNKNOWN_CUSTOM_RULE_FILE');
});

test('workflow no-state context exposes normal rule warnings in json', async (t) => {
  const fixture = makeGitFixture(t);
  fs.mkdirSync(path.join(fixture.root, '.drfx', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.drfx', 'rules', 'CHECKLIST.md'), '# Checklist\n');

  const result = await runWorkflowCommand('context', [
    '--no-state',
    'review-fix-spec',
    fixture.target,
    'read-only',
    'normal',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'ready',
    '--runtime-downgrade-reason',
    'none'
  ], {
    cwd: fixture.root,
    homeDir: path.join(fixture.root, 'home')
  });
  const json = workflowJson(result);

  assert.equal(result.status, 'context');
  assert.equal(json.warnings.length, 1);
  assert.equal(json.warnings[0].code, 'WARN_UNKNOWN_CUSTOM_RULE_FILE');
});

test('workflow persistent context exposes normal rule warnings in json', async (t) => {
  const fixture = makeGitFixture(t);
  fs.mkdirSync(path.join(fixture.root, '.drfx', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.drfx', 'rules', 'CHECKLIST.md'), '# Checklist\n');

  const start = await runWorkflowCommand('start', [
    'review-fix-spec',
    fixture.target,
    'review-and-fix',
    'normal',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--runtime-downgrade-reason',
    'none'
  ], {
    cwd: fixture.root,
    homeDir: path.join(fixture.root, 'home')
  });
  assert.equal(start.status, 'review');

  const context = await runWorkflowCommand('context', [
    'review-fix-spec',
    fixture.target,
    'review-and-fix',
    'normal',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--runtime-downgrade-reason',
    'none'
  ], {
    cwd: fixture.root,
    homeDir: path.join(fixture.root, 'home')
  });
  const json = workflowJson(context);

  assert.equal(context.status, 'context');
  assert.equal(json.warnings.length, 1);
  assert.equal(json.warnings[0].code, 'WARN_UNKNOWN_CUSTOM_RULE_FILE');
});

test('workflow start rejects target outside explicit root before emitting target key', async (t) => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-workflow-outside-'));
  const outsideTarget = path.join(outsideRoot, 'outside.md');
  fs.writeFileSync(outsideTarget, '# Outside\n');
  t.after(() => {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    () =>
      runWorkflowCommand('start', [
        'review-fix-spec',
        `target=${outsideTarget}`,
        `root=${ROOT}`,
        '--assurance',
        'practical',
        '--runtime-platform',
        'codex',
        '--runtime-subagent-probe',
        'ready',
        '--runtime-stdin-handoff',
        'ready'
      ]),
    /contain target/i
  );
});

test('workflow start preserves explicit assurance source from CLI flag', async () => {
  const result = await runWorkflowCommand('start', [
    'review-fix-spec',
    `target=${REAL_TARGET}`,
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready'
  ]);

  assert.equal(result.assuranceSource, 'explicit');
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
    `target=${REAL_TARGET}`,
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

test('formatWorkflowError default blocker is schema-2 legal after stable JSON formatting', () => {
  const formatted = workflowJson(formatWorkflowError({ error: new Error('bad workflow') }));

  assert.equal(formatted.status, 'blocked');
  assert.equal(BLOCKING_REASONS.includes(formatted.blockingReason), true);
  assert.equal(STATUS_REASONS.includes(formatted.statusReason), true);
  assert.equal(formatted.blockingReason, 'state-validation-failed');
  assert.equal(formatted.statusReason, 'none');
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

test('write eligibility preflight passes for clean tracked target without creating state', async (t) => {
  const fixture = makeGitFixture(t);
  const result = await runWorkflowCommand('preflight', writePreflightArgs(fixture.target), { cwd: fixture.root });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'write-eligible');
  assert.equal(result.mode, 'review-and-fix');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight honors snapshot guard outside git before creating state', async (t) => {
  const fixture = makeNonGitFixture(t);
  const result = await runWorkflowCommand(
    'preflight',
    writePreflightArgs(fixture.target, 'practical', { guardMode: 'snapshot' }),
    { cwd: fixture.root }
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'write-eligible');
  assert.equal(result.guardMode, 'snapshot');
  assert.equal(result.rollbackAnchor.guardMode, 'snapshot');
  assert.equal(result.targetOnlyGuard.guardMode, 'snapshot');
  assert.equal(result.targetOnlyGuard.status, 'passed');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight accepts strict verified before proof without creating state', async (t) => {
  const fixture = makeGitFixture(t);
  const result = await runWorkflowCommand('preflight', writePreflightArgs(fixture.target, 'strict-verified'), { cwd: fixture.root });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'write-eligible');
  assert.equal(result.assurance, 'strict-verified');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight reports write-not-required for read-only mode', async (t) => {
  const fixture = makeGitFixture(t);
  const args = writePreflightArgs(fixture.target);
  args[2] = 'read-only';
  const result = await runWorkflowCommand('preflight', args, { cwd: fixture.root });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'write-not-required');
  assert.equal(result.mode, 'read-only');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight returns unsupported for advisory review-and-fix', async (t) => {
  const fixture = makeGitFixture(t);
  const result = await runWorkflowCommand('preflight', writePreflightArgs(fixture.target, 'advisory'), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'advisory-review-and-fix-unsupported');
  assert.equal(result.mode, 'read-only');
  assert.equal(result.modeNormalizedFrom, 'review-and-fix');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks missing HEAD before state creation', async (t) => {
  const fixture = makeGitFixture(t, { commit: false });
  const result = await runWorkflowCommand('preflight', writePreflightArgs(fixture.target), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks untracked target before state creation', async (t) => {
  const fixture = makeGitFixture(t);
  const untracked = path.join(fixture.root, 'docs', 'untracked.md');
  fs.writeFileSync(untracked, '# Untracked\n');

  const result = await runWorkflowCommand('preflight', writePreflightArgs(untracked), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks ignored untracked target before state creation', async (t) => {
  const fixture = makeGitFixture(t);
  fs.writeFileSync(path.join(fixture.root, '.gitignore'), 'docs/ignored.md\n');
  fs.writeFileSync(path.join(fixture.root, 'docs', 'ignored.md'), '# Ignored\n');

  const result = await runWorkflowCommand('preflight', writePreflightArgs(path.join(fixture.root, 'docs', 'ignored.md')), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks copied target before state creation', async (t) => {
  const fixture = makeGitFixture(t);
  const source = path.join(fixture.root, 'docs', 'source.md');
  fs.writeFileSync(source, '# Source\n');
  git(fixture.root, ['add', 'docs/source.md']);
  git(fixture.root, ['commit', '-m', 'add source']);
  const copied = path.join(fixture.root, 'docs', 'copied.md');
  fs.copyFileSync(source, copied);

  const result = await runWorkflowCommand('preflight', writePreflightArgs(copied), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks staged target before state creation', async (t) => {
  const fixture = makeGitFixture(t);
  fs.writeFileSync(fixture.target, '# Staged\n');
  git(fixture.root, ['add', 'docs/target.md']);

  const result = await runWorkflowCommand('preflight', writePreflightArgs(fixture.target), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks dirty target before state creation', async (t) => {
  const fixture = makeGitFixture(t);
  fs.writeFileSync(fixture.target, '# Dirty\n');

  const result = await runWorkflowCommand('preflight', writePreflightArgs(fixture.target), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks deleted target before state creation', async (t) => {
  const fixture = makeGitFixture(t);
  fs.rmSync(fixture.target);

  const result = await runWorkflowCommand('preflight', writePreflightArgs(fixture.target), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks renamed target before state creation', async (t) => {
  const fixture = makeGitFixture(t);
  git(fixture.root, ['mv', 'docs/target.md', 'docs/renamed.md']);
  const renamed = path.join(fixture.root, 'docs', 'renamed.md');

  const result = await runWorkflowCommand('preflight', writePreflightArgs(renamed), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks unmerged target before state creation', async (t) => {
  const fixture = makeUnmergedTarget(t);
  const result = await runWorkflowCommand('preflight', writePreflightArgs(fixture.target), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks unreadable target when platform permissions expose it', async (t) => {
  const fixture = makeGitFixture(t);
  const originalMode = fs.statSync(fixture.target).mode & 0o777;
  fs.chmodSync(fixture.target, 0o000);
  t.after(() => {
    if (fs.existsSync(fixture.target)) fs.chmodSync(fixture.target, originalMode);
  });
  try {
    fs.accessSync(fixture.target, fs.constants.R_OK | fs.constants.W_OK);
    t.skip('platform still allows target read/write access after chmod 000');
    return;
  } catch {
    // Continue with the preflight assertion.
  }

  const result = await runWorkflowCommand('preflight', writePreflightArgs(fixture.target), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assertNoPreflightState(fixture.root);
});

test('write eligibility preflight blocks unsafe non-target worktree changes', async (t) => {
  const fixture = makeGitFixture(t);
  fs.writeFileSync(path.join(fixture.root, 'docs', 'other.md'), '# Other\n');

  const result = await runWorkflowCommand('preflight', writePreflightArgs(fixture.target), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  assertNoPreflightState(fixture.root);
});

// ---------------------------------------------------------------------------
// PR route workflow args (parseWorkflowArgs for review-fix-pr)
// ---------------------------------------------------------------------------

test('parseWorkflowArgs accepts review-fix-pr with base=<branch> and defaults mode, guardMode', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-pr',
    'base=main',
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

  assert.equal(parsed.entrySkill, 'review-fix-pr');
  assert.equal(parsed.invocation.routeKind, 'pr');
  assert.equal(parsed.invocation.base, 'main');
  assert.equal(parsed.invocation.mode, 'review-and-fix');
  assert.equal(parsed.invocation.guardMode, 'git');
  assert.equal(parsed.invocation.resume, false);
  assert.equal(parsed.invocation.roundLimit, null);
});

test('parseWorkflowArgs accepts review-fix-pr with explicit guard=snapshot', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-pr',
    'base=origin/main',
    'guard=snapshot',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required'
  ]);

  assert.equal(parsed.invocation.guardMode, 'snapshot');
  assert.equal(parsed.invocation.base, 'origin/main');
});

test('parseWorkflowArgs accepts review-fix-pr with explicit resume token (no implicit resume)', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-pr',
    'base=main',
    'resume',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required'
  ]);

  assert.equal(parsed.invocation.resume, true);
});

test('parseWorkflowArgs accepts review-fix-pr with rounds=<n>', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-pr',
    'base=main',
    'review-and-fix',
    'rounds=4',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required'
  ]);

  assert.equal(parsed.invocation.roundLimit, 4);
});

test('parseWorkflowArgs rejects review-fix-pr missing base at the parse boundary', () => {
  assert.throws(
    () =>
      parseWorkflowArgs('start', [
        'review-fix-pr',
        '--assurance',
        'advisory',
        '--runtime-platform',
        'manual',
        '--runtime-subagent-probe',
        'not-required',
        '--runtime-stdin-handoff',
        'not-required'
      ]),
    /base/i
  );
});

// ---------------------------------------------------------------------------
// CODE route workflow args (parseWorkflowArgs for review-fix-code)
// ---------------------------------------------------------------------------

test('parseWorkflowArgs accepts review-fix-code with zero scopes and defaults mode, guardMode', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-code',
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

  assert.equal(parsed.entrySkill, 'review-fix-code');
  assert.equal(parsed.invocation.routeKind, 'code');
  assert.deepEqual(parsed.invocation.scopes, []);
  assert.equal(parsed.invocation.mode, 'review-and-fix');
  assert.equal(parsed.invocation.guardMode, 'git');
  assert.equal(parsed.invocation.resume, false);
  assert.equal(parsed.invocation.roundLimit, null);
});

test('parseWorkflowArgs accepts review-fix-code with repeated scope= paths', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-code',
    'scope=src/',
    'scope=lib/',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required'
  ]);

  assert.deepEqual(parsed.invocation.scopes, ['src/', 'lib/']);
});

test('parseWorkflowArgs accepts review-fix-code with explicit resume token', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-code',
    'scope=src/',
    'resume',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required'
  ]);

  assert.equal(parsed.invocation.resume, true);
});

test('parseWorkflowArgs accepts review-fix-code with rounds=<n>', () => {
  const parsed = parseWorkflowArgs('start', [
    'review-fix-code',
    'scope=src/',
    'review-and-fix',
    'rounds=2',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required'
  ]);

  assert.equal(parsed.invocation.roundLimit, 2);
});

test('parseWorkflowArgs rejects review-fix-code with base= (usage error before side effects)', () => {
  assert.throws(
    () =>
      parseWorkflowArgs('start', [
        'review-fix-code',
        'base=main',
        '--assurance',
        'advisory',
        '--runtime-platform',
        'manual',
        '--runtime-subagent-probe',
        'not-required',
        '--runtime-stdin-handoff',
        'not-required'
      ]),
    /review-fix-pr/i
  );
});

// ---------------------------------------------------------------------------
// PLAN-TASK-007: partitioned-review CLI flags + subcommand parse into the
// existing VALUE_FLAGS / WORKFLOW_SUBCOMMANDS machinery (no bespoke parsing).
// ---------------------------------------------------------------------------

function partitionedFlags(extra) {
  return [
    'review-fix-code',
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
    ...extra
  ];
}

test('context --phase unit-review --unit parses unit + phase into the parsed object', () => {
  const parsed = parseWorkflowArgs('context', partitionedFlags(['--phase', 'unit-review', '--unit', 'unit-001']));
  assert.equal(parsed.subcommand, 'context');
  assert.equal(parsed.phase, 'unit-review');
  assert.equal(parsed.unit, 'unit-001');
  assert.equal(parsed.backstop, null);
});

test('context --phase crosscutting --backstop parses backstop + phase', () => {
  const parsed = parseWorkflowArgs('context', partitionedFlags(['--phase', 'crosscutting', '--backstop', 'security-redaction']));
  assert.equal(parsed.phase, 'crosscutting');
  assert.equal(parsed.backstop, 'security-redaction');
  assert.equal(parsed.unit, null);
});

test('record-review --phase unit-review --result-stdin --payload-file parses both payload inputs', () => {
  const parsed = parseWorkflowArgs('record-review', partitionedFlags([
    '--phase', 'unit-review', '--unit', 'unit-001',
    '--result-stdin', '--payload-file', '/tmp/receipt.txt'
  ]));
  assert.equal(parsed.phase, 'unit-review');
  assert.equal(parsed.unit, 'unit-001');
  assert.equal(parsed.payloadFlags.resultStdin, true);
  assert.equal(parsed.payloadFlags.payloadFile, '/tmp/receipt.txt');
});

test('aggregate-review is a known subcommand taking exactly one target-state dir', () => {
  const parsed = parseWorkflowArgs('aggregate-review', ['/abs/target/state/dir', '--json']);
  assert.equal(parsed.subcommand, 'aggregate-review');
  assert.equal(parsed.json, true);
  assert.equal(parsed.targetStateDir, path.resolve('/abs/target/state/dir'));
});

test('aggregate-review rejects --no-state cleanly', () => {
  assert.throws(
    () => parseWorkflowArgs('aggregate-review', ['/abs/dir', '--no-state']),
    (error) => error.code === 'ERR_NO_STATE_COMMAND'
  );
});

test('aggregate-review requires exactly one target-state dir', () => {
  assert.throws(
    () => parseWorkflowArgs('aggregate-review', ['--json']),
    (error) => error.code === 'ERR_TARGET_STATE_DIR'
  );
});

test('unknown --unit-like typo on a non-partitioned subcommand still rejects', () => {
  assert.throws(
    () => parseWorkflowArgs('context', partitionedFlags(['--unitt', 'unit-001'])),
    /Unknown workflow option: --unitt/
  );
});

test('finalize with a single token parses into a target-state dir (guard does not apply)', () => {
  const parsed = parseWorkflowArgs('finalize', ['/abs/target/state/dir']);
  assert.equal(parsed.subcommand, 'finalize');
  assert.equal(parsed.noState, false);
  assert.equal(parsed.targetStateDir, path.resolve('/abs/target/state/dir'));
});

test('finalize without --no-state and without a target-state dir is rejected', async () => {
  // A finalize invocation that parses as a full entry-skill run (>=2 tokens, no
  // --no-state) carries neither noState nor a targetStateDir. Without the guard it
  // would silently fall through to workflowBase and start a fresh workflow run.
  await assert.rejects(
    () => runWorkflowCommand('finalize', ['review-fix-spec', 'target=docs/spec.md']),
    (error) => {
      assert.equal(error.code, 'ERR_WORKFLOW_COMMAND');
      assert.match(error.message, /finalize requires a target-state directory/);
      return true;
    }
  );
});
