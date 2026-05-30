# G1+G3+G4: Review/Fix Skill Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the semantic quality of the review/fix loop without changing any machine schema: (G1) diff review verifies a fix actually resolves its finding; (G3) severity is anchored and reviewer PASS is auditable via the Summary line; (G4) full re-review gets a redacted "changed since last review" hint to hunt fix-induced regressions.

**Architecture:** G1/G3 are **prompt/rubric text only** — they deliberately do NOT add machine fields, because `lib/semantic-parsers.js` (DIFF-OK = exactly 2 lines; DIFF-FAIL fields = `issue_id/problem/required_action`) and `lib/reviewer-report.js` (PASS = exactly 2 lines; FAIL line 2 = `Findings:`) reject extra lines. So fix-effectiveness folds into the existing DIFF-FAIL fields, and coverage folds into the existing free-text `Summary:` line. G4 is the only CLI change: `lib/context-pack.js` gains an optional `changedSinceLastReview` field that `lib/workflow/persistent-context.js` populates from the issue ledger when the target has already been fixed this session (`lastKnownContentSha256 !== initialContentSha256`).

**Tech Stack:** Node.js 20 CommonJS, `node:test` + `node:assert/strict`. Tests for prompt/rubric text use `test/shared-assets.test.js` (`read('shared/...')` + `assert.match(/.../)`).

**Source spec:** `design/ENHANCE-REVIEW-FIX-2026-05-30.md` §3 G1, G3, G4 + D1. This is the "quality" minor (second of three batches; G5 already shipped, G2 is separate).

**Invariants (must hold after every task):**
- No new machine schema lines in reviewer/diff-review/fix-report payloads. `test/semantic-parsers.test.js` and `test/reviewer-report.test.js` stay green unchanged.
- `npm test` passes after each task's final step.
- G1/G3 touch only `shared/` text. G4 adds one optional `buildContextPack` field defaulting to `null`.

---

### Task 1 (G1): Diff review verifies fix effectiveness

**Why:** Today diff review only checks fixes map to accepted issues + no unrelated scope. A fix that edits the right location but does not resolve the finding's `why_it_matters` passes diff review and may silently slip toward PASS at the next (fresh, memoryless) re-review. Make the coordinator judge effectiveness, folding "not resolved" into the existing DIFF-FAIL fields (no schema change).

**Files:**
- Modify: `shared/core.md` (the `## Diff Review` section)
- Modify: `shared/prompts/coordinator.md` (the `Diff review:` block)
- Modify: `shared/prompts/fixer.md` (the `Output:` block)
- Test: `test/shared-assets.test.js`

- [ ] **Step 1: Write the failing assertions**

Append to `test/shared-assets.test.js`:

```js
test('diff review requires fix-effectiveness verification (no new machine fields)', () => {
  const core = read('shared/core.md');
  const coordinator = read('shared/prompts/coordinator.md');
  const fixer = read('shared/prompts/fixer.md');

  // G1: effectiveness is a prompt discipline folded into the existing DIFF-FAIL fields.
  assert.match(core, /resolves the original finding|actually resolve|does not resolve/i);
  assert.match(coordinator, /resolves the original finding|does not resolve/i);
  assert.match(fixer, /how (the|this) (change|fix) resolves|how it resolves the/i);

  // Must NOT introduce a machine field for it.
  assert.doesNotMatch(core, /^\s*resolves:\s*(yes|no|partial)/im);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/shared-assets.test.js`
Expected: the new test FAILS (the effectiveness wording is not present yet).

- [ ] **Step 3: Add the effectiveness discipline to `shared/core.md`**

In `shared/core.md`, in the `## Diff Review` section, the confirm list currently reads:

```
- Every claimed fix maps to an accepted issue.
- No unrelated scope was introduced.
- Terminology and structure remain coherent.
- No required-section placeholder was added.
- Sensitive values were not copied into workflow state or responses.
```

Add one item to that list:

```
- Every claimed fix actually resolves the original finding's `why_it_matters`, not merely that an edit was made at its location. If a claimed fix does not resolve its finding, record it as a `DIFF-FAIL` using the existing fields (`problem` = why the change does not resolve the original finding; `required_action` = the concrete next step). Do not add new fields.
```

- [ ] **Step 4: Add the same discipline to `shared/prompts/coordinator.md`**

In `shared/prompts/coordinator.md`, the `Diff review:` block currently begins:

```
Diff review:
- Before full re-review, check issue mapping, unrelated scope, terminology, placeholders, readability, and structural coherence.
```

Change that first bullet to include effectiveness:

```
Diff review:
- Before full re-review, check issue mapping, unrelated scope, terminology, placeholders, readability, structural coherence, and that each claimed fix actually resolves the original finding's why_it_matters (not just that an edit was made at the location).
- A claimed fix that does not resolve its finding is a DIFF-FAIL: report it with the existing issue_id/problem/required_action fields (problem = why it does not resolve the finding). Do not add new fields.
```

- [ ] **Step 5: Add the fix-rationale line to `shared/prompts/fixer.md`**

In `shared/prompts/fixer.md`, the `Output:` block's `Fixed:` line currently reads:

```
Fixed:
- ISSUE-001: <summary>
```

Change it to require a resolution rationale:

```
Fixed:
- ISSUE-001: <summary; state briefly how the change resolves the original finding, for diff-review verification>
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --test test/shared-assets.test.js`
Expected: PASS.

- [ ] **Step 7: Checkpoint**

Run: `npm test`. Expected: all pass (including unchanged `test/semantic-parsers.test.js`). Run `git status --short`; leave uncommitted unless the user requested commits.

---

### Task 2 (G3): Severity anchors + auditable coverage in the Summary line

**Why:** Severity (high/medium/low) is assigned with no anchored definition (drift across runs), and a `PASS / Summary: none` gives the coordinator no signal about which rubric dimensions were exercised. Add severity anchors to the COMMON rubric and require the reviewer to state coverage inside the existing free-text `Summary:` line (no new machine line). The coordinator's existing "independent agreement" step then has something concrete to check.

**Files:**
- Modify: `shared/rubrics/common.md` (add severity anchors + a coverage-group list per type)
- Modify: `shared/prompts/reviewer.md` (Instructions: reference severity anchors; state coverage in Summary)
- Modify: `shared/prompts/coordinator.md` (Loop step 10 / agreement: check Summary coverage)
- Test: `test/shared-assets.test.js`

- [ ] **Step 1: Write the failing assertions**

Append to `test/shared-assets.test.js`:

```js
test('common rubric defines severity anchors; reviewer states coverage in Summary (no machine line)', () => {
  const common = read('shared/rubrics/common.md');
  const reviewer = read('shared/prompts/reviewer.md');
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(common, /Severity anchors:/);
  assert.match(common, /high:.*blocks/i);
  assert.match(common, /medium:.*materially/i);
  assert.match(common, /low:.*clarity|low:.*does not block/i);

  // Coverage is stated inside the existing Summary line, NOT a new machine line.
  assert.match(reviewer, /state[^.]*coverage[^.]*Summary|within the Summary/i);
  assert.doesNotMatch(reviewer, /^Coverage:/m);
  assert.match(coordinator, /coverage|exercised the required/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/shared-assets.test.js`
Expected: FAILS (anchors + coverage wording absent).

- [ ] **Step 3: Add severity anchors to `shared/rubrics/common.md`**

In `shared/rubrics/common.md`, immediately under the `# COMMON Rubric` heading line and its first paragraph, insert:

```markdown
## Severity anchors

Apply these to all document types; type rubrics do not redefine them:

- high: blocks the document's stated purpose, or makes execution/acceptance unsafe or impossible.
- medium: materially weakens correctness or completeness, but a competent next actor can still proceed with caution.
- low: a clarity, consistency, or structure improvement that does not block use in normal mode.

## Coverage groups

State, in the reviewer Summary line, which of these groups you exercised (terse, e.g. `covered background/objective/coherence/constraints/risks/reference`):

- COMMON: background, objective, coherence, actionability, constraints, risks, project-alignment, reference.
- SPEC adds: requirements, scope, actors, permissions, io/errors, acceptance, edge cases.
- PLAN adds: executable-order, prerequisites, verification, rollback, blast-radius, stop-conditions.
- DESIGN adds: flows, states, transitions, contracts, data-flow, accessibility, hidden-scope.
```

- [ ] **Step 4: Update reviewer Instructions in `shared/prompts/reviewer.md`**

In `shared/prompts/reviewer.md`, in the `Instructions:` list, add two bullets (place after the existing severity bullets near `- In normal strictness, PASS only if...`):

```
- Assign severity using the severity anchors defined in the merged rubric (high/medium/low), not by intuition.
- State, within the Summary line, which rubric coverage groups for this document type you exercised (terse). Do not add a separate Coverage line; the Summary line is the only free-text field.
```

- [ ] **Step 5: Update coordinator agreement in `shared/prompts/coordinator.md`**

In `shared/prompts/coordinator.md`, the `Loop:` step 10 currently reads:

```
10. Check before automatic PASS: only pass when the full-document review passes and the coordinator independently agrees.
```

Change it to:

```
10. Check before automatic PASS: only pass when the full-document review passes and the coordinator independently agrees. Before agreeing, confirm the reviewer Summary states coverage of the required rubric groups for the document type; if a required group is unstated, require a re-review instead of passing.
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --test test/shared-assets.test.js`
Expected: PASS. Also confirm `test/reviewer-report.test.js` is unaffected (reviewer output still has no extra machine line).

- [ ] **Step 7: Checkpoint**

Run: `npm test`. Expected: all pass. `git status --short`; leave uncommitted.

---

### Task 3 (G4): Re-review regression hint via the context pack

**Why:** Every full re-review is a fresh isolated reviewer with no signal about what the prior fix changed, so it can't focus on fix-induced regressions. Add an optional, redacted `changedSinceLastReview` field to the reviewer context pack, populated by the CLI from the issue ledger when the target has already been fixed this session. This stays file-backed (resume-safe) and does not break isolation (the reviewer still reviews the whole document).

**Files:**
- Modify: `lib/context-pack.js` (function `buildContextPack`)
- Modify: `lib/workflow/persistent-context.js` (function `runPersistentContext`)
- Modify: `shared/prompts/reviewer.md` (Instructions)
- Test: `test/context-triage.test.js` (or a new `test/context-pack.test.js` if no suitable home exists) + `test/shared-assets.test.js`

- [ ] **Step 1: Write the failing tests**

In `test/shared-assets.test.js`, append:

```js
test('reviewer must not narrow the review when given changed-since-last-review', () => {
  const reviewer = read('shared/prompts/reviewer.md');
  assert.match(reviewer, /Changed since last review/i);
  assert.match(reviewer, /still review the (whole|full) document|do not narrow/i);
});
```

In a context-pack test file (prefer `test/context-triage.test.js`; mirror its existing `buildContextPack` usage), append a unit test:

```js
const { buildContextPack } = require('../lib/context-pack');

test('buildContextPack omits changedSinceLastReview by default and includes it when provided', () => {
  const base = buildContextPack({ target: 'docs/spec.md', documentType: 'SPEC', phase: 'full-re-review' });
  assert.equal(base.changedSinceLastReview, null);

  const withHint = buildContextPack({
    target: 'docs/spec.md',
    documentType: 'SPEC',
    phase: 'full-re-review',
    changedSinceLastReview: { fixedIssueIds: ['ISSUE-001'], sections: ['Requirements'] }
  });
  assert.deepEqual(withHint.changedSinceLastReview, { fixedIssueIds: ['ISSUE-001'], sections: ['Requirements'] });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/shared-assets.test.js test/context-triage.test.js`
Expected: both new tests FAIL (`changedSinceLastReview` is undefined on the pack; reviewer wording absent).

- [ ] **Step 3: Add the field to `lib/context-pack.js`**

In `lib/context-pack.js` `buildContextPack`, add the parameter (in the destructured options, next to `acceptedNonBlockingLowIssueIds`):

```js
  acceptedNonBlockingLowIssueIds = [],
  changedSinceLastReview = null,
```

and add it to the returned object (next to `acceptedNonBlockingLowIssueIds: normalizeAcceptedNonBlocking(...)`):

```js
    changedSinceLastReview: changedSinceLastReview || null,
```

(Keep it a plain redacted-safe object: the caller passes only issue IDs and section anchors, never body text.)

- [ ] **Step 4: Populate it in `lib/workflow/persistent-context.js`**

In `lib/workflow/persistent-context.js` `runPersistentContext`, after `ledger` is read and before `buildContextPack` is called, compute the hint for review phases only when the target has already been fixed this session:

```js
    const priorFix = Boolean(
      metadata.manifest.lastKnownContentSha256 &&
      metadata.manifest.initialContentSha256 &&
      metadata.manifest.lastKnownContentSha256 !== metadata.manifest.initialContentSha256
    );
    const changedSinceLastReview = (phase !== 'fix' && priorFix)
      ? {
        fixedIssueIds: (ledger.issues || [])
          .filter((issue) => issue.status === 'fixed' || issue.status === 'reopened')
          .map((issue) => issue.id),
        sections: [...new Set((ledger.issues || [])
          .filter((issue) => (issue.status === 'fixed' || issue.status === 'reopened') && issue.location)
          .map((issue) => redactSensitive(String(issue.location))))]
      }
      : null;
```

Then pass `changedSinceLastReview` into the `buildContextPack({ ... })` call (add the property alongside `acceptedNonBlockingLowIssueIds`). Confirm `redactSensitive` is already imported in this file; if not, import it from `../redaction` (it is used in `lib/context-pack.js` and likely available — verify and add the require if missing).

- [ ] **Step 5: Update reviewer Instructions in `shared/prompts/reviewer.md`**

In `shared/prompts/reviewer.md` `Instructions:`, add:

```
- If the context pack includes "Changed since last review", still review the whole document, but additionally focus on those sections and fixed issue IDs for regressions or new contradictions introduced by the last fix. Do not narrow the review to only those areas.
```

And in the reviewer context pack field list (the lines beginning `Target document:` ... `Accepted non-blocking low issues:`), add after the accepted-non-blocking line:

```
Changed since last review:
<fixed issue IDs and section anchors from the last fix, or none>
```

- [ ] **Step 6: Run to verify they pass**

Run: `node --test test/shared-assets.test.js test/context-triage.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`. Expected: all pass; existing context/persistent-context assertions unaffected (new field defaults to `null` on the first review where `lastKnown == initial`).

- [ ] **Step 8: Checkpoint**

`git status --short`; leave uncommitted unless the user requested commits.

---

## Out of scope for this plan

- G2 (convergence guard / `fixAttemptCount` / `stopped-no-progress`) — separate state-machine plan.
- G5 (guard=git multi-fix) — already shipped.
- Any machine-schema field for `resolves` or `Coverage` — deliberately avoided (strict parsers reject extra lines).

## Release follow-through (after all three tasks are green)

- This batch is prompt/rubric + one optional context-pack field — a minor (e.g. `0.2.2`, after G5's `0.2.1`).
- Update `README.md` / `README.zh-CN.md` only if user-visible route behavior changed (it does not here).
- Run `npm test` and `npm pack --dry-run` before publishing.

## Self-Review (run against `design/ENHANCE-REVIEW-FIX-2026-05-30.md` §3 G1/G3/G4)

- **Spec coverage:** G1 effectiveness folded into existing DIFF-FAIL (Task 1, no machine field); G3-a severity anchors + G3-b coverage-in-Summary (Task 2, no Coverage line); G4 context-pack `changedSinceLastReview` populated from the ledger when `lastKnown != initial`, reviewer told not to narrow (Task 3). All three gaps map to a task.
- **No-machine-schema invariant:** Task 1 asserts `doesNotMatch(/^resolves:/)`; Task 2 asserts `doesNotMatch(/^Coverage:/)`; Step 6/7 re-run `semantic-parsers`/`reviewer-report` tests to confirm parsers are untouched.
- **Type consistency:** `changedSinceLastReview` shape `{ fixedIssueIds: string[], sections: string[] }` is produced in persistent-context.js (Task 3 Step 4) and consumed/defaulted in context-pack.js (Step 3); the prior-fix signal mirrors G5's exactly (`lastKnown != initial`).
- **Open verification (resolve during execution):** confirm `test/context-triage.test.js` already imports/uses `buildContextPack` or `runPersistentContext`; if not, put the unit test in a new `test/context-pack.test.js`. Confirm `redactSensitive` import in `persistent-context.js`.
