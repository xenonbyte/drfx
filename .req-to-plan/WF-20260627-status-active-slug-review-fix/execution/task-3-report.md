# PLAN-TASK-003 Report

Status: DONE

Task: PLAN-TASK-003 workId invocation parser

Summary:
- Replaced the legacy `target=<requirement-dir>` / bare-path r2p invocation grammar with `workId=<WF-...>` plus one bare `WF-...` shorthand in `lib/input.js`.
- Enforced strict workId validation with `^WF-[A-Za-z0-9._-]+$` plus explicit `..` rejection, and rejected path-shaped / flag-shaped / duplicate / conflicting tokens as `invalid-r2p-invocation`.
- Parsed `debug` as a verbosity-only boolean and removed `guard=` from the accepted r2p token surface.
- Added the minimal workflow parse-error mapping so `runWorkflowCommand()` returns the task-required blocked payload instead of throwing on invalid r2p invocations.
- Updated focused r2p parser tests to the new grammar and narrowed the gate-1 selector collision by renaming the Gate 10 test label from `gate10` to `gate-10`.

Changed files:
- `lib/input.js`
- `lib/workflow/index.js`
- `test/input-parsing.test.js`
- `test/r2p-route.test.js`

Verification:
- `node --test --test-name-pattern='gate1' test/r2p-route.test.js`
  - PASS (`gate1 invocation accept/reject incl. archive-bypass and flag-injection`)
- `node --test --test-name-pattern='review-fix-r2p' test/input-parsing.test.js`
  - PASS (6 r2p parser-focused tests)

Evidence:
- Accepted:
  - `review-fix-r2p workId=WF-20260627-gate1 review-and-fix`
  - `review-fix-r2p WF-20260627-gate1 review-and-fix`
- Blocked as `invalid-r2p-invocation`:
  - `target=.req-to-plan/WF-...`
  - bare `.req-to-plan/WF-...`
  - bare `07-plan.md`
  - `workId=archive/WF-...`
  - `workId=../...`
  - `workId=--from=...`
  - duplicate/conflicting mode + resume/reset + `rounds=` without `review-and-fix`

Concerns:
- None for this task scope.
