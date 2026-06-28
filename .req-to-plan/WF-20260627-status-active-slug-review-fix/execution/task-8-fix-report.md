# PLAN-TASK-008 Fix Report

- Task: PLAN-TASK-008 finalize, PASS semantics, state lifecycle, and receipt linkage
- Base commit: fe01fef70fd1625f634f0baa43f47a7b23a78d41
- Status: DONE

## Summary

Fixed the Task 8 Critical/Important receipt-linkage issue by removing raw round-receipt directory scans
from the r2p reopen-link and same-round finalize paths.

- Added a shared safe round-receipt reader in `lib/receipts.js`.
- The reader only returns entries that are:
  - inside the target-state `rounds/` subtree,
  - validated through `validateTargetStateOwnedPath(...)`,
  - regular files according to `lstat`,
  - readable as UTF-8 text.
- `lib/workflow/start.js` now uses that helper when linking a reopened workId back to a prior repair
  receipt.
- `lib/workflow/file-set-finalize.js` now uses the same helper when finding the current-round r2p repair
  receipt for checkpoint finalization.

This means symlinked or otherwise unsafe receipt artifacts are skipped instead of being trusted as
linkage metadata.

## Changed Files

- `lib/receipts.js`
- `lib/workflow/start.js`
- `lib/workflow/file-set-finalize.js`
- `test/receipts.test.js`
- `test/r2p-route.test.js`

## Verification

- `node --test --test-name-pattern='gate7' test/r2p-route.test.js`
  - PASS (3/3)
  - Confirms:
    - same-round repair still cannot PASS
    - finalize ignores a malicious symlinked same-round receipt
    - reopen linkage ignores a malicious symlinked prior receipt
    - same-workId resume still preserves receipts after regeneration
    - Gemini remains advisory-only
- `node --test --test-name-pattern='readRoundReceiptArtifacts' test/receipts.test.js`
  - PASS (1/1)
  - Confirms the shared receipt reader skips symlinked round receipts and keeps regular files only.
- `node --test --test-name-pattern='reset archives stale state and starts fresh, breaking the resume/start deadlock|persistent finalize blocks receipt write through symlinked rounds directory' test/workflow-fileset-start.test.js test/finalize-resume.test.js`
  - PASS (2/2)
- `npm run syntaxcheck`
  - PASS (`syntax check passed: 101 files checked`)

## Evidence Notes

- Before the fix, `findPriorR2pRepairReceipt()` and `currentRoundR2pRepairReceipt()` read arbitrary
  `rounds/*` entries directly from the filesystem.
- After the fix, both paths consume only validated regular files owned by the target state directory.
- The new `gate7` coverage proves that a lexically earlier malicious symlink receipt is not selected for
  finalize next-action resolution, and that a newer malicious symlink receipt is not selected for reopen
  linkage.

## Concerns

- None within PLAN-TASK-008 scope.
