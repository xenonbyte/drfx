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
- Modify: `lib/workflow-state.js` (`MANIFEST_V2_FIELDS` ~line 93-129; default-on-missing block ~line 230-236; normalize ~line 245; the two `parseManifestV2` defaults/return at ~line 358 and ~line 408). **No serializer edit** — `formatManifestV2` iterates the field table.
- Modify: `lib/workflow/start.js` (initialize at start, near `lastFixReportPath: 'none'` ~line 139)
- Test: `test/workflow-state-v2.test.js`
- (`lib/target-state.js`: not required — see Step 4.)

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

(d) In `parseManifestV2`'s returned object: it defaults `guardMode` at ~line 358 (`if (!Object.hasOwn(result, 'guardMode')) result.guardMode = 'git';`); add right after it:

```js
  if (!Object.hasOwn(result, 'fixAttemptCount')) result.fixAttemptCount = 0;
```

(e) **No return-object or text-serializer change is needed.** Verified: `parseManifestV2` returns `normalizeManifestV2(result)` directly, so there is no assembled return object to edit. Verified: `formatManifestV2` (workflow-state.js:308) does NOT hand-write each line — it iterates `MANIFEST_V2_FIELDS` (`for (const [key, label] of MANIFEST_V2_FIELDS) lines.push(\`${label}: ${normalized[key]}\`)`). Once `fixAttemptCount` is in `MANIFEST_V2_FIELDS` (Step 3a), defaulted (Step 3d), and normalized (Step 3c), the parsed value is returned and the `Fix attempt count:` line is emitted automatically. Adding a manual return-field or serializer line here would duplicate or drift.

- [ ] **Step 4: target-state — DEFENSIVE ONLY (the workflow does not require this field here)**

**Context (verified):** The live manifest is written by `formatManifestV2` and read on the main path by `parseManifestV2`. `target-state.js`'s separate `parseManifest`/`formatManifest`/`MANIFEST_FIELDS` are a different, older serializer — but `parseManifest` IS still reached on the V2 begin-fix path via `lock.js` (`readManifest` → `assertPreFixFingerprint` → `manifestLastKnownSha`). However, `parseManifest` **silently ignores unknown lines** (target-state.js:449/452-459: an unrecognized `Label:` line is skipped, no error). So the extra `Fix attempt count:` line that `formatManifestV2` now emits does NOT break `parseManifest`, and `parseManifest` does not need the value.

**Recommended: skip Step 4 entirely.** The begin-fix cap (Task 3) reads `fixAttemptCount` from `metadata.manifest`, which is produced by `parseManifestV2` (Task 1 Step 3) — not from target-state's `parseManifest`. The only target-state reach on the begin-fix path (`lock.js` → `readManifest` → `manifestLastKnownSha`) consumes `lastKnownContentSha256`, never `fixAttemptCount`. Since `parseManifest` silently ignores the unknown `Fix attempt count:` line, nothing breaks. Do NOT add `fixAttemptCount` to `MANIFEST_FIELDS` (that array is the `requireManifestValue` required set at line ~464; adding it would make any manifest lacking the line fail to load), and do NOT touch the assembly sites or `formatManifest`.

(Optional, only if a future caller needs `parseManifest` to surface the value: add a read-side capture in the label dispatch next to the `Created at`/`Updated at` branches — `} else if (label === 'Fix attempt count') { result.fixAttemptCount = value;` — and a default before `assertAllowedStatus`. Not required by G2.)

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
- Modify: `lib/workflow/helpers.js` (`finalizationRequiresReceipt` ~line 1335-1346; `resumeRequiresReceipt` ~line 1829-1838)
- Modify: `lib/receipts.js` (`RECEIPT_STOP_REASONS` ~line 8-18)
- Modify: `shared/long-task.md` (Status list ~line 50) and `shared/core.md` (Terminal And Pause States section)
- Test: `test/workflow-state-v2.test.js` + `test/semantic-parsers.test.js` + `test/finalize-resume.test.js`

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

Append to `test/finalize-resume.test.js` (extend the existing helper import from `../lib/workflow/helpers` or add one if absent):

```js
test('resume requires receipt for stopped-no-progress', () => {
  const { resumeRequiresReceipt } = require('../lib/workflow/helpers');
  assert.equal(resumeRequiresReceipt('stopped-no-progress'), true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/workflow-state-v2.test.js test/semantic-parsers.test.js test/finalize-resume.test.js`
Expected: FAIL — `stopped-no-progress` / `no-progress-detected` rejected by the enums and `resumeRequiresReceipt` does not yet require a receipt for the new pause state.

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

- [ ] **Step 5: Add to `lib/target-state.js` `ALLOWED_STATUSES` (REQUIRED — not optional)**

In `ALLOWED_STATUSES` (~line 7-22), add after `'stopped-with-deferrals',`:

```js
  'stopped-no-progress',
```

**Why required even though Task 1 Step 4 (target-state field) was not:** the begin-fix path reaches `target-state.js` `parseManifest` via `lock.js` (`readManifest` → `assertPreFixFingerprint` → `manifestLastKnownSha`), and `parseManifest` ends with `assertAllowedStatus(result.status)` (target-state.js:463). Once a manifest is persisted with `Status: stopped-no-progress`, any later command whose `assertPreFixFingerprint` re-reads it through `readManifest` throws unless `ALLOWED_STATUSES` includes it. (`parseManifest` ignores unknown *fields* but validates the *status value*.)

- [ ] **Step 6: Add to `lib/workflow/helpers.js`**

In `finalizationRequiresReceipt`'s array, add after `'stopped-with-deferrals',`:

```js
    'stopped-no-progress',
```

In `resumeRequiresReceipt`'s array, add after `'stopped-with-deferrals',`:

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

Run: `node --test test/workflow-state-v2.test.js test/semantic-parsers.test.js test/finalize-resume.test.js`
Expected: PASS.

- [ ] **Step 10: Run the full suite**

Run: `npm test`. Expected: all pass.

- [ ] **Step 11: Checkpoint**

`git status --short`; leave uncommitted.

---

### Task 3: `begin-fix` enforces the fix-attempt cap

**Why:** This is the deterministic convergence guarantee. `begin-fix` increments `fixAttemptCount` on success, and refuses the attempt that would exceed the cap by returning/persisting a `stopped-no-progress` stop signal instead of writing the target. The route must then finalize that stop signal through the normal final-response path.

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
  // The target was not modified by the refused attempt, but the route must still
  // finalize to write the final receipt/summary through the validated final path.
  assert.equal(manifestAt(manifestPath).status, 'stopped-no-progress');

  const FINAL_NO_PROGRESS = [
    'Final status: stopped-no-progress',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/practical-target.md',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: begin-fix cap refusal',
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
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'rounds', '001-final-stopped-no-progress.md')), true);
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
Expected: FAIL — the cap is not enforced, the count is not incremented, and the stopped cap path does not yet have finalized receipt coverage.

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

This refused `begin-fix` result is a stop signal, not the complete terminal response. The generated route/coordinator must follow it by submitting a `Final status: stopped-no-progress` payload through `drfx workflow finalize <targetStateDir> --final-response-stdin --json`, so final-response validation, receipt writing, and summary generation use the same path as other pause states.

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
- Verify/Modify: `lib/workflow/finalize.js` (it delegates status/receipt rules to `finalizationRequiresReceipt` + `validateFinalResponse`; confirm no status-specific branch rejects the new status)
- Modify: `lib/final-response.js` (`validateReadOnly`/status-specific final validation — require `stopped-no-progress` to use `Status reason: no-progress-detected`)
- Modify: `shared/prompts/coordinator.md` (Terminal states list + recurrence heuristic) and `shared/core.md` (Loop convergence note)
- Modify: `skills/review-fix-spec/SKILL.md`, `skills/review-fix-plan/SKILL.md`, `skills/review-fix-design/SKILL.md`, `skills/review-fix-doc/SKILL.md` (terminal-state lists)
- Modify: `templates/claude-command.md.tmpl`, `templates/codex-skill.md.tmpl`, `templates/gemini-command.toml.tmpl` (terminal-state lists)
- Test: `test/workflow-e2e.test.js` (finalize), `test/finalize-resume.test.js` (final-response validation), `test/shared-assets.test.js` (text)

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

Append a recurrence-stop workflow test to `test/workflow-e2e.test.js`. This test intentionally models the semantic coordinator decision with deterministic payloads: a fixed high/medium issue reappears at the same location/category after `DIFF-OK -> full-re-review`, so the coordinator stops as no-progress instead of starting another fix.

```js
test('recurring high finding after full re-review finalizes stopped-no-progress', async (t) => {
  const fixture = makeWorkflowRepo(t);
  const startArgs = workflowStartArgs(fixture, 'review-and-fix', 'practical', 'codex', { guardMode: 'git' });
  const start = await runWorkflowCommand('start', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('context', startArgs, workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'initial-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_ACCEPT }));
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'],
    workflowOptions(fixture, { now: new Date('2026-05-21T00:00:00.000Z') }));

  fs.writeFileSync(
    fixture.target,
    [
      '# Practical Workflow Target',
      '',
      'The document now states the expected behavior directly for implementers.',
      '',
      '## Acceptance',
      '',
      '- The final wording names the expected behavior.',
      ''
    ].join('\n')
  );

  await runWorkflowCommand('end-fix', [start.targetStateDir, '--fix-report-stdin', '--json'],
    workflowOptions(fixture, { stdin: FIX_REPORT }));
  await runWorkflowCommand('record-diff-review', [start.targetStateDir, '--result-stdin', '--json'],
    workflowOptions(fixture, { stdin: DIFF_OK }));
  await runWorkflowCommand('context', [...startArgs, '--phase', 'full-re-review'], workflowOptions(fixture));
  await runWorkflowCommand('record-review', [...startArgs, '--phase', 'full-re-review', '--result-stdin'],
    workflowOptions(fixture, { stdin: REVIEW_FAIL }));
  await runWorkflowCommand('record-triage', [...startArgs, '--triage-stdin'],
    workflowOptions(fixture, { stdin: TRIAGE_REOPEN }));

  const FINAL_NO_PROGRESS = [
    'Final status: stopped-no-progress',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/practical-target.md',
    'Files changed: docs/practical-target.md',
    'Fixed issue IDs: ISSUE-001',
    'Verification performed: full re-review found recurring ISSUE-001',
    'Deferrals or blockers: ISSUE-001 recurred at docs/practical-target.md#practical-workflow-target',
    'Blocking reason: none',
    'Status reason: no-progress-detected',
    'Residual risk: ISSUE-001 remains unresolved after recurrence',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');

  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'],
    workflowOptions(fixture, { stdin: FINAL_NO_PROGRESS }));
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'stopped-no-progress');
  const manifest = manifestAt(start.manifestPath);
  assert.equal(manifest.status, 'stopped-no-progress');
  assert.equal(manifest.statusReason, 'no-progress-detected');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'rounds', '001-final-stopped-no-progress.md')), true);
});
```

Append status-specific final-response validation tests to `test/finalize-resume.test.js`:

```js
test('final response validation requires no-progress reason for stopped-no-progress', () => {
  const state = {
    persistent: true,
    target: 'docs/spec.md',
    mode: 'review-and-fix',
    assurance: 'practical',
    runtimePlatform: 'codex',
    filesChanged: 'none',
    unresolvedBlockingIssues: ['ISSUE-001']
  };
  const finalResponse = {
    ...baseBlock,
    finalStatus: 'stopped-no-progress',
    filesChanged: 'none',
    fixedIssueIds: 'none',
    deferralsOrBlockers: 'ISSUE-001 unresolved after fix-attempt cap',
    statusReason: 'none',
    coordinatorAgreement: 'none'
  };

  assert.throws(
    () => validateFinalResponse({ finalResponse, state }),
    /no-progress-detected/i
  );

  const accepted = validateFinalResponse({
    finalResponse: { ...finalResponse, statusReason: 'no-progress-detected' },
    state
  });
  assert.equal(accepted.status, 'stopped-no-progress');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/shared-assets.test.js test/workflow-e2e.test.js test/finalize-resume.test.js`
Expected: FAIL — terminal lists lack the status, and `validateFinalResponse` does not yet enforce the `stopped-no-progress` / `no-progress-detected` pairing.

- [ ] **Step 3: Add status-specific final validation; confirm finalize delegates cleanly**

In `lib/final-response.js`, add a status-specific branch near the existing persistent `stopped-with-deferrals` validation:

```js
  if (state && state.persistent && finalResponse.finalStatus === 'stopped-no-progress') {
    const unresolvedIssueIds = normalizeIssueIds([
      ...(Array.isArray(state.unresolvedBlockingIssues) ? state.unresolvedBlockingIssues : []),
      ...(Array.isArray(state.deferredBlockingIssueIds) ? state.deferredBlockingIssueIds : []),
      ...(Array.isArray(state.readOnlyBlockingIssueIds) ? state.readOnlyBlockingIssueIds : [])
    ]);
    if ((finalResponse.blockingReason || 'none') !== 'none') {
      fail('ERR_FINAL_NO_PROGRESS_BLOCKING_REASON', 'stopped-no-progress requires Blocking reason: none');
    }
    if (finalResponse.statusReason !== 'no-progress-detected') {
      fail('ERR_FINAL_NO_PROGRESS_STATUS_REASON', 'stopped-no-progress requires Status reason: no-progress-detected');
    }
    if (unresolvedIssueIds.length === 0) {
      fail('ERR_FINAL_NO_PROGRESS_FINDINGS_EMPTY', 'stopped-no-progress requires unresolved high/medium findings');
    }
  }
```

Then read `lib/workflow/finalize.js` `runPersistentFinalize`. It builds validation state via `buildFinalValidationState`, calls `validateFinalResponse`, and writes a receipt when `finalizationRequiresReceipt(status)` is true (Task 2). Confirm there is no status allowlist in finalize.js that excludes `stopped-no-progress`. Make NO finalize.js change unless the test proves one is needed; if it does, record exactly what failed and the minimal line changed.

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

Run: `node --test test/shared-assets.test.js test/workflow-e2e.test.js test/finalize-resume.test.js`
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

- **Spec coverage:** `fixAttemptCount` back-compat field (Task 1, mirrors guardMode); `stopped-no-progress` + `no-progress-detected` in all enum/list copies + prose (Task 2); deterministic cap=5 enforced at begin-fix with increment and finalized receipt coverage (Task 3); finalize acceptance + final-response pairing validation + coordinator recurrence heuristic + route/SKILL terminal lists + recurrence-stop e2e coverage (Task 4). All G2 spec points map to a task.
- **Back-compat invariant:** Task 1 Step 1 explicitly tests a legacy manifest missing the line → defaults to 0; cap uses `Number(manifest.fixAttemptCount || 0)` so absent = 0.
- **Enum-copy completeness:** Task 2 covers `workflow-state.js` (×2), `semantic-parsers.js` (×2), `target-state.js`, `helpers.js` `finalizationRequiresReceipt` and `resumeRequiresReceipt`, `receipts.js`, plus `core.md`/`long-task.md` prose — the exact set the spec's "落点" enumerates plus the resume receipt list that mirrors terminal pause handling.
- **Type consistency:** `fixAttemptCount` is an integer everywhere (`normalizeInteger` in Task 1c; `Number(...)` reads in Task 3); status string `stopped-no-progress` and reason `no-progress-detected` are identical across all tasks and tests.
- **Verified (resolved at plan time, corrected after a code-grounded plan review):**
  1. The live manifest is written by `formatManifestV2` and read on the main path by `parseManifestV2`. `parseManifestV2` returns `normalizeManifestV2(result)` directly, and `formatManifestV2` (workflow-state.js:308) **iterates `MANIFEST_V2_FIELDS`**, so adding `fixAttemptCount` to that table + default + normalize auto-emits and auto-parses it — **no return-object or serializer line** (the original manual return/serializer edits would have been wrong or duplicative; removed).
  2. `lib/target-state.js` has a *separate, older* `parseManifest`/`formatManifest`/`MANIFEST_FIELDS`. The begin-fix cap reads `fixAttemptCount` from `parseManifestV2`, never from `parseManifest`. So **Task 1 Step 4 (target-state write of the field) is optional/defensive and recommended-skip** — `parseManifest` silently ignores the unknown `Fix attempt count:` line (target-state.js:449/452-459). Do NOT add it to `MANIFEST_FIELDS` (the `requireManifestValue` required set, line ~464).
  3. **Task 2 Step 5 (target-state `ALLOWED_STATUSES`) IS required**, by contrast: begin-fix → `lock.js` `readManifest` → `parseManifest` → `assertAllowedStatus(result.status)` (line ~463) validates the *status value*, so a persisted `stopped-no-progress` would throw on the next read unless listed.
  4. Test fixtures: `test/workflow-state-v2.test.js` has `makeManifest(overrides)`; `test/semantic-parsers.test.js` has no block helper — Task 2 uses an inline 14-line `join('\n')` block.
  5. Open at execution only: Task 4 Step 3 — `finalize.js` is expected to need no change (it delegates to the Task-2-extended `finalizationRequiresReceipt` + the Task-4-extended `validateFinalResponse`); confirm by running the finalize test, change it only if proven necessary.
