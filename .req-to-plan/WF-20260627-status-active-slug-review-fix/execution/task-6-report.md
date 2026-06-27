# PLAN-TASK-006 Report

## Status

DONE

## Scope Delivered

- Added `lib/workflow/r2p-repair.js` as the Task 6 repair module.
- Updated the Task 6 gate tests in `test/r2p-route.test.js` to exercise the repair module directly, without pulling in the later r2p lifecycle wiring owned by PLAN-TASK-007/008.

## Changed Files

- `lib/workflow/r2p-repair.js`
- `test/r2p-route.test.js`

## Implementation Notes

- `resolveR2pCommands()` resolves `r2p-status`, `r2p-reopen`, `r2p-gap-open`, and `r2p-continue` via `PATH` first and then `~/.req-to-plan/bin`, returning absolute paths.
- `probeJsonContract()` and `readRunStatus()` run `r2p-status --all` with `R2P_JSON=1`, parse JSON, validate the `status` / `current_stage` contract, and normalize `open_routes_detail`.
- `mapRepairMode()` covers reopen, gap-open, current-stage checkpoint, and unsupported-status mapping.
- `buildRepairPlan()` validates owner stages, enforces safe single-line reason / required-action text, and aggregates accepted findings to the earliest repairable stage.
- `driftGuard()` re-resolves commands, checks active/archive run placement, recomputes `run.md` + `03-07` fingerprints, and confirms the live status still matches the planned command kind.
- `runRepairCommand()` uses `execFile` with argv arrays and `shell: false`, passes `R2P_JSON=1`, preserves the resolved absolute binary path, and parses `new_work_id` / `route_id`.
- `writeReceipt()` redacts argv/stdout/stderr, including token-like field names and `required_action=` fragments.

## Verification

### Required task verification

Command:

```sh
node --test --test-name-pattern='gate6|gate8|gate10|drift|redaction' test/r2p-route.test.js
```

Result:

- Passed 5/5 matching tests:
  - `gate6 repair exec argv shell:false; capture new_work_id/route_id; checkpoint, no PASS`
  - `gate8 status-contract parses multiple owner stages; missing contract blocks`
  - `gate10 earliest-stage aggregation + r2p-repair-plan-ambiguous`
  - `redaction receipt omits raw reason/secrets`
  - `drift guard blocks instead of executing`

### Additional practical verification

Command:

```sh
npm run syntaxcheck
```

Result:

- `syntax check passed: 101 files checked`

## Concerns

- None for Task 6 scope. The workflow subcommand wiring and persistent-state integration are intentionally left to PLAN-TASK-007 and PLAN-TASK-008.
