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
