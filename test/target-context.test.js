'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  resolveTargetContext,
  resolveCodeTarget,
  describeCodeBlock,
  computeFileSetFingerprint,
  buildPrIdentity,
  formatPrIdentityFields,
  parsePrIdentityFields,
  comparePrIdentity,
  buildCodeIdentity,
  formatCodeIdentityFields,
  parseCodeIdentityFields,
  compareCodeIdentity
} = require('../lib/target-context');

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
