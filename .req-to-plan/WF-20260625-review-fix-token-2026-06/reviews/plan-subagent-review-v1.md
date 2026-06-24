# PLAN Subagent Review v1

Status: FAIL

## Findings

- Severity: medium
  Location: `.req-to-plan/WF-20260625-review-fix-token-2026-06/07-plan.md:38`, `:74`
  Problem: Compact allowlist scope is not concrete enough in the executable tasks. SPEC requires coverage for every route-automated subcommand, file-set flows, partitioned paths, and no-state contexts, but PLAN-TASK-001/002 only says "classify every route-automated full-output field" and shows a context-only skeleton.
  Fix: Add an explicit allowlist coverage matrix to PLAN-TASK-001/002 matching SPEC-BEHAVIOR-002, including `preflight`, `start`, `context`, `record-*`, fix lifecycle commands, `finalize`, file-set, partitioned, and no-state paths.

- Severity: medium
  Location: `.req-to-plan/WF-20260625-review-fix-token-2026-06/07-plan.md:115`
  Problem: Codex shared de-duplication is conditional but not fully executable if the measurement gate passes. The task names measurement and possible implementation, but not the exact fail-closed install/invocation/missing-source tests or implementation files needed to protect the runtime file dependency.
  Fix: Split measurement from guarded implementation. Define the no-op recording location when the gate fails; if it passes, list exact tests for offline install, invocation, missing copied source fail-closed behavior, no route growth, and preservation of embedded safety constraints.

- Severity: medium
  Location: `.req-to-plan/WF-20260625-review-fix-token-2026-06/07-plan.md:177`
  Problem: Retry negative coverage does not close all SPEC fail-closed cases. PLAN-TASK-005 covers several failures, but omits tests for non-retryable manifest state/phase/blocking reason, failed baseline, target mismatch, and missing passed rollback anchor.
  Fix: Add those negative tests and acceptance checks so retry is allowed only for `Status: blocked`, `Current phase: fix`, `Blocking reason: fix-report-mismatch`, with a valid original guard baseline.

## Checks Passed

- Required task fields are present: spec refs, change type, TDD applicability, file lists, skeletons, steps, and verification.
- Referenced files exist.
- Task order broadly follows SPEC handoff: tests/allowlist before route switching, then schema/retry/docs.
- Trace closes all `SPEC-BEHAVIOR-001..006` and `SCOPE-IN-001..007`.

## Verification

Read-only review completed by subagent `019efb00-3713-7b80-b6f9-c2639e01a45b` against PLAN v1, SPEC v3, DESIGN v2, and RISK v2. No files were modified by the subagent.
