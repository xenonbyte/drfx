# Partitioned Fix Loop v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source spec (design, decision-complete):** `PLAN-partitioned-fix-loop-v2-2026-06-21.md` (same dir). That file is the approved blueprint; THIS file is its executable TDD task list. When the two disagree, the blueprint governs intent and this file governs steps — flag the conflict, do not silently diverge.

**Goal:** Make an over-cap partitioned CODE project review (1) earn PASS through an in-place incremental fix loop (Part 1 / Plan B) and (2) cover oversize single files via deterministic line-window chunking (Part 2 / P2), without ever weakening "PASS is earned, never assumed."

**Architecture:** Part 1 hangs a partitioned increment off the ONE already-proven route-owned point — `end-fix` after its guard chain proves `actualChanged === declaredFiles ⊆ monitoredSet`. At that point it re-resolves the inventory (scoped, never whole-root), refreshes `units.json` content digests + the project fingerprint via a new pure `refreshPartitionPlanContent`, deletes the summaries/findings of affected units + all 7 backstops (= "mark for re-review"), and returns the target to the partitioned `checkpoint/review` state so the existing `nextUnit` cursor + review cache re-review only what changed → re-aggregate → earned PASS. Part 2 expands each oversize unit into deterministic chunk-as-sub-units inside `assemblePartitionPlan` (file-level inventory unchanged; drift fingerprint unchanged), each chunk reviewed through the existing unbounded per-unit machinery.

**Tech Stack:** Node.js 20, CommonJS, **zero npm dependencies**. Tests: `node --test` (`node:test` + `node:assert/strict`). Syntax gate: `npm run syntaxcheck`. No new dependency may be introduced.

## Global Constraints

Every task implicitly includes these. Values are copied verbatim from the blueprint.

- **Zero runtime npm deps; Node 20 CommonJS.** No new dependency, no new language/runtime.
- **"PASS is earned, never assumed."** read-only, advisory, Gemini, diff-review-only, unverified, and stale/drifted file-set runs can never claim a workflow PASS. This invariant outranks every convenience.
- **Additive only.** All new behavior hides behind `partitioned + active-plan` (Part 1) or `oversize_chunk` (Part 2) branches. **Non-partitioned and single-shot CODE/PR paths must not change by one byte** — proven by the existing `code-route generated shells equal golden snapshots byte-for-byte` test and the unchanged non-partitioned lifecycle tests.
- **Out of scope (trigger ⇒ block + reset to prior state, never a fake PASS):** a fix that adds/removes file-set members; a fix that breaks bucketing (a unit exceeds `unitByteBudget`, or a single file crosses the oversize threshold); P2 semantic/AST splitting; cross-chunk global-reasoning reconstruction; oversize binary/non-text review; cross-target-key incremental; concurrent multi-target.
- **Partitioned end-fix increment manifest:** `status:'checkpoint'`, `currentPhase:'review'`, `fileSetFingerprint:F1` — identical to partitioned `start` (`lib/workflow/start.js:233-234`). **`currentPhase:'unit-review'` is ILLEGAL** (not in `PHASE_VALUES`; active status `review` requires `currentPhase:'review'`). The increment **does not change `currentRound`** and **does not reset `fixAttemptCount`**.
- **Error codes (throw from the pure refresh; caller maps to `endFixBlocked('state-validation-failed', reset)`):** `ERR_PARTITION_MEMBERSHIP_CHANGED`, `ERR_PARTITION_REBUCKET_REQUIRED`, `ERR_PARTITION_REFS_CHANGED`. (Oversize parent-content change may reuse `ERR_PARTITION_MEMBERSHIP_CHANGED` or the synonym `ERR_PARTITION_OVERSIZE_RESPLIT_REQUIRED`; same behavior.)
- **P2 default constants (fix now; calibrate later, non-blocking):** `CHUNK_LINES = 800`, `CHUNK_OVERLAP_LINES = 40`, `chunkByteBudget = MAX_UNIT_BYTES` (1_000_000). The context byte budget is a HARD constraint measured on the UTF-8 byte length of the `contextLineRange` slice (primary + overlap).
- **Phase independence (`/think` red line):** Part 1 and Part 2 are TWO independent merge points. After Part 1 (Tasks 1–10) the system is complete and usable; Part 2 (Tasks 11–18) is an independent increment on top. Commit/merge granularity is split — if Part 2 stalls, Part 1 ships alone.
- **Repo conventions:** commit messages, code comments, and in-repo docs are **English** (match the repo). Each commit message ends with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Git safety:** all task commit steps are optional and require explicit user approval. Before any staging, run `git status --short`; stage only the files listed in that task's `git add ...` command; never use `git add -A` or stage unrelated local changes.
- **Module size:** prefer keeping handwritten files under ~500 lines. `lib/workflow/file-set-fix.js` is already 979 lines — do NOT pile the increment logic into it; the increment lives in a new `lib/workflow/file-set-partitioned-increment.js`.

---

## File Structure

**Part 1 — Plan B (Tasks 1–10):**

| File | Create/Modify | Responsibility |
|---|---|---|
| `lib/project-review.js` | Modify | Add pure `refreshPartitionPlanContent` + the three `ERR_PARTITION_*` constants. |
| `lib/workflow/file-set-unit-review.js` | Modify | Add exported `invalidateUnitReviews` / `invalidateAllBackstopReviews` (delete summaries + findings = mark for re-review). |
| `lib/workflow/file-set-context.js` | Modify | Export `readMemberTextForRefs` so the increment module can re-resolve refs without duplicating IO logic. |
| `lib/workflow/file-set-partitioned-increment.js` | **Create** | `applyPartitionedIncrement({metadata, declaredFiles, fixReport, ledger, options})` — the end-fix partitioned exit orchestration. |
| `lib/workflow/file-set-fix.js` | Modify | `runEndFix` fork on `readActivePartitionedPlan`; delete the `partitionedPlanFreshness` stale-block (815–833) and the now-dead function; remove the ②′ begin-fix read-only guard (370–386). |
| `lib/workflow/file-set-finalize.js` | Modify | `buildFileSetFinalValidationState`: partitioned active + fixRound ⇒ `requiredDiffReviewComplete = true` (rely on `requiredFullReReviewComplete`). |
| `lib/workflow/partitioned-review.js` | Modify | Aggregate FAIL `nextAction` reverts to promising triage→begin-fix + incremental re-review. |
| `lib/generator.js` | Modify | `partitionedReviewFlowFor` step 6 reverts to "aggregate → fix → earned PASS" + incremental note. |
| `templates/fragments/route-contract.code.claude.md`, `…codex.md` | Modify | Phase-3 wording reverts (fix loop restored). |
| `test/fixtures/generated/claude/review-fix-code.md`, `…/codex/review-fix-code.md` | Modify | Regenerated byte-for-byte to match the template change. |
| `design/OPTIMIZATION-2026-06-20-partitioned-code-review.md` | Modify | §12 marks Plan B implemented, ②′ guard removed, follow-up ① voided. |

**Part 2 — P2 (Tasks 11–18):**

| File | Create/Modify | Responsibility |
|---|---|---|
| `lib/project-review.js` | Modify | Add pure `computeOversizeChunks` (line+byte windowing) + `CHUNK_LINES`/`CHUNK_OVERLAP_LINES`; extend `refreshPartitionPlanContent` for chunk units. |
| `lib/workflow/file-set-context.js` | Modify | Add `splitOversizeFile` (IO: read text → chunk-units); call it inside `assemblePartitionPlan`; keep `inventoryRows` file-level. |
| `lib/context-pack.js` | Modify | `buildFileSetContextPack`: persist chunk range metadata only; reviewer slice text stays in memory. |
| `lib/workflow/file-set-unit-review.js` | Modify | `unitContext` + `recordUnitReview` `oversize_chunk` branches (normal bounded review, not forced-high). |
| `lib/workflow/partitioned-review.js` | Modify | Chunk-aware finding dedup/normalization in the aggregate path. |
| Docs + fixtures | Modify | Oversize note in route-contract; regenerate fixtures; design §8 fulfilled. |

---

# PART 1 — PLAN B (independent merge point)

### Task 1: Pure `refreshPartitionPlanContent` primitive

**Files:**
- Modify: `lib/project-review.js` (add near `partitionInventory`, export at bottom)
- Test: `test/project-review.test.js`

**Interfaces:**
- Consumes: `computeMemberDigest(files)` (same module), `MAX_UNIT_BYTES`.
- Produces:
  `refreshPartitionPlanContent(oldPlan, newInventory, { nextSuggestedRefsByUnit, projectReviewFingerprint }) -> { refreshedPlan, refsChangedUnitIds }`
  where `nextSuggestedRefsByUnit` is `{ [unit_id]: Array<{path,contentId}> }`, `projectReviewFingerprint` is the live F1 string, `refsChangedUnitIds` is a sorted string[]. Throws `ERR_PARTITION_MEMBERSHIP_CHANGED` / `ERR_PARTITION_REBUCKET_REQUIRED` / `ERR_PARTITION_REFS_CHANGED` (each `error.code` set to the same string).
- Pure: no fs, no require beyond `node:crypto` already imported. Refs text reading is the CALLER's job (Task 3) — this function only validates/replaces.

- [ ] **Step 1: Write the failing tests**

Add to `test/project-review.test.js` (top already has `const { test } = require('node:test')` / `const assert = require('node:assert/strict')` — reuse them; import the new symbol):

```js
const { refreshPartitionPlanContent } = require('../lib/project-review');

// Minimal 2-unit plan fixture: unit-001 {a.js}, unit-002 {b.js}; b.js requires ./a.
function basePlan() {
  return {
    reviewMode: 'partitioned',
    unitByteBudget: 1_000_000,
    units: [
      { unit_id: 'unit-001', member_count: 1, member_bytes: 10, member_digest: 'OLD1',
        files: [{ path: 'a.js', size: 10, ext: '.js', contentId: 'ca0', unit_id: 'unit-001' }],
        suggestedRefs: [] },
      { unit_id: 'unit-002', member_count: 1, member_bytes: 20, member_digest: 'OLD2',
        files: [{ path: 'b.js', size: 20, ext: '.js', contentId: 'cb0', unit_id: 'unit-002' }],
        suggestedRefs: [{ path: 'a.js', contentId: 'ca0' }] },
    ],
    crosscuttingBackstops: ['security-redaction'],
    projectReviewFingerprint: 'FP0',
    userExcludes: [],
    inventoryRows: [],
  };
}

test('refreshPartitionPlanContent refreshes content fields and stamps the new fingerprint', () => {
  const newInventory = [
    { path: 'a.js', size: 11, ext: '.js', contentId: 'ca1' }, // a.js edited
    { path: 'b.js', size: 20, ext: '.js', contentId: 'cb0' },
  ];
  const { refreshedPlan, refsChangedUnitIds } = refreshPartitionPlanContent(basePlan(), newInventory, {
    nextSuggestedRefsByUnit: { 'unit-001': [], 'unit-002': [{ path: 'a.js', contentId: 'ca1' }] },
    projectReviewFingerprint: 'FP1',
  });
  assert.equal(refreshedPlan.projectReviewFingerprint, 'FP1');
  assert.equal(refreshedPlan.units[0].files[0].contentId, 'ca1');
  assert.equal(refreshedPlan.units[0].files[0].size, 11);
  assert.notEqual(refreshedPlan.units[0].member_digest, 'OLD1'); // recomputed to a real sha256
  assert.notEqual(refreshedPlan.units[1].member_digest, 'OLD2'); // recomputed (was a placeholder digest)
  // unit-002's suggestedRef still points to a.js; only the contentId refreshed.
  // refsChangedUnitIds is reserved for ref PATH topology changes. The end-fix
  // caller still invalidates unit-002 through unitsToReReview(declaredFiles, oldPlan).
  assert.equal(refreshedPlan.units[1].suggestedRefs[0].contentId, 'ca1');
  assert.deepEqual(refsChangedUnitIds, []);
});

test('refreshPartitionPlanContent reports refsChangedUnitIds when ref path topology changes', () => {
  const newInventory = [
    { path: 'a.js', size: 10, ext: '.js', contentId: 'ca0' },
    { path: 'b.js', size: 20, ext: '.js', contentId: 'cb0' },
  ];
  const { refsChangedUnitIds } = refreshPartitionPlanContent(basePlan(), newInventory, {
    nextSuggestedRefsByUnit: { 'unit-001': [], 'unit-002': [] }, // unit-002 dropped ref path a.js
    projectReviewFingerprint: 'FP1',
  });
  assert.deepEqual(refsChangedUnitIds, ['unit-002']);
});

test('refreshPartitionPlanContent throws MEMBERSHIP_CHANGED when a member is added or removed', () => {
  const added = [
    { path: 'a.js', size: 10, ext: '.js', contentId: 'ca0' },
    { path: 'b.js', size: 20, ext: '.js', contentId: 'cb0' },
    { path: 'c.js', size: 5, ext: '.js', contentId: 'cc0' }, // NEW member
  ];
  assert.throws(
    () => refreshPartitionPlanContent(basePlan(), added, { nextSuggestedRefsByUnit: { 'unit-001': [], 'unit-002': [] }, projectReviewFingerprint: 'FP1' }),
    (e) => e.code === 'ERR_PARTITION_MEMBERSHIP_CHANGED'
  );
});

test('refreshPartitionPlanContent throws REBUCKET_REQUIRED when a unit exceeds the byte budget', () => {
  const fat = [
    { path: 'a.js', size: 2_000_000, ext: '.js', contentId: 'ca1' }, // now over budget
    { path: 'b.js', size: 20, ext: '.js', contentId: 'cb0' },
  ];
  assert.throws(
    () => refreshPartitionPlanContent(basePlan(), fat, { nextSuggestedRefsByUnit: { 'unit-001': [], 'unit-002': [{ path: 'a.js', contentId: 'ca1' }] }, projectReviewFingerprint: 'FP1' }),
    (e) => e.code === 'ERR_PARTITION_REBUCKET_REQUIRED'
  );
});

test('refreshPartitionPlanContent throws REFS_CHANGED when a non-chunk unit has no re-resolved refs', () => {
  const newInventory = [
    { path: 'a.js', size: 10, ext: '.js', contentId: 'ca0' },
    { path: 'b.js', size: 20, ext: '.js', contentId: 'cb0' },
  ];
  assert.throws(
    () => refreshPartitionPlanContent(basePlan(), newInventory, { nextSuggestedRefsByUnit: { 'unit-001': [] /* unit-002 missing */ }, projectReviewFingerprint: 'FP1' }),
    (e) => e.code === 'ERR_PARTITION_REFS_CHANGED'
  );
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test --test-name-pattern="refreshPartitionPlanContent" test/project-review.test.js`
Expected: FAIL — `refreshPartitionPlanContent is not a function`.

- [ ] **Step 3: Implement the function**

In `lib/project-review.js`, after `partitionInventory` (around line 182), add:

```js
// ---------------------------------------------------------------------------
// refreshPartitionPlanContent (Plan B) — PURE. Re-stamp an existing partition
// plan with refreshed file content after a route-owned, in-set fix, WITHOUT
// re-bucketing. The caller (end-fix increment) supplies the freshly resolved
// inventory, the live projectReviewFingerprint (F1), and the re-resolved
// suggestedRefs per non-chunk unit (refs reading needs file bodies = caller IO).
// This function only validates membership/bucket stability and replaces
// content-derived fields. Membership/bucket/refs drift throws — never a silent
// reuse of stale unit content.
// ---------------------------------------------------------------------------

const ERR_PARTITION_MEMBERSHIP_CHANGED = 'ERR_PARTITION_MEMBERSHIP_CHANGED';
const ERR_PARTITION_REBUCKET_REQUIRED = 'ERR_PARTITION_REBUCKET_REQUIRED';
const ERR_PARTITION_REFS_CHANGED = 'ERR_PARTITION_REFS_CHANGED';

function partitionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function pathSet(entries, key = 'path') {
  return new Set((Array.isArray(entries) ? entries : []).map((entry) => entry[key]));
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

// The file-level path set a plan covers: normal units contribute files[].path;
// oversize_chunk units (Part 2) contribute their single sourcePath once.
function planFilePathSet(plan) {
  const paths = new Set();
  for (const unit of plan.units) {
    if (unit.oversize_chunk === true) {
      paths.add(unit.sourcePath);
    } else {
      for (const file of unit.files) paths.add(file.path);
    }
  }
  return paths;
}

function refreshPartitionPlanContent(oldPlan, newInventory, { nextSuggestedRefsByUnit = {}, projectReviewFingerprint } = {}) {
  const inventory = Array.isArray(newInventory) ? newInventory : [];
  const byPath = new Map(inventory.map((row) => [row.path, row]));
  const unitByteBudget = Number(oldPlan.unitByteBudget) || MAX_UNIT_BYTES;

  // (1) File-level membership must be byte-identical (no add/remove). A changed
  // member SET is out of scope: the caller blocks + resets to a full re-partition.
  if (!sameSet(planFilePathSet(oldPlan), new Set(byPath.keys()))) {
    throw partitionError(ERR_PARTITION_MEMBERSHIP_CHANGED, 'partition plan members changed since the plan was written');
  }

  const refsChangedUnitIds = [];
  const units = oldPlan.units.map((unit) => {
    // Part 2 chunk units: handled by the chunk-aware path (Task 17). In Part 1 no
    // chunk units exist; if one appears with a moved parent content, demand a reset.
    if (unit.oversize_chunk === true) {
      const source = byPath.get(unit.sourcePath);
      if (!source || String(source.contentId) !== String(unit.sourceContentId)) {
        throw partitionError(ERR_PARTITION_MEMBERSHIP_CHANGED, `oversize chunk source changed; re-split required: ${unit.sourcePath}`);
      }
      return { ...unit };
    }
    if (unit.oversize_file === true) {
      // Legacy oversize blocker unit: single member, refresh its content row only.
      const row = byPath.get(unit.files[0].path);
      if (Number(row.size) <= unitByteBudget) {
        throw partitionError(ERR_PARTITION_REBUCKET_REQUIRED, `oversize unit ${unit.unit_id} is no longer oversize; re-partition required`);
      }
      const files = [{ ...unit.files[0], size: row.size, ext: row.ext, contentId: row.contentId }];
      return { ...unit, files, member_bytes: row.size, member_digest: computeMemberDigest(files) };
    }

    // (2) Normal unit: refresh each member's content row in place (paths unchanged).
    const files = unit.files.map((file) => {
      const row = byPath.get(file.path);
      if (Number(row.size) > unitByteBudget) {
        throw partitionError(ERR_PARTITION_REBUCKET_REQUIRED, `member ${file.path} flipped oversize; re-partition required`);
      }
      return { ...file, size: row.size, ext: row.ext, contentId: row.contentId };
    });
    const member_bytes = files.reduce((sum, file) => sum + Number(file.size), 0);
    if (member_bytes > unitByteBudget) {
      throw partitionError(ERR_PARTITION_REBUCKET_REQUIRED, `unit ${unit.unit_id} exceeds the byte budget after fix; re-partition required`);
    }

    // (3) Refs topology: the caller MUST supply re-resolved refs for every normal
    // unit (refs reading needs file bodies). A missing entry is a contract breach,
    // not "no refs" — fail loud rather than silently reuse stale refs.
    if (!Object.prototype.hasOwnProperty.call(nextSuggestedRefsByUnit, unit.unit_id)) {
      throw partitionError(ERR_PARTITION_REFS_CHANGED, `refs were not re-resolved for ${unit.unit_id}`);
    }
    const nextRefs = Array.isArray(nextSuggestedRefsByUnit[unit.unit_id]) ? nextSuggestedRefsByUnit[unit.unit_id] : [];
    if (!sameSet(pathSet(unit.suggestedRefs), pathSet(nextRefs))) {
      refsChangedUnitIds.push(unit.unit_id);
    }
    return { ...unit, files, member_bytes, member_digest: computeMemberDigest(files), suggestedRefs: nextRefs };
  });

  // (4) Rebuild file-level inventoryRows (one row per source path) so the written
  // inventory.jsonl stays file-level. unit_id is looked up from refreshed units.
  const pathToUnit = new Map();
  for (const unit of units) {
    if (unit.oversize_chunk === true) {
      if (!pathToUnit.has(unit.sourcePath)) pathToUnit.set(unit.sourcePath, unit.unit_id);
      continue;
    }
    for (const file of unit.files) pathToUnit.set(file.path, unit.unit_id);
  }
  const inventoryRows = inventory
    .map((row) => ({ path: row.path, size: row.size, ext: row.ext, contentId: row.contentId, unit_id: pathToUnit.get(row.path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const refreshedPlan = {
    ...oldPlan,
    units,
    projectReviewFingerprint: String(projectReviewFingerprint),
    inventoryRows,
  };
  return { refreshedPlan, refsChangedUnitIds: refsChangedUnitIds.sort() };
}
```

Add to `module.exports` (the object near line 424):

```js
  refreshPartitionPlanContent,
  ERR_PARTITION_MEMBERSHIP_CHANGED,
  ERR_PARTITION_REBUCKET_REQUIRED,
  ERR_PARTITION_REFS_CHANGED,
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test --test-name-pattern="refreshPartitionPlanContent" test/project-review.test.js`
Expected: PASS (5/5 new tests).

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/project-review.js test/project-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): add pure refreshPartitionPlanContent primitive

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Re-review invalidation helpers

**Files:**
- Modify: `lib/workflow/file-set-unit-review.js` (add helpers, export)
- Test: `test/project-review.test.js` (these are filesystem helpers; test via a tmp target dir)

**Interfaces:**
- Consumes: existing private `summaryPath` / `findingsPath` / `backstopSummaryPath` / `backstopFindingsPath`, `CROSSCUTTING_BACKSTOPS`.
- Produces:
  `invalidateUnitReviews(targetStateDir, unitIds) -> string[]` (ids whose summary OR findings were removed),
  `invalidateAllBackstopReviews(targetStateDir) -> string[]` (backstop ids cleared).
  Both delete `summaries/<id>.json` + `findings/<id>.json` when present (a missing file is a no-op). Deleting both = "mark for re-review": `nextUnit` / aggregate then see the unit/backstop as unreviewed.

- [ ] **Step 1: Write the failing test**

Add to `test/project-review.test.js`:

```js
const os = require('node:os');
const fs = require('node:fs');
const pathMod = require('node:path');
const {
  invalidateUnitReviews,
  invalidateAllBackstopReviews,
} = require('../lib/workflow/file-set-unit-review');

function tmpTargetWithReviews() {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-inval-'));
  const pr = pathMod.join(dir, 'project-review');
  fs.mkdirSync(pathMod.join(pr, 'summaries'), { recursive: true });
  fs.mkdirSync(pathMod.join(pr, 'findings'), { recursive: true });
  for (const id of ['unit-001', 'unit-002', 'backstop-security-redaction']) {
    fs.writeFileSync(pathMod.join(pr, 'summaries', `${id}.json`), '{}\n');
    fs.writeFileSync(pathMod.join(pr, 'findings', `${id}.json`), '{}\n');
  }
  return dir;
}

test('invalidateUnitReviews removes summary+findings for the named units only', () => {
  const dir = tmpTargetWithReviews();
  const removed = invalidateUnitReviews(dir, ['unit-001']);
  assert.deepEqual(removed, ['unit-001']);
  assert.ok(!fs.existsSync(pathMod.join(dir, 'project-review', 'summaries', 'unit-001.json')));
  assert.ok(!fs.existsSync(pathMod.join(dir, 'project-review', 'findings', 'unit-001.json')));
  assert.ok(fs.existsSync(pathMod.join(dir, 'project-review', 'summaries', 'unit-002.json')));
});

test('invalidateAllBackstopReviews clears every backstop summary+findings', () => {
  const dir = tmpTargetWithReviews();
  const cleared = invalidateAllBackstopReviews(dir);
  assert.ok(cleared.includes('security-redaction'));
  assert.ok(!fs.existsSync(pathMod.join(dir, 'project-review', 'summaries', 'backstop-security-redaction.json')));
});

test('invalidateUnitReviews fails loudly when a review artifact cannot be removed', () => {
  const dir = tmpTargetWithReviews();
  const badPath = pathMod.join(dir, 'project-review', 'summaries', 'unit-001.json');
  fs.rmSync(badPath);
  fs.mkdirSync(badPath);
  fs.writeFileSync(pathMod.join(badPath, 'nested'), '{}\n');
  assert.throws(() => invalidateUnitReviews(dir, ['unit-001']));
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test --test-name-pattern="invalidate" test/project-review.test.js`
Expected: FAIL — `invalidateUnitReviews is not a function`.

- [ ] **Step 3: Implement**

In `lib/workflow/file-set-unit-review.js`, after `unitsToReReview` (around line 572), add:

```js
// ---------------------------------------------------------------------------
// Invalidation (Plan B) — deleting a summary+findings pair marks that unit (or
// backstop) for re-review: nextUnit returns it again and aggregate sees it as
// uncovered. A missing file is a no-op (idempotent).
// ---------------------------------------------------------------------------

function removeIfPresent(filePath) {
  try {
    fs.rmSync(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function invalidateUnitReviews(targetStateDir, unitIds) {
  const removed = [];
  for (const unitId of Array.isArray(unitIds) ? unitIds : []) {
    const a = removeIfPresent(summaryPath(targetStateDir, unitId));
    const b = removeIfPresent(findingsPath(targetStateDir, unitId));
    if (a || b) removed.push(unitId);
  }
  return removed.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

function invalidateAllBackstopReviews(targetStateDir) {
  const cleared = [];
  for (const backstop of CROSSCUTTING_BACKSTOPS) {
    const a = removeIfPresent(backstopSummaryPath(targetStateDir, backstop));
    const b = removeIfPresent(backstopFindingsPath(targetStateDir, backstop));
    if (a || b) cleared.push(backstop);
  }
  return cleared;
}
```

Add `invalidateUnitReviews` and `invalidateAllBackstopReviews` to `module.exports`.

- [ ] **Step 4: Run to confirm pass**

Run: `node --test --test-name-pattern="invalidate" test/project-review.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/workflow/file-set-unit-review.js test/project-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): add unit/backstop review invalidation helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `applyPartitionedIncrement` orchestration module

**Files:**
- Create: `lib/workflow/file-set-partitioned-increment.js`
- Test: `test/cli-partitioned-review.test.js` (integration via the real partitioned harness; see capstone Task 10 for the full loop — this task tests the increment unit directly against a constructed `fix` state)

**Interfaces:**
- Consumes: `refreshPartitionPlanContent` (Task 1), `invalidateUnitReviews`/`invalidateAllBackstopReviews` (Task 2), `unitsToReReview`/`readUnitsPlan` (file-set-unit-review), `writeProjectReviewPlan`/`readMemberTextForRefs` (file-set-context), `suggestRefsFor` (project-review), `resolveCodeInventory`/`describeCodeBlock` (target-context), `updatePersistentManifest`/`writeFixReceipt`/`writeNormalizedFixReport`/`updateFixedIssues`/`formatLedger`/`atomicWriteFile`/`stateRelativePath`/`stateCommandBase` (helpers).
- Produces:
  `async applyPartitionedIncrement({ metadata, declaredFiles, fixReport, ledger, options, oldPlan }) -> stateCommandBase result`.
  On success: writes refreshed `units.json` + `inventory.jsonl`, invalidates affected units + all backstops, sets manifest to `checkpoint/review/F1` (round unchanged), writes the normalized fix report + advances the ledger + a fix receipt, returns `{ ok:true, status:'end-fix', reviewMode:'partitioned', nextAction:'run context --phase unit-review …' }`.
  On membership/bucket/refs error: returns `endFixBlocked(metadata,'state-validation-failed', …reset…)`.

- [ ] **Step 1: Write the failing test**

Add to `test/cli-partitioned-review.test.js` (reuse its `makeMultiUnitRepo`, `startPartitioned`, `recordCompletePartitionedCoverage`, `runWorkflowCommand`, `parseManifestV2`, `readSummaryIfPresent`). This test drives the unit directly by reaching a `fix` state, then calling the increment:

```js
const { applyPartitionedIncrement } = require('../lib/workflow/file-set-partitioned-increment');
const { resolveFileSetStateMetadata } = require('../lib/workflow/helpers');
const { readActivePartitionedPlan } = require('../lib/workflow/file-set-partitioned-live');

test('applyPartitionedIncrement refreshes units.json, invalidates affected units + backstops, returns to checkpoint/review', async (t) => {
  const root = makeMultiUnitRepo(t);              // >=2 units; unit-001 owns src/a.js
  const start = await startPartitioned(root);
  const plan = readActivePartitionedPlan(resolveFileSetStateMetadata(start.targetStateDir));
  await recordCompletePartitionedCoverage(t, root, plan); // every unit + backstop coverage_risk:none

  // Simulate a route-owned, in-set fix: edit one member of unit-001.
  const fs = require('node:fs');
  const path = require('node:path');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { return 7; };\n');

  const metadata = resolveFileSetStateMetadata(start.targetStateDir);
  const oldPlan = readActivePartitionedPlan(metadata);
  const result = await applyPartitionedIncrement({
    metadata,
    declaredFiles: ['src/a.js'],
    fixReport: { fixed: [], filesChanged: ['src/a.js'], verification: ['node --test: 1/1'] },
    ledger: { issues: [] },
    options: {},
    oldPlan,
  });

  assert.equal(result.ok, true);
  const manifest = parseManifestV2(fs.readFileSync(path.join(start.targetStateDir, 'MANIFEST.md'), 'utf8'));
  assert.equal(manifest.status, 'checkpoint');
  assert.equal(manifest.currentPhase, 'review');         // NOT 'unit-review' (illegal)
  // unit-001 was invalidated (a.js changed); its summary is gone -> needs re-review.
  assert.equal(readSummaryIfPresent(start.targetStateDir, 'unit-001'), null);
  // a unit that does NOT own a.js and does not reference it keeps its summary.
  const survivor = oldPlan.units.find((u) => !u.files.some((f) => f.path === 'src/a.js')
    && !(u.suggestedRefs || []).some((r) => r.path === 'src/a.js'));
  assert.notEqual(readSummaryIfPresent(start.targetStateDir, survivor.unit_id), null);
});
```

> Setup note: `makeMultiUnitRepo`, `startPartitioned`, `recordCompletePartitionedCoverage` already exist in this test file (lines ~64, ~94, ~200). `MANIFEST.md` lives at `targetStateDir/MANIFEST.md`; confirm the manifest filename used by `parseManifestV2` callers in this file and match it.

- [ ] **Step 2: Run to confirm failure**

Run: `node --test --test-name-pattern="applyPartitionedIncrement" test/cli-partitioned-review.test.js`
Expected: FAIL — module `file-set-partitioned-increment` not found.

- [ ] **Step 3: Implement the module**

Create `lib/workflow/file-set-partitioned-increment.js`:

```js
'use strict';

// Plan B: the partitioned end-fix incremental exit. Called ONLY from runEndFix
// after its guard chain has proven the worktree delta equals the declared,
// in-set, route-owned fix (file-set-fix.js). At that one proven point we may
// safely re-stamp the partition plan with the new content and re-review only the
// affected units. Membership/bucket/refs drift = out of scope -> block + reset.

const {
  atomicWriteFile,
  formatLedger,
  stateCommandBase,
  stateRelativePath,
  updateFixedIssues,
  updatePersistentManifest,
  writeFixReceipt,
  writeNormalizedFixReport,
} = require('./helpers');
const { describeCodeBlock, resolveCodeInventory } = require('../target-context');
const { refreshPartitionPlanContent, suggestRefsFor } = require('../project-review');
const {
  invalidateUnitReviews,
  invalidateAllBackstopReviews,
  unitsToReReview,
} = require('./file-set-unit-review');
const { writeProjectReviewPlan, readMemberTextForRefs } = require('./file-set-context');

function endFixIncrementBlocked(metadata, fixReport, declaredFiles, summary, nextAction) {
  // Mirrors endFixBlocked from file-set-fix.js but is reused here to keep the
  // increment self-contained. The caller releases the lease after this function
  // returns, so blocked-state persistence still happens under the active lease.
  try {
    writeFixReceipt(metadata, {
      status: 'blocked',
      issueIds: (fixReport.fixed || []).map((f) => f.issue_id),
      filesChanged: declaredFiles.join(', '),
      blockingReason: 'state-validation-failed',
      summary,
      nextAction,
    });
  } catch { /* best-effort */ }
  updatePersistentManifest(metadata, { status: 'blocked', blockingReason: 'state-validation-failed', statusReason: 'none' });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    nextAction,
  });
}

async function applyPartitionedIncrement({ metadata, declaredFiles, fixReport, ledger, options, oldPlan }) {
  // (1) Re-resolve the inventory using the DURABLE manifest scope identity, never
  // whole-root. A scoped CODE review must keep its scope or membership/fingerprint
  // would be judged against the wrong file set.
  const inventoryResult = await resolveCodeInventory({
    cwd: metadata.projectRoot,
    scopes: metadata.manifest.normalizedScopes || [],
    commandLog: options.commandLog,
  });
  if (inventoryResult && inventoryResult.status === 'blocked') {
    const blocked = describeCodeBlock(inventoryResult);
    return endFixIncrementBlocked(metadata, fixReport, declaredFiles, blocked.message,
      blocked.nextAction || 'reset and rerun partitioned project review before bounded re-review');
  }
  const newInventory = inventoryResult.inventory;
  const fingerprintF1 = String(inventoryResult.projectReviewFingerprint || '');

  // (2) Re-resolve suggestedRefs for every non-chunk unit on the NEW inventory.
  // refs reading needs file bodies = IO here (the pure refresh is IO-free).
  const inRootSet = new Map(newInventory.map((row) => [row.path, row.contentId]));
  const nextSuggestedRefsByUnit = {};
  for (const unit of oldPlan.units) {
    if (unit.oversize_chunk === true || unit.oversize_file === true) continue;
    const unitFiles = readMemberTextForRefs(metadata.projectRoot, unit.files);
    nextSuggestedRefsByUnit[unit.unit_id] = suggestRefsFor(unitFiles, inRootSet);
  }

  // (3) Pure refresh (membership/bucket/refs drift throws -> block + reset).
  let refreshedPlan;
  let refsChangedUnitIds;
  try {
    ({ refreshedPlan, refsChangedUnitIds } = refreshPartitionPlanContent(oldPlan, newInventory, {
      nextSuggestedRefsByUnit,
      projectReviewFingerprint: fingerprintF1,
    }));
  } catch (error) {
    return endFixIncrementBlocked(metadata, fixReport, declaredFiles,
      `partitioned increment refused: ${error && error.message ? error.message : String(error)}`,
      'reset and rerun partitioned project review for the changed code before re-reviewing units');
  }

  // (4) Persist the refreshed plan (units.json + inventory.jsonl), atomic.
  writeProjectReviewPlan(metadata.targetStateDir, refreshedPlan);

  // (5) Affected = changed-member ∪ suggestedRef-hit ∪ extraRead-hit (over BOTH old
  // and refreshed plans) ∪ refs-topology-changed. Old plan catches units that
  // referenced the changed file before refresh; refreshed catches new references.
  const affected = new Set([
    ...unitsToReReview(declaredFiles, oldPlan, metadata.targetStateDir),
    ...unitsToReReview(declaredFiles, refreshedPlan, metadata.targetStateDir),
    ...refsChangedUnitIds,
  ]);
  invalidateUnitReviews(metadata.targetStateDir, [...affected]);
  // Backstops reason cross-unit; any content change invalidates all 7 (v1 safe default).
  invalidateAllBackstopReviews(metadata.targetStateDir);

  // (6) Record the fix exactly like non-partitioned end-fix (normalized report +
  // ledger advance + receipt), but transition to the partitioned checkpoint/review
  // state instead of diff-review. currentRound and fixAttemptCount are unchanged.
  const reportPath = writeNormalizedFixReport({ metadata, fixReport });
  const nextLedger = updateFixedIssues(ledger, fixReport);
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
  updatePersistentManifest(metadata, {
    status: 'checkpoint',
    currentPhase: 'review',
    blockingReason: 'none',
    statusReason: 'checkpoint-requested',
    currentReportPath: stateRelativePath(metadata.targetStateDir, reportPath),
    lastFixReportPath: stateRelativePath(metadata.targetStateDir, reportPath),
    fileSetFingerprint: fingerprintF1,
    lastModifiedAt: new Date().toISOString(),
  });
  try {
    writeFixReceipt(metadata, {
      kind: 'fix-applied',
      status: 'end-fix',
      issueIds: (fixReport.fixed || []).map((f) => f.issue_id),
      filesChanged: declaredFiles.join(', '),
      verification: (fixReport.verification || []).join('; '),
      summary: 'partitioned file-set fix applied; affected units and all backstops invalidated for bounded re-review',
    });
  } catch { /* receipt is best-effort */ }

  return stateCommandBase(metadata, {
    ok: true,
    status: 'end-fix',
    reviewMode: 'partitioned',
    fixReportPath: reportPath,
    fixedIssueIds: (fixReport.fixed || []).map((f) => f.issue_id),
    verification: fixReport.verification,
    invalidatedUnitIds: [...affected].sort(),
    nextAction: 'run context --phase unit-review to re-review the affected units, then aggregate-review',
  });
}

module.exports = { applyPartitionedIncrement };
```

> If `writeNormalizedFixReport`, `updateFixedIssues`, `formatLedger`, or `describeCodeBlock` are not exported from `./helpers` / `../target-context`, import them from the same module `file-set-fix.js` imports them from (it imports all of these — copy its import lines).
> Also export `readMemberTextForRefs` from `lib/workflow/file-set-context.js` in this task; the new increment module imports it directly and must not receive `undefined`.

- [ ] **Step 3a: Pin the whole-root scope invariant (do NOT thread scopes)**

A partitioned target is ALWAYS whole-root: `file-set-too-large` only fires for whole-root (`start.js:128-129`, the cap is null-guarded for scoped runs) and the partitioned checkpoint manifest is written with `normalizedScopes:[]` (`start.js:263`). So `applyPartitionedIncrement` resolving inventory with `metadata.manifest.normalizedScopes || []` is correct today (reads `[]`) AND future-proof (reads real scopes the day scoped partitioning is added). The whole-root freshness/fingerprint sites (`readUnitsPlanWithLiveFingerprint`, `activePartitionedPlanFreshness`, `runAggregateReview`) keep their existing `scopes:[]` — do **not** thread a `scopes` param through `nextUnit` / `recordUnitReview` / aggregate; that would churn the working hot path for a state the system cannot produce. Pin the invariant with a test instead:

```js
test('partitioned start writes a whole-root manifest (normalizedScopes is empty)', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await startPartitioned(root);
  const manifest = parseManifestV2(fs.readFileSync(path.join(start.targetStateDir, 'MANIFEST.md'), 'utf8'));
  assert.deepEqual(manifest.normalizedScopes || [], []);
});
```

If scoped partitioning is ever added (a scoped over-cap run that partitions instead of blocking), THIS test breaks first — that is the signal to thread `metadata.manifest.normalizedScopes` through the four whole-root fingerprint sites.

- [ ] **Step 4: Run to confirm pass**

Run: `node --test --test-name-pattern="applyPartitionedIncrement|whole-root manifest" test/cli-partitioned-review.test.js`
Expected: PASS — the increment test and the whole-root scope-invariant test pass.

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/workflow/file-set-partitioned-increment.js lib/workflow/file-set-context.js test/cli-partitioned-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): add end-fix incremental exit orchestration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Fork `runEndFix` on the active partition plan

**Files:**
- Modify: `lib/workflow/file-set-fix.js` (`runEndFix`; delete `partitionedPlanFreshness` + its call)
- Test: `test/cli-partitioned-review.test.js` + `test/workflow-fileset-lifecycle.test.js`

**Interfaces:**
- Consumes: `applyPartitionedIncrement` (Task 3), `readActivePartitionedPlan` (already imported).
- Produces: a partitioned end-fix returns the increment result (`checkpoint/review`); a non-partitioned end-fix returns the existing `diff-review` transition **byte-identically**.

- [ ] **Step 1: Write the failing tests**

Add a regression assertion to `test/workflow-fileset-lifecycle.test.js` proving the non-partitioned path is unchanged (use the existing `reachFileSetFixStage` flow that already drives begin-fix/end-fix on a PR repo): assert an end-fix on a non-partitioned CODE/PR target still returns `status:'end-fix'` with `nextAction` `'run record-diff-review'` and the manifest moves to `diff-review`. Add to `test/cli-partitioned-review.test.js` a test that an ACTIVE partitioned target at `fix` state, after an in-set edit + a valid fix report through `end-fix`, returns `reviewMode:'partitioned'` and the manifest is `checkpoint/review` (the full begin→end happy path is the Task 10 capstone; here assert the fork wiring only).

```js
// test/cli-partitioned-review.test.js
test('end-fix on an active partition plan takes the incremental exit (checkpoint/review)', async (t) => {
  const root = makeMultiUnitRepo(t);
  const start = await startPartitioned(root);
  const metadata = resolveFileSetStateMetadata(start.targetStateDir);
  const plan = readActivePartitionedPlan(metadata);
  await recordCompletePartitionedCoverage(t, root, plan);
  // Drive triage->begin-fix->edit->end-fix through the CLI (Task 5 removes the door guard).
  // ... reach end-fix with declaredFiles=['src/a.js'] ...
  // assert end-fix result.reviewMode === 'partitioned'
  // assert manifest.status === 'checkpoint' && manifest.currentPhase === 'review'
});
```

> This test depends on Task 5 (guard removal) to reach begin-fix; sequence Task 5 before running the full assertion, or assert the fork by constructing the `fix` manifest directly (as Task 3's test does) and calling `runWorkflowCommand('end-fix', …)`.

- [ ] **Step 2: Run to confirm failure**

Run: `node --test --test-name-pattern="incremental exit" test/cli-partitioned-review.test.js`
Expected: FAIL — end-fix still returns the diff-review transition for the partitioned target.

- [ ] **Step 3: Implement the fork**

In `lib/workflow/file-set-fix.js`:

1. Add the import near the other `./file-set-*` requires (after line 59):

```js
const { applyPartitionedIncrement } = require('./file-set-partitioned-increment');
```

2. **Delete** the stale freshness block in `runEndFix` (current lines 815–833, the `let partitionedFreshness; … if (partitionedFreshness && partitionedFreshness.status === 'stale') { … }`). Replace those lines with the partitioned fork, placed right after the `declaredFiles.length === 0` guard (line 813) and before `let liveFileSet`:

```js
  // Plan B fork: an ACTIVE partition plan owns this target. The guard chain above
  // already proved the worktree delta == declared, in-set, route-owned fix, so this
  // is the one proven point at which we may re-stamp the partition plan and bounded
  // re-review only the affected units. A non-partitioned (or stale/inactive) target
  // falls through to the unchanged diff-review transition below.
  const activePartitionPlan = readActivePartitionedPlan(metadata);
  if (activePartitionPlan) {
    try {
      return await applyPartitionedIncrement({
        metadata,
        declaredFiles,
        fixReport,
        ledger,
        options,
        oldPlan: activePartitionPlan,
      });
    } finally {
      releaseLeaseQuietly(metadata);
    }
  }
```

> The increment writes the normalized fix report itself; the non-partitioned branch below keeps doing its own `writeNormalizedFixReport`. Do not double-write — the partitioned branch returns before reaching the non-partitioned report write. Keep the lease held until `applyPartitionedIncrement` has either persisted the checkpoint/review state or persisted a blocked state; release in `finally`.

3. **Delete** the now-dead `async function partitionedPlanFreshness(metadata, options) { … }` (current lines 645–671) and its `resolveCodeInventory`/`readUnitsPlan` imports IF they become unused (check: `resolveCodeInventory` and `readUnitsPlan` are also used elsewhere in the file via `resolveLiveFileSet`/imports — keep any still referenced).

- [ ] **Step 4: Run the tests**

Run:
```bash
node --test test/cli-partitioned-review.test.js test/workflow-fileset-lifecycle.test.js
```
Expected: PASS — partitioned end-fix takes the increment; non-partitioned end-fix still reaches `diff-review`.

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/workflow/file-set-fix.js test/cli-partitioned-review.test.js test/workflow-fileset-lifecycle.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): route active-plan end-fix to the incremental exit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Remove the ②′ begin-fix read-only guard

**Files:**
- Modify: `lib/workflow/file-set-fix.js` (`runBeginFix`)
- Test: `test/cli-partitioned-review.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: begin-fix on an active partitioned target is no longer blocked at the door; it proceeds through the normal lock/baseline path.

- [ ] **Step 1: Write the failing test**

```js
test('begin-fix is allowed for an active partition plan after triage', async (t) => {
  const root = makeMultiUnitRepo(t);
  const start = await startPartitioned(root);
  const metadata = resolveFileSetStateMetadata(start.targetStateDir);
  const plan = readActivePartitionedPlan(metadata);
  await recordCompletePartitionedCoverage(t, root, plan);
  // Force a FAIL aggregate + triage acceptance so begin-fix has an accepted issue.
  // ... record one unit with a high reviewer finding, aggregate -> FAIL, record-triage accept ...
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], { cwd: root });
  assert.notEqual(beginFix.blockingReason, 'state-validation-failed');
  assert.equal(beginFix.status, 'begin-fix');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test --test-name-pattern="begin-fix is allowed for an active partition" test/cli-partitioned-review.test.js`
Expected: FAIL — begin-fix returns `blocked / state-validation-failed` (the ②′ guard).

- [ ] **Step 3: Implement**

In `lib/workflow/file-set-fix.js` `runBeginFix`, **delete** the entire ②′ guard block (current lines 370–386):

```js
  // Partitioned project review is read-only for the fix loop in this version. ...
  if (readActivePartitionedPlan(metadata)) {
    return beginFixBlocked(metadata, null, { ... });
  }
```

If `readActivePartitionedPlan` is now unused in this file (Task 4 still uses it), keep the import; otherwise the linter/syntaxcheck will not complain (unused require is allowed) — but prefer to keep it since Task 4 uses it.

- [ ] **Step 4: Run the tests**

Run: `node --test test/cli-partitioned-review.test.js`
Expected: PASS.

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/workflow/file-set-fix.js test/cli-partitioned-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): allow begin-fix for an active partition plan (revert v1 read-only guard)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Finalize special-case for partitioned fix rounds

**Files:**
- Modify: `lib/workflow/file-set-finalize.js` (`buildFileSetFinalValidationState`)
- Test: `test/workflow-fileset-lifecycle.test.js`

**Interfaces:**
- Consumes: `readActivePartitionedPlan` (import from `./file-set-partitioned-live`).
- Produces: for a partitioned active target with a fix round, `requiredDiffReviewComplete` is `true` (the incremental unit-review + aggregate full-re-review IS the partitioned diff-review); the existing `requiredFullReReviewComplete` still gates PASS. Non-partitioned fix rounds still require a real `DIFF-OK` diff review (no regression). Never reads `aggregate.json`.

- [ ] **Step 1: Write the failing test**

In `test/workflow-fileset-lifecycle.test.js` (or `cli-partitioned-review.test.js`), assert: a partitioned target that went `fix → increment → unit-review → aggregate PASS (full-re-review report at currentRound) → finalize` returns `finalize` PASS; AND a partitioned read-only run (no fix round, never wrote a full-re-review PASS at the matching round) does NOT finalize as PASS. (The full happy path is built in the Task 10 capstone — here add the minimal finalize-state assertion using a constructed manifest with `lastFixReportPath` set, `lastReviewerReportPath` pointing at a `full-re-review` PASS report at `currentRound`, and an active `units.json`.)

```js
test('partitioned fix round finalizes without a diff-review report', () => {
  // Construct a target state dir with: active units.json (fingerprint == manifest.fileSetFingerprint),
  // manifest currentRound=1, lastFixReportPath -> a fix report (round 1),
  // lastReviewerReportPath -> a full-re-review PASS report (round 1).
  const state = buildFileSetFinalValidationState(metadataForConstructedPartitionedTarget);
  assert.equal(state.requiredDiffReviewComplete, true);
  assert.equal(state.requiredFullReReviewComplete, true);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test --test-name-pattern="partitioned fix round finalizes" test/workflow-fileset-lifecycle.test.js`
Expected: FAIL — `requiredDiffReviewComplete` is `false` (no `DIFF-OK` report).

- [ ] **Step 3: Implement**

In `lib/workflow/file-set-finalize.js`:

1. Add the import near the top requires:

```js
const { readActivePartitionedPlan } = require('./file-set-partitioned-live');
```

2. In `buildFileSetFinalValidationState`, replace the `requiredDiffReviewComplete` field (current lines 508–513):

```js
    requiredDiffReviewComplete: !hasFixRound ? true : Boolean(
      fixRoundCurrent &&
      diffReport &&
      Number(diffReport.report.round || 1) === round &&
      reportResult(diffReport.report) === 'DIFF-OK'
    ),
```

with:

```js
    // Partitioned fix rounds run unit-review -> aggregate -> full-re-review and have
    // NO diff-review; the aggregate full-re-review PASS (requiredFullReReviewComplete
    // below) is the equivalent coverage proof. A partitioned active target therefore
    // skips the diff-review requirement. Non-partitioned fix rounds are unchanged.
    requiredDiffReviewComplete: !hasFixRound
      ? true
      : (Boolean(readActivePartitionedPlan(metadata))
        ? true
        : Boolean(
          fixRoundCurrent &&
          diffReport &&
          Number(diffReport.report.round || 1) === round &&
          reportResult(diffReport.report) === 'DIFF-OK'
        )),
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/workflow-fileset-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/workflow/file-set-finalize.js test/workflow-fileset-lifecycle.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): accept full-re-review as the diff-review equivalent for fix rounds

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Revert the aggregate-FAIL nextAction to promise the fix loop

**Files:**
- Modify: `lib/workflow/partitioned-review.js` (`runAggregateReview`, FAIL branch ~line 526)
- Test: `test/cli-partitioned-review.test.js`

**Interfaces:**
- Consumes/Produces: none new — string copy only.

- [ ] **Step 1: Write the failing test**

```js
test('aggregate FAIL with a reviewer report directs the triage/fix loop', async (t) => {
  const root = makeMultiUnitRepo(t);
  const start = await startPartitioned(root);
  // record one unit with a high reviewer finding so aggregate -> stopped-with-deferrals + report
  // ... assert result.reviewerReportPath truthy ...
  assert.match(result.nextAction, /triage|begin-fix|fix loop/i);
  assert.doesNotMatch(result.nextAction, /read-only in this version/);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test --test-name-pattern="aggregate FAIL with a reviewer report" test/cli-partitioned-review.test.js`
Expected: FAIL — nextAction still says "read-only in this version".

- [ ] **Step 3: Implement**

In `lib/workflow/partitioned-review.js`, in `runAggregateReview`'s return (current lines 523–527), replace the FAIL branch string:

```js
    nextAction: result.verdict === 'PASS'
      ? 'verdict PASS earned; proceed to finalize'
      : (reviewerReportPath
        ? 'verdict FAIL recorded; partitioned project review is read-only in this version — fix the findings manually, or narrow scope= to a fixable subset and rerun review-fix-code, then re-review'
        : 'coverage incomplete; resolve deferrals before claiming a project PASS')
```

with:

```js
    nextAction: result.verdict === 'PASS'
      ? 'verdict PASS earned; proceed to finalize'
      : (reviewerReportPath
        ? 'verdict FAIL recorded; record-triage the accepted findings, then begin-fix. The partitioned fix loop re-reviews only the affected units before re-aggregating for an earned PASS.'
        : 'coverage incomplete; resolve deferrals before claiming a project PASS')
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/cli-partitioned-review.test.js`
Expected: PASS.

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/workflow/partitioned-review.js test/cli-partitioned-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): aggregate FAIL points back to the triage/fix loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Revert generator + route-contract wording and regenerate fixtures

**Files:**
- Modify: `lib/generator.js` (`partitionedReviewFlowFor` step 6)
- Modify: `templates/fragments/route-contract.code.claude.md`, `templates/fragments/route-contract.code.codex.md`
- Modify: `test/fixtures/generated/claude/review-fix-code.md`, `test/fixtures/generated/codex/review-fix-code.md`
- Modify: `test/shared-assets.test.js` (flip the two ②′ assertions, lines 116–133)

**Interfaces:** none — generated-content sync. The byte-for-byte snapshot test (`shared-assets.test.js:65`) is the gate; the template change and the fixture change must be identical.

- [ ] **Step 1: Flip the ②′ snapshot assertions (write the new expectation)**

In `test/shared-assets.test.js`, replace the test at lines 116–133 (`'Claude and Codex partitioned CODE flow routes deferrals to narrow-scope or manual re-review'`) with one asserting the fix loop is promised:

```js
test('Claude and Codex partitioned CODE flow routes aggregate FAIL into the triage/fix loop', () => {
  const SNAPSHOT_VERSION = '0.0.0-snapshot';
  for (const platform of ['claude', 'codex']) {
    const rendered = renderPlatformRoute(platform, 'review-fix-code', { packageVersion: SNAPSHOT_VERSION });
    assert.match(
      rendered,
      /stopped-with-deferrals[^\n]*reviewer report path[^\n]*record-triage[^\n]*begin-fix/i,
      `${platform}:review-fix-code must route partitioned aggregate FAIL into the triage/fix loop`
    );
    assert.doesNotMatch(
      rendered,
      /do not invoke `begin-fix` for the active partition plan/i,
      `${platform}:review-fix-code must not advertise the v1 read-only partition guard`
    );
  }
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test --test-name-pattern="partitioned CODE flow routes aggregate FAIL" test/shared-assets.test.js`
Expected: FAIL.

- [ ] **Step 3: Edit the generator step 6**

In `lib/generator.js`, replace the step-6 string in `partitionedReviewFlowFor` (current line 355):

```js
    '6. After all units and backstops are recorded, run `drfx workflow aggregate-review <targetStateDir> --json`. Treat the aggregate verdict as authoritative: only `verdict: PASS` may proceed to finalization. If `reason: coverage-incomplete`, review the uncovered units/backstops. If aggregate returns `stopped-with-deferrals` with a reviewer report path, do not invoke `begin-fix` for the active partition plan; resolve findings by narrowing `scope=` to a fixable subset or fixing manually, then re-review the relevant scope or whole project.',
```

with:

```js
    '6. After all units and backstops are recorded, run `drfx workflow aggregate-review <targetStateDir> --json`. Treat the aggregate verdict as authoritative: only `verdict: PASS` may proceed to finalization. If `reason: coverage-incomplete`, review the uncovered units/backstops. If aggregate returns `stopped-with-deferrals` with a reviewer report path, record-triage the accepted findings and run `begin-fix`; the partitioned fix loop re-reviews only the affected units and backstops before re-aggregating, so an earned project PASS stays reachable after fixes.',
```

- [ ] **Step 4: Mirror the same change into the route-contract fragments**

In `templates/fragments/route-contract.code.claude.md` and `…codex.md`, find the phase-3 line that describes the over-cap partitioned run as "review-only … there is no in-place partitioned fix loop in this version." Replace it with text matching the blueprint P1.5: partitioned over-cap runs earn PASS through `aggregate review → triage → fix → bounded re-review of affected units → re-aggregate`, and a fix only re-reviews the affected units + backstops. Keep the surrounding bullet structure byte-stable; change only the sentence(s) that asserted read-only.

- [ ] **Step 5: Regenerate the two code fixtures**

The step-6 text appears verbatim in the rendered fixtures (it is route shell, not masked embedded content). Update the same line in `test/fixtures/generated/claude/review-fix-code.md` and `test/fixtures/generated/codex/review-fix-code.md` to the new step-6 string. (Gemini's code route has no partitioned flow — `partitionedReviewFlowFor` returns `''` for gemini — so `test/fixtures/generated/gemini/review-fix-code.toml` is unchanged.) Then let the byte-for-byte test verify equality:

Run: `node --test test/shared-assets.test.js`
Expected: the `code-route generated shells equal golden snapshots byte-for-byte` test PASSES (template render == fixture). If it reports a diff, copy the exact expected text from the failure into the fixture.

- [ ] **Step 6: Run the full shared-assets suite**

Run: `node --test test/shared-assets.test.js`
Expected: PASS (all snapshot + content assertions, including the flipped one and `coverage-incomplete` checks at lines ~296–326 which remain true).

- [ ] **Step 7: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/generator.js templates/fragments/route-contract.code.claude.md templates/fragments/route-contract.code.codex.md test/fixtures/generated/claude/review-fix-code.md test/fixtures/generated/codex/review-fix-code.md test/shared-assets.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): restore the fix-loop guidance in generated code routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Update design §12

**Files:**
- Modify: `design/OPTIMIZATION-2026-06-20-partitioned-code-review.md` (§12)

**Interfaces:** none — doc only.

- [ ] **Step 1: Edit §12**

Mark Plan B as implemented: the over-cap partitioned run now supports an in-place incremental fix loop (`aggregate FAIL → triage → begin-fix → fix → end-fix increment → bounded re-review of affected units + all backstops → re-aggregate → earned PASS`); the v1 (②′) begin-fix read-only guard and the end-fix freshness backstop are removed; follow-up ① (record-triage read-only guard) is **voided** (it strengthened read-only, which Plan B removes). Note that membership/bucket/refs drift still blocks + resets (out of scope). Keep §8's oversize exit noted as the Part 2 follow-up.

- [ ] **Step 2: Verify the doc references nothing removed**

Run: `grep -n "read-only in this version\|begin-fix read-only" design/OPTIMIZATION-2026-06-20-partitioned-code-review.md`
Expected: only historical/changelog mentions remain (no live claim that the loop is read-only).

- [ ] **Step 3: Optional commit (only with explicit user approval)**

```bash
git status --short
git add design/OPTIMIZATION-2026-06-20-partitioned-code-review.md
git commit -m "$(cat <<'EOF'
docs(design): record Plan B partitioned fix loop as implemented

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Part 1 capstone — full earned-PASS integration test

**Files:**
- Test: `test/cli-partitioned-review.test.js`

**Interfaces:** drives the real CLI end to end via `runWorkflowCommand` + the existing partitioned harness (`makeMultiUnitRepo`, `startPartitioned`, `unitReviewReceipt`, `reviewerFailHighWithId`, `writeReceiptTempFile`, `recordCompletePartitionedCoverage`, `readReviewerReportJson`, `parseManifestV2`).

This task adds NO production code — it proves the Part 1 DoD and locks the loop against regression. If it fails, the failure points at one of Tasks 1–9.

- [ ] **Step 1: Write the capstone test**

```js
test('over-cap partitioned project earns PASS through the incremental fix loop', async (t) => {
  const root = makeMultiUnitRepo(t);
  const start = await startPartitioned(root);
  const metadata = resolveFileSetStateMetadata(start.targetStateDir);
  const plan = readActivePartitionedPlan(metadata);

  // 1. Review every unit; unit-001 gets ONE high reviewer finding (a real, fixable defect).
  //    Other units + all 7 backstops: coverage_risk:none.
  //    (Use unitReviewReceipt + reviewerFailHighWithId for unit-001; clean receipts elsewhere.)

  // 2. aggregate-review -> stopped-with-deferrals + reviewer report path.
  const agg1 = await runWorkflowCommand('aggregate-review', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(agg1.verdict, 'stopped-with-deferrals');
  assert.ok(agg1.reviewerReportPath);

  // 3. record-triage (accept the finding) -> begin-fix (now allowed) -> edit src/a.js -> end-fix.
  //    end-fix returns reviewMode:'partitioned', manifest -> checkpoint/review, unit-001 invalidated.

  // 4. context --phase unit-review re-reviews ONLY unit-001 (+ backstops); re-record coverage_risk:none.
  //    Other units' summaries were NOT deleted (assert one survivor still present pre-aggregate).

  // 5. re-record all 7 backstops none. aggregate-review -> PASS; writes full-re-review report at round 1.
  const agg2 = await runWorkflowCommand('aggregate-review', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(agg2.verdict, 'PASS');

  // 6. finalize -> PASS.
  const fin = await runWorkflowCommand('finalize', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(fin.ok, true);
  assert.match(JSON.stringify(fin), /pass/i);
});

test('read-only partitioned run can never finalize PASS even with full unit coverage', async (t) => {
  // start with read-only; record all units+backstops none; aggregate PASS writes full-re-review;
  // finalize must NOT be a workflow PASS (mode gate). Assert fin is not a pass.
});
```

> Fill the elided steps with the same `runWorkflowCommand('record-review', [...])` / `runWorkflowCommand('record-triage', [...])` / `runWorkflowCommand('begin-fix'|'end-fix', [...])` calls the existing tests in this file use (see lines ~200, ~338, ~428). Use `writeReceiptTempFile(t, …)` for the coverage receipt `--payload-file`, and `--result-stdin` for reviewer findings, exactly as `recordCompletePartitionedCoverage` does.

- [ ] **Step 2: Run the capstone**

Run: `node --test --test-name-pattern="earns PASS through the incremental fix loop|read-only partitioned run can never finalize" test/cli-partitioned-review.test.js`
Expected: PASS (both).

- [ ] **Step 3: Run the full Part 1 verification gate**

Run:
```bash
node --test test/project-review.test.js test/workflow-fileset-lifecycle.test.js test/cli-partitioned-review.test.js test/shared-assets.test.js
npm run syntaxcheck
npm test
```
Expected: all green. This is the **Part 1 DoD gate** — Part 1 is independently mergeable here.

- [ ] **Step 4: Optional commit (only with explicit user approval)**

```bash
git status --short
git add test/cli-partitioned-review.test.js
git commit -m "$(cat <<'EOF'
test(partitioned): cover the end-to-end incremental fix loop earning PASS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

> **Part 1 merge point.** With Tasks 1–10 green, Part 1 may merge to `main` independently of Part 2 (see G.3). If Part 2 stalls, stop here.

---

# PART 2 — P2: oversize single-file chunked review (independent merge point)

### Task 11: Pure `computeOversizeChunks` line+byte windowing

**Files:**
- Modify: `lib/project-review.js` (add pure function + `CHUNK_LINES`/`CHUNK_OVERLAP_LINES`)
- Test: `test/project-review.test.js`

**Interfaces:**
- Produces:
  `computeOversizeChunks({ text, chunkLines = CHUNK_LINES, overlapLines = CHUNK_OVERLAP_LINES, chunkByteBudget = MAX_UNIT_BYTES }) -> Array<{ primaryLineRange:[s,e], contextLineRange:[cs,ce], sliceText, byteLength }> | null`.
  Deterministic: same `text` ⇒ same boundaries. Returns `null` (fall back to legacy oversize blocker) when any single line's UTF-8 byte length alone exceeds `chunkByteBudget`. Line numbers are 1-based inclusive. `byteLength` is `Buffer.byteLength(sliceText, 'utf8')` of the `contextLineRange` slice and must be `<= chunkByteBudget` for every returned chunk.

- [ ] **Step 1: Write the failing tests**

```js
const { computeOversizeChunks } = require('../lib/project-review');

test('computeOversizeChunks splits by line window with overlap, deterministically', () => {
  const text = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const chunks = computeOversizeChunks({ text, chunkLines: 400, overlapLines: 20, chunkByteBudget: 1_000_000 });
  assert.ok(Array.isArray(chunks) && chunks.length >= 2);
  assert.deepEqual(chunks[0].primaryLineRange, [1, 400]);
  // bidirectional overlap: chunk 1's context extends 20 lines after its primary;
  // chunk 2's context starts 20 lines before its primary start.
  assert.equal(chunks[0].contextLineRange[1], 420);
  assert.equal(chunks[1].primaryLineRange[0], 401);
  assert.equal(chunks[1].contextLineRange[0], 381);
  // every chunk's context slice is within budget.
  for (const c of chunks) assert.ok(c.byteLength <= 1_000_000);
  // determinism.
  const again = computeOversizeChunks({ text, chunkLines: 400, overlapLines: 20, chunkByteBudget: 1_000_000 });
  assert.deepEqual(again.map((c) => c.primaryLineRange), chunks.map((c) => c.primaryLineRange));
});

test('computeOversizeChunks shrinks context overlap to honor the byte budget', () => {
  // Build text whose 400-line primary is ~960KB and whose full bidirectional
  // 40-line overlap would push the context slice over 1MB unless overlap shrinks.
  const big = 'x'.repeat(2400);
  const text = Array.from({ length: 800 }, () => big).join('\n') + '\n';
  const chunks = computeOversizeChunks({ text, chunkLines: 400, overlapLines: 40, chunkByteBudget: 1_000_000 });
  assert.ok(chunks.every((c) => c.byteLength <= 1_000_000));
});

test('computeOversizeChunks returns null when a single line exceeds the byte budget', () => {
  const text = 'a'.repeat(2_000_000) + '\nshort\n';
  assert.equal(computeOversizeChunks({ text, chunkLines: 400, overlapLines: 40, chunkByteBudget: 1_000_000 }), null);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test --test-name-pattern="computeOversizeChunks" test/project-review.test.js`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement**

In `lib/project-review.js` add constants near `MAX_UNIT_BYTES`:

```js
const CHUNK_LINES = 800;
const CHUNK_OVERLAP_LINES = 40;
```

Add the function (after `refreshPartitionPlanContent`):

```js
// Deterministic line-window chunking for an oversize TEXT file. Primary windows of
// chunkLines get up to overlapLines of context before AND after the primary. The HARD
// constraint is the UTF-8 byte length of the contextLineRange slice (<= chunkByteBudget):
// overlap is shrunk (never the primary) to fit; a primary window is also byte-capped by
// ending it early when the next line would cross the budget. If any single line alone
// exceeds the budget the file is unsplittable -> null (caller keeps the legacy oversize blocker).
function computeOversizeChunks({ text, chunkLines = CHUNK_LINES, overlapLines = CHUNK_OVERLAP_LINES, chunkByteBudget = MAX_UNIT_BYTES }) {
  const lines = String(text).split('\n');
  // Preserve trailing newline semantics: split keeps a trailing '' for a final '\n'.
  const lineByte = (oneBasedIndex) => Buffer.byteLength(lines[oneBasedIndex - 1] + '\n', 'utf8');
  const total = lines.length;
  for (let i = 1; i <= total; i += 1) {
    if (lineByte(i) > chunkByteBudget) return null; // a single line cannot fit
  }
  const sliceText = (s, e) => lines.slice(s - 1, e).join('\n') + (e < total ? '\n' : '');
  const sliceBytes = (s, e) => Buffer.byteLength(sliceText(s, e), 'utf8');

  const chunks = [];
  let primaryStart = 1;
  while (primaryStart <= total) {
    // Grow the primary window up to chunkLines OR until the next line would cross budget.
    let primaryEnd = primaryStart;
    while (
      primaryEnd < total &&
      (primaryEnd - primaryStart + 1) < chunkLines &&
      sliceBytes(primaryStart, primaryEnd + 1) <= chunkByteBudget
    ) {
      primaryEnd += 1;
    }
    // Add bidirectional overlap around the primary, shrinking only overlap until
    // the context slice fits. Prefer dropping forward context first so each
    // chunk still retains preceding context when budget pressure is tight.
    let contextStart = Math.max(1, primaryStart - overlapLines);
    let contextEnd = Math.min(total, primaryEnd + overlapLines);
    while (sliceBytes(contextStart, contextEnd) > chunkByteBudget) {
      if (contextEnd > primaryEnd) {
        contextEnd -= 1;
      } else if (contextStart < primaryStart) {
        contextStart += 1;
      } else {
        break;
      }
    }
    chunks.push({
      primaryLineRange: [primaryStart, primaryEnd],
      contextLineRange: [contextStart, contextEnd],
      sliceText: sliceText(contextStart, contextEnd),
      byteLength: sliceBytes(contextStart, contextEnd),
    });
    if (primaryEnd >= total) break;
    primaryStart = primaryEnd + 1;
  }
  return chunks;
}
```

Export `computeOversizeChunks`, `CHUNK_LINES`, `CHUNK_OVERLAP_LINES`.

- [ ] **Step 4: Run to confirm pass**

Run: `node --test --test-name-pattern="computeOversizeChunks" test/project-review.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/project-review.js test/project-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): add deterministic oversize line-window chunking

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `splitOversizeFile` IO wrapper + chunk-unit schema

**Files:**
- Modify: `lib/workflow/file-set-context.js` (add `splitOversizeFile`)
- Test: `test/project-review.test.js` (or a context test) — uses a real tmp file

**Interfaces:**
- Consumes: `computeOversizeChunks` (Task 11), `computeMemberDigest` + `sha256hex` semantics (chunk `contentId = sha256(sliceText)`, `member_digest = sha256(chunkContentId)`).
- Produces:
  `splitOversizeFile({ projectRoot, file, chunkLines, overlapLines, chunkByteBudget }) -> Array<unit>|null`.
  Each chunk-unit:
  `{ unit_id, oversize_chunk:true, sourcePath, sourceContentId, files:[{ path, primaryLineRange:[s,e], contextLineRange:[cs,ce], size, contentId }], chunkIndex, chunkCount, member_digest, member_count:1, member_bytes:byteLength, suggestedRefs:[] }`.
  `unit_id` is assigned by the caller (Task 13) — `splitOversizeFile` returns chunk-units with a placeholder `unit_id:null` that `assemblePartitionPlan` fills. Returns `null` (keep legacy `oversize_file:true`) when: not a text/UTF-8 file, read fails, or `computeOversizeChunks` returns `null`.

- [ ] **Step 1: Write the failing test**

```js
const { splitOversizeFile } = require('../lib/workflow/file-set-context');

test('splitOversizeFile expands a text oversize file into chunk-units with stable contentIds', () => {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-split-'));
  const body = Array.from({ length: 1200 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(pathMod.join(dir, 'big.js'), body);
  const file = { path: 'big.js', size: Buffer.byteLength(body), ext: '.js', contentId: 'srcCID' };
  const chunks = splitOversizeFile({ projectRoot: dir, file, chunkLines: 500, overlapLines: 20, chunkByteBudget: 1_000_000 });
  assert.ok(Array.isArray(chunks) && chunks.length >= 2);
  assert.ok(chunks.every((c) => c.oversize_chunk === true && c.sourcePath === 'big.js' && c.sourceContentId === 'srcCID'));
  assert.equal(chunks[0].files[0].path, 'big.js');
  assert.equal(chunks[0].chunkCount, chunks.length);
  // member_digest = sha256(chunkContentId); distinct per chunk.
  assert.notEqual(chunks[0].member_digest, chunks[1].member_digest);
});

test('splitOversizeFile returns null for an unsplittable (single huge line) file', () => {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-split2-'));
  fs.writeFileSync(pathMod.join(dir, 'min.js'), 'a'.repeat(2_000_000) + '\n');
  const file = { path: 'min.js', size: 2_000_001, ext: '.js', contentId: 'cid' };
  assert.equal(splitOversizeFile({ projectRoot: dir, file, chunkByteBudget: 1_000_000 }), null);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test --test-name-pattern="splitOversizeFile" test/project-review.test.js`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement**

In `lib/workflow/file-set-context.js`, add (near `readMemberTextForRefs`, the IO boundary). The file already imports `crypto` from `./helpers`; do not add a second `const crypto = require('node:crypto')` binding.

```js
const { computeOversizeChunks } = require('../project-review');

function sha256hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Expand ONE oversize text file into deterministic chunk-as-sub-units. IO lives here
// (reads the in-root file body once). Returns null to keep the legacy oversize blocker
// when the file is not UTF-8 text, cannot be read, or is unsplittable (single huge line).
function splitOversizeFile({ projectRoot, file, chunkLines, overlapLines, chunkByteBudget } = {}) {
  let text;
  try {
    const buf = fsExtra.readFileSync(path.join(projectRoot, file.path));
    // Reject binary/non-UTF-8: round-trip and compare, and reject NUL bytes.
    if (buf.includes(0)) return null;
    text = buf.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') !== buf.length) return null;
  } catch {
    return null;
  }
  const chunks = computeOversizeChunks({ text, chunkLines, overlapLines, chunkByteBudget });
  if (!chunks) return null;
  const chunkCount = chunks.length;
  return chunks.map((chunk, index) => {
    const chunkContentId = sha256hex(chunk.sliceText);
    const member = {
      path: file.path,
      primaryLineRange: chunk.primaryLineRange,
      contextLineRange: chunk.contextLineRange,
      size: chunk.byteLength,
      contentId: chunkContentId,
    };
    return {
      unit_id: null, // assigned by assemblePartitionPlan
      oversize_chunk: true,
      sourcePath: file.path,
      sourceContentId: file.contentId,
      files: [member],
      chunkIndex: index,
      chunkCount,
      member_count: 1,
      member_bytes: chunk.byteLength,
      member_digest: sha256hex(chunkContentId),
      suggestedRefs: [],
    };
  });
}
```

Export `splitOversizeFile`.

- [ ] **Step 4: Run to confirm pass**

Run: `node --test --test-name-pattern="splitOversizeFile" test/project-review.test.js`
Expected: PASS.

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/workflow/file-set-context.js test/project-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): expand oversize text files into chunk sub-units

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Wire `assemblePartitionPlan` to expand oversize units

**Files:**
- Modify: `lib/workflow/file-set-context.js` (`assemblePartitionPlan`)
- Test: `test/project-review.test.js` (or a context-pack test) — assert plan shape + file-level `inventoryRows`

**Interfaces:**
- Consumes: `splitOversizeFile` (Task 12).
- Produces: a partition plan whose oversize text units are replaced by chunk-units (re-numbered `unit_id` contiguously); `inventoryRows` stays **file-level** (one row per source path); a non-splittable oversize file keeps `oversize_file:true`.

- [ ] **Step 1: Write the failing test**

```js
const { assemblePartitionPlan } = require('../lib/workflow/file-set-context');

test('assemblePartitionPlan expands a splittable oversize file into chunk units, inventoryRows stay file-level', () => {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-assemble-'));
  const big = Array.from({ length: 1500 }, (_, i) => `let v${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(pathMod.join(dir, 'big.js'), big);
  fs.writeFileSync(pathMod.join(dir, 'small.js'), 'module.exports = 1;\n');
  const inventory = [
    { path: 'big.js', size: 1_200_000, ext: '.js', contentId: 'bigCID' }, // > MAX_UNIT_BYTES
    { path: 'small.js', size: 20, ext: '.js', contentId: 'smallCID' },
  ];
  const plan = assemblePartitionPlan({ inventory, projectReviewFingerprint: 'FP', projectRoot: dir });
  const chunkUnits = plan.units.filter((u) => u.oversize_chunk === true);
  assert.ok(chunkUnits.length >= 2, 'big.js expanded into chunks');
  assert.ok(!plan.units.some((u) => u.oversize_file === true), 'no legacy oversize unit remains');
  // unit_ids are contiguous unit-NNN.
  assert.ok(plan.units.every((u) => /^unit-\d{3,}$/.test(u.unit_id)));
  // inventoryRows: big.js appears EXACTLY once (file-level), not once per chunk.
  const bigRows = plan.inventoryRows.filter((r) => r.path === 'big.js');
  assert.equal(bigRows.length, 1);
  assert.equal(bigRows[0].contentId, 'bigCID'); // file-level contentId preserved
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test --test-name-pattern="assemblePartitionPlan expands" test/project-review.test.js`
Expected: FAIL — oversize unit still has `oversize_file:true`, and `inventoryRows` is flattened from `unit.files`.

- [ ] **Step 3: Implement**

In `lib/workflow/file-set-context.js` `assemblePartitionPlan` (lines 567–610), after `const units = partitionInventory(...)` expand oversize units and re-number, then build `inventoryRows` from the file-level inventory:

```js
function assemblePartitionPlan({ inventory, projectReviewFingerprint, userExcludes = [], projectRoot, unitByteBudget = MAX_UNIT_BYTES }) {
  const rawUnits = partitionInventory(inventory, { unitByteBudget });
  const inRootSet = new Map((Array.isArray(inventory) ? inventory : []).map((row) => [row.path, row.contentId]));

  // Expand oversize text files into chunk-units; keep legacy oversize blocker when
  // splitOversizeFile declines (binary / unsplittable). Then renumber unit_ids.
  const expanded = [];
  for (const unit of rawUnits) {
    if (unit.oversize_file === true) {
      const chunks = splitOversizeFile({
        projectRoot,
        file: unit.files[0],
        chunkLines: CHUNK_LINES,
        overlapLines: CHUNK_OVERLAP_LINES,
        chunkByteBudget: unitByteBudget,
      });
      if (chunks) { expanded.push(...chunks); continue; }
    }
    expanded.push(unit);
  }
  const units = expanded.map((unit, idx) => {
    const unit_id = formatUnitId(idx + 1);
    const files = unit.files.map((f) => ({ ...f, unit_id }));
    return { ...unit, unit_id, files };
  });

  for (const unit of units) {
    if (unit.oversize_chunk === true) continue;       // chunk refs stay []
    if (unit.oversize_file === true) { unit.suggestedRefs = []; continue; }
    const unitFiles = readMemberTextForRefs(projectRoot, unit.files);
    unit.suggestedRefs = suggestRefsFor(unitFiles, inRootSet);
  }

  // inventoryRows: FILE-LEVEL — one row per source path from the inventory (NOT
  // flattened from units, which would duplicate a chunked file's path). unit_id is
  // the owning unit; for a chunked file every chunk shares the sourcePath, so map it
  // to the first chunk's unit_id.
  const pathToUnit = new Map();
  for (const unit of units) {
    if (unit.oversize_chunk === true) {
      if (!pathToUnit.has(unit.sourcePath)) pathToUnit.set(unit.sourcePath, unit.unit_id);
      continue;
    }
    for (const file of unit.files) pathToUnit.set(file.path, unit.unit_id);
  }
  const inventoryRows = (Array.isArray(inventory) ? inventory : [])
    .map((row) => ({ path: row.path, size: row.size, ext: row.ext, contentId: row.contentId, unit_id: pathToUnit.get(row.path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    reviewMode: 'partitioned',
    unitByteBudget,
    units,
    crosscuttingBackstops: CROSSCUTTING_BACKSTOPS,
    projectReviewFingerprint,
    userExcludes: Array.isArray(userExcludes) ? userExcludes : [],
    inventoryRows,
  };
}
```

> Import `formatUnitId` if not already in scope — it is private to `project-review.js`. Either export it from there, or compute `unit_id` inline as `'unit-' + String(idx + 1).padStart(3, '0')`. Also import `CHUNK_LINES`, `CHUNK_OVERLAP_LINES` from `../project-review`.

- [ ] **Step 4: Run to confirm pass + non-chunk regression**

Run:
```bash
node --test --test-name-pattern="assemblePartitionPlan" test/project-review.test.js
node --test test/cli-partitioned-review.test.js
```
Expected: PASS — chunk expansion works; existing non-oversize partition plans are byte-stable (the `inventoryRows` change is equivalent for non-chunk inventories: same rows, same sort).

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/workflow/file-set-context.js test/project-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): assemble chunk units for oversize files, file-level inventoryRows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: chunk metadata + in-memory line-slice handoff

**Files:**
- Modify: `lib/context-pack.js` (`buildFileSetContextPack` / its member normalization)
- Modify: `lib/workflow/file-set-unit-review.js` (`unitContext` chunk member handoff)
- Modify: generated CODE route guidance / route-contract fragments so reviewers read only the declared slice for chunk units.
- Test: `test/context-pack` test (or wherever `buildFileSetContextPack` is unit-tested) + a partitioned chunk metadata assertion

**Interfaces:**
- Consumes: a unit member carrying `contextLineRange:[cs,ce]`, `primaryLineRange:[s,e]`, `chunkIndex`, and `chunkCount`. Task 12 stores `chunkIndex`/`chunkCount` on the chunk unit, so `unitContext` must copy that unit-level chunk metadata onto the file member descriptor before calling `buildFileSetContextPack`.
- Produces: when a member has `contextLineRange`, the persisted context pack records ONLY metadata: path, `primaryLineRange`, `contextLineRange`, `chunkIndex`, `chunkCount`, and an instruction label. **It must not persist `sliceText`, file body text, or raw source lines.** The route/coordinator reads the slice into the reviewer prompt in memory immediately before reviewer dispatch. Members without `contextLineRange` are unchanged (byte-for-byte).

- [ ] **Step 1: Write the failing test**

Assert that `buildFileSetContextPack` for a partitioned chunk member (member has `contextLineRange:[381,820]`, `primaryLineRange:[401,800]`, `chunkIndex:0`, `chunkCount:2`) persists the chunk metadata and label, does **not** contain body text from lines 381–820, and includes a constraint telling the reviewer/coordinator to read only that slice in memory. Also assert a non-chunk member descriptor stays byte-identical.

Add an integration assertion through `unitContext`: construct an `oversize_chunk` unit whose `chunkIndex`/`chunkCount` live on the unit, not on `files[0]`, then assert the generated context pack still contains concrete chunk index/count values. This pins the unit-level-to-member-level handoff and prevents `undefined` / `NaN` labels.

- [ ] **Step 2: Run to confirm failure**

Expected: FAIL — the pack drops chunk range metadata, so the route cannot know which slice to read.

- [ ] **Step 3: Implement**

In `lib/workflow/file-set-unit-review.js`, update `unitContext` so when `unit.oversize_chunk === true`, it builds the member array passed to `buildFileSetContextPack` by copying `unit.chunkIndex` and `unit.chunkCount` onto each chunk member that already carries `contextLineRange` / `primaryLineRange`. Keep the non-chunk member array byte-identical.

In `lib/context-pack.js`, extend `normalizeFileSetMembers` metadata only. If `member.contextLineRange` is present, read `member.chunkIndex` / `member.chunkCount` from the normalized member descriptor and add:

```js
{
  path,
  status: 'present',
  chunk: {
    index: Number(member.chunkIndex),
    count: Number(member.chunkCount),
    primaryLineRange: member.primaryLineRange,
    contextLineRange: member.contextLineRange,
    instruction: '<path> chunk <index+1>/<count>, primary lines [s,e], context lines [cs,ce]; use location <path>:<line> for line-specific findings; overlap before/after the primary is context only — do not raise duplicate findings for overlap lines.'
  }
}
```

Do **not** read the file body in `buildFileSetContextPack`; context manifests are durable state and must keep `contentPolicy:'read-in-memory-only'`. Update the generated CODE route guidance so the coordinator, when dispatching a chunk unit reviewer, reads exactly `contextLineRange` from disk into the reviewer prompt in memory and never asks the reviewer to read the whole file. Keep the no-`contextLineRange` path exactly as-is so non-chunk packs stay byte-identical.

- [ ] **Step 4: Run to confirm pass + byte-stable regression**

Run:
```bash
node --test test/context-pack*.test.js test/shared-assets.test.js
```
Expected: PASS — chunk metadata is persisted without body text; route guidance covers in-memory slice handoff; non-partitioned packs unchanged.

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/context-pack.js lib/workflow/file-set-unit-review.js test/context-pack*.test.js test/cli-partitioned-review.test.js lib/generator.js templates/fragments/route-contract.code.claude.md templates/fragments/route-contract.code.codex.md test/fixtures/generated/claude/review-fix-code.md test/fixtures/generated/codex/review-fix-code.md
git commit -m "$(cat <<'EOF'
feat(partitioned): describe chunk slices without persisting file bodies

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: `unitContext` + `recordUnitReview` chunk branches

**Files:**
- Modify: `lib/workflow/file-set-unit-review.js` (`unitContext`, `recordUnitReview`)
- Test: `test/cli-partitioned-review.test.js`

**Interfaces:**
- Consumes: chunk-unit schema (Task 12/13), sliced context pack (Task 14).
- Produces: a chunk unit goes through the NORMAL bounded review path (loads its slice, records `reviewed`/`coverage_risk` honestly), NOT the forced-high oversize path. The legacy `oversize_file:true` unit keeps its forced-high behavior unchanged.

- [ ] **Step 1: Write the failing test**

Assert: `unitContext` for an `oversize_chunk` unit returns `oversize:false` with a context manifest carrying chunk range metadata (no body text), including concrete `chunk.index` and `chunk.count` copied from unit-level `chunkIndex` / `chunkCount`, and `recordUnitReview` for that unit with a clean receipt writes `coverage_risk:'none'` (not forced high). Assert a legacy `oversize_file:true` unit still forces `reviewed:false, coverage_risk:'high'`.

- [ ] **Step 2: Run to confirm failure**

Expected: FAIL — `unitContext`/`recordUnitReview` currently treat any non-normal unit by the normal path only if `oversize_file !== true`; a chunk unit has neither flag set in the legacy branches, so verify the actual current behavior and write the assertion that fails.

- [ ] **Step 3: Implement**

In `unitContext` (line 264) and `recordUnitReview` (line 378): the `oversize_file === true` branch stays as the forced-high blocker. A unit with `oversize_chunk === true` must take the **normal** branch (it has real `files[]` with `contextLineRange`, so `buildFileSetContextPack` emits chunk metadata and the route reads the slice in memory before reviewer dispatch). Confirm the normal branch already passes a chunk member's `contextLineRange` through. No forced-high for chunk units.

- [ ] **Step 4: Run to confirm pass**

Run: `node --test test/cli-partitioned-review.test.js`
Expected: PASS.

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/workflow/file-set-unit-review.js test/cli-partitioned-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): review oversize chunks through the normal bounded path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Chunk-aware finding dedup/normalization

**Files:**
- Modify: `lib/workflow/partitioned-review.js` (aggregate path) or `lib/project-review.js` (`findingDedupKey`/`aggregate`)
- Test: `test/project-review.test.js` + `test/cli-partitioned-review.test.js`

**Interfaces:**
- Consumes: chunk findings use the existing reviewer `location` field with a parseable line anchor: `<path>:<line>` or `<path>:L<line>`. The chunk context prompt must instruct reviewers to use that format for line-specific chunk findings. Overlap lines mean two adjacent chunks may report the same defect.
- Produces: a stable dedup key `(path + canonical owner primaryLineRange + issue class)` collapses overlap duplicates. **No new reviewer schema field** — `issue class` is derived internally from existing fields (e.g. `severity` + a normalized hash of `issue`/`suggested_fix` text), since `parseReviewerResult` accepts only fixed fields. If `location` is missing or unparsable, do not drop the finding; keep it under the reporting chunk's own primary range so PASS is not earned by an unparsed overlap heuristic.

- [ ] **Step 1: Write the failing test**

Assert: under the bidirectional overlap model from Task 11, two findings for the same path with the same severity + normalized text and parseable `location` values, one reported by chunk 1 against its forward overlap and one reported by chunk 2 against that same line in chunk 2's primary, dedup to ONE finding in the aggregate. Two genuinely different findings (different normalized text) stay distinct. Add a fallback test proving an unparsable `location` is retained under the reporting chunk instead of being dropped.

- [ ] **Step 2: Run to confirm failure**

Expected: FAIL — the current `findingDedupKey` is a full-object key, so overlap duplicates with differing wording/line survive as two findings.

- [ ] **Step 3: Implement**

Add a chunk-aware normalization that, before dedup, parses `finding.location` with the grammar above, maps the reported line into the owning chunk's `primaryLineRange`, and canonicalizes overlap-only findings to the primary owner when a matching owner exists. With bidirectional overlap, the owner is the chunk whose `primaryLineRange` contains the parsed line; an overlap report from either adjacent chunk uses that owner's primary range in the key. Build the dedup key from `path + canonicalOwnerPrimaryRange + sha256(normalize(issue)+severity)`. If the line cannot be parsed, keep the original finding with a key based on the reporting chunk's own primary range; never discard it. Apply this in the partitioned aggregate path only (guard on `reviewMode === 'partitioned'` / presence of chunk units) so non-chunk aggregation is unchanged.

- [ ] **Step 4: Run to confirm pass**

Run: `node --test test/project-review.test.js test/cli-partitioned-review.test.js`
Expected: PASS.

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/project-review.js lib/workflow/partitioned-review.js test/project-review.test.js test/cli-partitioned-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): dedup overlap findings across oversize chunks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: `refreshPartitionPlanContent` chunk compatibility (Plan B × P2)

**Files:**
- Modify: `lib/project-review.js` (`refreshPartitionPlanContent` chunk branch)
- Test: `test/project-review.test.js`

**Interfaces:**
- Consumes: chunk-unit schema.
- Produces: when a non-chunk file is fixed and the oversize parent's `sourceContentId` is UNCHANGED, the chunk units keep their `contentId/size/member_digest` (refresh leaves them intact). When the oversize parent's content CHANGED, refresh throws `ERR_PARTITION_MEMBERSHIP_CHANGED` (re-split required ⇒ block + reset). This makes Plan B + P2 coexist: a mixed-project fix that does not touch the oversize file leaves chunks valid; touching the oversize file resets.

- [ ] **Step 1: Write the failing tests**

```js
test('refreshPartitionPlanContent keeps chunk units intact when the parent content is unchanged', () => {
  // plan with one chunk unit (sourcePath 'big.js', sourceContentId 'B0') + one normal unit 'a.js'.
  // newInventory: a.js changed, big.js unchanged (contentId still 'B0').
  // assert refreshedPlan chunk unit's files[0].contentId is preserved (not overwritten by file-level contentId).
  // assert inventoryRows still contains big.js once and maps it to the first chunk unit_id, not the last.
});

test('refreshPartitionPlanContent throws when the oversize parent content changed', () => {
  // newInventory: big.js contentId 'B1' (changed) -> ERR_PARTITION_MEMBERSHIP_CHANGED.
});
```

> Task 1 already added the chunk branch (`oversize_chunk` → compare `sourceContentId`, throw on mismatch, else `{...unit}`). This task adds the explicit tests and, if Task 1's branch overwrote chunk content fields, fixes it to PRESERVE chunk `contentId/size/member_digest` (never overwrite with file-level `contentId`). Also ensure `planFilePathSet` counts `sourcePath` once (already done in Task 1) and `inventoryRows` preserves the first chunk `unit_id` for that source path so membership identity stays file-level and stable for a chunked file.

- [ ] **Step 2: Run to confirm failure (or confirm Task 1 already passes)**

Run: `node --test --test-name-pattern="chunk units intact|oversize parent content changed" test/project-review.test.js`
Expected: FAIL if Task 1's defensive branch needs hardening; PASS if Task 1 already satisfied it (then this task is test-only).

- [ ] **Step 3: Implement (if needed)**

Confirm the `oversize_chunk` branch in `refreshPartitionPlanContent` returns `{ ...unit }` unchanged when `sourceContentId` matches (preserving chunk `contentId/size/member_digest`) and throws otherwise. No file-level overwrite of chunk content.

- [ ] **Step 4: Run to confirm pass**

Run: `node --test test/project-review.test.js`
Expected: PASS.

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add lib/project-review.js test/project-review.test.js
git commit -m "$(cat <<'EOF'
feat(partitioned): preserve chunk content across incremental refresh, reset on parent change

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Part 2 capstone — oversize earns PASS + docs

**Files:**
- Test: `test/cli-partitioned-review.test.js` (+ a fixture for an over-cap repo containing a splittable oversize file)
- Modify: `templates/fragments/route-contract.code.{claude,codex}.md` (oversize note), `test/fixtures/generated/{claude,codex}/review-fix-code.md` (regenerate), `design/OPTIMIZATION-2026-06-20-partitioned-code-review.md` (§8 fulfilled)

**Interfaces:** end-to-end; no new production code.

- [ ] **Step 1: Write the capstone tests**

```js
test('over-cap project with a splittable oversize file earns PASS via chunk coverage', async (t) => {
  // makeOverCapRepo variant that includes one >1MB splittable text file.
  // start partitioned -> plan has chunk units for the oversize file.
  // review every unit (chunks included) coverage_risk:none + all backstops none.
  // aggregate-review -> PASS (file-level none == every chunk none).
});

test('a single chunk left high keeps the file a coverage blocker (no fake PASS)', async (t) => {
  // same repo; leave ONE chunk reviewed:false/high -> aggregate -> stopped-with-deferrals, coverage-incomplete.
});

test('an unsplittable single-huge-line oversize file stays a legacy high blocker', async (t) => {
  // repo with a min.js single 2MB line -> plan keeps oversize_file:true -> coverage-incomplete.
});
```

- [ ] **Step 2: Run to confirm failure, then make green**

Run: `node --test --test-name-pattern="oversize" test/cli-partitioned-review.test.js`
Expected: the three tests pass once Tasks 11–17 are integrated. Fix any wiring gaps surfaced here.

- [ ] **Step 3: Docs + fixtures**

Add a one-sentence oversize note to the route-contract phase-3 fragments: oversize text files are covered by deterministic line-window chunk review; a single chunk left unconfirmed keeps the whole file a coverage blocker (no fake PASS); unsplittable files (single huge line / binary) remain honest blockers. Regenerate the claude/codex code fixtures (byte-for-byte). Mark design §8's reserved "in-file chunked review" exit as fulfilled.

- [ ] **Step 4: Full Part 2 verification gate**

Run:
```bash
node --test test/project-review.test.js test/workflow-fileset-lifecycle.test.js test/cli-partitioned-review.test.js test/shared-assets.test.js
npm run syntaxcheck
npm test
```
Expected: all green. **Part 2 DoD gate.**

- [ ] **Step 5: Optional commit (only with explicit user approval)**

```bash
git status --short
git add test/cli-partitioned-review.test.js templates/fragments/route-contract.code.claude.md templates/fragments/route-contract.code.codex.md test/fixtures/generated/claude/review-fix-code.md test/fixtures/generated/codex/review-fix-code.md design/OPTIMIZATION-2026-06-20-partitioned-code-review.md
git commit -m "$(cat <<'EOF'
test(partitioned): oversize chunk coverage earns PASS; docs and fixtures

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Verification & Definition of Done

**Per-part gate (run after Task 10 for Part 1, after Task 18 for Part 2):**

```bash
node --test test/project-review.test.js test/workflow-fileset-lifecycle.test.js test/cli-partitioned-review.test.js test/shared-assets.test.js
npm run syntaxcheck
npm test
```

- **Part 1 done when:** over-cap partitioned in a content-only fix runs `aggregate FAIL → triage → begin-fix → fix → end-fix increment → bounded re-review of affected units + all backstops → re-aggregate → earned PASS`; add/remove members, over-budget, oversize-flip, and refs-topology drift all `block + reset`; scoped CODE increment reuses the manifest `normalizedScopes` (never whole-root); read-only/advisory/Gemini/stale still never PASS; ②′ guard + docs reverted with fixtures byte-for-byte; full suite green.
- **Part 2 done when:** an over-cap project with a splittable oversize text file reaches earned PASS via chunk coverage; every generated chunk's context slice ≤ budget (line+byte); a single high chunk keeps the file a blocker; unsplittable/binary files keep the legacy high blocker; `inventoryRows` stay file-level (one row per source path); chunk schema is backward compatible (non-chunk `units.json` unbroken); finding dedup needs no new reviewer field; full suite green.

**Rollback:** all additive behind `partitioned + active-plan` / `oversize_chunk`. Part 1 revert = back to ②′ read-only; Part 2 revert = back to oversize-as-single-blocker; independent. No data migration (sha256 namespace unchanged).

**Release follow-through:** after each part's gate is green, run `/check`, then finish the branch via `superpowers:finishing-a-development-branch` (merge to `main` / delete branch) — Part 1 may merge before Part 2 exists.

---

## Self-Review (run against the blueprint, fixed inline)

- **Spec coverage:** Blueprint Part 1 steps 1–6 → Tasks 1–9; Part 1 DoD/test-matrix → Task 10. Blueprint Part 2 P2.2–P2.4 → Tasks 11–17; P2 DoD/test-matrix → Task 18. G.1 edge cases (illegal `currentPhase:'unit-review'`, scoped-not-whole-root, refs-changed, finalize partitioned-vs-non-partitioned, chunk byte budget, inventoryRows file-level, single-huge-line fallback) are each pinned to a task's tests.
- **Type/name consistency:** `refreshPartitionPlanContent(oldPlan, newInventory, { nextSuggestedRefsByUnit, projectReviewFingerprint }) → { refreshedPlan, refsChangedUnitIds }` used identically in Tasks 1, 3, 17. `applyPartitionedIncrement({ metadata, declaredFiles, fixReport, ledger, options, oldPlan })` consistent in Tasks 3, 4. `invalidateUnitReviews`/`invalidateAllBackstopReviews` consistent in Tasks 2, 3. `computeOversizeChunks`/`splitOversizeFile` chunk schema (`primaryLineRange`/`contextLineRange`/`sourceContentId`/`member_digest`) consistent in Tasks 11–15, 17.
- **Known soft spots flagged for the implementer (not placeholders — real verification points):** (a) confirm `writeNormalizedFixReport`/`updateFixedIssues`/`formatLedger`/`describeCodeBlock` export paths before Task 3 (copy `file-set-fix.js`'s import lines); (b) confirm the manifest filename used by `parseManifestV2` callers in the test files (Task 3 setup); (c) `formatUnitId` is private to `project-review.js` — export it or inline the pad (Task 13); (d) Task 14 is the one genuinely new mechanism (chunk metadata in persistent context, slice text only in reviewer handoff memory) — keep the non-slice path byte-identical or the `code-route … byte-for-byte` snapshot test fails.
