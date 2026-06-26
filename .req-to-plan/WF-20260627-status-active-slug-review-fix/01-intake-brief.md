# Intake Brief

work_id: WF-20260627-status-active-slug-review-fix
requirement: ---
status: active
slug: review-fix-r2p-compliance
created_at: 2026-06-26
---

# review-fix-r2p compliance refactor: review-only, repair through the r2p lifecycle

## Background

`review-fix-r2p` exists to review the requirement-to-PLAN artifacts that `req-2-plan` (r2p)
generates. Its core judgement is whether a run's `07-plan.md` is a reliable execution plan, and
whether it is consistent with its upstream `03-06` documents (inconsistency, omission,
non-executability, weak verification, or an unresolved upstream decision gap).

The currently shipped route does this by treating the r2p-owned `03-07` documents as an ordinary
editable file set. It fixes findings by writing `03-requirement-brief.md`, `04-risk-discovery.md`,
`05-design.md`, `06-spec.md`, and `07-plan.md` in place, and carries `run.md` only as a protected
read-only gate. This behavior is real today, not hypothetical:

- `skills/review-fix-r2p/SKILL.md` documents `target=<requirement-dir>` and an in-place
  backward-fix write boundary of "the resolved `03-07` file set".
- `lib/workflow/target-resolution.js` resolves the route as a file set keyed on the requirement
  directory path.
- `lib/workflow/file-set-r2p-gate.js` makes `03-07` the writable members and `run.md` the protected
  read-only dependency, with a four-checkpoint gate revalidation around the writes.

Editing `03-07` directly, even behind a guard, bypasses r2p's own lifecycle: its stage gates,
checkpoints, reopen mechanics, upstream-gap routing, and artifact regeneration. r2p's model is that
each run lives in `<project-root>/.req-to-plan/<workId>/`, the CLI owns state, files, gates, and
structured validation, and the agent only authors semantic content. r2p already provides the
compliant repair entry points: `r2p-reopen` to reopen a closed or executing run for upstream repair,
and `r2p-gap-open` to route an upstream decision gap back to its owner stage on an open run.

This requirement changes the repair model, not the review power. The new governing principle is:

> review-fix-r2p may diagnose r2p artifacts, but only r2p may repair r2p artifacts.

Concretely: drfx reviews r2p artifacts and may trigger an official r2p repair command; r2p owns
reopen / gap routing, artifact updates, gates, checkpoints, and regeneration; drfx never edits
`03-07` or `run.md` directly.

This is an intentional reversal of the shipped edit-in-place behavior. It is also distinct from, and
not compatible with, the earlier `review-fix-r2q` design (a separate route that would edit `07-plan`
plus upstream docs in place). `review-fix-r2q` compatibility and any migration of prior r2p/r2q
`.drfx/targets` state are explicit non-goals here.

## Goal

Make `review-fix-r2p` conform to req-2-plan's lifecycle boundary:

1. The route takes an r2p `workId`, not a requirement-directory path.
2. It reviews only an active `.req-to-plan/<workId>/`, never an archived run.
3. It preflights the r2p command environment before doing anything else.
4. It preflights the project's `.req-to-plan` workspace and the specific `<workId>` directory.
5. `run.md` and `03-07` are all read-only evidence; nothing in the run is a drfx editable set.
6. In review-and-fix mode, "fix" means invoking `r2p-reopen` or `r2p-gap-open`, nothing else.
7. After a repair command runs, the route stops at a checkpoint and can never claim PASS in the same
   round.
8. PASS is only reachable by rerunning the route after `r2p-continue` regenerates the artifacts and
   the re-review is clean.
9. No backward compatibility, no old-state migration, and no migration language in docs or skills.

## Scope

### In scope

- New invocation grammar (`workId=<WF-...>` plus bare-workId shorthand) and rejection of the old
  path-based and document/file-set tokens.
- A fail-closed preflight chain (command environment, project root, workspace, active/archive
  resolution, run directory, artifacts).
- Read-only treatment of the entire run (`run.md` + `03-07`).
- An r2p-specific workflow lifecycle that replaces the write-and-diff-review lifecycle.
- Finding-to-owner-stage mapping and a validated repair-plan schema.
- Allowlisted, argv-array execution of `r2p-reopen` / `r2p-gap-open`, with a redacted audit receipt.
- Checkpoint-after-repair semantics and PASS-only-on-clean-rerun semantics.
- Documentation and template changes that describe only the new model.

### Out of scope (non-goals)

1. Compatibility with `review-fix-r2q`.
2. Migration of prior r2p/r2q `.drfx/targets` state.
3. Accepting `target=<requirement-dir>` as an entry point.
4. Accepting a raw `.req-to-plan/WF-*` path.
5. Accepting a `07-plan.md` file path.
6. Reviewing an archived run.
7. Auto-promoting an archived run back to active.
8. Auto-running `r2p-continue`, `r2p-execute`, or `r2p-archive`.
9. Editing `03-07` or `run.md` directly.
10. Treating r2p artifacts as an ordinary document or file-set fix target.

## Grounding facts (verified against the codebase and the installed r2p CLI)

These were verified against the req-2-plan source at `~/x-skills/req-to-plan` (v0.7.3) and the
installed CLI, on 2026-06-27, so the implementer does not have to re-derive them.

- The r2p CLI binaries are installed at `~/.req-to-plan/bin/` and are **not** on `PATH`. The plan's
  lookup order (PATH, then `~/.req-to-plan/bin`) is therefore correct and necessary. Present today:
  `r2p-status`, `r2p-reopen`, `r2p-gap-open`, `r2p-continue`, plus `r2p-start`, `r2p-execute`,
  `r2p-archive`, `r2p-switch`, `r2p-gap-resolve`, `r2p-tier-lock`, `r2p-task-brief`. Each is a thin
  shell wrapper over `python3 -m tools.workflow_cli.agent_shortcuts <verb>` in
  `@xenonbyte/req-2-plan`.
- Command signatures match the plan:
  - `r2p-reopen --from <work-id> --stage <stage> --reason <text>`
  - `r2p-gap-open --work-id <work-id> --owner-stage <stage> --required-action <text> [--confirm]`.
    The `--confirm` flag is accepted but currently inert: `cli.py:_cmd_gap_open` never reads it in
    v0.7.3, so gap-open mutates regardless (see R7 for why drfx still passes it).
  - `r2p-continue` exists.
- The owner-stage names in the plan's mapping are exactly the r2p `Stage` enum values:
  `raw_requirement`, `requirement_brief`, `risk_discovery`, `design`, `spec`, `plan`
  (`STAGE_ORDER` in `tools/workflow_cli/models.py`). The plan's mapping table is valid as written.
- Run statuses are real and include `closed_at_plan_checkpoint`, `executing`, and `archived`, plus
  many in-flight states (`active_stage_draft`, `entry_gate_failed`, `quality_gate_failed`,
  `ready_for_checkpoint_review`, `checkpoint_review`, `checkpoint_changes_requested`,
  `upstream_gap_routing`, `checkpoint_approved`, `next_stage`).
- Repair-mode constraints from `req-2-plan` `cli.py` (these refine the plan's section 7):
  - `r2p-reopen` applies to **closed or executing** runs and forks a new `WF-...-rN` directory.
  - `r2p-gap-open` is **open-runs-only** and requires `owner_stage` to be **strictly earlier** than
    the run's `current_stage` (`STAGE_ORDER.index(owner) < STAGE_ORDER.index(current)`); otherwise
    the command itself rejects the request (`cli.py:_cmd_gap_open`).
  - `r2p-gap-open` refuses when any route is already open (one open route per run at a time), so a
    round can route at most one gap. Both reopen and gap-open mark every stage from the owner down to
    `current_stage` stale for re-derivation. (These two facts back the R6 earliest-stage aggregation.)
- **Machine-readable status already exists (no `--json` flag, but an env-gated JSON contract).**
  `r2p-status` itself accepts only `--all`, but every r2p command emits a documented JSON payload when
  the `R2P_JSON=1` environment variable is set (`output.py:is_json_mode`). `status-run` (reached via
  `r2p-status`) returns `status`, `current_stage`, `open_routes`, and `open_routes_detail[]` (each with
  `route_id`, `from_stage`, `owner_stage`, `required_action`); `reopen` returns `new_work_id`;
  `gap-open` returns `route_id` and `staled_stages`. Reading this is the official serialized contract,
  not human-text scraping. To read a specific workId read-only, use `R2P_JSON=1 r2p-status --all` and
  select by `work_id` (never `r2p-switch`, which mutates the active pointer).

## Requirements

### R1. Invocation grammar

- Accept `review-fix-r2p workId=<WF-...>`.
- Accept a bare `WF-...` token as shorthand for `workId=<WF-...>` (at most one bare token).
- Full grammar:
  `review-fix-r2p workId=<WF-...> [read-only|review-and-fix] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`.
- Reject, with the single message `Blocked: review-fix-r2p expects workId=<WF-...>, not a path.`:
  `target=<anything>` (including `.req-to-plan/WF-...`, `.req-to-plan/archive/WF-...`, and
  `07-plan.md`), and any bare path token.
- Reject these tokens outright (not valid for this route): `ref=`, `scope=`, `base=`, `assurance=`,
  `ledger=`, `guard=`, `strict`, `normal`.
- Parsing stays strict: duplicate `workId=`, more than one bare workId, `read-only` together with
  `review-and-fix`, `resume` together with `reset`, and `rounds=<n>` without `review-and-fix` are all
  errors.
- On any invocation error, return:
  `{ "status": "blocked", "blockingReason": "invalid-r2p-invocation", "nextAction": "rerun as review-fix-r2p workId=<WF-...>" }`.
- No user-facing `guard=` token. The route writes no files, so there is nothing to authorize and no
  rollback boundary to choose; both `guard=git` and `guard=snapshot` are rejected as unknown tokens.
  Drift detection still happens, but it is internal and always on: before issuing a repair command the
  route fingerprints the read-only run (`run.md` + `03-07`) and blocks on any drift (R7). It is not a
  write guard and creates no rollback.

### R2. Preflight (fail-closed, in order)

Every check below must run before reading artifacts for review, creating drfx state, running the
reviewer, or executing any r2p command. Any failure blocks with the stated `blockingReason` and
`nextAction`.

1. **req-2-plan is a hard runtime dependency, checked first.** `review-fix-r2p` cannot run without
   req-2-plan. After invocation parsing (R1) and before any review work, drfx state, reviewer run, or
   r2p command, resolve `r2p-status`, `r2p-reopen`, `r2p-gap-open`, `r2p-continue` via PATH then
   `~/.req-to-plan/bin`. All four are required in all modes (chosen for a simple, consistent contract
   over per-mode subsetting). If req-2-plan is not installed or any command is missing, block
   immediately:
   `{ "blockingReason": "r2p-command-unavailable", "nextAction": "install req-2-plan and ensure r2p-status, r2p-reopen, r2p-gap-open, and r2p-continue are available, then rerun review-fix-r2p" }`.
   Presence is a hard block. Then probe the JSON contract (`r2pJsonContractAvailable`): invoke a
   read-only r2p command with `R2P_JSON=1` and confirm it returns the documented JSON payload. The
   installed v0.7.3 satisfies this; only an r2p too old to honor `R2P_JSON` fails it and blocks with
   `{ "blockingReason": "r2p-json-contract-unavailable", "nextAction": "upgrade req-2-plan to a version whose commands honor R2P_JSON, then rerun review-fix-r2p" }`.
2. **Project root.** `root=<project-root>` if given, else the current working directory. Must exist,
   be a directory, and not be a symlink. Failure:
   `{ "blockingReason": "invalid-project-root", "nextAction": "rerun with root=<project-root>" }`.
3. **`.req-to-plan` workspace.** `<projectRoot>/.req-to-plan` must exist and be a real directory.
   Missing: `{ "blockingReason": "r2p-workspace-not-found", ... }`. Symlink:
   `{ "blockingReason": "unsafe-r2p-workspace", ... }` (exact `nextAction` strings per the plan).
4. **workId active/archive resolution.** With
   `activeDir = <projectRoot>/.req-to-plan/<workId>` and
   `archiveDir = <projectRoot>/.req-to-plan/archive/<workId>`:
   - active exists, archive absent: continue.
   - active absent, archive exists: `{ "blockingReason": "r2p-run-archived", ... }`.
   - both exist: `{ "blockingReason": "r2p-work-id-conflict", ... }`.
   - neither exists: `{ "blockingReason": "r2p-run-not-found", ... }`.
5. **Run directory.** `activeDir` must be a directory and not a symlink. Failure:
   `{ "blockingReason": "unsafe-r2p-run-dir", ... }`.
6. **Artifacts.** `run.md`, `03-requirement-brief.md`, `04-risk-discovery.md`, `05-design.md`,
   `06-spec.md`, `07-plan.md` must each exist, be a regular file, and not be a symlink. Failure:
   `{ "blockingReason": "r2p-artifact-missing-or-unsafe", ... }`.

### R3. Read-only evidence

`run.md` and all of `03-07` are read-only review evidence. None of them may ever enter a drfx
editable set. The prohibition is on **drfx-internal filesystem operations**: no drfx code path may
write, delete, rename, or restore these files. Side effects produced by an allowlisted r2p lifecycle
command (R7) are permitted and expected, and are recorded as r2p command side effects, not as drfx
artifact edits. Tests must assert that a *drfx-driven* change to any of these files is a failure,
while an artifact change made by r2p itself is not.

### R4. Run status to repair mode

Run status, `current_stage`, and open-route owner stages come from the r2p JSON contract (invoke the
read-only status command with `R2P_JSON=1`; parse `status` / `current_stage` / `open_routes_detail[]`;
see Grounding facts). This is deterministic and available in every phase, so the mapping below applies
identically whether the route only recommends a command (Phase 1) or executes it (Phase 2/3):

- `closed_at_plan_checkpoint` or `executing`: `r2p-reopen --from <workId> --stage <ownerStage>
  --reason "<reason>"`. Forks a new `WF-...-rN` run.
- Open (in-flight) run, finding owned by a stage **strictly earlier** than `current_stage`:
  `r2p-gap-open --work-id <workId> --owner-stage <ownerStage> --required-action "<action>"`.
- Open run, finding owned by the **current stage** (e.g. a plan-local finding while `current_stage`
  is `plan`): gap-open is invalid (it requires a strictly upstream owner) and reopen does not apply to
  open runs. Call neither. Checkpoint with
  `{ "status": "checkpoint", "statusReason": "r2p-current-stage-repair-required", "nextAction": "run r2p-continue and repair the current stage through r2p's printed next command, then rerun review-fix-r2p" }`.
- Any other status that fits none of the above:
  `{ "blockingReason": "r2p-run-status-unsupported", "nextAction": "run r2p-continue or r2p-status to reach a repairable state, then rerun review-fix-r2p" }`.

### R5. Finding to owner stage

Findings map to an `ownerStage`, never to an editable file. Use this mapping (all targets are valid
`Stage` values):

| Finding type | ownerStage |
| --- | --- |
| Raw requirement conflicts with the PLAN direction | `raw_requirement` |
| Unclear scope, goal, non-goal, or acceptance direction | `requirement_brief` |
| Risk, rollback, migration, security, or dependency gap | `risk_discovery` |
| Architecture, interface, module-boundary, or implementation-strategy issue | `design` |
| Insufficient observable behavior, acceptance, or verification criteria | `spec` |
| PLAN task decomposition, ordering, execution command, or plan-local issue | `plan` |

`ownerStage` must be a valid r2p stage. `reason` / `required-action` must be single-line, non-empty,
length-bounded, contain no NUL, and contain no embedded shell command.

### R6. Repair-plan schema and validation

Before any r2p command runs, the route produces a structured repair plan (one `command_kind` per
round). Validation rules:

- `issue_id` must come from an accepted / reopened issue.
- `command_kind` is exactly `r2p-reopen` or `r2p-gap-open`.
- Only one `command_kind` per round.
- `owner_stage` must be a valid stage.
- `reason` (reopen) / `required_action` (gap-open) must be non-empty, single-line, length-bounded,
  NUL-free, and must not embed a shell command.

Multiple findings in one round: r2p allows only one repair action per run (gap-open refuses when any
route is already open; reopen forks per call), and both reopen and gap-open stale every stage from the
owner down to `current_stage`. Apply the R4 status mapping first. For a closed or executing run,
aggregate accepted findings into one `r2p-reopen` at the **earliest** owner stage in `STAGE_ORDER`. For
an open run whose earliest accepted owner stage is strictly upstream of `current_stage`, aggregate them
into one `r2p-gap-open` at that stage; the single `reason` / `required_action` summarizes them, and the
receipt's `issue_ids[]` lists every aggregated issue. For an open run with no accepted finding owned by
a stage strictly upstream of `current_stage`, do not create a repair plan; use the R4 checkpoint
`r2p-current-stage-repair-required`. Block as `r2p-repair-plan-ambiguous` only when accepted findings
still cannot be mapped to valid owner stages or one allowed command after the R4 status mapping.

### R7. r2p command execution

- Repair (mutating) allowlist: `r2p-reopen`, `r2p-gap-open` only.
- Read-only allowlist: `r2p-status` (invoked with `R2P_JSON=1` to resolve `repairMode` in R4, to run
  the R2.1 contract probe, and to re-read live status before execution; use `--all` then filter by
  `work_id`, never `r2p-switch`).
- Forbidden (drfx must never invoke): every other r2p verb, including `r2p-continue`, `r2p-execute`,
  `r2p-archive`, `r2p-start`, `r2p-gap-resolve`, `r2p-switch`, `r2p-tier-lock`.
- Execute with an argv array and `shell: false`; never build a shell command string.
- Invoke with `R2P_JSON=1` so the command returns the documented JSON payload (reopen: `new_work_id`;
  gap-open: `route_id` / `staled_stages`). For `r2p-gap-open`, also pass `--confirm`: it is inert in
  v0.7.3 (gap-open mutates regardless) but is passed defensively so a future r2p that makes it gate the
  mutation keeps working. The `r2pJsonContractAvailable` probe (R2.1) already confirmed the installed
  r2p accepts these.
- Re-check immediately before execution (the internal drift guard, always on, not a write guard): the
  four r2p commands still resolve; the active run still exists; the archive run still does not; `run.md`
  and `03-07` fingerprints have not drifted since review/triage; and the live run status (re-read via
  `R2P_JSON=1`) still matches the repair plan's `command_kind`. Any failure blocks instead of
  executing.
- Record a redacted receipt in drfx state: command, argv with `reason`/`required-action` redacted or
  reduced to a single line, exit code, redacted stdout/stderr, captured `newWorkId` (reopen) or
  `route_id` (gap-open) when present, and `nextAction`. Never record raw prompts, raw subagent
  transcripts, secrets, or large artifact bodies.

### R8. Workflow lifecycle

Do not reuse the file-set write lifecycle (`begin-fix`, `end-fix`, `record-diff-review`); those
model "write files then review a diff" and must be blocked for this route. Use an r2p-specific
lifecycle: `start` -> `context` -> `record-review` -> `record-triage` ->
`record-r2p-repair-plan` -> `apply-r2p-repair` -> `finalize/checkpoint`.

- `context` reports `routeKind: "r2p"`, the `workId`, `runDir`, `runLocation`, the `reviewFiles`
  (`03-07`), `protectedDependencies: ["run.md"]`, `editableFiles: []`,
  `directArtifactWrites: "forbidden"`, and the resolved `repairMode`.
- `record-review` keeps reviewer PASS/FAIL but every r2p finding must yield an `ownerStage` (from the
  reviewer or filled in during triage).
- `record-triage` sends accepted findings into the repair plan, never into a file-edit queue.
- `record-r2p-repair-plan` validates the plan (R6) and writes a receipt.
- `apply-r2p-repair` runs the allowlisted command (R7).
- Any direct-write entry for this route blocks with
  `r2p-direct-artifact-write-forbidden`.

Target-local state (decision, not open): the run is read-only, so target-local state under
`.drfx/targets/<target-key>/` holds only review history and repair receipts (R7) for this workId's
target key, never an editable set or diff. `resume` continues that target-local state (so a rerun can
link the prior round's receipt, R9). `reset` archives the existing target-local state and starts a
fresh review for the same workId. A one-shot `read-only` run without `resume` or `reset` stays
no-state and keeps tokens in memory only, matching the other routes.

Target key identity: the r2p target key is a stable hash of `projectRoot` + `routeKind=r2p` + `workId`
and MUST NOT include any `run.md` / `03-07` content fingerprint. Content fingerprints live in the
manifest (`runMdSha256`, the artifact-set fingerprint) purely as freshness gates. This keeps the state
directory stable across an r2p regeneration of the same workId (so receipts and review history survive
a gap-open plus `r2p-continue`), while a changed fingerprint still marks the prior review stale and
forces a re-read of the regenerated artifacts before any PASS. An `r2p-reopen` produces a new workId,
hence a new target key by design (R9 records the prior workId and receipt id for linkage).

### R9. PASS semantics

- PASS is reachable only when the current active run's current artifacts are clean and a full
  re-review found nothing.
- If a repair command (`r2p-reopen` / `r2p-gap-open`) ran this round, the round ends at a checkpoint
  and cannot PASS: `Final status: checkpoint`, `Status reason: r2p-repair-applied`,
  `Coordinator agreement: none`.
- The route instructs the user/agent to run `r2p-continue` until r2p finishes repair, gating,
  checkpointing, and regeneration, then to rerun `review-fix-r2p workId=<new-or-same-workId>`
  (new workId after reopen, same workId after gap-open). A clean re-review then earns PASS.
- Receipt linkage (decision, not open): after `r2p-reopen` forks `WF-...-rN`, the rerun targets a new
  workId and therefore a new target key; the new run's `start` state records the prior workId and the
  prior repair receipt id (the receipt captured `newWorkId` at apply time) so the closed loop can
  state which run this one was reopened from. After `r2p-gap-open` the workId is unchanged, so the
  same target-local state carries the receipt forward directly.
- Gemini stays advisory-only and can never claim a workflow PASS.

### R10. Change surface

The implementer should expect to touch at least:

- `lib/input.js`: the r2p parser (workId / bare-workId grammar; reject path, document/file-set, and
  `guard=` tokens).
- `lib/routes.js`: r2p descriptor gains semantic fields, e.g. `artifactWritePolicy: 'forbidden'`,
  `repairPolicy: 'r2p-lifecycle'`, `repairCommands: ['r2p-reopen', 'r2p-gap-open']`.
- `lib/target-context.js` / `lib/workflow/target-resolution.js`: a workId-based resolver
  (`resolveR2pWorkIdTarget({ projectRoot, workId })`) returning the read-only review set, empty
  editable set, and the run/artifact fingerprints; remove the requirement-dir-path resolution.
- `lib/workflow/file-set-fix.js`: block the r2p route from the direct-write fix lifecycle.
- New `lib/workflow/r2p-repair.js`: command resolution, the `r2pJsonContractAvailable` probe,
  `R2P_JSON=1` status read and JSON parsing, repair-plan validation and earliest-stage aggregation,
  reopen/gap-open execution (with `--confirm` on gap-open), receipt writing.
- `lib/workflow/index.js`: `record-r2p-repair-plan` and `apply-r2p-repair` subcommands.
- `skills/review-fix-r2p/SKILL.md` and all platform route-contract fragments
  (`route-contract.r2p.*`): rewrite to the new model (workId input, active-only, r2p commands
  required, direct artifact writes forbidden, repair = reopen/gap-open, checkpoint after repair).
- `shared/prompts/coordinator.md` and `shared/prompts/fixer.md`: add the r2p rules (no direct edits
  to `03-07`/`run.md`; map findings to ownerStage; produce an r2p repair plan; checkpoint after the
  command, never PASS from the command result; the fixer authors no file edits for this route).
- The retired `lib/workflow/file-set-r2p-gate.js` write-guard machinery (in-place `03-07` writes,
  four-checkpoint revalidation around writes) and the MANIFEST V2 r2p editable-set fields are removed
  or repurposed, since the run is now read-only.

### R11. No backward compatibility, no migration

- No support for the old `target=<requirement-dir>` entry, the old in-place edit lifecycle, or
  reading old r2p/r2q `.drfx/targets` state.
- Docs, skills, and route contracts must not contain legacy-behavior or migration language. They
  describe only the new model.

## Machine-readable status contract (no external blocker)

There is no blocking external dependency. req-2-plan already exposes a stable machine-readable
contract, gated by the `R2P_JSON=1` environment variable (verified in v0.7.3: `output.py:is_json_mode`,
`cli.py:_cmd_status_run`, `agent_shortcuts.py`). drfx invokes the r2p commands with `R2P_JSON=1` and
parses the documented JSON: status-run returns `status` / `current_stage` / `open_routes` /
`open_routes_detail[]` (each with `owner_stage`); reopen returns `new_work_id`; gap-open returns
`route_id` / `staled_stages`. Reading this contract is not human-text scraping; it is r2p's own
serialized output.

Because the contract exists today, all three phases are buildable now and the phase split is build
sequencing, not a capability gate. The only runtime guard is the `r2pJsonContractAvailable` probe
(R2.1): if an installed r2p is too old to honor `R2P_JSON`, the route blocks with
`r2p-json-contract-unavailable` rather than guessing from prose. This supersedes the earlier
"depend on a future `r2p-status --json`" decision, whose premise (no machine-readable status) was
incorrect.

## Phasing and delivery

The phases are a build sequence, not capability gates; all three consume the `R2P_JSON` contract.

- **Phase 1 (compliance):** workId invocation; reject path/document/`guard=` tokens; full preflight
  chain including the `r2pJsonContractAvailable` probe; read-only `run.md` + `03-07`; block direct
  artifact writes; resolve status from the JSON contract; review-and-fix emits the exact recommended
  r2p command and stops at a checkpoint without executing it.
- **Phase 2 (controlled execution):** repair-plan schema, validation, and earliest-stage aggregation;
  `apply-r2p-repair`; argv-array execution of `r2p-reopen` / `r2p-gap-open` under `R2P_JSON=1`;
  redacted receipt; checkpoint after repair.
- **Phase 3 (closed loop):** capture `new_work_id` / `route_id`; precise `nextAction`; link the prior
  round's repair receipt on rerun; PASS only after regenerated artifacts re-review clean.

## Checkpoints (verification gates)

These are the gates an implementation must pass before merge. They are the union of the plan's
acceptance criteria and test plan, with the scope decision applied.

1. **Invocation gate:** accepts `workId=WF-...` and bare `WF-...`; rejects `target=...`, a raw
   `.req-to-plan/...` path, `07-plan.md`, and `ref/scope/base/assurance/ledger/strict/normal`; rejects
   duplicate/conflicting tokens.
2. **Command-environment gate:** missing any of `r2p-status`, `r2p-reopen`, `r2p-gap-open`,
   `r2p-continue` (PATH or `~/.req-to-plan/bin`) blocks with `r2p-command-unavailable`; all four
   present passes. An r2p that does not honor `R2P_JSON` blocks with `r2p-json-contract-unavailable`.
3. **Workspace gate:** missing `.req-to-plan` blocks; symlinked `.req-to-plan` blocks; missing active
   workId blocks; archive-only workId blocks; active+archive conflict blocks; a real active workId
   passes.
4. **Artifact gate:** missing or symlinked `run.md` or any of `03-07` blocks; all regular files
   passes.
5. **No-direct-write gate:** the direct-write fix lifecycle (`begin-fix` / `end-fix`) is blocked for
   the r2p route; any test that observes a drfx-driven change to `03-07` or `run.md` fails.
6. **Repair-execution gate (Phase 2, exercised with fake r2p binaries that emit the `R2P_JSON`
   payload):** a closed-run finding drives `r2p-reopen` and captures `new_work_id`; an open-run
   upstream-gap finding drives `r2p-gap-open` (invoked with `--confirm`) and captures `route_id`;
   commands run via argv array with `shell: false`; state ends at a checkpoint; PASS is forbidden in
   the same round; `nextAction` names `r2p-continue` and the correct rerun workId.
7. **Rerun-PASS gate (Phase 3):** after regenerated artifacts re-review clean, the route can PASS;
   after a repair command in the same round, it cannot PASS.
8. **Status-contract gate:** status, `current_stage`, and owner stages are resolved from the
   `R2P_JSON` JSON payload, not from prose; a fixture with multiple open-route owner stages parses
   deterministically. An r2p without the contract blocks with `r2p-json-contract-unavailable`.
9. **Current-stage gate:** an open run with an owner==`current_stage` finding calls neither gap-open
   nor reopen; it checkpoints with `r2p-current-stage-repair-required`.
10. **Aggregation gate:** after the R4 status mapping, accepted findings spanning multiple owner
    stages produce one command at the earliest repairable `STAGE_ORDER` stage with all `issue_ids` in
    the receipt. An open-run current-stage-only repair checkpoints with
    `r2p-current-stage-repair-required`; only post-R4 aggregation failures block with
    `r2p-repair-plan-ambiguous`.
11. **Documentation gate:** SKILL.md, route-contract fragments, coordinator.md, and fixer.md describe
    only the new model and contain no legacy or migration language.

## References

- req-2-plan source: `~/x-skills/req-to-plan` (v0.7.3). Key files: `tools/workflow_cli/output.py`
  (`is_json_mode` / `R2P_JSON`), `tools/workflow_cli/cli.py` (`_cmd_status_run`, `_cmd_gap_open`,
  `run-reopen`, `STAGE_ORDER`), `tools/workflow_cli/agent_shortcuts.py` (the `r2p-*` verb wrappers),
  `tools/workflow_cli/models.py` (`Stage`, `RunStatus`).
- Installed CLI: `~/.req-to-plan/bin/` over `@xenonbyte/req-2-plan` (not on PATH).


## Tier Estimate
base: standard
modifiers: cross_project, dependency, migration, safety, scope_expanding

## Evidence Block
keywords_hit: ['rewrite', 'migration', 'project', 'delete', 'token', 'live', 'token', 'order', 'depend on', 'entire', 'all of', 'full']
repo_baseline_summary: loc=54039, modules=7, monorepo=False, languages=['JavaScript']
linked_context: none
scope_signals: ['entire', 'all of', 'full']
escalation_candidates: ['migration', 'cross_project', 'safety', 'dependency']
confirm_status: pending