# DESIGN subagent review (v1)

Artifact under review: `05-design.md` (r2p stage `design`, v1).
Spec: `00-raw-requirement.md` (R1–R11 + 11 verification gates).
Review trigger: forced (tier modifiers cross_project, dependency, migration, safety, scope_expanding).
Code facts verified against the on-disk repo at `/Users/xubo/x-studio/document-review-fix` via codegraph + Read.

## Verdict

**CHANGES-REQUESTED.**

The design is technically strong and unusually well-grounded: every "Current Code Evidence" claim is
factually correct, all 11 requirements and all 11 verification gates have design coverage, the
fail-closed dependency handling and the argv/`shell:false` execution model are sound, and the
retirement of the r2p-only machinery is correctly scoped so it cannot break the other six routes.
The one substantive gap is a **safety BLOCKER**: the design relies on "validate workId" (RISK-SEC-001)
but no DES block specifies a concrete workId shape/sanitization rule, and an unsanitized workId can
both traverse the filesystem and defeat the archive-only invariant (R2.4 / SCOPE-OUT-006). Two MINOR
coverage/enumeration gaps remain. "Decision Requests: none" is otherwise justified — the genuine
choices are resolved by evidence/convention.

## Current-code-evidence verification

All claims in the design's "Current Code Evidence" section were checked against the on-disk source.
Every one is **CONFIRMED**.

| Design claim | Verdict | Evidence |
|---|---|---|
| `parseInvocationR2p()` accepts bare dir / `target=`, `read-only\|review-and-fix`, `guard=git\|snapshot` (default snapshot), `resume\|reset`, `rounds=`, `root=`; rejects `ref/ledger/assurance/type/scope/base/strict/normal`; parse errors throw `Error` with `.code` (`ERR_MISSING_TARGET`, `ERR_UNLABELED_PATH`) | CONFIRMED | `lib/input.js:429-513`; rejects ref/ledger/assurance/type/scope/base at `:473-478`, strict/normal at `:485-487`; `ERR_MISSING_TARGET` `:498`, `ERR_UNLABELED_PATH` `:492-493`; default `guardMode:'snapshot'` `:445`; `guard=` accepted via `parseSharedCodeRouteToken` `:104-110` |
| `lib/routes.js` r2p descriptor `{ routeKind:'r2p', documentType:'PLAN', rubric:'plan', defaultMode:'review-and-fix', defaultGuard:'snapshot', targetContextKind:'r2p' }` | CONFIRMED | `lib/routes.js:99-108` (exact, plus `routeName:'review-fix-r2p'`, `platformPolicy`) |
| `deriveTargetKey(projectRoot, targetPath)` derives key from PATH: `slug(normalizedTarget)-sha256(normalizedTarget)[:12]`, NOT content; requires target to be an existing file inside root | CONFIRMED | `lib/target-state.js:192-205`; `realExistingFile(targetPath,'target')` `:194`; `assertTargetInsideRoot` `:195`; `hash12 = sha256(normalizedTarget).slice(0,12)` `:198`; `targetKey = ${slug}-${hash12}` `:203` |
| `buildR2pIdentity()` holds `runMdSha256`/`fileSetFingerprint` (+ `targetContextKind`, `guardMode`, `roundLimit`, `requirementDir`) and is persisted to the manifest, not folded into the key | CONFIRMED | `lib/target-context.js:1480-1494`; persisted-to-manifest semantics consistent with `MANIFEST_V2_R2P_FILESET_FIELDS` |
| `resolveR2pTarget({ cwd, target, commandLog })` resolves the requirement dir today | CONFIRMED | `lib/target-context.js:1400` (declared); call shape used at `lib/workflow/file-set-r2p-gate.js:54-58` |
| `file-set-r2p-gate.js` exports `snapshotForceIncludeDirs, resolveR2pLiveFileSet, revalidateR2pGate, beginGateBlockArgs, endGateBlockArgs (RESTORE_BEFORE_CONTINUE)`; four-checkpoint revalidation around `03-07` writes; blocks on `unexpected-worktree-change` | CONFIRMED | `module.exports` `lib/workflow/file-set-r2p-gate.js:171-178`; "FOUR checkpoints" header comment `:13-17`; `GATE_DRIFT_REASON='unexpected-worktree-change'` `:79`. Call sites: `file-set-fix.js:311,426,605,815` + `file-set-finalize.js:637` (5 sites = checkpoint-1 primary + blocked-retry, then refresh, end-fix, final PASS) |
| `lib/workflow/index.js` subcommand set = `start, preflight, context, record-review, record-triage, begin-fix, refresh-lock, end-fix, abort-fix, record-diff-review, finalize, aggregate-review`; r2p is an `isFileSetRoute` today running the file-set write/diff lifecycle | CONFIRMED | `WORKFLOW_SUBCOMMANDS` `lib/workflow/index.js:48-61`; `isFileSetRoute` returns true for `r2p` at `lib/workflow/target-resolution.js:49-52` |
| `MANIFEST_V2_R2P_FILESET_FIELDS = [requirementDir, runMdSha256, fileSetFingerprint, lastModifiedAt]`; `manifestV2FieldsForKind('r2p')` selects them; required by `requiredManifestV2Keys`; `targetContextKind` discriminator | CONFIRMED | `lib/workflow-state.js:177-182`; `manifestV2FieldsForKind` r2p branch `:221`; `requiredManifestV2Keys` `:225-227`; discriminator note `:184-187` |
| Only `coordinator.md` has an r2p passage today — the finding-to-owner-doc map naming `03-07` editable and `07-plan.md` the patch target (the OLD model to remove); `fixer.md`/`reviewer.md` have no r2p content | CONFIRMED | `shared/prompts/coordinator.md:117-125` ("editable set is the 03–07 owner docs", "fix backward there", "patched only in 07-plan.md"); `grep -i r2p` in `fixer.md`/`reviewer.md` = no matches |
| `route-contract.r2p.*`/`invocation-gate.r2p.*` document `target=<requirement-dir>`, editable `03-07`, `run.md` protected read-only, `guard=git\|snapshot` default snapshot; `debug` documented but NOT implemented in `lib/input.js` | CONFIRMED | `templates/fragments/invocation-gate.r2p.claude.md:1,3` (target=, guard default snapshot, lists `debug`); `route-contract.r2p.claude.md:7`; `debug` absent from `parseInvocationR2p`/`parseSharedCodeRouteToken` (`lib/input.js:69-119, 429-513`) → would `fail('ERR_UNKNOWN_TOKEN')` |
| argv-array exec is the norm: `runGit()` uses `execFile('git', args, …)` with a subcommand allowlist; `fix-guard.js` uses `execFileSync('git', args, …)`; neither passes `shell:true` | CONFIRMED | `runGit` `lib/target-context.js:48-65`, allowlist `ALLOWED_GIT_SUBCOMMANDS` `:36-42`, `execFile` `:56` (no `shell`); `fix-guard.js:4,88` `execFileSync` (no `shell`). `execFile`/`execFileSync` default `shell:false` |

No inaccurate or unverifiable code claim found.

Note on inherited external facts: the design's r2p-CLI grounding facts (binaries under `~/.req-to-plan/bin`,
not on PATH; `R2P_JSON`/`is_json_mode`; `--confirm` inert in v0.7.3; `STAGE_ORDER`; reopen forks
`WF-...-rN`; gap-open strictly-upstream + one-open-route) are inherited verbatim from `00-raw-requirement.md`,
which states they were verified against `~/x-skills/req-to-plan` v0.7.3 on 2026-06-27. These are **outside
this repo** and were not re-verified here; they are spec-asserted (UNCONFIRMED against the r2p source in this
pass). The design does not contradict any of them.

## Spec compliance (R1–R11 + 11 gates)

Requirements:

| Item | Owning DES | Coverage |
|---|---|---|
| R1 Invocation grammar (workId/bare, strict parse, reject path/`guard=`/doc+file-set tokens, `invalid-r2p-invocation` payload, internal always-on drift) | DES-INPUT-001 (+ DES-EXEC-001 for drift) | COVERED — but the **concrete workId shape/sanitization rule is silent** (see BLOCKER F-01) |
| R2 Fail-closed preflight in order (cmd env + `R2P_JSON` probe first, then root/workspace/active-archive/run-dir/artifacts) | DES-PREFLIGHT-001 | COVERED — all six steps + ordering; exact `nextAction` strings deferred to SPEC handoff |
| R3 Read-only evidence; tests distinguish drfx-driven vs r2p's own change | DES-RESOLVE-001 (empty editable set) + DES-LIFECYCLE-001 (`r2p-direct-artifact-write-forbidden`) | COVERED — the "r2p-side change is allowed" half is in RISK-WRITE-001 mitigation but thin in the SPEC handoff (F-04) |
| R4 Status→repair mode (4 outcomes, exact reasons) | DES-STATUS-001 | COVERED (all four outcomes verbatim) |
| R5 Finding→owner stage (6-stage table, string rules) | DES-STATUS-001 | COVERED |
| R6 Repair-plan schema, validation, earliest-stage aggregation, current-stage checkpoint, `r2p-repair-plan-ambiguous` boundary | DES-PLAN-001 | COVERED |
| R7 Execution (argv + `shell:false` + `R2P_JSON=1` + `--confirm`; drift re-checks; redacted receipt; read-only/forbidden allowlists) | DES-EXEC-001 (+ DES-STATUS-001) | COVERED |
| R8 r2p lifecycle (subcommands, context payload, block write/diff subcommands), target-key identity, **resume/reset/no-state state semantics** | DES-LIFECYCLE-001, DES-RESOLVE-001, DES-PASS-001 | MOSTLY COVERED — lifecycle, context payload, blocked subcommands, content-independent key all covered; **resume/reset/no-state behavior from R8 is not mapped to any DES block** (F-02) |
| R9 PASS semantics (checkpoint-after-repair, PASS-only-on-clean-rerun, receipt linkage, Gemini) | DES-PASS-001 | COVERED |
| R10 Change surface | all DES + DES-DOCS-001 | COVERED — but the retirement omits `file-set-finalize.js` from the enumerated touch points (F-03) |
| R11 No backward compat / no migration language | DES-DOCS-001 + Rollback | COVERED |

Verification gates:

| Gate | Owning DES | Coverage |
|---|---|---|
| 1 Invocation | DES-INPUT-001 | COVERED (modulo F-01 workId shape) |
| 2 Command-environment (+`R2P_JSON`) | DES-PREFLIGHT-001 | COVERED |
| 3 Workspace | DES-PREFLIGHT-001 | COVERED (archive-only resolution depends on F-01) |
| 4 Artifact | DES-PREFLIGHT-001 | COVERED |
| 5 No-direct-write | DES-LIFECYCLE-001 + DES-RESOLVE-001 | COVERED |
| 6 Repair-execution (fake r2p binaries) | DES-EXEC-001 + SPEC fixtures | COVERED |
| 7 Rerun-PASS | DES-PASS-001 | COVERED |
| 8 Status-contract | DES-STATUS-001 | COVERED |
| 9 Current-stage | DES-STATUS-001 / DES-PLAN-001 | COVERED |
| 10 Aggregation | DES-PLAN-001 | COVERED |
| 11 Documentation | DES-DOCS-001 | COVERED |

## Findings

### F-01 — workId shape/sanitization rule is unspecified; enables archive-bypass and path/flag traversal
- **Severity: BLOCKER** (safety; can defeat a core spec invariant)
- **Location:** `05-design.md` DES-INPUT-001 (lines 119-130) and DES-PREFLIGHT-001 (lines 132-143); spec gap also present upstream in `00-raw-requirement.md` R1 (lines 143-163) and brief SCOPE-IN-001.
- **Evidence:** RISK-SEC-001's mitigation lists "validate workId, owner-stage … and reason/required-action" (05-design.md lines 391-393) and claims the traversal risk is "mitigated" (lines 305-310). But no DES block states **what a valid workId is** — there is no required pattern (e.g. `^WF-[A-Za-z0-9._-]+$`), no rejection of `/`, and no rejection of `..`. DES-PREFLIGHT-001 step 4 resolves `activeDir = <root>/.req-to-plan/<workId>` and `archiveDir = <root>/.req-to-plan/archive/<workId>` by direct concatenation, and only checks symlink/regular-file on the resolved targets — which does not catch `..` traversal to a real sibling directory.
  - Concrete archive-bypass: `.req-to-plan/archive/` exists in this repo (verified on disk). `workId=archive/WF-foo` resolves `activeDir = .req-to-plan/archive/WF-foo` (an existing archived run) and `archiveDir = .req-to-plan/archive/archive/WF-foo` (absent) → the R2.4 branch "active exists, archive absent → continue" fires, so the route **reviews an archived run**, violating R2.4 / SCOPE-OUT-006 and the activation boundary.
  - Traversal: `workId=../../something` escapes the workspace; the symlink/dir checks do not prevent reaching a real directory via `..`.
  - argv flag-injection: an unvalidated workId is passed as the value of `r2p-reopen --from <workId>` / `r2p-gap-open --work-id <workId>`; a `--`-prefixed workId could be mis-parsed as a flag by r2p's arg parser. (R1 already rejects `target=` and *bare* path tokens, but it does **not** reject a path-shaped *value* of `workId=`.)
- **Recommendation:** Add an explicit DES statement (DES-INPUT-001) that the workId value must match a strict pattern (WF-prefixed, no path separators, no `..`, NUL-free, length-bounded) and is rejected with `invalid-r2p-invocation` otherwise; restate in DES-PREFLIGHT-001 that active/archive resolution operates only on a validated single-segment workId, and that the resolved `activeDir`/`archiveDir` must be a direct child of `.req-to-plan` (resp. `.req-to-plan/archive`) — e.g. resolve and assert containment. Carry this into the SPEC handoff and Gate 1/Gate 3.

### F-02 — R8 resume/reset/no-state behavior is not mapped to any DES block
- **Severity: MINOR** (partial coverage)
- **Location:** `05-design.md` DES-PASS-001 (lines 199-208); spec R8 (lines 310-315).
- **Evidence:** R8 mandates that `resume` continues target-local state (so a rerun can link the prior round's receipt), `reset` archives existing target-local state and starts fresh, and a one-shot `read-only` run without `resume`/`reset` stays no-state (tokens in memory only). DES-PASS-001 describes state *contents* (review history + redacted receipts) and reopen/gap-open linkage, but does not assign the `resume`/`reset`/no-state *lifecycle behavior* to any design component, and the SPEC handoff for DES-PASS-001 omits it. DES-INPUT-001 parses `resume`/`reset` but does not define their runtime effect.
- **Recommendation:** State in DES-PASS-001 (or DES-LIFECYCLE-001) that `resume` continues the workId's target-local state, `reset` archives it and starts fresh, and read-only-without-resume/reset is no-state, and add it to the SPEC handoff so Gate 7's linkage is testable.

### F-03 — retirement of `file-set-r2p-gate.js` omits `file-set-finalize.js` from the change surface
- **Severity: MINOR** (enumeration completeness)
- **Location:** `05-design.md` R10 change surface (lines 344-366) and DES-DOCS-001 (lines 210-219).
- **Evidence:** The design says to "Retire `lib/workflow/file-set-r2p-gate.js`." Its symbols are imported/called in **two** files: `file-set-fix.js` (`revalidateR2pGate` at :311,426,605,815) **and** `file-set-finalize.js` (imports at :56, call at :637). R10's change surface lists only `lib/workflow/file-set-fix.js` ("block the r2p route from the direct-write fix lifecycle") and does not mention `file-set-finalize.js`, even though the four-checkpoint revalidation the design retires lives partly there. (R10 is phrased "at least," so this is not strictly wrong, but the design's own retirement claim has an unlisted touch point that an implementer could miss, leaving a dangling import.)
- **Recommendation:** Add `lib/workflow/file-set-finalize.js` (remove the `file-set-r2p-gate` import + the final-PASS `revalidateR2pGate` call site) to the change surface, and note that all 5 r2p call sites across both files are removed.

### F-04 — the "r2p-side change is allowed" half of the R3 test contract is thin in the SPEC handoff
- **Severity: NIT**
- **Location:** `05-design.md` SPEC handoff for DES-LIFECYCLE-001 (lines 261-262); spec R3 (lines 201-208).
- **Evidence:** R3 requires tests to assert both that a *drfx-driven* change to `03-07`/`run.md` fails **and** that an artifact change made by *r2p itself* is **not** a failure. RISK-WRITE-001's mitigation captures both halves (lines 394-396), but the DES-LIFECYCLE-001 SPEC handoff only names the `r2p-direct-artifact-write-forbidden` block (the drfx-fails half).
- **Recommendation:** Add the "r2p-authored change is permitted/expected" assertion to the DES-LIFECYCLE-001 SPEC handoff so Gate 5 tests both directions.

### F-05 — `R2P_JSON` contract-probe success predicate is slightly under-specified
- **Severity: NIT**
- **Location:** `05-design.md` DES-PREFLIGHT-001 (lines 135-137); R2.1 (lines 171-181).
- **Evidence:** The probe "running a read-only status command and confirming the documented JSON payload" plus "parsed defensively against the documented keys" (DES-STATUS-001) is adequate, but the exact pass/fail predicate (must parse as JSON AND contain which minimal key set) is left to SPEC. This is acceptable at design altitude; flagging only so SPEC pins the exact predicate that distinguishes an r2p that honors `R2P_JSON` from one that emits human text.
- **Recommendation:** Have SPEC define the minimal key set the probe checks (e.g. `status` + `current_stage` present and parseable) for `r2p-json-contract-unavailable`.

Dimensions that are SOUND (stated plainly, no finding):
- **Fail-closed dependency (RISK-DEP-001 / cross_project):** all four commands required in all modes, then the `R2P_JSON` probe, all **before** any review work, drfx state, reviewer run, or r2p command (DES-PREFLIGHT-001 step 1). Probe placement is correct.
- **Execution safety (RISK-SEC-001, modulo F-01):** argv array + `shell:false` + `R2P_JSON=1`, two-verb mutating allowlist, owner-stage validated against the six-value enum, reason/required-action single-line/NUL-free/length-bounded/no-embedded-shell. With `shell:false`, reason metacharacters are inert. The injection surface is closed *for reason/stage*; the residual is the workId (F-01).
- **Migration/retirement safety (RISK-MIG-001 / migration):** `MANIFEST_V2_R2P_FILESET_FIELDS` is a **separate** constant; `manifestV2FieldsForKind` branches by kind (`document`/`code`/`r2p`/pr-default at `lib/workflow-state.js:218-223`), so replacing the r2p field list cannot alter the document/pr/code field sets. `revalidateR2pGate`/`snapshotForceIncludeDirs` are already no-ops for non-r2p routes, so removing the r2p branches does not affect PR/CODE. The manifest stays valid for the six non-r2p kinds. Sound (subject to F-03's call-site cleanup).
- **Scope discipline (scope_expanding):** no r2q compat, no old-state migration, no path tokens, no auto-run of `r2p-continue`/`execute`/`archive` — all explicitly excluded in Scope Overflow Risks + Boundaries and consistent with SCOPE-OUT-001..011.
- **Rollback:** correctly identifies the release/commit as the rollback unit, that drfx writes no artifact state, and that r2p-owned mutations are intentionally not reverted by drfx (consistent with the ownership boundary).

## Unresolved-ambiguity check

**Verdict on "Decision Requests: none": JUSTIFIED, with one caveat.**

The design genuinely resolves the candidate decision points rather than hedging:

- **Target-key hash construction — RESOLVED, concrete.** DES-RESOLVE-001 specifies `deriveR2pTargetKey({projectRoot, workId})` as a `slug-hash12` from a domain-separated SHA-256 of (`r2p`, realpath project root, workId), following the existing `deriveTargetKey` convention, content-independent. Hand-off-ready.
- **MANIFEST fields removed vs repurposed — RESOLVED (repurposed).** Options Considered "Manifest fields (A)" + DES-DOCS-001: replace the editable-set fields with read-only review-set freshness fields (drop `requirementDir`-as-key, add `workId`; keep `runMdSha256` + an artifact-set fingerprint). This resolves R10's "removed or repurposed" hedge. (Only minor residual: whether the fingerprint field reuses the `fileSetFingerprint` name or a new one — a naming detail, not a decision.)
- **Debug-token semantics — RESOLVED, concrete.** DES-INPUT-001 + Observability: `debug` is a parsed boolean raising diagnostic verbosity only; it must never relax preflight/read-only/PASS rules.
- **Receipt on-disk format/location — RESOLVED enough for design.** DES-EXEC-001 + DES-PASS-001: redacted receipt persisted to `.drfx/targets/<key>/` with a defined field list + redaction rules, plus a receipt id for linkage; exact filename deferred to SPEC, which is appropriate altitude.
- **Repair mechanism / status source / lifecycle** — all RESOLVED in Options Considered with rationale (A chosen, B/C rejected on grounded reasons).

**Caveat (the one real silence, = F-01):** the **workId validation rule** is the single load-bearing item the design names but does not pin down. It is not a *human* decision to escalate — it is a concrete safety spec the design must state outright (a regex/containment rule), and its absence is exploitable (archive-bypass + traversal + argv flag-injection). It should be added as a concrete design statement in DES-INPUT-001/DES-PREFLIGHT-001 rather than left implied by the `<WF-...>` placeholder and the "not a path" message. With that one addition, "Decision Requests: none" is fully sound and the design is hand-off-ready to SPEC.
