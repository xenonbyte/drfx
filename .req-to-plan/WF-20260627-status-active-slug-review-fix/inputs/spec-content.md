# Spec

## Behavior Contracts

### SPEC-INPUT-001 workId invocation grammar and value shape
implements DES-INPUT-001 [ADDRESSED]; closes RISK-SEC-001 [ADDRESSED] (covers SCOPE-IN-001, SCOPE-IN-002)
- Accept `review-fix-r2p workId=<WF-...>` and a single bare `WF-...` token (shorthand for `workId=`).
- Full grammar: `workId=<WF-...> [read-only|review-and-fix] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`.
- The `workId` value MUST match `^WF-[A-Za-z0-9._-]+$` AND MUST NOT contain the substring `..`; any value
  failing this — path-shaped (`archive/WF-x`, `../../x`), flag-shaped (`--from=x`, leading `-`), NUL-bearing,
  or over the length bound — is an invalid invocation and is never resolved.
- Strict parse errors: duplicate `workId=`, more than one bare workId, `read-only` together with
  `review-and-fix`, `resume` together with `reset`, `rounds=` without `review-and-fix`.
- Reject `target=<anything>` (including `.req-to-plan/...` and `07-plan.md`) and any bare path token with
  the single message `Blocked: review-fix-r2p expects workId=<WF-...>, not a path.`; reject
  `ref=/scope=/base=/assurance=/ledger=/guard=/strict/normal` as unknown tokens for this route.
- `debug` is a parsed boolean raising diagnostic verbosity only; it never relaxes preflight, read-only,
  or PASS rules.
- On any invocation error, return exactly
  `{ "status":"blocked", "blockingReason":"invalid-r2p-invocation", "nextAction":"rerun as review-fix-r2p workId=<WF-...>" }`.

### SPEC-PREFLIGHT-001 fail-closed preflight chain
implements DES-PREFLIGHT-001 [ADDRESSED]; closes RISK-DEP-001 [ADDRESSED], RISK-CROSS-001 [ADDRESSED] (covers SCOPE-IN-003)
Run in order, before any review work, drfx state, reviewer run, or r2p command; each failure blocks:
1. Resolve `r2p-status`, `r2p-reopen`, `r2p-gap-open`, `r2p-continue` via PATH then `~/.req-to-plan/bin`;
   any missing -> `r2p-command-unavailable`. Then probe `R2P_JSON`: run a read-only status command with
   `R2P_JSON=1`; the output must parse as JSON and contain at least `status` and `current_stage` to count
   as honoring the contract; otherwise -> `r2p-json-contract-unavailable`.
2. Project root (`root=` else cwd) exists, is a directory, not a symlink, else -> `invalid-project-root`.
3. `<root>/.req-to-plan` exists and is a real directory, else -> `r2p-workspace-not-found`
   (missing) / `unsafe-r2p-workspace` (symlink).
4. workId active/archive resolution on a validated single-segment workId: realpath-resolve
   `activeDir=<root>/.req-to-plan/<workId>` and `archiveDir=<root>/.req-to-plan/archive/<workId>` and assert
   each is a DIRECT child of `.req-to-plan` (resp. `.req-to-plan/archive`); then branch — active only ->
   continue; archive only -> `r2p-run-archived`; both -> `r2p-work-id-conflict`; neither ->
   `r2p-run-not-found`.
5. `activeDir` is a directory and not a symlink, else -> `unsafe-r2p-run-dir`.
6. `run.md` and each of `03-07` exist as regular non-symlink files, else -> `r2p-artifact-missing-or-unsafe`.

### SPEC-RESOLVE-001 workId-based read-only resolver and stable key
implements DES-RESOLVE-001 [ADDRESSED]; closes RISK-WRITE-001 [ADDRESSED] (covers SCOPE-IN-004)
- `resolveR2pWorkIdTarget({ projectRoot, workId })` returns `reviewFiles=[03,04,05,06,07]`,
  `protectedDependencies=['run.md']`, `editableFiles=[]`, the `runDir`/`runLocation`, `runMdSha256`, and a
  review-set fingerprint over `03-07`.
- The target key comes from `deriveR2pTargetKey({ projectRoot, workId })` = `slug-hash12` over a
  domain-separated SHA-256 of (`r2p`, realpath project root, workId); it is independent of any
  `run.md`/`03-07` content, so the same workId yields the same key across r2p regeneration, while a reopen
  (new workId) yields a new key.
- `runMdSha256` and the review-set fingerprint are persisted to the manifest ONLY as freshness gates; a
  changed fingerprint marks the prior review stale and forces a re-read before any PASS, but never changes
  the key.
- The path-based `resolveR2pTarget` and `buildR2pIdentity` are removed; all r2p-branch consumers migrate to
  the workId resolver (see SPEC-DOCS-001).

### SPEC-LIFECYCLE-001 r2p workflow lifecycle and write prohibition
implements DES-LIFECYCLE-001 [ADDRESSED]; closes RISK-WRITE-001 [ADDRESSED] (covers SCOPE-IN-005)
- Lifecycle: `start -> context -> record-review -> record-triage -> record-r2p-repair-plan ->
  apply-r2p-repair -> finalize/checkpoint`.
- `context` returns `routeKind:'r2p'`, `workId`, `runDir`, `runLocation`, `reviewFiles` (`03-07`),
  `protectedDependencies:['run.md']`, `editableFiles:[]`, `directArtifactWrites:'forbidden'`, and the
  resolved `repairMode`.
- Two new subcommands exist: `record-r2p-repair-plan` and `apply-r2p-repair`.
- For the r2p route the write/diff subcommands `begin-fix`, `refresh-lock`, `end-fix`, `abort-fix`,
  `record-diff-review` and any direct artifact write block with `r2p-direct-artifact-write-forbidden`.

### SPEC-STATUS-001 status resolution and finding-to-owner-stage mapping
implements DES-STATUS-001 [ADDRESSED]; closes RISK-CROSS-001 [ADDRESSED] (covers SCOPE-IN-006, SCOPE-IN-007)
- Resolve `status`, `current_stage`, and `open_routes_detail[]` (each with `owner_stage`) by running
  `r2p-status --all` with `R2P_JSON=1` and selecting the entry whose `work_id` matches; never `r2p-switch`.
- Repair-mode mapping: `closed_at_plan_checkpoint`/`executing` -> reopen; open run + finding owned strictly
  upstream of `current_stage` -> gap-open; open run + owner==`current_stage` finding -> checkpoint
  `r2p-current-stage-repair-required`; anything else -> `r2p-run-status-unsupported`.
- Each finding maps to an `ownerStage` over `[raw_requirement, requirement_brief, risk_discovery, design,
  spec, plan]` via the requirement's finding-type table.
- `reason`/`required-action` are single-line, non-empty, length-bounded, NUL-free, with no embedded shell
  command.

### SPEC-PLAN-001 repair-plan schema, validation, earliest-stage aggregation
implements DES-PLAN-001 [ADDRESSED] (covers SCOPE-IN-008)
- One repair plan per round with exactly one `command_kind` (`r2p-reopen` or `r2p-gap-open`); `issue_id`s
  from accepted findings; `owner_stage` a valid stage; `reason`/`required_action` pass the string rules.
- Aggregation applies the SPEC-STATUS-001 mapping first, then collapses accepted findings into one command
  at the EARLIEST repairable `STAGE_ORDER` stage, recording every aggregated `issue_id`.
- An open run with no accepted finding strictly upstream of `current_stage` yields the current-stage
  checkpoint (no plan).
- Block `r2p-repair-plan-ambiguous` only when, after the status mapping, accepted findings still cannot map
  to valid owner stages or one allowed command.

### SPEC-EXEC-001 allowlisted execution, drift guard, redacted receipt
implements DES-EXEC-001 [ADDRESSED]; closes RISK-SEC-001 [ADDRESSED], RISK-DRIFT-001 [ADDRESSED], RISK-DATA-001 [ADDRESSED] (covers SCOPE-IN-009)
- Mutating allowlist is exactly `r2p-reopen`, `r2p-gap-open`; read-only allowlist is `r2p-status`; every
  other r2p verb is forbidden to drfx.
- Execute via an argv array with `shell:false` and `R2P_JSON=1`; pass `--confirm` on `r2p-gap-open`.
- Immediately before execution, an always-on drift guard re-checks: the four commands still resolve; the
  active run still exists and the archive run still does not; the `run.md`+`03-07` fingerprints are
  unchanged since review/triage; and the live `R2P_JSON` status still matches the plan's `command_kind` —
  any mismatch blocks instead of executing.
- The receipt records only: command, a reduced single-line argv with `reason`/`required-action` redacted,
  exit code, redacted stdout/stderr, captured `newWorkId` (reopen) or `route_id`/`staled_stages`
  (gap-open), and `nextAction`. It never records raw prompts, transcripts, secrets, or large artifact
  bodies.

### SPEC-PASS-001 PASS semantics, linkage, state lifecycle, Gemini
implements DES-PASS-001 [ADDRESSED]; closes RISK-PASS-001 [ADDRESSED] (covers SCOPE-IN-010)
- A round that executed a repair command finalizes at a checkpoint (`Final status: checkpoint`,
  `Status reason: r2p-repair-applied`, `Coordinator agreement: none`) and can never PASS.
- PASS is reachable only on a clean re-review of the current active run's regenerated artifacts.
- `nextAction` instructs running `r2p-continue` until r2p finishes, then rerunning
  `review-fix-r2p workId=<...>` (new workId after reopen, same after gap-open).
- State lifecycle: `resume` continues the workId's target-local state (linking the prior receipt); `reset`
  archives it and starts fresh; a one-shot `read-only` run without `resume`/`reset` is no-state. On reopen
  the new workId's `start` state records the prior workId and prior receipt id; on gap-open the same key
  carries the receipt forward.
- Gemini is advisory-only and can never claim PASS.

### SPEC-DOCS-001 documentation rewrite and complete retirement
implements DES-DOCS-001 [ADDRESSED]; closes RISK-MIG-001 [ADDRESSED] (covers SCOPE-IN-011)
- Rewrite `skills/review-fix-r2p/SKILL.md`, `templates/fragments/route-contract.r2p.*`,
  `templates/fragments/invocation-gate.r2p.*`, `shared/prompts/coordinator.md`, and
  `shared/prompts/fixer.md` to the new model only, with no legacy or migration language; the
  coordinator's old "r2p finding-to-owner-doc map" (which names `03-07` as the editable set) is replaced.
- Retire `lib/workflow/file-set-r2p-gate.js` entirely. Remove EVERY import and use of its six exported
  symbols — `snapshotForceIncludeDirs`, `resolveR2pLiveFileSet`, `revalidateR2pGate`, `beginGateBlockArgs`,
  `endGateBlockArgs`, `RESTORE_BEFORE_CONTINUE` — across `lib/workflow/file-set-fix.js` and
  `lib/workflow/file-set-finalize.js` (the import block and all call sites in both files, including the
  final-PASS `revalidateR2pGate`), leaving no dangling import; update `test/workflow-module-boundaries.test.js`
  to drop the retired module entry.
- Migrate the other r2p-branch consumers of `resolveR2pTarget`/`buildR2pIdentity` (e.g.
  `lib/workflow/file-set-context.js`, `lib/workflow/start.js`, and any other caller) to the workId model.
- Replace `MANIFEST_V2_R2P_FILESET_FIELDS` with read-only review-set freshness fields (drop the
  requirementDir-as-key/editable-set semantics, add `workId`; keep `runMdSha256` and a review-set
  fingerprint as freshness gates), keeping `manifestV2FieldsForKind` valid for the six non-r2p kinds.

## API / Data / Config Contracts

- **workId value contract**: regex `^WF-[A-Za-z0-9._-]+$`, additionally rejecting any value containing
  `..`; single path segment; length-bounded; NUL-free. Used both at parse (SPEC-INPUT-001) and as the
  `--from`/`--work-id` argv value (SPEC-EXEC-001).
- **Blocked result shape**: `{ status:'blocked', blockingReason:<token>, nextAction:<string> }`. Checkpoint
  result shape: `{ status:'checkpoint', statusReason:<token>, nextAction:<string> }`.
- **`context` payload**: `{ routeKind:'r2p', workId, runDir, runLocation, reviewFiles:['03..07'],
  protectedDependencies:['run.md'], editableFiles:[], directArtifactWrites:'forbidden', repairMode }`.
- **Repair-plan schema**: `{ command_kind:'r2p-reopen'|'r2p-gap-open', owner_stage:<stage>,
  issue_ids:[...], reason?:<string>, required_action?:<string> }` (reason for reopen, required_action for
  gap-open).
- **Receipt schema**: `{ command, argv:[redacted], exitCode, stdout:<redacted>, stderr:<redacted>,
  newWorkId?|routeId?, staledStages?, nextAction, receiptId, priorWorkId?, priorReceiptId? }`.
- **r2p `R2P_JSON` parse contract (input from r2p, read-only)**: status-run -> `{ status, current_stage,
  open_routes, open_routes_detail:[{ route_id, from_stage, owner_stage, required_action }] }`; reopen ->
  `{ new_work_id }`; gap-open -> `{ route_id, staled_stages }`.
- **Manifest V2 r2p fields (new)**: `targetContextKind='r2p'`, `workId`, `runMdSha256`, review-set
  fingerprint, timestamps; selected by `manifestV2FieldsForKind('r2p')`; no editable-set field.

## External Documentation Checked

| Dependency | Version | Check Date | Conclusion |
|---|---|---|---|
| req-2-plan CLI (`@xenonbyte/req-2-plan`) | 0.7.3 | 2026-06-27 | Verified against `~/x-skills/req-to-plan`: env-gated `R2P_JSON` JSON contract (`output.py:is_json_mode`), command signatures for reopen/gap-open/status, `STAGE_ORDER`, `--confirm` accepted-but-inert on gap-open. Binaries live at `~/.req-to-plan/bin` (not on PATH). |

## Test Matrix

| Gate | Scenario | Expected | SPEC ref |
|---|---|---|---|
| 1 Invocation | `workId=WF-x` / bare `WF-x`; then `target=...`, raw `.req-to-plan/...`, `07-plan.md`, `ref/scope/base/assurance/ledger/guard/strict/normal`, dup/conflict tokens; then `workId=archive/WF-x`, `workId=../x`, `workId=--from=x` | accept the first two; all others -> `invalid-r2p-invocation` | SPEC-INPUT-001 |
| 2 Command-env | one of the four r2p commands missing; then an r2p that ignores `R2P_JSON` | `r2p-command-unavailable`; then `r2p-json-contract-unavailable` | SPEC-PREFLIGHT-001 |
| 3 Workspace | missing/symlinked `.req-to-plan`; missing active workId; archive-only; active+archive conflict; real active | block reasons per step; real active passes | SPEC-PREFLIGHT-001 |
| 4 Artifact | missing/symlinked `run.md` or any `03-07`; all six regular | `r2p-artifact-missing-or-unsafe`; all-present passes | SPEC-PREFLIGHT-001 |
| 5 No-direct-write | drfx attempts a write to `03-07`/`run.md`; then r2p itself changes an artifact | drfx-driven change FAILS; r2p-authored change is NOT a failure | SPEC-LIFECYCLE-001, SPEC-RESOLVE-001 |
| 6 Repair-exec (fake r2p binaries emitting `R2P_JSON`) | closed-run finding; open-run upstream-gap finding | `r2p-reopen` captures `new_work_id`; `r2p-gap-open` (with `--confirm`) captures `route_id`; argv + `shell:false`; ends at checkpoint; no PASS; `nextAction` names `r2p-continue` + correct rerun workId | SPEC-EXEC-001, SPEC-PLAN-001 |
| 7 Rerun-PASS | regenerated artifacts re-review clean; then a repair command in the same round | clean rerun can PASS; same-round repair cannot PASS | SPEC-PASS-001 |
| 8 Status-contract | `R2P_JSON` payload with multiple open-route owner stages; then an r2p without the contract | parses deterministically; missing contract -> `r2p-json-contract-unavailable` | SPEC-STATUS-001, SPEC-PREFLIGHT-001 |
| 9 Current-stage | open run, owner==`current_stage` finding | neither gap-open nor reopen; checkpoint `r2p-current-stage-repair-required` | SPEC-STATUS-001, SPEC-PLAN-001 |
| 10 Aggregation | accepted findings spanning multiple owner stages; then a post-mapping unmappable set | one command at the earliest repairable stage with all `issue_ids`; unmappable -> `r2p-repair-plan-ambiguous` | SPEC-PLAN-001 |
| 11 Documentation | scan SKILL.md, route-contract/invocation-gate fragments, coordinator.md, fixer.md; module-boundary test | only the new model, no legacy/migration language; no dangling `file-set-r2p-gate` import | SPEC-DOCS-001 |

## Non-goals

- No compatibility with `review-fix-r2q` (SCOPE-OUT-001).
- No migration or reading of prior r2p/r2q `.drfx/targets` state (SCOPE-OUT-002).
- No acceptance of `target=<requirement-dir>` (SCOPE-OUT-003), a raw `.req-to-plan/WF-*` path
  (SCOPE-OUT-004), or a `07-plan.md` path (SCOPE-OUT-005).
- No reviewing an archived run (SCOPE-OUT-006) and no auto-promotion of an archived run to active
  (SCOPE-OUT-007).
- No auto-running `r2p-continue`, `r2p-execute`, or `r2p-archive` (SCOPE-OUT-008).
- No drfx-driven edit of `03-07` or `run.md` (SCOPE-OUT-009) and no treating r2p artifacts as an ordinary
  document or file-set fix target (SCOPE-OUT-010).
- No legacy-behavior or migration language in docs, skills, or route contracts (SCOPE-OUT-011).

## PLAN Handoff

Each SPEC contract maps to one or more PLAN tasks; PLAN must consume every SPEC id via `Spec References`
and carry every SCOPE-IN id in a task body. Suggested task grouping by build phase:

- Phase 1 (compliance): SPEC-INPUT-001, SPEC-PREFLIGHT-001, SPEC-RESOLVE-001, SPEC-LIFECYCLE-001,
  SPEC-STATUS-001 (recommend-only, no execution), and the Phase-1 slice of SPEC-DOCS-001 (route
  contracts/skill reflect workId + read-only + forbidden writes).
- Phase 2 (controlled execution): SPEC-PLAN-001, SPEC-EXEC-001 (argv execution, drift guard, redacted
  receipt, checkpoint-after-repair).
- Phase 3 (closed loop): SPEC-PASS-001 (capture ids, precise `nextAction`, receipt linkage, PASS only on
  clean rerun), plus the SPEC-DOCS-001 retirement (delete `file-set-r2p-gate.js`, scrub all imports across
  both consumer files, update the boundary test, replace manifest fields).
- Risk closure: RISK-DEP-001, RISK-SEC-001, RISK-WRITE-001, RISK-DRIFT-001, RISK-CROSS-001, RISK-DATA-001,
  RISK-PASS-001, RISK-MIG-001 are each addressed by the contracts above.
- Test fixtures: fake `r2p-reopen`/`r2p-gap-open`/`r2p-status` binaries emitting the documented `R2P_JSON`
  payloads, used by gates 6, 8, 9, 10.

## Trace

| This ID | Upstream | Status |
|---|---|---|
| SPEC-INPUT-001 | DES-INPUT-001 / SCOPE-IN-001, SCOPE-IN-002 | addressed |
| SPEC-PREFLIGHT-001 | DES-PREFLIGHT-001 / SCOPE-IN-003 | addressed |
| SPEC-RESOLVE-001 | DES-RESOLVE-001 / SCOPE-IN-004 | addressed |
| SPEC-LIFECYCLE-001 | DES-LIFECYCLE-001 / SCOPE-IN-005 | addressed |
| SPEC-STATUS-001 | DES-STATUS-001 / SCOPE-IN-006, SCOPE-IN-007 | addressed |
| SPEC-PLAN-001 | DES-PLAN-001 / SCOPE-IN-008 | addressed |
| SPEC-EXEC-001 | DES-EXEC-001 / SCOPE-IN-009 | addressed |
| SPEC-PASS-001 | DES-PASS-001 / SCOPE-IN-010 | addressed |
| SPEC-DOCS-001 | DES-DOCS-001 / SCOPE-IN-011 | addressed |

## Upstream Summary (read-only)
# Design

## Design Summary

Convert `review-fix-r2p` from a file-set route that edits the r2p-owned `03-07` documents in place into
a **read-only, workId-keyed diagnostic route whose only repair action is invoking an official r2p
lifecycle command**. The design replaces the path-based, editable-file-set resolution with a
workId-based resolver that exposes `03-07` + `run.md` as read-only evidence and an empty editable set;
adds a fail-closed preflight chain (command environment + `R2P_JSON` contract probe, then workspace and
artifact checks); resolves run status from the `R2P_JSON` serialized contract; and introduces an
r2p-specific lifecycle (`record-r2p-repair-plan`, `apply-r2p-repair`) that runs `r2p-reopen` /
`r2p-gap-open` through an argv-array, `shell: false`, allowlisted executor behind an always-on
pre-execution drift guard, recording a redacted receipt. The old write-guard machinery
(`file-set-r2p-gate.js`, the four-checkpoint write revalidation) and the MANIFEST V2 editable-set
semantics are retired. No backward compatibility and no state migration are provided.

## Current Code Evidence

- **Invocation**: `parseInvocationR2p()` (`lib/input.js`) currently accepts a bare requirement dir or
  `target=<requirement-dir>`, plus `read-only|review-and-fix`, `guard=git|snapshot` (default snapshot),
  `resume|reset`, `rounds=<n>`, `root=`; it rejects `ref=/ledger=/assurance=/type=/scope=/base=/strict/normal`.
  Parse errors throw an `Error` with a `.code` (e.g. `ERR_MISSING_TARGET`, `ERR_UNLABELED_PATH`).
- **Descriptor**: `lib/routes.js` defines `review-fix-r2p` as
  `{ routeKind: 'r2p', documentType: 'PLAN', rubric: 'plan', defaultMode: 'review-and-fix',
  defaultGuard: 'snapshot', targetContextKind: 'r2p' }`.
- **Resolution / key**: `resolveR2pTarget({ cwd, target, commandLog })` (`lib/target-context.js`)
  resolves the requirement dir today. The target KEY is produced by
  `deriveTargetKey(projectRoot, targetPath)` (`lib/target-state.js`) as
  `slug(normalizedTarget)-sha256(normalizedTarget)[:12]` — i.e. already path-derived, NOT content-derived.
  Content fingerprints live in `buildR2pIdentity()` (`lib/target-context.js`):
  `{ targetContextKind:'r2p', guardMode, roundLimit, requirementDir, runMdSha256, fileSetFingerprint }`,
  which is persisted to the manifest, not folded into the key. `deriveTargetKey` requires the target to
  be an existing file inside the root.
- **Write-guard machinery (to retire)**: `lib/workflow/file-set-r2p-gate.js` exposes
  `snapshotForceIncludeDirs`, `resolveR2pLiveFileSet`, `revalidateR2pGate`, `beginGateBlockArgs`,
  `endGateBlockArgs`, `RESTORE_BEFORE_CONTINUE`; `revalidateR2pGate` is called at four checkpoints in
  `file-set-fix.js` and `file-set-finalize.js` around the `03-07` writes, blocking on
  `unexpected-worktree-change`.
- **Lifecycle**: `lib/workflow/index.js` dispatches the subcommands `start, preflight, context,
  record-review, record-triage, begin-fix, refresh-lock, end-fix, abort-fix, record-diff-review,
  finalize, aggregate-review`. r2p is an `isFileSetRoute` route, so it currently runs the file-set
  write-and-diff lifecycle (`runFileSetFixLifecycleCommand`, `runFileSetRecordDiffReview`,
  `runFileSetFinalize`).
- **Manifest fields**: `lib/workflow-state.js` defines `MANIFEST_V2_R2P_FILESET_FIELDS`
  (`requirementDir, runMdSha256, fileSetFingerprint, lastModifiedAt`), selected by
  `manifestV2FieldsForKind('r2p')` and required by `requiredManifestV2Keys`, with a `targetContextKind`
  discriminator. The r2p parse branch is `targetContextKind === 'r2p'`.
- **Prompts**: only `shared/prompts/coordinator.md` has an r2p passage today — the "r2p
  finding-to-owner-doc map" that names `03-07` as the editable set and `07-plan.md` as the patch
  target. `fixer.md` and `reviewer.md` have no r2p-specific content.
- **Route contracts**: `templates/fragments/route-contract.r2p.*` and `invocation-gate.r2p.*` document
  `target=<requirement-dir>`, the editable `03-07` file set, `run.md` as a protected read-only
  dependency, and a `guard=git|snapshot` default of snapshot. `debug` is documented in the
  invocation-gate fragment but is NOT implemented in `lib/input.js`.
- **Process execution convention**: the codebase already runs child processes via argv arrays —
  `runGit()` (`lib/target-context.js`) uses `execFile('git', args, …)` with a subcommand allowlist, and
  `lib/fix-guard.js` uses `execFileSync('git', args, …)`. Neither passes `shell: true`.

## Requirements Coverage

Scope coverage (SCOPE-IN -> owning design component):

- SCOPE-IN-001, SCOPE-IN-002 -> DES-INPUT-001 (workId grammar + token rejection).
- SCOPE-IN-003 -> DES-PREFLIGHT-001 (fail-closed preflight chain).
- SCOPE-IN-004 -> DES-RESOLVE-001 (read-only review set, empty editable set, content-independent key).
- SCOPE-IN-005 -> DES-LIFECYCLE-001 (r2p lifecycle; block direct writes).
- SCOPE-IN-006, SCOPE-IN-007 -> DES-STATUS-001 (status->repair-mode + finding->owner-stage).
- SCOPE-IN-008 -> DES-PLAN-001 (repair-plan schema, validation, earliest-stage aggregation).
- SCOPE-IN-009 -> DES-EXEC-001 (allowlisted argv execution, drift guard, redacted receipt).
- SCOPE-IN-010 -> DES-PASS-001 (checkpoint-after-repair, PASS-on-clean-rerun, linkage, Gemini, state).
- SCOPE-IN-011 -> DES-DOCS-001 (docs/prompt rewrite + retirement of old machinery/fields).

Risk closure:

- RISK-DEP-001 [ADDRESSED] by DES-PREFLIGHT-001 (command + `R2P_JSON` probe) and DES-STATUS-001
  (defensive JSON parsing against documented keys).
- RISK-SEC-001 [ADDRESSED] by DES-EXEC-001 (argv array, `shell:false`, two-verb allowlist) and
  DES-STATUS-001 (workId/owner-stage/reason validation).
- RISK-WRITE-001 [ADDRESSED] by DES-RESOLVE-001 (empty editable set) and DES-LIFECYCLE-001
  (`r2p-direct-artifact-write-forbidden`).
- RISK-DRIFT-001 [ADDRESSED] by DES-EXEC-001 (always-on pre-execution drift guard).
- RISK-CROSS-001 [ADDRESSED] by DES-PREFLIGHT-001 (contract probe), DES-STATUS-001, and DES-PLAN-001
  (grounded r2p semantics, defensive `--confirm`).
- RISK-DATA-001 [ADDRESSED] by DES-EXEC-001 (receipt redaction rules).
- RISK-PASS-001 [ADDRESSED] by DES-PASS-001 (checkpoint-after-repair invariant; Gemini advisory).
- RISK-MIG-001 [ADDRESSED] by DES-DOCS-001 (scoped retirement; manifest stays valid for other routes).

## Options Considered

- **Repair mechanism** — (A, chosen) drfx executes the allowlisted `r2p-reopen` / `r2p-gap-open` via the
  CLI and lets r2p own the mutation; (B) drfx only ever recommends the command and never executes it —
  rejected because the requirement's Phase 2/3 require controlled execution and a closed loop; (C) keep
  editing `03-07` directly behind a guard — rejected, this is exactly the behavior being reversed and it
  bypasses r2p's gates/checkpoints/regeneration.
- **Status source** — (A, chosen) read the env-gated `R2P_JSON` serialized contract; (B) scrape r2p
  human text — rejected as fragile and explicitly superseded by the requirement.
- **Target-key identity** — (A, chosen) a content-independent key over `projectRoot + routeKind=r2p +
  workId`, with `runMdSha256` and the review-set fingerprint kept in the manifest only as freshness
  gates; (B) fold content fingerprints into the key — rejected because the state dir would churn on
  every r2p regeneration, breaking receipt/review-history continuity across a gap-open + `r2p-continue`.
- **Lifecycle** — (A, chosen) add r2p-specific subcommands and block the file-set write/diff subcommands
  for this route; (B) overload `begin-fix`/`end-fix` to be no-ops for r2p — rejected as confusing and
  prone to silently re-enabling writes.
- **Manifest fields** — (A, chosen) replace the r2p editable-set fields with read-only review-set
  freshness fields (drop requirementDir-as-key-input, add `workId`); keep `runMdSha256` + an
  artifact-set fingerprint as freshness gates; (B) keep the old fields verbatim — rejected because they
  encode an editable set that no longer exists.

## Chosen Design

### DES-INPUT-001 workId invocation parser
Rewrite the r2p branch of `lib/input.js` to a workId grammar:
`review-fix-r2p workId=<WF-...> [read-only|review-and-fix] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`.
Accept one bare `WF-...` token as shorthand for `workId=`. Keep parsing strict: duplicate `workId=`,
more than one bare workId, `read-only`+`review-and-fix`, `resume`+`reset`, and `rounds=` without
`review-and-fix` are errors. Reject `target=<anything>` (including `.req-to-plan/...` and `07-plan.md`)
and any bare path with the single message `Blocked: review-fix-r2p expects workId=<WF-...>, not a path.`;
reject `ref=/scope=/base=/assurance=/ledger=/guard=/strict/normal` as tokens not valid for this route.
The `workId` VALUE itself is strictly shaped: it must match `^WF-[A-Za-z0-9._-]+$` (WF-prefixed, no path
separator `/` or `\`, no `..`, no leading `-`/`--`, NUL-free, length-bounded). A value failing this —
including a path-shaped value (e.g. `archive/WF-foo`, `../../x`) or a flag-shaped value (e.g.
`--from=...`) — is rejected as an invalid invocation, never resolved. This shape rule is load-bearing
for safety: it closes path traversal, defeats archive-bypass via a multi-segment workId (a single
segment cannot name `archive/<run>`), and prevents argv flag-injection when the workId is later passed
as the value of `r2p-reopen --from` / `r2p-gap-open --work-id`. On any parse error emit the blocked
result
`{ status:'blocked', blockingReason:'invalid-r2p-invocation', nextAction:'rerun as review-fix-r2p workId=<WF-...>' }`.
`debug` (currently documented but unimplemented) becomes a parsed boolean that only raises diagnostic
verbosity and must never relax preflight, read-only, or PASS rules.

### DES-PREFLIGHT-001 fail-closed preflight chain
A new ordered preflight runs after parsing and before any review work, drfx state, reviewer run, or r2p
command. Steps, each blocking with its own reason/nextAction: (1) resolve `r2p-status`, `r2p-reopen`,
`r2p-gap-open`, `r2p-continue` via PATH then `~/.req-to-plan/bin` (`r2p-command-unavailable`), then
probe `R2P_JSON` by running a read-only status command and confirming the documented JSON payload
(`r2p-json-contract-unavailable`); (2) project root from `root=` else cwd — exists, dir, not symlink
(`invalid-project-root`); (3) `<root>/.req-to-plan` exists and is a real dir
(`r2p-workspace-not-found` / `unsafe-r2p-workspace`); (4) workId active/archive resolution over
`<root>/.req-to-plan/<workId>` vs `<root>/.req-to-plan/archive/<workId>`
(`r2p-run-archived` / `r2p-work-id-conflict` / `r2p-run-not-found`) — resolution operates only on a
validated single-segment workId (DES-INPUT-001), and `activeDir` / `archiveDir` are each realpath-resolved
and asserted to be a DIRECT child of `<root>/.req-to-plan` and `<root>/.req-to-plan/archive` respectively,
so no `..`- or `archive/`-bearing value can reach a sibling or archived run (defense in depth behind the
DES-INPUT-001 shape rule); (5) run dir is a dir and not a symlink (`unsafe-r2p-run-dir`); (6) `run.md`
and `03-07` each exist as regular non-symlink files (`r2p-artifact-missing-or-unsafe`).

### DES-RESOLVE-001 workId-based read-only resolver
Add `resolveR2pWorkIdTarget({ projectRoot, workId })` (replacing the path-based `resolveR2pTarget`),
returning: `reviewFiles` = `03-07`, `protectedDependencies` = `['run.md']`, `editableFiles` = `[]`,
the resolved `runDir` / `runLocation`, `runMdSha256`, and an artifact-set (review-set) fingerprint over
`03-07`. The target key comes from a new `deriveR2pTargetKey({ projectRoot, workId })` that follows the
existing `deriveTargetKey` convention (a `slug-hash12` produced from a domain-separated SHA-256 of
`r2p`, the realpath project root, and the workId) and is independent of any `run.md` / `03-07` content,
so the state dir is stable across r2p regeneration of the same workId. The content fingerprints remain
manifest-only freshness gates.

### DES-LIFECYCLE-001 r2p-specific lifecycle
Route r2p through `start -> context -> record-review -> record-triage -> record-r2p-repair-plan ->
apply-r2p-repair -> finalize/checkpoint`. `context` reports `routeKind:'r2p'`, `workId`, `runDir`,
`runLocation`, `reviewFiles` (`03-07`), `protectedDependencies:['run.md']`, `editableFiles:[]`,
`directArtifactWrites:'forbidden'`, and the resolved `repairMode`. Add two subcommands to
`lib/workflow/index.js`: `record-r2p-repair-plan` (validate the plan, write a receipt) and
`apply-r2p-repair` (run the allowlisted command). Block the write/diff subcommands (`begin-fix`,
`refresh-lock`, `end-fix`, `abort-fix`, `record-diff-review`) and any direct artifact write for the r2p
route with `r2p-direct-artifact-write-forbidden`; r2p no longer dispatches to
`runFileSetFixLifecycleCommand` / `runFileSetRecordDiffReview`.

### DES-STATUS-001 status resolution and finding mapping
Read run `status`, `current_stage`, and `open_routes_detail[]` (each with `owner_stage`) by running
`r2p-status --all` with `R2P_JSON=1` and selecting the entry whose `work_id` matches (never
`r2p-switch`). Map to repair mode: `closed_at_plan_checkpoint` / `executing` -> reopen; open run with a
finding owned strictly upstream of `current_stage` -> gap-open; open run with an owner==`current_stage`
finding -> checkpoint `r2p-current-stage-repair-required`; anything else ->
`r2p-run-status-unsupported`. Map each finding to an `ownerStage` over the six `STAGE_ORDER` values via
the requirement's finding-type table; `reason` / `required-action` must be single-line, non-empty,
length-bounded, NUL-free, and contain no embedded shell command.

### DES-PLAN-001 repair-plan schema, validation, aggregation
`record-r2p-repair-plan` builds and validates one repair plan per round: `issue_id`s come from accepted
findings; exactly one `command_kind` (`r2p-reopen` or `r2p-gap-open`); `owner_stage` is a valid stage;
`reason` / `required_action` pass the string rules. Aggregation applies the status mapping first, then
collapses accepted findings into a single command at the EARLIEST repairable `STAGE_ORDER` stage,
recording every aggregated `issue_id`. An open run with no accepted finding strictly upstream of
`current_stage` yields the current-stage checkpoint (no plan). Block `r2p-repair-plan-ambiguous` only
when, after the status mapping, accepted findings still cannot map to valid owner stages or one allowed
command.

### DES-EXEC-001 allowlisted execution, drift guard, redacted receipt
A new `lib/workflow/r2p-repair.js` owns: command resolution, the `R2P_JSON` contract probe, the
status read/parse, plan validation + earliest-stage aggregation, and execution. `apply-r2p-repair`
runs `r2p-reopen` / `r2p-gap-open` via `execFile`-style argv arrays with `shell:false` and `R2P_JSON=1`
(passing `--confirm` on gap-open, defensively, since it is inert in v0.7.3). Immediately before
execution an always-on drift guard re-checks: the four commands still resolve; the active run still
exists and the archive run still does not; the `run.md` + `03-07` fingerprints are unchanged since
review/triage; and the live `R2P_JSON` status still matches the plan's `command_kind` — any mismatch
blocks instead of executing. A redacted receipt is persisted to target-local state: command, a reduced
single-line argv with `reason`/`required-action` redacted, exit code, redacted stdout/stderr, the
captured `newWorkId` (reopen) or `route_id` / `staled_stages` (gap-open), and `nextAction`. Receipts
never store raw prompts, transcripts, secrets, or large artifact bodies.

### DES-PASS-001 PASS semantics, linkage, state, Gemini
A round that executed a repair command finalizes at a checkpoint
(`Final status: checkpoint`, `Status reason: r2p-repair-applied`, `Coordinator agreement: none`) and
can never PASS. PASS is reachable only on a clean re-review of the current active run's regenerated
artifacts. `nextAction` instructs running `r2p-continue` until r2p finishes repair/gating/checkpoint/
regeneration, then rerunning `review-fix-r2p workId=<...>` (new workId after reopen, same after
gap-open). Target-local state under `.drfx/targets/<key>/` holds only review history and redacted
receipts; on reopen the new workId's `start` state records the prior workId and prior receipt id (the
receipt captured `newWorkId` at apply time); on gap-open the same key carries the receipt forward.
State lifecycle by token: `resume` continues the workId's existing target-local state (so a rerun links
the prior round's receipt); `reset` archives the existing target-local state and starts a fresh review
for the same workId; a one-shot `read-only` run without `resume`/`reset` stays no-state (review tokens
kept in memory only), matching the other routes. Gemini stays advisory-only and can never claim PASS.

### DES-DOCS-001 documentation and retirement
Rewrite `skills/review-fix-r2p/SKILL.md`, the `route-contract.r2p.*` and `invocation-gate.r2p.*`
fragments, `shared/prompts/coordinator.md`, and `shared/prompts/fixer.md` to the new model (workId
input, active-only, four required r2p commands, direct artifact writes forbidden, repair =
reopen/gap-open, checkpoint after repair, the fixer authors no file edits for this route), with no
legacy or migration language. Retire `lib/workflow/file-set-r2p-gate.js` and the four-checkpoint write
revalidation, removing all five r2p call sites across BOTH `lib/workflow/file-set-fix.js` and
`lib/workflow/file-set-finalize.js` (including the final-PASS `revalidateR2pGate` call and the
`file-set-r2p-gate` import in `file-set-finalize.js`) so no dangling import remains, and replace
`MANIFEST_V2_R2P_FILESET_FIELDS` with read-only review-set freshness fields
(drop the editable-set/requirementDir-as-key semantics, add `workId`; keep `runMdSha256` and an
artifact-set fingerprint as freshness gates), keeping `manifestV2FieldsForKind` valid for the six
non-r2p routes.

## Decision Requests

none

## Rollback

drfx ships as the versioned npm package `@xenonbyte/drfx`; the rollback unit is the release/commit, not
in-product data. Because the new route writes no files (empty editable set, read-only `03-07` + `run.md`),
there is no drfx-authored artifact state to undo on rollback. The one externally visible side effect is
an r2p mutation (a `WF-...-rN` fork from reopen, or an open route from gap-open); these are r2p-owned and
are intentionally NOT reverted by drfx — they are unwound through r2p's own commands
(`r2p-gap-resolve`, archive, or normal continuation), which is consistent with the ownership boundary.
Target-local drfx state (review history + receipts) is removable per target key without affecting r2p.
Reverting the release restores the prior route; no migration is needed because no new persistent schema
is depended upon for old runs.

## Observability

- Every blocked path returns a structured `{ status:'blocked', blockingReason, nextAction }` (or the
  checkpoint analog), so failures are self-describing.
- The `commandLog` records each r2p command invocation (already the convention for `runGit`).
- The redacted receipt is the durable audit record of any executed repair (command, reduced argv, exit
  code, redacted output, `newWorkId`/`route_id`, `nextAction`).
- The drift guard emits a specific blocking reason on each drift class (command unresolved, run
  archived/missing, fingerprint drift, status mismatch).
- `debug` raises diagnostic verbosity (resolved command paths, parsed JSON keys, fingerprint values)
  without changing control flow or relaxing any gate.

## SPEC Handoff

SPEC must specify, as observable behavior contracts with a test matrix mapping to the requirement's 11
verification gates:

- DES-INPUT-001: accepted/rejected token tables and the exact `invalid-r2p-invocation` blocked payload;
  bare-workId shorthand; every strict-parse error case.
- DES-PREFLIGHT-001: each of the six ordered checks, the exact `blockingReason`/`nextAction` strings,
  ordering (command env first, including the `R2P_JSON` probe), the workId shape rule and the
  single-segment / direct-child containment assertion for `activeDir`/`archiveDir`, and the exact
  `R2P_JSON` probe pass/fail predicate (the payload must parse as JSON and contain a minimal key set —
  e.g. `status` + `current_stage` — to count as honoring the contract; otherwise
  `r2p-json-contract-unavailable`).
- DES-RESOLVE-001: the read-only review set, empty editable set, the content-independent key contract
  (same workId -> same key across regeneration; reopen -> new key), and which fingerprints are
  manifest-only freshness gates.
- DES-LIFECYCLE-001: the r2p subcommand set, the `context` payload fields, and the
  `r2p-direct-artifact-write-forbidden` block for every write/diff subcommand and direct write; Gate 5
  must test BOTH directions — a drfx-driven change to `03-07`/`run.md` fails, while a change to those
  files made by r2p itself (an allowlisted command side effect) is permitted/expected and is not a
  failure.
- DES-STATUS-001: the `R2P_JSON` parse contract (`status` / `current_stage` / `open_routes_detail[]`),
  the four repair-mode outcomes, and the finding-to-owner-stage table.
- DES-PLAN-001: the repair-plan schema, validation rules, earliest-stage aggregation, the
  current-stage-checkpoint case, and the `r2p-repair-plan-ambiguous` boundary.
- DES-EXEC-001: argv-array + `shell:false` + `R2P_JSON=1` + `--confirm`-on-gap-open execution; the
  drift-guard re-checks; the redacted-receipt field list and redaction rules; capture of
  `new_work_id` / `route_id`.
- DES-PASS-001: checkpoint-after-repair (cannot PASS same round), PASS-only-on-clean-rerun, receipt
  linkage across reopen vs gap-open, the `resume` (continue state) / `reset` (archive + fresh) /
  read-only-no-state lifecycle behavior, and Gemini advisory-only.
- DES-DOCS-001: the documentation gate — SKILL.md, route-contract/invocation-gate fragments,
  coordinator.md, fixer.md describe only the new model with no legacy/migration language; the retired
  machinery and changed manifest fields.
- Test fixtures: fake r2p binaries that emit the documented `R2P_JSON` payloads for reopen / gap-open /
  status, used by the repair-execution and status-contract gates.

## Trace

| This ID | Upstream | Status |
|---|---|---|
| DES-INPUT-001 | SCOPE-IN-001, SCOPE-IN-002 | addressed |
| DES-PREFLIGHT-001 | SCOPE-IN-003 | addressed |
| DES-RESOLVE-001 | SCOPE-IN-004 | addressed |
| DES-LIFECYCLE-001 | SCOPE-IN-005 | addressed |
| DES-STATUS-001 | SCOPE-IN-006, SCOPE-IN-007 | addressed |
| DES-PLAN-001 | SCOPE-IN-008 | addressed |
| DES-EXEC-001 | SCOPE-IN-009 | addressed |
| DES-PASS-001 | SCOPE-IN-010 | addressed |
| DES-DOCS-001 | SCOPE-IN-011 | addressed |
<!-- /r2p-read-only -->

## Project Context (read-only)
# Project Context Pack

- repo_root: `/Users/xubo/x-studio/document-review-fix`
- languages: {'JavaScript': 54039}
- package_managers: npm
- test_commands: ['npm test']
- entrypoints: ['lib/workflow/index.js']
- config_files: none
- dependencies (0): none
- source_dirs: ['bin', 'docs', 'lib', 'requirements', 'scripts', 'shared', 'skills', 'templates', 'test']
<!-- /r2p-read-only -->
