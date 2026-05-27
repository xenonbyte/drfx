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
  const target = path.join(root, 'docs', 'target.md');
  const sibling = path.join(root, 'docs', 'sibling.md');
  const nested = path.join(root, 'docs', 'nested', 'nested.md');
  const reference = path.join(root, 'refs.md');
  fs.writeFileSync(target, '# Target\n\nOriginal.\n');
  fs.writeFileSync(sibling, '# Sibling\n');
  fs.writeFileSync(nested, '# Nested\n');
  fs.writeFileSync(reference, '# Reference\n');
  const targetStateDir = path.join(root, '.docs-review-fix', 'targets', 'target-md-aaaaaaaaaaaa');
  return { root, target, sibling, nested, reference, targetStateDir };
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

test('snapshot target-only guard monitors target directory direct files and explicit refs only', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    referencePaths: [fixture.reference]
  });
  assert.equal(baseline.status, 'passed');

  fs.appendFileSync(fixture.target, '\nFixed.\n');
  fs.appendFileSync(fixture.nested, '\nOut of scope.\n');
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
