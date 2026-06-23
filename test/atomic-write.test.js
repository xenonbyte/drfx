'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { atomicWriteFile, atomicCopyFile } = require('../lib/atomic-write');

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-atomic-shared-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function tempSiblings(targetPath) {
  const dir = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`.${basename}.`) && name.endsWith('.tmp'));
}

test('atomicWriteFile writes string content and creates parent directories', (t) => {
  const root = makeSandbox(t);
  const target = path.join(root, 'nested', 'deeper', 'descriptor.json');

  atomicWriteFile(target, 'hello world\n');

  assert.equal(fs.readFileSync(target, 'utf8'), 'hello world\n');
  assert.deepEqual(tempSiblings(target), []);
});

test('atomicWriteFile atomically replaces an existing file', (t) => {
  const root = makeSandbox(t);
  const target = path.join(root, 'lease.json');
  fs.writeFileSync(target, 'old\n');

  atomicWriteFile(target, 'new\n');

  assert.equal(fs.readFileSync(target, 'utf8'), 'new\n');
  assert.deepEqual(tempSiblings(target), []);
});

test('atomicWriteFile preserves existing file mode when replacing content', { skip: process.platform === 'win32' }, (t) => {
  const root = makeSandbox(t);
  const target = path.join(root, 'manifest');
  fs.writeFileSync(target, 'old\n', { mode: 0o600 });
  fs.chmodSync(target, 0o600);

  atomicWriteFile(target, 'new\n');

  assert.equal(fs.readFileSync(target, 'utf8'), 'new\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(tempSiblings(target), []);
});

test('atomicWriteFile preserves raw bytes for Buffer content (no normalization)', (t) => {
  const root = makeSandbox(t);
  const target = path.join(root, 'body.bin');
  // CRLF + a non-UTF8 byte that line-normalization or string coercion would corrupt.
  const buffer = Buffer.from([0x61, 0x0d, 0x0a, 0xff, 0x00, 0x62]);

  atomicWriteFile(target, buffer);

  assert.deepEqual(fs.readFileSync(target), buffer);
});

test('atomicWriteFile leaves no partial file and no temp when beforeRename throws', (t) => {
  const root = makeSandbox(t);
  const target = path.join(root, 'MANIFEST.md');

  assert.throws(
    () =>
      atomicWriteFile(target, '# content\n', {
        beforeRename: () => {
          throw new Error('forced failure before rename');
        }
      }),
    /forced failure before rename/
  );

  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(tempSiblings(target), []);
});

test('atomicWriteFile refuses to replace a directory target and leaves no temp', (t) => {
  const root = makeSandbox(t);
  const target = path.join(root, 'state');
  fs.mkdirSync(target);

  assert.throws(() => atomicWriteFile(target, 'new\n'), /non-regular/);

  assert.equal(fs.lstatSync(target).isDirectory(), true);
  assert.deepEqual(tempSiblings(target), []);
});

test('atomicWriteFile refuses to replace a symlink target and leaves no temp', { skip: process.platform === 'win32' }, (t) => {
  const root = makeSandbox(t);
  const linked = path.join(root, 'linked.txt');
  const target = path.join(root, 'descriptor.json');
  fs.writeFileSync(linked, 'linked\n');
  fs.symlinkSync(linked, target);

  assert.throws(() => atomicWriteFile(target, 'new\n'), /non-regular/);

  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(linked, 'utf8'), 'linked\n');
  assert.deepEqual(tempSiblings(target), []);
});

test('atomicCopyFile copies content and creates parent directories', (t) => {
  const root = makeSandbox(t);
  const source = path.join(root, 'source.txt');
  const dest = path.join(root, 'out', 'copy.txt');
  fs.writeFileSync(source, 'payload\n');

  atomicCopyFile(source, dest);

  assert.equal(fs.readFileSync(dest, 'utf8'), 'payload\n');
  assert.deepEqual(tempSiblings(dest), []);
});

test('atomicCopyFile leaves no temp behind when the source is missing', (t) => {
  const root = makeSandbox(t);
  const source = path.join(root, 'does-not-exist.txt');
  const dest = path.join(root, 'copy.txt');

  assert.throws(() => atomicCopyFile(source, dest));

  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(tempSiblings(dest), []);
});

test('atomicCopyFile refuses to replace a symlink target', { skip: process.platform === 'win32' }, (t) => {
  const root = makeSandbox(t);
  const source = path.join(root, 'src.txt');
  const dest = path.join(root, 'link');
  fs.writeFileSync(source, 'payload\n');
  fs.symlinkSync(source, dest);

  assert.throws(() => atomicCopyFile(source, dest), /non-regular/);
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
  assert.deepEqual(tempSiblings(dest), []);
});

test('atomicCopyFile refuses to replace a directory target', (t) => {
  const root = makeSandbox(t);
  const source = path.join(root, 'src.txt');
  const dest = path.join(root, 'adir');
  fs.writeFileSync(source, 'payload\n');
  fs.mkdirSync(dest);

  assert.throws(() => atomicCopyFile(source, dest), /non-regular/);
  assert.equal(fs.statSync(dest).isDirectory(), true);
  assert.deepEqual(tempSiblings(dest), []);
});

test('atomicCopyFile preserves existing destination mode', { skip: process.platform === 'win32' }, (t) => {
  const root = makeSandbox(t);
  const source = path.join(root, 'src.txt');
  const dest = path.join(root, 'manifest');
  fs.writeFileSync(source, 'NEW CONTENT\n', { mode: 0o644 });
  fs.writeFileSync(dest, 'old\n', { mode: 0o600 });
  fs.chmodSync(dest, 0o600);

  atomicCopyFile(source, dest);

  assert.equal(fs.readFileSync(dest, 'utf8'), 'NEW CONTENT\n');
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  assert.deepEqual(tempSiblings(dest), []);
});
