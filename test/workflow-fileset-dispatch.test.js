'use strict';

// PLAN-TASK-009 (Phase A): the workflow dispatcher must resolve a FILE-SET target
// context for PR/CODE routes instead of calling deriveTargetKey/computeFingerprint on
// the undefined single-file `parsed.invocation.target`. These tests prove the
// dispatch fallthrough, advisory-downgrade-to-unsupported, and blocked paths resolve a
// route-kind-aware target key (e.g. `pr-<hash>` / `code-<hash>`) and never crash with
// an "undefined target" file-system error.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runWorkflowCommand } = require('../lib/workflow');
const {
  deriveFileSetTargetKey,
  resolveRouteTargetMetadata,
  isFileSetRoute
} = require('../lib/workflow/target-resolution');
const { parseInvocation } = require('../lib/input');

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

function freshRepo(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fileset-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'lib', 'b.js'), 'module.exports = 2;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function parsedFor(entrySkill, tokens) {
  const invocation = parseInvocation(entrySkill, tokens, {
    defaultMode: 'read-only',
    defaultAssurance: null,
    includeMetadata: true
  });
  return { invocation };
}

const R2P_EDITABLE_DOCS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

const PLAN_APPROVED_RUN_MD = [
  '# Requirement Run',
  '',
  '## Status',
  'closed_at_plan_checkpoint',
  '',
  '## Active Artifacts',
  '- plan: approved',
  ''
].join('\n');

// Create a valid r2p requirement directory (<project>/.req-to-plan/WF-*) and
// return the project root. Metadata tests need only the shape, while preflight
// tests exercise the full run.md + 03–07 resolver gate.
function freshR2pProject(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wfDir = path.join(root, '.req-to-plan', 'WF-1');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'run.md'), PLAN_APPROVED_RUN_MD);
  for (const doc of R2P_EDITABLE_DOCS) {
    fs.writeFileSync(path.join(wfDir, doc), `# ${doc}\nContent of ${doc}\n`);
  }
  return root;
}

function writeExecutable(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o755 });
}

function installFakeR2pCli(root, workId) {
  const binDir = path.join(root, 'fake-r2p-bin');
  const statusPayload = JSON.stringify([{
    work_id: workId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }]);
  const scripts = {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" '${statusPayload}'`
    ].join('\n'),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      'printf "%s\\n" \'{"new_work_id":"WF-fake-reopen"}\''
    ].join('\n'),
    'r2p-gap-open': [
      '#!/bin/sh',
      'set -eu',
      'printf "%s\\n" \'{"route_id":"route-fake","staled_stages":["plan"]}\''
    ].join('\n'),
    'r2p-continue': [
      '#!/bin/sh',
      'set -eu',
      'printf "%s\\n" \'{"ok":true}\''
    ].join('\n')
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeExecutable(path.join(binDir, name), body);
  }
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`
  };
}

test('resolveRouteTargetMetadata derives a pr-<hash> file-set key, never deriveTargetKey on undefined target', (t) => {
  const root = freshRepo(t);
  const parsed = parsedFor('review-fix-pr', ['base=main', 'read-only']);
  assert.equal(isFileSetRoute(parsed), true);
  const metadata = resolveRouteTargetMetadata(parsed, { cwd: root });
  assert.equal(metadata.routeKind, 'pr');
  assert.match(metadata.targetKey, /^pr-[0-9a-f]{12}$/);
  assert.equal(metadata.normalizedTarget, null);
  assert.equal(metadata.projectRoot, root);
});

test('resolveRouteTargetMetadata resolves PR cwd subdirectories to the git top level', (t) => {
  const root = freshRepo(t);
  const parsed = parsedFor('review-fix-pr', ['base=main', 'read-only']);
  const metadata = resolveRouteTargetMetadata(parsed, { cwd: path.join(root, 'src') });
  assert.equal(metadata.routeKind, 'pr');
  assert.equal(metadata.projectRoot, root);
});

test('resolveRouteTargetMetadata rejects PR root= values below the git top level', (t) => {
  const root = freshRepo(t);
  const parsed = parsedFor('review-fix-pr', [`root=${path.join(root, 'src')}`, 'base=main', 'read-only']);
  assert.throws(
    () => resolveRouteTargetMetadata(parsed, { cwd: root }),
    (error) => error.code === 'ERR_PR_ROOT_NOT_GIT_TOP_LEVEL'
  );
});

test('resolveRouteTargetMetadata derives a code-<hash> file-set key from sorted scopes', (t) => {
  const root = freshRepo(t);
  const parsedA = parsedFor('review-fix-code', ['scope=src', 'scope=lib', 'read-only']);
  const parsedB = parsedFor('review-fix-code', ['scope=lib', 'scope=src', 'read-only']);
  const keyA = deriveFileSetTargetKey(parsedA);
  const keyB = deriveFileSetTargetKey(parsedB);
  assert.match(keyA, /^code-[0-9a-f]{12}$/);
  assert.equal(keyA, keyB, 'scope order must not change the file-set target key');

  const metadata = resolveRouteTargetMetadata(parsedA, { cwd: root });
  assert.equal(metadata.routeKind, 'code');
  assert.deepEqual(metadata.scopes.slice().sort(), ['lib', 'src']);
});

test('resolveRouteTargetMetadata derives CODE key from normalized scopes, including bare project root', (t) => {
  const root = freshRepo(t);
  const bare = resolveRouteTargetMetadata(parsedFor('review-fix-code', ['read-only']), { cwd: root });
  const dot = resolveRouteTargetMetadata(parsedFor('review-fix-code', ['scope=.', 'read-only']), { cwd: root });
  const srcDot = resolveRouteTargetMetadata(parsedFor('review-fix-code', ['scope=src', 'scope=.', 'read-only']), { cwd: root });
  const src = resolveRouteTargetMetadata(parsedFor('review-fix-code', ['scope=src', 'read-only']), { cwd: root });
  const dotSrc = resolveRouteTargetMetadata(parsedFor('review-fix-code', ['scope=./src', 'read-only']), { cwd: root });

  assert.equal(bare.targetKey, dot.targetKey, 'bare CODE review and scope=. must share state identity');
  assert.equal(bare.targetKey, srcDot.targetKey, 'explicit root scope must cover narrower scopes in state identity');
  assert.deepEqual(bare.scopes, []);
  assert.deepEqual(srcDot.scopes, []);
  assert.equal(src.targetKey, dotSrc.targetKey, 'equivalent scope syntax must share state identity');
  assert.deepEqual(src.scopes, ['src']);
});

test('resolveRouteTargetMetadata does not throw on an invalid CODE scope (resolver reports it as blocked)', (t) => {
  const root = freshRepo(t);
  // Identity-only normalization must never throw: an outside-root scope still derives a
  // deterministic (throwaway) key here, and the scope error surfaces uniformly as a clean
  // blocked result at the resolver layer, not as an uncaught throw during metadata resolution.
  let metadata;
  assert.doesNotThrow(() => {
    metadata = resolveRouteTargetMetadata(parsedFor('review-fix-code', ['scope=../outside', 'read-only']), { cwd: root });
  });
  assert.equal(metadata.routeKind, 'code');
  assert.match(metadata.targetKey, /^code-[0-9a-f]{12}$/);
});

test('a different PR base produces a different file-set target key', (t) => {
  const keyMain = deriveFileSetTargetKey(parsedFor('review-fix-pr', ['base=main']));
  const keyDev = deriveFileSetTargetKey(parsedFor('review-fix-pr', ['base=develop']));
  assert.notEqual(keyMain, keyDev);
});

test('file-set write eligibility preflight supports PR review-and-fix routes', async (t) => {
  const root = freshRepo(t);
  git(root, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 11;\n');
  git(root, ['add', 'src/a.js']);
  git(root, ['commit', '-m', 'feature changes src a']);
  const result = await runWorkflowCommand('preflight', [
    'review-fix-pr',
    'base=main',
    'review-and-fix',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--json'
  ], { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'write-eligible');
  assert.equal(result.routeKind, 'pr');
  assert.match(result.targetKey, /^pr-[0-9a-f]{12}$/);
});

test('file-set write eligibility preflight rejects dirty PR members before any route-owned fix', async (t) => {
  const root = freshRepo(t);
  git(root, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 11;\n');
  git(root, ['add', 'src/a.js']);
  git(root, ['commit', '-m', 'feature changes src a']);
  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// local dirty edit before drfx owns a fix round\n');

  const result = await runWorkflowCommand('preflight', [
    'review-fix-pr',
    'base=main',
    'review-and-fix',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--json'
  ], { cwd: root });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('file-set write eligibility preflight supports bare CODE review-and-fix routes', async (t) => {
  const root = freshRepo(t);
  const result = await runWorkflowCommand('preflight', [
    'review-fix-code',
    'review-and-fix',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--json'
  ], { cwd: root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'write-eligible');
  assert.equal(result.routeKind, 'code');
  assert.deepEqual(result.scopes, []);
});

test('file-set write eligibility preflight lets oversized whole-root CODE reach partitioning', async (t) => {
  const root = freshRepo(t);
  for (let i = 0; i < 301; i++) fs.writeFileSync(path.join(root, `oversize-${i}.js`), 'x\n');

  const result = await runWorkflowCommand('preflight', [
    'review-fix-code',
    'review-and-fix',
    'guard=snapshot',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--json'
  ], { cwd: root });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'write-eligible');
  assert.equal(result.routeKind, 'code');
  assert.deepEqual(result.scopes, []);
  assert.equal(result.targetOnlyGuard.status, 'partitioning-deferred');
  assert.equal(result.targetOnlyGuard.reason, 'whole-root-over-cap');
  assert.equal(result.blockingReason, 'none');
});

test('r2p write eligibility preflight skips git file-set guards', async (t) => {
  const root = freshR2pProject(t);
  const env = installFakeR2pCli(root, 'WF-1');
  const result = await runWorkflowCommand('preflight', [
    'review-fix-r2p',
    'workId=WF-1',
    'review-and-fix',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'not-required',
    '--json'
  ], { cwd: root, env });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'write-eligible');
  assert.equal(result.routeKind, 'r2p');
  assert.equal(result.blockingReason, 'none');
  assert.equal(result.targetOnlyGuard.status, 'not-applicable');
  assert.equal(result.targetOnlyGuard.reason, 'r2p-repair-uses-lifecycle-commands');
});

test('advisory review-and-fix PR start dispatches to unsupported (file-set context resolved, no crash)', async (t) => {
  const root = freshRepo(t);
  const result = await runWorkflowCommand('start', [
    'review-fix-pr',
    'base=main',
    'review-and-fix',
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
  assert.equal(result.status, 'unsupported');
  assert.equal(result.routeKind, 'pr');
  assert.match(result.targetKey, /^pr-[0-9a-f]{12}$/);
  // No document-only identity leaks into a file-set route base.
  assert.equal(result.documentType, 'none');
  assert.equal(result.target, null);
  assert.equal(result.base, 'main');
});

test('read-only PR start falls through to workflowBase with a resolved file-set key', async (t) => {
  const root = freshRepo(t);
  const result = await runWorkflowCommand('start', [
    'review-fix-pr',
    'base=main',
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
  assert.equal(result.routeKind, 'pr');
  assert.match(result.targetKey, /^pr-[0-9a-f]{12}$/);
  assert.equal(result.documentType, 'none');
});

test('PR start root-resolution failures preserve the PR route kind', async (t) => {
  const root = freshRepo(t);
  const missingRoot = path.join(root, 'missing-root');
  const result = await runWorkflowCommand('start', [
    'review-fix-pr',
    `root=${missingRoot}`,
    'base=main',
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
  ], { cwd: root });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.routeKind, 'pr');
  assert.equal(result.errorCode, 'ERR_FILE_SET_ROOT_MISSING');
});

test('read-only CODE start falls through to workflowBase with a resolved file-set key', async (t) => {
  const root = freshRepo(t);
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
  assert.equal(result.routeKind, 'code');
  assert.match(result.targetKey, /^code-[0-9a-f]{12}$/);
  assert.equal(result.documentType, 'none');
  assert.deepEqual(result.scopes, ['src']);
});

test('unavailable stdin handoff blocks a read-only PR start without crashing on undefined target', async (t) => {
  const root = freshRepo(t);
  const result = await runWorkflowCommand('start', [
    'review-fix-pr',
    'base=main',
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'unavailable',
    '--json'
  ], { cwd: root });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unsafe-handoff-file');
  assert.equal(result.routeKind, 'pr');
  assert.match(result.targetKey, /^pr-[0-9a-f]{12}$/);
});

// ---------------------------------------------------------------------------
// .drfxignore and the CODE target identity seed
// ---------------------------------------------------------------------------

test('CODE target key is byte-stable without .drfxignore (empty excludes never enter the seed)', (t) => {
  const root = freshRepo(t);
  const parsed = parsedFor('review-fix-code', ['read-only']);

  // The legacy pre-.drfxignore key comes from the options-free derivation, which
  // never sees user excludes. The metadata-resolved key (which DOES consult
  // .drfxignore) must agree whenever no active exclude exists.
  const legacyKey = deriveFileSetTargetKey(parsed, { normalizedScopes: [] });
  const noFileKey = resolveRouteTargetMetadata(parsed, { cwd: root }).targetKey;
  assert.equal(noFileKey, legacyKey, 'absent .drfxignore must keep the pre-feature target key');

  fs.writeFileSync(path.join(root, '.drfxignore'), '# only comments and blanks\n\n');
  const emptyFileKey = resolveRouteTargetMetadata(parsed, { cwd: root }).targetKey;
  assert.equal(emptyFileKey, legacyKey, 'an effectively-empty .drfxignore must keep the pre-feature target key');
});

test('.drfxignore pattern digests and ORDER are the CODE target identity input', (t) => {
  const root = freshRepo(t);
  const wholeRoot = parsedFor('review-fix-code', ['read-only']);

  const baseKey = resolveRouteTargetMetadata(wholeRoot, { cwd: root }).targetKey;
  fs.writeFileSync(path.join(root, '.drfxignore'), 'lib\n');
  const excludedKey = resolveRouteTargetMetadata(wholeRoot, { cwd: root }).targetKey;
  assert.notEqual(excludedKey, baseKey, 'a pattern list is a different review target');

  // Reordering negation rules changes exclusion semantics (last match wins),
  // so it must change the key too.
  fs.writeFileSync(path.join(root, '.drfxignore'), '*.log\n!keep.log\n');
  const negationLast = resolveRouteTargetMetadata(wholeRoot, { cwd: root }).targetKey;
  fs.writeFileSync(path.join(root, '.drfxignore'), '!keep.log\n*.log\n');
  const negationFirst = resolveRouteTargetMetadata(wholeRoot, { cwd: root }).targetKey;
  assert.notEqual(negationLast, negationFirst, 'pattern ORDER is identity');

  // Patterns are whole-file identity even for scoped runs: glob expansion is
  // filesystem-dependent, so no static scope-relevance filtering applies.
  const scoped = parsedFor('review-fix-code', ['scope=lib', 'read-only']);
  fs.writeFileSync(path.join(root, '.drfxignore'), 'lib\n');
  const scopedWithIgnore = resolveRouteTargetMetadata(scoped, { cwd: root }).targetKey;
  fs.rmSync(path.join(root, '.drfxignore'));
  const scopedWithout = resolveRouteTargetMetadata(scoped, { cwd: root }).targetKey;
  assert.notEqual(scopedWithIgnore, scopedWithout, 'patterns enter the key even when a scope overrides them at walk time');
});

test('a non-existent .drfxignore pattern never throws during identity derivation', (t) => {
  const root = freshRepo(t);
  fs.writeFileSync(path.join(root, '.drfxignore'), 'missing-dir\n');
  const parsed = parsedFor('review-fix-code', ['read-only']);
  let metadata;
  assert.doesNotThrow(() => {
    metadata = resolveRouteTargetMetadata(parsed, { cwd: root });
  });
  assert.match(metadata.targetKey, /^code-[0-9a-f]{12}$/);
});

test('a symlinked .drfxignore never throws during identity derivation and never enters the seed', (t) => {
  const root = freshRepo(t);
  fs.writeFileSync(path.join(root, 'real-ignore'), 'lib\n');
  const parsed = parsedFor('review-fix-code', ['read-only']);
  const cleanKey = resolveRouteTargetMetadata(parsed, { cwd: root }).targetKey;

  fs.symlinkSync(path.join(root, 'real-ignore'), path.join(root, '.drfxignore'));
  let metadata;
  assert.doesNotThrow(() => {
    metadata = resolveRouteTargetMetadata(parsed, { cwd: root });
  });
  // Lenient mode treats the symlinked config as empty: the key stays at the
  // no-excludes form while the resolver reports the actionable error.
  assert.equal(metadata.targetKey, cleanKey);
});
