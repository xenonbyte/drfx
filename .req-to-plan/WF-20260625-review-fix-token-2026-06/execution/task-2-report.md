# PLAN-TASK-002 Report

Status: complete

Files changed:
- `bin/drfx.js`
- `lib/workflow/index.js`
- `.req-to-plan/WF-20260625-review-fix-token-2026-06/execution/task-2-report.md`

Implementation notes:
- Added workflow-only JSON mode parsing for `--json`, `--json=full`, and `--json=compact`.
- Preserved compatibility `json` booleans and added `jsonMode` to parsed workflow args.
- Added compact workflow JSON allowlists with field purpose checks for state, fix lifecycle, file-set, partitioned, and no-state paths.
- Kept compact formatting in stdout only; full JSON remains the default formatter mode.

Verification:
- `node --test test/workflow-args.test.js test/workflow-json-baseline.test.js test/cli.test.js` passed: 69/69 tests.
- `npm run syntaxcheck` passed: 98 files checked.

Review follow-up (2026-06-25):
- Added regression coverage for compact formatting of no-state partitioned `context` output. The compact row must preserve partition plan essentials (`reviewMode`, `unitCount`, `unitByteBudget`, `crosscuttingBackstops`) and omit full/debug fields (`units`, `projectReviewFingerprint`, `userExcludes`, `runtimeCheck`, `contextPackSkeleton`).
- Added fail-closed coverage for direct compact formatting without a valid workflow subcommand; expected error code is `ERR_WORKFLOW_JSON_COMPACT`.
- Fixed `lib/workflow/index.js` so partitioned compact rows are selected before generic no-state rows, and unknown compact row keys no longer return full JSON.

RED evidence:
- `node --test test/workflow-json-baseline.test.js` failed before the production fix: 5/7 passed, 2 failed.
- Failures: `compact no-state partitioned context keeps partition plan fields` had `reviewMode` as `undefined`; `compact formatter fails closed without workflow subcommand` reported `Missing expected exception`.

GREEN verification:
- `node --test test/workflow-json-baseline.test.js` passed: 7/7 tests.
- `node --test test/workflow-args.test.js test/workflow-json-baseline.test.js test/cli.test.js` passed: 71/71 tests.
- `npm run syntaxcheck` passed: 98 files checked.
