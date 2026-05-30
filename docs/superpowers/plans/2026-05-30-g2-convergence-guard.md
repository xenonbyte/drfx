# G2: Convergence / No-Progress Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the auto-fix loop a convergence guarantee: a deterministic per-target fix-attempt cap that stops the loop at a new pause state `stopped-no-progress` instead of looping forever, plus a coordinator-side recurrence heuristic.

**Architecture:** Add one persistent manifest integer `fixAttemptCount` (mirrors how `guardMode` was added in 0.2.0: present in the field tables, defaulted when absent from older manifests, never breaking resume). `begin-fix` increments it and refuses the next attempt once it has reached the cap (default 5) by finalizing to a new pause state `stopped-no-progress` with status reason `no-progress-detected`. The new status/reason are added to **every** enum copy (state validation, final-response parser, target-state validation, receipt-requiring set). The recurrence heuristic is prompt-only text in `shared/`.

**Tech Stack:** Node.js 20 CommonJS, `node:test` + `node:assert/strict`.

**Source spec:** `design/ENHANCE-REVIEW-FIX-2026-05-30.md` §3 G2 + D3/D4/D7. This is the convergence minor (third/last batch; G5 shipped, G1+G3+G4 is the quality batch).

**Cap semantics (fixed across the whole plan):** cap = 5. `fixAttemptCount` starts at 0; each successful `begin-fix` increments it after its guards pass. The 6th attempt is refused: when `fixAttemptCount` is already `>= 5` at `begin-fix` entry, do not write the target — stop as `stopped-no-progress`.

**Invariants (must hold after every task):**
- Older manifests without a `Fix attempt count:` line still load (default 0) — resume never fails on the new field.
- `npm test` passes after each task's final step.
- No change to the happy path that reaches `pass` within 5 fixes.

---

### Task 1: Add `fixAttemptCount` as a back-compatible manifest field

**Why:** The cap needs durable per-target state. Mirror `guardMode`'s exact back-compat pattern (added in 0.2.0): listed in both field tables, defaulted to a value when absent, manifest schema stays 2, resume of an older manifest does not fail.

**Files:**
- Modify: `lib/workflow-state.js` (`MANIFEST_V2_FIELDS` ~line 93-129; default-on-missing block ~line 230-236; normalize ~line 245; the two object assemblies ~line 358 and ~line 408; the text serializer ~line 465)
- Modify: `lib/target-state.js` (`MANIFEST_FIELDS` ~line 28-44; the two `guardMode: ...` assemblies at ~line 483 and ~line 609)
- Modify: `lib/workflow/start.js` (initialize at start, near `lastFixReportPath: 'none'` ~line 139)
- Test: `test/workflow-state-v2.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/workflow-state-v2.test.js`. This file already imports `formatManifestV2`/`parseManifestV2` and defines a `makeManifest(overrides = {})` helper (verified, ~line 18) that returns a full valid schema-2 manifest — use it:

```js
test('fixAttemptCount round-trips through format/parse', () => {
  const text = formatManifestV2(makeManifest({ fixAttemptCount: 3 }));
  assert.match(text, /^Fix attempt count: 3$/m);
  const parsed = parseManifestV2(text);
  assert.equal(parsed.fixAttemptCount, 3);
});

test('parseManifestV2 defaults fixAttemptCount to 0 when the line is absent (back-compat)', () => {
  const legacy = formatManifestV2(makeManifest())
    .split('\n').filter((line) => !line.startsWith('Fix attempt count:')).join('\n');
  const parsed = parseManifestV2(legacy);
  assert.equal(parsed.fixAttemptCount, 0);
});
```

(Note: `makeManifest` returns the field set used everywhere else in this file; once `fixAttemptCount` defaults in normalize/parse, `makeManifest()` without the override still round-trips with `Fix attempt count: 0`.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/workflow-state-v2.test.js`
Expected: FAIL — `fixAttemptCount` is dropped by format and is `undefined` after parse.

- [ ] **Step 3: Add the field in `lib/workflow-state.js`**

(a) In `MANIFEST_V2_FIELDS`, add the entry immediately after the `['currentRound', 'Current round'],` line:

```js
  ['fixAttemptCount', 'Fix attempt count'],
```

(b) In the normalize loop default-on-missing block (currently special-cases `guardMode`), broaden it so `fixAttemptCount` also defaults when absent. Replace:

```js
    if (key === 'guardMode' && !Object.hasOwn(manifest, key)) {
      normalized[key] = 'git';
    } else {
```

with:

```js
    if (key === 'guardMode' && !Object.hasOwn(manifest, key)) {
      normalized[key] = 'git';
    } else if (key === 'fixAttemptCount' && !Object.hasOwn(manifest, key)) {
      normalized[key] = '0';
    } else {
```

(c) Add integer normalization next to `currentRound` (after the `normalized.currentRound` lines ~245):

```js
  normalized.fixAttemptCount = normalizeInteger(normalized.fixAttemptCount, 'Fix attempt count');
  if (normalized.fixAttemptCount < 0) failState('Fix attempt count must be zero or a positive integer');
```

(d) In the parse-side object that defaults `guardMode` (the block at ~line 358 `if (!Object.hasOwn(result, 'guardMode')) result.guardMode = 'git';`), add right after it:

```js
  if (!Object.hasOwn(result, 'fixAttemptCount')) result.fixAttemptCount = 0;
```

(e) In the assembled return object at ~line 408 (the one with `guardMode: result.guardMode || 'git',`), add:

```js
    fixAttemptCount: Number(result.fixAttemptCount || 0),
```

(f) In the text serializer (the array of `` `Key: ${...}` `` lines, near `` `Guard mode: ...` `` ~line 465), add a line after the Current round line:

```js
    `Fix attempt count: ${manifest && Number.isInteger(manifest.fixAttemptCount) ? manifest.fixAttemptCount : 0}`,
```

- [ ] **Step 4: Add the field in `lib/target-state.js` (do NOT add it to `MANIFEST_FIELDS`)**

Verified: `target-state.js` `parseManifest` ends with `for (const [key] of MANIFEST_FIELDS) requireManifestValue(result, key)` (line ~464), which **requires every `MANIFEST_FIELDS` entry**. Adding `fixAttemptCount` there would make legacy manifests (without the line) fail to load — exactly the back-compat we must preserve. So:

(a) Do **not** add `fixAttemptCount` to `MANIFEST_FIELDS` in `target-state.js`. Leave that array unchanged.

(b) Add a reader default just before `assertAllowedStatus(result.status);` (~line 463), so a present line is captured and an absent one defaults to `'0'`:

```js
  if (!Object.hasOwn(result, 'fixAttemptCount')) result.fixAttemptCount = '0';
```

To capture the value when the line IS present (since it is not in `MANIFEST_FIELDS`, the label loop won't pick it up), add an explicit branch in the label dispatch (next to the `Created at`/`Updated at` branches at ~line 455-458):

```js
    } else if (label === 'Fix attempt count') {
      result.fixAttemptCount = value;
```

(c) At the two assembly sites that already carry `guardMode: manifest.guardMode || 'git',` (~line 483 and ~line 609), add:

```js
    fixAttemptCount: Number(manifest.fixAttemptCount || 0),
```

(d) Confirm `target-state.js` `formatManifest` writes the field. If `formatManifest` iterates `MANIFEST_FIELDS` (which now excludes `fixAttemptCount`), add an explicit `Fix attempt count: ${Number(manifest.fixAttemptCount || 0)}` line to its output next to the Current round line so writer/reader stay symmetric. Verify by reading `formatManifest` during execution; mirror exactly how it emits `Current round`.

- [ ] **Step 5: Initialize at start in `lib/workflow/start.js`**

Next to `lastFixReportPath: 'none',` (~line 139) in the manifest object that `start` writes, add:

```js
    fixAttemptCount: 0,
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --test test/workflow-state-v2.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`. Expected: all pass (legacy manifests in `test/finalize-resume.test.js` / `test/target-state.test.js` still load).

- [ ] **Step 8: Checkpoint**

`git status --short`; leave uncommitted unless the user requested commits.

---

### Task 2: Register `stopped-no-progress` + `no-progress-detected` in every enum

**Why:** A new terminal/pause status and its status reason must appear in every enum copy or finalize/parse/validate/receipt will reject it. There are multiple copies (verified): state validation, final-response machine-block parser, target-state validation, receipt-requiring set, plus the prose status lists.

**Files:**
- Modify: `lib/workflow-state.js` (`STATUS_VALUES` ~line 8-23; `STATUS_REASONS` ~line 62-75)
- Modify: `lib/semantic-parsers.js` (`FINAL_STATUSES` ~line 12-22; `STATUS_REASONS` ~line 46-58)
- Modify: `lib/target-state.js` (`ALLOWED_STATUSES` ~line 7-22)
- Modify: `lib/workflow/helpers.js` (`finalizationRequiresReceipt` ~line 1335-1346)
- Modify: `lib/receipts.js` (`RECEIPT_STOP_REASONS` ~line 8-18)
- Modify: `shared/long-task.md` (Status list ~line 50) and `shared/core.md` (Terminal And Pause States section)
- Test: `test/workflow-state-v2.test.js` + `test/semantic-parsers.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/workflow-state-v2.test.js`:

```js
test('stopped-no-progress is a valid manifest status with no-progress-detected reason', () => {
  const text = formatManifestV2(makeManifest({
    status: 'stopped-no-progress',
    currentPhase: 'final',
    statusReason: 'no-progress-detected'
  }));
  const parsed = parseManifestV2(text);
  assert.equal(parsed.status, 'stopped-no-progress');
  assert.equal(parsed.statusReason, 'no-progress-detected');
});
```

Note: confirm `makeManifest`'s default `status`/`currentPhase` produce a valid pairing with these overrides; `formatManifestV2` enforces status/phase coherence (e.g. an active status requires a matching phase), and `final` phase with a terminal status is the safe combination used here.

Append to `test/semantic-parsers.test.js` (it imports `parseFinalResponseBlock`). Verified: this file has no `makeFinalBlock` helper — it builds blocks inline with `[ ...lines ].join('\n')`. Use the same inline style (all 14 fields, in order):

```js
test('final response accepts stopped-no-progress with no-progress-detected', () => {
  const block = [
    'Final status: stopped-no-progress',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/spec.md',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: full re-review',
    'Deferrals or blockers: ISSUE-001 unresolved after fix-attempt cap',
    'Blocking reason: none',
    'Status reason: no-progress-detected',
    'Residual risk: ISSUE-001 remains unresolved',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');
  const parsed = parseFinalResponseBlock(block);
  assert.equal(parsed.finalStatus, 'stopped-no-progress');
  assert.equal(parsed.statusReason, 'no-progress-detected');
});
```

(`parseFinalResponseBlock` validates only the machine-block shape + enum membership; it does not require persistent state, so this stands alone.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/workflow-state-v2.test.js test/semantic-parsers.test.js`
Expected: FAIL — `stopped-no-progress` / `no-progress-detected` rejected by the enums.

- [ ] **Step 3: Add to `lib/workflow-state.js`**

In `STATUS_VALUES`, add after `'stopped-with-deferrals',`:

```js
  'stopped-no-progress',
```

In `STATUS_REASONS`, add after `'deferred-findings',`:

```js
  'no-progress-detected',
```

- [ ] **Step 4: Add to `lib/semantic-parsers.js`**

In `FINAL_STATUSES`, add after `'stopped-with-deferrals',`:

```js
  'stopped-no-progress',
```

In its `STATUS_REASONS`, add after `'deferred-findings',`:

```js
  'no-progress-detected',
```

- [ ] **Step 5: Add to `lib/target-state.js`**

In `ALLOWED_STATUSES`, add after `'stopped-with-deferrals',`:

```js
  'stopped-no-progress',
```

- [ ] **Step 6: Add to `lib/workflow/helpers.js`**

In `finalizationRequiresReceipt`'s array, add after `'stopped-with-deferrals',`:

```js
    'stopped-no-progress',
```

- [ ] **Step 7: Add to `lib/receipts.js`**

In `RECEIPT_STOP_REASONS`, add after `'stopped-with-deferrals',`:

```js
  'stopped-no-progress',
```

- [ ] **Step 8: Update prose status lists**

In `shared/long-task.md`, the `- Status:` line listing statuses: add `stopped-no-progress` to the comma list (after `stopped-with-deferrals`).

In `shared/core.md`, in the `## Terminal And Pause States` section's bullet list, add:

```
- `stopped-no-progress`: the fix loop hit the fix-attempt cap or a recurring unresolved finding; high or medium issues remain. This is a pause state, not PASS.
```

And in the same file's `Status reasons include` sentence, add `no-progress-detected` to the list.

- [ ] **Step 9: Run to verify they pass**

Run: `node --test test/workflow-state-v2.test.js test/semantic-parsers.test.js`
Expected: PASS.

- [ ] **Step 10: Run the full suite**

Run: `npm test`. Expected: all pass.

- [ ] **Step 11: Checkpoint**

`git status --short`; leave uncommitted.

---

### Task 3: `begin-fix` enforces the fix-attempt cap

**Why:** This is the deterministic convergence guarantee. `begin-fix` increments `fixAttemptCount` on success, and refuses the attempt that would exceed the cap by finalizing to `stopped-no-progress` instead of writing the target.

**Files:**
- Modify: `lib/workflow/fix-lifecycle.js` (`runBeginFix` — cap check near the top of the `try`, before guards; increment on the success manifest update ~line 133-140)
- Test: `test/workflow-e2e.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/workflow-e2e.test.js` (reuse `makeWorkflowRepo`, `workflowStartArgs`, `workflowOptions`, `manifestAt`, and the constants). This test seeds the cap directly on the manifest to avoid driving five full cycles:

```js
test('begin-fix refuses the attempt past the fix-attempt cap with stopped-no-progress', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));

  // Seed the manifest at the cap (5) so the next begin-fix is the refused 6th attempt.
  const manifestPath = start.manifestPath;
  const text = fs.readFileSync(manifestPath, 'utf8').replace(/^Fix attempt count: \d+$/m, 'Fix attempt count: 5');
  fs.writeFileSync(manifestPath, text);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, false, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'stopped-no-progress');
  assert.equal(beginFix.statusReason, 'no-progress-detected');
  // The target was not modified by the refused attempt.
  assert.equal(manifestAt(manifestPath).status, 'stopped-no-progress');
});

test('begin-fix increments fixAttemptCount on a successful attempt', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));

  assert.equal(Number(manifestAt(start.manifestPath).fixAttemptCount), 0);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], opts());
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(Number(manifestAt(start.manifestPath).fixAttemptCount), 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/workflow-e2e.test.js`
Expected: FAIL — the cap is not enforced and the count is not incremented.

- [ ] **Step 3: Add the cap constant and check + increment in `runBeginFix`**

In `lib/workflow/fix-lifecycle.js`, define a module-level constant near the top of the file (after the requires):

```js
const MAX_FIX_ATTEMPTS = 5;
```

In `runBeginFix`, inside the `try` block, BEFORE `acquireLock(...)` (so a refused attempt takes no lock and writes no target), add:

```js
    const priorAttempts = Number(metadata.manifest.fixAttemptCount || 0);
    if (priorAttempts >= MAX_FIX_ATTEMPTS) {
      updatePersistentManifest(metadata, {
        status: 'stopped-no-progress',
        currentPhase: 'final',
        blockingReason: 'none',
        statusReason: 'no-progress-detected'
      });
      return stateCommandBase(metadata, {
        ok: false,
        status: 'stopped-no-progress',
        blockingReason: 'none',
        statusReason: 'no-progress-detected',
        nextAction: 'fix-attempt cap reached; review unresolved findings manually or accept/defer them'
      });
    }
```

Then, on the SUCCESS manifest update (the existing `updatePersistentManifest(metadata, { status: 'fix', currentPhase: 'fix', ... runtimeFingerprintGuard: 'passed' })` at ~line 133-140), add the increment:

```js
      fixAttemptCount: priorAttempts + 1,
```

(Add it as one more property in that existing `updatePersistentManifest` object literal. Do not add a second update call.)

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/workflow-e2e.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`. Expected: all pass, including the existing G5 two-fix and abort tests (a 2-fix run stays well under the cap).

- [ ] **Step 6: Checkpoint**

`git status --short`; leave uncommitted.

---

### Task 4: finalize accepts `stopped-no-progress`; coordinator recurrence heuristic + route terminal lists

**Why:** finalize must treat `stopped-no-progress` as a valid pause finalization (write receipt, persist), and the prompts/routes must list it as a terminal state. Add the coordinator recurrence heuristic (semantic backup to the deterministic cap).

**Files:**
- Verify/Modify: `lib/workflow/finalize.js` (it delegates status/receipt rules to `finalizationRequiresReceipt` + `validateFinalResponse`, both already extended in Task 2 — confirm no status-specific branch rejects the new status)
- Modify: `shared/prompts/coordinator.md` (Terminal states list + recurrence heuristic) and `shared/core.md` (Loop convergence note)
- Modify: `skills/review-fix-spec/SKILL.md`, `skills/review-fix-plan/SKILL.md`, `skills/review-fix-design/SKILL.md`, `skills/review-fix-doc/SKILL.md` (terminal-state lists)
- Modify: `templates/claude-command.md.tmpl`, `templates/codex-skill.md.tmpl`, `templates/gemini-command.toml.tmpl` (terminal-state lists)
- Test: `test/workflow-e2e.test.js` (finalize), `test/shared-assets.test.js` (text)

- [ ] **Step 1: Write the failing tests**

Append to `test/shared-assets.test.js`:

```js
test('routes and prompts list stopped-no-progress as a terminal state', () => {
  for (const rel of [
    'shared/core.md',
    'shared/prompts/coordinator.md',
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md',
    'templates/claude-command.md.tmpl',
    'templates/codex-skill.md.tmpl',
    'templates/gemini-command.toml.tmpl'
  ]) {
    assert.match(read(rel), /stopped-no-progress/, `${rel} must list stopped-no-progress`);
  }
});

test('coordinator defines a recurrence + fix-attempt-cap convergence rule', () => {
  const coordinator = read('shared/prompts/coordinator.md');
  assert.match(coordinator, /fix-attempt cap|recurr/i);
  assert.match(coordinator, /stopped-no-progress/);
});
```

Append a finalize test to `test/workflow-e2e.test.js`:

```js
test('finalize accepts a stopped-no-progress final response', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const opts = () => workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') });

  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));

  const FINAL_NO_PROGRESS = [
    'Final status: stopped-no-progress',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/practical-target.md',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: node --test test/workflow-e2e.test.js',
    'Deferrals or blockers: ISSUE-001 unresolved after fix-attempt cap',
    'Blocking reason: none',
    'Status reason: no-progress-detected',
    'Residual risk: ISSUE-001 remains unresolved',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');

  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'],
    workflowOptions(fixture, { stdin: FINAL_NO_PROGRESS }));
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'stopped-no-progress');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/shared-assets.test.js test/workflow-e2e.test.js`
Expected: FAIL — terminal lists lack the status; finalize test may pass already (Task 2 wired the parser/validator) or fail if a finalize branch needs adjustment.

- [ ] **Step 3: Confirm finalize handles the status**

Read `lib/workflow/finalize.js` `runPersistentFinalize`. It builds validation state via `buildFinalValidationState`, calls `validateFinalResponse`, and writes a receipt when `finalizationRequiresReceipt(status)` is true (both extended in Task 2). Confirm there is no status allowlist in finalize.js that excludes `stopped-no-progress`. If the finalize test fails because `validateFinalResponse` rejects it, the gap is an enum from Task 2 — fix there, not with a special-case here. Make NO finalize.js change unless the test proves one is needed; if it does, record exactly what failed and the minimal line changed.

- [ ] **Step 4: Add coordinator recurrence heuristic + terminal entry in `shared/prompts/coordinator.md`**

In the `Terminal and pause states:` list, add:

```
- stopped-no-progress
```

In the `Triage and PASS rules:` area, add a convergence rule:

```
Convergence:
- The workflow enforces a deterministic fix-attempt cap (default 5 fixes per target); the 6th begin-fix is refused as stopped-no-progress.
- Additionally, if a high or medium finding that was marked fixed in an earlier round is raised again by a later full re-review at the same location/category, treat the loop as not converging: stop as stopped-no-progress with the recurring findings (redacted IDs/locations) and a next action, instead of attempting another fix.
- stopped-no-progress is a pause state, not PASS; unresolved high/medium findings remain.
```

- [ ] **Step 5: Add the convergence note in `shared/core.md`**

In `shared/core.md`, in the `## Loop` or `## Terminal And Pause States` area (whichever the Task 2 Step 8 edit touched), ensure the deterministic cap is described once:

```
The fix loop is bounded: after a deterministic fix-attempt cap (default 5 fixes per target), or when a previously fixed high/medium finding recurs, the loop stops as `stopped-no-progress` rather than fixing indefinitely.
```

- [ ] **Step 6: Add `stopped-no-progress` to the four SKILL.md terminal lists**

Each `skills/review-fix-*/SKILL.md` ends with a line like `Run the loop until pass, stopped-with-deferrals, read-only-findings, blocked, unsupported, externally-changed, possible-target-replacement, user stop, or checkpoint.` Add `stopped-no-progress` to that comma list (after `stopped-with-deferrals`) in all four files.

- [ ] **Step 7: Add `stopped-no-progress` to the three route templates**

In `templates/claude-command.md.tmpl`, `templates/codex-skill.md.tmpl`, `templates/gemini-command.toml.tmpl`, find their terminal/pause state lists (same wording as the SKILL files) and add `stopped-no-progress` after `stopped-with-deferrals`.

- [ ] **Step 8: Run to verify they pass**

Run: `node --test test/shared-assets.test.js test/workflow-e2e.test.js`
Expected: PASS.

- [ ] **Step 9: Full suite + package check**

Run: `npm test` (all pass). Run: `npm pack --dry-run` (succeeds; file list unchanged — only `lib/`, `shared/`, `skills/`, `templates/`, `test/` edits, all already packaged).

- [ ] **Step 10: Checkpoint**

`git status --short`; leave uncommitted.

---

## Out of scope for this plan

- A user-facing `max-fix-attempts=` token (cap is hard-coded 5; tokenization is a later option per D7).
- A full issue-dependency graph for recurrence (the heuristic + deterministic cap suffice per D3).
- G1/G3/G4 and G5 (other batches).

## Release follow-through (after all four tasks are green)

- New pause state → minor bump (e.g. `0.2.3` after the quality batch).
- CHANGELOG: "feat: auto-fix loop now converges — a fix-attempt cap (5) and recurrence heuristic stop the loop as `stopped-no-progress` instead of looping forever."
- `README.md` / `README.zh-CN.md`: add `stopped-no-progress` to any terminal-state listing; keep both languages aligned.
- Run `npm test` and `npm pack --dry-run` before publishing.

## Self-Review (run against `design/ENHANCE-REVIEW-FIX-2026-05-30.md` §3 G2)

- **Spec coverage:** `fixAttemptCount` back-compat field (Task 1, mirrors guardMode); `stopped-no-progress` + `no-progress-detected` in all 6 enum copies + prose (Task 2); deterministic cap=5 enforced at begin-fix with increment (Task 3); finalize acceptance + coordinator recurrence heuristic + route/SKILL terminal lists (Task 4). All G2 spec points map to a task.
- **Back-compat invariant:** Task 1 Step 1 explicitly tests a legacy manifest missing the line → defaults to 0; cap uses `Number(manifest.fixAttemptCount || 0)` so absent = 0.
- **Enum-copy completeness:** Task 2 covers `workflow-state.js` (×2), `semantic-parsers.js` (×2), `target-state.js`, `helpers.js` `finalizationRequiresReceipt`, `receipts.js`, plus `core.md`/`long-task.md` prose — the exact set the spec's "落点" enumerates.
- **Type consistency:** `fixAttemptCount` is an integer everywhere (`normalizeInteger` in Task 1c; `Number(...)` reads in Task 3); status string `stopped-no-progress` and reason `no-progress-detected` are identical across all tasks and tests.
- **Verified (resolved at plan time):** (1) `fixAttemptCount` must NOT go in `target-state.js` `MANIFEST_FIELDS` — that array is the `requireManifestValue` required set (line ~464), so it stays out; the field is handled via an explicit label branch + reader default + assembly lines (Task 1 Step 4). (2) Test fixtures: `test/workflow-state-v2.test.js` has `makeManifest(overrides)` (used in Task 1/2 tests); `test/semantic-parsers.test.js` has no block helper — Task 2 uses an inline 14-line `join('\n')` block. (3) Open at execution only: Task 4 Step 3 — whether `finalize.js` needs any change (expected none; it delegates to the Task-2-extended `finalizationRequiresReceipt` + `validateFinalResponse`). Resolve by running the finalize test; change finalize.js only if it proves necessary.
