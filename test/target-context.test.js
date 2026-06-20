'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  resolveTargetContext,
  resolveCodeTarget,
  resolveCodeInventory,
  streamingContentId,
  hashFileContent,
  describeCodeBlock,
  computeFileSetFingerprint,
  buildPrIdentity,
  formatPrIdentityFields,
  parsePrIdentityFields,
  comparePrIdentity,
  buildCodeIdentity,
  formatCodeIdentityFields,
  parseCodeIdentityFields,
  normalizeCodeUserExcludesForIdentity,
  compareCodeIdentity
} = require('../lib/target-context');

function digestPattern(pattern) {
  return crypto
    .createHash('sha256')
    .update('drfxignore-pattern\0')
    .update(String(pattern))
    .digest('hex');
}

function digestPatterns(patterns) {
  return patterns.map((pattern) => digestPattern(pattern));
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
}

// Build a local git repo with a `main` branch and a `feature` branch that
// diverges with modified, added, deleted, and renamed files. No remotes.
function makeLocalGitFixture(t, { commandLog } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-pr-ctx-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'keep.js'), 'export const keep = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'remove-me.js'), 'export const gone = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'old-name.js'), 'export const renamed = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);

  git(root, ['checkout', '-b', 'feature']);
  // modify
  fs.writeFileSync(path.join(root, 'src', 'keep.js'), 'export const keep = 2;\n');
  // delete
  fs.rmSync(path.join(root, 'src', 'remove-me.js'));
  // rename (move) old-name.js -> new-name.js with content unchanged so git detects rename
  fs.renameSync(path.join(root, 'src', 'old-name.js'), path.join(root, 'src', 'new-name.js'));
  // add new file
  fs.writeFileSync(path.join(root, 'src', 'added.js'), 'export const added = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'feature work']);

  return {
    root,
    commandLog: Array.isArray(commandLog) ? commandLog : []
  };
}

test('pr resolver returns route kind, base/merge-base/head identity and a file set', async (t) => {
  const fixture = makeLocalGitFixture(t);
  const commandLog = [];
  const context = await resolveTargetContext({
    routeName: 'review-fix-pr',
    base: 'main',
    cwd: fixture.root,
    commandLog
  });

  assert.equal(context.routeKind, 'pr');
  assert.equal(context.base, 'main');
  assert.equal(context.currentBranch, 'feature');
  assert.match(context.head, /^[0-9a-f]{40}$/);
  assert.match(context.baseRevision, /^[0-9a-f]{40}$/);
  assert.match(context.mergeBase, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(context.files) && context.files.length > 0);
  assert.ok(commandLog.length > 0);
});

test('pr resolver never performs git fetch, push, or any ref mutation', async (t) => {
  const fixture = makeLocalGitFixture(t);
  const commandLog = [];
  await resolveTargetContext({ routeName: 'review-fix-pr', base: 'main', cwd: fixture.root, commandLog });

  const joined = commandLog.join('\n');
  assert.doesNotMatch(joined, /\bfetch\b/);
  assert.doesNotMatch(joined, /\bpush\b/);
  assert.doesNotMatch(joined, /\bremote\b/);
  assert.doesNotMatch(joined, /\bpull\b/);
  assert.doesNotMatch(joined, /\bupdate-ref\b/);
});

test('pr resolver discovers modified, deleted, added, and renamed files', async (t) => {
  const fixture = makeLocalGitFixture(t);
  const context = await resolveTargetContext({ routeName: 'review-fix-pr', base: 'main', cwd: fixture.root });

  const byPath = new Map(context.files.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get('src/keep.js').status, 'modified');
  assert.equal(byPath.get('src/remove-me.js').status, 'deleted');
  assert.equal(byPath.get('src/added.js').status, 'added');

  const renamed = context.files.find((entry) => entry.status === 'renamed');
  assert.ok(renamed, 'expected a renamed entry');
  assert.equal(renamed.path, 'src/new-name.js');
  assert.equal(renamed.fromPath, 'src/old-name.js');

  // Every live-resolved entry must carry a per-file identity token that is a
  // 40-hex git blob OID, or 'none' for a deleted path with no HEAD blob.
  for (const entry of context.files) {
    assert.match(
      String(entry.contentId),
      /^([0-9a-f]{40}|none)$/,
      `${entry.path} contentId must be a blob OID or none`
    );
  }
  assert.match(byPath.get('src/keep.js').contentId, /^[0-9a-f]{40}$/);
});

test('pr resolver parses non-ASCII diff paths as real paths with blob identities', async (t) => {
  const fixture = makeLocalGitFixture(t);
  const commandLog = [];
  fs.writeFileSync(path.join(fixture.root, 'src', '中文.js'), 'export const value = 1;\n');
  git(fixture.root, ['add', 'src/中文.js']);
  git(fixture.root, ['commit', '-m', 'add unicode path']);

  const context = await resolveTargetContext({
    routeName: 'review-fix-pr',
    base: 'main',
    cwd: fixture.root,
    commandLog
  });

  const unicode = context.files.find((entry) => entry.path === 'src/中文.js');
  assert.ok(unicode, `expected real unicode path, got ${context.files.map((entry) => entry.path).join(', ')}`);
  assert.equal(unicode.status, 'added');
  assert.match(unicode.contentId, /^[0-9a-f]{40}$/);
  assert.ok(
    commandLog.some((command) => command.includes('diff --name-status -z --find-renames')),
    'PR diff must use NUL-delimited name-status output'
  );
});

test('pr resolver rejects a missing base argument', async (t) => {
  const fixture = makeLocalGitFixture(t);
  await assert.rejects(
    resolveTargetContext({ routeName: 'review-fix-pr', base: '', cwd: fixture.root }),
    (error) => error.code === 'ERR_PR_BASE_MISSING'
  );
});

test('pr resolver rejects an unresolvable base ref', async (t) => {
  const fixture = makeLocalGitFixture(t);
  await assert.rejects(
    resolveTargetContext({ routeName: 'review-fix-pr', base: 'does-not-exist', cwd: fixture.root }),
    (error) => error.code === 'ERR_PR_BASE_UNRESOLVABLE'
  );
});

test('pr resolver refuses when base equals the current branch', async (t) => {
  const fixture = makeLocalGitFixture(t);
  await assert.rejects(
    resolveTargetContext({ routeName: 'review-fix-pr', base: 'feature', cwd: fixture.root }),
    (error) => error.code === 'ERR_PR_BASE_IS_CURRENT_BRANCH'
  );
});

test('pr resolver refuses refs that resolve to HEAD', async (t) => {
  const fixture = makeLocalGitFixture(t);
  const headSha = git(fixture.root, ['rev-parse', 'HEAD']).trim();

  for (const base of ['HEAD', 'refs/heads/feature', headSha]) {
    await assert.rejects(
      resolveTargetContext({ routeName: 'review-fix-pr', base, cwd: fixture.root }),
      (error) => error.code === 'ERR_PR_BASE_IS_HEAD'
    );
  }
});

test('pr resolver fails when there is no merge base between base and HEAD', async (t) => {
  const fixture = makeLocalGitFixture(t);
  // Create an orphan branch with unrelated history (no common ancestor with feature).
  git(fixture.root, ['checkout', '--orphan', 'island']);
  fs.writeFileSync(path.join(fixture.root, 'island.txt'), 'unrelated\n');
  git(fixture.root, ['add', 'island.txt']);
  git(fixture.root, ['commit', '-m', 'island root']);
  // Now we are on `island`; use base `main` which shares no ancestry with this orphan.
  await assert.rejects(
    resolveTargetContext({ routeName: 'review-fix-pr', base: 'main', cwd: fixture.root }),
    (error) => error.code === 'ERR_PR_NO_MERGE_BASE'
  );
});

test('pr resolver resolves a tag base and a commit-sha base', async (t) => {
  const fixture = makeLocalGitFixture(t);
  git(fixture.root, ['tag', 'v0', 'main']);
  const baseSha = git(fixture.root, ['rev-parse', 'main']).trim();

  const tagContext = await resolveTargetContext({ routeName: 'review-fix-pr', base: 'v0', cwd: fixture.root });
  assert.equal(tagContext.baseRevision, baseSha);

  const shaContext = await resolveTargetContext({ routeName: 'review-fix-pr', base: baseSha, cwd: fixture.root });
  assert.equal(shaContext.baseRevision, baseSha);
});

test('code resolver fails instead of silently skipping unreadable in-scope directories', async (t) => {
  const fixture = makeLocalGitFixture(t);
  const blockedDir = path.join(fixture.root, 'src', 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(blockedDir, 'hidden.js'), 'export const hidden = true;\n');

  const originalReaddirSync = fs.readdirSync;
  t.after(() => {
    fs.readdirSync = originalReaddirSync;
  });
  fs.readdirSync = function patchedReaddirSync(directoryPath, options) {
    if (path.resolve(directoryPath) === blockedDir) {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return originalReaddirSync.call(fs, directoryPath, options);
  };

  await assert.rejects(
    resolveCodeTarget({ cwd: fixture.root, scopes: ['src'] }),
    (error) => error.code === 'ERR_CODE_SCOPE_UNREADABLE'
  );
});

test('computeFileSetFingerprint is order-independent and deterministic', () => {
  const a = computeFileSetFingerprint([
    { path: 'b.js', contentId:'b'.repeat(64), status: 'modified' },
    { path: 'a.js', contentId:'a'.repeat(64), status: 'modified' }
  ]);
  const b = computeFileSetFingerprint([
    { path: 'a.js', contentId:'a'.repeat(64), status: 'modified' },
    { path: 'b.js', contentId:'b'.repeat(64), status: 'modified' }
  ]);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);

  const different = computeFileSetFingerprint([
    { path: 'a.js', contentId:'c'.repeat(64), status: 'modified' }
  ]);
  assert.notEqual(a, different);
});

function sampleContext() {
  return {
    routeKind: 'pr',
    base: 'main',
    baseRevision: '1'.repeat(40),
    mergeBase: '2'.repeat(40),
    head: '3'.repeat(40),
    currentBranch: 'feature',
    files: [
      { path: 'src/keep.js', status: 'modified', contentId:'a'.repeat(64) },
      { path: 'src/added.js', status: 'added', contentId:'b'.repeat(64) }
    ]
  };
}

test('buildPrIdentity captures route kind, base/head/merge-base, guard, roundLimit, and file-set fingerprint', () => {
  const identity = buildPrIdentity({ context: sampleContext(), guardMode: 'git', roundLimit: 5 });
  assert.equal(identity.targetContextKind, 'pr');
  assert.equal(identity.base, 'main');
  assert.equal(identity.baseRevision, '1'.repeat(40));
  assert.equal(identity.mergeBase, '2'.repeat(40));
  assert.equal(identity.head, '3'.repeat(40));
  assert.equal(identity.guardMode, 'git');
  assert.equal(identity.roundLimit, '5');
  assert.match(identity.fileSetFingerprint, /^[0-9a-f]{64}$/);
});

test('buildPrIdentity stores roundLimit none when unset', () => {
  const identity = buildPrIdentity({ context: sampleContext(), guardMode: 'git', roundLimit: null });
  assert.equal(identity.roundLimit, 'none');
});

test('pr identity round-trips through format/parse helpers', () => {
  const identity = buildPrIdentity({ context: sampleContext(), guardMode: 'snapshot', roundLimit: 3 });
  const fields = formatPrIdentityFields(identity);
  const parsed = parsePrIdentityFields(fields);
  assert.deepEqual(parsed, identity);
});

test('comparePrIdentity matches identical PR identities on resume', () => {
  const identity = buildPrIdentity({ context: sampleContext(), guardMode: 'git', roundLimit: 2 });
  assert.deepEqual(comparePrIdentity({ stored: identity, requested: identity }), { match: true, mismatches: [] });
});

test('comparePrIdentity flags any drift in base revision, merge-base, head, or file set', () => {
  const stored = buildPrIdentity({ context: sampleContext(), guardMode: 'git', roundLimit: 2 });

  const changedHead = buildPrIdentity({
    context: { ...sampleContext(), head: '9'.repeat(40) },
    guardMode: 'git',
    roundLimit: 2
  });
  assert.equal(comparePrIdentity({ stored, requested: changedHead }).match, false);
  assert.ok(comparePrIdentity({ stored, requested: changedHead }).mismatches.includes('head'));

  const changedMergeBase = buildPrIdentity({
    context: { ...sampleContext(), mergeBase: '8'.repeat(40) },
    guardMode: 'git',
    roundLimit: 2
  });
  assert.ok(comparePrIdentity({ stored, requested: changedMergeBase }).mismatches.includes('mergeBase'));

  const changedFiles = buildPrIdentity({
    context: {
      ...sampleContext(),
      files: [{ path: 'src/keep.js', status: 'modified', contentId:'f'.repeat(64) }]
    },
    guardMode: 'git',
    roundLimit: 2
  });
  assert.ok(comparePrIdentity({ stored, requested: changedFiles }).mismatches.includes('fileSetFingerprint'));
});

test('comparePrIdentity treats a roundLimit drift as a STRICT stale mismatch', () => {
  const stored = buildPrIdentity({ context: sampleContext(), guardMode: 'git', roundLimit: 2 });
  const requested = buildPrIdentity({ context: sampleContext(), guardMode: 'git', roundLimit: 3 });
  const result = comparePrIdentity({ stored, requested });
  assert.equal(result.match, false);
  assert.ok(result.mismatches.includes('roundLimit'));
});

test('comparePrIdentity treats a guard-mode drift as a stale mismatch', () => {
  const stored = buildPrIdentity({ context: sampleContext(), guardMode: 'git', roundLimit: 2 });
  const requested = buildPrIdentity({ context: sampleContext(), guardMode: 'snapshot', roundLimit: 2 });
  assert.ok(comparePrIdentity({ stored, requested }).mismatches.includes('guardMode'));
});

// --- PLAN-TASK-004: CODE identity helpers (PURE) ---

function sampleCodeContext(overrides = {}) {
  return {
    routeKind: 'code',
    normalizedScopes: ['src', 'lib'],
    exclusions: ['.git', 'node_modules'],
    files: [
      { path: 'src/a.js', status: 'present', contentId: 'a'.repeat(64) },
      { path: 'lib/c.js', status: 'present', contentId: 'c'.repeat(64) }
    ],
    ...overrides
  };
}

test('buildCodeIdentity captures kind, normalized scopes/exclusions, guard, roundLimit, and fingerprint', () => {
  const identity = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'git', roundLimit: 4 });
  assert.equal(identity.targetContextKind, 'code');
  // Scopes and exclusions are sorted so order never causes false staleness.
  assert.deepEqual(identity.normalizedScopes, ['lib', 'src']);
  assert.deepEqual(identity.exclusions, ['.git', 'node_modules']);
  assert.equal(identity.guardMode, 'git');
  assert.equal(identity.roundLimit, '4');
  assert.match(identity.fileSetFingerprint, /^[0-9a-f]{64}$/);
});

test('buildCodeIdentity stores roundLimit none when unset', () => {
  const identity = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'git', roundLimit: null });
  assert.equal(identity.roundLimit, 'none');
});

test('buildCodeIdentity rejects a non-code context', () => {
  assert.throws(
    () => buildCodeIdentity({ context: { routeKind: 'pr' }, guardMode: 'git', roundLimit: 1 }),
    (error) => error.code === 'ERR_CODE_IDENTITY'
  );
});

test('code identity round-trips through format/parse helpers including the scope/exclusion lists', () => {
  const identity = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'snapshot', roundLimit: 3 });
  const fields = formatCodeIdentityFields(identity);
  const parsed = parseCodeIdentityFields(fields);
  assert.deepEqual(parsed, identity);
});

test('compareCodeIdentity matches identical CODE identities on resume', () => {
  const identity = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'git', roundLimit: 2 });
  assert.deepEqual(compareCodeIdentity({ stored: identity, requested: identity }), { match: true, mismatches: [] });
});

test('compareCodeIdentity is order-stable: scope ordering does not cause false staleness', () => {
  const stored = buildCodeIdentity({
    context: sampleCodeContext({ normalizedScopes: ['src', 'lib'] }),
    guardMode: 'git',
    roundLimit: 2
  });
  const requested = buildCodeIdentity({
    context: sampleCodeContext({ normalizedScopes: ['lib', 'src'] }),
    guardMode: 'git',
    roundLimit: 2
  });
  assert.deepEqual(compareCodeIdentity({ stored, requested }), { match: true, mismatches: [] });
});

test('compareCodeIdentity flags a scope drift as a STRICT stale mismatch', () => {
  const stored = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'git', roundLimit: 2 });
  const requested = buildCodeIdentity({
    context: sampleCodeContext({ normalizedScopes: ['src'] }),
    guardMode: 'git',
    roundLimit: 2
  });
  const result = compareCodeIdentity({ stored, requested });
  assert.equal(result.match, false);
  assert.ok(result.mismatches.includes('normalizedScopes'));
});

test('compareCodeIdentity tolerates exclusion drift when the file set fingerprint is unchanged', () => {
  const stored = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'git', roundLimit: 2 });
  const requested = buildCodeIdentity({
    context: sampleCodeContext({ exclusions: ['.git'] }),
    guardMode: 'git',
    roundLimit: 2
  });
  assert.deepEqual(compareCodeIdentity({ stored, requested }), { match: true, mismatches: [] });
});

test('compareCodeIdentity reports exclusion drift when the file set fingerprint also changes', () => {
  const stored = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'git', roundLimit: 2 });
  const requested = buildCodeIdentity({
    context: sampleCodeContext({
      exclusions: ['.git'],
      files: [{ path: 'src/a.js', status: 'present', contentId: 'f'.repeat(64) }]
    }),
    guardMode: 'git',
    roundLimit: 2
  });
  const result = compareCodeIdentity({ stored, requested });
  assert.equal(result.match, false);
  assert.ok(result.mismatches.includes('fileSetFingerprint'));
  assert.ok(result.mismatches.includes('exclusions'));
});

test('compareCodeIdentity flags a file-set drift as a STRICT stale mismatch', () => {
  const stored = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'git', roundLimit: 2 });
  const requested = buildCodeIdentity({
    context: sampleCodeContext({
      files: [{ path: 'src/a.js', status: 'present', contentId: 'f'.repeat(64) }]
    }),
    guardMode: 'git',
    roundLimit: 2
  });
  assert.ok(compareCodeIdentity({ stored, requested }).mismatches.includes('fileSetFingerprint'));
});

test('compareCodeIdentity treats a roundLimit drift as a STRICT stale mismatch', () => {
  const stored = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'git', roundLimit: 2 });
  const requested = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'git', roundLimit: 3 });
  const result = compareCodeIdentity({ stored, requested });
  assert.equal(result.match, false);
  assert.ok(result.mismatches.includes('roundLimit'));
});

test('compareCodeIdentity treats a guard-mode drift as a stale mismatch', () => {
  const stored = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'git', roundLimit: 2 });
  const requested = buildCodeIdentity({ context: sampleCodeContext(), guardMode: 'snapshot', roundLimit: 2 });
  assert.ok(compareCodeIdentity({ stored, requested }).mismatches.includes('guardMode'));
});

test('whole-root CODE blocks when the file set exceeds the file-count limit', async (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-bigset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 301; i++) fs.writeFileSync(path.join(dir, `f${i}.js`), 'x\n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'file-set-too-large');
  assert.equal(result.fileCount, 301);
});

test('whole-root CODE count gate blocks before reading file contents', async (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-bigset-early-count-'));
  const rootReal = fs.realpathSync.native(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 301; i++) fs.writeFileSync(path.join(dir, `f${i}.js`), 'x\n');

  const originalReadFileSync = fs.readFileSync;
  let readAttempts = 0;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (typeof filePath === 'string' && filePath.startsWith(`${rootReal}${path.sep}`)) {
      readAttempts += 1;
      throw new Error('whole-root gate should not read file contents before blocking');
    }
    return originalReadFileSync.call(this, filePath, ...args);
  };
  t.after(() => {
    fs.readFileSync = originalReadFileSync;
  });

  const result = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'file-set-too-large');
  assert.equal(result.fileCount, 301);
  assert.equal(readAttempts, 0);
});

test('whole-root CODE blocks when the file set exceeds the byte limit', async (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-bigbytes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'large.js'), 'x'.repeat(1_500_001));

  const result = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'file-set-too-large');
  assert.equal(result.totalBytes, 1_500_001);
});

test('whole-root CODE byte gate blocks before reading file contents', async (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-bigset-early-bytes-'));
  const rootReal = fs.realpathSync.native(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'large.js'), 'x'.repeat(1_500_001));

  const originalReadFileSync = fs.readFileSync;
  let readAttempts = 0;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (typeof filePath === 'string' && filePath.startsWith(`${rootReal}${path.sep}`)) {
      readAttempts += 1;
      throw new Error('whole-root gate should not read file contents before blocking');
    }
    return originalReadFileSync.call(this, filePath, ...args);
  };
  t.after(() => {
    fs.readFileSync = originalReadFileSync;
  });

  const result = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'file-set-too-large');
  assert.equal(result.totalBytes, 1_500_001);
  assert.equal(readAttempts, 0);
});

test('whole-root CODE gate applies to dot, project-root, and root-plus-narrower scopes', async (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-bigset-rootforms-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'small'));
  fs.writeFileSync(path.join(dir, 'small', 'a.js'), 'x\n');
  for (let i = 0; i < 301; i++) fs.writeFileSync(path.join(dir, `f${i}.js`), 'x\n');

  const rootReal = fs.realpathSync.native(dir);
  for (const scopes of [['.'], [rootReal], ['small', '.']]) {
    const result = await resolveCodeTarget({ cwd: dir, scopes });
    assert.equal(result.status, 'blocked', `scopes=${JSON.stringify(scopes)}`);
    assert.equal(result.reason, 'file-set-too-large');
  }
});

test('narrow scope is not subject to the whole-root size gate', async (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-bigset-narrow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 301; i++) fs.writeFileSync(path.join(dir, `f${i}.js`), 'x\n');
  fs.mkdirSync(path.join(dir, 'small'));
  fs.writeFileSync(path.join(dir, 'small', 'a.js'), 'x\n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: ['small'] });
  assert.equal(result.status, undefined); // not blocked
  assert.equal(result.files.length, 1);
});

test('describeCodeBlock is reason-aware', () => {
  assert.match(describeCodeBlock({ reason: 'file-set-too-large', fileCount: 301, totalBytes: 9 }).message, /file-set-too-large/);
  assert.match(describeCodeBlock({ reason: 'excluded-scope', scope: 'node_modules' }).message, /excluded-scope: node_modules/);
});

// ---------------------------------------------------------------------------
// .drfxignore — user-level CODE exclusions
// ---------------------------------------------------------------------------

function makeIgnoreFixture(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'lib', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, 'docs', 'big.md'), 'b\n');
  return dir;
}

test('.drfxignore excludes a directory from the whole-root CODE file set', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-basic-');
  fs.writeFileSync(path.join(dir, '.drfxignore'), '# local excludes\n\ndocs\n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.deepEqual(result.files.map((file) => file.path), ['.drfxignore', 'lib/a.js']);
  assert.deepEqual(result.userExcludes, digestPatterns(['docs']));
  assert.deepEqual(result.userExcludePatterns, ['docs']);
  assert.deepEqual(result.scopeIgnoreOverrides, []);
  assert.equal(result.versionIgnoreSource, 'none', 'temp fixture is not a git worktree');
});

test('.drfxignore shrinks the whole-root file set below the cap', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-cap-');
  fs.writeFileSync(path.join(dir, 'docs', 'huge.md'), 'x'.repeat(1_600_000));

  const blocked = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'file-set-too-large');

  fs.writeFileSync(path.join(dir, '.drfxignore'), 'docs\n');
  const result = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.equal(result.status, undefined);
  assert.deepEqual(result.userExcludes, digestPatterns(['docs']));
  assert.deepEqual(result.userExcludePatterns, ['docs']);
});

test('explicit scope= overrides a covering .drfxignore pattern, reported not silent', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-override-');
  fs.writeFileSync(path.join(dir, '.drfxignore'), 'docs\n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: ['docs'] });
  assert.deepEqual(result.files.map((file) => file.path), ['docs/big.md']);
  assert.deepEqual(result.userExcludes, digestPatterns(['docs']), 'pattern digest stays whole-file identity');
  assert.deepEqual(result.userExcludePatterns, ['docs']);
  assert.deepEqual(result.scopeIgnoreOverrides, ['docs']);
});

test('an explicit FILE scope wins over a .drfxignore pattern that covers it', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-file-scope-');
  fs.writeFileSync(path.join(dir, '.drfxignore'), '*.md\n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: ['docs/big.md'] });
  assert.deepEqual(result.files.map((file) => file.path), ['docs/big.md']);
  assert.deepEqual(result.scopeIgnoreOverrides, ['docs/big.md']);
});

test('an explicit nested scope reports override when an ignored parent covers it', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-parent-override-');
  fs.mkdirSync(path.join(dir, 'docs', 'sub'));
  fs.writeFileSync(path.join(dir, 'docs', 'sub', 'nested.md'), 'nested\n');
  fs.writeFileSync(path.join(dir, '.drfxignore'), 'docs/\n');

  const fileResult = await resolveCodeTarget({ cwd: dir, scopes: ['docs/big.md'] });
  assert.deepEqual(fileResult.files.map((file) => file.path), ['docs/big.md']);
  assert.deepEqual(fileResult.scopeIgnoreOverrides, ['docs/big.md']);

  const dirResult = await resolveCodeTarget({ cwd: dir, scopes: ['docs/sub'] });
  assert.deepEqual(dirResult.files.map((file) => file.path), ['docs/sub/nested.md']);
  assert.deepEqual(dirResult.scopeIgnoreOverrides, ['docs/sub']);
});

test('a .drfxignore entry inside an explicit scope prunes within that scope', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-inside-scope-');
  fs.mkdirSync(path.join(dir, 'lib', 'legacy'));
  fs.writeFileSync(path.join(dir, 'lib', 'legacy', 'old.js'), 'old\n');
  fs.writeFileSync(path.join(dir, '.drfxignore'), 'lib/legacy\n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: ['lib'] });
  assert.deepEqual(result.files.map((file) => file.path), ['lib/a.js']);
  assert.deepEqual(result.userExcludes, digestPatterns(['lib/legacy']));
  assert.deepEqual(result.userExcludePatterns, ['lib/legacy']);
});

test('.drfxignore patterns disjoint from the scopes leave the scoped set intact', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-disjoint-');
  fs.writeFileSync(path.join(dir, '.drfxignore'), 'docs\n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: ['lib'] });
  assert.deepEqual(result.files.map((file) => file.path), ['lib/a.js']);
  assert.deepEqual(result.userExcludes, digestPatterns(['docs']), 'pattern digest is whole-file identity');
  assert.deepEqual(result.userExcludePatterns, ['docs']);
  assert.deepEqual(result.scopeIgnoreOverrides, []);
});

test('.drfxignore patterns are kept verbatim in file order, including semantic duplicates', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-verbatim-');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'));
  fs.writeFileSync(path.join(dir, 'docs', 'plans', 'p.md'), 'p\n');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'));
  fs.writeFileSync(path.join(dir, '.drfxignore'), 'docs\ndocs/plans\nnode_modules/pkg\ndocs\n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.deepEqual(result.userExcludes, digestPatterns(['docs', 'docs/plans', 'node_modules/pkg', 'docs']));
  assert.deepEqual(result.userExcludePatterns, ['docs', 'docs/plans', 'node_modules/pkg', 'docs']);
  assert.deepEqual(result.files.map((file) => file.path), ['.drfxignore', 'lib/a.js']);
});

test('.drfxignore uses gitignore syntax: globs, negation, and non-existent patterns', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-gitignore-syntax-');
  fs.writeFileSync(path.join(dir, 'lib', 'debug.log'), 'log\n');
  fs.writeFileSync(path.join(dir, 'lib', 'keep.log'), 'keep\n');
  // Globs, negation (last match wins), and a pattern matching nothing — all
  // legal gitignore forms; nothing requires entries to exist on disk.
  fs.writeFileSync(path.join(dir, '.drfxignore'), '*.log\n!keep.log\nno-such-dir/\n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['.drfxignore', 'docs/big.md', 'lib/a.js', 'lib/keep.log']
  );
  assert.deepEqual(result.userExcludes, digestPatterns(['*.log', '!keep.log', 'no-such-dir/']));
  assert.deepEqual(result.userExcludePatterns, ['*.log', '!keep.log', 'no-such-dir/']);
});

test('.drfxignore identity patterns preserve leading and escaped trailing spaces', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-spaces-');
  fs.writeFileSync(path.join(dir, ' leading.js'), 'leading\n');
  fs.writeFileSync(path.join(dir, 'trailing.js '), 'trailing\n');
  fs.writeFileSync(path.join(dir, '.drfxignore'), ' leading.js\ntrailing.js\\ \n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.deepEqual(result.userExcludes, digestPatterns([' leading.js', 'trailing.js\\ ']));
  assert.deepEqual(result.userExcludePatterns, [' leading.js', 'trailing.js\\ ']);
  assert.deepEqual(result.files.map((file) => file.path), ['.drfxignore', 'docs/big.md', 'lib/a.js']);
});

test('CODE identity carries userExcludes strictly: edited excludes are stale, same set stays resumable', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-identity-');
  fs.writeFileSync(path.join(dir, '.drfxignore'), 'docs\n');

  const context = await resolveCodeTarget({ cwd: dir, scopes: [] });
  const stored = buildCodeIdentity({ context, guardMode: 'git', roundLimit: null });
  assert.deepEqual(stored.userExcludes, digestPatterns(['docs']));

  // Same .drfxignore ⇒ identity matches.
  const same = buildCodeIdentity({
    context: await resolveCodeTarget({ cwd: dir, scopes: [] }),
    guardMode: 'git',
    roundLimit: null
  });
  assert.deepEqual(compareCodeIdentity({ stored, requested: same }), { match: true, mismatches: [] });

  // Removing the entry changes BOTH the file set and userExcludes: strict mismatch.
  fs.rmSync(path.join(dir, '.drfxignore'));
  const without = buildCodeIdentity({
    context: await resolveCodeTarget({ cwd: dir, scopes: [] }),
    guardMode: 'git',
    roundLimit: null
  });
  const compared = compareCodeIdentity({ stored, requested: without });
  assert.equal(compared.match, false);
  assert.ok(compared.mismatches.includes('userExcludes'));

  // format/parse round-trip preserves the list field.
  const fields = formatCodeIdentityFields(stored);
  assert.deepEqual(parseCodeIdentityFields(fields).userExcludes, digestPatterns(['docs']));
});

test('the file-set-too-large message reports early-termination counts as a floor', () => {
  const described = describeCodeBlock({ reason: 'file-set-too-large', fileCount: 61, totalBytes: 1_514_715 });
  assert.match(described.message, /at least 61 files \/ 1514715\+ bytes \(counting stopped at the cap\)/);
  assert.match(described.nextAction, /\.drfxignore/);
});

test('a symlinked .drfxignore is refused in strict resolution and inert for identity', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-symlink-');
  const realConfig = path.join(dir, 'docs', 'real-ignore');
  fs.writeFileSync(realConfig, 'docs\n');
  fs.symlinkSync(realConfig, path.join(dir, '.drfxignore'));

  await assert.rejects(
    () => resolveCodeTarget({ cwd: dir, scopes: [] }),
    (error) => error.code === 'ERR_CODE_USER_EXCLUDE_CONFIG_SYMLINK'
  );
});

test('a non-regular .drfxignore is refused in strict resolution and inert for identity', async (t) => {
  const dir = makeIgnoreFixture(t, 'drfx-ignore-directory-');
  fs.mkdirSync(path.join(dir, '.drfxignore'));

  await assert.rejects(
    () => resolveCodeTarget({ cwd: dir, scopes: [] }),
    (error) => error.code === 'ERR_CODE_USER_EXCLUDE_CONFIG_NOT_FILE'
  );

  assert.deepEqual(normalizeCodeUserExcludesForIdentity({ cwd: dir }), []);
});

// ---------------------------------------------------------------------------
// Version ignores — git-ignored files are excluded from CODE review
// ---------------------------------------------------------------------------

function makeGitIgnoreFixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-vcs-ignore-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.mkdirSync(path.join(dir, 'generated'));
  fs.writeFileSync(path.join(dir, 'lib', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, 'lib', 'debug.log'), 'log\n');
  fs.writeFileSync(path.join(dir, 'generated', 'out.js'), 'gen\n');
  fs.writeFileSync(path.join(dir, 'tracked.log'), 'tracked\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\ngenerated/\n');
  // tracked.log matches *.log but is COMMITTED: git never ignores tracked files.
  git(dir, ['add', '-f', 'tracked.log']);
  git(dir, ['add', '.gitignore', 'lib/a.js']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

test('git-ignored files and directories are excluded from the CODE file set', async (t) => {
  const dir = makeGitIgnoreFixture(t);
  const result = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.equal(result.versionIgnoreSource, 'git');
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['.gitignore', 'lib/a.js', 'tracked.log'],
    'untracked *.log and generated/ are version-ignored; the TRACKED .log stays reviewable'
  );
});

test('nested .gitignore files are honored through the git query', async (t) => {
  const dir = makeGitIgnoreFixture(t);
  fs.mkdirSync(path.join(dir, 'lib', 'cache'));
  fs.writeFileSync(path.join(dir, 'lib', 'cache', 'c.js'), 'c\n');
  fs.writeFileSync(path.join(dir, 'lib', '.gitignore'), 'cache/\n');

  const result = await resolveCodeTarget({ cwd: dir, scopes: ['lib'] });
  assert.deepEqual(result.files.map((file) => file.path), ['lib/.gitignore', 'lib/a.js']);
});

test('an explicit scope into a git-ignored directory wins and is reported', async (t) => {
  const dir = makeGitIgnoreFixture(t);
  const result = await resolveCodeTarget({ cwd: dir, scopes: ['generated'] });
  assert.deepEqual(result.files.map((file) => file.path), ['generated/out.js']);
  assert.deepEqual(result.scopeIgnoreOverrides, ['generated']);
});

test('the version-ignore git queries are read-only plumbing only', async (t) => {
  const dir = makeGitIgnoreFixture(t);
  const commandLog = [];
  await resolveCodeTarget({ cwd: dir, scopes: [], commandLog });
  assert.ok(commandLog.length > 0);
  for (const command of commandLog) {
    assert.match(command, /^git (rev-parse|ls-files) /);
  }
});

// ---------------------------------------------------------------------------
// PLAN-TASK-002: resolveCodeInventory — whole-tree uncapped inventory builder
// ---------------------------------------------------------------------------

// Helper: create a temp dir with N small files in a flat layout.
function makeFlatFixture(t, prefix, count, contentFn) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.js`), contentFn ? contentFn(i) : `export const f${i} = ${i};\n`);
  }
  return dir;
}

test('streamingContentId produces a byte-identical digest to hashFileContent for a text file', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-streaming-text-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'sample.js');
  fs.writeFileSync(filePath, 'export const x = 42;\n');

  const sync = hashFileContent(filePath);
  const streaming = await streamingContentId(filePath);
  assert.equal(streaming, sync, 'streaming sha256 must equal sync sha256 for the same file');
  assert.match(streaming, /^[0-9a-f]{64}$/);
});

test('streamingContentId is byte-identical to hashFileContent for an empty file', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-streaming-empty-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'empty.txt');
  fs.writeFileSync(filePath, '');

  const sync = hashFileContent(filePath);
  const streaming = await streamingContentId(filePath);
  assert.equal(streaming, sync, 'empty file: streaming digest must equal sync digest');
});

test('streamingContentId is byte-identical to hashFileContent for a binary file', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-streaming-bin-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'binary.bin');
  // Write a buffer with all byte values 0–255 repeated
  const buf = Buffer.alloc(512);
  for (let i = 0; i < 512; i++) buf[i] = i % 256;
  fs.writeFileSync(filePath, buf);

  const sync = hashFileContent(filePath);
  const streaming = await streamingContentId(filePath);
  assert.equal(streaming, sync, 'binary file: streaming digest must equal sync digest');
});

test('resolveCodeInventory returns all surviving files WITHOUT cap truncation', async (t) => {
  // Build a tree with > MAX_WHOLE_ROOT_FILES (300) files.
  // resolveCodeTarget would block with file-set-too-large; resolveCodeInventory must NOT.
  const dir = makeFlatFixture(t, 'drfx-inv-nocap-', 310);

  // Confirm resolveCodeTarget DOES block (sanity check for the fixture).
  const blocked = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'file-set-too-large');

  // resolveCodeInventory must return all 310 files.
  const result = await resolveCodeInventory({ cwd: dir, scopes: [] });
  assert.ok(result && result.inventory, 'result must have an inventory array');
  assert.equal(result.inventory.length, 310, 'inventory must include ALL 310 files, not cap-truncated');
  assert.match(result.projectReviewFingerprint, /^[0-9a-f]{64}$/, 'fingerprint must be a 64-char hex string');
});

test('resolveCodeInventory returns rows with {path,size,ext,contentId} shape', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-shape-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n');

  const result = await resolveCodeInventory({ cwd: dir, scopes: [] });
  assert.ok(Array.isArray(result.inventory));
  for (const row of result.inventory) {
    assert.ok(typeof row.path === 'string' && row.path.length > 0, 'path must be a non-empty string');
    assert.ok(typeof row.size === 'number' && row.size >= 0, 'size must be a non-negative number');
    assert.ok(typeof row.ext === 'string', 'ext must be a string');
    assert.match(row.contentId, /^[0-9a-f]{64}$/, 'contentId must be a 64-char hex string');
  }
  // Paths must be root-relative POSIX (no absolute path, no leading slash)
  for (const row of result.inventory) {
    assert.ok(!path.isAbsolute(row.path), `path must be root-relative: ${row.path}`);
    assert.ok(!row.path.startsWith('/'), `path must not start with /: ${row.path}`);
  }
  // ext must reflect the file extension (including dot, or '' for no-extension files)
  const aRow = result.inventory.find((r) => r.path === 'src/a.js');
  assert.ok(aRow, 'must find src/a.js');
  assert.equal(aRow.ext, '.js');
  const mdRow = result.inventory.find((r) => r.path === 'README.md');
  assert.ok(mdRow, 'must find README.md');
  assert.equal(mdRow.ext, '.md');
});

test('resolveCodeInventory contentIds match hashFileContent (namespace frozen)', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-contentid-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');

  const result = await resolveCodeInventory({ cwd: dir, scopes: [] });
  const row = result.inventory.find((r) => r.path === 'a.js');
  assert.ok(row, 'must find a.js');
  const expected = hashFileContent(path.join(dir, 'a.js'));
  assert.equal(row.contentId, expected, 'inventory contentId must equal hashFileContent digest');
});

test('resolveCodeInventory .drfxignore exclusions still apply', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-ignore-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'lib', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, 'docs', 'big.md'), 'b\n');
  fs.writeFileSync(path.join(dir, '.drfxignore'), 'docs\n');

  const result = await resolveCodeInventory({ cwd: dir, scopes: [] });
  const paths = result.inventory.map((r) => r.path);
  assert.ok(paths.includes('lib/a.js'), 'lib/a.js must be in inventory');
  assert.ok(paths.includes('.drfxignore'), '.drfxignore must be in inventory');
  assert.ok(!paths.includes('docs/big.md'), 'docs/big.md must be excluded by .drfxignore');
});

test('resolveCodeInventory version-ignore (git) exclusions still apply', async (t) => {
  const dir = makeGitIgnoreFixture(t);

  const result = await resolveCodeInventory({ cwd: dir, scopes: [] });
  const paths = result.inventory.map((r) => r.path);
  // tracked.log is tracked by git: NOT excluded
  assert.ok(paths.includes('tracked.log'), 'tracked.log must be in inventory (tracked, not version-ignored)');
  // lib/debug.log matches *.log and is untracked: excluded
  assert.ok(!paths.includes('lib/debug.log'), 'lib/debug.log must be version-ignored');
  // generated/ is a version-ignored directory
  assert.ok(!paths.includes('generated/out.js'), 'generated/out.js must be version-ignored');
});

test('resolveCodeInventory explicit scope= wins over ignore sources', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-scope-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'big.md'), 'b\n');
  fs.writeFileSync(path.join(dir, '.drfxignore'), 'docs\n');

  const result = await resolveCodeInventory({ cwd: dir, scopes: ['docs'] });
  const paths = result.inventory.map((r) => r.path);
  assert.ok(paths.includes('docs/big.md'), 'explicit scope into ignored dir must win');
});

test('resolveCodeInventory excluded basenames (node_modules, .git, dist, etc) are pruned', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-excluded-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x\n');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'bundled\n');

  const result = await resolveCodeInventory({ cwd: dir, scopes: [] });
  const paths = result.inventory.map((r) => r.path);
  assert.ok(paths.includes('src/a.js'), 'src/a.js must be in inventory');
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')), 'node_modules must be excluded');
  assert.ok(!paths.some((p) => p.startsWith('.git/')), '.git must be excluded');
  assert.ok(!paths.some((p) => p.startsWith('dist/')), 'dist must be excluded');
});

test('resolveCodeInventory fingerprint is deterministic and stable for the same tree', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-fp-stable-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b\n');

  const r1 = await resolveCodeInventory({ cwd: dir, scopes: [] });
  const r2 = await resolveCodeInventory({ cwd: dir, scopes: [] });
  assert.equal(r1.projectReviewFingerprint, r2.projectReviewFingerprint, 'same tree => same fingerprint');
});

test('resolveCodeInventory fingerprint changes when a file changes', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-fp-change-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b\n');

  const before = await resolveCodeInventory({ cwd: dir, scopes: [] });
  fs.writeFileSync(path.join(dir, 'a.js'), 'CHANGED\n');
  const after = await resolveCodeInventory({ cwd: dir, scopes: [] });

  assert.notEqual(before.projectReviewFingerprint, after.projectReviewFingerprint,
    'changing a file must change the projectReviewFingerprint');
});

test('resolveCodeInventory fingerprint is order-independent (sorted by path before hashing)', async (t) => {
  // Two dirs with same files but written in different orders on disk.
  // Because inventory is sorted by path before fingerprinting, the fingerprint
  // should be the SAME if the file contents are identical.
  const dir1 = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-fp-ord1-')));
  const dir2 = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-fp-ord2-')));
  t.after(() => {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  });
  // Write files in different orders (the OS may return them in inode order)
  const content = { 'a.js': 'same\n', 'b.js': 'same\n', 'c.js': 'same\n' };
  const keys1 = ['a.js', 'b.js', 'c.js'];
  const keys2 = ['c.js', 'b.js', 'a.js'];
  for (const k of keys1) fs.writeFileSync(path.join(dir1, k), content[k]);
  for (const k of keys2) fs.writeFileSync(path.join(dir2, k), content[k]);

  const r1 = await resolveCodeInventory({ cwd: dir1, scopes: [] });
  const r2 = await resolveCodeInventory({ cwd: dir2, scopes: [] });
  assert.equal(r1.projectReviewFingerprint, r2.projectReviewFingerprint,
    'fingerprint must be order-independent (sorted by path)');
});

test('resolveCodeInventory inventory is sorted by path', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-sorted-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'b\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'r\n');

  const result = await resolveCodeInventory({ cwd: dir, scopes: [] });
  const paths = result.inventory.map((r) => r.path);
  const sorted = [...paths].sort();
  assert.deepEqual(paths, sorted, 'inventory must be sorted by path');
});

test('resolveCodeTarget behavior is unchanged after adding resolveCodeInventory', async (t) => {
  // Sanity: resolveCodeTarget still blocks on over-cap whole-root
  const dir = makeFlatFixture(t, 'drfx-inv-compat-', 310);
  const blocked = await resolveCodeTarget({ cwd: dir, scopes: [] });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'file-set-too-large');

  // And resolveCodeTarget still succeeds on a narrow scope
  const small = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-inv-compat-small-')));
  t.after(() => fs.rmSync(small, { recursive: true, force: true }));
  fs.mkdirSync(path.join(small, 'src'));
  fs.writeFileSync(path.join(small, 'src', 'a.js'), 'a\n');
  const ctx = await resolveCodeTarget({ cwd: small, scopes: ['src'] });
  assert.equal(ctx.routeKind, 'code');
  assert.equal(ctx.files.length, 1);
  assert.equal(ctx.files[0].path, 'src/a.js');
});
