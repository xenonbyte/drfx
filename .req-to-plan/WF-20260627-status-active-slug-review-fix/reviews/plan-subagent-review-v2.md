# PLAN subagent review (v2)

Artifact under review: `07-plan.md` (r2p stage `plan`, **v2**, `r2p_updated_at: 2026-06-26T18:23`).
References: `00-raw-requirement.md` (R1–R11 + 11 gates), `03-requirement-brief.md` (SCOPE-IN),
`06-spec.md` (SPEC-* + Test Matrix), `05-design.md` (DES-*).
Prior review: `plan-subagent-review-v1.md` (CHANGES-REQUESTED — F-P1 MAJOR, F-P2/F-P3/F-P4 MINOR).
Re-review trigger: forced (cross_project, dependency, migration, safety, scope_expanding). Last gate before close.
Ground truth re-established on disk via grep/Read.

## Verdict

**PASS.** The PLAN is clean enough to approve and close the run.

All four v1 findings are RESOLVED with correct, on-disk-verified fixes. The F-P1 caller-migration defect —
the one true blocker — is fully fixed by a restructure: TASK-005 now only ADDS the new resolver, a new
TASK-010 explicitly migrates every legacy caller to the workId model and THEN deletes the old definitions
(ordered after TASK-005), and TASK-011 scrubs only the three real `file-set-r2p-gate` importers. The
migrate-vs-remove decision is now stated explicitly (migrate). The regression scan found no new
dangling-reference, wrong-Change-Type, or coverage problem introduced by the restructure. Completeness
held: 9/9 SPEC consumed, 11/11 SCOPE-IN carried, all 11 gates covered. No BLOCKER, no MAJOR, no open
decision remains.

## Resolution of v1 findings

### F-P1 (MAJOR) — caller-migration defect: **RESOLVED**

I re-ran the authoritative sweep on disk:
```
grep -rln "resolveR2pTarget|buildR2pIdentity|compareR2pIdentity" lib/
 → lib/target-context.js          (definitions)
 → lib/workflow/start.js
 → lib/workflow/file-set-no-state.js
 → lib/workflow/file-set-context.js
 → lib/workflow/file-set-finalize.js
 → lib/workflow/helpers.js
 → lib/workflow/file-set-r2p-gate.js   (deleted by TASK-012)
```
The non-definition, non-deleted callers are exactly **start.js, file-set-no-state.js, file-set-context.js,
file-set-finalize.js, helpers.js** — and the definitions live in **target-context.js**.

Checking each part of the fix:
- **(a) TASK-010 Files match the actual callers — CONFIRMED.** TASK-010 Files (lines 279-284):
  `start.js`, `file-set-context.js`, `file-set-no-state.js`, `file-set-finalize.js`, `helpers.js`,
  `target-context.js`. That is precisely the caller set above (callers + the definition file), with no
  miss and no spurious entry. `file-set-r2p-gate.js` is correctly absent (it is deleted by TASK-012, not
  migrated).
- **(b) migrate-vs-remove decision is explicit — CONFIRMED.** TASK-010 skeleton line 287: "Decision: every
  r2p branch is MIGRATED to the workId model (r2p is still a supported, read-only route), not removed,"
  with per-file actions (lines 289-292): `resolveR2pTarget(...) -> resolveR2pWorkIdTarget({ projectRoot,
  workId })` for start/context/no-state; `buildR2pIdentity`/`compareR2pIdentity` freshness → compare the
  new manifest `workId` + `reviewSetFingerprint` in finalize; `helpers.js` re-export swap;
  `target-context.js` delete the old defs.
- **(c) ordering is safe — CONFIRMED.** TASK-005 step 2 (line 159): "do NOT remove the legacy
  `resolveR2pTarget`/`buildR2pIdentity` yet (their callers are migrated in PLAN-TASK-010)." TASK-010 step 3
  (line 297): "Delete the path-based ... in `lib/target-context.js`; this task runs AFTER PLAN-TASK-005
  added the replacements." Add (005) → migrate-then-delete (010): no intermediate state has a dangling
  reference, and TASK-010's verification (line 298) is `grep ... returns no matches` **and** `npm test`
  passes — an objective whole-suite gate that would catch any straggler.
- **(d) TASK-011 scrubs only the three real importers — CONFIRMED.** My sweep:
  `grep -rln "file-set-r2p-gate" lib/ test/` → `file-set-fix.js`, `file-set-finalize.js`,
  `test/workflow-module-boundaries.test.js`. TASK-011 Files (lines 306-308) are exactly those three; the
  five caller files are no longer over-listed there. TASK-011 skeleton (line 311) even states "The only
  three importers ... are file-set-fix.js, file-set-finalize.js, and the module-boundary test."
- **Bonus — `compareR2pIdentity` is now addressed** (it was unmentioned in v1): TASK-010 skeleton line 290
  and step 2 fold it into the finalize freshness migration, and step 3 deletes it "if now unused." The full
  legacy-identity family is covered.

### F-P2 (MINOR) — test-first ordering: **RESOLVED**
The two test tasks are now **PLAN-TASK-001** (`test/r2p-route.test.js`, create) and **PLAN-TASK-002**
(`test/r2p-docs.test.js`, create), both ahead of every impl task. Their verifications (lines 42, 69)
explicitly say "red before PLAN-TASK-003..013 land, green after," i.e. test-first. Impl tasks now verify
with scoped patterns against the already-created files — e.g. TASK-003 `node --test
--test-name-pattern='gate1' test/r2p-route.test.js` (line 99), TASK-006
`--test-name-pattern='gate6|gate8|gate10|drift|redaction'` (line 194). **No impl task references a test
file before it exists** (every impl task is id ≥ 003, both test files created at 001/002). Confirmed.

### F-P3 (MINOR) — resolved absolute path in execution skeleton: **RESOLVED**
TASK-006 skeleton now resolves the path: `resolveR2pCommands()` "returns {name->absPath}" (line 174), and
`runRepairCommand(paths, plan)` does `const bin = paths[plan.command_kind]; // resolved absolute path, not
the bare verb (binaries are not on PATH)` then `execFile(bin, argv, …) // shell:false` (lines 180-185).
Step 1 (line 191) reiterates "command resolution (returning absolute paths because the binaries are not on
PATH)." The bare-verb bug is gone. Confirmed.

### F-P4 (MINOR) — preflight ordering owned by a task: **RESOLVED**
TASK-007 is retitled "r2p lifecycle subcommands, write-lifecycle prohibition, **preflight ordering**"
(line 196). Skeleton line 212: "preflight order for r2p: r2p-repair command-env + R2P_JSON probe FIRST,
then resolveR2pWorkIdTarget FS checks." Step 3 (line 220): "Wire the r2p preflight so the r2p-repair
command-environment + `R2P_JSON` probe run before the resolver FS checks." Verification (line 221) asserts
"command-env preflight precedes FS checks" via `gate2`. Confirmed.

## Regression scan

I checked every concern the restructure could introduce.

- **Multi-task files all `modify`, all exist:** `file-set-finalize.js` is touched by TASK-008 (finalize/PASS),
  TASK-010 (identity migration), TASK-011 (gate scrub) — all Change Type `modify`, file exists; the three
  concerns are disjoint (finalize logic vs identity-freshness migration vs file-set-r2p-gate import removal)
  and ordered 008→010→011, so they compose. `target-context.js` is in TASK-005 (add new fns) and TASK-010
  (delete old fns) — coherent and correctly ordered (add before delete). `file-set-fix.js` in TASK-007
  (block write/diff) and TASK-011 (gate scrub) — disjoint, modify, exists. No conflict.
- **Change-Type accuracy (re-verified on disk):** all `modify`/`delete` targets exist; the three `create`
  targets (`test/r2p-route.test.js`, `test/r2p-docs.test.js`, `lib/workflow/r2p-repair.js`) are absent.
  Correct.
- **No new dangling reference:** the only symbols removed are `resolveR2pTarget`/`buildR2pIdentity`/
  `compareR2pIdentity` (TASK-010, after all callers migrated) and the six `file-set-r2p-gate` exports
  (TASK-011, only the three importers; TASK-012 deletes the module after). Both removals are gated by
  `grep returns no matches` + `npm test`. No symbol is removed before its consumers are rewired.
- **Retirement ordering intact:** scrub (TASK-011) → delete (TASK-012); TASK-012 verification is
  `test -e ... false` + docs test + `npm test`. The gate-11 boundary test (TASK-002) and TASK-012 both
  assert no surviving importer.
- **Completeness held:**
  - **SPEC 9/9 consumed:** INPUT→003,001; PREFLIGHT→005,006,007?,001 (005 FS + 006 cmd-env/probe + 007
    ordering); RESOLVE→005,009,010,001; LIFECYCLE→004,007,001; STATUS→006,001; PLAN→006,001; EXEC→006,001;
    PASS→008,001; DOCS→009,010,011,012,013,002. Every SPEC id appears in at least one task's Spec References.
  - **SCOPE-IN 11/11 carried:** 001→001,003; 002→003; 003→005,006; 004→005,010; 005→004,007; 006→006;
    007→006; 008→006; 009→001,006; 010→008; 011→002,009,010,011,012,013.
  - **11 gates all covered:** gates 1–10 authored in TASK-001 and driven green by TASK-003/005/006/007/008;
    receipt-redaction and drift-guard cases are in TASK-001 (lines 36-37) and implemented/verified by
    TASK-006 (`--test-name-pattern='...|drift|redaction'`); gate 11 + no-import in TASK-002, satisfied by
    TASK-011/012/013.
- **Safety carried forward (unchanged, still correct):** workId `^WF-[A-Za-z0-9._-]+$` + `!includes('..')`
  (TASK-003) + realpath single-segment/direct-child containment (TASK-005); argv `shell:false` + resolved
  path + `--confirm` on gap-open (TASK-006); manifest rework touches only the r2p field set, leaving
  document/pr/code branches untouched with an `npm test` cross-check (TASK-009).

No regression found.

## Remaining findings

None at BLOCKER/MAJOR/MINOR. A few non-blocking NITs (all optional polish, none gate the close):

- **N-V2-1 (NIT):** TASK-010's verification `grep -rn "resolveR2pTarget|buildR2pIdentity|compareR2pIdentity"
  lib` returns-no-matches will also flag *comment* mentions of these names (several callers reference them in
  code comments, e.g. `file-set-r2p-gate.js` header and `file-set-no-state.js:562`). Since `file-set-r2p-gate.js`
  is deleted by TASK-012 (which runs after TASK-010), and TASK-010 should also scrub stale comments in the
  migrated files, this is harmless, but the executor should treat lingering comment hits as a signal to clean
  the comment, not as a false failure. A `--line-number` grep over code identifiers would be marginally crisper.
- **N-V2-2 (NIT):** `record-review`/`record-triage` r2p-specific behavior (ownerStage on every finding;
  accepted findings feed the repair plan, not a fix queue) is still only implied (via TASK-006
  `buildRepairPlan(accepted, …)` + TASK-007 dispatch), not called out as a step. Behavior is reachable; an
  explicit step would aid the executor.
- **N-V2-3 (NIT, inherited):** the req-2-plan v0.7.3 facts in "External Documentation Checked" remain
  spec-asserted/UNCONFIRMED — that source (`~/x-skills/req-to-plan`) is outside this repo and was not
  re-verified in any stage. Not a PLAN defect; carry as a known assumption into execution.

These do not block approval.

## Unresolved-ambiguity check

No task defers a real decision. The one v1 open decision (migrate vs remove the legacy r2p branches) is now
explicitly resolved to "migrate" with per-file actions (TASK-010). Ordering, file lists, Change Types,
verifications (objective grep/`npm test`/scoped `--test-name-pattern`), and coverage are all concrete and
internally consistent. The PLAN is executable as written and ready to close.
