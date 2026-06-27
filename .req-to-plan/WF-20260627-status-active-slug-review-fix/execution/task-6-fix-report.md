# PLAN-TASK-006 Fix Report

## Status

DONE

## Scope

Fixed all Critical/Important findings from `task-6-review.md` within Task 6 ownership:

1. `mapRepairMode()` and drift/status matching now recognize the real r2p in-flight/open status family, not just the literal `open`.
2. External `R2P_JSON` stage validation is now classified as `r2p-json-contract-unavailable` instead of leaking into internal `r2p-repair-plan-ambiguous`.

No later lifecycle wiring from PLAN-TASK-007/008 was implemented here.

## Changed Files

- `lib/workflow/r2p-repair.js`
- `test/r2p-route.test.js`

## Implementation Evidence

- Added `OPEN_RUN_STATUSES` and `isOpenRunStatus()` so `active_stage_draft`, `checkpoint_review`, and the other documented in-flight statuses map through the gap-open/current-stage logic and the pre-exec drift guard consistently.
- Added `ensureContractStage()` and routed `readRunStatus()` / `normalizeOpenRoutesDetail()` through it, so malformed `current_stage` or `open_routes_detail[].owner_stage` values now fail closed as `r2p-json-contract-unavailable`.
- Updated Gate 6 to execute the gap-open path from a real in-flight status (`active_stage_draft`).
- Expanded Gate 8 to verify:
  - a real in-flight status (`checkpoint_review`) still maps to `r2p-gap-open`,
  - non-JSON `r2p-status` output blocks as `r2p-json-contract-unavailable`,
  - malformed `current_stage` blocks as `r2p-json-contract-unavailable`,
  - malformed open-route `owner_stage` blocks as `r2p-json-contract-unavailable`.

## Verification

- Passed: `node --test --test-name-pattern='gate6|gate8|gate10|drift|redaction' test/r2p-route.test.js`
- Passed: `npm run syntaxcheck`

## Concerns

- None within PLAN-TASK-006 scope. The review note about later workflow subcommands invoking `driftGuard()` remains owned by PLAN-TASK-007/008, as already stated in the review report.
