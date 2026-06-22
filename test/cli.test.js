'use strict';

// CLI surface tests: drfx version / help / doctor / status / install / uninstall.
// Spawns the real bin with an isolated HOME so install/uninstall never touch the
// developer's real platform roots.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'drfx.js');
const PKG_VERSION = require('../package.json').version;

function run(args, { home, cwd, expectFail = false, input = undefined } = {}) {
  const env = { ...process.env };
  if (home) env.HOME = home;
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      env,
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    if (!expectFail) throw error;
    return { code: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('drfx version / --version / -v print the package version', () => {
  for (const args of [['version'], ['--version'], ['-v']]) {
    assert.equal(run(args).stdout.trim(), PKG_VERSION, args.join(' '));
  }
});

test('drfx help and no-args print the user command list without the internal workflow command', () => {
  for (const args of [['help'], ['--help'], []]) {
    const out = run(args).stdout;
    for (const fragment of ['drfx version', 'drfx doctor', 'drfx status', 'drfx install', 'drfx uninstall']) {
      assert.match(out, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${args.join(' ')} missing ${fragment}`);
    }
    for (const fragment of [
      'drfx doctor    [--platform claude,codex,gemini,opencode] [--json]',
      'drfx status    [--platform claude,codex,gemini,opencode] [--json]',
      'drfx install   [--platform claude,codex,gemini,opencode]',
      'drfx uninstall [--platform claude,codex,gemini,opencode]'
    ]) {
      assert.match(out, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${args.join(' ')} missing ${fragment}`);
    }
    // `workflow` is internal and must stay out of the user-facing help.
    assert.doesNotMatch(out, /drfx workflow/);
  }
});

test('the removed check command reports unknown and exits non-zero', () => {
  const result = run(['check'], { expectFail: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: check/);
});

test('workflow CLI forwards semantic stdin payloads to the dispatcher', (t) => {
  const root = tmpDir(t, 'drfx-cli-workflow-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');

  const commonArgs = [
    'review-fix-code',
    'read-only',
    `root=${root}`,
    'guard=snapshot',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'ready',
    '--runtime-downgrade-reason',
    'none',
    '--phase',
    'initial-review',
    '--json'
  ];
  const context = JSON.parse(run(['workflow', 'context', '--no-state', ...commonArgs]).stdout);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(typeof context.reviewGuard, 'string');

  const review = JSON.parse(run([
    'workflow',
    'record-review',
    '--no-state',
    ...commonArgs,
    '--review-guard',
    context.reviewGuard,
    '--result-stdin'
  ], {
    input: 'PASS\nSummary: correctness, architecture, state-and-io, safety, tests, contracts, maintainability, platform.\n'
  }).stdout);
  assert.equal(review.ok, true, JSON.stringify(review));
  assert.equal(review.status, 'recorded-review');
});

test('drfx status reports not installed for every platform when nothing is installed', (t) => {
  const home = tmpDir(t, 'drfx-cli-home-');
  const out = run(['status'], { home }).stdout;
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    assert.match(out, new RegExp(`${platform}: not installed`));
  }
});

test('install/status/uninstall default --platform to all platforms', (t) => {
  const home = tmpDir(t, 'drfx-cli-home-');
  const work = tmpDir(t, 'drfx-cli-work-');

  const installed = run(['install'], { home, cwd: work }).stdout;
  assert.match(installed, /installed: claude, codex, gemini, opencode/);

  const status = run(['status'], { home }).stdout;
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    assert.match(status, new RegExp(`${platform}: installed \\(v${PKG_VERSION.replace(/\./g, '\\.')}\\)`));
  }

  const uninstalled = run(['uninstall'], { home }).stdout;
  assert.match(uninstalled, /uninstalled: claude, codex, gemini, opencode/);
});
