---
r2p_stage: risk_discovery
r2p_version: 2
r2p_status: approved
r2p_created_at: 2026-06-24T18:29:41.084395+00:00
r2p_updated_at: 2026-06-24T18:50:49.627880+00:00
---

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

## Upstream Summary (read-only)
# Requirement Brief

## Goal
Deliver a scoped review-fix resilience and token-output optimization release for `@xenonbyte/drfx`: shorten generated-route workflow JSON output through compact/full modes and per-command allowlists, add size regression coverage for workflow context and generated route shells, evaluate shared prompt embedding duplication without weakening quality gates, and repair document fix-report contract/retry behavior so recoverable payload mismatches can continue through the full review-fix loop.

## In-Scope
- SCOPE-IN-001 Compact workflow JSON: add `--json=compact|full` for workflow subcommands, keep bare `--json` as full, fail closed on invalid values, and make compact output path-driven with per-subcommand allowlists.
- SCOPE-IN-002 Generated route integration: switch automatic route workflow invocations to `--json=compact` only after allowlist and continuation tests prove required paths remain available.
- SCOPE-IN-003 Size and token-proxy regression coverage: add byte/word-count budgets for context JSON, partitioned context, generated route shells, embedded shared content, and Codex copied shared assets using existing `node:test` patterns.
- SCOPE-IN-004 Shared embedding review: measure Codex duplicated shared content and implement fail-closed de-duplication only if the measured benefit clears the requirement's risk/benefit bar; otherwise record the decision and keep current behavior guarded by tests.
- SCOPE-IN-005 Document fix-report contract: align document and file-set fix reports around the same optional `Verification:` section schema and update parser, prompts, route fixtures, and schema-contract tests together.
- SCOPE-IN-006 Safe fix-report retry: allow document `fix-report-mismatch` recovery through `begin-fix` while reusing the original pre-fix guard baseline and preserving the required diff-review/full-re-review loop.
- SCOPE-IN-007 Documentation and fixtures: update README/developer docs, generated route fixtures, and embedded shared fixtures whenever public behavior or generated text changes.

## Out-of-Scope
- SCOPE-OUT-001 Reducing review depth, reviewer isolation, full re-review, diff review, partitioned review, guard checks, redaction, machine payload validation, or final-response validation.
- SCOPE-OUT-002 Introducing `rtk-ai/rtk` or any new runtime dependency; it is only a design reference for output filtering and budget tests.
- SCOPE-OUT-003 Adding a summarization layer that replaces primary review evidence or quality-gate inputs.
- SCOPE-OUT-004 Large unrelated workflow-state rewrites, broad module reshaping, or fixture churn not required by compact output, route text, or fix-report recovery.
- SCOPE-OUT-005 Mutating remote systems, publishing, committing, or changing historical release notes as part of this requirement.

## Non-Goals
- Do not make token reduction a PASS criterion; PASS remains controlled by the existing review-fix quality gates and re-review results.
- Do not silently hide missing compact fields or parser failures behind fallback behavior.
- Do not weaken prompt/rubric/protocol hard constraints to reduce route shell size.
- Do not allow retry to accept unparsed reports, remap issues, skip ledger checks, or treat already modified content as a clean baseline.

## Assumptions
- The current workflow JSON result shape is sufficiently stable to derive compact allowlists without changing underlying workflow execution semantics.
- Route automation can continue from compact output when all required artifact paths are retained and detailed bodies remain readable from manifest, receipt, or debug artifacts.
- Byte count and word-count proxies are acceptable regression signals because CI must stay offline and dependency-free.
- Prior approved prompt/rubric hardening that touches `shared/prompts/*` and embedded fixtures should be verified before implementation to avoid fixture conflicts.
- The document and file-set fix-report schemas can share the same optional `Verification:` section while preserving target-specific semantics.

## Acceptance Criteria
- `--json`, `--json=full`, `--json=compact`, and invalid `--json=<value>` workflow behavior are covered by tests; bare `--json` remains full-compatible.
- Compact output has per-command allowlist tests that assert required fields exist and large/debug fields such as skeletons, raw prompts, raw transcripts, raw logs, full units, and full summaries are absent unless explicitly allowed.
- Generated Claude Code, Codex, Gemini, and opencode routes use compact workflow output for automated calls and still expose full/debug artifact paths for diagnosis.
- Context JSON and generated route shells have size-budget or snapshot tests that fail on accidental reintroduction of duplicated skeletons, raw prompt bodies, or abnormal shell growth.
- Codex shared de-duplication is either implemented with measured benefit plus offline/fail-closed install coverage, or explicitly recorded as not worth changing after measurement.
- Document `end-fix` accepts valid reports with or without a non-empty `Verification:` section, rejects empty/misordered/unknown sections, and exposes a safe retry path for recoverable `fix-report-mismatch`.
- Retry uses the original begin-fix baseline, validates allowed target/reference changes, reacquires the lock, and resumes into diff review/full re-review rather than PASS.
- README/developer documentation and generated fixtures are updated when behavior changes; `npm run syntaxcheck` and `npm test` pass or any unrun check is called out with residual risk.

## Open Questions
- Does the current branch already contain the 2026-06-23 shared prompt/rubric hardening and related embedded fixture updates that this requirement depends on? [DEFERRED to risk discovery evidence check]
- What initial size-budget thresholds give useful regression protection without creating noisy failures? [DEFERRED to design/spec with current fixture measurements]
- Does Codex shared de-duplication meet a worthwhile benefit threshold after measurement, or should the implementation keep the current static embedding model? [DEFERRED to design/spec measurement]

## Sources
- `00-raw-requirement.md`: source requirement text for token-output, route-shell, shared-embedding, and fix-report resilience goals.
- `01-intake-brief.md`: tier estimate, modifiers, and evidence block generated from the raw requirement.
- `02-project-context.md`: repository context pack showing Node.js/CommonJS project shape, source directories, entrypoint, and `npm test` command.
- Repository guidance: root `AGENTS.md` / provided project instructions covering tests, fixture handling, docs synchronization, and security boundaries.

## Trace
<!-- Map this stage's IDs to upstream/downstream. R3 derives & checks closure. -->
| This ID | Upstream | Status |
|---|---|---|
| SCOPE-IN-001 | raw requirement compact workflow JSON batch | [ADDRESSED] |
| SCOPE-IN-002 | raw requirement generated route compact-output batch | [ADDRESSED] |
| SCOPE-IN-003 | raw requirement size/token regression batch | [ADDRESSED] |
| SCOPE-IN-004 | raw requirement shared embedding de-duplication evaluation batch | [ADDRESSED] |
| SCOPE-IN-005 | raw requirement document fix-report schema batch | [ADDRESSED] |
| SCOPE-IN-006 | raw requirement fix-report retry resilience batch | [ADDRESSED] |
| SCOPE-IN-007 | raw requirement documentation/fixture verification requirements | [ADDRESSED] |
| SCOPE-OUT-001 | raw requirement quality-boundary non-goals | [ADDRESSED] |
| SCOPE-OUT-002 | raw requirement no new runtime dependency constraint | [ADDRESSED] |
| SCOPE-OUT-003 | raw requirement no summarization quality-gate replacement constraint | [ADDRESSED] |
| SCOPE-OUT-004 | raw requirement narrow module boundary constraint | [ADDRESSED] |
| SCOPE-OUT-005 | repository safety and release-side-effect constraints | [ADDRESSED] |
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