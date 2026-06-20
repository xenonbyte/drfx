---
r2p_stage: spec
r2p_version: 2
r2p_status: approved
r2p_created_at: 2026-06-20T01:59:56.227124+00:00
r2p_updated_at: 2026-06-20T02:08:17.184011+00:00
---

# Spec

## Behavior Contracts
### SPEC-BEHAVIOR-001 Trigger and mode selection
A whole-root CODE review whose surviving inventory exceeds `MAX_WHOLE_ROOT_BYTES` OR `MAX_WHOLE_ROOT_FILES` (counted after every exclusion source) returns `reviewMode:'partitioned'` instead of failing `file-set-too-large`. Under cap, and any run with an explicit `scope=`, are unchanged and never enter partitioned mode (SCOPE-IN-001).

### SPEC-BEHAVIOR-002 Deterministic whole-file binning
`partitionInventory(inventory,{unitByteBudget})` bin-packs files in directory natural order into units each with `member_bytes ≤ MAX_UNIT_BYTES`, and MUST NOT split a file across units. Determinism: identical inventory + budget ⇒ byte-identical `units.json`. A single file with `size > MAX_UNIT_BYTES` becomes its own single-member unit with `oversize_file:true`; its body is never loaded into a reviewer context and it is recorded `reviewed:false` / `coverage_risk:high` / `skipped_reason:single-file-over-budget` (SCOPE-IN-002).

### SPEC-BEHAVIOR-003 Bounded unit review and on-demand contracts
A unit reviewer context contains only that unit's file bodies, the merged rules, and the unit's `suggestedRefs` (the in-root files it `require()/import`s, computed by deterministic regex) injected as read-only references. The reviewer may read suggested refs up to `CONTRACT_READ_BUDGET`; any read beyond budget, any metadata-only review, or any property it cannot positively confirm is recorded `coverage_risk:high`. Reviewer context MUST NOT contain files outside the unit ∪ its suggestedRefs (asserted by test) (SCOPE-IN-003, SCOPE-IN-004).

### SPEC-BEHAVIOR-004 Incremental review cache
`reviewCacheKey = sha256(member_digest ++ merged-rules fingerprint ++ ordered suggestedRefs {path,contentId} ++ ordered extraReads {path,contentId})`. A prior `summaries/<unit_id>.json` may be reused ONLY when its `reviewCacheKey` recomputes identical AND every `extraReads` `{path,contentId}` still matches current content. Editing any contract file therefore forces re-review of every unit whose suggestedRefs or extraReads include it (SCOPE-IN-002, SCOPE-IN-003).

### SPEC-BEHAVIOR-005 Earned-PASS gate and PASS-reachability
PASS is returned iff ALL hold: every high-risk unit was body-reviewed; the crosscutting backstop completed; all findings are triaged; no open high/medium remains; and every unit (and the backstop) reports `coverage_risk:none`. Any miss yields `stopped-with-deferrals` + `coverage-incomplete`, never PASS. Every P0/P1/high finding forces the aggregator to re-read its location + caller/callee + test/config/contract slice before it enters the final report. PASS-reachability rule: the crosscutting backstop MAY emit `coverage_risk:none` for an emergent property ONLY when that property is fully derivable from the summaries of the units it spans, every spanned unit is itself `coverage_risk:none`, and the backstop records the explicit cross-unit reasoning and the unit ids it relied on; otherwise it MUST emit `coverage_risk:high`. Contract-class invariants do not depend on the backstop — they are covered by whole-file units + `code.md` rules + on-demand contract reads (SCOPE-IN-006).

### SPEC-BEHAVIOR-006 Checkpoint state, resume, and drift
A Phase-1 persistent partition plan writes a manifest with `Status: checkpoint` / `Status reason: checkpoint-requested` / `Current phase: review` under the existing CODE target-key, honoring reset/archive. Resume re-validates `projectReviewFingerprint`; on drift it follows the existing stale-state / `blocked` path and never silently continues; otherwise it dispatches the next unit lacking a valid `summaries/<unit_id>.json`. Because `checkpoint` is not in `ACTIVE_STATUSES`, this re-entry and dispatch is new state-machine wiring (not the document `validateResumeState` path) and MUST be specified explicitly, including the legality of a `checkpoint`-status manifest carrying `Current phase: review`. A one-shot `read-only --no-state` over-cap run returns a no-state partition plan (or an explicit unsupported/blocker) and MUST NOT write `.drfx/targets/` (SCOPE-IN-007).

### SPEC-BEHAVIOR-007 Fix integration and frozen convergence
After aggregate, the existing triage → fix → diff-review → full-re-review loop runs unchanged. The fixer write boundary is the inventory file union (so all fixes are in-set), enforced by the existing `buildFileSetFixerGuard`. After a fix round, the units re-reviewed are: directly-changed units, units whose `suggestedRefs` include a changed file, and units whose `summaries` `extraReads` include a changed file; then re-aggregate. `fixAttemptCount` stays per-file-set, the cap stays `MAX_FIX_ATTEMPTS = 5` (project-level), `rounds=` stays project-level, and the recurring-finding → `stopped-no-progress` rule is unchanged (SCOPE-IN-005); the fix-cap freeze is recorded in the document-level Non-goals.

### SPEC-BEHAVIOR-008 Finalize semantics
`stopped-with-deferrals` + `coverage-incomplete` MUST finalize successfully on both the document and file-set paths, carrying a `Deferrals or blockers` entry with a coverage-deferral owner + next action and requiring NO reviewer issue id. Read-only, advisory, Gemini, oversize-file, metadata-only, drifted/stale, and any `coverage_risk≠none` outcome can never finalize as PASS (SCOPE-IN-006).

## API / Data / Config Contracts
### SPEC-DATA-001 project-review/ persistence (no file bodies)
Under `.drfx/targets/<target-key>/project-review/`:
- `inventory.jsonl` — one line per surviving file: `{path, size, ext, contentId}` (`contentId` = streaming sha256, same namespace as `hashFileContent`); no bodies.
- `units.json` — `{reviewMode, unitByteBudget, units:[{unit_id, member_count, member_bytes, member_digest, files:[...], suggestedRefs:[{path, contentId}], oversize_file?:true}], crosscuttingBackstops:[fixed list], projectReviewFingerprint}`. `projectReviewFingerprint` = sha256 over the path-sorted `{path, contentId}` inventory projection. `unit_id` = `unit-NNN`.
- `summaries/<unit_id>.json` — coverage receipt: `{reviewed:bool, skipped:[{path, reason}], extraReads:[{path, contentId}], coverage_risk:'none'|'high', reviewCacheKey, contractsTouched:[...]}`. An `oversize_file` unit is fixed to `{reviewed:false, coverage_risk:'high', skipped_reason:'single-file-over-budget'}` and stores no body.
- `findings/<unit_id>.json` — the reviewer's existing `reviewer-pass-fail` findings, schema unchanged.
- `aggregate.json` — merged/deduped findings + coverage proof + verdict.

### SPEC-DATA-002 Status JSON and the additive unit-review-report
- Over-cap entry returns `{status:'partitioned-review', reviewMode, targetStateDir, reviewPlanPath:'project-review/units.json', unitCount, nextAction}`.
- New additive parser `unit-review-report` in `lib/semantic-parsers.js` validates the coverage receipt payload and fixes `coverage_risk` to the enum `{none, high}`. The existing `reviewer-pass-fail` required-output schema (parsed by `parseFinalResponseBlock`) and `fix-report` (`parseFixReport`) are untouched; `readSemanticPayload` dispatch gains the new type only.

### SPEC-CLI-001 Subcommands (all additive, behind partitioned mode)
- `drfx workflow context review-fix-code <mode> --phase unit-review --unit <id> --json` → that unit's bodies + merged rules + suggestedRefs; for an `oversize_file` unit returns metadata-only context + `nextAction:'record oversize coverage blocker'`.
- `drfx workflow context review-fix-code <mode> --phase crosscutting --backstop <id> --json` → summaries only (no bodies).
- `drfx workflow record-review review-fix-code <mode> --phase unit-review --unit <id> --result-stdin --json` → writes `findings/<id>.json` + `summaries/<id>.json`; accepts a restricted `unit-review-report` for oversize units.
- `drfx workflow aggregate-review <targetStateDir> --json` → dedup + coverage proof + forced high-severity re-read + verdict.

### SPEC-CONFIG-001 Enum wiring and tunables
- `coverage-incomplete` added to `STATUS_REASONS` in BOTH `lib/workflow-state.js:60` and `lib/semantic-parsers.js:47`; the `validateReadOnly` `stopped-with-deferrals` branch (`lib/final-response.js:162-177`) amended to admit it and to allow an empty deferred-reviewer-id set for that reason (gating on a coverage-deferral owner + next action); `lib/workflow/file-set-finalize.js:510` path covered; `shared/core.md` route contract updated; generator re-syncs CODE route text + fixtures.
- Tunables (same class as `MAX_WHOLE_ROOT_BYTES`): `MAX_UNIT_BYTES = 1_000_000`, `CONTRACT_READ_BUDGET = 500_000` (sum = 1_500_000 = verified single-pass budget). These are a structural determinant of PASS-reachability, not free knobs: Phase 3 PASS enablement is gated on the Phase 2 `coverage_risk` distribution observation.

## External Documentation Checked
N/A — no external dependencies

The feature uses only Node.js built-ins (`fs`, `crypto`, `path`), the already-allowlisted read-only `git` subcommands, and simple `require()/import` regex. No new npm dependency, SDK, framework, or external service is introduced, so no Context7 / external-doc lookup applies.

## Test Matrix
Phase 1 (partition plan):
- `partitionInventory` determinism and whole-file-never-split; single file > `MAX_UNIT_BYTES` → single-member `oversize_file:true` unit, not hard-cut (new or `target-context.test.js`).
- `suggestRefsFor` yields only in-root paths with `contentId`; non-JS/TS files degrade to whole-file + no refs.
- Full-tree inventory is not cap-truncated; `.drfxignore` / version-ignore / scope-wins still apply.
- `partitioned-review` status JSON shape; partition checkpoint manifest `reset` / `archive` / `resume` / stale-fingerprint behavior (`target-state.test.js`).
- Over-cap `read-only --no-state` does NOT create `.drfx/targets/`.

Phase 2 (bounded unit review):
- Unit context is bounded: only the unit's files + `suggestedRefs`, asserted no out-of-set leakage; oversize unit context is metadata-only (no body).
- Coverage receipt records reviewed / skipped+reason / extraReads; cache skip requires member + suggestedRefs + extraReads fingerprints all unchanged; editing a contract file forces re-review of every unit that read it.
- Resume from Phase-1 checkpoint re-reviews only units lacking a valid summary; `projectReviewFingerprint` drift → stale/blocked.
- `unit-review-report` parser; `coverage_risk` enum is exactly `none|high`; read-only verdict honesty (any unit `coverage_risk≠none` ⇒ not clean) (`workflow-fileset-lifecycle.test.js`, parser test).

Phase 3 (aggregate + fix + earned PASS):
- metadata-only / extra-read-overflow / oversize-file-high-risk ⇒ `stopped-with-deferrals` + `coverage-incomplete`, never PASS.
- finalize accepts `stopped-with-deferrals` + `coverage-incomplete` with an empty reviewer-id set on both document and file-set paths, but rejects PASS carrying that reason (`final-response` / finalize test).
- `coverage-incomplete` route-text/`shared/core.md`/generated-route + fixture consistency in `shared-assets.test.js`; the two `STATUS_REASONS` copies (`workflow-state.js` + `semantic-parsers.js`) parity asserted in a constants-level test (e.g. `target-state.test.js` / a workflow-state test) — NOT in the route-text suite.
- high-severity re-read enforced; contract-file change triggers dependent-unit re-review; fix stays in-set; gate satisfied ⇒ PASS; full lifecycle (`workflow-fileset-lifecycle.test.js`).

All phases: `npm run syntaxcheck` + `npm test` green; CLI surface in `cli.test.js`.

## Non-goals
- No change to the single-shot or scoped paths; under-cap and explicit `scope=` stay byte-identical (SCOPE-OUT-001).
- No tree-sitter / AST / import-graph / LSP; partitioning is directory+byte binning, dependency hints are deterministic `require()/import` regex only (SCOPE-OUT-002).
- No change to the `hashFileContent` sha256 identity namespace and no git blob OID; zero fingerprint migration (SCOPE-OUT-003).
- No change to the `reviewer-pass-fail` or `fix-report` schemas; coverage rides only the additive `unit-review-report` (SCOPE-OUT-004).
- No summary-first-primary cross-cutting; the backstop is secondary and must end `coverage_risk:high` when unconfirmed (SCOPE-OUT-005).
- No intra-file chunked review; an oversize file is a coverage blocker, never split-and-stitched (SCOPE-OUT-006).
- No change to `MAX_FIX_ATTEMPTS = 5` (per-file-set) or `rounds=` semantics (SCOPE-OUT-007).
- No raising/removing the byte cap to allow a larger single-shot (SCOPE-OUT-008).

## PLAN Handoff
PLAN produces `### PLAN-TASK-NNN` anchors grouped by the three independently-mergeable phases; every SPEC id below must be consumed by at least one task.
- Phase 1 tasks consume SPEC-BEHAVIOR-001, SPEC-BEHAVIOR-002, SPEC-DATA-001, and the Phase-1 half of SPEC-BEHAVIOR-006. Files: `lib/target-context.js` (`resolveCodeInventory`, streaming sha256, `projectReviewFingerprint`), new `lib/project-review.js` (`partitionInventory`, `suggestRefsFor`, `project-review/` IO), `lib/workflow/file-set-context.js` / `start.js` (over-cap → partitioned + checkpoint manifest), `shared/rubrics/code.md` (partitioned section + four disciplines), `lib/generator.js` + `templates/fragments/route-contract.code.{claude,codex,gemini}.md` + `test/fixtures/generated/*`.
- Phase 2 tasks consume SPEC-BEHAVIOR-003, SPEC-BEHAVIOR-004, SPEC-DATA-002, SPEC-CLI-001 (unit-review + crosscutting + record-review), and the resume half of SPEC-BEHAVIOR-006. Files: `lib/context-pack.js` (unit subset + suggestedRefs refs), new `lib/workflow/file-set-unit-review.js`, `bin/drfx.js` (context/record-review phases), `lib/semantic-parsers.js` (`unit-review-report` parser), `lib/project-review.js` (base aggregate), `shared/prompts/{reviewer,coordinator}.md`.
- Phase 3 tasks consume SPEC-BEHAVIOR-005, SPEC-BEHAVIOR-007, SPEC-BEHAVIOR-008, SPEC-CLI-001 (`aggregate-review`), and SPEC-CONFIG-001. Files: `bin/drfx.js` + `lib/project-review.js` (`aggregate-review`), `lib/workflow-state.js` + `lib/semantic-parsers.js` (both `STATUS_REASONS` copies), `lib/final-response.js` (branch amendment) + `lib/workflow/file-set-finalize.js` (path) + `shared/core.md`, fix-loop integration via existing `lib/workflow/file-set-fix.js` (no counting change), `shared/prompts/coordinator.md` (aggregator gate). Each TDD-applicable task carries a Skeleton code block. Verification per task: `npm run syntaxcheck` + `npm test`.

## Trace
| This ID | Upstream | Status |
|---|---|---|
| SPEC-BEHAVIOR-001 | SCOPE-IN-001; DES-PART-001 [ADDRESSED] | Specified |
| SPEC-BEHAVIOR-002 | SCOPE-IN-002; DES-PART-001 [ADDRESSED] | Specified |
| SPEC-BEHAVIOR-003 | SCOPE-IN-003, SCOPE-IN-004; DES-CONTRACT-001 [ADDRESSED] | Specified |
| SPEC-BEHAVIOR-004 | SCOPE-IN-002, SCOPE-IN-003; DES-CONTRACT-001 [ADDRESSED] | Specified |
| SPEC-BEHAVIOR-005 | SCOPE-IN-006; DES-GATE-001 [ADDRESSED] | Specified |
| SPEC-BEHAVIOR-006 | SCOPE-IN-007; DES-STATE-001 [ADDRESSED] | Specified |
| SPEC-BEHAVIOR-007 | SCOPE-IN-005; DES-GATE-001 [ADDRESSED] | Specified |
| SPEC-BEHAVIOR-008 | SCOPE-IN-006; DES-ENUM-001 [ADDRESSED] | Specified |
| SPEC-DATA-001 | SCOPE-IN-007; DES-STATE-001 [ADDRESSED] | Specified |
| SPEC-DATA-002 | SCOPE-IN-004; DES-CONTRACT-001 [ADDRESSED] | Specified |
| SPEC-CLI-001 | SCOPE-IN-003; DES-ARCH-001 [ADDRESSED] | Specified |
| SPEC-CONFIG-001 | SCOPE-IN-006; DES-ENUM-001 [ADDRESSED] | Specified |

## Upstream Summary (read-only)
# Design

## Design Summary
When a whole-root CODE review exceeds the honest single-pass budget, `review-fix-code` enters `reviewMode:'partitioned'` instead of the hard `file-set-too-large` block. The CLI does only deterministic, fingerprintable, cacheable work: a full-tree inventory (streaming sha256 per file), whole-file byte bin-packing into review units that never split a file, a `projectReviewFingerprint`, the existing file-set guard, and deterministic `require()/import` dependency hints. The model does only semantic work: logical grouping, contract cross-checking, findings, and coverage judgment. Each unit reviewer reads only that unit's bodies plus on-demand small contract files (read-only references fetched within `CONTRACT_READ_BUDGET`) and emits evidence-backed findings plus a coverage receipt with `coverage_risk` fixed to `none|high`. An aggregate-review dedups, proves coverage, force-re-reads every high-severity finding, then feeds the existing triage → fix → diff-review → full-re-review loop bounded to the in-set file union. PASS is earned only through a gate; any gap ends `stopped-with-deferrals` + the new `coverage-incomplete` reason. The project total size becomes unbounded while every single model call stays bounded and PASS stays provable. The work ships as three independently-mergeable phases (partition plan → bounded read-only unit review → aggregate + fix + earned PASS). The cross-module net reuses two existing mechanisms — merged rules injected into every context pack, and read-only `references` — rather than building a new fragile component.

## Current Code Evidence
- The cap and its own "tunable" self-description: `lib/target-context.js:274-276` (`MAX_WHOLE_ROOT_FILES` / `MAX_WHOLE_ROOT_BYTES`, comment "Tunable constants, not load-bearing").
- An uncapped full-tree traversal already exists and is used by scoped CODE today: `walkDirectory` (`lib/target-context.js:570`) counts and early-stops only inside its `if (wholeRootStats)` branch (`:600-609`); called with `wholeRootStats=null` that branch is skipped, so the walk is uncapped. The partition inventory reuses this null-stats path.
- Per-file identity today: `lib/target-context.js:617-620` (`hashFileContent` does `readFileSync` then sha256). The design switches to streaming sha256 to avoid single-file OOM but keeps the identical sha256 identity namespace (zero fingerprint migration).
- The fingerprint projection that the identity-field-coverage invariant guards: `lib/target-context.js:249-258` (`computeFileSetFingerprint` projects `{path,status,contentId}`).
- The git read-only allowlist a new git call must join: `lib/target-context.js:30`.
- Context packs already persist no file bodies: `lib/context-pack.js:12` (`CONTENT_POLICY='read-in-memory-only'`).
- Today a single isolated reviewer reviews "the entire resolved file set" and the CLI "only validates deterministic contracts": `shared/prompts/coordinator.md:24,67,87`. This is the exact behavior partition bounds.
- The fix-attempt cap the operator chose to freeze: `lib/workflow/fix-lifecycle.js:51` and `lib/workflow/file-set-fix.js:56` (`MAX_FIX_ATTEMPTS = 5`, per-file-set).
- The fixer write guard reused unchanged for in-set fixes: `lib/workflow/helpers.js:834` (`buildFileSetFixerGuard`).
- The `checkpoint` status and `checkpoint-requested` reason already exist in `lib/workflow-state.js`, so partition needs no new `STATUS_VALUES`; only `coverage-incomplete` is an additive `STATUS_REASONS` value.

## Requirements Coverage
- SCOPE-IN-001 (trigger → partition, not block) → DES-PART-001.
- SCOPE-IN-002 (inventory + whole-file binning + fingerprint + guard + cache) → DES-PART-001 (binning) and DES-ARCH-001 (deterministic spine).
- SCOPE-IN-003 (on-demand contract reads) → DES-CONTRACT-001.
- SCOPE-IN-004 (bounded unit reviewer + coverage receipt + disciplines-as-rules) → DES-CONTRACT-001 (receipt) and DES-ARCH-001 (rules).
- SCOPE-IN-005 (aggregate wired into existing fix loop, fix in-set) → DES-GATE-001 and Phase 3 integration.
- SCOPE-IN-006 (earned-PASS gate) → DES-GATE-001.
- SCOPE-IN-007 (project-review checkpoint state) → DES-STATE-001.
- SCOPE-IN-008 (three independently-mergeable phases) → DES-PHASE-001.
- The additive enum surface that AC-008 verifies is owned by DES-ENUM-001.

## Options Considered
- Option A — raise or remove the byte cap and keep single-shot. Rejected: returns to the unprovable "I reviewed the whole project" PASS, dilutes reviewer attention, and makes stdin handoff / debug output / token cost fragile (plan §11, SCOPE-OUT-008). Violates "PASS is earned, never assumed".
- Option B — summary-first cross-cutting as the primary mechanism for catching cross-module bugs. Rejected by the L2 verification: summarizing every unit to feed one cross-cutting pass re-hits the byte ceiling and summaries can drop the very signal a contract bug needs (plan §2.2). Kept only as a backstop (SCOPE-OUT-005).
- Option C — import-graph / AST-based unit partitioning. Rejected: adds a cross-language static-analysis maintenance surface and a heavy dependency for a deterministic step that directory + byte binning already satisfies (SCOPE-OUT-002).
- Option D (chosen) — whole-file directory+byte bin-packing, cross-module disciplines written as locally-checkable rules, and on-demand reads of the small contract files a unit actually `require()/import`s, with summary-first demoted to a backstop. Chosen because the L2 finding shows contracts concentrate in a small spine of small files reachable by deterministic regex, and most invariants are intra-file — so keeping each file whole inside one unit plus pulling its few small contracts is both stronger and simpler than Option B, with no new dependency.

## Chosen Design
### DES-ARCH-001 Deterministic / semantic boundary
The CLI owns inventory, whole-file binning, fingerprinting, the file-set guard, the per-unit review cache, and deterministic `require()/import` hints — all reproducible, fingerprintable, cacheable. The model owns logical grouping, contract cross-checking, findings, and the coverage judgment — all semantic. The cross-module net is not a new component: merged rules are already injected into every context pack (the disciplines live in `shared/rubrics/code.md`), and read-only `references` already carry on-demand files. New module `lib/project-review.js` holds the pure functions (`partitionInventory`, `suggestRefsFor`, `project-review/` read/write); `lib/target-context.js` gains `resolveCodeInventory` reusing `walkDirectory(null)`.

### DES-PART-001 Whole-file byte bin-packing and the trigger
Whole-root over `MAX_WHOLE_ROOT_BYTES` (or the file cap) enters `reviewMode:'partitioned'` rather than erroring; the file-count cap degrades from a footgun to one trigger. `partitionInventory` bin-packs files in directory natural order into units each ≤ `MAX_UNIT_BYTES`, and never splits a file. A single file larger than `MAX_UNIT_BYTES` becomes its own single-member `oversize_file:true` unit whose body is never loaded into a reviewer context; it is recorded immediately as `coverage_risk:high` / `skipped_reason:single-file-over-budget`. `unit_id = unit-NNN`; the unit's member-content digest is its cache key.

### DES-CONTRACT-001 On-demand contract reads and the coverage receipt
A unit's context lists the in-root files it `require()/import`s (deterministic regex, no graph) as suggested read-only references. The reviewer pulls them within `CONTRACT_READ_BUDGET`; any read beyond budget, metadata-only review, or unconfirmable property records `coverage_risk:high`. `coverage_risk` is a fixed `none|high` enum carried by a new additive `unit-review-report` parser in `lib/semantic-parsers.js`. The frozen contracts are: the reviewer's `reviewer-pass-fail` required-output schema — a `requiredOutputSchema` identifier (`lib/workflow/helpers.js:863`, `no-state.js:240`, `file-set-no-state.js:299`) parsed by `parseFinalResponseBlock`, not a named parser in `semantic-parsers.js` — and the `fix-report` schema (`parseFixReport` in `semantic-parsers.js`); neither changes, and `findings/<unit_id>.json` carries the reviewer's existing PASS/FAIL findings unchanged, with coverage riding only the new `unit-review-report`. The four disciplines (redaction-at-write-boundary, identity-field-coverage, allowlist-only-git, status/phase legality) are written into the `code.md` partitioned section as locally-checkable rules.

### DES-GATE-001 Earned-PASS gate
PASS requires all of: every high-risk unit body-reviewed, the cross-cutting backstop completed, all findings triaged, no open high/medium, and every unit `coverage_risk=none`. Any miss yields `stopped-with-deferrals` + `coverage-incomplete` — never PASS. Each P0/P1/high finding forces the aggregator to re-read its location plus caller/callee and test/config/contract slice before it enters the final report. An `oversize_file:true` unit that was never body-reviewed forces `coverage-incomplete` and blocks auto-fix/PASS. PASS-reachability note: because `coverage_risk` is two-state, the crosscutting backstop must be able to emit `none` on positive evidence — otherwise a target with any unconfirmable emergent property is pinned at `coverage-incomplete` forever. SPEC defines what positive evidence closes an emergent property to `none` so earned PASS stays reachable; the contract-class invariants this repo actually carries are covered by whole-file units + rules + on-demand reads, independent of that backstop.

### DES-STATE-001 project-review persistence and checkpoint mounting
A new `project-review/` directory (`inventory.jsonl`, `units.json`, `summaries/<unit_id>.json`, `findings/<unit_id>.json`, `aggregate.json`) lives under a valid CODE target-state manifest. Phase 1 plan-only persistent runs write `Status: checkpoint` / `Status reason: checkpoint-requested` / `Current phase: review`, reusing existing target-key/reset/archive rules; partition review is a sub-phase of `review`, so no new `PHASE_VALUES`. Important honesty: `checkpoint` is NOT an active status (`ACTIVE_STATUSES` at `lib/target-state.js:27`, and `ACTIVE_STATUS_PHASES` at `lib/workflow-state.js:25`, both exclude it), and the existing `validateResumeState` resume path is built around document-target fingerprints (`lastKnownContentSha256`). So re-entering a `Status: checkpoint` + `Current phase: review` target as an active partitioned review, and a resume dispatch that re-validates `projectReviewFingerprint` (drift → existing stale-state / `blocked` handling) and advances by reading `units.json` + `summaries/`, are NEW state-machine wiring SPEC must define — not a pure reuse. A one-shot `read-only --no-state` run returns a no-state plan and never writes `.drfx/targets/`.

### DES-ENUM-001 Additive coverage-incomplete enum
`coverage-incomplete` is a new `STATUS_REASONS` value added to BOTH hand-maintained copies — `lib/workflow-state.js:60` and `lib/semantic-parsers.js:47` — and is a reason paired with the existing `stopped-with-deferrals` status (not a new final status). Allowlisting it is necessary but NOT sufficient: the actual gate is the `validateReadOnly` `stopped-with-deferrals` branch (`lib/final-response.js:162-177`), which hard-codes `Status reason ∈ {deferred-findings, round-limit}` (`:170`) and requires non-empty `deferredIssueIds` (`:176-177`). That branch must be amended to admit `coverage-incomplete` and to allow an empty deferred-reviewer-ID set for that reason, gating instead on a `Deferrals or blockers` coverage-deferral owner + next action (no fabricated reviewer issue ID). CODE finalize reaches this validator via `lib/workflow/file-set-finalize.js:510` (`validateFinalResponse`). The wiring surface is therefore: `workflow-state.js` + `semantic-parsers.js` (both `STATUS_REASONS` copies), `final-response.js` (branch logic, not just the allowlist), `file-set-finalize.js` (path coverage), and the `shared/core.md` route contract. The generator re-syncs CODE route text + fixtures; `shared-assets.test.js` asserts `coverage-incomplete` consistency across surfaces AND cross-file parity of the two `STATUS_REASONS` copies.

### DES-PHASE-001 Three independently-mergeable phases
Phase 1 turns the over-cap block into a deterministic partition plan (usable even for manual per-unit review). Phase 2 runs bounded read-only unit review producing coverage-aware `read-only-findings` / `read-only-clean`. Phase 3 adds aggregate re-review, fix integration, and earned PASS. Each phase ships a usable state if the next never lands. The fix phase keeps `fixAttemptCount` per-file-set, cap 5, `rounds=` project-level — `lib/workflow/file-set-fix.js` counting is unchanged.

## Decision Requests
none

## Rollback
All three phases are additive and hidden behind the over-cap branch and new subcommands; single-shot and scoped paths are byte-identical, so they carry zero rollback risk. `project-review/` state is cleanable like any target-local state. Only one additive enum value (`coverage-incomplete`) and one additive schema (`unit-review-report`) are introduced. There is no data migration: the sha256 identity namespace is deliberately frozen, so existing persisted CODE fingerprints are unchanged. Rollback of any phase is a plain revert — reverting Phase 3 leaves Phase 2's read-only review intact, and reverting Phase 2 leaves Phase 1's plan output intact.

## Observability
Per-unit coverage receipts record reviewed / skipped+reason / extraReads `{path,contentId}` / `coverage_risk`. The aggregate emits a coverage proof: files discovered, body-reviewed, extra-read, skipped+reason, whether every high-risk unit was fully reviewed, and residual risk. The over-cap entry returns a `partitioned-review` JSON status with `reviewMode`, `unitCount`, and `nextAction`. Non-PASS outcomes are surfaced explicitly as `stopped-with-deferrals` + `coverage-incomplete` with an owner and next action — never a silent pass. Phase 2 read-only runs additionally observe the `coverage_risk` distribution purely to calibrate the §9 tunables; that observation changes numbers, not structure.

## SPEC Handoff
The SPEC stage must pin down: (1) the `partitioned-review` status JSON and the `units.json` / `inventory.jsonl` / coverage-receipt field contracts; (2) the new `unit-review-report` schema and the fixed `coverage_risk: none|high` enum; (3) the CLI surface — `context ... --phase unit-review|crosscutting --unit <id>`, `record-review ... --phase unit-review --unit <id> --result-stdin`, and `aggregate-review <targetStateDir>`; (4) the `reviewCacheKey` formula (member digest + merged-rules fingerprint + suggestedRefs `{path,contentId}` + recomputed extraReads fingerprints) and the incremental-skip rule; (5) the `coverage-incomplete` enum wiring across the four code surfaces plus generated routes and fixtures; (6) the earned-PASS gate predicate and the oversize-file blocker; (7) behavior contracts for resume / fingerprint-drift and the no-state read-only path; (8) the per-phase test matrix; (9) the exact `final-response.js` `stopped-with-deferrals` branch amendment and `file-set-finalize.js` path coverage for `coverage-incomplete`, plus cross-file parity of the two `STATUS_REASONS` copies (DES-ENUM-001); (10) the positive-evidence condition under which the crosscutting backstop may emit `coverage_risk:none` so earned PASS is reachable, and Phase 3 PASS enablement gated on the Phase 2 `coverage_risk` distribution — the 1.0MB/0.5MB budget split is a structural determinant of PASS-reachability, not a free tunable; (11) a deterministic test asserting `computeFileSetFingerprint`'s projection covers every identity-bearing member field (not only a rubric rule). External-documentation note for SPEC: the feature adds no external dependency (Node built-ins + git + regex only), so the External Documentation Checked inventory is `N/A — no external dependencies`.

## Trace
| This ID | Upstream | Status |
|---|---|---|
| DES-ARCH-001 | SCOPE-IN-002, SCOPE-IN-004 | Chosen |
| DES-PART-001 | SCOPE-IN-001, SCOPE-IN-002; RISK-OVR-001 [DEFERRED] | Chosen |
| DES-CONTRACT-001 | SCOPE-IN-003, SCOPE-IN-004; RISK-CACHE-001 [ADDRESSED]; RISK-SEC-001 [ADDRESSED] | Chosen |
| DES-GATE-001 | SCOPE-IN-005, SCOPE-IN-006; RISK-PASS-001 [ADDRESSED]; RISK-COV-001 [DEFERRED] | Chosen |
| DES-STATE-001 | SCOPE-IN-007; RISK-STATE-001 [ADDRESSED]; RISK-DRIFT-001 [ADDRESSED] | Chosen |
| DES-ENUM-001 | AC-008; RISK-ENUM-001 [ADDRESSED] | Chosen |
| DES-PHASE-001 | SCOPE-IN-008; RISK-PHASE-001 [ADDRESSED] | Chosen |

## Upstream Summary (read-only)
# Risk Discovery

## Risks
### RISK-PASS-001 Partitioned review claims PASS without full coverage
Status: Open — mitigated by design. A reviewer that splits the tree into units could converge to PASS while a unit was only metadata-reviewed or its high-severity finding never re-read. Because `review-fix-code` runs against arbitrary external projects (cross_project), a false PASS would propagate to any large codebase. This is the central correctness risk and the reason the whole feature exists as earned-PASS, not advisory.

### RISK-SEC-001 New write boundaries omit redaction (redaction-everywhere)
Status: Open — mitigated by rule + receipt. The new `project-review/` persistence (inventory, units, summaries, findings, aggregate) adds write boundaries; any that skips `redactSensitive` is a silent secret leak with no runtime backstop (safety). Coverage receipts and summaries must store no raw file bodies.

### RISK-COV-001 Pure emergent cross-system properties not bound to any contract file
Status: Accepted — deformed to honest non-PASS. Whole-system properties (e.g. "is the error-handling strategy across N modules self-consistent") bind to no contract file, so the summary-only backstop can still miss them. This is the one residual L2 cannot eliminate offline (plan §8).

### RISK-OVR-001 Single file larger than MAX_UNIT_BYTES cannot be body-reviewed
Status: Accepted — classified as coverage blocker. The plan deliberately does not build intra-file chunking, so an oversize file cannot be faithfully body-reviewed in one bounded pass.

### RISK-CACHE-001 Stale per-unit review cache reused after a contract change
Status: Open — mitigated by cache key. Reusing `summaries/<unit_id>.json` after a depended-on contract file changed would silently miss a regression in every unit that read it.

### RISK-DRIFT-001 Fingerprint drift mid-run and identity-field-coverage omission
Status: Open — mitigated by fingerprint + rule. A worktree edited during a long partitioned run drifts `projectReviewFingerprint`, risking an inconsistent aggregate; separately, a new member field that affects fingerprint identity but is omitted from the `computeFileSetFingerprint` projection makes drift itself silently undetectable (L2 invariant, `lib/target-context.js:249-258`).

### RISK-STATE-001 project-review/ checkpoint state integrity
Status: Open — mitigated by manifest mounting. The new persistent state could become a floating directory without a manifest, or break existing reset/archive/resume/stale-state handling, corrupting a target's lifecycle.

### RISK-ENUM-001 coverage-incomplete enum drifts across surfaces (scope_expanding)
Status: Open — mitigated by shared-asset test. The additive `coverage-incomplete` reason must stay consistent across `workflow-state.js`, `semantic-parsers.js`, `final-response.js`, `shared/core.md`, and the generated/embedded CODE route text + fixtures; any surface left on the old enum makes finalize reject a legitimate state or skills carry a stale contract.

### RISK-PHASE-001 A phase is not independently mergeable
Status: Open — mitigated by phase cut. If Phase 2 or 3 cannot ship a usable state alone, one stuck phase blocks the whole release and wastes review effort.

## Boundaries
- Single-shot and scoped (`scope=`) paths stay byte-identical; under-cap and explicit-scope behavior does not change (SCOPE-OUT-001).
- The `hashFileContent` sha256 identity namespace is frozen; zero fingerprint migration, no git blob OID (SCOPE-OUT-003).
- The `reviewer-pass-fail` and `fix-report` schemas are frozen; coverage rides a separate additive `unit-review-report` (SCOPE-OUT-004).
- The fix-attempt cap (`MAX_FIX_ATTEMPTS = 5`, per-file-set) and `rounds=` semantics are frozen; partition restructures review only (SCOPE-OUT-007).
- The per-call single-pass context bound is preserved; only the project-total block is removed (Non-Goal).
- No AST / import-graph / LSP; partitioning uses directory + byte binning, dependency hints use deterministic `require()/import` regex only (SCOPE-OUT-002).

## Scope Overflow Risks
- Pressure to make partitioning "smarter" with an import graph or AST would add a cross-language maintenance surface and contradict SCOPE-OUT-002; hold the line at whole-file directory+byte binning.
- Pressure to just raise/remove the byte cap and keep single-shot would re-introduce the unprovable "whole project reviewed" PASS (SCOPE-OUT-008); the cap stays, partition is the path.
- Pressure to add per-unit or per-issue fix-attempt counting would change convergence semantics the operator chose to freeze (SCOPE-OUT-007); fix counting stays per-file-set.
- Pressure to build intra-file chunking for oversize files would open a large new review surface mid-plan (SCOPE-OUT-006); oversize stays a coverage blocker deferred to a separate design.
- Pressure to promote the summary-first cross-cutting pass to primary would restore the fragile byte-bound mechanism L2 rejected (SCOPE-OUT-005); it stays a backstop that must end `coverage_risk:high` when unconfirmed.

## Mitigations
- RISK-PASS-001 → earned-PASS gate: PASS only when every high-risk unit is body-reviewed, all findings triaged, no open high/medium, and all units `coverage_risk=none`; every P0/P1/high is force-re-read at aggregate; otherwise `stopped-with-deferrals` + `coverage-incomplete`.
- RISK-SEC-001 → redaction-at-write-boundary written as a locally-checkable rule in `shared/rubrics/code.md`; receipts/summaries persist no raw bodies; a redaction test covers the new write points.
- RISK-COV-001 → accepted and deformed: this class always ends `coverage_risk:high` → non-PASS (honest failure, never false PASS); Phase 2 read-only runs observe its distribution only for §9 calibration.
- RISK-OVR-001 → oversize file becomes a single-member `oversize_file:true` unit with `reviewed:false` / `coverage_risk:high` / `skipped_reason:single-file-over-budget`; aggregate maps it to `coverage-incomplete`; a fixture proves no false clean/PASS.
- RISK-CACHE-001 → `reviewCacheKey` = member digest + merged-rules fingerprint + `suggestedRefs` `{path,contentId}` + recomputed `extraReads` fingerprints; editing a contract file forces re-review of every unit that read it.
- RISK-DRIFT-001 → resume re-validates `projectReviewFingerprint`; drift reuses existing stale-state/`blocked` handling (never silent continue); identity-field-coverage written as a code.md rule so a new identity field must enter the projection.
- RISK-STATE-001 → `project-review/` must mount under a valid CODE target-state manifest (`Status: checkpoint`), reusing existing target-key/reset/archive/resume/stale-state; one-shot `read-only --no-state` returns a no-state plan and never writes `.drfx/targets/`.
- RISK-ENUM-001 → `shared-assets.test.js` asserts `coverage-incomplete` consistency across `shared/core.md`, generated CODE routes, and embedded skill text; the generator re-syncs route text + fixtures.
- RISK-PHASE-001 → three independently-mergeable phases: Phase 1 ships a plan-only deterministic output, Phase 2 ships read-only coverage-aware findings, Phase 3 ships aggregate + fix + earned PASS; each is usable if the next never lands.

## Trace
| This ID | Upstream | Status |
|---|---|---|
| RISK-PASS-001 | SCOPE-IN-006 (earned-PASS gate) | Mitigated |
| RISK-SEC-001 | SCOPE-IN-004, SCOPE-IN-007 (rules + persistence) | Mitigated |
| RISK-COV-001 | plan §8 residual risk | Accepted (non-PASS) |
| RISK-OVR-001 | SCOPE-OUT-006 (no intra-file chunking) | Accepted (blocker) |
| RISK-CACHE-001 | SCOPE-IN-002, SCOPE-IN-003 (cache + refs) | Mitigated |
| RISK-DRIFT-001 | SCOPE-IN-002 (fingerprint), plan §2.2 L2 | Mitigated |
| RISK-STATE-001 | SCOPE-IN-007 (project-review state) | Mitigated |
| RISK-ENUM-001 | SCOPE-IN-006, AC-008 (enum consistency) | Mitigated |
| RISK-PHASE-001 | SCOPE-IN-008 (three phases) | Mitigated |

## Upstream Summary (read-only)
# Requirement Brief

## Goal
`review-fix-code` must auto review **and** fix an entire project's code, looping to convergence, without being forced to manually split by directory (`scope=`) because of the whole-root size cap. When whole-root exceeds the honest single-pass budget it enters `reviewMode:'partitioned'`: the CLI does only deterministic work (inventory, whole-file byte bin-packing, fingerprint, guard, cache); the model reviews per unit with bounded body + on-demand small-contract reads and emits evidence-backed findings plus a coverage receipt; an aggregator merges, re-reads high-severity findings, proves coverage, and PASS is earned by a gate. Project size becomes unbounded, each single model call stays bounded, and PASS stays provable. This is the earned-PASS mode (isolated read-only reviewer → guarded fix → independent re-review → loop), not advisory edit-as-you-read.

## In-Scope
- SCOPE-IN-001 Whole-root over the single-pass budget enters `reviewMode:'partitioned'` instead of the hard `file-set-too-large` block; the file-count cap becomes one trigger, not a footgun.
- SCOPE-IN-002 Deterministic CLI inventory + whole-file byte bin-packing that never splits a file, plus `projectReviewFingerprint`, file-set guard, and per-unit review cache.
- SCOPE-IN-003 On-demand contract reads: deterministic `require()/import` regex lists a unit's in-root dependencies as read-only references, fetched within `CONTRACT_READ_BUDGET`.
- SCOPE-IN-004 Bounded per-unit reviewer producing evidence-backed findings plus a coverage receipt with `coverage_risk` fixed to `none|high`; cross-module disciplines written as locally-checkable rules.
- SCOPE-IN-005 Aggregate-review (dedup, coverage proof, forced high-severity re-read) wired into the existing triage → fix → diff-review → full-re-review loop, fix bounded to the in-set file union.
- SCOPE-IN-006 Earned-PASS gate: PASS only when every high-risk unit is body-reviewed, findings triaged, no open high/medium, and all units `coverage_risk=none`; otherwise `stopped-with-deferrals` + new `coverage-incomplete` reason.
- SCOPE-IN-007 New persistent `project-review/` state mounted under a valid CODE target manifest using existing `checkpoint` status, honoring reset/archive/resume/stale-state; one-shot `read-only --no-state` returns a no-state plan and never writes `.drfx/targets/`.
- SCOPE-IN-008 Delivered as three independently-mergeable phases (partition plan → bounded read-only unit review → aggregate + fix + earned PASS).

## Out-of-Scope
- SCOPE-OUT-001 Changing the single-shot or scoped paths; under-cap and explicit `scope=` behavior stays byte-identical.
- SCOPE-OUT-002 tree-sitter / AST / import-graph / LSP semantic parsing or any dependency-graph construction.
- SCOPE-OUT-003 Changing the `hashFileContent` sha256 identity namespace or introducing git blob OID; zero fingerprint migration (streaming only guards against single-file OOM).
- SCOPE-OUT-004 Changing the `reviewer-pass-fail` or `fix-report` schemas; coverage rides a separate additive `unit-review-report`.
- SCOPE-OUT-005 A summary-first-primary cross-cutting pass; it exists only as a backstop that must end in `coverage_risk:high` (non-PASS) when unconfirmed.
- SCOPE-OUT-006 Intra-file chunked review; a single file over `MAX_UNIT_BYTES` becomes a coverage blocker, never split-and-stitched.
- SCOPE-OUT-007 Changing the fix-attempt cap (`MAX_FIX_ATTEMPTS = 5`, per-file-set) or `rounds=` semantics; partition restructures only review, not the fix count/convergence.
- SCOPE-OUT-008 Raising or removing the byte cap to allow a larger single-shot review.

## Non-Goals
- Increasing the per-call single-pass context budget (the bound is deliberately preserved; only the project-total block is removed).
- Producing an unprovable "I reviewed the whole project" PASS — that violates the project's "PASS is earned, never assumed" rule.
- Adding any new runtime/package dependency; the feature uses Node built-ins + git + simple regex only.
- Turning `review-fix-code` into an advisory edit-as-you-read flow.

## Assumptions
- ASMP-001 `MAX_UNIT_BYTES` (1,000,000) + `CONTRACT_READ_BUDGET` (500,000) = 1,500,000 is a faithful single reviewer-pass budget, aligned to the current `MAX_WHOLE_ROOT_BYTES`.
- ASMP-002 Cross-module contracts concentrate in a small spine of small files reachable via `require()/import` regex (L2 finding); most invariants are intra-file.
- ASMP-003 Whole-file bin-packing keeps each file intact inside one unit, so intra-file invariants are never cut across units.
- ASMP-004 Existing read-only `references` plus merged-rules injection are a sufficient cross-module net; no new mechanism is required.
- ASMP-005 Per the L1 measurement, partition is needed only when one call must cover src+tests and auto-fix to convergence; pure source review can still be solved by exclusion/`scope=`.

## Acceptance Criteria
- AC-001 Whole-root over cap no longer hard-blocks; it returns a partitioned plan with an inventory and whole-file unit bins (Phase 1).
- AC-002 `partitionInventory` is deterministic and never splits a file; a single file > `MAX_UNIT_BYTES` yields a single-member `oversize_file:true` unit, not a hard cut.
- AC-003 Unit review context contains only that unit's files plus suggested refs (asserted: no out-of-set leakage); a coverage receipt is recorded per unit (Phase 2).
- AC-004 Cache skip requires member + `suggestedRefs` + `extraReads` fingerprints all unchanged; editing a contract file forces re-review of every unit that read it.
- AC-005 Aggregate emits a coverage proof and forced high-severity re-read; PASS only when the gate is satisfied, else `stopped-with-deferrals` + `coverage-incomplete` (Phase 3).
- AC-006 An oversize-file fixture provably never yields a false clean or false PASS.
- AC-007 Fix stays inside the in-set union; `fixAttemptCount` stays per-file-set, cap stays 5, `rounds=` stays project-level — all unchanged.
- AC-008 `npm run syntaxcheck` + `npm test` are green each phase; the `coverage-incomplete` enum is consistent across `workflow-state.js`, `semantic-parsers.js`, `final-response.js`, `shared/core.md`, and generated CODE routes + fixtures.

## Open Questions
- OQ-001 (non-blocking, owner: implementer at Phase 2) The two tunable constants `MAX_UNIT_BYTES` and `CONTRACT_READ_BUDGET` carry verified initial values; Phase 2 may calibrate the numbers against the first real large target but must not change structure. No design decision remains open — §8 residual risks are accepted and deformed to honest non-PASS, §9 values are calibration-only.

## Sources
- `design/OPTIMIZATION-2026-06-20-partitioned-code-review.md` — the full validated plan (north star §0/§2.3, building/not-building §3, key decisions §4, persistence §5, three-phase plan §6, residual risk §8, tunables §9).
- `design/DESIGN-v3.md` — current baseline design (pass).
- Code evidence: `lib/target-context.js:274-276` (cap + "Tunable constants, not load-bearing" comment), `:600-609` (uncapped `walkDirectory`), `:617-620` (`hashFileContent`), `:249-258` (`computeFileSetFingerprint` identity projection), `:30` (git read-only allowlist); `lib/context-pack.js:12` (`CONTENT_POLICY='read-in-memory-only'`); `shared/prompts/coordinator.md:24,67,87` (single reviewer reviews the entire file set; CLI validates only deterministic contracts); `lib/workflow/fix-lifecycle.js:51` and `lib/workflow/file-set-fix.js:56` (`MAX_FIX_ATTEMPTS = 5`).
- Codex `/review` partitioned reviewer pattern (inspiration for per-unit bounded review, not copied implementation).

## Trace
| This ID | Upstream | Status |
|---|---|---|
| SCOPE-IN-001 | plan §1 现状勘察, §4.2 decision 2 | Phase 1 |
| SCOPE-IN-002 | plan §4.2 decision 1, §5 inventory/units | Phase 1 |
| SCOPE-IN-003 | plan §4.2 decision 4, §4.1 references net | Phase 2 |
| SCOPE-IN-004 | plan §4.2 decision 3, §5 unit-review-report | Phase 2 |
| SCOPE-IN-005 | plan §6 Phase 3 aggregate + fix integration | Phase 3 |
| SCOPE-IN-006 | plan §4.2 decision 5, §6 Phase 3 gate | Phase 3 |
| SCOPE-IN-007 | plan §5 project-review state, §6 Phase 1 checkpoint | Phase 1-2 |
| SCOPE-IN-008 | plan §6 (three independently-mergeable phases) | Phases 1-3 |

## Upstream Summary (read-only)
# 优化方案 — `review-fix-code` 解除全项目体量限制(partitioned project review)

- 日期：2026-06-20
- 范围：`lib/target-context.js`、`lib/context-pack.js`、`lib/workflow-state.js`、`lib/semantic-parsers.js`、`lib/final-response.js`、`lib/workflow/*`、`lib/project-review.js`(新)、`bin/drfx.js`、`shared/core.md`、`shared/rubrics/code.md`、`shared/prompts/{reviewer,coordinator}.md`、`lib/generator.js`、`templates/fragments/route-contract.code.*`、`test/`
- 目标读者：包维护者 / 后续实现该计划的工程师或 agent
- 当前版本：`0.6.4`
- 当前基线设计：`design/DESIGN-v3.md`（pass）
- 状态：**已通过两轮验证（L1 体量、L2 跨模块漏检），方案已据验证结果重塑**；核心诉求(北极星)已记入 §0/§2.3；fix-attempt cap 与 `rounds=` **保持现状不变**（per-file-set，见 §4 决策 7）；**全部决策已定、无未决项**（§9 为可调初值，§8 为已接受残余风险）；待批准实现

---

## 0. TL;DR

**核心诉求(北极星)**：`review-fix-code` 这个技能应当能**自动 review + fix 一个项目的全部代码，循环直到没有问题(收敛)才结束**——而不是因体量上限被迫**按目录手动拆**多次跑。本方案的全部设计都服务于这一条。

`review-fix-code` 想支持"整个项目、无总大小限制、且质量可证明"，正解**不是**把 `MAX_WHOLE_ROOT_BYTES`（当前 1.5MB）调大或取消，而是：whole-root 超出单次诚实预算时进入 `reviewMode:'partitioned'`——CLI 只做 inventory / **whole-file 字节分桶** / 指纹 / guard / 缓存；model 按 review unit 读有限正文、**按需拉取少数小契约文件**、产出 evidence-backed findings + coverage receipt；aggregator 合并、复核高严重、出覆盖证明，PASS 由 gate 赚取。项目体量无上限，单次 model 调用始终有界，PASS 可证明。

本方案与"直接扩大 cap"的根本区别：保留"单次 review unit 的上下文上限"，只取消"项目总大小阻塞"。

---

## 1. 现状勘察（已核实）

| 项 | 现状 | 证据 |
|---|---|---|
| whole-root 硬上限 | 300 文件 / 1,500,000 bytes，超出 `file-set-too-large` 硬阻塞 | `lib/target-context.js:275-276,724-729`；`describeCodeBlock` `:851` |
| 上限定性 | 注释明确 `Tunable constants, not load-bearing`（调参旋钮，非正确性不变量） | `lib/target-context.js:274` |
| cap 计数时机 | 在所有排除（built-in dirs + `.drfxignore` + git version-ignore）之后 | `walkDirectory` `:600-609` |
| 每文件身份 | `hashFileContent` 整文件 `readFileSync` 后 sha256 | `lib/target-context.js:617-620` |
| context pack 内容 | 只存骨架（file list / scope / ignore / rules），不存正文（`CONTENT_POLICY='read-in-memory-only'`） | `lib/context-pack.js:12` |
| 实际审查方式 | 一个**隔离 read-only reviewer subagent** 一次性审查"**the entire resolved file set**" | `shared/prompts/coordinator.md:24,67` |
| CLI 职责边界 | "the CLI only validates deterministic contracts"——语义判断全留给 model | `shared/prompts/coordinator.md:87` |
| 遍历能力 | `walkDirectory(wholeRootStats=null)` 不计数、不早停；scoped CODE 已走此无上限路径 | `lib/target-context.js:600,691-693` |

**真实瓶颈**：CLI 不持久化正文，但单个 reviewer 在一次语义审查中会装入整套文件正文。1.5MB cap 是在保护 workflow 不要假装完成了不可证明的"全项目审查"。这一诊断成立。

---

## 2. 验证结论（本方案的核心，先验证后改方案）

### 2.1 L1 — 体量假设：本仓库**不需要** partition（用排除/scope 即可）

对本仓库 whole-root CODE 审查实测（tracked == 全部源码，工作树干净）：

| 配置 | bytes | files | 对 cap（300 / 1.5MB） |
|---|---|---|---|
| 无 `.drfxignore` | 3,072,128 | 168 | **byte cap 超 2.05×**；file cap 不触发 → **blocked** |
| 其中 `test/` | 2,102,656 | 76 | — | 撑爆 cap 的唯一驱动 |
| 有 `.drfxignore`（有效排除=仅 `test/`） | 969,472 | 92 | **两项都过** → single-shot 可用 |

`test/` 内部：`test/fixtures (other)` 975,195 / 23；`test/*.test.js` 803,704 / 35；`test/fixtures/generated` 323,757 / 18。

关键事实：
1. `docs/`、`design/`、`.codegraph` 已被 `.gitignore`，CODE review 经 version-ignore 自动排除；`.drfxignore` 里它们冗余，**唯一有效排除是 `test/`**。
2. **300-file cap 从未触发**；真正卡住的只有 byte cap，且**仅因把 2MB 测试套件算进去**。
3. 本仓库当前已运行在"通过"档（`.drfxignore` 排除 `test/` 后 0.97MB），whole-root review 今天即可工作。

**L1 推论**：对单包项目，1.5MB 的"排除后非测试源码"已属偏大；cap 多半因 tests/fixtures 被计入而触发，而那应由排除/scope 解决。**partition 仅在一种情形下才被需要**（见 2.3）。

### 2.2 L2 — 质量假设：跨模块漏检风险**真实**，但契约集中在极少数小文件

(a) 确认存在"运行时不报错、分单元会漏、只有 review 兜底"的跨模块不变量：

| 不变量 | 证据 | 运行时兜底 | 分单元会漏 |
|---|---|---|---|
| redaction-everywhere（每个落盘点必须 `redactSensitive`） | 22 调用点散在 9 文件，无中央强制 | 否（漏写=静默泄密） | 会，除非 reviewer 知道该纪律 |
| identity-field-coverage（`computeFileSetFingerprint` 只投影 `{path,status,contentId}`，member 新增影响身份字段却漏加 → drift 静默漏检） | `lib/target-context.js:249-258` | 否 | 取决于构造点/投影是否同 unit |
| git read-only allowlist（新 git 调用须进白名单） | `lib/target-context.js:30` | 部分（越界报错） | 多为同文件，风险低 |

(b) 结构发现（决定设计）：契约集中在一个小 "spine"，且每个 spine 文件都小到能塞进一个 unit——`workflow-state.js` 32KB、`target-context.js` 41KB、`redaction.js` 3.4KB、`manifest.js` 28KB、`semantic-parsers.js` 19KB。因此：
- **大多数不变量是 intra-file 的** → 只要**绝不把单个文件拆到两个 unit**，这类不会被切断。
- **跨 file 耦合只指向少数小契约文件** → unit reviewer **按需拉取**它依赖的那个小文件即可对照，无需"summary-first 猜测 + 复读"。

**L2 推论（推翻上一版最脆弱部分）**：对契约类，不必靠脆弱的"cross-cutting 吃 summary 抓跨模块 bug"（会撞回字节上限、summary 可能丢信号）。更强且更简单的主力机制 = **whole-file 分桶 + 把纪律写成可本地核查的规则 + 按需拉取小契约文件**。summary-first cross-cutting **降级为兜底**，仅处理"无契约文件可依、纯涌现性"的少数属性，且必须以 `coverage_risk:high`=非 PASS 收场，绝不静默 PASS。

### 2.3 北极星需求（operator 原话，本方案的目标）

> `review-fix-code` 应能**自动 review + fix 一个项目的全部代码，循环直到没有问题(收敛)才结束**；当前因体量上限，项目过大就只能**按目录手动 `scope=` 拆**多次跑——本方案要免去这个手动拆分，让一条 whole-root 调用内部自动分片并跑完整收敛循环。

技术等价表述：需要对**整棵树（含测试在内、排除后仍 >1.5MB）在一条调用里跑自动 review-fix 到收敛，并给统一的、可证明覆盖的 verdict**。

边界澄清（与 advisory 区分）：这里要的是 drfx 那套"read-only reviewer 发现 → 守卫下 fix → 独立复审 → 循环到收敛"的**可证明 PASS** 模式，**不是**"同一 agent 随手边读边改"的 advisory 模式（后者拿不到 earned PASS）。

什么时候用不到 partition：
- "review 项目"=只审源码 → 排除/scope 掉 test，single-shot 即可，**无需 partition**。
- 必须一条调用覆盖 src+test 并自动修到收敛 → single-shot 做不到，`scope=` 拆多次跑**丢失统一收敛与覆盖证明** → 这是 partition 唯一真正解决的东西。

本方案在此前提下成立。

---

## 3. 方案边界（Building / Not building）

### Building
whole-root 超单次诚实预算时进入 `reviewMode:'partitioned'`：CLI 做确定性 inventory + whole-file 字节分桶 + 指纹 + guard + 缓存；model 按 unit 审查、按需拉契约文件、产 findings + coverage receipt；aggregator 合并/复核/出覆盖证明，PASS 由 gate 赚取。

### Not building
- 不动 single-shot 与 scoped 路径（under-cap、scoped 行为零变化）。
- 不引入 tree-sitter / AST / import-graph 语义解析。分桶只按**目录 + 字节预算**；依赖提示只用 `require()/import` 的**确定性正则**（JS/TS 适用，其他语言退化为 whole-file + 按需读），绝不构图。
- 不改 `hashFileContent` 身份命名空间（仍 sha256 of worktree content，**零指纹迁移**），只改 streaming 防超大单文件 OOM；**不**用 git blob OID（`ls-files -s` 取 index，漏未暂存编辑；PR 路由正因此用 `worktreeBlobSha`）。
- 不改 `reviewer-pass-fail` / `fix-report` schema；coverage 走独立新增 `unit-review-report`。
- **不建以 summary-first 为主的 cross-cutting**（L2 已否）；它只作降级兜底。
- **不建文件内分块 review**：单个文件大于 `MAX_UNIT_BYTES` 时，本计划不把它切成多段让 model 拼接理解；该情况按 coverage blocker 处理（见 §4.2/§6），不允许假 PASS。

---

## 4. 架构与关键决策

### 4.1 确定性 / 语义边界
- **CLI**：inventory、whole-file 分桶、指纹、guard、缓存、确定性 `require/import` 提示。全部确定性、可指纹化、可缓存。
- **model**：逻辑分组、契约核查、findings、coverage 判断。全部语义。

主力跨模块网（复用现有机制，非新造脆弱件）：
1. merged rules 已注入每个 context pack；把纪律写进 `code.md`。
2. `references`（`readOnly:true`）已是只读读入机制；用它承载"按需契约文件"。

### 4.2 Key decisions
1. **whole-file 字节分桶**（纯确定性）：按目录子树自然序 bin-pack，每普通 unit ≤ `MAX_UNIT_BYTES`（初值见 §9）；**永不拆分单个文件**。单文件超预算 → 自成 `oversize_file:true` 的 over-budget unit，**不把正文塞进 reviewer context**，立即记录 `coverage_risk:high` / `skipped_reason:single-file-over-budget`，最终只能得到 `stopped-with-deferrals` + `coverage-incomplete`，除非操作者先拆小该文件或未来另立文件内分块设计。`unit_id = unit-NNN` + member 内容 digest（缓存键）。
2. **触发即分片，不再硬阻塞**：whole-root 超 `MAX_WHOLE_ROOT_BYTES`（或 files）→ 进 partitioned，而非 `file-set-too-large`。file-count cap 由此**自动从"误杀 footgun"降级为触发器之一**。
3. **纪律写成可本地核查的规则**（进 `shared/rubrics/code.md` partitioned 段）：redaction-at-write-boundary、identity-field-coverage、allowlist-only-git、status/phase legality。
4. **按需契约读取**：unit context 用确定性 `require/import` 正则把该 unit 依赖的 in-root 文件列为**建议只读引用**；reviewer 在 `CONTRACT_READ_BUDGET`（初值见 §9）内拉取；额外读入记进 coverage receipt；`coverage_risk` 枚举固定为 `none|high`，任何越界、metadata-only 或无法确证的情况都写 `high`。
5. **earned PASS gate**：全部 high-risk unit 已 body-review + cross-cutting 兜底完成 + findings 全 triage + 无未决 high/medium + 所有 unit `coverage_risk=none`。任一不满足 → `stopped-with-deferrals` + `coverage-incomplete`，**绝不 PASS**。
6. 三阶段各自可独立合并；`project-review/` 为 target-local 状态，沿用现有清理规则；**无数据迁移**。
7. **fix-attempt cap 与 `rounds=` 保持现状、不因 partition 改变**（operator 决定）：CODE target 仍是**一个 file-set、一个 `fixAttemptCount`**；`MAX_FIX_ATTEMPTS = 5` 仍是**项目级**兜底（= 最多 5 个 whole-project fix 轮次，每轮修掉当前全部 accepted issues 再复审，**非 per-unit、非 per-issue**）；`rounds=<n>` 仍是项目级可选 loop 上限；recurring-finding → `stopped-no-progress` 规则不变。partition 只重构 **review** 的分块方式，不改 **fix** 的计数与收敛口径。

---

## 5. 持久化 schema（target 目录下新增 `project-review/`）

```text
.drfx/targets/<target-key>/project-review/
  inventory.jsonl    # 每行 {path,size,ext,contentId,unit_id};无正文
  units.json         # {reviewMode,unitByteBudget,
                     #  units:[{unit_id,member_count,member_bytes,member_digest,files[],suggestedRefs:[{path,contentId}],oversize_file?}],
                     #  crosscuttingBackstops:[固定列表],
                     #  projectReviewFingerprint}
  summaries/<unit_id>.json  # coverage receipt + reviewCacheKey + extraReads[{path,contentId}] + interface/contracts-touched 摘要(Phase 2)；oversize unit 只记录 skipped_reason/coverage_risk，不记录正文
  findings/<unit_id>.json   # 该 unit 的 reviewer-pass-fail findings(Phase 2)
  aggregate.json            # 合并/去重/coverage/verdict(Phase 2 基础;Phase 3 加复核)
```

- `project-review/` **必须挂在有效 CODE target-state manifest 下**，不得成为无 manifest 的游离目录。Phase 1 只产 plan 时，persistent `review-and-fix` / `resume` / `reset` / `ledger=` 路径的 manifest 写成 `Status: checkpoint`、`Status reason: checkpoint-requested`、`Current phase: review`，`Next action` 指向继续 Phase 2 unit review；它不是 active review/fix loop，但仍使用现有 target-key、reset、archive、resume、stale-state 校验和清理规则。一次性 `read-only --no-state` 路径仍不得写 `.drfx/targets/`：它只返回 no-state partition plan（或明确 unsupported/blocker），不创建 `project-review/`。
- `crosscuttingBackstops` 固定派生自 `code.md` priority surfaces：`security-redaction / state-machine-invariant / install-uninstall-fs-safety / cli-parser-template-consistency / cross-platform-symlink / tests-fixtures / public-contract-backcompat`（仅 prompt 标识，非 CLI 逻辑）。
- `projectReviewFingerprint` = 按路径排序的 `{path, contentId}` 清单 sha256（任一文件内容或路径变 → 聚合失效；单 unit `member_digest` 仍用于增量缓存入口）。
- `reviewCacheKey` = `member_digest` + merged-rules fingerprint + `suggestedRefs` 的 `{path,contentId}` 有序 sha256；复用旧 `summaries/<unit_id>.json` 前还必须重算其中 `extraReads[{path,contentId}]`，任一建议引用或实际额外读取文件变更都强制该 unit 重新 review。
- `oversize_file:true` 只允许出现在单成员 unit；其 coverage receipt 固定为 `reviewed:false`、`coverage_risk:high`、`skipped_reason:single-file-over-budget`，并由 aggregate gate 映射为 `coverage-incomplete`。

---

## 6. 三阶段实现计划

> 每阶段独立可合并：Phase N 合并后系统处于可用状态，即使 N+1 永不落地。

### Phase 1 — `file-set-too-large` 改为 partitioned plan（确定性、只读输出）
**独立价值**：目标项目不再被硬阻塞，拿到 inventory + whole-file 分桶 plan（即便手动逐 unit 审也可用）。

改动：
- `lib/target-context.js`：新增 `resolveCodeInventory({cwd,scopes,commandLog})`，复用 `walkDirectory(null)` 全量遍历 → `{path,size,ext,contentId(streaming sha256)}`；新增 `projectReviewFingerprint`。
- 新模块 `lib/project-review.js`：纯函数 `partitionInventory(inventory,{unitByteBudget})`（whole-file 分桶）、`suggestRefsFor(unitFiles)`（确定性 `require/import` 正则，仅产 in-root 路径）、`project-review/` 读写。
- `lib/workflow/file-set-context.js` / `start.js`：CODE whole-root 命中超限 → persistent 路径创建 manifest-backed checkpoint state，构建并写 plan，返回 `{status:'partitioned-review',reviewMode,targetStateDir,reviewPlanPath:'project-review/units.json',unitCount,nextAction}`；manifest 用现有 `checkpoint` + `checkpoint-requested`，**不新增 `STATUS_VALUES`**，但 reset/archive/resume/stale-state 必须按普通 target state 生效。一次性 `read-only --no-state` 路径只返回 no-state partition plan 或显式 unsupported/blocker，保持不落盘契约。
- `shared/rubrics/code.md`：加 partitioned 段（unit PASS≠project PASS；Key decision 3 四条纪律；跨 unit finding 必须命名具体依赖边/caller path）。
- `lib/generator.js` + `templates/fragments/route-contract.code.{claude,codex,gemini}.md` + `test/fixtures/generated/*`：同步说明。

测试：`partitionInventory` 确定性 & whole-file 不拆；单文件 > `MAX_UNIT_BYTES` 生成单成员 `oversize_file:true` unit 且不硬切；`suggestRefsFor` 只产 in-root 路径且带 contentId；全量遍历不被 cap 截断；`.drfxignore` / version-ignore / scope-wins 仍生效；`partitioned-review` JSON；partition checkpoint 的 reset/archive/resume/stale-fingerprint 行为；read-only no-state 超限不创建 `.drfx/targets/`；`npm run syntaxcheck` + `npm test`；手动对 >cap fixture 跑 `drfx workflow start review-fix-code` 得 plan。

### Phase 2 — bounded unit-review + 兜底 cross-cutting（只读项目审查）
**独立价值**：能跑只读分片审查，得到 coverage 化的 `read-only-findings` / `read-only-clean`。

改动：
- `lib/context-pack.js`：`buildFileSetContextPack` 支持 unit 子集 + 注入 `suggestedRefs` 为只读 references；加 `reviewMode/unit_id`。
- `bin/drfx.js` + 新 `lib/workflow/file-set-unit-review.js`：
  - `drfx workflow context review-fix-code <mode> --phase unit-review --unit <id> --json` → 仅该 unit 正文 + merged rules + 建议契约引用。
  - `drfx workflow record-review ... --phase unit-review --unit <id> --result-stdin --json` → 写 `findings/<id>.json` + `summaries/<id>.json`（coverage receipt：reviewed / skipped+reason / extraReads[{path,contentId}] / `coverage_risk:none|high` + contracts-touched 摘要）；`reviewCacheKey` 与 extraReads 指纹都未变时才可跳过（增量）。
- **从 Phase 1 checkpoint 恢复并推进状态**：`context --phase unit-review` 先校验目标处于本 file-set 的 partition checkpoint（`Status: checkpoint` / `checkpoint-requested`）且 `projectReviewFingerprint` 未漂移（漂移 → 复用现有 stale-state / `blocked` 处理，不静默续审）；通过后按 `units.json` 顺序发下一个"无有效 `summaries/<unit_id>.json`"的 unit。Phase 2 全程 `Current phase` 仍为 `review`（partitioned review 即 review 阶段的分块，**不新增 `PHASE_VALUES`**；`unit-review` 只是 context 的子 phase 标志，非 manifest phase）；逐 unit 完成度由 `summaries/` + `reviewCacheKey` 记录，故中断后 resume 自然从下一个未审 unit 继续。全部 unit 完成后交 aggregate 收口。
- oversize unit 处理：`context --phase unit-review --unit <id>` 对 `oversize_file:true` 返回 metadata-only context 和 `nextAction:'record oversize coverage blocker'`；不派发正文 reviewer。`record-review` 接受受限的 `unit-review-report` payload，写 `reviewed:false`、`skipped_reason:single-file-over-budget`、`coverage_risk:high`；aggregate 因此不得 clean/PASS。
- `lib/semantic-parsers.js`：新增 `unit-review-report` schema（additive，不动现有），并固定 `coverage_risk` 枚举为 `none|high`。
- cross-cutting **兜底**：`--phase crosscutting --backstop <id>`，context = 仅 summaries；仅用于无契约文件可依的涌现性属性；拿不到确证 → 必须写 `coverage_risk:high`（非 PASS），不得静默通过。
- `shared/prompts/{reviewer,coordinator}.md`：加 unit-review + 按需契约读取 + 兜底循环说明。
- `lib/project-review.js`：**基础 aggregate**——拼接 findings + coverage receipt，verdict 仅 `read-only-findings`，或（零 findings 且全 unit `coverage_risk=none`）`read-only-clean`。

测试：unit context 有界（只含该 unit + 建议引用，断言无越界）；oversize unit 不含正文、只产 metadata-only coverage blocker；按需读入记入 receipt；缓存跳过必须同时满足 member、suggestedRefs、extraReads 指纹不变；修一个契约文件会强制所有读取过它的 unit 复审；从 Phase 1 checkpoint resume 只续审无有效 summary 的 unit、`projectReviewFingerprint` 漂移时按 stale/blocked 处理；兜底 pack 断言无正文；`unit-review-report` parser；只读 verdict 诚实性（任一 unit `coverage_risk≠none` → 不得 clean）。

### Phase 3 — aggregate-review 复核 + fix 集成 + earned PASS
**独立价值**：覆盖证明 + 高严重复核 + 可证明 PASS + 自动 fix。

改动：
- `bin/drfx.js` + `lib/project-review.js`：`drfx workflow aggregate-review <targetStateDir> --json` 增强——去重（location+category）；coverage receipt（discovered / body-reviewed / extra-read / skipped+reason / high-risk-units-fully-reviewed / residual risk）；每个 P0/P1/high 强制 aggregator 复读 location + caller/callee + test/config/contract 切片才入终报。
- `lib/workflow-state.js` + `lib/semantic-parsers.js` + `lib/final-response.js` + `shared/core.md`：三个 final/status validation allowlist 和共享路由契约都加 `coverage-incomplete`；`final-response` 允许 `Final status: stopped-with-deferrals` + `Status reason: coverage-incomplete`，要求 `Deferrals or blockers` 写明 coverage deferral 的 owner 和 next action，但不要求伪造 reviewer issue ID。更新后必须通过 generator 同步生成/嵌入的 CODE 路由文本与 fixtures，避免 skill 内嵌合同仍列旧枚举。
- fix 集成：聚合后接入**现有** triage / fix / diff-review / full-re-review；fix guard（`buildFileSetFixerGuard`，`lib/workflow/helpers.js:834`）写边界 = inventory 文件并集，天然 in-set；修后重审受影响 unit、其 `suggestedRefs` 命中的 unit、以及 summaries 中 `extraReads` 命中的 unit，再 re-aggregate；PASS 仅经 Key decision 5 的 gate。
- oversize unit gate：任一 `oversize_file:true` unit 未被正文 review 时，aggregate 直接产 `stopped-with-deferrals` + `coverage-incomplete`，next action 是拆小该文件、显式排除它，或等待独立的文件内分块方案；不得进入自动 fix 或报告 PASS。
- **fix-attempt 计数与收敛口径保持现状（见 §4 决策 7）**：fix 阶段按**项目级轮次**跑（一次 begin-fix/end-fix 修掉当前全部 accepted issues，over 整个 file-set 并集），`fixAttemptCount` 仍 per-file-set、cap 仍 5、`rounds=` 仍项目级；`lib/workflow/file-set-fix.js` 的计数逻辑**无需改动**。
- `shared/prompts/coordinator.md`：aggregator gate 段。

测试：metadata-only / extra-read-overflow / oversize-file high-risk → `stopped-with-deferrals` + `coverage-incomplete`（从不 PASS）；finalize 接受 `Status reason: coverage-incomplete` 的 `stopped-with-deferrals`，但拒绝 PASS 携带该 reason；`shared-assets.test.js` 覆盖 `shared/core.md`、生成 CODE 路由、嵌入 skill 文本中的 `coverage-incomplete` 枚举一致性；高严重复核；契约文件改动会触发依赖 unit 复审；fix 不越 in-set；gate 满足才 PASS；全生命周期 lifecycle 测试。

---

## 7. 规模 / 回滚 / 迁移

- **规模**：大型功能 + 1 新模块，跨 `target-context / project-review(新) / context-pack / workflow-state / semantic-parsers / final-response / lib/workflow/* / bin/drfx / shared/{core,rubrics,prompts} / generator+templates+fixtures` + 大测试增量（现 806）。L2 重塑后比初版更小（主力机制复用现有 references / merged-rules，去掉了 summary-first 为主的复杂度）。
- **回滚**：三阶段全 additive，藏在超限分支与新子命令后，single-shot / scoped 零改动；`project-review/` 可清理；仅 1 个 additive 枚举值。回滚 = revert。
- **迁移**：**无**。刻意保留 sha256 身份命名空间，既有持久化 CODE 指纹不变。

---

## 8. 残余风险（已识别、已接受、已变形为诚实非 PASS）

**纯涌现性、不绑定任何契约文件的全系统属性**（如"这 N 个模块的错误处理策略是否整体自洽"），兜底 cross-cutting 吃 summary 仍可能漏。这是 L2 唯一无法离线消除的残余。

**已为其变形（这不是未决问题，是已接受并已缓解的风险）**：此类一律以 `coverage_risk:high` → `stopped-with-deferrals` 收场——**失败 = 诚实非 PASS，不是假 PASS**。契约类（redaction / identity / allowlist / status——本仓库实测的主要风险）已由 whole-file unit + 规则化纪律 + 按需契约读取覆盖，不依赖该假设。

> **不阻塞本计划**：设计已保证该残余只会表现为 `coverage_risk` 升高→非 PASS（而非假 PASS）。Phase 2 只读跑时顺带观测 `coverage_risk` 分布，仅用于 §9 数值微调，不改变方案结构。

**单文件超预算**同样不是假 PASS 风险：本计划不实现文件内分块，因此它被明确归类为 coverage blocker。该文件会被 inventory/fingerprint/guard 捕获，但不会被声称已正文审查；聚合结论必须是 `coverage-incomplete`，直到文件被拆小、排除，或另一个已批准设计补上文件内分块审查。

---

## 9. 可调默认值（已定初值，Phase 2 仅做校准，无未决问题）

无未决决策。以下为带初值的可调常量，与现有 `MAX_WHOLE_ROOT_BYTES` 同属"Tunable constants, not load-bearing"：

- `MAX_UNIT_BYTES = 1_000_000`：普通 unit 自身正文上限；单文件超过该值时不拆分，标记为 oversize coverage blocker。
- `CONTRACT_READ_BUDGET = 500_000`：按需契约读取的额外预算；超出 → `coverage_risk:high` → 非 PASS。
- **依据**：二者之和 1,500,000 = 已验证的单次"忠实读完"预算（对齐 `MAX_WHOLE_ROOT_BYTES`）——一个 reviewer 一次 pass 读 unit 正文 + 必要契约文件 + merged rules 仍在预算内。
- Phase 2 在首个真实大目标上按观测**仅微调数值、不改结构**；不阻塞落地。

---

## 10. 验证命令 / Definition of Done

- 每阶段：`npm run syntaxcheck` + `npm test` 全绿；新增行为有 `*.test.js` 贴边覆盖（分桶/解析→新建或 `target-context.test.js`；状态→`workflow-state` / `target-state.test.js`；route 文本→`shared-assets.test.js`；CLI→`cli.test.js`；file-set 生命周期→`workflow-fileset-lifecycle.test.js`）。
- 公共行为变化时同步 `README.md` / `README.zh-CN.md`（技术字面保持英文）。
- 完成判据：whole-root 超限不再硬阻塞而是产出 partition plan（P1）；可跑只读分片审查并得 coverage 化只读结论（P2）；aggregator 出覆盖证明、高严重复核、gate 满足才 PASS、否则 `stopped-with-deferrals` + `coverage-incomplete`（P3）；单文件超预算 fixture 必须证明不会假 clean/PASS。

---

## 11. 不建议的做法（连同理由，避免回潮）

- **不**把 1.5MB 调成 10/50MB：注意力稀释、stdin handoff / 调试输出 / token 成本变脆，且仍不可证明全项目审查。
- **不**完全取消 cap 继续 single-shot：回到"我已 review 全项目"的不可证明假 PASS，违反 `PASS is earned`。
- **不**引入大型静态分析依赖（tree-sitter / LSP / 全量 AST）：跨语言维护成本高，本方案用 Node 内置 + git + 简单正则即可。
- **不**改现有 reviewer schema 塞 coverage 字段：会扩散 `lib/semantic-parsers.js` blast radius；coverage 走独立 `unit-review-report`。
<!-- /r2p-read-only -->

## Project Context (read-only)
# Project Context Pack

- repo_root: `/Users/xubo/x-studio/document-review-fix`
- languages: {'JavaScript': 36148}
- package_managers: npm
- test_commands: ['npm test']
- entrypoints: ['lib/workflow/index.js']
- config_files: none
- dependencies (0): none
- source_dirs: ['bin', 'design', 'docs', 'lib', 'scripts', 'shared', 'skills', 'templates', 'test']
<!-- /r2p-read-only -->
<!-- /r2p-read-only -->

## Project Context (read-only)
# Project Context Pack

- repo_root: `/Users/xubo/x-studio/document-review-fix`
- languages: {'JavaScript': 36148}
- package_managers: npm
- test_commands: ['npm test']
- entrypoints: ['lib/workflow/index.js']
- config_files: none
- dependencies (0): none
- source_dirs: ['bin', 'design', 'docs', 'lib', 'scripts', 'shared', 'skills', 'templates', 'test']
<!-- /r2p-read-only -->
<!-- /r2p-read-only -->

## Project Context (read-only)
# Project Context Pack

- repo_root: `/Users/xubo/x-studio/document-review-fix`
- languages: {'JavaScript': 36148}
- package_managers: npm
- test_commands: ['npm test']
- entrypoints: ['lib/workflow/index.js']
- config_files: none
- dependencies (0): none
- source_dirs: ['bin', 'design', 'docs', 'lib', 'scripts', 'shared', 'skills', 'templates', 'test']
<!-- /r2p-read-only -->
<!-- /r2p-read-only -->

## Project Context (read-only)
# Project Context Pack

- repo_root: `/Users/xubo/x-studio/document-review-fix`
- languages: {'JavaScript': 36148}
- package_managers: npm
- test_commands: ['npm test']
- entrypoints: ['lib/workflow/index.js']
- config_files: none
- dependencies (0): none
- source_dirs: ['bin', 'design', 'docs', 'lib', 'scripts', 'shared', 'skills', 'templates', 'test']
<!-- /r2p-read-only -->
