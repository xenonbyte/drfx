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

## Upstream Summary (read-only)
# Risk Discovery

## Risks
### RISK-JSON-001 Compact allowlist can omit a route-required field
Status: mitigated
Scope: SCOPE-IN-001, SCOPE-IN-002
Evidence: `workflowJson` currently emits a broad base object, and `formatWorkflowJson` appends many optional lifecycle and partitioned fields. A compact mode that uses a global blacklist could remove a field needed by one subcommand while still passing unrelated tests.
Impact: Generated routes could stall after switching to `--json=compact` even though full JSON still works.
Mitigation: Define a per-subcommand allowlist with field purpose labels, test required fields and large-field absence per subcommand, and run route-continuation smoke tests before switching generated routes.

### RISK-COMPAT-001 JSON flag compatibility can drift outside workflow commands
Status: mitigated
Scope: SCOPE-IN-001
Evidence: Existing CLI code treats workflow `--json` as a boolean request; `doctor` and `status` also use JSON behavior for different purposes. The requirement explicitly keeps bare workflow `--json` full-compatible and excludes `doctor` / `status`.
Impact: Existing scripts, tests, or strict-proof/status flows could break if `--json=compact|full` parsing is applied too broadly or if bare `--json` changes meaning.
Mitigation: Scope value parsing to `workflow` subcommands, add tests for `--json`, `--json=full`, `--json=compact`, and `--json=bad`, and leave non-workflow JSON behavior unchanged.

### RISK-OUTPUT-001 Compact output can leak or reintroduce large/debug payloads
Status: mitigated
Scope: SCOPE-IN-001, SCOPE-IN-003
Evidence: `contextPackSkeleton`, partitioned `units`, `summaries`, and `coverageProof` are currently visible in JSON paths; these are legitimate full/debug data but can dominate model context.
Impact: The token reduction work could fail silently, or worse, expose raw prompt/transcript/log-style payloads in default route output.
Mitigation: Treat compact as an allowlist, not a blacklist; add size-budget tests and explicit absence assertions for skeletons, raw prompts, raw transcripts, raw logs, full units, and full summaries.

### RISK-PARTITION-001 Partitioned review fields need command-specific compact decisions
Status: mitigated
Scope: SCOPE-IN-001, SCOPE-IN-003
Evidence: Partitioned review uses unit plans, unit summaries, coverage proof, backstops, and aggregate fields. Some fields are user status, while full arrays are path-readable or debug-only.
Impact: Dropping too much breaks partitioned review continuation; keeping too much undermines the compact goal.
Mitigation: Include partitioned start/context/record/aggregate commands in A0 allowlist tests, retaining counts, paths, status, and next action while moving large collections behind artifact paths in compact output.

### RISK-FIX-001 Document fix-report retry can accidentally reset the safety baseline
Status: mitigated
Scope: SCOPE-IN-006
Evidence: Document `runEndFix` blocks on `fix-report-mismatch` after reading the persisted begin-fix guard baseline. Retrying by rerunning begin-fix naively could sample already modified target content as the new baseline.
Impact: A bad fix report could be laundered into a clean baseline, weakening target-only guard guarantees and auditability.
Mitigation: Implement retry as a guarded resubmission path that reuses the original begin-fix baseline, verifies reference fingerprints and allowed target-only changes, reacquires the lock, and only enables a corrected `end-fix`.

### RISK-FIX-002 Fix-report schema symmetry conflicts with current file-set verification behavior
Status: mitigated
Scope: SCOPE-IN-005
Evidence: The requirement calls for a shared optional `Verification:` section for document and file-set reports. Current file-set `runEndFix` parses with `allowVerification: true` and then blocks when `verification` is missing.
Impact: Making document verification optional without addressing file-set behavior would leave schema asymmetry; making file-set optional could reduce per-round audit evidence unless prompts/tests preserve verification expectations.
Mitigation: Decide the shared contract in SPEC, then update parser, document lifecycle, file-set lifecycle, prompts, and schema tests together. If optional is retained, tests must still ensure present-but-empty verification fails and route prompts continue asking for per-round verification.

### RISK-SHARED-001 Codex shared de-duplication can trade static reliability for runtime file dependency
Status: mitigated
Scope: SCOPE-IN-004
Evidence: Codex currently embeds shared text and also copies shared assets. Removing embedded content may reduce bytes but introduces runtime reads and missing-file failure modes.
Impact: Installed Codex skills could become less reliable offline or fail unclearly when copied shared source is absent.
Mitigation: Measure duplicate bytes first; only de-duplicate if the benefit clears the implementation threshold and offline, install, invocation, and missing-source fail-closed tests pass. Otherwise preserve static embedding and guard size growth.

### RISK-FIXTURE-001 Generated route and embedded shared fixtures are high-conflict surfaces
Status: mitigated
Scope: SCOPE-IN-002, SCOPE-IN-003, SCOPE-IN-005, SCOPE-IN-007
Evidence: The project maintains platform x route fixtures by hand, and the current branch already contains embedded prompt hardening such as “Surfacing is a valid fix” in `shared/prompts/fixer.md` and generated embedded fixtures.
Impact: Compact route changes, prompt schema changes, and fixture budget tests can conflict or mask unrelated fixture drift.
Mitigation: Verify the pre-existing prompt hardening before editing, keep fixture updates tied to their behavior change, and run targeted shared-assets tests before full `npm test`.

### RISK-BUDGET-001 Size thresholds can become either noisy or toothless
Status: mitigated
Scope: SCOPE-IN-003
Evidence: Initial budgets must be based on current generated fixture and JSON sizes, but the requirement allows future legitimate growth.
Impact: Tight thresholds slow routine maintenance; loose thresholds fail to catch reintroduced skeletons or prompt bodies.
Mitigation: Use current measurements plus explicit margin, report platform/route/growth deltas on failure, and combine size thresholds with semantic absence checks for known large/debug fields.

### RISK-DOCS-001 Public behavior docs can drift across README languages
Status: mitigated
Scope: SCOPE-IN-007
Evidence: Repository guidance requires `README.md` and `README.zh-CN.md` structural alignment when public behavior changes.
Impact: Users can receive conflicting guidance for `--json=compact|full`, debug paths, and retry behavior.
Mitigation: Update both README files in the same batch when CLI or route behavior changes, and add/read existing README content tests where available.

## Boundaries
- Quality gates remain authoritative: reviewer isolation, readiness probes, guards, redaction, machine payload validation, diff review, full re-review, and final-response validation stay in force.
- Compact output affects stdout shape only; state files, manifests, receipts, context artifacts, ledgers, and guard baselines remain the source of truth.
- No new runtime dependency is introduced. `rtk-ai/rtk` remains a reference for output filtering patterns only.
- `--json=compact|full` is limited to workflow subcommands; `doctor` and `status` JSON semantics remain outside this change.
- Retry is limited to recoverable `fix-report-mismatch` conditions with validated target/reference state. It does not alter accepted findings, forge ledger state, or skip review phases.
- Route shell size work must not delete hard constraints, safety boundaries, platform capability differences, or quality language.
- Implementation should stay near workflow JSON formatting, argument parsing, route generation/templates, parser/fix lifecycle, tests, fixtures, and docs.

## Scope Overflow Risks
- Expanding compact JSON work into a broad workflow state rewrite instead of a formatting/contract layer.
- Compressing prompt/rubric/protocol language by weakening requirements rather than removing duplication or moving path-readable bodies out of default stdout.
- Applying compact/full parsing to lifecycle commands outside workflow, especially `doctor` or `status`.
- Implementing Codex shared de-duplication before measurement and fail-closed tests justify the runtime-read risk.
- Treating every blocked state as retryable instead of narrowly handling safe `fix-report-mismatch` resubmission.
- Updating generated fixtures without tying each diff to a specific prompt, template, or route invocation change.
- Changing file-set verification semantics without explicit tests that preserve auditability and parser/prompt alignment.

## Mitigations
- Build A0 before B1: compact allowlists and route-continuation tests must pass before generated routes default to compact output.
- Keep full JSON and artifact paths available for diagnosis; compact should retain paths, not duplicate file bodies.
- Add negative tests that fail when `contextPackSkeleton`, raw prompts, raw transcripts, raw logs, full units, or full summaries appear in compact output unexpectedly.
- Use CodeGraph and targeted source checks before designing fix-report changes because document and file-set lifecycle code currently diverge.
- Implement prompt/parser schema tests before or alongside F1/F2 so route instructions and accepted machine payload sections cannot drift again.
- For retry, assert the original guard baseline is reused, reference fingerprints remain stable, target-only changes are verified, and success transitions only to diff review.
- For Codex de-duplication, record measured before/after bytes and accept “no behavior change” as a valid outcome when benefit is insufficient.
- Keep documentation, generated fixtures, and embedded shared snapshots in the same reviewable batch as their behavior change.
- Run targeted tests for changed surfaces first, then `npm run syntaxcheck` and `npm test` for final verification.

## Trace
<!-- Map this stage's IDs to upstream/downstream. R3 derives & checks closure. -->
| This ID | Upstream | Status |
|---|---|---|
| RISK-JSON-001 | SCOPE-IN-001, SCOPE-IN-002 | [ADDRESSED] |
| RISK-COMPAT-001 | SCOPE-IN-001 | [ADDRESSED] |
| RISK-OUTPUT-001 | SCOPE-IN-001, SCOPE-IN-003 | [ADDRESSED] |
| RISK-PARTITION-001 | SCOPE-IN-001, SCOPE-IN-003 | [ADDRESSED] |
| RISK-FIX-001 | SCOPE-IN-006 | [ADDRESSED] |
| RISK-FIX-002 | SCOPE-IN-005 | [ADDRESSED] |
| RISK-SHARED-001 | SCOPE-IN-004 | [ADDRESSED] |
| RISK-FIXTURE-001 | SCOPE-IN-002, SCOPE-IN-003, SCOPE-IN-005, SCOPE-IN-007 | [ADDRESSED] |
| RISK-BUDGET-001 | SCOPE-IN-003 | [ADDRESSED] |
| RISK-DOCS-001 | SCOPE-IN-007 | [ADDRESSED] |
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