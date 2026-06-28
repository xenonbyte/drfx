# PLAN-TASK-007 Fix Report

## Summary

- Completed the r2p `context` payload contract by sourcing r2p metadata from the workId resolver and adding resolved `repairMode` to the emitted context pack.
- Fixed `apply-r2p-repair` drift enforcement so it checks `03-07` review-set drift with the persisted manifest fingerprint, not just `run.md`.
- Aligned the runtime review-set fingerprint calculation in `driftGuard()` with the manifest's r2p `fileSetFingerprint`, so clean runs still execute and real drift blocks.
- Expanded the focused gate5 coverage to prove both behaviors: stale `03-07` content blocks `apply-r2p-repair`, while an allowlisted r2p-authored artifact mutation is still allowed.

## Changed Files

- `lib/workflow/target-resolution.js`
- `lib/workflow/index.js`
- `lib/workflow/r2p-repair.js`
- `test/r2p-route.test.js`

## Evidence

- `resolveRouteTargetMetadata()` now carries `runLocation`, non-empty `reviewFiles`, `runMdSha256`, and `fileSetFingerprint` from `resolveR2pWorkIdTarget()`.
- `runR2pContextCommand()` now emits `repairMode` from live `R2P_JSON` status resolution, alongside the existing read-only r2p fields.
- `runApplyR2pRepairCommand()` now passes `metadata.manifest.fileSetFingerprint` into `driftGuard()`.
- `driftGuard()` now fingerprints `03-07` with the same `computeFileSetFingerprint()` shape used by r2p manifest/state capture, so the guard is sensitive to real review-set drift without false positives on clean runs.

## Verification

- `node --test --test-name-pattern='gate2|gate5' test/r2p-route.test.js`
  - PASS: `gate2 command-env + R2P_JSON probe`
  - PASS: `gate5 no-direct-write both directions (drfx fails; r2p-authored change allowed)`
  - PASS: `gate5 r2p-authored change after apply-r2p-repair is allowed`
- `npm run syntaxcheck`
  - PASS: `syntax check passed: 101 files checked`

## Scope Notes

- Manifest/state token schema alignment remains later-task work and was not broadened here beyond the fingerprint plumbing required to make Task 7's drift guard contract actually hold.
