# PLAN-TASK-001 Report

Status: RED coverage added. No production workflow behavior was implemented.

Files changed:
- `test/workflow-args.test.js`
- `test/workflow-json-baseline.test.js`
- `test/cli.test.js`
- `.req-to-plan/WF-20260625-review-fix-token-2026-06/execution/task-1-report.md`

Tests run:
- `node --test test/workflow-args.test.js test/workflow-json-baseline.test.js test/cli.test.js`

Result: expected RED before PLAN-TASK-002. Latest run: 69 tests, 66 passed, 3 failed.

RED evidence:
- `SCOPE-IN-001 workflow JSON mode accepts full and compact while preserving bare json` fails because `parseWorkflowJsonMode` is not exported/implemented.
- `SCOPE-IN-001 compact context output keeps paths and omits skeleton bodies` fails because compact formatting still emits `contextPackSkeleton`.
- `SCOPE-IN-001 compact generated-route continuation keeps next-step artifact paths` fails because workflow CLI rejects `--json=compact` with `ERR_WORKFLOW_FLAG`.

Passing coverage added:
- `doctor --json` and `status --json` remain boolean user-command flags and reject `--json=compact`.
- Compact allowlist matrix includes state, fix lifecycle, file-set, partitioned, and no-state route rows.
- Formatter field classification now fails if a full-output field lacks one of the allowed purposes: `stdout required`, `user status`, `path readable`, or `debug only`.

Fix-review follow-up (2026-06-25):
- Tightened `test/workflow-json-baseline.test.js` continuation smoke coverage so `begin-fix`, `end-fix`, `record-diff-review`, full re-review `context`, and full re-review `record-review` compact responses are retained and asserted, alongside the original start/context/review/triage/finalize responses.
- Added fail-closed compact matrix accounting: route-automated full-output fields must appear in the compact allowlist matrix unless they are explicitly accounted for as debug-only compact omissions.
- Extended `test/cli.test.js` boolean user-command JSON coverage so `doctor/status` reject both `--json=compact` and `--json=full`.
- Changed the invalid `parseWorkflowJsonMode(['--json=bad'])` assertion in `test/workflow-args.test.js` to check `error.code === 'ERR_WORKFLOW_FLAG'`.

Follow-up verification:
- `node --test test/workflow-args.test.js test/workflow-json-baseline.test.js test/cli.test.js`
- Result: expected RED before PLAN-TASK-002. Latest run: 69 tests, 66 passed, 3 failed.
- Remaining RED evidence is still PLAN-TASK-002 implementation work: `parseWorkflowJsonMode` is not exported/implemented; compact formatting still emits `contextPackSkeleton`; workflow CLI still rejects `--json=compact` before the strengthened continuation assertions can run.
