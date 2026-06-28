# PLAN-TASK-008 Fix Report 2

- Task: PLAN-TASK-008 finalize, PASS semantics, state lifecycle, and receipt linkage
- Base commit: fe01fef70fd1625f634f0baa43f47a7b23a78d41
- Status: DONE

## Summary

Fixed the remaining Task 8 review finding by replacing reopen linkage's path-shaped prior receipt reference with a stable `priorReceiptId`.

- Round receipts now carry a durable `Receipt ID` derived from `targetKey + rounds/<file>`.
- `apply-r2p-repair` now returns `receiptId` alongside `receiptPath`.
- Reopen linkage now parses and records `priorReceiptId` from the prior repair receipt, not `priorReceiptPath`.
- The reopen-link receipt summary now records `Prior receipt ID: ...`, preserving safe path validation only for reading receipt artifacts.

## Changed Files

- `lib/receipts.js`
- `lib/workflow/r2p-repair.js`
- `lib/workflow/index.js`
- `lib/workflow/start.js`
- `test/r2p-route.test.js`
- `test/receipts.test.js`

## Verification

- `node --test --test-name-pattern='gate7' test/r2p-route.test.js`
  - PASS (3/3)
  - Confirms same-round repair still cannot PASS, rerun PASS still works, Gemini remains advisory-only, and reopened reruns now link `priorReceiptId`.
- `node --test --test-name-pattern='readRoundReceiptArtifacts|v2 receipts include fixed fields and attempt suffixes' test/receipts.test.js`
  - PASS (2/2)
  - Confirms safe receipt enumeration still skips symlinked artifacts and written receipts now include stable `Receipt ID`.
- `node --test --test-name-pattern='reset archives stale state and starts fresh, breaking the resume/start deadlock|persistent finalize blocks receipt write through symlinked rounds directory' test/workflow-fileset-start.test.js test/finalize-resume.test.js`
  - PASS (2/2)
- `node --test --test-name-pattern='Gemini is advisory-only: read-only mode \\+ advisory assurance, the no-state path|no-state finalization never accepts pass' test/r2p-finalize.test.js test/finalize-resume.test.js`
  - PASS (2/2)
- `npm run syntaxcheck`
  - PASS (`syntax check passed: 101 files checked`)

## Evidence Notes

- Before this fix, reopen linkage surfaced only `priorReceiptPath`, which breaks the Task 8 / `SPEC-PASS-001` contract and becomes fragile after state moves or archive.
- After this fix, reopen linkage resolves from the prior repair receipt's embedded `Receipt ID`, while receipt discovery still uses the hardened validated-regular-file reader.

## Concerns

- None within PLAN-TASK-008 scope.
