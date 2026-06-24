# SPEC Checkpoint Review

**Verdict: FAIL**

## Summary

The SPEC has the expected standard-stage structure: `SPEC-*` anchors, behavior contracts, API/data/config contracts, external-docs section, test matrix, non-goals, PLAN handoff, and trace table are present. Trace closure from DESIGN IDs to SPEC IDs is complete, and the API/data/config contracts are broadly implementable against the current code structure.

## Findings

- **Severity: medium**
  **Location:** `06-spec.md` `SPEC-BEHAVIOR-003`, `PLAN Handoff`
  **Problem:** Size and de-duplication thresholds are still undecided: terms like "materially smaller," "meaningful amount," "threshold," and "current measured baselines plus a documented margin" leave PLAN to invent acceptance rules.
  **Fix:** Define deterministic thresholds or formulas before PLAN: compact/full context ratio or max bytes, platform x route shell budget margin, Codex de-dup minimum byte/percent reduction, and the exact "record no behavior change" condition.

- **Severity: medium**
  **Location:** `06-spec.md` `SPEC-BEHAVIOR-005`, `Document retry state contract`, `Test Matrix`
  **Problem:** The retry contract omits the upstream DESIGN constraint that retry must not consume or alter fix-attempt semantics. Current file-set retry preserves this; document retry could accidentally increment `fixAttemptCount` if PLAN follows normal `begin-fix`.
  **Fix:** Add an explicit requirement and test that document blocked retry does not increment `fixAttemptCount`, change `currentRound`, alter accepted issue IDs, or mark issues fixed before corrected `end-fix`.

## Non-blocking Note

- `External Documentation Checked` says `N/A`, but upstream cites `rtk-ai/rtk` as a design reference. Prefer listing it as "reference only; no runtime dependency; no version-sensitive contract" so the external-docs inventory is not misleading.

## Verification

Read-only review completed by subagent `019efaef-853e-7d22-96ee-f7e29fb218de` against `06-spec.md`, `05-design.md`, `04-risk-discovery.md`, `00-raw-requirement.md`, and current implementation surfaces. No files were modified by the subagent.
