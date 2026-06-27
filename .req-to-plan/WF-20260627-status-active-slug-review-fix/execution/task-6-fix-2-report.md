# PLAN-TASK-006 Fix Report 2

## Status

DONE

## Scope

Fixed the remaining Important review finding in `task-6-review-2.md` for the malformed
`open_routes_detail[]` contract. No work outside PLAN-TASK-006 scope was changed.

## Changed Files

- `lib/workflow/r2p-repair.js`
- `test/r2p-route.test.js`

## Implementation Evidence

- `normalizeOpenRoutesDetail()` now fails closed with `r2p-json-contract-unavailable` when an
  `open_routes_detail[]` entry is missing the required `owner_stage` field, instead of normalizing it
  to `ownerStage: null`.
- Gate 8 now includes a regression case where `r2p-status --all` returns an `open_routes_detail[]`
  item with `route_id` and `required_action` but no `owner_stage`, and asserts that `readRunStatus()`
  rejects the payload with `r2p-json-contract-unavailable`.

## Verification

- Passed: `node --test --test-name-pattern='gate6|gate8|gate10|drift|redaction' test/r2p-route.test.js`
- Passed: `npm run syntaxcheck`

## Concerns

- None within PLAN-TASK-006 scope.
