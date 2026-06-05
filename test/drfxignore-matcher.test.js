'use strict';

// Corpus tests for the gitignore-syntax .drfxignore matcher. Each case states
// the gitignore rule it mirrors; the expectations follow gitignore(5)
// documented semantics under the pruning model (a matched directory is
// pruned, descendants are never queried).

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDrfxignoreMatcher } = require('../lib/drfxignore-matcher');

test('basename patterns match at any depth; anchored patterns only at the root', () => {
  const m = createDrfxignoreMatcher('build\n/dist\n');
  assert.equal(m.ignores('build', true), true);
  assert.equal(m.ignores('lib/build', true), true);
  assert.equal(m.ignores('dist', true), true);
  assert.equal(m.ignores('lib/dist', true), false, 'leading / anchors to the root');
});

test('a separator inside the pattern anchors it to the root', () => {
  const m = createDrfxignoreMatcher('docs/archive\n');
  assert.equal(m.ignores('docs/archive', true), true);
  assert.equal(m.ignores('lib/docs/archive', true), false);
});

test('trailing slash restricts the pattern to directories', () => {
  const m = createDrfxignoreMatcher('cache/\n');
  assert.equal(m.ignores('cache', true), true);
  assert.equal(m.ignores('cache', false), false, 'a FILE named cache is not matched');
  assert.equal(m.ignores('lib/cache', true), true);
});

test('star and question mark never cross a path separator', () => {
  const m = createDrfxignoreMatcher('*.log\nfile?.txt\n');
  assert.equal(m.ignores('app.log', false), true);
  assert.equal(m.ignores('lib/deep/app.log', false), true);
  assert.equal(m.ignores('file1.txt', false), true);
  assert.equal(m.ignores('file12.txt', false), false);
  const anchored = createDrfxignoreMatcher('lib/*.js\n');
  assert.equal(anchored.ignores('lib/a.js', false), true);
  assert.equal(anchored.ignores('lib/sub/a.js', false), false, '* must not cross /');
});

test('double-star spans path segments in all three documented positions', () => {
  const m = createDrfxignoreMatcher('**/logs\nbuild/**\na/**/b\n');
  assert.equal(m.ignores('logs', true), true);
  assert.equal(m.ignores('x/y/logs', true), true);
  assert.equal(m.ignores('build/anything/deep.txt', false), true);
  assert.equal(m.ignores('a/b', true), true);
  assert.equal(m.ignores('a/x/b', true), true);
  assert.equal(m.ignores('a/x/y/b', true), true);
});

test('negation re-includes with last-match-wins ordering', () => {
  const m = createDrfxignoreMatcher('*.log\n!keep.log\n');
  assert.equal(m.ignores('app.log', false), true);
  assert.equal(m.ignores('keep.log', false), false);
  assert.equal(m.ignores('lib/keep.log', false), false);

  const reversed = createDrfxignoreMatcher('!keep.log\n*.log\n');
  assert.equal(reversed.ignores('keep.log', false), true, 'later rule wins');
});

test('character classes, escapes, comments, and trailing spaces follow gitignore rules', () => {
  const m = createDrfxignoreMatcher([
    '# comment line',
    'file[0-9].txt',
    '\\#literal',
    'spaced   ',
    ''
  ].join('\n'));
  assert.equal(m.ignores('file5.txt', false), true);
  assert.equal(m.ignores('fileA.txt', false), false);
  assert.equal(m.ignores('#literal', false), true, 'escaped hash is a literal pattern');
  assert.equal(m.ignores('spaced', false), true, 'unescaped trailing spaces are trimmed');
});

test('patterns list preserves file order and collapses exact duplicates', () => {
  const m = createDrfxignoreMatcher('*.log\n!keep.log\ndocs\n*.log\n');
  assert.deepEqual(m.patterns, ['*.log', '!keep.log', 'docs']);
});

test('malformed patterns degrade to literals instead of throwing', () => {
  assert.doesNotThrow(() => createDrfxignoreMatcher('a[unterminated\n(((\n'));
  const m = createDrfxignoreMatcher('(((\n');
  assert.equal(m.ignores('(((', false), true);
});

test('dir/** allows re-inclusion inside; dir/ does not (verified against real git behavior)', () => {
  // gitignore(5): `abc/**` matches everything INSIDE abc — the directory itself
  // is not excluded, so a later negation can re-include a file. `abc/` excludes
  // the DIRECTORY, so under the pruning model nothing inside can come back.
  const m = createDrfxignoreMatcher('out/**\n!out/keep.txt\ncachedir/\n!cachedir/keep.txt\n');
  assert.equal(m.ignores('out', true), false, 'out itself is not pruned');
  assert.equal(m.ignores('out/drop.txt', false), true);
  assert.equal(m.ignores('out/keep.txt', false), false, 'negation re-includes under dir/**');
  assert.equal(m.ignores('cachedir', true), true, 'cachedir/ prunes the directory; negation inside is unreachable');
});
