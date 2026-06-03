'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveCodeTarget,
  CODE_EXCLUDED_DIRECTORIES,
  computeFileSetFingerprint
} = require('../lib/target-context');

// Build a project tree with a mix of source files and obvious non-source
// directories (vcs, state, dependency, build, cache, temp). No git is needed:
// CODE traversal walks the working tree directly, not git plumbing.
function makeCodeFixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-code-ctx-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (relative, content) => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };

  // Source files (must be discovered).
  write('src/a.js', 'export const a = 1;\n');
  write('src/nested/b.js', 'export const b = 2;\n');
  write('lib/c.js', 'export const c = 3;\n');
  write('README.md', '# readme\n');

  // Excluded directories (must be pruned).
  write('.git/HEAD', 'ref: refs/heads/main\n');
  write('.docs-review-fix/targets/x/MANIFEST.md', 'state\n');
  write('node_modules/dep/index.js', 'module.exports = {};\n');
  write('dist/bundle.js', 'bundled\n');
  write('build/out.js', 'built\n');
  write('coverage/lcov.info', 'coverage\n');
  write('.cache/blob', 'cache\n');
  write('tmp/scratch.txt', 'temp\n');

  return { root, write };
}

test('code resolver with no scope traverses the whole project root excluding non-source dirs', async (t) => {
  const fixture = makeCodeFixture(t);
  const result = await resolveCodeTarget({ cwd: fixture.root });

  assert.equal(result.routeKind, 'code');
  assert.deepEqual(result.normalizedScopes, []);

  const paths = result.files.map((entry) => entry.path);
  assert.deepEqual(paths, ['README.md', 'lib/c.js', 'src/a.js', 'src/nested/b.js']);

  // None of the excluded directories leak into the file set.
  for (const entry of result.files) {
    assert.doesNotMatch(entry.path, /^\.git\//);
    assert.doesNotMatch(entry.path, /^\.docs-review-fix\//);
    assert.doesNotMatch(entry.path, /^node_modules\//);
    assert.doesNotMatch(entry.path, /^dist\//);
    assert.doesNotMatch(entry.path, /^build\//);
    assert.doesNotMatch(entry.path, /^coverage\//);
    assert.doesNotMatch(entry.path, /^\.cache\//);
    assert.doesNotMatch(entry.path, /^tmp\//);
  }
});

test('code resolver produces deterministic sorted file entries with content hashes', async (t) => {
  const fixture = makeCodeFixture(t);
  const first = await resolveCodeTarget({ cwd: fixture.root });
  const second = await resolveCodeTarget({ cwd: fixture.root });

  assert.deepEqual(first.files, second.files);
  for (const entry of first.files) {
    assert.equal(entry.status, 'present');
    assert.match(entry.contentId, /^[0-9a-f]{64}$/);
  }
  // contentId is a content hash: README.md content hashes to sha256 of its bytes.
  const readme = first.files.find((entry) => entry.path === 'README.md');
  const expected = require('node:crypto').createHash('sha256').update('# readme\n').digest('hex');
  assert.equal(readme.contentId, expected);
});

test('code resolver accepts valid repeated in-root scopes', async (t) => {
  const fixture = makeCodeFixture(t);
  const result = await resolveCodeTarget({ cwd: fixture.root, scopes: ['src', 'lib'] });

  assert.deepEqual(result.normalizedScopes, ['lib', 'src']);
  const paths = result.files.map((entry) => entry.path);
  assert.deepEqual(paths, ['lib/c.js', 'src/a.js', 'src/nested/b.js']);
});

test('code resolver normalizes nested scope paths to posix root-relative form', async (t) => {
  const fixture = makeCodeFixture(t);
  const result = await resolveCodeTarget({ cwd: fixture.root, scopes: ['./src/nested'] });
  assert.deepEqual(result.normalizedScopes, ['src/nested']);
  assert.deepEqual(result.files.map((entry) => entry.path), ['src/nested/b.js']);
});

test('code resolver de-duplicates repeated identical scopes', async (t) => {
  const fixture = makeCodeFixture(t);
  const result = await resolveCodeTarget({ cwd: fixture.root, scopes: ['src', 'src', './src'] });
  assert.deepEqual(result.normalizedScopes, ['src']);
});

test('code resolver rejects a missing scope', async (t) => {
  const fixture = makeCodeFixture(t);
  await assert.rejects(
    resolveCodeTarget({ cwd: fixture.root, scopes: ['does-not-exist'] }),
    (error) => error.code === 'ERR_CODE_SCOPE_MISSING'
  );
});

test('code resolver keeps normalized scopes inside project root', async (t) => {
  const fixture = makeCodeFixture(t);
  await assert.rejects(
    resolveCodeTarget({ cwd: fixture.root, scopes: ['../outside'] }),
    /outside project root/
  );
});

test('code resolver rejects unsafe parent-traversal scopes', async (t) => {
  const fixture = makeCodeFixture(t);
  await assert.rejects(
    resolveCodeTarget({ cwd: fixture.root, scopes: ['src/../../escape'] }),
    /outside project root/
  );
});

test('code resolver rejects a scope that is a symlink escaping the root', async (t) => {
  const fixture = makeCodeFixture(t);
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-code-out-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.js'), 'secret\n');
  fs.symlinkSync(outside, path.join(fixture.root, 'linked'));

  await assert.rejects(
    resolveCodeTarget({ cwd: fixture.root, scopes: ['linked'] }),
    /outside project root/
  );
});

test('code resolver rejects excluded scopes before review starts', async (t) => {
  const fixture = makeCodeFixture(t);
  for (const scope of ['.git', '.docs-review-fix', 'node_modules', 'dist', 'build', 'coverage']) {
    const result = await resolveCodeTarget({ cwd: fixture.root, scopes: [scope] });
    assert.equal(result.status, 'blocked', `scope ${scope} must be blocked`);
    assert.equal(result.reason, 'excluded-scope');
  }
});

test('code resolver does not follow symlinks that escape the root during traversal', async (t) => {
  const fixture = makeCodeFixture(t);
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-code-out2-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.js'), 'secret\n');
  // Place an escaping symlink inside a traversed scope.
  fs.symlinkSync(outside, path.join(fixture.root, 'src', 'linked'));

  const result = await resolveCodeTarget({ cwd: fixture.root, scopes: ['src'] });
  // The escaping symlink and anything under it must never appear.
  for (const entry of result.files) {
    assert.doesNotMatch(entry.path, /linked/);
  }
});

test('code resolver does not read device or special files', async (t) => {
  const fixture = makeCodeFixture(t);
  // A symlink that does NOT escape the root still must not be traversed as a file
  // we hash; we only hash regular files in the working tree.
  fs.symlinkSync(path.join(fixture.root, 'src', 'a.js'), path.join(fixture.root, 'src', 'alias.js'));
  const result = await resolveCodeTarget({ cwd: fixture.root, scopes: ['src'] });
  for (const entry of result.files) {
    assert.doesNotMatch(entry.path, /alias\.js/);
  }
});

test('CODE_EXCLUDED_DIRECTORIES is exported and includes the mandatory non-source dirs', () => {
  assert.ok(CODE_EXCLUDED_DIRECTORIES instanceof Set);
  for (const required of ['.git', '.docs-review-fix', 'node_modules', 'dist', 'build', 'coverage']) {
    assert.ok(CODE_EXCLUDED_DIRECTORIES.has(required), `expected exclusion ${required}`);
  }
});

test('code resolver file set feeds computeFileSetFingerprint deterministically', async (t) => {
  const fixture = makeCodeFixture(t);
  const result = await resolveCodeTarget({ cwd: fixture.root });
  const fingerprint = computeFileSetFingerprint(result.files);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  // A second resolve over an unchanged tree yields the same fingerprint.
  const again = await resolveCodeTarget({ cwd: fixture.root });
  assert.equal(computeFileSetFingerprint(again.files), fingerprint);
});

test('code resolver fingerprint changes when a scoped file content changes', async (t) => {
  const fixture = makeCodeFixture(t);
  const before = computeFileSetFingerprint((await resolveCodeTarget({ cwd: fixture.root, scopes: ['src'] })).files);
  fixture.write('src/a.js', 'export const a = 99;\n');
  const after = computeFileSetFingerprint((await resolveCodeTarget({ cwd: fixture.root, scopes: ['src'] })).files);
  assert.notEqual(before, after);
});
