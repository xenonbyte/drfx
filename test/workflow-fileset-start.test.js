'use strict';

// PLAN-TASK-009 (Phase B): live PR/CODE file-set state is created in workflow start and
// ONLY there, through the schema/identity helpers. These tests prove a valid file-set
// MANIFEST.md (targetContextKind pr/code) is written and re-parses, that PR/CODE start
// persists practical (never advisory) assurance for review-and-fix, and that a fresh
// start over existing state is refused (ERR_STATE_EXISTS) rather than silently reused.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runWorkflowCommand } = require('../lib/workflow');
const { parseManifestV2 } = require('../lib/workflow-state');
const {
  resolveTargetContext,
  computeFileSetFingerprint
} = require('../lib/target-context');

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

function makePrRepo(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fs-start-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 3;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'feature work']);
  return root;
}

function practicalArgs(extra) {
  return [
    ...extra,
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

const REVIEW_FAIL = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: src/a.js',
  '  issue: The change drops error handling.',
  '  why_it_matters: A failure path now throws unhandled.',
  '  suggested_fix: Restore the try/catch around the call.',
  '  confidence: confirmed',
  '  sensitive: false'
].join('\n');

const TRIAGE_ACCEPT = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: accepted',
  '  severity: high',
  '  original_severity: high',
  '  rationale: The missing error handling blocks merge.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

async function reachFileSetFixStage(root, args) {
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));
  await runWorkflowCommand('context', args, { cwd: root });
  await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...args,
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  return start;
}

function writeOversizeDrift(root) {
  for (let i = 0; i < 301; i++) fs.writeFileSync(path.join(root, `oversize-${i}.js`), 'x\n');
}

function assertFileSetTooLargeBlock(result) {
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.errorCode, 'ERR_FILE_SET_RESOLVE');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(String(result.message), /file-set-too-large/);
  assert.equal(result.nextAction, 'resolve a valid base/scope file set before continuing');
}

test('PR review-and-fix start writes a parseable pr file-set MANIFEST.md and never advisory', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'review');
  assert.equal(result.routeKind, 'pr');
  assert.match(result.targetKey, /^pr-[0-9a-f]{12}$/);
  assert.ok(result.fileSetFingerprint && /^[0-9a-f]{64}$/.test(result.fileSetFingerprint));

  const manifest = parseManifestV2(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.targetContextKind, 'pr');
  assert.equal(manifest.documentType, 'none');
  assert.equal(manifest.mode, 'review-and-fix');
  assert.equal(manifest.assurance, 'practical');
  assert.equal(manifest.base, 'main');
  assert.match(manifest.head, /^[0-9a-f]{40}$/);
  assert.match(manifest.mergeBase, /^[0-9a-f]{40}$/);
  assert.equal(manifest.fileSetFingerprint, result.fileSetFingerprint);
});

test('PR start from a subdirectory writes state at the git root and resolves root-relative diff paths', async (t) => {
  const root = makePrRepo(t);
  const cwd = path.join(root, 'src');
  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd });
  assert.equal(result.ok, true);
  assert.equal(result.routeKind, 'pr');
  assert.equal(
    path.relative(root, result.manifestPath).split(path.sep).join('/').startsWith('.drfx/targets/'),
    true
  );
  assert.equal(fs.existsSync(path.join(cwd, '.drfx')), false);

  const directContext = await resolveTargetContext({ routeName: 'review-fix-pr', base: 'main', cwd: root });
  assert.equal(result.fileSetFingerprint, computeFileSetFingerprint(directContext.files));
  assert.equal(directContext.files.every((entry) => entry.contentId !== 'none'), true);
});

test('CODE review-and-fix start writes a parseable code file-set MANIFEST.md with normalized scopes', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=src']), { cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.routeKind, 'code');
  assert.match(result.targetKey, /^code-[0-9a-f]{12}$/);

  const manifest = parseManifestV2(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.targetContextKind, 'code');
  assert.equal(manifest.documentType, 'none');
  assert.equal(manifest.assurance, 'practical');
  assert.deepEqual(manifest.normalizedScopes, ['src']);
  assert.ok(Array.isArray(manifest.exclusions) && manifest.exclusions.includes('node_modules'));
  assert.match(manifest.fileSetFingerprint, /^[0-9a-f]{64}$/);
});

test('CODE start uses normalized scope identity before refusing existing state', async (t) => {
  const scopedRoot = makePrRepo(t);
  const scoped = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=src']), { cwd: scopedRoot });
  assert.equal(scoped.ok, true);
  await assert.rejects(
    runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=./src']), { cwd: scopedRoot }),
    (error) => error.code === 'ERR_STATE_EXISTS'
  );

  const bareRoot = makePrRepo(t);
  const bare = await runWorkflowCommand('start', practicalArgs(['review-fix-code']), { cwd: bareRoot });
  assert.equal(bare.ok, true);
  await assert.rejects(
    runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=.']), { cwd: bareRoot }),
    (error) => error.code === 'ERR_STATE_EXISTS'
  );
});

test('a second fresh PR start over existing state is refused (no silent resume)', async (t) => {
  const root = makePrRepo(t);
  const first = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(first.ok, true);
  await assert.rejects(
    runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root }),
    (error) => error.code === 'ERR_STATE_EXISTS'
  );
});

test('CODE start with an excluded scope is blocked, not silently empty', async (t) => {
  const root = makePrRepo(t);
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=node_modules']), { cwd: root });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.match(String(result.message), /excluded-scope/);
});

test('CODE start reports file-set-too-large with a reason-aware message', async (t) => {
  const root = makePrRepo(t);
  writeOversizeDrift(root);

  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'guard=snapshot']), { cwd: root });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.match(String(result.message), /file-set-too-large/);
  assert.doesNotMatch(String(result.message), /excluded-scope/);
});

test('CODE persistent context reports file-set-too-large drift as blocked JSON', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'guard=snapshot']), { cwd: root });
  assert.equal(start.ok, true);

  writeOversizeDrift(root);

  const result = await runWorkflowCommand('context', practicalArgs(['review-fix-code', 'guard=snapshot']), { cwd: root });
  assertFileSetTooLargeBlock(result);
});

test('CODE persistent record-review reports file-set-too-large drift as blocked JSON', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'guard=snapshot']);
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true);
  const context = await runWorkflowCommand('context', args, { cwd: root });
  assert.equal(context.ok, true);

  writeOversizeDrift(root);

  const result = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  assertFileSetTooLargeBlock(result);
});

test('CODE persistent record-triage reports file-set-too-large drift as blocked JSON', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'guard=snapshot']);
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true);
  const context = await runWorkflowCommand('context', args, { cwd: root });
  assert.equal(context.ok, true);
  const review = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  assert.equal(review.ok, true);

  writeOversizeDrift(root);

  const result = await runWorkflowCommand('record-triage', [
    ...args,
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  assertFileSetTooLargeBlock(result);
});

test('PR and CODE file-set fixer context only allows resolved file-set members', async (t) => {
  for (const routeTokens of [
    ['review-fix-pr', 'base=main'],
    ['review-fix-code', 'scope=src']
  ]) {
    const root = makePrRepo(t);
    const args = practicalArgs(routeTokens);
    const start = await reachFileSetFixStage(root, args);
    const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
      cwd: root,
      now: new Date('2026-06-03T00:00:00.000Z')
    });
    assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

    const context = await runWorkflowCommand('context', [
      ...args,
      '--phase',
      'fix'
    ], { cwd: root });
    assert.equal(context.ok, true, JSON.stringify(context));
    const contextText = fs.readFileSync(context.contextManifestPath, 'utf8');
    const contextPack = JSON.parse(contextText.match(/```json\n([\s\S]*?)\n```/)[1]);

    assert.deepEqual(contextPack.fixerGuard.expectedChangedFileSet, ['src/a.js', 'src/b.js']);
    assert.deepEqual(
      contextPack.fixerGuard.resolvedFileSetMembers.map((entry) => entry.path),
      ['src/a.js', 'src/b.js']
    );
    assert.equal(Object.hasOwn(contextPack.fixerGuard, 'recordedDependencies'), false);
    assert.match(contextPack.fixerGuard.fileSetWriteRule, /resolved PR\/CODE file set/);
    assert.doesNotMatch(contextPack.fixerGuard.fileSetWriteRule, /dependenc/i);
    assert.doesNotMatch(contextText, /recorded necessary dependenc|recordedDependencies/i);
  }
});

test('rounds=<n> round limit round-trips into the file-set manifest', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'rounds=3']), { cwd: root });
  assert.equal(result.ok, true);
  const manifest = parseManifestV2(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.roundLimit, '3');
});

test('read-only CODE start creates no automatic-fix target state and claims no pass', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('start', [
    'review-fix-code',
    'scope=src',
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ], { cwd: root });
  assert.notEqual(result.status, 'pass');
  assert.equal(fs.existsSync(path.join(root, '.drfx', 'targets')), false);
});

test('PR persistent context executes over the file set after start (Phase C)', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true);

  // context (invocation-based) now executes a real file-set reviewer context-pack.
  const context = await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(context.ok, true);
  assert.equal(context.status, 'context');
  assert.equal(context.contextPackSkeleton.fileSet.routeKind, 'pr');
  assert.ok(context.contextPackSkeleton.fileSet.fileCount >= 1);
  assert.equal(context.contextPackSkeleton.target, 'none');
});

test('PR explicit resume with a matching identity resumes (no silent reuse)', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true);

  // explicit resume with an unchanged file set resumes to the manifest current phase.
  const resume = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'resume']), { cwd: root });
  assert.equal(resume.ok, true);
  assert.equal(resume.status, 'review');
  assert.equal(resume.routeKind, 'pr');
});

test('PR explicit resume compares requested guard and rounds against stored identity', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs([
    'review-fix-pr',
    'base=main',
    'guard=git',
    'rounds=1'
  ]), { cwd: root });
  assert.equal(start.ok, true);

  const guardMismatch = await runWorkflowCommand('start', practicalArgs([
    'review-fix-pr',
    'base=main',
    'guard=snapshot',
    'rounds=1',
    'resume'
  ]), { cwd: root });
  assert.equal(guardMismatch.ok, false);
  assert.equal(guardMismatch.status, 'blocked');
  assert.ok(guardMismatch.staleIdentityFields.includes('guardMode'));

  const roundsMismatch = await runWorkflowCommand('start', practicalArgs([
    'review-fix-pr',
    'base=main',
    'guard=git',
    'rounds=2',
    'resume'
  ]), { cwd: root });
  assert.equal(roundsMismatch.ok, false);
  assert.equal(roundsMismatch.status, 'blocked');
  assert.ok(roundsMismatch.staleIdentityFields.includes('roundLimit'));
});

test('CODE explicit resume tolerates additive default exclusion drift when file set is unchanged', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=src']), { cwd: root });
  assert.equal(start.ok, true);

  const manifestText = fs.readFileSync(start.manifestPath, 'utf8')
    .split('\n')
    .filter((line) => ![
      '- .claude',
      '- .codex',
      '- .codegraph',
      '- .gemini',
      '- .req-to-plan'
    ].includes(line))
    .join('\n');
  fs.writeFileSync(start.manifestPath, manifestText);

  const resume = await runWorkflowCommand('start', practicalArgs([
    'review-fix-code',
    'scope=src',
    'resume'
  ]), { cwd: root });
  assert.equal(resume.ok, true);
  assert.equal(resume.status, 'review');
  assert.equal(resume.routeKind, 'code');
  assert.equal(resume.fileSetFingerprint, start.fileSetFingerprint);
});

test('PR explicit resume refuses a stale identity (changed file set)', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true);

  // Add a new commit so the PR file set / head drifts from the recorded identity.
  fs.writeFileSync(path.join(root, 'src', 'c.js'), 'module.exports = 4;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'more feature work']);

  const resume = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'resume']), { cwd: root });
  assert.equal(resume.ok, false);
  assert.equal(resume.status, 'blocked');
  assert.equal(resume.blockingReason, 'state-validation-failed');
  assert.ok(Array.isArray(resume.staleIdentityFields) && resume.staleIdentityFields.length > 0);
});

test('reset archives stale state and starts fresh, breaking the resume/start deadlock', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true);

  // Drift the file set so the stored identity goes stale.
  fs.writeFileSync(path.join(root, 'src', 'c.js'), 'module.exports = 4;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'more feature work']);

  // Deadlock: resume refuses the stale identity ...
  const staleResume = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'resume']), { cwd: root });
  assert.equal(staleResume.ok, false);
  assert.ok(Array.isArray(staleResume.staleIdentityFields) && staleResume.staleIdentityFields.length > 0);

  // ... and a plain fresh start refuses because state exists.
  await assert.rejects(
    runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root }),
    (error) => error.code === 'ERR_STATE_EXISTS'
  );

  // reset breaks the deadlock: it ARCHIVES the prior state (never deletes) and starts fresh.
  const reset = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'reset']), { cwd: root });
  assert.equal(reset.ok, true);
  assert.equal(reset.status, 'review');
  assert.match(reset.archivedStatePath, /[\\/]\.drfx[\\/]archived[\\/]pr-/);
  assert.equal(fs.existsSync(reset.archivedStatePath), true);
  assert.equal(fs.existsSync(path.join(reset.archivedStatePath, 'MANIFEST.md')), true, 'old state is preserved in the archive');
  // The fresh manifest is recomputed over the current file set, not the stale one.
  assert.notEqual(reset.fileSetFingerprint, start.fileSetFingerprint);
  assert.equal(fs.existsSync(start.manifestPath), true);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fileSetFingerprint, reset.fileSetFingerprint);
});

test('reset with no existing state starts fresh without archiving', async (t) => {
  const root = makePrRepo(t);
  const reset = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'reset']), { cwd: root });
  assert.equal(reset.ok, true);
  assert.equal(reset.status, 'review');
  assert.equal(reset.archivedStatePath, undefined, 'nothing to archive when no prior state exists');
  assert.equal(fs.existsSync(path.join(root, '.drfx', 'archived')), false);
});

test('resume and reset tokens are mutually exclusive', async (t) => {
  const root = makePrRepo(t);
  await assert.rejects(
    runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'resume', 'reset']), { cwd: root }),
    (error) => error.code === 'ERR_CONFLICTING_RESUME_RESET'
  );
});

test('read-only no-state CODE review never creates auto-fix state and never claims pass', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('context', [
    'review-fix-code',
    'scope=src',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ], { cwd: root });
  assert.notEqual(result.status, 'pass');
  assert.equal(result.mode, 'read-only');
  assert.equal(fs.existsSync(path.join(root, '.drfx', 'targets')), false);
});

test('CODE start with .drfxignore persists User excludes in the manifest and surfaces them in the result', async (t) => {
  const root = makePrRepo(t);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'notes.md'), 'notes\n');
  fs.writeFileSync(path.join(root, '.drfxignore'), '# local\ndocs\n');

  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-code']), { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.userExcludes, ['docs']);

  const manifestText = fs.readFileSync(result.manifestPath, 'utf8');
  assert.match(manifestText, /User excludes:\n- [a-f0-9]{64}/);
  assert.doesNotMatch(manifestText, /^- docs$/m);

  // The excluded directory never enters the reviewed file set.
  const contextResult = await runWorkflowCommand('context', practicalArgs(['review-fix-code']), { cwd: root });
  assert.equal(contextResult.ok, true, JSON.stringify(contextResult));
  const contextManifest = fs.readFileSync(contextResult.contextManifestPath, 'utf8');
  assert.doesNotMatch(contextManifest, /docs\/notes\.md/);
  assert.match(contextManifest, /userExcludes/);
});

test('CODE .drfxignore sensitive patterns use redacted output and digest resume identity', async (t) => {
  const root = makePrRepo(t);
  const sensitivePattern = 'secret=super-sensitive-token';
  fs.writeFileSync(path.join(root, '.drfxignore'), `${sensitivePattern}\n`);

  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-code']), { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.userExcludes, ['secret=[REDACTED:credential]']);
  assert.doesNotMatch(JSON.stringify(result), /super-sensitive-token/);

  const manifestText = fs.readFileSync(result.manifestPath, 'utf8');
  assert.match(manifestText, /User excludes:\n- [a-f0-9]{64}/);
  assert.doesNotMatch(manifestText, /super-sensitive-token/);
  assert.doesNotMatch(manifestText, /\[REDACTED:credential\]/);

  const resumed = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'resume']), { cwd: root });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.notEqual(resumed.errorCode, 'ERR_FILE_SET_STALE_IDENTITY');
});
