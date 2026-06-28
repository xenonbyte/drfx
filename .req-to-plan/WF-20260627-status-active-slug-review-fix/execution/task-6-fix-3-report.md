# PLAN-TASK-006 Fix Report 3

## Status

DONE

## Scope

Fixed the remaining review finding in `task-6-review-3.md` within PLAN-TASK-006 scope only:
`readRunStatus()` now fails closed when the selected matching `work_id` entry is missing `status` or
missing/non-array `open_routes_detail`. No Task 7/8 workflow wiring or receipt-linkage work was added.

## Changed Files

- `lib/workflow/r2p-repair.js`
- `test/r2p-route.test.js`
- `.req-to-plan/WF-20260627-status-active-slug-review-fix/execution/task-6-fix-3-report.md`

## Implementation Evidence

- `readRunStatus()` now rejects the matched `work_id` entry with
  `r2p-json-contract-unavailable` when `entry.status` is absent or not a string, instead of
  normalizing it to `"undefined"`.
- `normalizeOpenRoutesDetail()` now rejects missing or non-array `open_routes_detail` with
  `r2p-json-contract-unavailable` instead of normalizing malformed external input to `[]`.
- Gate 8 coverage now includes focused regressions for:
  - matched `work_id` entry missing `status`
  - matched `work_id` entry missing `open_routes_detail`
  - matched `work_id` entry with non-array `open_routes_detail`

## Verification

- Passed: `node --test --test-name-pattern='gate6|gate8|gate10|drift|redaction' test/r2p-route.test.js`
- Passed: `npm run syntaxcheck`

## Concerns

- None within PLAN-TASK-006 scope.
