# DESIGN subagent review (v2) — focused re-verification

stage: design
version: 2
modifiers_triggering_review: cross_project, safety, scope_expanding
reviewer: independent read-only subagent (Plan agent), findings re-verified against source by the coordinator
verdict: APPROVE-WITH-NITS

## Method
v1 returned CHANGES-REQUIRED with 8 findings (1 blocker, 2 high, 3 medium, 2 low; see `design-subagent-review-v1.md`). v2 applied targeted fixes. An independent read-only subagent re-verified each finding against `05-design.md` (v2) and current source, and scanned the changed sections for regressions.

## Resolution table
| # | Sev | Finding | Status | v2 evidence (source-verified) |
|---|---|---|---|---|
| 1 | BLOCKER | DES-ENUM-001 must name the `final-response.js:162-177` branch amendment + `file-set-finalize.js:510` path + both `STATUS_REASONS` copies | RESOLVED | DES-ENUM-001 now says allowlisting is "necessary but NOT sufficient"; names the branch (`:170` reason allowlist, `:176-177` non-empty deferredIssueIds), the required amendment (admit `coverage-incomplete`, allow empty deferred set, gate on coverage-deferral owner/next-action), `file-set-finalize.js:510` (`validateFinalResponse`), and both copies (`workflow-state.js:60` + `semantic-parsers.js:47`). Reviewer independently confirmed via `buildFileSetFinalValidationState` → `deferredBlockingIssues(ledger)` that a pure coverage stop yields an empty deferred set and throws today — fix is correctly targeted. |
| 2 | HIGH | `reviewer-pass-fail` mis-located as a `semantic-parsers.js` parser | RESOLVED | DES-CONTRACT-001 now anchors it as a `requiredOutputSchema` identifier (`helpers.js:863`, `no-state.js:240`, `file-set-no-state.js:299`) parsed by `parseFinalResponseBlock`, with `fix-report`=`parseFixReport` correctly in `semantic-parsers.js`; `unit-review-report` is the additive parser. |
| 3 | HIGH | DES-STATE-001 overclaimed "pure reuse" | RESOLVED | Now states `checkpoint` ∉ `ACTIVE_STATUSES` (`target-state.js:27`) / `ACTIVE_STATUS_PHASES` (`workflow-state.js:25`); `validateResumeState` keys on `lastKnownContentSha256`; checkpoint→active re-entry + fingerprint-drift dispatch are NEW wiring SPEC must define. |
| 4 | MEDIUM | `:600-609` mislabeled | RESOLVED | Re-anchored: `walkDirectory` at `:570`; `:600-609` is the capped `if (wholeRootStats)` branch; null-stats path is uncapped. |
| 5 | MEDIUM | PASS-reachability tension unacknowledged | RESOLVED | DES-GATE-001 adds the two-state-enum PASS-reachability note; SPEC owns the positive-evidence condition for backstop `none`. |
| 6 | MEDIUM | budget split framed as free tunable | RESOLVED | SPEC Handoff (10): 1.0MB/0.5MB is a structural PASS-reachability determinant; Phase 3 PASS gated on Phase 2 coverage_risk distribution. |
| 7 | LOW | identity-projection guarded only by rubric prose | RESOLVED | SPEC Handoff (11): deterministic test that `computeFileSetFingerprint`'s projection covers every identity-bearing member field. |
| 8 | LOW | two `STATUS_REASONS` copies / no parity test | RESOLVED | DES-ENUM-001 + SPEC Handoff (9) name both copies and require a parity test; reviewer confirmed no existing parity coverage. |

## New defects introduced by v2
- [LOW, non-blocking] DES-ENUM-001 routes the `STATUS_REASONS` parity assertion to `shared-assets.test.js` (the route-text suite), but a pure JS-constant equality between `workflow-state.js` and `semantic-parsers.js` belongs where the constants live (e.g. a `workflow-state`/`target-state` test). Carry to SPEC: place the parity test next to the constants, not in the route-text suite. Not a factual error; does not warrant another CHANGES-REQUIRED round.

No factual errors, broken anchors, or contradictions were introduced. Every cited anchor (`final-response.js:162-177/:170/:176-177`, `file-set-finalize.js:510`, `helpers.js:863`, `no-state.js:240`, `file-set-no-state.js:299`, `target-context.js:570/:600-609/:249-258`, `target-state.js:27`, `workflow-state.js:25/:60`, `semantic-parsers.js:47/:402`) lands on the code v2 describes. Positive cross-check: `parseFinalResponseBlock` validates `statusReason` against the `semantic-parsers.js` `STATUS_REASONS` copy at `:402`, so updating BOTH copies is provably necessary, not redundant.

## Disposition
All 8 v1 findings resolved; one non-blocking test-placement nit carried to SPEC. DESIGN v2 is accurate, internally consistent, and hard-rule-compliant. Ready for human approval.
