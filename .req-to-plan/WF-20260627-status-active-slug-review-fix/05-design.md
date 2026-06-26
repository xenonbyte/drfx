---
r2p_stage: design
r2p_version: 2
r2p_status: approved
r2p_created_at: 2026-06-26T17:42:16.338351+00:00
r2p_updated_at: 2026-06-26T17:58:56.307341+00:00
---

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

## Upstream Summary (read-only)
# Risk Discovery

## Risks

### RISK-DEP-001 req-2-plan and the R2P_JSON contract are hard runtime dependencies
The route cannot function without the installed r2p CLI and its `R2P_JSON` serialized contract. A
missing binary, an r2p too old to honor `R2P_JSON`, or a future change to the JSON shape
(`status` / `current_stage` / `open_routes_detail[]` / `new_work_id` / `route_id` / `staled_stages`)
would break status resolution, mapping, or capture.
Status: mitigated
Impact: high. Likelihood: medium.

### RISK-SEC-001 command execution is an injection and traversal surface
Invoking `r2p-reopen` / `r2p-gap-open` with attacker-influenced `reason` / `required-action`, workId,
or owner-stage could inject shell commands or traverse outside the workspace if a shell string or an
unvalidated path/stage were used.
Status: mitigated
Impact: high. Likelihood: low.

### RISK-WRITE-001 accidental drfx writes to the now read-only run
The whole point of the refactor is that drfx never writes `03-07` or `run.md`. A lingering code path
from the old file-set lifecycle could still write, delete, rename, or restore one of these files and
silently regress the governing principle.
Status: mitigated
Impact: high. Likelihood: medium.

### RISK-DRIFT-001 the read-only run drifts between review and repair
Between context capture / review and command execution, the artifacts can regenerate, the run can be
archived, or the live status can change, so a repair command would act on stale findings or an invalid
state.
Status: mitigated
Impact: high. Likelihood: medium.

### RISK-CROSS-001 coupling to r2p lifecycle semantics across project boundaries
The repair logic depends on cross-project facts owned by r2p: gap-open requires a strictly-upstream
owner, only one open route per run is allowed, reopen forks `WF-...-rN`, both reopen and gap-open stale
every stage from the owner to `current_stage`, and `--confirm` is currently inert. A future r2p that
changes any of these invalidates the mapping and earliest-stage aggregation.
Status: mitigated
Impact: medium. Likelihood: medium.

### RISK-DATA-001 repair receipts could leak secrets or large artifact bodies
Receipts capture command, argv, and stdout/stderr. Without redaction they could persist secrets,
raw subagent transcripts, or large artifact bodies into target-local drfx state.
Status: mitigated
Impact: medium. Likelihood: low.

### RISK-PASS-001 a repair round could falsely claim PASS
If checkpoint-after-repair is not enforced, a round that issued `r2p-reopen` / `r2p-gap-open` could
report PASS from the command result, defeating "PASS only on a clean re-review of regenerated
artifacts".
Status: mitigated
Impact: high. Likelihood: low.

### RISK-MIG-001 retiring old machinery can break shared manifest, uninstall, and other routes
Removing `lib/workflow/file-set-r2p-gate.js` and the MANIFEST V2 r2p editable-set fields touches code
and a manifest schema shared with the six non-r2p routes. A careless removal could break manifest
parsing, install/uninstall, or another route, and there is no compatibility shim for old r2p/r2q
`.drfx/targets` state by design.
Status: mitigated
Impact: high. Likelihood: medium.

## Boundaries

- Ownership boundary: drfx owns diagnosis (review, triage, finding-to-owner-stage mapping, the repair
  plan, and the audit receipt); r2p owns all artifact mutation — reopen / gap routing, gates,
  checkpoints, and regeneration. drfx never authors content into `03-07` or `run.md`.
- Read-only boundary: `run.md` and `03-07` are review evidence only and never enter a drfx editable
  set; the only permitted mutations of the run are side effects of an allowlisted r2p command.
- Execution boundary: drfx may invoke only the read-only `r2p-status` and the two mutating verbs
  `r2p-reopen` / `r2p-gap-open`, always via an argv array with `shell: false`; every other r2p verb
  (including `r2p-continue`, `r2p-execute`, `r2p-archive`, `r2p-switch`, `r2p-gap-resolve`,
  `r2p-tier-lock`, `r2p-start`) is forbidden to drfx.
- Activation boundary: only an active `.req-to-plan/<workId>/` is in range; archived runs are out of
  range and are never promoted back to active.
- State boundary: target-local state under `.drfx/targets/<target-key>/` holds only review history and
  redacted repair receipts; it carries no editable set and no diff.

## Scope Overflow Risks

- Re-introducing `review-fix-r2q` compatibility or an in-place edit path while building the new model
  would re-couple drfx to artifact mutation; this is explicitly excluded (SCOPE-OUT-001, SCOPE-OUT-009,
  SCOPE-OUT-010).
- Migrating or reading prior r2p / r2q `.drfx/targets` state, or adding migration language to docs and
  skills, would expand the change beyond the read-only repair model (SCOPE-OUT-002, SCOPE-OUT-011).
- Accepting legacy path-based inputs "just in case" — `target=<requirement-dir>`, a raw
  `.req-to-plan/WF-*` path, or a `07-plan.md` path — would defeat the workId-only grammar
  (SCOPE-OUT-003, SCOPE-OUT-004, SCOPE-OUT-005).
- Auto-running `r2p-continue` / `r2p-execute` / `r2p-archive` to "finish the loop" would cross the
  ownership boundary and let drfx drive r2p's lifecycle (SCOPE-OUT-008).

## Mitigations

- RISK-DEP-001: fail-closed preflight resolves the four required commands (PATH then
  `~/.req-to-plan/bin`) and probes the `R2P_JSON` contract, blocking with `r2p-command-unavailable` or
  `r2p-json-contract-unavailable`; the integration baseline is pinned to v0.7.3 and the JSON is parsed
  defensively against the documented keys.
- RISK-SEC-001: execute with an argv array and `shell: false` (never a shell string); validate workId,
  owner-stage (against the six-value stage enum), and reason / required-action (single-line, non-empty,
  length-bounded, NUL-free, no embedded shell command); restrict the mutating allowlist to exactly
  `r2p-reopen` and `r2p-gap-open`.
- RISK-WRITE-001: the r2p route declares an empty editable set, blocks the direct-write fix lifecycle
  with `r2p-direct-artifact-write-forbidden`, and is covered by tests that fail on any drfx-driven
  change to `03-07` or `run.md` while allowing a change made by r2p itself.
- RISK-DRIFT-001: an always-on pre-execution drift guard re-checks command resolution, active-run
  presence, archive-run absence, the `run.md` + `03-07` fingerprints, and the live `R2P_JSON` status
  against the plan's `command_kind`, blocking instead of executing on any mismatch.
- RISK-CROSS-001: the cross-project facts are verified and recorded as grounding facts, `--confirm` is
  passed defensively on gap-open, the contract probe gates an incompatible r2p, and the coupling is
  documented so a future r2p change is caught early.
- RISK-DATA-001: receipts record only the command, a reduced single-line argv with reason /
  required-action redacted, the exit code, redacted stdout/stderr, the captured `newWorkId` /
  `route_id`, and the `nextAction` — never raw prompts, transcripts, secrets, or large artifact bodies.
- RISK-PASS-001: a round that issued a repair command ends at a checkpoint (`Status reason:
  r2p-repair-applied`) and cannot PASS; PASS is reachable only on a clean re-review of regenerated
  artifacts, and Gemini stays advisory-only.
- RISK-MIG-001: the removal is scoped to r2p-only machinery and manifest fields, the manifest schema
  stays valid for the six non-r2p routes, and install / uninstall / manifest round-trip and the other
  routes are covered by the existing test suite plus targeted tests; no compatibility or migration path
  is provided, by design.

## Trace

| This ID | Upstream | Status |
|---|---|---|
| RISK-DEP-001 | brief: SCOPE-IN-003 / raw_requirement R2 | mitigated |
| RISK-SEC-001 | brief: SCOPE-IN-009 / raw_requirement R7 | mitigated |
| RISK-WRITE-001 | brief: SCOPE-IN-004 / raw_requirement R3 | mitigated |
| RISK-DRIFT-001 | brief: SCOPE-IN-009 / raw_requirement R7 | mitigated |
| RISK-CROSS-001 | brief: SCOPE-IN-006, SCOPE-IN-008 / raw_requirement R4, R6 | mitigated |
| RISK-DATA-001 | brief: SCOPE-IN-009 / raw_requirement R7 | mitigated |
| RISK-PASS-001 | brief: SCOPE-IN-010 / raw_requirement R9 | mitigated |
| RISK-MIG-001 | brief: SCOPE-IN-011 / raw_requirement R10, R11 | mitigated |
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
