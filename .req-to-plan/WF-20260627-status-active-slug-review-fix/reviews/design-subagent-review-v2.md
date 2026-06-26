# DESIGN subagent review (v2)

Artifact under review: `05-design.md` (r2p stage `design`, **v2**, `r2p_updated_at: 2026-06-26T17:53`).
Spec: `00-raw-requirement.md` (R1–R11 + 11 verification gates).
Prior review: `reviews/design-subagent-review-v1.md` (CHANGES-REQUESTED — F-01 BLOCKER, F-02/F-03 MINOR, F-04/F-05 NIT).
Re-review trigger: forced (tier modifiers cross_project, dependency, migration, safety, scope_expanding).
Code facts re-verified against on-disk source at `/Users/xubo/x-studio/document-review-fix`.

## Verdict

**PASS-WITH-NITS.**

The v1 BLOCKER (F-01, workId validation) is fully resolved with a sound two-layer defense, and F-02,
F-04, F-05 are cleanly resolved. **No BLOCKER and no genuine undecided point remains** — "Decision
Requests: none" is now fully justified, so the checkpoint can be approved. One residual MINOR (N-01)
and two NITs (N-02, N-03) remain, all hand-off-precision issues for SPEC/PLAN, not design defects:
F-03's enumeration ("all five r2p call sites") still undercounts the retirement surface of
`file-set-r2p-gate.js`, which—if followed literally—would leave a dangling import (the exact regression
F-03 targeted). The design's *stated goal* in the same sentence ("so no dangling import remains") is
correct, so this is fully actionable downstream without another design round.

## Resolution of v1 findings

| v1 finding | v1 severity | v2 verdict | Evidence in v2 |
|---|---|---|---|
| F-01 workId shape/sanitization (archive-bypass + traversal + flag-injection) | BLOCKER | **RESOLVED** | DES-INPUT-001 lines 127-133 add the value shape rule `^WF-[A-Za-z0-9._-]+$` and explicitly reject `archive/WF-foo`, `../../x`, `--from=...`, stating it "closes path traversal, defeats archive-bypass … and prevents argv flag-injection." DES-PREFLIGHT-001 step 4 lines 148-152 add defense-in-depth: resolution "operates only on a validated single-segment workId," and `activeDir`/`archiveDir` are "realpath-resolved and asserted to be a DIRECT child of `<root>/.req-to-plan` and `<root>/.req-to-plan/archive`." SPEC handoff lines 273-274 carry both. Verified the regex closes all three attacks (see Findings rationale). |
| F-02 resume/reset/no-state behavior unmapped | MINOR | **RESOLVED** | DES-PASS-001 lines 218-221: "`resume` continues the workId's existing target-local state … `reset` archives the existing target-local state and starts a fresh review … a one-shot `read-only` run without `resume`/`reset` stays no-state (review tokens kept in memory only)." SPEC handoff lines 294-295 list "the `resume` (continue state) / `reset` (archive + fresh) / read-only-no-state lifecycle behavior." |
| F-03 retirement omits file-set-finalize.js | MINOR | **PARTIAL** | DES-DOCS-001 lines 228-231 now name `file-set-finalize.js` and call out "the final-PASS `revalidateR2pGate` call and the `file-set-r2p-gate` import in `file-set-finalize.js` … so no dangling import remains." The *goal* is correct, but "all five r2p call sites" counts only the 5 `revalidateR2pGate` calls and misses the rest of the module's consumer surface in `file-set-fix.js` (see N-01). |
| F-04 R3 test contract one-directional in SPEC handoff | NIT | **RESOLVED** | DES-LIFECYCLE-001 SPEC handoff lines 282-285: "Gate 5 must test BOTH directions — a drfx-driven change to `03-07`/`run.md` fails, while a change to those files made by r2p itself (an allowlisted command side effect) is permitted/expected and is not a failure." |
| F-05 R2P_JSON probe predicate under-specified | NIT | **RESOLVED** | DES-PREFLIGHT-001 SPEC handoff lines 275-277: "the payload must parse as JSON and contain a minimal key set — e.g. `status` + `current_stage` — to count as honoring the contract; otherwise `r2p-json-contract-unavailable`." |

F-01 rationale (why RESOLVED): `^WF-[A-Za-z0-9._-]+$` requires a `WF-` prefix and a character class excluding `/` and `\`.
- `archive/WF-foo` → contains `/`, no `WF-` prefix → rejected; cannot reach `.req-to-plan/archive/<run>`. Archive-bypass closed (and the direct-child containment assertion is a second layer).
- `../../x` → contains `/`, no `WF-` prefix → rejected; cannot traverse. Closed.
- `--from=...` → no `WF-` prefix → rejected; the surviving value always starts with `WF-`, so r2p's arg parser cannot mistake it for a flag. Flag-injection closed.

## Current-code-evidence verification (re-check)

The v2 "Current Code Evidence" section (lines 25-65) is **unchanged from v1**; all 11 claims were CONFIRMED
in v1 and remain accurate on disk (input parser, routes descriptor, `deriveTargetKey` path-derivation,
`buildR2pIdentity`, the gate exports + four-checkpoint revalidation, the 12-subcommand set, the manifest
field constant, the coordinator.md old-model passage, `debug` documented-but-unimplemented, the
`execFile`/`shell:false` convention). No regression introduced. Inherited external r2p-CLI grounding
facts (v0.7.3, `R2P_JSON`, `--confirm` inert, `STAGE_ORDER`) remain spec-asserted/UNCONFIRMED (outside
this repo); the design contradicts none.

## Spec compliance (R1–R11 + 11 gates)

All R1–R11 and all 11 verification gates retain design coverage from v1, now strengthened:
- R1 (Gate 1): workId shape rule is now concrete (was the v1 silence) — fully covered.
- R2 / SCOPE-OUT-006 (Gates 1, 3): archive-only invariant is now enforced by both the shape rule and the realpath direct-child containment assertion — fully covered.
- R8 (Gate 7): resume/reset/no-state lifecycle now mapped to DES-PASS-001 + SPEC handoff — fully covered.
- R3 (Gate 5): both test directions now specified — fully covered.
- R2.1 (Gates 2, 8): probe pass/fail predicate now pinned — fully covered.
No requirement or gate is left without coverage. No coverage was removed by the v2 edits.

## Findings (v2)

### N-01 — F-03 residual: "all five r2p call sites" undercounts the `file-set-r2p-gate.js` retirement surface; literal reading leaves a dangling import
- **Severity: MINOR** (hand-off completeness; build-break risk if followed literally — the regression class F-03 targeted)
- **Location:** `05-design.md` DES-DOCS-001 lines 228-231 (and R10 change surface lines 344-366).
- **Evidence:** `file-set-r2p-gate.js` exports **six** symbols, and `file-set-fix.js` destructures all six in one import block and uses them at far more than five sites:
  - import block: `lib/workflow/file-set-fix.js:60-67` (all six symbols).
  - `resolveR2pLiveFileSet` — `:90`.
  - `snapshotForceIncludeDirs` — `:296, :491, :766, :782` (4 sites).
  - `revalidateR2pGate` — `:311, :426, :605, :815` (4 sites here) + `file-set-finalize.js:637` (1) = the "five."
  - `beginGateBlockArgs` — `:313, :428`; `endGateBlockArgs` — `:817`; `RESTORE_BEFORE_CONTINUE` — `:619`.
  - `file-set-finalize.js:56` import + `:637` call (the design names these — good).
  - `test/workflow-module-boundaries.test.js:48` carries a `'file-set-r2p-gate.js': new Set([])` module entry, and the per-module allow-sets reference cross-module deps; deleting the module requires updating this test or it will fail.
  Removing only "the five revalidateR2pGate calls" deletes the module while leaving `snapshotForceIncludeDirs`/`resolveR2pLiveFileSet`/`beginGateBlockArgs`/`endGateBlockArgs`/`RESTORE_BEFORE_CONTINUE` imported in `file-set-fix.js` → dangling import / load-time crash. The design's adjacent goal clause "so no dangling import remains" is correct, but the enumeration contradicts it.
- **Recommendation:** Reword DES-DOCS-001 to "remove the entire `file-set-r2p-gate` import block and every reference to its six exports across `file-set-fix.js` (import :60-67; `resolveR2pLiveFileSet` :90; `snapshotForceIncludeDirs` ×4; `revalidateR2pGate` ×4; `beginGateBlockArgs` ×2; `endGateBlockArgs` ×1; `RESTORE_BEFORE_CONTINUE` ×1) and `file-set-finalize.js` (import :56; `revalidateR2pGate` :637), and update `test/workflow-module-boundaries.test.js`." Keep "so no dangling import remains" as the acceptance condition. This is a SPEC/PLAN enumeration fix; it does not require another design round.

### N-02 — change surface omits other current consumers of the replaced r2p resolver/identity
- **Severity: NIT** (hand-off completeness; R10 is "at least")
- **Location:** `05-design.md` R10 change surface (lines 344-366), DES-RESOLVE-001 (lines 155-163).
- **Evidence:** DES-RESOLVE-001 replaces `resolveR2pTarget` with `resolveR2pWorkIdTarget`, but `resolveR2pTarget` has additional r2p-branch callers not enumerated in the change surface — `lib/workflow/file-set-context.js`, `lib/workflow/file-set-no-state.js`, `lib/workflow/start.js` — and `buildR2pIdentity` is called from `file-set-context.js`, `file-set-finalize.js`, `start.js` (per the dependency graph). The DES blocks imply these get rewired ("r2p no longer dispatches to `runFileSetFixLifecycleCommand`"), but the change-surface list does not name them.
- **Recommendation:** Note in DES-RESOLVE-001/DES-DOCS-001 that the change surface is illustrative and SPEC/PLAN must rewire every current r2p-branch consumer of `resolveR2pTarget`, `buildR2pIdentity`, and `MANIFEST_V2_R2P_FILESET_FIELDS` to the new resolver/lifecycle.

### N-03 — DES-INPUT-001 prose "no `..`" is not literally enforced by the regex
- **Severity: NIT** (precision; not a safety hole)
- **Location:** `05-design.md` DES-INPUT-001 lines 127-128.
- **Evidence:** The parenthetical says "no `..`," but `^WF-[A-Za-z0-9._-]+$` includes `.` in the character class, so a value like `WF-..` (or `WF-a..b`) matches the regex. This is **not** exploitable: with `/` and `\` excluded, a `..` substring is a literal filename component (e.g. a child literally named `WF-..`), never a traversal operator, and the realpath direct-child containment assertion (DES-PREFLIGHT-001) backstops it. It is only a prose/regex mismatch.
- **Recommendation:** Either tighten the regex to reject a `..` substring explicitly, or correct the prose to "`..` cannot act as a traversal component because path separators are excluded." Pin the exact pattern in the SPEC handoff so DES-INPUT-001 and Gate 1 agree.

Also confirm in SPEC that the workId shape rule applies identically to **both** the `workId=<value>` form and the bare `WF-...` shorthand token (DES-INPUT-001 currently phrases it as "the `workId` VALUE"; the bare token resolves to the same value, but make it explicit).

Dimensions re-confirmed SOUND (unchanged by the edits, no regression):
- Fail-closed dependency + `R2P_JSON` probe placement (before any review work) — DES-PREFLIGHT-001 step 1.
- Execution safety — argv + `shell:false` + two-verb allowlist + validated owner-stage/reason; with F-01 resolved, the workId arm of the injection/traversal surface is now closed.
- Migration/retirement scoping — `MANIFEST_V2_R2P_FILESET_FIELDS` is a separate kind-branched constant; the manifest stays valid for the six non-r2p routes (the residual is enumeration completeness, N-01/N-02, not schema safety).
- Scope discipline — no r2q compat, no old-state migration, no path tokens, no auto-run of `r2p-continue/execute/archive`.

## Unresolved-ambiguity check

**Verdict on "Decision Requests: none": FULLY JUSTIFIED.** The one v1 caveat (the load-bearing workId
validation rule that the design named but did not pin down) is now a concrete design statement
(`^WF-[A-Za-z0-9._-]+$` + realpath direct-child containment). All other candidate decisions
(target-key construction, manifest repurpose-vs-remove, debug semantics, receipt format/location,
repair mechanism, status source, lifecycle) remain resolved by evidence/convention as in v1. **No genuine
human/technical decision is hedged or deferred.** The remaining N-01/N-02/N-03 are enumeration/precision
items for SPEC/PLAN, not open decisions — the design ends cleanly enough to approve the checkpoint.
