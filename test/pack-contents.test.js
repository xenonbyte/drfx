'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function packTopLevelEntries() {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  const report = JSON.parse(stdout);
  const files = report[0].files.map((entry) => entry.path);
  return new Set(files.map((p) => (p.includes('/') ? `${p.split('/')[0]}/` : p)));
}

test('npm pack ships exactly the runtime whitelist and no tests', () => {
  const tops = packTopLevelEntries();
  const expected = [
    'README.md',
    'README.zh-CN.md',
    'bin/',
    'lib/',
    'package.json',
    'shared/',
    'skills/',
    'templates/'
  ];
  assert.deepEqual([...tops].sort(), expected);
  assert.equal(tops.has('test/'), false);
});
