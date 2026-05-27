'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  captureSnapshot,
  checkSnapshotRollbackAnchor,
  checkSnapshotTargetOnly,
  inspectActualChangedFilesSnapshot,
  restoreSnapshot
} = require('../lib/snapshot-guard');

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  const target = path.join(root, 'docs', 'target.md');
  const sibling = path.join(root, 'docs', 'sibling.md');
  const nested = path.join(root, 'docs', 'nested', 'nested.md');
  const other = path.join(root, 'other', 'file.md');
  const reference = path.join(root, 'refs.md');
  fs.writeFileSync(target, '# Target\n\nOriginal.\n');
  fs.writeFileSync(sibling, '# Sibling\n');
  fs.writeFileSync(nested, '# Nested\n');
  fs.writeFileSync(other, '# Other\n');
  fs.writeFileSync(reference, '# Reference\n');
  const targetStateDir = path.join(root, '.docs-review-fix', 'targets', 'target-md-aaaaaaaaaaaa');
  return { root, target, sibling, nested, other, reference, targetStateDir };
}

test('snapshot rollback anchor rejects missing and symlink targets', (t) => {
  const fixture = makeWorkspace(t);
  fs.rmSync(fixture.target);
  assert.throws(
    () => checkSnapshotRollbackAnchor({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error.blockingReason === 'rollback-unavailable'
  );

  fs.writeFileSync(fixture.target, '# Restored\n');
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-outside-')), 'target.md');
  t.after(() => fs.rmSync(path.dirname(outside), { recursive: true, force: true }));
  fs.writeFileSync(outside, '# Outside\n');
  fs.rmSync(fixture.target);
  fs.symlinkSync(outside, fixture.target);
  assert.throws(
    () => checkSnapshotRollbackAnchor({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error.blockingReason === 'rollback-unavailable'
  );
});

test('snapshot target-only guard monitors project tree files and explicit refs', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    referencePaths: [fixture.reference]
  });
  assert.equal(baseline.status, 'passed');
  assert.equal(baseline.monitorScope, 'project-tree-files-and-references');
  assert.ok(baseline.entries.some((entry) => entry.path === 'docs/nested/nested.md'));
  assert.ok(baseline.entries.some((entry) => entry.path === 'other/file.md'));

  fs.appendFileSync(fixture.target, '\nFixed.\n');
  let actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });
  assert.equal(actual.status, 'passed');
  assert.deepEqual(actual.changedFiles, ['docs/target.md']);

  fs.appendFileSync(fixture.sibling, '\nIn scope.\n');
  actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });
  assert.equal(actual.status, 'blocked');
  assert.equal(actual.blockingReason, 'unexpected-worktree-change');
});

test('snapshot target-only guard blocks reference changes as unexpected worktree changes', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    referencePaths: [fixture.reference]
  });
  fs.appendFileSync(fixture.reference, '\nChanged ref.\n');

  const actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });

  assert.equal(actual.status, 'blocked');
  assert.equal(actual.blockingReason, 'unexpected-worktree-change');
});

test('snapshot target-only guard blocks nested non-target changes', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  fs.appendFileSync(fixture.nested, '\nNested non-target change.\n');

  const actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });

  assert.equal(actual.status, 'blocked');
  assert.equal(actual.blockingReason, 'unexpected-worktree-change');
});

test('snapshot target-only guard blocks non-target changes outside target directory', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  fs.appendFileSync(fixture.target, '\nTarget change.\n');
  fs.appendFileSync(fixture.other, '\nOther project file change.\n');

  const actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });

  assert.equal(actual.status, 'blocked');
  assert.equal(actual.blockingReason, 'unexpected-worktree-change');
  assert.equal(actual.changedFiles, undefined);
});

test('snapshot capture rejects symlinked snapshot parent directory', (t) => {
  const fixture = makeWorkspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-outside-round-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, 'real-round'), { recursive: true });
  fs.mkdirSync(path.join(fixture.targetStateDir, 'snapshots'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'real-round'), path.join(fixture.targetStateDir, 'snapshots', 'round-001'));

  assert.throws(
    () => captureSnapshot({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      targetStateDir: fixture.targetStateDir,
      round: 1,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error && error.blockingReason === 'rollback-unavailable'
  );
});

test('snapshot capture and restore round target body without touching non-target files', (t) => {
  const fixture = makeWorkspace(t);
  const snapshotPath = path.join(fixture.targetStateDir, 'snapshots', 'round-002', 'target.body');
  const snapshot = captureSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 2,
    expectedNormalizedTarget: 'docs/target.md'
  });
  assert.equal(snapshot.status, 'passed');
  assert.equal(fs.existsSync(snapshotPath), true);

  fs.writeFileSync(fixture.target, '# Target\n\nChanged.\n');
  fs.writeFileSync(fixture.sibling, '# Sibling changed outside restore.\n');
  const restored = restoreSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 2,
    expectedNormalizedTarget: 'docs/target.md',
    rollbackAnchor: snapshot
  });

  assert.equal(restored.status, 'passed');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), '# Target\n\nOriginal.\n');
  assert.equal(fs.readFileSync(fixture.sibling, 'utf8'), '# Sibling changed outside restore.\n');
  assert.equal(fs.existsSync(snapshotPath), false);
});

test('snapshot restore returns missing when snapshot body is absent', (t) => {
  const fixture = makeWorkspace(t);
  fs.writeFileSync(fixture.target, '# Target\n\nChanged.\n');

  const restored = restoreSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 3,
    expectedNormalizedTarget: 'docs/target.md'
  });

  assert.equal(restored.status, 'missing');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), '# Target\n\nChanged.\n');
});

test('snapshot capture leaves no .tmp file in the snapshot directory', (t) => {
  const fixture = makeWorkspace(t);
  captureSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 4,
    expectedNormalizedTarget: 'docs/target.md'
  });
  const snapshotDir = path.join(fixture.targetStateDir, 'snapshots', 'round-004');
  const residual = fs.readdirSync(snapshotDir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(residual, []);
});

test('snapshot target-only guard rejects references outside the project root', (t) => {
  const fixture = makeWorkspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-extref-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const externalReference = path.join(outside, 'external-ref.md');
  fs.writeFileSync(externalReference, '# External\n');

  assert.throws(
    () => checkSnapshotTargetOnly({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      allowedStateDir: fixture.targetStateDir,
      expectedNormalizedTarget: 'docs/target.md',
      referencePaths: [externalReference]
    }),
    (error) => {
      assert.equal(error.blockingReason, 'target-only-guard-unavailable');
      assert.equal(error.message.includes(outside), false);
      assert.equal(error.message.includes(externalReference), false);
      return true;
    }
  );
});

test('snapshot guard ignores mtime-only touches when content is unchanged', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  assert.equal(baseline.status, 'passed');

  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(fixture.target, future, future);
  fs.utimesSync(fixture.sibling, future, future);

  const actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });

  assert.equal(actual.status, 'passed');
  assert.deepEqual(actual.changedFiles, []);
});

test('snapshot restore rejects symlinked snapshot parent directory', (t) => {
  const fixture = makeWorkspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-outside-restore-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const realRound = path.join(outside, 'real-round');
  fs.mkdirSync(realRound, { recursive: true });
  fs.writeFileSync(path.join(realRound, 'target.body'), '# Outside body\n');
  fs.mkdirSync(path.join(fixture.targetStateDir, 'snapshots'), { recursive: true });
  fs.symlinkSync(realRound, path.join(fixture.targetStateDir, 'snapshots', 'round-001'));

  assert.throws(
    () => restoreSnapshot({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      targetStateDir: fixture.targetStateDir,
      round: 1,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error && error.blockingReason === 'rollback-unavailable'
  );
});

test('snapshot restore rejects missing target when parent was replaced by symlink', (t) => {
  const fixture = makeWorkspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-parent-symlink-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const snapshot = captureSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 5,
    expectedNormalizedTarget: 'docs/target.md'
  });

  fs.rmSync(path.join(fixture.root, 'docs'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(fixture.root, 'docs'));

  assert.throws(
    () => restoreSnapshot({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      targetStateDir: fixture.targetStateDir,
      round: 5,
      expectedNormalizedTarget: 'docs/target.md',
      rollbackAnchor: snapshot
    }),
    (error) => {
      assert.equal(error.blockingReason, 'rollback-unavailable');
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(outside, 'target.md')), false);
});
