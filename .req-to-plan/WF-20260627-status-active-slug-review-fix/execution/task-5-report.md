# PLAN-TASK-005 Report

Status: done

Summary:
- Added a content-independent r2p target key derived from `projectRoot + routeKind=r2p + workId`.
- Added ordered r2p workId filesystem preflight for project root, workspace, active/archive selection, run dir, and artifacts.
- Kept legacy `resolveR2pTarget` / `buildR2pIdentity` in place; added the new resolver alongside them.
- Added a focused regression test proving same-`workId` key stability across artifact content changes.

Changed files:
- `lib/target-state.js`
- `lib/workflow/target-resolution.js`
- `lib/target-context.js`
- `lib/workflow/start.js`
- `test/r2p-route.test.js`

Implementation notes:
- `lib/target-state.js`: added `deriveR2pTargetKey()`.
- `lib/workflow/target-resolution.js`: switched r2p route metadata from requirement-dir identity to workId identity and added fail-closed workspace/run-dir preflight helpers with structured blocking reasons.
- `lib/target-context.js`: added `resolveR2pWorkIdTarget()` to validate `run.md` + `03-07`, compute `runMdSha256`, and compute the review-set fingerprint while exposing `editableFiles: []`.
- `lib/workflow/start.js`: minimal wiring so r2p `start` uses the new resolver and surfaces preflight blocking reasons directly.
- `test/r2p-route.test.js`: added stable-key coverage and verified workspace/artifact preflight cases.

Evidence:
- `node --test --test-name-pattern='gate3|gate4|stable target key' test/r2p-route.test.js`
  - PASS (3 tests)
- `node --test test/r2p-target-context.test.js test/target-state.test.js`
  - PASS (59 tests)
- `npm run syntaxcheck`
  - PASS (`100 files checked`)

Concerns:
- None for this task’s scoped behavior. `lib/workflow/start.js` needed a small wiring change so the new resolver is actually exercised by `start`; the legacy r2p resolver remains available for later migration/removal tasks.
