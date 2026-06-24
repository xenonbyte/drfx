# Spec

## Behavior Contracts
### SPEC-BEHAVIOR-001 Workflow JSON mode semantics
Upstream: DES-OUT-001 [ADDRESSED], DES-OUT-002 [ADDRESSED]

- `drfx workflow <subcommand> ... --json` MUST keep the existing full JSON behavior.
- `drfx workflow <subcommand> ... --json=full` MUST produce the same shape as bare `--json`.
- `drfx workflow <subcommand> ... --json=compact` MUST produce compact JSON for that workflow subcommand.
- `drfx workflow <subcommand> ... --json=<invalid>` MUST fail closed with an `ERR_WORKFLOW_FLAG`-style error and MUST NOT silently choose full or compact.
- JSON value parsing MUST apply only to `workflow` commands. `doctor --json` and `status --json` remain boolean options.
- Full mode MUST remain the default for `formatWorkflowJson(result)` callers that do not pass mode options.
- Compact mode MUST NOT change workflow execution, persisted manifests, ledgers, receipts, guard reports, context artifacts, locks, or review payload validation.

### SPEC-BEHAVIOR-002 Compact field allowlist and continuation
Upstream: DES-OUT-002 [ADDRESSED], DES-ROUTE-001 [ADDRESSED]

- Compact JSON MUST be driven by a per-subcommand allowlist, not by deleting a global set of fields.
- Every full-output field that can be emitted by route-automated workflow subcommands MUST be classified as `stdout required`, `user status`, `path readable`, or `debug only`.
- Compact JSON MAY include `path readable` fields only as paths. It MUST NOT inline the body behind those paths.
- Compact JSON MUST include status and continuation essentials for each relevant subcommand, including `ok`, `status`, `blockingReason`, `statusReason`, `nextAction` when present, and required state/report/context paths.
- Compact JSON MUST omit `contextPackSkeleton`, raw prompts, raw transcripts, raw logs, complete file skeleton bodies, full partitioned `units`, full `summaries`, and full `coverageProof` unless a SPEC-approved future subcommand reclassifies a bounded scalar/count field.
- Generated routes MUST switch automated workflow calls to `--json=compact` only when compact tests prove route continuation can still locate required artifacts.

### SPEC-BEHAVIOR-003 Size budget and generated route behavior
Upstream: DES-BUDGET-001 [ADDRESSED], DES-ROUTE-001 [ADDRESSED], DES-SHARED-001 [ADDRESSED]

- Size tests MUST use deterministic local proxies such as bytes and `Math.ceil(bytes / 4)` token approximation. They MUST NOT depend on network or external tokenizer services.
- When full context output contains `contextPackSkeleton`, compact context JSON MUST satisfy `compactBytes <= max(2048, floor(fullBytes * 0.35))` and MUST omit `contextPackSkeleton`.
- For partitioned context cases where full output contains full `units`, `summaries`, or `coverageProof`, compact JSON MUST satisfy `compactBytes <= max(4096, floor(fullBytes * 0.50))` and MUST omit those full collections.
- Route shell budget tests MUST use the current checked-in fixture as the baseline and allow growth of at most `max(4096, ceil(baselineBytes * 0.08))` per platform x route. Budget failures MUST identify platform, route, baseline bytes, actual bytes, allowed bytes, and growth.
- Generated route fixtures MUST be updated only for intentional changes: `--json=compact`, compact/full debug guidance, prompt/schema changes, or measured size fixture additions.
- Codex shared de-duplication MUST remain measurement-gated. Implement de-duplication only if measurement shows the largest Codex route shell would shrink by at least 16 KiB and at least 12%, no Codex route grows, and offline install/invocation plus missing copied-source fail-closed tests pass. If any condition fails, the accepted behavior is to keep static embedding and record the measured no-op outcome in a test snapshot or developer-facing note.

### SPEC-BEHAVIOR-004 Shared fix-report schema
Upstream: DES-SCHEMA-001 [ADDRESSED], DES-FIX-001 [ADDRESSED]

- Document and file-set fix reports MUST accept the same section order: `Fixed:`, `Files changed:`, `Not fixed:`, optional `Verification:`, `Residual risk:`.
- `Verification:` MUST be optional for both document and file-set workflow acceptance.
- When `Verification:` is present, it MUST contain at least one list item; an empty section MUST block as `fix-report-mismatch`.
- Unknown sections or wrong section order MUST block as `fix-report-mismatch`.
- `parseFixReport()` MUST keep returning `verification: null` when the section is absent and an array of redacted strings when it is present.
- Route prompts MAY continue instructing agents to record per-round verification. Parser/workflow acceptance MUST NOT block solely because the section is absent.
- Normalized fix reports MUST preserve present verification and MUST NOT synthesize verification success when absent.

### SPEC-BEHAVIOR-005 Document `fix-report-mismatch` retry
Upstream: DES-FIX-002 [ADDRESSED]

- Document `begin-fix` MUST accept retry only when manifest state is `Status: blocked`, `Current phase: fix`, and `Blocking reason: fix-report-mismatch`.
- Retry MUST reuse the latest persisted passed begin-fix guard baseline through the existing guard-report reader. It MUST fail closed if the baseline is missing, unparseable, failed, has a target mismatch, lacks a passed rollback anchor, or lacks a passed target-only guard.
- Retry MUST verify references have not changed using the persisted reference fingerprints.
- Retry MUST validate that current worktree changes are restricted to the target and the state directory, using the original guard baseline rather than resampling the modified target as clean.
- Retry MUST reacquire the lock before returning to `Status: fix`.
- Retry MUST NOT change accepted findings, ledger issue IDs, ledger issue statuses, `currentRound`, `fixAttemptCount`, or mark issues fixed.
- A successful retry MUST return `nextAction: retry end-fix with a valid fix report`.
- A successful corrected `end-fix` after retry MUST transition to `diff-review`, not PASS.

### SPEC-BEHAVIOR-006 Documentation and user-visible blocker output
Upstream: DES-DOCS-001 [ADDRESSED], DES-FIX-002 [ADDRESSED]

- User-visible `fix-report-mismatch` output MUST distinguish safe retry from reset/manual recovery.
- Default outputs MUST avoid raw JSON dumps, raw prompt text, raw transcripts, raw logs, target body content, secrets, and unredacted payload bodies.
- Debug/full diagnosis MUST be available through full JSON and artifact paths.
- README behavior documentation MUST keep English and Simplified Chinese README structures aligned.

## API / Data / Config Contracts
### Workflow JSON mode API
- `formatWorkflowJson(result, options = {})` accepts `options.mode` with `full` or `compact` and `options.subcommand` for compact allowlist selection.
- Calling `formatWorkflowJson(result)` with no options remains full mode.
- `parseWorkflowArgs()` returns compatibility boolean `json: true` when any workflow JSON mode is requested and a new `jsonMode` value of `full` or `compact`.
- A helper such as `parseWorkflowJsonMode(args)` MAY be added for `bin/drfx.js` error-format decisions, but it MUST share validation rules with workflow argument parsing.

### Compact allowlist data
- Add a single source of truth such as `COMPACT_WORKFLOW_JSON_FIELDS`.
- Each listed field has a purpose label: `stdout required`, `user status`, `path readable`, or `debug only`.
- The allowlist MUST cover route-automated subcommands: `preflight`, `start`, `context`, `record-review`, `record-triage`, `begin-fix`, `refresh-lock`, `end-fix`, `abort-fix`, `record-diff-review`, `finalize`, file-set context/review/triage, partitioned unit/crosscutting/aggregate paths, and any no-state contexts used by generated routes.
- Tests MUST fail when a full-output key emitted by a route-automated subcommand has no classification.

### Fix-report data contract
- `parseFixReport(text, { allowVerification: true })` is used by both document and file-set `end-fix`.
- `fixReport.verification === null` means the report omitted `Verification:`.
- `Array.isArray(fixReport.verification)` means the report included a non-empty verification list.
- File-set receipts MUST include verification only when it is present. They MUST NOT call `.join()` on `null` or invent a verification result.
- Existing normalized report persistence through `writeNormalizedFixReport()` remains JSON-based and needs no migration.

### Document retry state contract
- Add a document retry helper that mirrors file-set retry structure without changing manifest schema.
- Safe retry returns to `status: begin-fix` / manifest `Status: fix`, `Current phase: fix`, `Blocking reason: none`, and includes lock metadata plus a guard report path.
- Safe retry MUST preserve the manifest's pre-retry `currentRound` and `fixAttemptCount`; it is a report-resubmission path, not a new fix attempt.
- Unsafe retry remains `status: blocked` with a specific `blockingReason`, a guard/report path when available, and a recovery-oriented `nextAction`.
- No new external config, dependency, or environment variable is introduced.

## External Documentation Checked
N/A — no external dependencies

- Reference-only note: `rtk-ai/rtk` informed output-filtering direction, but this SPEC introduces no runtime dependency and no version-sensitive external contract.

## Test Matrix
| Contract | Tests |
|---|---|
| SPEC-BEHAVIOR-001 | CLI/workflow tests for `--json`, `--json=full`, `--json=compact`, invalid `--json=bad`, and unchanged `doctor --json` / `status --json`. |
| SPEC-BEHAVIOR-002 | Compact allowlist tests for each route-automated subcommand; context compact excludes `contextPackSkeleton`; partitioned compact excludes full `units`, `summaries`, and `coverageProof` unless represented as counts/paths. |
| SPEC-BEHAVIOR-003 | Route fixture tests show generated workflow calls use `--json=compact`; route size budget tests cover platform x route with `max(4096, ceil(baselineBytes * 0.08))`; compact/full byte comparison tests enforce context ratios. |
| SPEC-BEHAVIOR-003 | Codex shared measurement test records current route bytes, embedded shared bytes, copied shared bytes, and duplicate bytes; behavior changes only when the 16 KiB plus 12% reduction and fail-closed conditions pass. |
| SPEC-BEHAVIOR-004 | Parser tests accept document and file-set reports with and without non-empty `Verification:`; reject empty verification, wrong order, and unknown sections. |
| SPEC-BEHAVIOR-004 | Prompt/schema contract tests prove shared prompts and parser section order stay aligned for reviewer, triage, fix, diff-review, and final-response payloads. |
| SPEC-BEHAVIOR-005 | Workflow lifecycle test: invalid document fix report blocks as `fix-report-mismatch`; `begin-fix` retry reuses original baseline; corrected report advances to `diff-review`. |
| SPEC-BEHAVIOR-005 | Retry preservation test asserts `fixAttemptCount`, `currentRound`, accepted issue IDs, and ledger issue statuses are unchanged between blocked retry begin-fix and corrected `end-fix`. |
| SPEC-BEHAVIOR-005 | Negative retry tests: missing baseline, reference mutation, non-target mutation, target-only guard unavailable, and lock reacquisition failure all fail closed. |
| SPEC-BEHAVIOR-006 | README content tests or targeted assertions confirm compact/full docs and retry guidance are present in both README files with aligned structure. |
| All contracts | `npm run syntaxcheck` and `npm test` pass after implementation. |

## Non-goals
- Do not change `doctor` / `status` JSON contracts.
- Do not remove full JSON output or debug artifact paths.
- Do not reduce reviewer isolation, guard checks, diff review, full re-review, final-response validation, or redaction.
- Do not introduce runtime dependencies or external service calls.
- Do not implement Codex shared de-duplication unless measurement and fail-closed tests justify it.
- Do not rewrite workflow state schema, ledgers, manifests, or route invocation grammar beyond the specified JSON mode and retry behavior.
- Do not make absent verification a generated-route best practice; generated prompts still ask agents to record verification.

## PLAN Handoff
- Start with tests for JSON mode parsing and compact output allowlists so route switching is blocked until compact is proven sufficient.
- Implement full-compatible `formatWorkflowJson(result, { mode, subcommand })` and workflow-only JSON mode parsing.
- Add compact context and partitioned compact tests before generated route changes.
- Update generated route calls to `--json=compact` and refresh fixtures by hand according to repository guidance.
- Add size budget tests and Codex shared measurement. Apply Codex de-duplication only if the 16 KiB plus 12% route-shrink threshold and fail-closed tests pass; otherwise record no behavior change.
- Add prompt/parser schema tests, then align document/file-set `Verification:` acceptance.
- Implement document blocked retry using the original guard baseline and add positive/negative workflow tests, including preservation of `fixAttemptCount`, `currentRound`, accepted issue IDs, and ledger issue statuses.
- Update README.md and README.zh-CN.md for public behavior changes.
- Run targeted tests after each batch, then `npm run syntaxcheck` and `npm test`.

## Trace
<!-- Map this stage's IDs to upstream/downstream. R3 derives & checks closure. -->
| This ID | Upstream | Status |
|---|---|---|
| SPEC-BEHAVIOR-001 | DES-OUT-001 [ADDRESSED], DES-OUT-002 [ADDRESSED] | [ADDRESSED] |
| SPEC-BEHAVIOR-002 | DES-OUT-002 [ADDRESSED], DES-ROUTE-001 [ADDRESSED] | [ADDRESSED] |
| SPEC-BEHAVIOR-003 | DES-BUDGET-001 [ADDRESSED], DES-ROUTE-001 [ADDRESSED], DES-SHARED-001 [ADDRESSED] | [ADDRESSED] |
| SPEC-BEHAVIOR-004 | DES-SCHEMA-001 [ADDRESSED], DES-FIX-001 [ADDRESSED] | [ADDRESSED] |
| SPEC-BEHAVIOR-005 | DES-FIX-002 [ADDRESSED] | [ADDRESSED] |
| SPEC-BEHAVIOR-006 | DES-DOCS-001 [ADDRESSED], DES-FIX-002 [ADDRESSED] | [ADDRESSED] |

## Upstream Summary (read-only)
# Design

## Design Summary
Implement the requirement as four narrow, independently reviewable design tracks:

- A compact workflow JSON output layer that preserves full JSON compatibility while adding `--json=compact` and per-subcommand allowlists.
- Generated route and size-budget changes that switch route-internal workflow calls to compact output only after compact continuation tests exist.
- A fix-report contract and retry path that aligns document/file-set report parsing and lets recoverable document `fix-report-mismatch` states safely resubmit without resetting the pre-fix guard baseline.
- A Codex shared-content measurement gate that either proves a fail-closed de-duplication is worth shipping or records that current static embedding remains the safer choice.

The design keeps workflow state, manifests, receipts, ledgers, guard baselines, and review quality gates unchanged as the source of truth. Compact output changes stdout shape only.

## Current Code Evidence
- `bin/drfx.js` always calls `formatWorkflowJson(result)` for `workflow` commands, and `workflowJsonRequested()` already treats `--json=<value>` as JSON-requesting for error formatting.
- `parseWorkflowArgs()` in `lib/workflow/index.js` currently treats `json` as a boolean flag. `--json=compact` is rejected because boolean flags reject inline values.
- `workflowJson()` in `lib/workflow-state.js` always includes broad base fields such as `contextManifestPath`, `contextPackSkeleton`, `reviewGuard`, `stateToken`, `blockingReason`, and `statusReason`.
- `formatWorkflowJson()` in `lib/workflow/index.js` appends many optional fields, including locks, fix reports, final responses, partitioned `units`, `summaries`, `coverageProof`, and aggregate data. This is the right full/debug surface but too wide for compact route chaining. This directly addresses RISK-JSON-001 [ADDRESSED], RISK-OUTPUT-001 [ADDRESSED], and RISK-PARTITION-001 [ADDRESSED].
- `renderPlatformRoute()` in `lib/generator.js` centralizes platform route generation and embeds shared content through `embeddedSharedContent()` / `sharedRelativePathsForRoute()`. That is the correct integration point for route-wide `--json=compact` text and route size budget fixtures. This addresses RISK-FIXTURE-001 [ADDRESSED].
- `shared/prompts/fixer.md` and generated embedded fixtures already contain the “Surfacing is a valid fix” hardening text, so the prior prompt/rubric hardening dependency appears present. This reduces the fixture conflict called out by RISK-FIXTURE-001 [ADDRESSED], though tests still need to prove fixture alignment.
- `parseFixReport(text, { allowVerification = false })` already has a guarded optional parser path for `Verification:`. Present verification is non-empty because it goes through `requireListLines()`.
- Document `runEndFix()` in `lib/workflow/fix-lifecycle.js` calls `parseFixReport(payload)` without `allowVerification`, then blocks unparseable reports as `fix-report-mismatch`. File-set `runEndFix()` calls `parseFixReport(payload, { allowVerification: true })`, then currently blocks when `verification` is missing. This confirms RISK-FIX-002 [ADDRESSED].
- File-set `runBeginFix()` already has a blocked retry model through `isBlockedFixRetry()` and `retryBlockedFixBeginFix()`, reusing the persisted baseline and returning `nextAction: 'retry end-fix with a valid fix report'`. Document `runBeginFix()` lacks the equivalent retry path. This is the safest model for RISK-FIX-001 [ADDRESSED].

## Requirements Coverage
- SCOPE-IN-001 is covered by DES-OUT-001 and DES-OUT-002.
- SCOPE-IN-002 is covered by DES-ROUTE-001.
- SCOPE-IN-003 is covered by DES-BUDGET-001.
- SCOPE-IN-004 is covered by DES-SHARED-001.
- SCOPE-IN-005 is covered by DES-FIX-001 and DES-SCHEMA-001.
- SCOPE-IN-006 is covered by DES-FIX-002.
- SCOPE-IN-007 is covered by DES-DOCS-001 and the fixture parts of DES-ROUTE-001 / DES-SCHEMA-001.
- RISK-COMPAT-001 [ADDRESSED] is covered by keeping non-workflow `doctor` / `status` JSON behavior out of the parser change.
- RISK-BUDGET-001 [ADDRESSED] is covered by using measured baselines plus semantic absence checks instead of a single brittle byte threshold.
- RISK-DOCS-001 [ADDRESSED] is covered by updating README files together when public behavior changes.

## Options Considered
- Option A: Global blacklist for compact JSON. Rejected because full output is assembled from many result-specific optional fields; a blacklist would miss newly added large fields or remove fields required by a specific subcommand. This would leave RISK-JSON-001 [ADDRESSED] unresolved.
- Option B: Per-subcommand compact allowlists with field-purpose labels. Chosen because route continuation depends on the exact subcommand and because tests can fail when a new full field lacks compact classification.
- Option C: Switch generated routes to compact immediately. Rejected because compact must first prove that route continuation still has the required paths.
- Option D: Remove embedded shared route text and rely only on copied shared files for Codex. Deferred behind a measurement gate because it changes runtime reliability; DES-SHARED-001 makes “record no behavior change after measurement” an acceptable implementation outcome.
- Option E: Make `Verification:` document-only. Rejected because prompts describe one fix-report contract across routes, and this would preserve parser/prompt drift.
- Option F: Use one shared optional `Verification:` section schema for document and file-set reports. Chosen to match the requirement. Route prompts still require agents to record verification; parser/workflow acceptance will not block solely because the section is absent. Present-but-empty verification remains invalid.
- Option G: Recover document `fix-report-mismatch` by restarting `begin-fix` from a new baseline. Rejected because it can normalize already modified content.
- Option H: Recover document `fix-report-mismatch` through guarded blocked retry that reuses the original baseline. Chosen because it mirrors the proven file-set retry shape.

## Chosen Design
### DES-OUT-001 Workflow JSON mode parsing and formatting
Add workflow-only JSON mode parsing:

- Bare `--json` means `full`.
- `--json=full` means `full`.
- `--json=compact` means `compact`.
- Any other value fails closed with a clear workflow flag error.

Keep `doctor` and `status` option parsing unchanged. In `workflow` command handling, pass the selected mode plus subcommand to `formatWorkflowJson(result, { mode, subcommand })`. Preserve `formatWorkflowJson(result)` defaulting to full so existing tests and direct imports remain compatible. Keep error formatting JSON-shaped when the user supplied `--json` or `--json=<value>`.

### DES-OUT-002 Compact allowlist module
Introduce a small formatter/allowlist module behind the existing `formatWorkflowJson` export. Full mode continues to use the current `workflowJson()` plus extra result fields. Compact mode applies `COMPACT_WORKFLOW_JSON_FIELDS[subcommand]`, where each field is classified as:

- `stdout required`: needed by route chaining or machine state decisions.
- `user status`: needed for concise user-visible status.
- `path readable`: keep the artifact path, not the artifact body.
- `debug only`: omitted from compact and present only in full/debug output.

The allowlist includes state paths, report paths, receipt paths, status, `blockingReason`, `statusReason`, `nextAction`, and subcommand-specific counts. It excludes large bodies by default, including `contextPackSkeleton`, raw prompts, raw transcripts, raw logs, full `units`, full `summaries`, and full `coverageProof` unless a future subcommand explicitly classifies a small value differently.

Tests import the allowlist or a test-facing descriptor so any new full output field that lacks compact classification fails in the compact coverage test.

### DES-ROUTE-001 Generated routes use compact after allowlist proof
Update generated route templates/fragments so automated `drfx workflow ... --json` calls become `--json=compact` after DES-OUT-002 tests pass. Keep debug guidance pointing to `--json=full`, `manifestPath`, `contextManifestPath`, `receiptPath`, and report paths. Do not alter route quality gates or prompt hard constraints.

Generated fixture updates are required for Claude Code, Codex, Gemini, and opencode. Snapshot diffs should show the output mode change and any compact/full diagnostic wording, not unrelated prompt rewrites.

### DES-BUDGET-001 Size and token-proxy regression tests
Add deterministic size tests using `Buffer.byteLength()` and a simple token proxy such as `Math.ceil(bytes / 4)`. These tests are regression guards, not runtime PASS criteria.

Coverage:

- Compact vs full `workflow context` and partitioned context outputs.
- Generated route shell size per platform x route.
- Embedded shared content snapshots.
- Codex copied shared asset size/duplication measurement.

Budgets use current measured baselines plus a documented margin. Tests also assert semantic absence for known large/debug fields so a generous byte budget cannot hide a reintroduced skeleton or prompt body.

### DES-SHARED-001 Codex shared de-duplication measurement gate
Before changing Codex skill reading behavior, measure:

- Current Codex generated route size.
- Embedded shared bytes.
- Copied shared asset bytes.
- Duplicate ratio or absolute repeated bytes.

Set the implementation gate in SPEC as a measurable threshold: de-duplicate only if the generated Codex route decreases by a meaningful amount and offline install/invocation plus missing copied-source fail-closed tests pass. If the threshold is not met or the fail-closed path is too fragile, keep current static embedding and record the measured “no behavior change” outcome in docs or test comments.

### DES-SCHEMA-001 Prompt/parser schema contract tests
Add schema-contract tests that extract or construct the machine payload section order expected by shared prompts and verify parser acceptance for:

- reviewer result
- triage result
- document fix report
- file-set fix report
- diff review
- final response

For fix reports, the shared accepted order is `Fixed:`, `Files changed:`, `Not fixed:`, optional `Verification:`, `Residual risk:`. Tests must prove:

- A report without `Verification:` is accepted for both document and file-set paths.
- A report with non-empty `Verification:` is accepted.
- Empty `Verification:`, wrong section order, or an unknown section is rejected as `fix-report-mismatch`.

Route prompts still instruct agents to record verification each round; parser acceptance no longer creates a hard workflow block solely because the section is absent.

### DES-FIX-001 Align document and file-set `end-fix`
Change document `runEndFix()` to call `parseFixReport(payload, { allowVerification: true })`. Change file-set `runEndFix()` so absent verification is accepted, while present verification remains non-empty and is still recorded in result/receipt when present.

Normalized reports should preserve verification when present and omit or render an explicit empty verification collection only where existing serializers can do so without misleading users. The final behavior must keep issue ID validation, declared/actual file validation, reference checks, target-only guards, ledger update, manifest update, and diff-review transition unchanged.

### DES-FIX-002 Document blocked retry using original guard baseline
Add a document-side equivalent of the file-set blocked retry path:

- `assertFixEligible()` or a helper accepts `Status: blocked`, `Current phase: fix`, `Blocking reason: fix-report-mismatch`.
- `runBeginFix()` detects this state and enters retry mode rather than sampling a new clean baseline.
- Retry reads the latest persisted fix guard baseline and fails closed if it is missing or unparseable.
- Retry validates target-only state against the original baseline, checks reference fingerprints, confirms rollback anchor usability, reacquires the lock, updates manifest back to `Status: fix` / `Current phase: fix`, and returns `nextAction: retry end-fix with a valid fix report`.
- Retry does not alter accepted findings, ledger issue status, round number, or fix attempt semantics except for lock/manifest state required to resubmit the report.
- Successful resubmission still transitions only to `diff-review`; full re-review remains required before PASS.

### DES-DOCS-001 Documentation and rollback boundaries
Update public docs only for visible behavior: workflow `--json=compact|full`, route debug guidance, compact/full diagnosis paths, and safe retry behavior. Keep `README.md` and `README.zh-CN.md` structurally aligned.

Rollback is split by track: compact formatting can revert to full route calls; size tests can be adjusted with fixture baselines; Codex de-duplication can remain no-op if not justified; fix-report retry can revert to the previous blocked behavior without data migration because state files keep their existing schema.

## Decision Requests
none

## Rollback
- Compact output rollback: keep full formatter as the default; generated routes can be switched back from `--json=compact` to bare `--json` or `--json=full` without state migration.
- Allowlist rollback: remove compact mode and its tests while preserving full output fixtures and existing workflow state semantics.
- Route text rollback: restore generated fixtures/templates for affected platforms only.
- Codex shared de-duplication rollback: if implemented, restore static embedding behavior and keep copied shared files as inert assets; if not implemented, no rollback is needed.
- Fix-report schema rollback: revert parser/lifecycle prompt changes; existing manifests and ledgers remain readable because no persisted schema migration is introduced.
- Retry rollback: document `fix-report-mismatch` can return to the previous blocked state; persisted baselines and reports remain ordinary artifacts.

## Observability
- Compact JSON still exposes status, `blockingReason`, `statusReason`, `nextAction`, and artifact paths required for diagnosis.
- Full JSON remains available through `--json=full` for debugging and compatibility.
- Size tests report the platform, route, current bytes, baseline bytes, and growth delta.
- Fix-report retry outputs whether retry is available, why it is blocked when unsafe, and the path to redacted guard/report artifacts; it does not print raw target body, raw prompt, raw transcript, secrets, or unredacted payloads.
- Receipts and manifests remain the audit trail for fix application, retry blocks, final responses, and review transitions.

## SPEC Handoff
- Specify exact `--json` parsing changes in `bin/drfx.js` and `lib/workflow/index.js`, including invalid-value behavior and JSON error formatting.
- Define `COMPACT_WORKFLOW_JSON_FIELDS` per workflow subcommand and list field classifications for document, file-set, partitioned, and finalize flows.
- Specify compact/full tests and baseline fixture updates, including negative large-field assertions.
- Specify generated route template/fragments that must use `--json=compact`, and the exact fixture regeneration/update process.
- Specify prompt/parser schema-contract tests before changing lifecycle acceptance.
- Specify document retry helper behavior by mapping file-set retry concepts to document artifacts: persisted guard baseline, target-only guard, reference fingerprints, rollback anchor, lock reacquisition, manifest state update, and unchanged ledger.
- Specify file-set verification behavior change explicitly so removing the hard missing-verification block is intentional and tested.
- Specify README and README.zh-CN edits together.

## Trace
<!-- Map this stage's IDs to upstream/downstream. R3 derives & checks closure. -->
| This ID | Upstream | Status |
|---|---|---|
| DES-OUT-001 | RISK-COMPAT-001 [ADDRESSED], RISK-JSON-001 [ADDRESSED] | [ADDRESSED] |
| DES-OUT-002 | RISK-JSON-001 [ADDRESSED], RISK-OUTPUT-001 [ADDRESSED], RISK-PARTITION-001 [ADDRESSED] | [ADDRESSED] |
| DES-ROUTE-001 | RISK-JSON-001 [ADDRESSED], RISK-FIXTURE-001 [ADDRESSED] | [ADDRESSED] |
| DES-BUDGET-001 | RISK-OUTPUT-001 [ADDRESSED], RISK-BUDGET-001 [ADDRESSED] | [ADDRESSED] |
| DES-SHARED-001 | RISK-SHARED-001 [ADDRESSED], RISK-FIXTURE-001 [ADDRESSED] | [ADDRESSED] |
| DES-SCHEMA-001 | RISK-FIX-002 [ADDRESSED], RISK-FIXTURE-001 [ADDRESSED] | [ADDRESSED] |
| DES-FIX-001 | RISK-FIX-002 [ADDRESSED] | [ADDRESSED] |
| DES-FIX-002 | RISK-FIX-001 [ADDRESSED] | [ADDRESSED] |
| DES-DOCS-001 | RISK-DOCS-001 [ADDRESSED] | [ADDRESSED] |
<!-- /r2p-read-only -->

## Project Context (read-only)
# Project Context Pack

- repo_root: `/Users/xubo/x-studio/document-review-fix`
- languages: {'JavaScript': 50673}
- package_managers: npm
- test_commands: ['npm test']
- entrypoints: ['lib/workflow/index.js']
- config_files: none
- dependencies (0): none
- source_dirs: ['bin', 'docs', 'lib', 'scripts', 'shared', 'skills', 'templates', 'test']
<!-- /r2p-read-only -->
