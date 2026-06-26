# SPEC subagent review (v1)

Artifact under review: `06-spec.md` (r2p stage `spec`, v1).
References: `00-raw-requirement.md` (R1–R11 + 11 gates), `03-requirement-brief.md` (SCOPE-IN/OUT),
`04-risk-discovery.md` (RISK-*), `05-design.md` (DES-*, v2 — approved).
Prior reviews: `design-subagent-review-v1.md`, `design-subagent-review-v2.md` (raised N-01/N-02/N-03 as
SPEC/PLAN carry-forwards).
Re-review trigger: forced (tier modifiers cross_project, dependency, migration, safety, scope_expanding).

## Verdict

**PASS-WITH-NITS.** The checkpoint can be approved.

The SPEC faithfully encodes R1–R11 as observable contracts; every one of the 11 verification gates has a
concrete Test Matrix row with scenario + expected; the API/Data contracts (blocked/checkpoint shapes,
context payload, repair-plan schema, receipt schema, `R2P_JSON` parse contract, manifest fields) are
concrete enough to implement and test; and the safety surface (workId regex + `..` rejection +
single-segment + realpath direct-child containment; argv/`shell:false`; scoped retirement) carries the
design's defenses forward intact. **All three deferred design nits (N-01, N-02, N-03) landed.** No
BLOCKER, no MAJOR, and no genuine undecided point remains. The residue is a few MINOR/NIT
test-coverage and precision items — most importantly, two specified safety behaviors (receipt redaction
for RISK-DATA-001, and the pre-execution drift guard for RISK-DRIFT-001) have no explicit Test Matrix
scenario. They are additive and fully actionable at PLAN/test time; they do not block SPEC approval.

## Spec compliance (R1–R11 + 11 gates)

Requirement contracts:

| Req | SPEC contract | Observable? | Verdict |
|---|---|---|---|
| R1 invocation grammar + value shape | SPEC-INPUT-001 (+ API workId value contract) | yes — accept/reject tables, exact `invalid-r2p-invocation` payload | COVERED |
| R2 fail-closed preflight (ordered) | SPEC-PREFLIGHT-001 | yes — 6 ordered steps, blockingReason per step | COVERED (exact `nextAction` strings unpinned — F-S3) |
| R3 read-only evidence (both test directions) | SPEC-LIFECYCLE-001 + SPEC-RESOLVE-001; Gate 5 | yes | COVERED |
| R4 status→repair mode (4 outcomes) | SPEC-STATUS-001 | yes — exact tokens | COVERED |
| R5 finding→owner stage | SPEC-STATUS-001 | partial — references the requirement's table, not reproduced (F-S5) | COVERED |
| R6 repair-plan schema/validation/aggregation | SPEC-PLAN-001 + API repair-plan schema | yes | COVERED |
| R7 execution (allowlists, argv+`shell:false`+`R2P_JSON`+`--confirm`, drift guard, redacted receipt) | SPEC-EXEC-001 + API receipt/parse contracts | yes — but redaction & drift lack test rows (F-S1, F-S2) | COVERED |
| R8 lifecycle, key identity, resume/reset/no-state | SPEC-LIFECYCLE-001 + SPEC-RESOLVE-001 + SPEC-PASS-001 | yes | COVERED |
| R9 PASS semantics (checkpoint-after-repair, linkage, Gemini) | SPEC-PASS-001 | yes — exact checkpoint strings | COVERED |
| R10 change surface | SPEC-DOCS-001 (+ all contracts) | yes | COVERED |
| R11 no backward compat / migration language | SPEC-DOCS-001 + Non-goals | yes | COVERED |

11 verification gates (Test Matrix rows, lines 170-182):

| Gate | Row present | Concrete scenario + expected | Verdict |
|---|---|---|---|
| 1 Invocation | yes (line 172) | accept workId/bare; reject target/path/tokens/dup **and** `archive/WF-x`,`../x`,`--from=x` → `invalid-r2p-invocation` | STRONG (exercises the F-01 attack vectors) |
| 2 Command-env | yes (173) | missing command → `r2p-command-unavailable`; no-`R2P_JSON` → `r2p-json-contract-unavailable` | COVERED |
| 3 Workspace | yes (174) | missing/symlinked `.req-to-plan`, missing-active, archive-only, conflict, real-active | COVERED |
| 4 Artifact | yes (175) | missing/symlinked `run.md`/`03-07` → `r2p-artifact-missing-or-unsafe` | COVERED |
| 5 No-direct-write | yes (176) | drfx change FAILS; r2p-authored change NOT a failure (both directions) | COVERED |
| 6 Repair-exec | yes (177) | fake binaries; reopen→`new_work_id`; gap-open `--confirm`→`route_id`; argv+`shell:false`; checkpoint; no PASS; `nextAction` | COVERED (no redaction/drift assertion — F-S1/F-S2) |
| 7 Rerun-PASS | yes (178) | clean rerun PASS; same-round repair cannot PASS | COVERED |
| 8 Status-contract | yes (179) | multi-owner `R2P_JSON` parses deterministically; missing contract blocks | COVERED |
| 9 Current-stage | yes (180) | owner==current_stage → neither verb; `r2p-current-stage-repair-required` | COVERED |
| 10 Aggregation | yes (181) | multi-stage → one command at earliest stage with all `issue_ids`; unmappable → `r2p-repair-plan-ambiguous` | COVERED |
| 11 Documentation | yes (182) | scan SKILL/fragments/coordinator/fixer + module-boundary test; no legacy/migration; no dangling import | COVERED |

All 11 gates have a row; the matrix is complete against the named gates. Non-goals (lines 186-195) cover
SCOPE-OUT-001..011. PLAN Handoff (lines 199-213) maps every SPEC id and the phase split.

## Carry-forward of design nits

### N-01 / F-03 — full retirement of `file-set-r2p-gate.js`: **LANDED**
SPEC-DOCS-001 lines 130-135 now state: "Retire `lib/workflow/file-set-r2p-gate.js` entirely. Remove EVERY
import and use of its six exported symbols — `snapshotForceIncludeDirs`, `resolveR2pLiveFileSet`,
`revalidateR2pGate`, `beginGateBlockArgs`, `endGateBlockArgs`, `RESTORE_BEFORE_CONTINUE` — across
`lib/workflow/file-set-fix.js` and `lib/workflow/file-set-finalize.js` (the import block and all call
sites in both files, including the final-PASS `revalidateR2pGate`), leaving no dangling import; update
`test/workflow-module-boundaries.test.js` to drop the retired module entry." This enumerates all six
symbols (matching the actual `module.exports` and the `file-set-fix.js:60-67` import block I verified on
disk in the v2 review), both consumer files, and the boundary test. The v2 undercount ("all five r2p call
sites") is fully corrected. Test Matrix Gate 11 also asserts "no dangling `file-set-r2p-gate` import."

### N-02 — migrate the other r2p-branch consumers of `resolveR2pTarget`/`buildR2pIdentity`: **LANDED**
SPEC-RESOLVE-001 line 60-61: "The path-based `resolveR2pTarget` and `buildR2pIdentity` are removed; all
r2p-branch consumers migrate to the workId resolver (see SPEC-DOCS-001)." SPEC-DOCS-001 lines 136-137:
"Migrate the other r2p-branch consumers of `resolveR2pTarget`/`buildR2pIdentity` (e.g.
`lib/workflow/file-set-context.js`, `lib/workflow/start.js`, and any other caller) to the workId model."
The named files match the dependency graph; the catch-all "and any other caller" covers the remaining
consumer (`file-set-no-state.js`, also a `resolveR2pTarget` caller). See F-S6 (NIT) for an explicit-naming
suggestion.

### N-03 — workId regex vs `..` prose reconciliation: **LANDED**
SPEC-INPUT-001 line 17: "The `workId` value MUST match `^WF-[A-Za-z0-9._-]+$` AND MUST NOT contain the
substring `..`." API/Data contract lines 144-145: "regex `^WF-[A-Za-z0-9._-]+$`, additionally rejecting
any value containing `..`; single path segment; length-bounded; NUL-free." Both the contract and the
API/Data section state the regex AND the explicit `..` rejection, so the v2 prose-vs-regex mismatch (the
class character `.` permitting a literal `..`) is now closed by an explicit substring rule. Gate 1 also
exercises `workId=../x`.

## Findings (severity-ranked)

### F-S1 — receipt redaction (RISK-DATA-001) has no Test Matrix scenario
- **Severity: MINOR** (specified safety behavior without test coverage)
- **Location:** SPEC-EXEC-001 lines 106-109 + Receipt schema (lines 154-155); Test Matrix Gate 6 (line 177).
- **Evidence:** SPEC-EXEC-001 mandates the receipt "never records raw prompts, transcripts, secrets, or
  large artifact bodies," and the receipt schema marks `argv:[redacted]`, `stdout/stderr:<redacted>`. But
  Gate 6 only asserts capture of `new_work_id`/`route_id`, argv+`shell:false`, checkpoint, no-PASS, and
  `nextAction` — nothing exercises redaction. A safety behavior with no test can silently regress.
- **Recommendation:** Add a scenario (extend Gate 6 or add a row): a fake `r2p-reopen`/`r2p-gap-open` whose
  `reason`/`required-action` carries a secret-like token and whose stdout contains a secret-like string →
  the persisted receipt contains neither the raw reason nor the secret (only the reduced single-line
  redacted argv and redacted stdout/stderr).

### F-S2 — pre-execution drift guard (RISK-DRIFT-001) has no Test Matrix scenario
- **Severity: MINOR** (specified safety behavior without test coverage)
- **Location:** SPEC-EXEC-001 lines 102-105; Test Matrix (no drift row).
- **Evidence:** SPEC-EXEC-001 specifies an always-on drift guard that blocks instead of executing when any
  of {commands no longer resolve, active run gone, archive run appeared, `run.md`+`03-07` fingerprint
  drift, live `R2P_JSON` status no longer matches the plan's `command_kind`} occurs between review/triage
  and execution. No Test Matrix row exercises the block path, so the guard's "block instead of execute"
  outcome is untested.
- **Recommendation:** Add a scenario: mutate `run.md` (or flip the live `R2P_JSON` status) between
  `record-r2p-repair-plan` and `apply-r2p-repair` → the route blocks (e.g. `unexpected-worktree-change` /
  the drift-class blockingReason) and does NOT invoke any r2p command.

### F-S3 — exact `nextAction` strings for preflight blocks are not pinned
- **Severity: MINOR** (testability; inherited from R2)
- **Location:** SPEC-PREFLIGHT-001 lines 32-46; Blocked-result shape (line 147).
- **Evidence:** Each preflight step names its `blockingReason` token but not its `nextAction` text; the
  blocked-result shape only declares `nextAction:<string>`. R2 in the requirement spelled out the
  `nextAction` for `r2p-command-unavailable` and `invalid-project-root` but deferred the rest ("exact
  nextAction strings per the plan"). As written, Gates 2/3/4 can assert only the `blockingReason`, not the
  full observable `nextAction`. Since the design's SPEC handoff explicitly asked SPEC to pin "the exact
  `blockingReason`/`nextAction` strings," this is a gap the SPEC should close (or PLAN must).
- **Recommendation:** Tabulate the exact `nextAction` string for each preflight `blockingReason`
  (`r2p-command-unavailable`, `r2p-json-contract-unavailable`, `invalid-project-root`,
  `r2p-workspace-not-found`, `unsafe-r2p-workspace`, `r2p-run-archived`, `r2p-work-id-conflict`,
  `r2p-run-not-found`, `unsafe-r2p-run-dir`, `r2p-artifact-missing-or-unsafe`) so each is an observable,
  testable contract.

### F-S4 — `R2P_JSON` probe predicate may not match the `r2p-status --all` shape
- **Severity: NIT** (precision)
- **Location:** SPEC-PREFLIGHT-001 lines 34-36 (probe) vs SPEC-STATUS-001 line 77 (`r2p-status --all`) and
  API parse contract lines 156-158.
- **Evidence:** The probe requires the output to "parse as JSON and contain at least `status` and
  `current_stage`," but the read-only status path is `r2p-status --all`, whose `R2P_JSON` payload is most
  plausibly a list of run entries (each carrying `status`/`current_stage`), not a top-level object with
  those keys. As phrased, the predicate is shape-ambiguous against an array.
- **Recommendation:** Clarify the probe predicate to match the actual `--all` shape (e.g. "parses as JSON
  and, for at least one run entry, exposes `status` and `current_stage`"), or specify a distinct read-only
  invocation for the probe. Pin it against the verified v0.7.3 `--all` payload.

### F-S5 — finding-type → ownerStage table is referenced, not reproduced
- **Severity: NIT** (self-containment)
- **Location:** SPEC-STATUS-001 lines 81-82.
- **Evidence:** "Each finding maps to an `ownerStage` … via the requirement's finding-type table." The
  six-row mapping (R5) is not reproduced in the SPEC, so the observable mapping requires reading R5. The
  design did the same, so this is consistent, but a self-contained SPEC contract would inline the table.
- **Recommendation:** Inline the six-row finding-type→ownerStage table into SPEC-STATUS-001 so the mapping
  is directly testable from the SPEC.

### F-S6 — N-02 catch-all could name `file-set-no-state.js` explicitly
- **Severity: NIT** (enumeration completeness)
- **Location:** SPEC-DOCS-001 lines 136-137.
- **Evidence:** `resolveR2pTarget` is also consumed by `lib/workflow/file-set-no-state.js` (a caller in the
  dependency graph). It is covered by "and any other caller," but naming it removes ambiguity for PLAN.
- **Recommendation:** Add `file-set-no-state.js` to the named consumer list.

Dimensions re-confirmed SOUND (no finding):
- **Injection/traversal:** workId `^WF-[A-Za-z0-9._-]+$` + `..` rejection + single segment + realpath
  direct-child containment (SPEC-PREFLIGHT-001 step 4) + WF-prefix defeating argv flag-injection; reason/
  required-action single-line/NUL-free/no-embedded-shell; `shell:false`; two-verb mutating allowlist. No
  gap re-introduced.
- **Migration safety:** retirement is now fully enumerated (F-03 closed); manifest replaces only the
  r2p-only field set, `manifestV2FieldsForKind` stays valid for the six non-r2p kinds (SPEC-DOCS-001
  lines 138-140; API lines 159-160).
- **External Documentation Checked (lines 164-166):** accurate relative to the requirement's grounding
  facts — req-2-plan v0.7.3, `R2P_JSON`/`is_json_mode`, reopen/gap-open/status signatures, `STAGE_ORDER`,
  `--confirm` accepted-but-inert, binaries at `~/.req-to-plan/bin` not on PATH. NOTE: the underlying r2p
  source (`~/x-skills/req-to-plan`) is outside this repo and was not re-verified here; it remains
  spec-asserted/UNCONFIRMED, as in the design reviews. The SPEC does not contradict it.

## Unresolved-ambiguity check

No contract defers a decision that belongs at SPEC altitude, and "Decision Requests: none" upstream
remains justified. The candidate hot-spots are all pinned: the workId value contract is concrete (regex +
`..` + single-segment + length/NUL), the key derivation is concrete (`deriveR2pTargetKey` domain-separated
SHA-256), the repair-plan and receipt schemas are explicit field lists, the `R2P_JSON` parse contract is
spelled out, and the manifest field set is named. The only genuine imprecisions are F-S3 (exact
`nextAction` strings unpinned — partly inherited from R2) and F-S4 (probe predicate vs `--all` shape);
neither is an open product/technical *decision*, just text to tighten. The two MINOR test-coverage gaps
(F-S1 redaction, F-S2 drift guard) are missing scenarios for already-specified behaviors, not ambiguity.
Nothing blocks checkpoint approval.
