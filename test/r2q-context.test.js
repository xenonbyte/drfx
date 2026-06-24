'use strict';

// ---------------------------------------------------------------------------
// review-fix-r2q — PERSISTENT (stateful) context resolution (Task 8).
//
// These tests are DETERMINISTIC: no LLM / CLI semantic reviewer runs. The test
// harness builds a real WF-* requirement directory (03–07 + run.md), drives the
// PERSISTENT `start` then `context` workflow commands, and asserts the assembled
// r2q context + the persisted V2 manifest directly.
//
// What they pin:
//   - The assembled r2q context's editable file set is EXACTLY the five 03–07
//     *.md files (run.md is NOT among them).
//   - run.md appears as a PROTECTED read-only dependency (its sha256 fingerprint
//     is carried in the context pack) and is NEVER part of the editable set.
//   - The persisted V2 MANIFEST.md round-trips with targetContextKind:'r2q' and
//     the correct runMdSha256 + fileSetFingerprint (matching resolveR2qTarget).
//   - r2q is dispatched as its own route kind — never mislabeled 'code'.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runWorkflowCommand } = require('../lib/workflow');
const { parseManifestV2 } = require('../lib/workflow-state');
const { resolveR2qTarget } = require('../lib/target-context');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const planApprovedRunMd = [
  '# Requirement Run',
  '',
  '## Status',
  'closed_at_plan_checkpoint',
  '',
  '## Active Artifacts',
  '- plan: approved',
  ''
].join('\n');

const R2Q_EDITABLE_DOCS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

// A git-backed project root (default guard=git for the persistent path) containing
// an active <root>/.req-to-plan/WF-* requirement directory with run.md + 03–07.
function makeR2qProject(t, name = 'WF-20260624-context') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2q-context-')));
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2q-context-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  git(root, ['init', '-b', 'main']);
  const wfDir = path.join(root, '.req-to-plan', name);
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'run.md'), planApprovedRunMd);
  for (const doc of R2Q_EDITABLE_DOCS) {
    fs.writeFileSync(path.join(wfDir, doc), `# ${doc}\nContent of ${doc}\n`);
  }
  // Commit so the default git guard sees a clean worktree at start.
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed requirement']);
  return { root, homeDir, wfDir };
}

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotProtectedFiles(wfDir) {
  const watched = ['run.md', ...R2Q_EDITABLE_DOCS];
  return Object.fromEntries(watched.map((name) => [name, sha256OfFile(path.join(wfDir, name))]));
}

function changedFiles(wfDir, before) {
  return Object.keys(before).filter((name) => before[name] !== sha256OfFile(path.join(wfDir, name)));
}

function projectRelative(root, wfDir, name) {
  return path.relative(root, path.join(wfDir, name)).split(path.sep).join('/');
}

function r2qArgs(wfDir) {
  return [
    'review-fix-r2q',
    `target=${wfDir}`,
    'review-and-fix',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ];
}

// ---------------------------------------------------------------------------
// Persistent context: editable set is exactly 03–07; run.md is protected.
// ---------------------------------------------------------------------------

test('r2q persistent start + context assembles the 03–07 editable set with run.md protected', async (t) => {
  const { root, homeDir, wfDir } = makeR2qProject(t);
  const opts = { cwd: root, homeDir };
  const args = r2qArgs(wfDir);
  const before = snapshotProtectedFiles(wfDir);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.status, 'review');
  assert.equal(start.routeKind, 'r2q', 'r2q must dispatch as its own route kind');
  assert.equal(typeof start.manifestPath, 'string');

  const context = await runWorkflowCommand('context', args, opts);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(context.status, 'context');
  const pack = context.contextPackSkeleton;
  assert.equal(pack.fileSet.routeKind, 'r2q');
  assert.equal(pack.documentType, 'none');
  assert.equal(pack.target, 'none');

  // The editable file set is EXACTLY the five 03–07 docs — run.md is NOT in it.
  const editable = pack.fileSet.files.map((file) => file.path).sort();
  const expectedEditable = R2Q_EDITABLE_DOCS.map((doc) => projectRelative(root, wfDir, doc)).sort();
  assert.deepEqual(editable, expectedEditable);
  assert.ok(!editable.some((file) => file.endsWith('/run.md')), 'run.md must never be in the editable set');

  // The guard baseline must use real on-disk hashes for the same editable file set.
  const guardFiles = pack.reviewerGuardBaseline.files;
  assert.equal(guardFiles.length, R2Q_EDITABLE_DOCS.length);
  assert.ok(guardFiles.every((file) => file.kind === 'file'), 'all r2q guard files must exist on disk');
  assert.ok(guardFiles.every((file) => file.sha256 !== 'none'), 'all r2q guard files must carry real hashes');

  // run.md appears as a PROTECTED read-only dependency, fingerprinted.
  const expected = resolveR2qTarget({ cwd: root, target: wfDir });
  assert.ok(Array.isArray(pack.protectedDependencies), 'protectedDependencies must be present');
  const protectedPaths = pack.protectedDependencies.map((dep) => dep.path);
  assert.deepEqual(protectedPaths, [projectRelative(root, wfDir, 'run.md')]);
  const runMdDep = pack.protectedDependencies[0];
  assert.equal(runMdDep.readOnly, true);
  assert.equal(runMdDep.sha256, expected.runMdSha256);

  // Drift fingerprint covers the editable 03–07 set.
  assert.equal(context.fileSetFingerprint, expected.fileSetFingerprint);

  // Nothing under the requirement directory was mutated by start/context.
  assert.deepEqual(changedFiles(wfDir, before), []);
});

test('r2q persistent start resolves relative target from explicit root outside cwd', async (t) => {
  const { root, homeDir, wfDir } = makeR2qProject(t, 'WF-20260624-root');
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2q-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const args = [
    'review-fix-r2q',
    'target=.req-to-plan/WF-20260624-root',
    'review-and-fix',
    `root=${root}`,
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ];

  const start = await runWorkflowCommand('start', args, { cwd: outside, homeDir });
  assert.equal(start.ok, true, JSON.stringify(start));
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.targetContextKind, 'r2q');
  assert.equal(manifest.requirementDir, path.relative(root, wfDir).split(path.sep).join('/'));
});

test('r2q persistent start resolves relative root from the original cwd when base recomputes from project root', async (t) => {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2q-relative-parent-')));
  const root = path.join(parent, 'proj');
  fs.mkdirSync(root, { recursive: true });
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2q-relative-home-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  git(root, ['init', '-b', 'main']);
  const wfDir = path.join(root, '.req-to-plan', 'WF-20260624-relative-root');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'run.md'), planApprovedRunMd);
  for (const doc of R2Q_EDITABLE_DOCS) {
    fs.writeFileSync(path.join(wfDir, doc), `# ${doc}\nContent of ${doc}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed requirement']);

  const args = [
    'review-fix-r2q',
    'target=.req-to-plan/WF-20260624-relative-root',
    'review-and-fix',
    'root=proj',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ];

  const start = await runWorkflowCommand('start', args, { cwd: parent, homeDir });
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.routeKind, 'r2q');
  assert.equal(start.targetKey, parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).targetKey);
});

// ---------------------------------------------------------------------------
// Persisted manifest round-trips as targetContextKind:'r2q' with run.md
// fingerprint + editable-set fingerprint.
// ---------------------------------------------------------------------------

test('r2q persistent manifest round-trips with targetContextKind r2q + run.md fingerprint', async (t) => {
  const { root, homeDir, wfDir } = makeR2qProject(t, 'WF-20260624-manifest');
  const opts = { cwd: root, homeDir };
  const args = r2qArgs(wfDir);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));

  const expected = resolveR2qTarget({ cwd: root, target: wfDir });
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));

  assert.equal(manifest.targetContextKind, 'r2q');
  assert.equal(manifest.documentType, 'none');
  assert.equal(manifest.runMdSha256, expected.runMdSha256);
  assert.equal(manifest.fileSetFingerprint, expected.fileSetFingerprint);
  // requirementDir is stored project-root-relative, posix-normalized.
  const relRequirementDir = path.relative(root, wfDir).split(path.sep).join('/');
  assert.equal(manifest.requirementDir, relRequirementDir);

  // The manifest has NO CODE/PR identity fields: r2q is neither.
  assert.ok(!Object.hasOwn(manifest, 'base'), 'r2q manifest must not carry a PR base');
  assert.ok(!Object.hasOwn(manifest, 'normalizedScopes'), 'r2q manifest must not carry CODE scopes');

  // run.md is the protected gate, never an editable member: its sha256 is the
  // manifest runMdSha256 and differs from the editable-set fingerprint.
  assert.equal(manifest.runMdSha256, sha256OfFile(path.join(wfDir, 'run.md')));
  assert.notEqual(manifest.runMdSha256, manifest.fileSetFingerprint);
});

test('r2q persistent record-review blocks when protected run.md drifts after context', async (t) => {
  const { root, homeDir, wfDir } = makeR2qProject(t, 'WF-20260624-context-drift');
  const opts = { cwd: root, homeDir };
  const args = r2qArgs(wfDir);

  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));

  const context = await runWorkflowCommand('context', args, opts);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(
    context.contextPackSkeleton.reviewerGuardBaseline.protectedDependencies[0].path,
    projectRelative(root, wfDir, 'run.md')
  );

  fs.appendFileSync(path.join(wfDir, 'run.md'), '\nchanged after reviewer context\n');

  const review = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], {
    ...opts,
    stdin: [
      'PASS',
      'Summary: correctness, regression, safety, tests, contracts, maintainability, platform checked'
    ].join('\n')
  });

  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.status, 'blocked');
  assert.equal(review.blockingReason, 'reviewer-mutated-file');
});

// ---------------------------------------------------------------------------
// The persistent path enforces the run.md gate before writing any state.
// ---------------------------------------------------------------------------

test('r2q persistent start blocks on an incomplete-plan run.md and writes no state', async (t) => {
  const { root, homeDir, wfDir } = makeR2qProject(t, 'WF-20260624-incomplete');
  // Demote run.md to an incomplete plan stage AFTER seeding so the gate fails.
  fs.writeFileSync(path.join(wfDir, 'run.md'), [
    '# Requirement Run',
    '',
    '## Status',
    'active_at_spec_stage',
    '',
    '## Active Artifacts',
    '- spec: active',
    ''
  ].join('\n'));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'demote run.md']);

  const opts = { cwd: root, homeDir };
  const start = await runWorkflowCommand('start', r2qArgs(wfDir), opts);
  assert.equal(start.ok, false, JSON.stringify(start));
  assert.equal(start.status, 'blocked');
  assert.equal(start.errorCode, 'ERR_R2Q_GATE_PLAN_INCOMPLETE');
  assert.equal(start.manifestPath, null);
  assert.equal(fs.existsSync(path.join(root, '.drfx')), false);
});
