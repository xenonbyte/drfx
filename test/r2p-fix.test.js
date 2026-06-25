'use strict';

// ---------------------------------------------------------------------------
// review-fix-r2p — PERSISTENT (stateful) in-place backward-fix lifecycle (Task 9).
//
// SAFETY-CRITICAL. These tests are DETERMINISTIC: no LLM / CLI semantic reviewer
// runs. The harness builds a real git-backed WF-* requirement directory
// (03–07 + run.md), drives the persistent workflow to the fix phase with EXPLICIT
// accepted-issue payloads, performs the allowed in-place edits ITSELF, and asserts
// the real workflow status / error / no-write behavior.
//
// What they pin:
//   (a) An r2p review-and-fix run edits ONLY files inside the 03–07 set (07-plan
//       plus the mapped owning upstream doc). The harness edits BOTH 07-plan.md and
//       06-spec.md, submits a matching fix report, and the workflow ACCEPTS exactly
//       those in-set changes (status → diff-review).
//   (b) An attempt to modify run.md (or any path OUTSIDE 03–07) is REFUSED by the
//       file-set guard as an out-of-set / unexpected-worktree change — no diff-review
//       transition, no PASS, and run.md is left byte-identical.
//   (c) The fix phase requires a CLEAN guard over the set before the first write: a
//       dirty/unreviewed in-set change after triage blocks begin-fix.
//
// The fixer edits in place — no versions, no checkpoints, no reopen, NO run.md write.
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

const R2P_EDITABLE_DOCS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

// Explicit reviewer FAIL payload: a PLAN-rubric finding whose ROOT CAUSE is an
// acceptance/behavior gap. Per the finding->owner-doc map the owner is 06-spec.md, so
// the backward fix edits BOTH 07-plan.md and the upstream 06-spec.md.
const REVIEW_FAIL = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: 07-plan.md#step-3',
  '  issue: Step 3 implements acceptance behavior that 06-spec.md never states.',
  '  why_it_matters: The plan executes behavior with no spec backing, so it can drift from intended behavior.',
  '  suggested_fix: Add the acceptance criterion to 06-spec.md, then reference it from the plan step.',
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
  '  rationale: Acceptance/behavior gap whose owner doc is 06-spec.md.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

// The fixer's writable boundary is the 03–07 docs resolved to PROJECT-ROOT-relative paths
// (the docs live under the requirement directory). The reviewer pack still labels them by
// the short doc name; the guard / fix report use the project-relative path.
function memberPath(root, wfDir, doc) {
  return path.relative(root, path.join(wfDir, doc)).split(path.sep).join('/');
}

// Fix report crediting the in-place backward fix to BOTH the plan and the owning
// upstream doc — every declared file is inside the 03–07 editable set.
function fixReportBackward(root, wfDir) {
  return [
    'Fixed:',
    '- ISSUE-001: Added the acceptance criterion to 06-spec.md and referenced it from 07-plan.md step 3.',
    '',
    'Files changed:',
    `- ${memberPath(root, wfDir, '06-spec.md')}`,
    `- ${memberPath(root, wfDir, '07-plan.md')}`,
    '',
    'Not fixed:',
    '- none',
    '',
    'Verification:',
    '- re-read 06-spec.md and 07-plan.md for the new cross-reference: passed',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
}

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

// A git-backed project root (default guard=git for the persistent path) containing an
// active <root>/.req-to-plan/WF-* requirement directory with run.md + 03–07.
function makeR2pProject(t, name = 'WF-20260624-fix') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-fix-')));
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-fix-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  git(root, ['init', '-b', 'main']);
  const wfDir = path.join(root, '.req-to-plan', name);
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'run.md'), planApprovedRunMd);
  for (const doc of R2P_EDITABLE_DOCS) {
    fs.writeFileSync(path.join(wfDir, doc), `# ${doc}\nContent of ${doc}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed requirement']);
  return { root, homeDir, wfDir };
}

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotProtectedFiles(wfDir) {
  const watched = ['run.md', ...R2P_EDITABLE_DOCS];
  return Object.fromEntries(watched.map((name) => [name, sha256OfFile(path.join(wfDir, name))]));
}

function changedFiles(wfDir, before) {
  return Object.keys(before).filter((name) => before[name] !== sha256OfFile(path.join(wfDir, name)));
}

function r2pArgs(wfDir) {
  return [
    'review-fix-r2p',
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

// Drive start → context → record-review(FAIL) → record-triage(ACCEPT) so the manifest
// reaches Status: fix with ISSUE-001 accepted in the ledger.
async function reachR2pFixStage(root, homeDir, wfDir) {
  const opts = { cwd: root, homeDir };
  const args = r2pArgs(wfDir);
  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.routeKind, 'r2p', 'r2p must dispatch as its own route kind');
  await runWorkflowCommand('context', args, opts);
  await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_FAIL });
  const triage = await runWorkflowCommand('record-triage', [
    ...args,
    '--triage-stdin'
  ], { ...opts, stdin: TRIAGE_ACCEPT });
  assert.equal(triage.ok, true, JSON.stringify(triage));
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.currentPhase, 'fix');
  assert.equal(manifest.targetContextKind, 'r2p');
  const ledger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'accepted');
  return { start, opts };
}

// ---------------------------------------------------------------------------
// (a) The in-place backward fix edits BOTH 07-plan.md and the mapped upstream doc and
//     the workflow accepts exactly those in-set changes.
// ---------------------------------------------------------------------------

test('r2p review-and-fix accepts an in-place backward fix to 07-plan.md + the owning upstream doc', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t);
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir);
  const before = snapshotProtectedFiles(wfDir);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'begin-fix');
  // The writable boundary is EXACTLY the five 03–07 docs — run.md is never monitored.
  assert.equal(beginFix.monitoredFileCount, R2P_EDITABLE_DOCS.length);
  const guardReport = JSON.parse(
    fs.readFileSync(beginFix.fixGuardReportPath, 'utf8').match(/```json\n([\s\S]*?)\n```/)[1]
  );
  const expectedMembers = R2P_EDITABLE_DOCS.map((doc) => memberPath(root, wfDir, doc)).sort();
  assert.deepEqual([...guardReport.monitoredFiles].sort(), expectedMembers);
  const runMdMember = memberPath(root, wfDir, 'run.md');
  assert.ok(!guardReport.monitoredFiles.includes(runMdMember), 'run.md must never be monitored/writable');

  // The HARNESS performs the allowed in-place edits to BOTH the plan and the upstream doc.
  fs.writeFileSync(
    path.join(wfDir, '07-plan.md'),
    '# 07-plan.md\nStep 3 now references SPEC-ACCEPT-1 from 06-spec.md.\n'
  );
  fs.writeFileSync(
    path.join(wfDir, '06-spec.md'),
    '# 06-spec.md\nSPEC-ACCEPT-1: the acceptance criterion the plan step relies on.\n'
  );

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: fixReportBackward(root, wfDir) });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.status, 'end-fix');
  assert.deepEqual(endFix.fixedIssueIds, ['ISSUE-001']);

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'diff-review');
  assert.equal(manifest.targetContextKind, 'r2p');

  // Exactly the two edited docs changed; run.md is byte-identical (never written).
  assert.deepEqual([...changedFiles(wfDir, before)].sort(), ['06-spec.md', '07-plan.md']);
  assert.equal(sha256OfFile(path.join(wfDir, 'run.md')), before['run.md'], 'run.md must never be written');
});

// ---------------------------------------------------------------------------
// (b1) An attempt to write run.md is REFUSED as out-of-set; no diff-review, no PASS.
// ---------------------------------------------------------------------------

test('r2p end-fix refuses a write to run.md as out-of-set', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-20260624-runmd');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // A real in-set edit PLUS an out-of-set write to the run.md gate.
  fs.writeFileSync(
    path.join(wfDir, '07-plan.md'),
    '# 07-plan.md\nStep 3 now references SPEC-ACCEPT-1 from 06-spec.md.\n'
  );
  fs.writeFileSync(path.join(wfDir, 'run.md'), `${fs.readFileSync(path.join(wfDir, 'run.md'), 'utf8')}<!-- tampered gate -->\n`);

  const declaresInSet = [
    'Fixed:',
    '- ISSUE-001: Referenced the new acceptance criterion from 07-plan.md.',
    '',
    'Files changed:',
    `- ${memberPath(root, wfDir, '07-plan.md')}`,
    '',
    'Not fixed:',
    '- none',
    '',
    'Verification:',
    '- re-read 07-plan.md for the cross-reference: passed',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: declaresInSet });

  // run.md is not a member, so the live worktree guard sees an out-of-set change.
  assert.equal(endFix.ok, false, JSON.stringify(endFix));
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'unexpected-worktree-change');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

// ---------------------------------------------------------------------------
// (b2) Declaring run.md (or any non-03–07 path) in the fix report is refused as out-of-set.
// ---------------------------------------------------------------------------

test('r2p end-fix refuses a fix report that declares run.md or a non-03–07 path', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-20260624-declare');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir);
  const before = snapshotProtectedFiles(wfDir);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // The harness edits only an in-set doc, but the report DECLARES run.md as changed.
  fs.writeFileSync(
    path.join(wfDir, '07-plan.md'),
    '# 07-plan.md\nStep 3 references SPEC-ACCEPT-1.\n'
  );
  const declaresRunMd = [
    'Fixed:',
    '- ISSUE-001: Edited the gate instead of the spec (illegal).',
    '',
    'Files changed:',
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
  ], { ...opts, stdin: declaresRunMd });

  assert.equal(endFix.ok, false, JSON.stringify(endFix));
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'fix-report-mismatch');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
  // run.md was never written by the harness here, so it stays byte-identical.
  assert.equal(sha256OfFile(path.join(wfDir, 'run.md')), before['run.md']);
});

// ---------------------------------------------------------------------------
// (b3) A write to a path OUTSIDE the requirement directory (outside 03–07) is refused.
// ---------------------------------------------------------------------------

test('r2p end-fix refuses a write outside the 03–07 requirement set', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-20260624-outside');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(
    path.join(wfDir, '07-plan.md'),
    '# 07-plan.md\nStep 3 references SPEC-ACCEPT-1.\n'
  );
  // An untracked write to a project file completely outside the requirement directory.
  fs.writeFileSync(path.join(root, 'unrelated.js'), 'module.exports = "outside";\n');

  const declaresInSet = [
    'Fixed:',
    '- ISSUE-001: Referenced the new acceptance criterion.',
    '',
    'Files changed:',
    `- ${memberPath(root, wfDir, '07-plan.md')}`,
    '',
    'Not fixed:',
    '- none',
    '',
    'Verification:',
    '- re-read 07-plan.md: passed',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: declaresInSet });

  assert.equal(endFix.ok, false, JSON.stringify(endFix));
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'unexpected-worktree-change');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

// ---------------------------------------------------------------------------
// (c) The fix phase requires a clean guard over the set before the first write: a dirty,
//     unreviewed in-set change after triage blocks begin-fix (no baseline, no lease).
// ---------------------------------------------------------------------------

test('r2p begin-fix requires a clean guard over the 03–07 set before the first write', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-20260624-dirty');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir);

  // Dirty an in-set doc AFTER triage and BEFORE begin-fix: this is unreviewed local work,
  // so the pre-write file-set guard must block the first fix round.
  fs.appendFileSync(path.join(wfDir, '05-design.md'), '\n<!-- unreviewed local edit -->\n');

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, false, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'unexpected-worktree-change');
  // No fix lease and no captured baseline: the fix never started.
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'file-set-baseline.json')), false);
});
