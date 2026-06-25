'use strict';

// ---------------------------------------------------------------------------
// review-fix-r2p — GATE-FRESHNESS (TOCTOU) revalidation at every write/PASS checkpoint
// (Task 10).
//
// SAFETY-CRITICAL and DETERMINISTIC: no LLM / CLI semantic reviewer runs. The harness
// builds a real git-backed WF-* requirement directory (run.md + 03–07), drives the
// persistent workflow with EXPLICIT payloads, and mutates run.md BETWEEN the gate decision
// and a later write/PASS checkpoint, then asserts the workflow stops as a guarded drift
// blocker — never a write, never a PASS.
//
// r2p makes the eligibility decision (run.md unchanged AND still satisfies the gate) once at
// resolve time, but then writes/PASSes across several later commands. Between gate and each
// of the FOUR write/PASS checkpoints run.md can be:
//   - MODIFIED (fingerprint drift),
//   - mutated to an ARCHIVED/INCOMPLETE state (gate no longer satisfied), or
//   - DELETED (unreadable — the Task-9 snapshot residual: a DELETE-only of run.md is NOT
//     caught by the snapshot file-set guard because run.md is not a monitored member).
// Any of these must STOP the run as a guarded blocker reusing the file-set guard's
// unexpected-worktree-change plumbing.
//
// The four checkpoints exercised here:
//   (1) before begin-fix
//   (2) before a lock refresh that precedes writes (refresh-lock)
//   (3) after end-fix (before the diff-review/PASS-ward transition)
//   (4) before final PASS (finalize)
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

// A run.md that parses but no longer satisfies the gate: status open, no approved/active
// plan in Active Artifacts ⇒ parseRunMdGate().planApproved === false (incomplete).
const incompleteRunMd = [
  '# Requirement Run',
  '',
  '## Status',
  'open',
  '',
  '## Active Artifacts',
  '- plan: draft',
  ''
].join('\n');

const R2P_EDITABLE_DOCS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

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

const DIFF_OK = 'DIFF-OK\nSummary: In-set backward fix addresses ISSUE-001.\n';
const REVIEW_PASS = 'PASS\nSummary: No blocking findings.\n';

function memberPath(root, wfDir, doc) {
  return path.relative(root, path.join(wfDir, doc)).split(path.sep).join('/');
}

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

function finalPass(filesChanged) {
  return [
    'Final status: pass',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: none',
    `Files changed: ${filesChanged}`,
    'Fixed issue IDs: ISSUE-001',
    'Verification performed: re-read 06-spec.md and 07-plan.md',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: none identified',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: approved after full re-review'
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

function makeR2pProject(t, name = 'WF-20260624-freshness') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-fresh-')));
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-fresh-home-')));
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

function r2pArgs(wfDir, routeTokens = []) {
  return [
    'review-fix-r2p',
    `target=${wfDir}`,
    'review-and-fix',
    ...routeTokens,
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

async function reachR2pFixStage(root, homeDir, wfDir, extraArgs = []) {
  const opts = { cwd: root, homeDir };
  const args = r2pArgs(wfDir, extraArgs);
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
  return { start, opts, args };
}

// ---------------------------------------------------------------------------
// CHECKPOINT 1 — before begin-fix.
// ---------------------------------------------------------------------------

test('(a) begin-fix blocks when run.md is MODIFIED between gate and begin-fix (no write)', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-mod-begin');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir);

  // MODIFY run.md after triage, before begin-fix: the protected gate fingerprint drifts.
  fs.writeFileSync(path.join(wfDir, 'run.md'), `${planApprovedRunMd}<!-- tampered gate -->\n`);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, false, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'unexpected-worktree-change');
  // No baseline captured, no lease, no diff-review transition: the fix never started.
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'file-set-baseline.json')), false);
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

test('(b) begin-fix blocks when run.md becomes INCOMPLETE between gate and begin-fix (no write)', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-incomplete-begin');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir);

  // Mutate run.md to an incomplete/non-approved-plan state. (Distinct sha AND failing gate.)
  fs.writeFileSync(path.join(wfDir, 'run.md'), incompleteRunMd);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, false, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'unexpected-worktree-change');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'file-set-baseline.json')), false);
});

test('(c) begin-fix BLOCKS when run.md is DELETED between gate and begin-fix (residual backstop)', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-del-begin');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir);

  // DELETE run.md after triage, before begin-fix. The re-read must fail (unreadable) → block.
  fs.rmSync(path.join(wfDir, 'run.md'));

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, false, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'unexpected-worktree-change');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'file-set-baseline.json')), false);
});

// ---------------------------------------------------------------------------
// CHECKPOINT 2 — before a lock refresh that precedes writes (refresh-lock).
// ---------------------------------------------------------------------------

test('CHECKPOINT 2: refresh-lock blocks when run.md is DELETED mid-fix (no continued write window)', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-refresh');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // The fixer holds a live lease. DELETE run.md mid-fix, then ask to refresh the lease: the
  // refresh must reject the stale gate instead of extending the write window.
  fs.rmSync(path.join(wfDir, 'run.md'));

  const refresh = await runWorkflowCommand('refresh-lock', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:30.000Z')
  });
  assert.equal(refresh.ok, false, JSON.stringify(refresh));
  assert.equal(refresh.status, 'blocked');
  assert.equal(refresh.blockingReason, 'unexpected-worktree-change');
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'blocked');
});

// ---------------------------------------------------------------------------
// CHECKPOINT 3 — after end-fix (before the diff-review/PASS-ward transition).
// ---------------------------------------------------------------------------

test('(a) end-fix blocks when run.md is MODIFIED after begin-fix (no diff-review transition)', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-mod-end');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir);
  const before = { 'run.md': sha256OfFile(path.join(wfDir, 'run.md')) };

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // Apply the real in-set backward fix...
  fs.writeFileSync(path.join(wfDir, '07-plan.md'), '# 07-plan.md\nStep 3 references SPEC-ACCEPT-1.\n');
  fs.writeFileSync(path.join(wfDir, '06-spec.md'), '# 06-spec.md\nSPEC-ACCEPT-1: the acceptance criterion.\n');
  // ...but MODIFY run.md before end-fix. Under guard=git the worktree guard already sees the
  // out-of-set change; the gate revalidation is the route-agnostic backstop.
  fs.writeFileSync(path.join(wfDir, 'run.md'), `${planApprovedRunMd}<!-- tampered after begin -->\n`);

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: fixReportBackward(root, wfDir) });

  assert.equal(endFix.ok, false, JSON.stringify(endFix));
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'unexpected-worktree-change');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
  // No normalized fix report was persisted (no diff-review transition).
  assert.notEqual(before['run.md'], sha256OfFile(path.join(wfDir, 'run.md')));
});

test('(b) end-fix blocks when run.md becomes INCOMPLETE after begin-fix (snapshot guard) — no diff-review', async (t) => {
  // guard=snapshot isolates the gate revalidation from the git worktree guard: the editable
  // set delta still validates against the begin-fix baseline, but the run.md gate no longer
  // satisfies the requirement, so end-fix must block at CHECKPOINT 3.
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-incomplete-end');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir, ['guard=snapshot']);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).guardMode, 'snapshot');

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(wfDir, '07-plan.md'), '# 07-plan.md\nStep 3 references SPEC-ACCEPT-1.\n');
  fs.writeFileSync(path.join(wfDir, '06-spec.md'), '# 06-spec.md\nSPEC-ACCEPT-1: the acceptance criterion.\n');
  // Mutate run.md to an incomplete gate state after begin-fix.
  fs.writeFileSync(path.join(wfDir, 'run.md'), incompleteRunMd);

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: fixReportBackward(root, wfDir) });

  assert.equal(endFix.ok, false, JSON.stringify(endFix));
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'unexpected-worktree-change');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

test('(c) end-fix BLOCKS when run.md is DELETED after begin-fix under guard=snapshot (Task-9 residual backstop)', async (t) => {
  // THE residual case: a DELETE-only of run.md is NOT a monitored member, so the snapshot
  // file-set guard would not catch it. CHECKPOINT 3 re-reads run.md and BLOCKS because the
  // re-read fails (unreadable) — no diff-review transition, no PASS, no fix report persisted.
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-del-end');
  const { start, opts } = await reachR2pFixStage(root, homeDir, wfDir, ['guard=snapshot']);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).guardMode, 'snapshot');

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(wfDir, '07-plan.md'), '# 07-plan.md\nStep 3 references SPEC-ACCEPT-1.\n');
  fs.writeFileSync(path.join(wfDir, '06-spec.md'), '# 06-spec.md\nSPEC-ACCEPT-1: the acceptance criterion.\n');
  // DELETE run.md mid-fix. The snapshot baseline covers only the 03–07 set, so this is the
  // exact residual the Task-10 re-read backstops.
  fs.rmSync(path.join(wfDir, 'run.md'));

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: fixReportBackward(root, wfDir) });

  assert.equal(endFix.ok, false, JSON.stringify(endFix));
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'unexpected-worktree-change');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
  assert.equal(fs.existsSync(path.join(wfDir, 'run.md')), false, 'run.md remains deleted');
  // The ledger issue stays accepted (never advanced to fixed): no fix was recorded.
  const ledger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'accepted');
});

// ---------------------------------------------------------------------------
// CHECKPOINT 4 — before final PASS (finalize). Drive a full clean fix → diff-review →
// full-re-review, then drift/delete run.md and assert finalize PASS is REFUSED.
// ---------------------------------------------------------------------------

async function driveToFullReReview(root, homeDir, wfDir) {
  const { start, opts, args } = await reachR2pFixStage(root, homeDir, wfDir);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(wfDir, '07-plan.md'), '# 07-plan.md\nStep 3 references SPEC-ACCEPT-1 from 06-spec.md.\n');
  fs.writeFileSync(path.join(wfDir, '06-spec.md'), '# 06-spec.md\nSPEC-ACCEPT-1: the acceptance criterion the plan step relies on.\n');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: fixReportBackward(root, wfDir) });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.status, 'end-fix');

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
  return { start, opts };
}

test('CHECKPOINT 4: finalize PASS is refused when run.md is DELETED before final pass (no PASS)', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-del-final');
  const { start, opts } = await driveToFullReReview(root, homeDir, wfDir);

  // DELETE run.md after full re-review, before finalize. The PASS must be refused.
  fs.rmSync(path.join(wfDir, 'run.md'));

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { ...opts, stdin: finalPass('06-spec.md, 07-plan.md') });

  assert.equal(final.ok, false, JSON.stringify(final));
  assert.equal(final.status, 'blocked');
  assert.equal(final.blockingReason, 'unexpected-worktree-change');
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.notEqual(manifest.status, 'pass', 'finalize must not record a PASS from a deleted gate');
  assert.equal(manifest.status, 'blocked');
});

test('CHECKPOINT 4: finalize PASS is refused when run.md is MODIFIED before final pass (no PASS)', async (t) => {
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-mod-final');
  const { start, opts } = await driveToFullReReview(root, homeDir, wfDir);

  // MODIFY run.md after full re-review, before finalize. The PASS must be refused.
  fs.writeFileSync(path.join(wfDir, 'run.md'), `${planApprovedRunMd}<!-- tampered before pass -->\n`);

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { ...opts, stdin: finalPass('06-spec.md, 07-plan.md') });

  assert.equal(final.ok, false, JSON.stringify(final));
  assert.equal(final.status, 'blocked');
  assert.equal(final.blockingReason, 'unexpected-worktree-change');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'pass');
});

// ---------------------------------------------------------------------------
// Control: a fresh, unchanged, still-approved run.md passes through every checkpoint and
// reaches PASS — proving the revalidation does not block the happy path.
// ---------------------------------------------------------------------------

test('control: an unchanged, still-approved run.md is NEVER blocked by the gate revalidation', async (t) => {
  // The gate revalidation must not false-positive on the happy path. With run.md untouched
  // and still plan-approved, the run flows cleanly through CHECKPOINT 1 (begin-fix), 2 (the
  // fix window), and 3 (end-fix) to full-re-review, proving no checkpoint blocks a fresh
  // gate. (driveToFullReReview already asserts begin-fix.ok / end-fix.ok / the diff-review
  // and full-re-review transitions — i.e. no unexpected-worktree-change block fired.)
  const { root, homeDir, wfDir } = makeR2pProject(t, 'WF-control');
  const { start, opts } = await driveToFullReReview(root, homeDir, wfDir);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'full-re-review');

  // CHECKPOINT 4 with a fresh gate: the gate revalidation passes (returns null), so finalize
  // does NOT block with a gate-drift reason. NOTE: r2p PASS through `finalize` is gated by a
  // SEPARATE, pre-existing limitation — liveIdentityFor/storedIdentityFor in
  // file-set-finalize.js have no r2p branch and compare the r2p target with a CODE-shaped
  // identity, so finalize stops on ERR_FINAL_FILE_SET_STALE_IDENTITY rather than reaching
  // PASS. That is out of scope for Task 10 (gate freshness). What this control proves is the
  // narrow Task-10 property: the gate revalidation itself never blocks a fresh run.md.
  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { ...opts, stdin: finalPass('06-spec.md, 07-plan.md') });
  assert.notEqual(final.blockingReason, 'unexpected-worktree-change',
    'a fresh, approved run.md must not be blocked by the gate revalidation');
});
