'use strict';

// ---------------------------------------------------------------------------
// review-fix-r2p — END-TO-END lifecycle + gating (Task 13, Milestone 3).
//
// SAFETY-CRITICAL and DETERMINISTIC: no LLM / CLI semantic reviewer runs. The
// six per-task r2p test files already pin each phase in isolation (gate parser,
// advisory path, persistent context, in-place fix, gate-freshness TOCTOU, earned
// PASS / deferral). THIS file's value is threefold and intentionally NOT a re-test
// of those units:
//
//   1. It anchors on a COMMITTED, realistic WF-* requirement fixture
//      (test/fixtures/r2p/approved/) whose 07-plan.md carries a PLANTED PLAN-rubric
//      gap (step 4 caps link requests — observable acceptance behavior — that
//      06-spec.md never states as a criterion). The committed fixture is the
//      canonical INPUT; each test COPIES it into a t-scoped os.tmpdir() sandbox and
//      mutates only the copy.
//
//   2. It runs ONE cohesive end-to-end thread that drives the WHOLE persistent
//      lifecycle on that fixture: start -> context -> initial-review (FAIL) ->
//      triage (accept) -> begin-fix -> harness backward edit to BOTH 07-plan.md AND
//      the owning 06-spec.md -> end-fix -> diff-review -> full-re-review (PASS) ->
//      finalize (earned PASS). The reviewer payload maps the finding to 06-spec.md
//      (the finding->owner-doc map), and the fix report / final response name ONLY
//      those two in-set files.
//
//   3. It threads the cross-cutting matrix on the SAME committed fixture so the
//      gating / drift / editable-set / default-guard / deferral properties are all
//      proven against one realistic artifact rather than ad-hoc inline strings:
//        - Gating: incomplete-plan run.md -> ERR_R2P_GATE_PLAN_INCOMPLETE;
//          archived dir -> ERR_R2P_GATE_ARCHIVED; neither runs a review.
//        - run.md drift mid-run -> guarded drift blocker (no write, no PASS).
//        - Editable-set enforcement: a fix never touches run.md or anything outside
//          03–07 (edits WITHIN 03–07, incl. 07-plan.md, ARE accepted).
//        - Default guard: an UNTRACKED .req-to-plan/WF-* runs with guard=snapshot by
//          DEFAULT (no guard= token); a tracked-clean fixture runs with guard=git.
//        - Earned PASS vs stopped-with-deferrals (human-decision finding).
//
// CRITICAL: the r2p editable set is 03–07 (ALL FIVE), INCLUDING 07-plan.md. run.md
// is the ONLY never-written file. The editable-set test asserts run.md / out-of-set
// writes are refused while in-set edits (incl. 07-plan.md) are accepted.
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
const { parseLedger } = require('../lib/ledger');

// ---------------------------------------------------------------------------
// Committed fixture: the canonical INPUT for every test in this file.
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'r2p');
const APPROVED_DIR = path.join(FIXTURE_ROOT, 'approved');
const PAYLOAD_DIR = path.join(FIXTURE_ROOT, 'payloads');

const R2P_EDITABLE_DOCS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];
const REQUIREMENT_FILES = ['run.md', ...R2P_EDITABLE_DOCS];

function readPayload(name) {
  return fs.readFileSync(path.join(PAYLOAD_DIR, name), 'utf8');
}

// The committed reviewer/triage/diff/re-review payloads are path-independent.
const REVIEW_FAIL = readPayload('upstream-finding.review.txt');
const TRIAGE_ACCEPT = readPayload('upstream-finding.triage.txt');
const DIFF_OK = readPayload('upstream-finding.diff-ok.txt');
const REVIEW_PASS = readPayload('upstream-finding.re-review-pass.txt');
const REVIEW_FAIL_HUMAN = readPayload('human-decision.review.txt');
const TRIAGE_DEFER_USER = readPayload('human-decision.triage.txt');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotRequirementFiles(wfDir) {
  return Object.fromEntries(
    REQUIREMENT_FILES.map((name) => [name, sha256OfFile(path.join(wfDir, name))])
  );
}

function changedFiles(wfDir, before) {
  return Object.keys(before).filter(
    (name) => before[name] !== sha256OfFile(path.join(wfDir, name))
  );
}

function memberPath(root, wfDir, doc) {
  return path.relative(root, path.join(wfDir, doc)).split(path.sep).join('/');
}

// Copy the committed approved fixture into a writable sandbox WF-* dir. The committed
// fixture is canonical; every mutation happens on the COPY. `underArchive` plants the
// copy under .req-to-plan/archive/ (the archived-gate case). `git: true` git-inits and
// commits a clean tree (the tracked-clean / guard=git fixture); `git: false` leaves the
// project UNTRACKED (the default guard=snapshot fixture). `runMdOverride` swaps run.md
// (the incomplete-plan gate case).
function makeSandbox(t, name, { underArchive = false, git: useGit = false, runMdOverride = null } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-e2e-')));
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-e2e-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const parent = underArchive
    ? path.join(root, '.req-to-plan', 'archive')
    : path.join(root, '.req-to-plan');
  const wfDir = path.join(parent, name);
  fs.mkdirSync(wfDir, { recursive: true });
  for (const file of REQUIREMENT_FILES) {
    fs.copyFileSync(path.join(APPROVED_DIR, file), path.join(wfDir, file));
  }
  if (runMdOverride !== null) {
    fs.writeFileSync(path.join(wfDir, 'run.md'), runMdOverride);
  }

  if (useGit) {
    git(root, ['init', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'seed requirement']);
  }

  return { root, homeDir, wfDir };
}

function r2pArgs(wfDir, { mode = 'review-and-fix', routeTokens = [], runtimePlatform = 'codex' } = {}) {
  return [
    'review-fix-r2p',
    `target=${wfDir}`,
    mode,
    ...routeTokens,
    '--assurance',
    'practical',
    '--runtime-platform',
    runtimePlatform,
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ];
}

// Drive start -> context -> record-review(FAIL) -> record-triage(TRIAGE) on the
// persistent path and return the start result + shared opts.
async function reachAfterTriage(root, homeDir, wfDir, { review, triage, routeTokens = [] }) {
  const opts = { cwd: root, homeDir };
  const args = r2pArgs(wfDir, { routeTokens });
  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.routeKind, 'r2p', 'r2p must dispatch as its own route kind');
  await runWorkflowCommand('context', args, opts);
  await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { ...opts, stdin: review });
  const triageResult = await runWorkflowCommand('record-triage', [
    ...args,
    '--triage-stdin'
  ], { ...opts, stdin: triage });
  return { start, opts, args, triageResult };
}

// The harness performs the legal in-place BACKWARD fix: add the missing acceptance
// criterion to the owning 06-spec.md AND reference it from 07-plan.md step 4. Both
// files are inside the 03–07 editable set; run.md is untouched.
function applyBackwardFix(wfDir) {
  const spec = fs.readFileSync(path.join(wfDir, '06-spec.md'), 'utf8');
  fs.writeFileSync(
    path.join(wfDir, '06-spec.md'),
    `${spec}\n### SPEC-4 — Cap link requests per address\n\nGIVEN repeated link requests for one address inside the rolling window\nWHEN the cap is reached\nTHEN the system issues no further link AND returns the identical SPEC-1 response.\n`
  );
  const plan = fs.readFileSync(path.join(wfDir, '07-plan.md'), 'utf8');
  fs.writeFileSync(
    path.join(wfDir, '07-plan.md'),
    plan.replace('Acceptance: (none stated in 06-spec.md).', 'Acceptance: SPEC-4.')
  );
}

// The committed fix-report payload references the two owning in-set files by their
// PROJECT-ROOT-relative path; substitute the sandbox-specific paths in.
function fixReportFor(root, wfDir) {
  return readPayload('upstream-finding.fix-report.txt')
    .replace('{{OWNER_SPEC}}', memberPath(root, wfDir, '06-spec.md'))
    .replace('{{PLAN}}', memberPath(root, wfDir, '07-plan.md'));
}

function finalPassFor(filesChanged) {
  return readPayload('upstream-finding.final-pass.txt').replace('{{FILES_CHANGED}}', filesChanged);
}

// ---------------------------------------------------------------------------
// THE END-TO-END THREAD: the whole persistent lifecycle on the committed fixture,
// with the finding mapped to its owning upstream doc and an EARNED PASS.
// ---------------------------------------------------------------------------

test('e2e: full r2p lifecycle on the committed fixture earns PASS via a finding->06-spec.md backward fix', async (t) => {
  // Tracked-clean fixture (guard=git): a committed, clean worktree.
  const { root, homeDir, wfDir } = makeSandbox(t, 'WF-20260624-magic-link-pass', { git: true });
  const before = snapshotRequirementFiles(wfDir);

  const { start, opts, args } = await reachAfterTriage(root, homeDir, wfDir, {
    review: REVIEW_FAIL,
    triage: TRIAGE_ACCEPT,
    routeTokens: ['guard=git']
  });
  // The reviewer payload maps the upstream finding to 06-spec.md.
  assert.match(REVIEW_FAIL, /06-spec\.md/);
  let manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.guardMode, 'git', 'explicit guard=git is honored');
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.targetContextKind, 'r2p');
  const accepted = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'))
    .issues.find((issue) => issue.id === 'ISSUE-001');
  assert.equal(accepted.status, 'accepted');

  // begin-fix: the writable boundary is EXACTLY the five 03–07 docs; run.md is never monitored.
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(beginFix.monitoredFileCount, R2P_EDITABLE_DOCS.length);
  const guardReport = JSON.parse(
    fs.readFileSync(beginFix.fixGuardReportPath, 'utf8').match(/```json\n([\s\S]*?)\n```/)[1]
  );
  assert.ok(
    !guardReport.monitoredFiles.includes(memberPath(root, wfDir, 'run.md')),
    'run.md must never be monitored/writable'
  );

  // The HARNESS performs the in-place backward fix to BOTH 07-plan.md and the owning 06-spec.md.
  applyBackwardFix(wfDir);

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: fixReportFor(root, wfDir) });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.deepEqual(endFix.fixedIssueIds, ['ISSUE-001']);
  // Exactly the two owning in-set docs changed; run.md is byte-identical (never written).
  assert.deepEqual([...changedFiles(wfDir, before)].sort(), ['06-spec.md', '07-plan.md']);
  assert.equal(sha256OfFile(path.join(wfDir, 'run.md')), before['run.md'], 'run.md must never be written');
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');

  // diff-review -> full-re-review (PASS).
  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { ...opts, stdin: DIFF_OK });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'full-re-review');

  await runWorkflowCommand('context', [...args, '--phase', 'full-re-review'], opts);
  const fullReview = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  // finalize: EARNED PASS. Files changed names ONLY the two in-set owning files.
  const filesChanged = [
    memberPath(root, wfDir, '06-spec.md'),
    memberPath(root, wfDir, '07-plan.md')
  ].sort().join(', ');
  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { ...opts, stdin: finalPassFor(filesChanged) });

  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  assert.equal(final.finalResponse.filesChanged, filesChanged);
  assert.match(final.finalResponse.filesChanged, /06-spec\.md/);
  assert.match(final.finalResponse.filesChanged, /07-plan\.md/);
  // The final response names ONLY in-set files — never run.md, never an out-of-set path.
  assert.ok(!/run\.md/.test(final.finalResponse.filesChanged), 'final response must not name run.md');
  // The accepted execution-state risk note is surfaced.
  assert.match(final.finalResponse.residualRisk, /execution-state/i);
  assert.match(final.finalResponse.residualRisk, /r2p-execute/);

  // The archived terminal manifest records the pass; the ledger marks the issue fixed.
  const archivedManifestPath = path.join(
    final.archivedStatePath,
    path.relative(start.targetStateDir, start.manifestPath)
  );
  assert.equal(parseManifestV2(fs.readFileSync(archivedManifestPath, 'utf8')).status, 'pass');
  const archivedLedgerPath = path.join(
    final.archivedStatePath,
    path.relative(start.targetStateDir, start.ledgerPath)
  );
  const ledger = parseLedger(fs.readFileSync(archivedLedgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'fixed');
});

// ---------------------------------------------------------------------------
// GATING: incomplete-plan run.md and an archived dir both BLOCK; neither runs a review.
// ---------------------------------------------------------------------------

const incompletePlanRunMd = [
  '# Requirement Run',
  '',
  '## Status',
  'active_at_spec_stage',
  '',
  '## Active Artifacts',
  '- spec: active',
  ''
].join('\n');

test('e2e gating: an incomplete-plan run.md blocks with ERR_R2P_GATE_PLAN_INCOMPLETE before any review', async (t) => {
  const { root, homeDir, wfDir } = makeSandbox(t, 'WF-20260624-incomplete', {
    git: true,
    runMdOverride: incompletePlanRunMd
  });
  const opts = { cwd: root, homeDir };
  const args = r2pArgs(wfDir, { routeTokens: ['guard=git'] });

  // The persistent start refuses and writes no state.
  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, false, JSON.stringify(start));
  assert.equal(start.status, 'blocked');
  assert.equal(start.errorCode, 'ERR_R2P_GATE_PLAN_INCOMPLETE');
  assert.equal(start.manifestPath, null);
  assert.equal(fs.existsSync(path.join(root, '.drfx')), false);

  // The advisory no-state path ALSO refuses at context, before any reviewer recording.
  const advisoryArgs = [
    'review-fix-r2p',
    `target=${wfDir}`,
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'manual',
    '--runtime-subagent-probe',
    'not-required',
    '--runtime-stdin-handoff',
    'ready',
    '--runtime-downgrade-reason',
    'none',
    '--phase',
    'initial-review',
    '--json'
  ];
  const context = await runWorkflowCommand('context', ['--no-state', ...advisoryArgs], opts);
  assert.equal(context.ok, false, JSON.stringify(context));
  assert.equal(context.status, 'blocked');
  assert.equal(context.errorCode, 'ERR_R2P_GATE_PLAN_INCOMPLETE');
  const review = await runWorkflowCommand('record-review', [
    '--no-state',
    ...advisoryArgs,
    '--review-guard',
    'placeholder-guard',
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_FAIL });
  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.errorCode, 'ERR_R2P_GATE_PLAN_INCOMPLETE');
  assert.notEqual(review.status, 'recorded-review');
});

test('e2e gating: an archived requirement dir blocks with ERR_R2P_GATE_ARCHIVED before any review', async (t) => {
  // The committed fixture, copied UNDER .req-to-plan/archive/, must be refused as archived.
  const { root, homeDir, wfDir } = makeSandbox(t, 'WF-20260624-archived', {
    git: true,
    underArchive: true
  });
  assert.match(wfDir, /\.req-to-plan\/archive\//, 'fixture lives under the archive dir');
  const opts = { cwd: root, homeDir };

  const start = await runWorkflowCommand('start', r2pArgs(wfDir, { routeTokens: ['guard=git'] }), opts);
  assert.equal(start.ok, false, JSON.stringify(start));
  assert.equal(start.status, 'blocked');
  assert.equal(start.errorCode, 'ERR_R2P_GATE_ARCHIVED');
  assert.equal(fs.existsSync(path.join(root, '.drfx')), false);
});

// ---------------------------------------------------------------------------
// run.md DRIFT mid-run -> guarded drift blocker (no write, no PASS). One representative
// checkpoint on the committed fixture (the per-task gate-freshness suite pins all four).
// ---------------------------------------------------------------------------

test('e2e drift: mutating run.md after triage blocks begin-fix (no write, no PASS)', async (t) => {
  const { root, homeDir, wfDir } = makeSandbox(t, 'WF-20260624-drift', { git: true });
  const before = snapshotRequirementFiles(wfDir);
  const { start, opts } = await reachAfterTriage(root, homeDir, wfDir, {
    review: REVIEW_FAIL,
    triage: TRIAGE_ACCEPT,
    routeTokens: ['guard=git']
  });

  // MUTATE the run.md gate after triage, before begin-fix.
  fs.appendFileSync(path.join(wfDir, 'run.md'), '\n<!-- tampered gate -->\n');

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, false, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'unexpected-worktree-change');
  // No baseline, no diff-review transition, no PASS — and the 03–07 set is untouched.
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'file-set-baseline.json')), false);
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
  assert.deepEqual([...changedFiles(wfDir, before)].sort(), ['run.md']);
});

// ---------------------------------------------------------------------------
// EDITABLE-SET ENFORCEMENT: a fix never touches run.md or any path outside 03–07.
// (Edits WITHIN 03–07, including 07-plan.md, ARE accepted — proven by the e2e thread.)
// ---------------------------------------------------------------------------

test('e2e editable-set: a write to run.md is refused as out-of-set (no diff-review, run.md byte-identical)', async (t) => {
  const { root, homeDir, wfDir } = makeSandbox(t, 'WF-20260624-runmd-refused', { git: true });
  const { start, opts } = await reachAfterTriage(root, homeDir, wfDir, {
    review: REVIEW_FAIL,
    triage: TRIAGE_ACCEPT,
    routeTokens: ['guard=git']
  });

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // A legal in-set edit PLUS an illegal write to the run.md gate.
  applyBackwardFix(wfDir);
  fs.appendFileSync(path.join(wfDir, 'run.md'), '<!-- illegal gate write -->\n');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: fixReportFor(root, wfDir) });
  // run.md is not a member, so the live worktree guard sees an out-of-set change.
  assert.equal(endFix.ok, false, JSON.stringify(endFix));
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'unexpected-worktree-change');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

test('e2e editable-set: a fix report declaring an OUT-OF-SET path is refused', async (t) => {
  const { root, homeDir, wfDir } = makeSandbox(t, 'WF-20260624-outofset-declare', { git: true });
  const { start, opts } = await reachAfterTriage(root, homeDir, wfDir, {
    review: REVIEW_FAIL,
    triage: TRIAGE_ACCEPT,
    routeTokens: ['guard=git']
  });

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // Only an in-set edit happens, but the report DECLARES an out-of-set sibling file.
  applyBackwardFix(wfDir);
  const declaresOutOfSet = [
    'Fixed:',
    '- ISSUE-001: Added SPEC-4 and referenced it (but also claims an out-of-set edit).',
    '',
    'Files changed:',
    `- ${memberPath(root, wfDir, '06-spec.md')}`,
    `- ${memberPath(root, wfDir, '07-plan.md')}`,
    `- ${memberPath(root, wfDir, 'run.md')}`,
    '',
    'Not fixed:',
    '- none',
    '',
    'Verification:',
    '- re-read the docs: passed',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: declaresOutOfSet });

  assert.equal(endFix.ok, false, JSON.stringify(endFix));
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'fix-report-mismatch');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

// ---------------------------------------------------------------------------
// DEFAULT GUARD: an UNTRACKED .req-to-plan/WF-* runs with guard=snapshot by DEFAULT
// (no guard= token). Contrast: the e2e thread above runs the tracked-clean fixture with
// an explicit guard=git.
// ---------------------------------------------------------------------------

test('e2e default guard: an untracked .req-to-plan/WF-* runs with guard=snapshot by default (no guard= token)', async (t) => {
  // NO git init — an untracked project. NO guard= token — r2p defaults to snapshot.
  const { root, homeDir, wfDir } = makeSandbox(t, 'WF-20260624-untracked', { git: false });
  assert.equal(fs.existsSync(path.join(root, '.git')), false, 'project is untracked');
  const before = snapshotRequirementFiles(wfDir);

  const opts = { cwd: root, homeDir };
  const args = r2pArgs(wfDir); // no guard= token
  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.routeKind, 'r2p');
  // The default guard for r2p is snapshot — which is why an untracked tree is not rejected.
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.guardMode, 'snapshot', 'r2p defaults to guard=snapshot');

  await runWorkflowCommand('context', args, opts);
  await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_FAIL });
  const triage = await runWorkflowCommand('record-triage', [...args, '--triage-stdin'], { ...opts, stdin: TRIAGE_ACCEPT });
  assert.equal(triage.ok, true, JSON.stringify(triage));

  // The snapshot-guarded fix accepts an in-set backward edit on the untracked tree.
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  applyBackwardFix(wfDir);
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: fixReportFor(root, wfDir) });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.deepEqual(endFix.fixedIssueIds, ['ISSUE-001']);
  assert.deepEqual([...changedFiles(wfDir, before)].sort(), ['06-spec.md', '07-plan.md']);
  assert.equal(sha256OfFile(path.join(wfDir, 'run.md')), before['run.md'], 'run.md must never be written');
});

// ---------------------------------------------------------------------------
// DEFERRAL: an explicit human-decision finding ends stopped-with-deferrals, NOT pass.
// ---------------------------------------------------------------------------

test('e2e deferral: a human-decision finding ends stopped-with-deferrals (owner+next action), never pass', async (t) => {
  const { root, homeDir, wfDir } = makeSandbox(t, 'WF-20260624-defer', { git: true });
  const { start, opts, triageResult } = await reachAfterTriage(root, homeDir, wfDir, {
    review: REVIEW_FAIL_HUMAN,
    triage: TRIAGE_DEFER_USER,
    routeTokens: ['guard=git']
  });

  // Deferring a high finding to a human stops the run with deferrals at triage time —
  // there is no fix loop and no stopped-pending-human state.
  assert.equal(triageResult.ok, true, JSON.stringify(triageResult));
  const triaged = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(triaged.status, 'stopped-with-deferrals');
  assert.equal(triaged.currentPhase, 'final');
  assert.equal(triaged.statusReason, 'deferred-findings');

  const deferred = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'))
    .issues.find((issue) => issue.id === 'ISSUE-001');
  assert.equal(deferred.status, 'deferred');
  assert.match(deferred.resolution, /owner: user/);
  assert.match(deferred.resolution, /next action: decide the unknown-email behavior/);

  // The committed deferral final response confirms the terminal status; it never reaches pass.
  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { ...opts, stdin: readPayload('human-decision.final-deferral.txt') });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'stopped-with-deferrals');
  assert.notEqual(final.status, 'pass');
  assert.match(final.finalResponse.deferralsOrBlockers, /owner: user/);
  assert.match(final.finalResponse.deferralsOrBlockers, /next action/);
  assert.equal(final.finalResponse.statusReason, 'deferred-findings');
});
