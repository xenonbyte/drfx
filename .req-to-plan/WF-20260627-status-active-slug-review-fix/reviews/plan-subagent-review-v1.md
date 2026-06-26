# PLAN subagent review (v1)

Artifact under review: `07-plan.md` (r2p stage `plan`, v1).
References: `00-raw-requirement.md` (R1–R11 + 11 gates), `03-requirement-brief.md` (SCOPE-IN),
`06-spec.md` (SPEC-* + Test Matrix), `05-design.md` (DES-*).
Prior reviews: design v1/v2 + spec v1 (raised N-01/N-02/F-S1/F-S2 carry-forwards).
Re-review trigger: forced (cross_project, dependency, migration, safety, scope_expanding). Executability weighted heavily.
Code facts verified on disk at `/Users/xubo/x-studio/document-review-fix`.

## Verdict

**CHANGES-REQUESTED.** One MAJOR executability defect blocks a clean execution and should be fixed
before the PLAN closes; everything else is sound.

The good news, and the coordinator's headline question, first: the `file-set-r2p-gate.js` **retirement is
safe** — TASK-008's file list is a *superset* of the real importers, and delete (009) is ordered after
scrub (008), so no dangling `file-set-r2p-gate` import can remain. File-refs/change-types are all correct,
and coverage (9 SPEC contracts, 11 SCOPE-IN, 11 gates incl. F-S1 redaction + F-S2 drift) is complete.

The blocker is the **inverse** problem: TASK-008 *over*-lists five files (`file-set-context.js`,
`file-set-no-state.js`, `start.js`, `helpers.js`, `target-context.js`) as "file-set-r2p-gate consumers"
— but those files do **not** import `file-set-r2p-gate`. They import `resolveR2pTarget` /
`buildR2pIdentity` / `compareR2pIdentity`, which TASK-003 *removes*. The actual N-02 migration work
(rewire those callers to the workId model) is present in TASK-008's file list but **absent from any task's
steps**, and TASK-003 deletes the definitions before any task migrates the callers. As written, an
executor following the steps literally leaves dangling references to deleted functions and a broken build,
with no in-plan remedy. The SPEC mandated this migration (SPEC-DOCS-001); the PLAN failed to translate it
into actionable steps.

## File-ref & Change-Type verification

All 17 spot-checked targets are correct (verified on disk):

| Task | Path | Change Type | On disk | Verdict |
|---|---|---|---|---|
| 001 | lib/input.js | modify | exists | OK |
| 002 | lib/routes.js | modify | exists | OK |
| 003 | lib/workflow/target-resolution.js, lib/target-context.js, lib/target-state.js | modify | all exist | OK (but Files omit the resolveR2pTarget/buildR2pIdentity callers — see F-P1) |
| 004 | lib/workflow/r2p-repair.js | create | ABSENT | OK (correct for create) |
| 005 | lib/workflow/index.js, lib/workflow/file-set-fix.js | modify | both exist | OK |
| 006 | lib/workflow/file-set-finalize.js | modify | exists | OK |
| 007 | lib/workflow-state.js | modify | exists | OK |
| 008 | file-set-fix.js, file-set-finalize.js, file-set-context.js, file-set-no-state.js, start.js, helpers.js, target-context.js, test/workflow-module-boundaries.test.js | modify | all exist | paths real, but 5 are MISLABELED (see F-P1) |
| 009 | lib/workflow/file-set-r2p-gate.js | delete | exists | OK (delete target present; ordered after 008) |
| 010 | SKILL.md + 8 r2p fragments + coordinator.md + fixer.md | modify (non_code) | all 11 exist | OK |
| 011 | test/r2p-route.test.js | create | ABSENT | OK (correct for create) |
| 012 | test/r2p-docs.test.js | create | ABSENT | OK (correct for create) |

No wrong Change Type and no non-existent path. The three `create` targets are correctly absent; the
`delete` target correctly exists.

## Retirement completeness (importer sweep)

Direct answer to the N-01 question. My sweep:
```
grep -rln "file-set-r2p-gate" lib/ test/
 → lib/workflow/file-set-fix.js
 → lib/workflow/file-set-finalize.js
 → test/workflow-module-boundaries.test.js
```
The **complete** importer set is exactly these three. TASK-008's Files list contains all three
(`file-set-fix.js` ✓, `file-set-finalize.js` ✓, `test/workflow-module-boundaries.test.js` ✓), so **no
importer is missing** and **no dangling `file-set-r2p-gate` import will remain** after TASK-009 deletes
the module. Ordering is correct: TASK-008 (scrub) precedes TASK-009 (delete), and TASK-009's step says
"Delete the file after PLAN-TASK-008 has removed every importer." **N-01 retirement safety: SATISFIED.**

However, the *other five* files in TASK-008 (`file-set-context.js`, `file-set-no-state.js`, `start.js`,
`helpers.js`, `target-context.js`) are **not** `file-set-r2p-gate` importers — they are consumers of the
soon-removed `resolveR2pTarget` / `buildR2pIdentity` (and `compareR2pIdentity`). See F-P1.

## Coverage (SPEC / SCOPE-IN / 11 gates)

- **SPEC contracts (9/9 consumed):** INPUT→001,011; PREFLIGHT→003,004,011; RESOLVE→003,007,011;
  LIFECYCLE→002,005,011; STATUS→004,011; PLAN→004,011; EXEC→004,011; PASS→006,011; DOCS→007,008,009,010,012.
- **SCOPE-IN (11/11 carried):** 001→001,011; 002→001; 003→003,004; 004→003; 005→002,005; 006→004;
  007→004; 008→004; 009→004,011; 010→006; 011→007,008,009,010,012.
- **11 gates (all tested):** gates 1–10 → TASK-011 test cases `gate1..gate10`; **F-S1 receipt redaction →
  TASK-011 line 324** (`F-S1 receipt redaction omits raw reason/secrets`); **F-S2 drift-guard block →
  TASK-011 line 325** (`F-S2 drift guard blocks instead of executing`); gate 11 + no-dangling-import →
  TASK-012. The two deferred SPEC test gaps both LANDED as concrete test cases.

Coverage is complete. No SPEC id, SCOPE-IN id, or gate is unimplemented or untested.

## Findings (severity-ranked)

### F-P1 — N-02 caller migration is mis-specified; TASK-003 removes `resolveR2pTarget`/`buildR2pIdentity` before any task rewires the callers (broken build, no in-plan remedy)
- **Severity: MAJOR** (executability/completeness — blocks clean execution)
- **Location:** PLAN-TASK-003 (Files lines 77-80, step 3 line 106) and PLAN-TASK-008 (Files lines 232-240, steps 249-251).
- **Evidence (on disk):** `resolveR2pTarget` is called by `start.js:163`, `file-set-no-state.js:106,566`,
  `file-set-context.js:339`, `file-set-finalize.js:105`, and re-exported by `helpers.js:46/2386`;
  `buildR2pIdentity` is called by `start.js:168`, `file-set-context.js:438`, `file-set-finalize.js:112`,
  and re-exported by `helpers.js:52/2378`. There is also `compareR2pIdentity` (re-exported `helpers.js`,
  used in the finalize identity path) tied to the same old identity model.
  - TASK-003 step 3 removes `resolveR2pTarget` and `buildR2pIdentity` (definitions in `target-context.js`),
    but TASK-003's Files are only `target-resolution.js`/`target-context.js`/`target-state.js` — it does
    **not** list or rewire the five caller files, and its verification runs only `test/r2p-route.test.js`,
    so it cannot detect the breakage it introduces elsewhere.
  - TASK-008 lists the caller files, but its title, skeleton, and steps describe removing
    `file-set-r2p-gate`'s **six symbols** (`snapshotForceIncludeDirs`, `resolveR2pLiveFileSet`,
    `revalidateR2pGate`, `beginGateBlockArgs`, `endGateBlockArgs`, `RESTORE_BEFORE_CONTINUE`). Grepping
    those symbols in `file-set-context.js`/`file-set-no-state.js`/`start.js`/`helpers.js`/`target-context.js`
    returns nothing, so an executor following step 1 literally removes **nothing** from them and the
    `resolveR2pTarget`/`buildR2pIdentity` calls remain → dangling references to deleted functions →
    `npm test` (the TASK-008 verification) fails, with no task specifying the actual migration.
  - `compareR2pIdentity` and the `helpers.js` barrel re-exports are not mentioned by any task at all.
  - The disposition is also undecided: whether the r2p branches in `file-set-context.js`/`file-set-no-state.js`/
    `file-set-finalize.js` are **migrated** to `resolveR2pWorkIdTarget` or **removed** (r2p context/finalize
    handled by the new lifecycle) is not stated. TASK-005 puts `context` in `index.js`/`file-set-fix.js`
    (not `file-set-context.js`), which suggests removal, but no task says so.
- **Why it matters:** This is the same dangling-reference failure class the N-01/N-02 thread was created to
  prevent, just shifted from `file-set-r2p-gate` to the `resolveR2pTarget`/`buildR2pIdentity` family. The
  SPEC (SPEC-DOCS-001 lines 504-505 + SPEC-RESOLVE-001 line 60) mandated the migration; the PLAN lists the
  files but gives the wrong instructions, so the work is effectively unspecified.
- **Recommendation:** Rewrite the caller-migration as its own step set (in TASK-008 or a dedicated task),
  enumerating each caller and the concrete action: in `start.js`, `file-set-context.js`,
  `file-set-no-state.js`, `file-set-finalize.js` either migrate the r2p branch from `resolveR2pTarget`/
  `buildR2pIdentity` to `resolveR2pWorkIdTarget` **or** remove it (state which); drop the
  `resolveR2pTarget`/`buildR2pIdentity`/`compareR2pIdentity` imports and re-exports from `helpers.js`; and
  decide `compareR2pIdentity`'s fate. Order the definition removal (TASK-003) to run **with or after** the
  caller migration so no intermediate state has dangling references, and broaden the per-task verification
  to `npm test` for the tasks that touch shared modules.

### F-P2 — implementation tasks 001–009 cite a verification test file created only in TASK-011
- **Severity: MINOR** (ordering/consistency)
- **Location:** Verification lines of TASK-001..009 (e.g. lines 43, 70, 107, 145, 172, 199, 225, 252, 269) vs TASK-011 Change Type `create` (line 305).
- **Evidence:** Every impl task's Verification is `node --test test/r2p-route.test.js`, but that file is
  created in TASK-011 (`create`), which runs last. As ordered, the verification command for 001–009 cannot
  run (file absent). Conversely, if the intent is TDD-per-task (each task writes its test slice), then
  TASK-011's `create` is wrong because the file would already exist.
- **Recommendation:** Either front-load the test scaffold (move test-suite creation before/alongside
  TASK-001, with impl tasks adding their slices) or have each TDD task author its own test slice and make
  TASK-011 a `modify`/consolidation. Make the verification commands runnable at the point each task claims them.

### F-P3 — TASK-004 execution skeleton invokes the bare verb, but the r2p binaries are not on PATH
- **Severity: MINOR** (skeleton correctness / could be copied verbatim)
- **Location:** PLAN-TASK-004 skeleton line 135: `execFile(plan.command_kind, argv, …)`.
- **Evidence:** The grounding facts (00-raw-requirement.md + 06-spec.md External Documentation row) state
  the r2p binaries live at `~/.req-to-plan/bin` and are **not on PATH**. `resolveR2pCommands()` resolves
  the path (line 122), but `runRepairCommand` passes the bare `plan.command_kind` ("r2p-reopen"/
  "r2p-gap-open") to `execFile`, which would `ENOENT` when the binary is off-PATH. The skeleton models the
  wrong thing on a known fact.
- **Recommendation:** Pass the resolved absolute command path (from `resolveR2pCommands()`) to `execFile`,
  not the bare verb; have the skeleton reflect it.

### F-P4 — preflight ordering (command-env before FS) is not owned by any task
- **Severity: MINOR** (completeness)
- **Location:** TASK-003 (FS preflight, steps 104-106) vs TASK-004 (`resolveR2pCommands`/`probeJsonContract`, step 142); SPEC-PREFLIGHT-001 "Run in order."
- **Evidence:** SPEC-PREFLIGHT-001 requires the command-environment + `R2P_JSON` probe to run **first**,
  before the FS preflight. The command-env checks live in TASK-004 and the FS checks in TASK-003, but no
  task specifies the end-to-end sequencing (command-env → root → workspace → active/archive → run-dir →
  artifacts) or which orchestration point enforces it. Gate 2/3 test each in isolation but not the ordering.
- **Recommendation:** Assign the ordered preflight composition (command-env first) to a task (likely the
  r2p `context`/`start` path in TASK-005), and add a test that command-env failure fires before any FS check.

### F-P5 — r2p-specific `record-review` / `record-triage` behavior is not in any task step
- **Severity: NIT**
- **Location:** Lifecycle in SPEC-LIFECYCLE-001 (start→context→record-review→record-triage→…); TASK-005 covers `context` + the two new subcommands but not `record-review`/`record-triage`.
- **Evidence:** The design/SPEC require record-review to attach an `ownerStage` to every r2p finding and
  record-triage to route accepted findings into the repair plan (never a file-edit queue). No task step
  names this; it is only implied by TASK-004's `buildRepairPlan(acceptedFindings, …)`.
- **Recommendation:** Add a step (TASK-005) making `record-review`/`record-triage` r2p-aware (ownerStage on
  findings; accepted findings feed the repair plan, not a fix queue).

### F-P6 — minor coordination/consistency notes
- **Severity: NIT**
- `file-set-fix.js` is modified by TASK-005 (block write/diff) and TASK-008 (scrub); `file-set-finalize.js`
  by TASK-006 (finalize) and TASK-008 (scrub) — same files across tasks; call out the coordination so edits
  don't collide. TASK-002 removes `defaultGuard` from the r2p descriptor — confirm no other code requires
  every descriptor to carry `defaultGuard` (the document/pr/code descriptors still have it).

Dimensions confirmed SOUND:
- **workId safety:** TASK-001 skeleton encodes `^WF-[A-Za-z0-9._-]+$` **and** explicit `!value.includes('..')`,
  and TASK-003 adds the realpath single-segment + direct-child containment — the F-01 defense is carried
  into executable steps; Gate 1 (TASK-011) exercises `archive/WF-x`, `../x`, `--from=x`.
- **execution safety:** argv array, `shell:false` (comment), `--confirm` on gap-open, `R2P_JSON=1` env, two-verb
  mutating allowlist (modulo F-P3's path fix).
- **migration safety for other routes:** TASK-007 replaces only `MANIFEST_V2_R2P_FILESET_FIELDS` and the r2p
  branch of `manifestV2FieldsForKind`, explicitly leaving document/pr/code branches untouched, with a
  verification that `npm test` confirms the other field sets unchanged. Sound.
- **scope:** Non-goals (SCOPE-OUT-001..011) intact; no r2q compat, no state migration, no path tokens, no
  auto-run of `r2p-continue/execute/archive`.

## Unresolved-ambiguity check

One genuine unresolved decision, captured in F-P1: **whether the old r2p branches in `file-set-context.js`/
`file-set-no-state.js`/`file-set-finalize.js` are migrated to `resolveR2pWorkIdTarget` or removed** (and
the fate of `compareR2pIdentity`). The PLAN neither decides nor specifies it, while simultaneously removing
the functions those branches call — that is a real "to-be-figured-out-at-execution" gap, not just imprecise
text, and it should be pinned before the PLAN closes. The remaining items (F-P2 test ordering, F-P3 resolved
path, F-P4 preflight composition, F-P5 triage behavior) are under-specification, not open product decisions.
Aside from F-P1, the PLAN does not hedge: the workId rule, manifest rework, retirement, receipt/repair
schemas, and PASS semantics are all concretely specified and testable.
