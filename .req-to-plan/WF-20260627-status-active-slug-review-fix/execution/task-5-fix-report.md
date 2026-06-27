# PLAN-TASK-005 Fix Report

Status: done

Summary:
- Fixed the shared file-set start fallback so PR/CODE resolution failures keep their own `routeKind` and default guard semantics instead of being mislabeled as `r2p`.
- Fixed the r2p workspace preflight so a symlinked `.req-to-plan` reports `unsafe-r2p-workspace`, matching `SPEC-PREFLIGHT-001`.
- Added helper-local direct-child containment checks inside `resolveR2pWorkIdTarget()` so the exported resolver itself rejects archive-prefixed or multi-segment `workId` inputs.

Changed files:
- `lib/workflow/start.js`
- `lib/workflow/target-resolution.js`
- `lib/target-context.js`
- `test/r2p-route.test.js`
- `test/r2p-target-context.test.js`
- `test/workflow-fileset-dispatch.test.js`
- `.req-to-plan/WF-20260627-status-active-slug-review-fix/execution/task-5-fix-report.md`

Findings addressed:
1. Major: shared `runFileSetStart()` catch now preserves the actual file-set route kind (`pr` / `code` / `r2p`) instead of hardcoding `r2p`.
2. Minor: symlinked `.req-to-plan` now blocks with `unsafe-r2p-workspace`.
3. Minor: `resolveR2pWorkIdTarget()` now enforces helper-local direct-child containment for both active and archive candidate paths.

Verification:
- `node --test --test-name-pattern='gate3|gate4|stable target key' test/r2p-route.test.js`
  - PASS (3/3)
- `node --test test/r2p-target-context.test.js test/target-state.test.js`
  - PASS (60/60)
- `node --test --test-name-pattern='PR start root-resolution failures preserve the PR route kind' test/workflow-fileset-dispatch.test.js`
  - PASS (1/1)
- `npm run syntaxcheck`
  - PASS (`100 files checked`)

Scope notes:
- No files outside PLAN-TASK-005 were changed.
- `test/workflow-fileset-dispatch.test.js` was touched only to add a regression for the shared PR start-path labeling bug introduced by this task's wiring in `lib/workflow/start.js`.
