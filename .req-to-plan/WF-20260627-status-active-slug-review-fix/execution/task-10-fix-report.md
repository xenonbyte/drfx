# PLAN-TASK-010 Fix Report

Status: DONE_WITH_CONCERNS

## Summary

Addressed the review's Critical/Important scope for Task 10:

- restored `runMdSha256` as an r2p freshness gate in resume/finalize identity comparison alongside `workId` and `reviewSetFingerprint`
- allowed the post-repair resume refresh path to re-anchor when only `run.md` drifted
- removed the unused `deriveR2pTargetKey` helper re-export so the workflow helper boundary export set matches real submodule imports again

## Changed Files

- `lib/workflow/file-set-finalize.js`
- `lib/workflow/helpers.js`
- `test/r2p-route.test.js`

## Evidence

- `rg "resolveR2pTarget|buildR2pIdentity|compareR2pIdentity" lib`
  - exit status `1` (no matches)
- `node --test test/r2p-context.test.js test/r2p-target-context.test.js test/r2p-route.test.js test/manifest-schema-v2.test.js`
  - passed `74/74`
- `node --test test/workflow-module-boundaries.test.js`
  - helper export contract passed
  - suite still has the pre-existing size-ceiling failure: `file-set-fix.js has 1005 lines`
- `npm run syntaxcheck`
  - passed (`101 files checked`)

## Notes

- Added a focused Gate 7 regression covering the previously missing case: same-`workId` resume after `r2p-repair-applied` when only `run.md` changes.
- Did not touch `.req-to-plan/.../run.md`; it remains an unrelated local modification.
