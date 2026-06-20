# SPEC subagent review (v2)

stage: spec
version: 2
modifiers_triggering_review: cross_project, safety, scope_expanding
reviewer: independent read-only subagent (Plan agent), key findings re-verified against source by the coordinator
verdict: APPROVE-WITH-NITS

## Method
An independent read-only subagent audited `06-spec.md` for DESIGN→SPEC fidelity, code-anchor accuracy, implementability, PASS-reachability, test coverage, hard-rule compliance, and trace closure. The coordinator re-verified the material nit (merged-rules fingerprint absence) against source.

## Outcome
- **DESIGN→SPEC fidelity: clean.** Every DES decision and SCOPE-IN-001..008 maps to a concrete SPEC contract; no scope creep. All four DESIGN-review corrections survived into SPEC: the `final-response.js:162-177` branch amendment + empty-deferred-set allowance (SPEC-CONFIG-001, SPEC-BEHAVIOR-008), `file-set-finalize.js:510` path, both `STATUS_REASONS` copies, `reviewer-pass-fail` as a `requiredOutputSchema` (not a semantic-parsers parser), checkpoint resume as NEW wiring, and the two-state PASS-reachability rule.
- **Code anchors: 18/18 groups CONFIRMED, zero wrong.** Including `final-response.js:162-177/:170/:176-177`, `file-set-finalize.js:510`, `workflow-state.js:60`, `semantic-parsers.js:47/:402`, `target-context.js:30/:249-258/:274-276/:570/:600-609/:617-620`, `helpers.js:834/:863`, `fix-lifecycle.js:51`, `file-set-fix.js:56`, `context-pack.js:12`, `target-state.js:27`. Additive symbols (`coverage-incomplete`, `unit-review-report`, `partitionInventory`, `partitioned-review`, `resolveCodeInventory`, `projectReviewFingerprint`, `project-review`) confirmed absent today.
- **v2 nit resolved.** The two-`STATUS_REASONS`-copies parity test is routed to a constants-level test (`target-state.test.js` / a workflow-state test), NOT the route-text suite. Confirmed no existing parity test today.
- **Hard rules: no violation.** Earned PASS preserved (failure direction is safe); no bodies/secrets persisted; no new dependency; fix counting frozen per-file-set; manifest-backed safety.
- **Trace closure: clean.** All 12 SPEC ids are consumed by a planned phase; no orphan.

## Non-blocking nits (tighten in SPEC OR delegate to PLAN — reviewer-sanctioned either way)
- **[MEDIUM] merged-rules fingerprint undefined.** `reviewCacheKey` (SPEC-BEHAVIOR-004) includes a "merged-rules fingerprint" term, but no such fingerprint exists today (coordinator confirmed: `lib/context-pack.js` carries `mergedRules` `{layers, sourceList, sources, text}` but no hash over it anywhere in `lib/`). Cache soundness rests on this term. → PLAN must pin the input + algorithm (e.g. `sha256(mergedRules.text)` or an ordered digest of `sourceList` contents). Failure direction is safe (a coarser fingerprint only over-invalidates).
- **[MEDIUM] crosscuttingBackstops fixed list not in the normative body.** `units.json` carries `crosscuttingBackstops:[fixed list]` and `context --phase crosscutting --backstop <id>` takes an id, but the 7-item enumeration (security-redaction / state-machine-invariant / install-uninstall-fs-safety / cli-parser-template-consistency / cross-platform-symlink / tests-fixtures / public-contract-backcompat) lives only in the non-normative upstream summary. → inline the list into SPEC-DATA-001 / SPEC-CLI-001 (or have PLAN pin it).
- **[LOW] inventory.jsonl drops `unit_id`.** SPEC narrows the line to `{path,size,ext,contentId}`, dropping DESIGN §5's `unit_id` without stating intent (recoverable from `units.json` `files[]`). → restore `unit_id` or state the intentional drop.
- **[LOW] PASS-reachability: CLI vs model boundary.** SPEC-BEHAVIOR-005's backstop-`none` rule is checkable for the receipt's structural preconditions (all spanned units `none`, unit ids + reasoning recorded) but the "fully derivable" predicate is a model judgment. → add one sentence so PLAN asserts the structure, not derivability.
- **[LOW] aggregate.json schema thin / test filename.** Expand `aggregate.json` coverage-proof fields in PLAN (DESIGN Observability list is more concrete); the constants parity test file is `workflow-state-v2.test.js`.

## Disposition
No blocker, no high. SPEC is accurate, faithful to DESIGN, hard-rule-compliant, and trace-closed. The nits are under-specifications an implementer would otherwise re-decide; the reviewer explicitly sanctions resolving them either in SPEC or in the PLAN Handoff. Recommended: approve SPEC and carry the five nits as binding PLAN-stage items (merged-rules fingerprint definition, inline backstop list, inventory `unit_id`, CLI-vs-model PASS predicate, aggregate.json fields + correct test filename), to be resolved when PLAN writes the concrete `PLAN-TASK-*` anchors. No further SPEC review round warranted.
