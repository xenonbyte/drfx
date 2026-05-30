# G5: guard=git Multi-Fix Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `guard=git` support more than one fix cycle so a review needing >1 fix no longer dies on the second `begin-fix` with `rollback-unavailable` / `unexpected-worktree-change`.

**Architecture:** `begin-fix` distinguishes the *first* fix from a *subsequent* fix using the existing manifest fingerprints (`lastKnownContentSha256 !== initialContentSha256`), NOT `currentRound` (which only increments on DIFF-FAIL and stays `1` on the common DIFF-OK→re-review→FAIL path). On a subsequent git-mode fix it (a) skips the worktree-clean rollback check, (b) swaps the non-target guard from `checkTargetOnlyWorktree` (allowTarget:false) to `inspectActualChangedFiles` (allowTarget:true), and (c) for *both* first and subsequent fixes captures a per-fix `target.body` snapshot whose `snapshotPath` is recorded in the rollback anchor so `abort-fix` can restore it. The "is this dirty content ours vs externally changed" check is already enforced by `assertPreFixFingerprint` (lock.js) which runs before the guard, so the prior-fix branch must NOT re-implement it.

**Tech Stack:** Node.js 20 CommonJS, `node:test` + `node:assert/strict`, git CLI fixtures.

**Source spec:** `design/ENHANCE-REVIEW-FIX-2026-05-30.md` §3 G5 + D8/D9. This is the 0.2.1 bug-fix batch (first of three).

**Invariants (must hold after every task):**
- First-fix safety semantics and existing git fixture compatibility are preserved; the only first-fix-visible addition is the intentional per-fix snapshot metadata required for git abort restore.
- No new manifest field, no new workflow status, no new guard function, no new external dependency.
- `npm test` (full `node --test` suite) passes after each task's final step.

---

### Task 1: `checkGitRollbackAnchor` gains a `priorFix` mode

**Why:** On a subsequent fix the target is legitimately dirty (it holds the previous fix's output). The clean-worktree throw must be skipped for that case while keeping the tracked-target + HEAD + identity checks. The fingerprint/externally-changed protection is already done upstream by `assertPreFixFingerprint`, so this function only needs to gate the porcelain clean check.

**Files:**
- Modify: `lib/fix-guard.js` (function `checkGitRollbackAnchor`, currently lines 233-268)
- Test: `test/fix-guard.test.js` (imports `checkGitRollbackAnchor` directly; git fixture helper `makeGitRepo` already exists)

- [ ] **Step 1: Write the failing tests**

Append to `test/fix-guard.test.js` (the file already imports `checkGitRollbackAnchor`, `fs`, `path`, and defines `makeGitRepo(t)`):

```js
test('checkGitRollbackAnchor: priorFix accepts a tracked dirty target', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.writeFileSync(target, '# Target\n\nEdited by the previous fix.\n');

  // Default (first fix): a dirty target is still rejected.
  assert.throws(
    () => checkGitRollbackAnchor({ projectRoot: root, targetPath: target }),
    /rollback-unavailable/
  );

  // Subsequent fix: a dirty tracked target is accepted.
  const anchor = checkGitRollbackAnchor({ projectRoot: root, targetPath: target, priorFix: true });
  assert.equal(anchor.status, 'passed');
  assert.equal(anchor.priorFix, true);
});

test('checkGitRollbackAnchor: priorFix still requires a tracked target', (t) => {
  const { root } = makeGitRepo(t);
  const untracked = path.join(root, 'docs', 'untracked.md');
  fs.writeFileSync(untracked, '# Untracked\n');
  assert.throws(
    () => checkGitRollbackAnchor({ projectRoot: root, targetPath: untracked, priorFix: true }),
    /rollback-unavailable/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/fix-guard.test.js`
Expected: the two new tests FAIL — `priorFix` is currently ignored, so the dirty-target case throws `rollback-unavailable` instead of returning `{status:'passed'}`.

- [ ] **Step 3: Implement `priorFix` in `checkGitRollbackAnchor`**

Replace the whole `checkGitRollbackAnchor` function in `lib/fix-guard.js` with:

```js
function checkGitRollbackAnchor({
  projectRoot,
  targetPath,
  expectedNormalizedTarget = null,
  priorFix = false
}) {
  const root = path.resolve(projectRoot);
  runGit(root, ['rev-parse', '--is-inside-work-tree'], 'rollback-unavailable');
  const head = runGit(root, ['rev-parse', '--verify', 'HEAD'], 'rollback-unavailable').trim();
  const normalizedTarget = assertTargetIdentity({
    projectRoot: root,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: 'rollback-unavailable'
  });
  runGit(root, ['ls-files', '--error-unmatch', '--', normalizedTarget], 'rollback-unavailable');

  // Subsequent fix: the target is legitimately dirty with our own prior output.
  // assertPreFixFingerprint (lock.js) has already proven current == lastKnown, so do
  // NOT re-check the worktree here; just confirm the rollback anchor (HEAD) exists.
  if (priorFix) {
    return { status: 'passed', head, normalizedTarget, priorFix: true };
  }

  let entries;
  try {
    entries = parsePorcelainStatus(runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'], 'rollback-unavailable'));
  } catch (error) {
    if (error && error.blockingReason) throw error;
    throw guardError('rollback-unavailable', error.message, { cause: error });
  }

  const targetEntries = entries.filter((entry) => entry.paths.includes(normalizedTarget));
  if (targetEntries.length > 0) {
    throw guardError('rollback-unavailable', 'target must be tracked, index-clean, and worktree-clean', {
      entries: targetEntries.map((entry) => ({
        statusCode: entry.statusCode,
        kind: entry.kind
      }))
    });
  }

  return {
    status: 'passed',
    head,
    normalizedTarget
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/fix-guard.test.js`
Expected: PASS, including all pre-existing `checkGitRollbackAnchor` tests (first-fix behavior unchanged).

- [ ] **Step 5: Checkpoint**

Run: `npm test`
Expected: all tests pass.

Run `git status --short` and leave changes uncommitted unless the user explicitly requested commits for this implementation run.

---

### Task 2: `begin-fix` selects guards by the prior-fix signal and snapshots the target

**Why:** Wire Task 1 into the workflow: pick the first-fix vs subsequent-fix guard set using `lastKnownContentSha256 !== initialContentSha256`, swap the non-target guard to `inspectActualChangedFiles` (allowTarget:true) on a subsequent fix, and capture a per-fix snapshot for git mode so abort can restore (Task 3). The `snapshotPath` must be merged into the rollback anchor because `readLatestFixGuardBaseline` (helpers.js:1103) requires `rollbackAnchor.status === 'passed'` and `restoreSnapshot` reads `rollbackAnchor.snapshotPath`.

**Files:**
- Modify: `lib/workflow/fix-lifecycle.js` (function `runBeginFix`, the guard block at lines 88-115)
- Test: `test/workflow-e2e.test.js` (reuse module helpers `makeWorkflowRepo`, `workflowStartArgs`, `workflowOptions`, `assertManifestPhase`, and the `REVIEW_FAIL`/`TRIAGE_ACCEPT`/`FIX_REPORT`/`DIFF_OK`/`REVIEW_PASS`/`FINAL_PASS` constants)

- [ ] **Step 1: Confirm the imports exist**

Open `lib/workflow/fix-lifecycle.js` and verify the top-of-file require from `../fix-guard` includes `checkGitRollbackAnchor`, `checkTargetOnlyWorktree`, and `inspectActualChangedFiles`, and the require from `../snapshot-guard` includes `captureSnapshot`. They are already used elsewhere in this file (end-fix uses `inspectActualChangedFiles`; snapshot begin-fix uses `captureSnapshot`). If `inspectActualChangedFiles` is not in the destructured import list, add it. No code change expected — this is a verification step.

- [ ] **Step 2: Add the failing reopen-triage constant + second-fix test**

Add this constant near the other payload constants (after `TRIAGE_ACCEPT`) in `test/workflow-e2e.test.js`:

```js
const TRIAGE_REOPEN = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: reopened',
  '  severity: high',
  '  original_severity: high',
  '  rationale: The re-review shows the issue is not yet resolved.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');
```

Then add this test at the end of `test/workflow-e2e.test.js`:

```js
test('guard=git allows a second fix after DIFF-OK -> full re-review FAIL', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  assert.equal(start.ok, true);

  // --- Round 1: review -> triage -> fix -> DIFF-OK -> full re-review FAIL ---
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));

  const beginFix1 = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix1.ok, true, JSON.stringify(beginFix1));

  fs.writeFileSync(fixture.target,
    '# Practical Workflow Target\n\nFirst fix clarified the wording.\n\n## Acceptance\n\n- Names the expected behavior.\n');
  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));

  // currentRound is still 1 here (DIFF-OK does not increment it).
  const afterDiff = manifestAt(start.manifestPath);
  assert.equal(Number(afterDiff.currentRound), 1);

  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  const reReview = await runWorkflowCommand('record-review',
    [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  assert.equal(reReview.ok, true);

  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_REOPEN }));
  assertManifestPhase(start.manifestPath, 'fix', 'fix');

  // --- The headline: the SECOND begin-fix must NOT be blocked under guard=git ---
  const beginFix2 = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix2.ok, true, JSON.stringify(beginFix2));
  assert.equal(beginFix2.status, 'begin-fix');
  // currentRound is still 1; the prior-fix path is selected by lastKnown != initial.
  assert.equal(Number(manifestAt(start.manifestPath).currentRound), 1);

  fs.writeFileSync(fixture.target,
    '# Practical Workflow Target\n\nSecond fix fully names the expected behavior.\n\n## Acceptance\n\n- Names the expected behavior.\n- Preserves git guard multi-cycle behavior.\n');
  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));
  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  await runWorkflowCommand('record-review',
    [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_PASS }));
  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'],
    workflowOptions(fixture, { stdin: FINAL_PASS }));
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  assert.equal(assertManifestPhase(start.manifestPath, 'pass', 'final').guardMode, 'git');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/workflow-e2e.test.js`
Expected: the new test FAILS at `beginFix2` with `ok:false` and `blockingReason: rollback-unavailable` (the second begin-fix currently hits the clean-HEAD throw).

- [ ] **Step 4: Implement the prior-fix-aware guard block in `runBeginFix`**

In `lib/workflow/fix-lifecycle.js`, replace the guard block (currently lines 88-115, beginning `const guardMode = guardModeFor(metadata);` and ending with the `checkTargetOnlyWorktree({...})` ternary) with:

```js
    const guardMode = guardModeFor(metadata);
    const priorFix = Boolean(
      metadata.manifest.lastKnownContentSha256 &&
      metadata.manifest.initialContentSha256 &&
      metadata.manifest.lastKnownContentSha256 !== metadata.manifest.initialContentSha256
    );
    const snapshotRound = Number(metadata.manifest.currentRound || 1);

    let rollbackAnchor;
    let targetOnlyGuard;
    if (guardMode === 'snapshot') {
      rollbackAnchor = captureSnapshot({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        targetStateDir: metadata.targetStateDir,
        round: snapshotRound,
        expectedNormalizedTarget: metadata.normalizedTarget
      });
      targetOnlyGuard = checkSnapshotTargetOnly({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        allowedStateDir: metadata.targetStateDir,
        expectedNormalizedTarget: metadata.normalizedTarget,
        referencePaths: referencePathsForSnapshot(metadata)
      });
    } else {
      const gitAnchor = checkGitRollbackAnchor({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        expectedNormalizedTarget: metadata.normalizedTarget,
        priorFix
      });
      // git mode also takes a per-fix body snapshot so abort-fix can restore (Task 3).
      const snapshot = captureSnapshot({
        projectRoot: metadata.projectRoot,
        targetPath: metadata.targetPath,
        targetStateDir: metadata.targetStateDir,
        round: snapshotRound,
        expectedNormalizedTarget: metadata.normalizedTarget
      });
      rollbackAnchor = { ...gitAnchor, guardMode: 'git', snapshotPath: snapshot.snapshotPath };
      targetOnlyGuard = priorFix
        ? inspectActualChangedFiles({
          projectRoot: metadata.projectRoot,
          targetPath: metadata.targetPath,
          allowedStateDir: metadata.targetStateDir,
          expectedNormalizedTarget: metadata.normalizedTarget
        })
        : checkTargetOnlyWorktree({
          projectRoot: metadata.projectRoot,
          targetPath: metadata.targetPath,
          allowedStateDir: metadata.targetStateDir,
          expectedNormalizedTarget: metadata.normalizedTarget
        });
    }
```

Leave the rest of `runBeginFix` unchanged — the existing `if (targetOnlyGuard.status === 'blocked')` handling, `writeBeginFixGuardReport({ ..., rollbackAnchor, targetOnlyGuard, ... })`, and the catch block all consume `rollbackAnchor`/`targetOnlyGuard` exactly as before.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/workflow-e2e.test.js`
Expected: PASS, including the existing single-fix e2e test (first-fix path unchanged) and the new two-fix `guard=git` path through final PASS.

- [ ] **Step 6: Run the full suite (regression gate)**

Run: `npm test`
Expected: all tests pass. If `inspectActualChangedFiles` was not imported (Step 1), a `ReferenceError` here tells you to add it to the `../fix-guard` require list.

- [ ] **Step 7: Checkpoint**

Run `git status --short` and leave changes uncommitted unless the user explicitly requested commits for this implementation run.

---

### Task 3: `abort-fix` restores the target from the per-fix snapshot in git mode

**Why:** git-mode `abort-fix` currently does NOT restore the target at all (only the `snapshot` branch restores — `fix-lifecycle.js:391-428`). Now that git mode captures a per-fix snapshot (Task 2), abort must restore it so a stopped/aborted fix rolls back to the pre-fix body. This is a *new* behavior (git abort went from "no rollback" to "per-fix snapshot rollback"), not a replacement of `git checkout`.

**Files:**
- Modify: `lib/workflow/fix-lifecycle.js` (function `runAbortFix`, the `if (guardModeFor(metadata) === 'snapshot')` block at lines 391-428)
- Test: `test/workflow-e2e.test.js` (reuse helpers + constants from Task 2)

- [ ] **Step 1: Write the failing test**

Add to `test/workflow-e2e.test.js`:

```js
test('guard=git abort-fix restores the target from the per-fix snapshot', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });
  const before = fs.readFileSync(fixture.target, 'utf8');

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // Make a partial edit, then abort.
  fs.writeFileSync(fixture.target, before + '\nPartial, aborted edit.\n');
  const abort = await runWorkflowCommand('abort-fix', [
    start.targetStateDir, '--status', 'blocked', '--reason', 'lock-held', '--json'
  ], opts());
  assert.equal(abort.ok, true, JSON.stringify(abort));

  // The target is restored to its pre-fix body.
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), before);
});
```

`abort-fix` consumes the reason through `--reason`; the value for blocked status must be a member of `BLOCKING_REASONS`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/workflow-e2e.test.js`
Expected: FAIL — the file still contains "Partial, aborted edit." because git-mode abort does not restore.

- [ ] **Step 3: Broaden the abort restore to git mode**

In `lib/workflow/fix-lifecycle.js` `runAbortFix`, change the restore guard condition from snapshot-only to snapshot-or-git. Replace:

```js
  let restoredFingerprint = null;
  if (guardModeFor(metadata) === 'snapshot') {
```

with:

```js
  let restoredFingerprint = null;
  if (['snapshot', 'git'].includes(guardModeFor(metadata))) {
```

The body is unchanged: it reads `readLatestFixGuardBaseline(metadata)` and calls `restoreSnapshot({ ..., rollbackAnchor: guardBaseline.report.rollbackAnchor })`. The git rollback anchor written in Task 2 carries `status: 'passed'` and `snapshotPath`, which `readLatestFixGuardBaseline` and `restoreSnapshot` already consume.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/workflow-e2e.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass. (Snapshot-mode abort behavior is unchanged; git-mode abort now restores.)

- [ ] **Step 6: Checkpoint**

Run `git status --short` and leave changes uncommitted unless the user explicitly requested commits for this implementation run.

---

### Task 4: Guard-rail regression tests for the subsequent-fix path

**Why:** Lock in that the relaxed second-fix path still refuses the two real dangers — an *external* change to the target and a change to a *non-target* file — and that the first-fix path is untouched.

**Files:**
- Test: `test/workflow-e2e.test.js` (reuse helpers + constants)

- [ ] **Step 1: Write the failing/﻿passing guard-rail tests**

Add to `test/workflow-e2e.test.js`:

```js
async function driveToSecondFixPhase(fixture, t) {
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  fs.writeFileSync(fixture.target, '# Practical Workflow Target\n\nFirst fix output.\n');
  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));
  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_REOPEN }));
  return { start, opts };
}

test('guard=git second fix still rejects an external target change', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const { start, opts } = await driveToSecondFixPhase(fixture, t);
  // Simulate an out-of-band edit to the target before the second begin-fix.
  fs.appendFileSync(fixture.target, '\nUnexpected external edit.\n');
  const beginFix2 = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix2.ok, false);
  // G5 leaves the existing fingerprint-mismatch -> rollback-unavailable mapping unchanged
  // (re-categorizing it as externally-changed is out of scope for G5 — see "Out of scope").
  assert.equal(beginFix2.status, 'blocked');
  assert.equal(beginFix2.blockingReason, 'rollback-unavailable');
});

test('guard=git second fix still rejects a non-target worktree change', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const { start, opts } = await driveToSecondFixPhase(fixture, t);
  // Dirty a NON-target file in the worktree.
  fs.writeFileSync(path.join(fixture.root, 'docs', 'reference.md'), '# Reference\n\nTampered.\n');
  const beginFix2 = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix2.ok, false);
  assert.equal(beginFix2.blockingReason, 'unexpected-worktree-change');
});
```

Note: `fixture.reference` is `docs/reference.md`, committed at `init`, so editing it creates a tracked non-target worktree change that `inspectActualChangedFiles` flags.

- [ ] **Step 2: Run the tests**

Run: `node --test test/workflow-e2e.test.js`
Expected: both PASS. The external-change case is caught by `assertPreFixFingerprint`; its `manifest-fingerprint-mismatch` flows through the existing `runBeginFix` catch block, which maps it to `blocked` / `rollback-unavailable` (G5 leaves that mapping unchanged). The non-target case is caught by `inspectActualChangedFiles` (→ `unexpected-worktree-change`).

- [ ] **Step 3: Full suite + package check**

Run: `npm test`
Expected: all pass.

Run: `npm pack --dry-run`
Expected: succeeds; package contents unchanged (no new files shipped — only `lib/` and `test/` edits).

- [ ] **Step 4: Checkpoint**

Run `git status --short` and leave changes uncommitted unless the user explicitly requested commits for this implementation run.

---

## Out of scope for this plan (tracked elsewhere)

- G1/G3 (diff-review effectiveness, severity anchors + coverage) — prompt/rubric batch.
- G4 (re-review regression hint) — context-pack CLI batch.
- G2 (convergence / `fixAttemptCount` + `stopped-no-progress`) — state-machine batch.
- A `max-fix-attempts=` user token (G2 writes the cap as 5).
- Re-categorizing fingerprint-mismatch (`manifest-fingerprint-mismatch` / `target-fingerprint-mismatch`) from `rollback-unavailable` to `externally-changed`. This is a separate semantic improvement that would change existing behavior and break `test/workflow-e2e.test.js:689-693` and `test/fix-guard.test.js:309-316`; G5 deliberately keeps the existing mapping. Track it on its own if wanted.

## Release follow-through (after all four tasks are green)

- Bump `package.json` version to `0.2.1`.
- Add a CHANGELOG entry: "fix: guard=git now supports multi-cycle review-and-fix (previously blocked after the first fix with rollback-unavailable)."
- Run `npm test` and `npm pack --dry-run` once more before publishing.

## Self-Review (run against `design/ENHANCE-REVIEW-FIX-2026-05-30.md` §3 G5)

- **Spec coverage:** two begin-fix guards prior-fix-signal gated → Task 1 (anchor) + Task 2 (non-target swap + signal); per-fix snapshot anchor → Task 2; git abort restore as new behavior → Task 3; prior-fix signal uses `lastKnown != initial` not `currentRound` → Task 2 (asserted `currentRound===1` in the second-fix test); external-change (→ rollback-unavailable, mapping unchanged) + non-target (→ unexpected-worktree-change) guard rails + first-fix-unchanged → Task 4 + full-suite gate; full two-fix `guard=git` flow reaches PASS in Task 2. All G5 spec points map to a task.
- **Placeholder scan:** every code step contains complete code; every command has expected output. No TBD/TODO.
- **Type consistency:** `priorFix` (boolean) defined in Task 1 and passed in Task 2; `rollbackAnchor` carries `status:'passed'` + `snapshotPath` (Task 2) consumed by `readLatestFixGuardBaseline`/`restoreSnapshot` (Task 3); `inspectActualChangedFiles`/`checkTargetOnlyWorktree` both return `{status, blockingReason?, ...}` consumed identically by the existing `targetOnlyGuard.status === 'blocked'` branch.
- **Known edge (call out, do not fix here):** `abort-fix` on a git session that began *before* this change has no captured snapshot, so `restoreSnapshot` returns `missing` → `rollback-unavailable`. This only affects an in-flight fix resumed across the upgrade; acceptable for a transient state. Not introduced by normal new sessions.
