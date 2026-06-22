'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { writeGeneratedFile } = require('../lib/install');

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-atomic-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function tempSiblings(dir, targetPath) {
  const basename = path.basename(targetPath);
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`.${basename}.`) && name.endsWith('.tmp'));
}

test('writeGeneratedFile writes content and creates parent directories', (t) => {
  const root = makeSandbox(t);
  const target = path.join(root, 'nested', 'deep', 'command.md');

  writeGeneratedFile(target, 'hello world\n');

  assert.equal(fs.readFileSync(target, 'utf8'), 'hello world\n');
  // No temp sibling is left behind on success.
  assert.deepEqual(tempSiblings(path.dirname(target), target), []);
});

test('writeGeneratedFile atomically replaces an existing file', (t) => {
  const root = makeSandbox(t);
  const target = path.join(root, 'command.md');
  fs.writeFileSync(target, 'old content\n');

  writeGeneratedFile(target, 'new content\n');

  assert.equal(fs.readFileSync(target, 'utf8'), 'new content\n');
  assert.deepEqual(tempSiblings(root, target), []);
});

test('writeGeneratedFile refuses a directory target and leaves it untouched with no temp', (t) => {
  const root = makeSandbox(t);
  // A non-regular target (here a directory) is rejected before any temp is staged.
  const target = path.join(root, 'command.md');
  fs.mkdirSync(target);

  assert.throws(() => writeGeneratedFile(target, 'content\n'), /non-regular/);

  // The directory target is untouched, and no orphaned temp remains.
  assert.equal(fs.statSync(target).isDirectory(), true);
  assert.deepEqual(tempSiblings(root, target), []);
});
