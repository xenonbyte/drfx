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

## Upstream Summary (read-only)
# Requirement Brief

## Goal

Make the `review-fix-r2p` route conform to req-2-plan's lifecycle boundary so that drfx
**diagnoses** r2p artifacts but **only r2p repairs** them. The route stops treating the r2p-owned
`03-07` documents as an editable file set and instead takes an r2p `workId`, reviews the active run's
artifacts read-only, and — in review-and-fix mode — performs repair solely by invoking the official
r2p lifecycle commands (`r2p-reopen` / `r2p-gap-open`). This is an intentional reversal of the shipped
edit-in-place behavior, delivered with no backward compatibility and no state migration.

## In-Scope

- SCOPE-IN-001 workId invocation grammar: accept `workId=<WF-...>` and a single bare `WF-...` token as
  shorthand; support the full token set `[read-only|review-and-fix] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`;
  keep parsing strict (duplicate `workId=`, multiple bare workIds, `read-only`+`review-and-fix`,
  `resume`+`reset`, and `rounds=` without `review-and-fix` are errors); emit the exact
  `invalid-r2p-invocation` blocked result on any parse error.
- SCOPE-IN-002 token rejection: reject `target=<anything>` (including `.req-to-plan/WF-...`,
  `.req-to-plan/archive/WF-...`, and `07-plan.md`) and any bare path token with the single message
  `Blocked: review-fix-r2p expects workId=<WF-...>, not a path.`; reject `ref=`, `scope=`, `base=`,
  `assurance=`, `ledger=`, `guard=`, `strict`, and `normal` as tokens not valid for this route.
- SCOPE-IN-003 fail-closed preflight chain, run in order before any review work, drfx state, reviewer
  run, or r2p command: resolve the four required r2p commands (`r2p-status`, `r2p-reopen`,
  `r2p-gap-open`, `r2p-continue`) via PATH then `~/.req-to-plan/bin` and probe the `R2P_JSON` JSON
  contract; validate the project root, the `.req-to-plan` workspace, the workId active/archive
  resolution, the run directory, and the six artifacts — each failure blocking with its stated
  `blockingReason` / `nextAction`.
- SCOPE-IN-004 whole-run read-only treatment: `run.md` and all of `03-07` are review evidence only and
  never enter a drfx editable set; no drfx code path may write, delete, rename, or restore any of them;
  side effects produced by an allowlisted r2p command are recorded as r2p command side effects, not as
  drfx artifact edits.
- SCOPE-IN-005 r2p-specific workflow lifecycle replacing the file-set write-and-diff lifecycle:
  `start -> context -> record-review -> record-triage -> record-r2p-repair-plan -> apply-r2p-repair ->
  finalize/checkpoint`; the `context` step reports `routeKind: "r2p"`, the workId, run location, the
  `03-07` review files, `protectedDependencies: ["run.md"]`, `editableFiles: []`,
  `directArtifactWrites: "forbidden"`, and the resolved repair mode; any direct-write entry blocks with
  `r2p-direct-artifact-write-forbidden`.
- SCOPE-IN-006 status-to-repair-mode resolution: read run `status`, `current_stage`, and open-route
  owner stages from the `R2P_JSON` status contract (read-only, via `--all` filtered by `work_id`, never
  `r2p-switch`) and map them to the repair mode — reopen for closed/executing runs, gap-open for an open
  run with an owner stage strictly upstream of `current_stage`, a `r2p-current-stage-repair-required`
  checkpoint for an owner==current-stage finding, and `r2p-run-status-unsupported` otherwise.
- SCOPE-IN-007 finding-to-owner-stage mapping over the six valid r2p stages (`raw_requirement`,
  `requirement_brief`, `risk_discovery`, `design`, `spec`, `plan`); `reason` / `required-action` must be
  single-line, non-empty, length-bounded, NUL-free, and free of any embedded shell command.
- SCOPE-IN-008 repair-plan schema, validation, and earliest-stage aggregation: one `command_kind`
  (`r2p-reopen` or `r2p-gap-open`) per round; accepted findings aggregate into a single command at the
  earliest repairable stage in `STAGE_ORDER` with every aggregated `issue_id` recorded; block with
  `r2p-repair-plan-ambiguous` only when accepted findings still cannot be mapped to valid owner stages
  or one allowed command after the status mapping.
- SCOPE-IN-009 allowlisted r2p command execution: run `r2p-reopen` / `r2p-gap-open` via an argv array
  with `shell: false` and `R2P_JSON=1` (passing `--confirm` on gap-open) behind an always-on
  pre-execution drift guard (commands still resolve; the active run still exists; the archive run still
  does not; `run.md` + `03-07` fingerprints unchanged since review; live status still matches the plan's
  `command_kind`); write a redacted receipt capturing the command, reduced argv, exit code, redacted
  output, captured `newWorkId` / `route_id`, and `nextAction`.
- SCOPE-IN-010 PASS and state semantics: checkpoint-after-repair (`Final status: checkpoint`,
  `Status reason: r2p-repair-applied`) that can never PASS in the same round; PASS only on a clean
  re-review of regenerated artifacts; read-only target-local state holding review history and repair
  receipts under a content-independent target key (a stable hash of `projectRoot` + `routeKind=r2p` +
  `workId`); receipt linkage across reopen (new workId, new key) and gap-open (same workId, same key);
  Gemini stays advisory-only and can never claim PASS.
- SCOPE-IN-011 documentation and retirement: rewrite `skills/review-fix-r2p/SKILL.md`, the
  `route-contract.r2p.*` fragments, `shared/prompts/coordinator.md`, and `shared/prompts/fixer.md` to the
  new model, and retire the `lib/workflow/file-set-r2p-gate.js` write-guard machinery and the MANIFEST
  V2 r2p editable-set fields, with no legacy or migration language anywhere.

## Out-of-Scope

- SCOPE-OUT-001 compatibility with the earlier `review-fix-r2q` design.
- SCOPE-OUT-002 migration of prior r2p / r2q `.drfx/targets` state.
- SCOPE-OUT-003 accepting `target=<requirement-dir>` as an entry point.
- SCOPE-OUT-004 accepting a raw `.req-to-plan/WF-*` path as input.
- SCOPE-OUT-005 accepting a `07-plan.md` file path as input.
- SCOPE-OUT-006 reviewing an archived run.
- SCOPE-OUT-007 auto-promoting an archived run back to active.
- SCOPE-OUT-008 auto-running `r2p-continue`, `r2p-execute`, or `r2p-archive`.
- SCOPE-OUT-009 any drfx-driven edit of `03-07` or `run.md`.
- SCOPE-OUT-010 treating r2p artifacts as an ordinary document or file-set fix target.
- SCOPE-OUT-011 legacy-behavior or migration language in docs, skills, or route contracts.

## Non-Goals

- Not changing the review power or the rubric stack: the route still reviews whether `07-plan.md` is a
  reliable execution plan and whether it is consistent with its upstream `03-06` documents. Only the
  repair model changes.
- Not modifying req-2-plan itself. drfx only consumes the installed r2p CLI and its `R2P_JSON` serialized
  contract; r2p remains the sole owner of reopen / gap routing, gates, checkpoints, and regeneration.
- Not depending on a future `r2p-status --json` flag. That earlier premise was incorrect; the
  env-gated `R2P_JSON` contract already exists in the installed r2p and supersedes it.
- Not changing the other six review-fix routes (SPEC, PLAN, DESIGN, COMMON, PR, CODE).

## Assumptions

- The integration baseline is req-2-plan v0.7.3: the `R2P_JSON` env-gated JSON contract, the documented
  command signatures, the six-value `STAGE_ORDER`, and the currently-inert `--confirm` on `r2p-gap-open`.
  An older r2p that does not honor `R2P_JSON` is handled by the runtime contract probe
  (`r2p-json-contract-unavailable`), not assumed away.
- The r2p binaries live at `~/.req-to-plan/bin` and are not on `PATH`, so command resolution must try
  `PATH` first and then that directory.
- r2p enforces one open route per run, `r2p-reopen` forks a new `WF-...-rN` run, and both reopen and
  gap-open stale every stage from the owner stage down to `current_stage`; these facts justify
  aggregating a round's findings into one command at the earliest repairable stage.
- The drfx workflow runner can spawn a child process with an argv array and `shell: false` and capture
  its stdout / stderr, which the allowlisted execution and receipt depend on.

## Acceptance Criteria

- AC-001 (invocation): `workId=WF-...` and a bare `WF-...` are accepted; `target=...`, a raw
  `.req-to-plan/...` path, `07-plan.md`, and `ref/scope/base/assurance/ledger/guard/strict/normal` are
  rejected; duplicate/conflicting tokens are rejected. [SCOPE-IN-001, SCOPE-IN-002]
- AC-002 (command environment): missing any of the four r2p commands blocks with
  `r2p-command-unavailable`; an r2p that does not honor `R2P_JSON` blocks with
  `r2p-json-contract-unavailable`; all four present and honoring the contract passes. [SCOPE-IN-003]
- AC-003 (workspace): a missing or symlinked `.req-to-plan`, a missing active workId, an archive-only
  workId, and an active+archive conflict each block; a real active workId passes. [SCOPE-IN-003]
- AC-004 (artifacts): a missing or symlinked `run.md` or any of `03-07` blocks; all six present as
  regular files passes. [SCOPE-IN-003]
- AC-005 (no direct write): the direct-write fix lifecycle is blocked for this route, and any test that
  observes a drfx-driven change to `03-07` or `run.md` fails, while a change made by r2p itself does not.
  [SCOPE-IN-004, SCOPE-IN-005]
- AC-006 (status contract): `status`, `current_stage`, and owner stages are resolved from the `R2P_JSON`
  payload (not prose), and a fixture with multiple open-route owner stages parses deterministically.
  [SCOPE-IN-006]
- AC-007 (current stage): an open run with an owner==`current_stage` finding calls neither gap-open nor
  reopen and checkpoints with `r2p-current-stage-repair-required`. [SCOPE-IN-006]
- AC-008 (repair execution): a closed-run finding drives `r2p-reopen` and captures `new_work_id`; an
  open-run upstream-gap finding drives `r2p-gap-open` (with `--confirm`) and captures `route_id`;
  commands run via argv array with `shell: false`; the round ends at a checkpoint and cannot PASS; the
  `nextAction` names `r2p-continue` and the correct rerun workId. [SCOPE-IN-008, SCOPE-IN-009]
- AC-009 (aggregation): after the status mapping, accepted findings spanning multiple owner stages
  produce one command at the earliest repairable `STAGE_ORDER` stage with all `issue_ids` in the
  receipt; only post-mapping failures block with `r2p-repair-plan-ambiguous`. [SCOPE-IN-008]
- AC-010 (rerun PASS): after regenerated artifacts re-review clean the route can PASS, and after a
  repair command in the same round it cannot PASS; Gemini can never PASS. [SCOPE-IN-010]
- AC-011 (documentation): SKILL.md, the route-contract fragments, coordinator.md, and fixer.md describe
  only the new model and contain no legacy or migration language. [SCOPE-IN-011]

## Open Questions

No requirement-level ambiguity remains; the raw requirement resolves the previously open design points
(target-local state model, receipt linkage, target-key identity, and the `R2P_JSON` status contract)
explicitly. The following are implementation details intentionally deferred to the DESIGN stage, not
unresolved scope questions:

- The exact construction of the content-independent target key hash (algorithm and canonical input
  form), given the fixed inputs `projectRoot` + `routeKind=r2p` + `workId`.
- The precise behavior of the `[debug]` token (diagnostic verbosity only; it must not relax preflight,
  read-only, or PASS rules).
- The on-disk format and location of the redacted repair receipt within target-local state, consistent
  with the redaction rules in the requirement.

## Sources

- `00-raw-requirement.md` in this run — the authoritative requirement (Background, Goal, Scope,
  Grounding facts, R1-R11, Phasing, and the Checkpoints/verification gates).
- The requirement's Grounding facts and References sections, verified against the req-2-plan source at
  `~/x-skills/req-to-plan` (v0.7.3) and the installed CLI on 2026-06-27: `tools/workflow_cli/output.py`
  (`is_json_mode` / `R2P_JSON`), `tools/workflow_cli/cli.py` (`_cmd_status_run`, `_cmd_gap_open`,
  reopen, `STAGE_ORDER`), `tools/workflow_cli/agent_shortcuts.py`, and `tools/workflow_cli/models.py`
  (`Stage`, `RunStatus`).
- This repository's named change surface: `lib/input.js`, `lib/routes.js`, `lib/target-context.js`,
  `lib/workflow/target-resolution.js`, `lib/workflow/file-set-fix.js`, `lib/workflow/index.js`,
  `lib/workflow/file-set-r2p-gate.js`, `skills/review-fix-r2p/SKILL.md`, the `route-contract.r2p.*`
  fragments, `shared/prompts/coordinator.md`, and `shared/prompts/fixer.md`.

## Trace

| This ID | Upstream | Status |
|---|---|---|
| SCOPE-IN-001 | raw_requirement: R1 (invocation grammar) | derived |
| SCOPE-IN-002 | raw_requirement: R1 (token rejection) | derived |
| SCOPE-IN-003 | raw_requirement: R2 (preflight) | derived |
| SCOPE-IN-004 | raw_requirement: R3 (read-only evidence) | derived |
| SCOPE-IN-005 | raw_requirement: R8 (workflow lifecycle) | derived |
| SCOPE-IN-006 | raw_requirement: R4 (status to repair mode) | derived |
| SCOPE-IN-007 | raw_requirement: R5 (finding to owner stage) | derived |
| SCOPE-IN-008 | raw_requirement: R6 (repair-plan schema) | derived |
| SCOPE-IN-009 | raw_requirement: R7 (command execution) | derived |
| SCOPE-IN-010 | raw_requirement: R9 (PASS semantics) + R8 (state) | derived |
| SCOPE-IN-011 | raw_requirement: R10 (change surface) + R11 (no migration) | derived |
| SCOPE-OUT-001..011 | raw_requirement: Scope non-goals + R11 | derived |
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
