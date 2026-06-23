'use strict';

// ---------------------------------------------------------------------------
// review-fix-r2q — PERSISTENT finalize: earned PASS over the 03–07 set + the
// Item-3b human-decision deferral terminal (Task 11).
//
// SAFETY-CRITICAL and DETERMINISTIC: no LLM / CLI semantic reviewer runs. The
// harness builds a real git-backed WF-* requirement directory (03–07 + run.md),
// drives the FULL persistent lifecycle with EXPLICIT payload fixtures
// (review FAIL / triage / fix report / diff review / full re-review / final
// response), performs the in-place 03–07 edits ITSELF, and asserts the real
// terminal status / files-changed / deferral fields.
//
// What they pin:
//   (a) EARNED PASS — an initial reviewer finding, accepted triage, a harness
//       edit to the owning 03–07 files (06-spec.md + 07-plan.md), a matching fix
//       report, DIFF-OK, a full re-review PASS, and a final-response payload →
//       r2q reaches `pass`, with `Files changed` listing BOTH edited 03–07 files
//       and the accepted execution-state risk note surfaced in the output.
//   (b) DEFERRAL — a reviewer finding whose resolution needs a human product
//       decision, triaged `deferred` (deferred_owner: user), the in-document
//       marker surfaced via a harness edit → terminal status
//       `stopped-with-deferrals`, NOT pass, with owner + next action recorded.
//       There is NO `stopped-pending-human` state.
//   (c) A Gemini (advisory) r2q run never reaches `pass`.
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

const R2Q_EDITABLE_DOCS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

// Reviewer FAIL: a PLAN-rubric finding whose ROOT CAUSE is an acceptance/behavior
// gap. Per the finding->owner-doc map the owner is 06-spec.md, so the backward fix
// edits BOTH 07-plan.md and the upstream 06-spec.md.
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

// Reviewer FAIL whose resolution needs a human PRODUCT decision (scope/value), not a
// mechanical doc edit. Triage DEFERS it to the user (Item-3b surface-and-defer).
const REVIEW_FAIL_HUMAN = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: 03-requirement-brief.md#scope',
  '  issue: The brief leaves a product scope/value question that only the owner can settle.',
  '  why_it_matters: Resolving it changes what the plan should build; no doc edit can decide it.',
  '  suggested_fix: Escalate the scope decision to the product owner before re-planning.',
  '  confidence: confirmed',
  '  sensitive: false'
].join('\n');

const TRIAGE_DEFER_USER = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: deferred',
  '  severity: high',
  '  original_severity: high',
  '  rationale: Needs a human product/scope decision; no in-place doc edit can resolve it.',
  '  merged_into: none',
  '  deferred_owner: user',
  '  deferred_next_action: decide the product scope question, then re-run r2q',
  '  non_blocking: false'
].join('\n');

const DIFF_OK = 'DIFF-OK\nSummary: In-place 03–07 edit addresses ISSUE-001.\n';
const REVIEW_PASS = 'PASS\nSummary: No blocking findings after the backward fix.\n';

// The execution-state risk note (design Decision 1 "accepted consequence"): r2q cannot
// prove the artifacts were not already consumed because r2p has no r2p-execute marker.
const EXECUTION_STATE_RISK =
  'Accepted execution-state risk: r2q cannot prove the requirement was not already consumed (no r2p-execute marker).';

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

// PASS final response. `Files changed` MUST equal the multi-file (03–07) fix-report
// edits (sorted, comma-joined). It surfaces the accepted execution-state risk note.
function finalPass(filesChanged) {
  return [
    'Final status: pass',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: none',
    `Files changed: ${filesChanged}`,
    'Fixed issue IDs: ISSUE-001',
    'Verification performed: re-read 06-spec.md and 07-plan.md cross-reference',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    `Residual risk: ${EXECUTION_STATE_RISK}`,
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: approved after full re-review'
  ].join('\n');
}

// Deferral final response: stopped-with-deferrals, owner + next action recorded.
function finalDeferred() {
  return [
    'Final status: stopped-with-deferrals',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: none',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: full file-set review against COMMON+PLAN',
    'Deferrals or blockers: ISSUE-001 needs a human product decision; owner: user; next action: decide the product scope question, then re-run r2q',
    'Blocking reason: none',
    'Status reason: deferred-findings',
    `Residual risk: ${EXECUTION_STATE_RISK}`,
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
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
function makeR2qProject(t, name = 'WF-20260624-finalize') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2q-final-')));
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2q-final-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  git(root, ['init', '-b', 'main']);
  const wfDir = path.join(root, '.req-to-plan', name);
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'run.md'), planApprovedRunMd);
  for (const doc of R2Q_EDITABLE_DOCS) {
    fs.writeFileSync(path.join(wfDir, doc), `# ${doc}\nContent of ${doc}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed requirement']);
  return { root, homeDir, wfDir };
}

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function r2qArgs(wfDir, { mode = 'review-and-fix', assurance = 'practical', runtimePlatform = 'codex' } = {}) {
  return [
    'review-fix-r2q',
    `target=${wfDir}`,
    mode,
    '--assurance',
    assurance,
    '--runtime-platform',
    runtimePlatform,
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ];
}

// Drive start → context → record-review → record-triage with the supplied review +
// triage payloads, returning the start result and shared opts.
async function reachAfterTriage(root, homeDir, { review, triage, args }) {
  const opts = { cwd: root, homeDir };
  const start = await runWorkflowCommand('start', args, opts);
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.routeKind, 'r2q', 'r2q must dispatch as its own route kind');
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
  assert.equal(triageResult.ok, true, JSON.stringify(triageResult));
  return { start, opts, triageResult };
}

// ---------------------------------------------------------------------------
// (a) EARNED PASS over the multi-file 03–07 set.
// ---------------------------------------------------------------------------

test('r2q review-and-fix earns PASS over the 03–07 set with the execution-state risk surfaced', async (t) => {
  const { root, homeDir, wfDir } = makeR2qProject(t, 'WF-20260624-pass');
  const args = r2qArgs(wfDir);
  const { start, opts } = await reachAfterTriage(root, homeDir, {
    review: REVIEW_FAIL,
    triage: TRIAGE_ACCEPT,
    args
  });
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'fix');

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    ...opts,
    now: new Date('2026-06-24T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // The HARNESS performs the in-place backward fix to BOTH the plan and the upstream doc.
  fs.writeFileSync(
    path.join(wfDir, '07-plan.md'),
    '# 07-plan.md\nStep 3 now references SPEC-ACCEPT-1 from 06-spec.md.\n'
  );
  fs.writeFileSync(
    path.join(wfDir, '06-spec.md'),
    '# 06-spec.md\nSPEC-ACCEPT-1: the acceptance criterion the plan step relies on.\n'
  );

  const runMdBefore = sha256OfFile(path.join(wfDir, 'run.md'));

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { ...opts, stdin: fixReportBackward(root, wfDir) });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.deepEqual(endFix.fixedIssueIds, ['ISSUE-001']);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');

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

  // The PASS final response's Files changed lists BOTH edited 03–07 files (sorted).
  const filesChanged = [
    memberPath(root, wfDir, '06-spec.md'),
    memberPath(root, wfDir, '07-plan.md')
  ].sort().join(', ');
  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { ...opts, stdin: finalPass(filesChanged) });

  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  // Files changed reports the multi-file (03–07) edits.
  assert.equal(final.finalResponse.filesChanged, filesChanged);
  assert.match(final.finalResponse.filesChanged, /06-spec\.md/);
  assert.match(final.finalResponse.filesChanged, /07-plan\.md/);
  // The accepted execution-state risk note is surfaced in the output.
  assert.match(final.finalResponse.residualRisk, /execution-state/i);
  assert.match(final.finalResponse.residualRisk, /r2p-execute/);
  // run.md was never written across the whole lifecycle.
  assert.equal(sha256OfFile(path.join(wfDir, 'run.md')), runMdBefore, 'run.md must never be written');

  // The archived terminal manifest records the pass and the ledger marks the issue fixed.
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
// (b) DEFERRAL — a human-product-decision finding stops with deferrals, never pass.
//     There is NO stopped-pending-human state.
// ---------------------------------------------------------------------------

test('r2q human-decision finding stops-with-deferrals (owner+next action), never pass', async (t) => {
  const { root, homeDir, wfDir } = makeR2qProject(t, 'WF-20260624-defer');
  const args = r2qArgs(wfDir);
  const { start, opts, triageResult } = await reachAfterTriage(root, homeDir, {
    review: REVIEW_FAIL_HUMAN,
    triage: TRIAGE_DEFER_USER,
    args
  });

  // Deferring a high finding to a human stops the run with deferrals at triage time —
  // there is no fix loop and no stopped-pending-human state.
  assert.equal(triageResult.status, 'recorded-triage');
  const triagedManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(triagedManifest.status, 'stopped-with-deferrals');
  assert.equal(triagedManifest.currentPhase, 'final');
  assert.equal(triagedManifest.statusReason, 'deferred-findings');

  // The ledger records the deferral with owner=user and the next action.
  const ledger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));
  const deferred = ledger.issues.find((issue) => issue.id === 'ISSUE-001');
  assert.equal(deferred.status, 'deferred');
  assert.match(deferred.resolution, /owner: user/);
  assert.match(deferred.resolution, /next action: decide the product scope question/);

  // The harness surfaces the in-document marker in the owning 03 doc (an explicit,
  // human-visible note), simulating the Item-3b surface-and-defer write.
  fs.appendFileSync(
    path.join(wfDir, '03-requirement-brief.md'),
    '\n<!-- DEFERRED ISSUE-001: product scope decision required (owner: user) -->\n'
  );

  // Finalize confirms the terminal stopped-with-deferrals status; it never reaches pass.
  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { ...opts, stdin: finalDeferred() });

  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'stopped-with-deferrals');
  assert.notEqual(final.status, 'pass');
  assert.match(final.finalResponse.deferralsOrBlockers, /owner: user/);
  assert.match(final.finalResponse.deferralsOrBlockers, /next action/);
  assert.equal(final.finalResponse.statusReason, 'deferred-findings');
});

// ---------------------------------------------------------------------------
// (c) A Gemini (advisory) r2q run never reaches pass.
// ---------------------------------------------------------------------------

test('r2q under Gemini (advisory) never reaches pass', async (t) => {
  const { root, homeDir, wfDir } = makeR2qProject(t, 'WF-20260624-gemini');
  // Gemini is advisory-only: read-only mode + advisory assurance, the no-state path.
  const commonArgs = [
    'review-fix-r2q',
    `target=${wfDir}`,
    'read-only',
    '--assurance',
    'advisory',
    '--runtime-platform',
    'gemini',
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
  const opts = { cwd: root, homeDir };
  const before = sha256OfFile(path.join(wfDir, '07-plan.md'));

  const context = await runWorkflowCommand('context', ['--no-state', ...commonArgs], opts);
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(context.routeKind, 'r2q');

  const review = await runWorkflowCommand('record-review', [
    '--no-state',
    ...commonArgs,
    '--review-guard',
    context.reviewGuard,
    '--result-stdin'
  ], { ...opts, stdin: REVIEW_FAIL });
  assert.equal(review.ok, true, JSON.stringify(review));

  const triage = await runWorkflowCommand('record-triage', [
    '--no-state',
    ...commonArgs,
    '--state-token',
    review.stateToken,
    '--triage-stdin'
  ], { ...opts, stdin: TRIAGE_ACCEPT });
  assert.equal(triage.ok, true, JSON.stringify(triage));

  // An advisory final response can only be read-only-findings; a forged pass is refused.
  const passAttempt = [
    'Final status: pass',
    'Assurance: advisory',
    'Runtime platform: gemini',
    'Mode: read-only',
    'Target: none',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: advisory review',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: none identified',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: approved after full re-review'
  ].join('\n');
  const forgedPass = await runWorkflowCommand('finalize', [
    '--no-state',
    ...commonArgs,
    '--state-token',
    triage.stateToken,
    '--final-response-stdin'
  ], { ...opts, stdin: passAttempt });
  assert.equal(forgedPass.ok, false, JSON.stringify(forgedPass));
  assert.notEqual(forgedPass.status, 'pass');

  // The honest advisory terminal is read-only-findings, never pass.
  const findings = [
    'Final status: read-only-findings',
    'Assurance: advisory',
    'Runtime platform: gemini',
    'Mode: read-only',
    'Target: none',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: advisory read-only review of 07-plan.md',
    'Deferrals or blockers: ISSUE-001 acceptance/behavior gap owned by 06-spec.md',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: 07-plan.md step 3 lacks spec backing in 06-spec.md',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');
  const finalized = await runWorkflowCommand('finalize', [
    '--no-state',
    ...commonArgs,
    '--state-token',
    triage.stateToken,
    '--final-response-stdin'
  ], { ...opts, stdin: findings });
  assert.equal(finalized.ok, true, JSON.stringify(finalized));
  assert.equal(finalized.status, 'read-only-findings');
  assert.notEqual(finalized.status, 'pass');

  // Advisory wrote nothing to the 03–07 set.
  assert.equal(sha256OfFile(path.join(wfDir, '07-plan.md')), before);
});
