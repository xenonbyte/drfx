'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { formatWorkflowJson, runWorkflowCommand } = require('../lib/workflow');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'workflow-json', 'start-snapshot.json');

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
