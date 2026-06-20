# DESIGN subagent review (v1)

stage: design
version: 1
modifiers_triggering_review: cross_project, safety, scope_expanding
reviewer: independent read-only subagent (Plan agent), findings re-verified against source by the coordinator
verdict: CHANGES-REQUIRED

## Method
An independent read-only subagent audited `05-design.md` against the upstream brief (03), risk discovery (04), the source plan (`design/OPTIMIZATION-2026-06-20-partitioned-code-review.md`), and the project hard rules (`CLAUDE.md`/`AGENTS.md`), verifying every cited `file:line` anchor against the current repo. The coordinator then independently re-verified the load-bearing findings (#1, #2, #3, #4, #8) directly against source before recording this file.

## Code-evidence verification (10/10 anchors land on real code)
| Cited anchor | Result |
|---|---|
| `lib/target-context.js:274-276` cap + "Tunable constants, not load-bearing" | CONFIRMED |
| `lib/target-context.js:600-609` "uncapped walkDirectory(null)" | MISLABELED — `:600-609` is the `if (wholeRootStats)` **capped** branch; `walkDirectory` is defined at `:570`; the uncapped path is when `wholeRootStats` is falsy |
| `lib/target-context.js:617-620` hashFileContent readFileSync→sha256 | CONFIRMED |
| `lib/target-context.js:249-258` computeFileSetFingerprint `{path,status,contentId}` | CONFIRMED |
| `lib/target-context.js:30` git allowlist (ALLOWED_GIT_SUBCOMMANDS) | CONFIRMED |
| `lib/context-pack.js:12` CONTENT_POLICY='read-in-memory-only' | CONFIRMED |
| `shared/prompts/coordinator.md:24,67,87` | CONFIRMED |
| `lib/workflow/fix-lifecycle.js:51` MAX_FIX_ATTEMPTS=5 | CONFIRMED |
| `lib/workflow/file-set-fix.js:56` MAX_FIX_ATTEMPTS=5 | CONFIRMED |
| `lib/workflow/helpers.js:834` buildFileSetFixerGuard | CONFIRMED |
| `lib/workflow-state.js` checkpoint + checkpoint-requested exist; coverage-incomplete absent | CONFIRMED (additive) |

## Findings
- **[BLOCKER] DES-ENUM-001 under-specifies the real `final-response.js` change.** `validateReadOnly`'s `stopped-with-deferrals` branch (`lib/final-response.js:162-177`) hard-codes `Status reason ∈ {deferred-findings, round-limit}` (`:170`, `ERR_FINAL_DEFERRED_STATUS_REASON`) and requires `deferredIssueIds.length > 0` (`:176-177`, `ERR_FINAL_DEFERRED_FINDINGS_EMPTY`). Merely adding `coverage-incomplete` to the `STATUS_REASONS` allowlists passes `assertAllowedPairing` but still throws here, so the central earned-PASS-replacement state (`stopped-with-deferrals` + `coverage-incomplete`, no fabricated reviewer ID) cannot finalize. CODE finalize routes through this validator (`lib/workflow/file-set-finalize.js:510` → `validateFinalResponse`), and DES-ENUM-001 names neither the branch logic nor `file-set-finalize.js`. Re-verified: confirmed. → Fix in DESIGN: name the branch amendment (admit `coverage-incomplete`; allow empty deferred-reviewer-ID set for that reason; require a coverage-deferral owner/next-action instead) and add `lib/workflow/file-set-finalize.js` to the wiring surface.
- **[HIGH] `reviewer-pass-fail` schema is mis-located.** DES-CONTRACT-001/SCOPE-OUT-004/§5 treat `reviewer-pass-fail` as a frozen schema in `lib/semantic-parsers.js`. Re-verified: `reviewer-pass-fail` IS a real identifier — a `requiredOutputSchema` value (`lib/workflow/helpers.js:863`, `lib/workflow/no-state.js:240`, `lib/workflow/file-set-no-state.js:299`) parsed by `parseFinalResponseBlock` — but it is NOT a named parser in `semantic-parsers.js` (whose exports are `parseTriageResult`/`parseFixReport`/`parseDiffReview`/`parseFinalResponseBlock`/`readSemanticPayload`). `fix-report` (=`parseFixReport`) does live there. → Fix in DESIGN: anchor `reviewer-pass-fail` to its real location (requiredOutputSchema + `parseFinalResponseBlock`), keep `fix-report`/`parseFixReport` as the semantic-parsers freeze, and define `unit-review-report` as the additive parser there.
- **[HIGH] DES-STATE-001 resume is new wiring, not pure reuse.** `checkpoint` is excluded from `ACTIVE_STATUSES` (`lib/target-state.js:27`) and `ACTIVE_STATUS_PHASES` (`lib/workflow-state.js:25`). No existing path resumes a `checkpoint`-status target by re-dispatching partition unit-review keyed on `projectReviewFingerprint` (existing `validateResumeState` is built around document `lastKnownContentSha256`). → Fix in DESIGN: state honestly that `Status: checkpoint` + `Current phase: review` re-entry and the fingerprint-drift→blocked resume dispatch are new state-machine wiring SPEC must define, not "pure reuse".
- **[MEDIUM] Mislabeled anchor.** `lib/target-context.js:600-609` is the capped branch; re-anchor to `:570` (function) and describe the null-stats uncapped path. Re-verified: confirmed.
- **[MEDIUM] PASS-reachability tension (DES-GATE-001 vs RISK-COV-001).** With `coverage_risk` a two-state `none|high` enum and the backstop forced to `high` whenever it cannot positively confirm an emergent property, any target with an unconfirmable emergent property is pinned at `coverage-incomplete` forever — honest (never false PASS) but potentially making the headline "earned PASS to convergence" unreachable. → Acknowledge in DESIGN; SPEC must define what positive evidence lets the crosscutting backstop emit `none` so PASS is reachable.
- **[MEDIUM] ASMP-001 budget split is structural, not a pure tunable.** The 1.0MB unit + 0.5MB contract budget directly determines whether PASS is attainable; OQ-001 defers it to calibration while asserting "no design decision remains open." → SPEC should gate Phase 3 PASS enablement on the Phase 2 `coverage_risk` distribution observation.
- **[LOW] identity-field-coverage guarded only by rubric prose.** Add a deterministic test asserting `computeFileSetFingerprint`'s projection covers every identity-bearing member field (SPEC test matrix).
- **[LOW] Two `STATUS_REASONS` copies.** `coverage-incomplete` must be added to BOTH `lib/workflow-state.js:60` and `lib/semantic-parsers.js:47`; no current test asserts cross-file parity. Re-verified: confirmed. DES-ENUM-001 already lists both files; add a parity note/test.

## Hard-rule compliance
No violation found. "PASS is earned" is preserved everywhere (every gap → honest non-PASS, never false PASS); single-shot/scoped stay byte-identical; no raw bodies/secrets persisted; no new dependency; fix counting stays per-file-set; no-COMMON 4-layer stack respected; Gemini advisory-only untouched. The failure mode of the blocker is the *safe* direction (a legitimate `coverage-incomplete` is rejected, not a false PASS) — but it still ships broken until fixed.

## Disposition
The approach is sound and the reviewer confirms none of the findings are fatal. The BLOCKER + two HIGH + one MEDIUM anchor are DESIGN-artifact accuracy defects to be corrected at source (so SPEC inherits correct anchors); the two PASS-reachability MEDIUMs get a DESIGN acknowledgment + explicit SPEC-handoff items; the two LOWs become SPEC test-matrix items. See DESIGN v2 for the corrections.
