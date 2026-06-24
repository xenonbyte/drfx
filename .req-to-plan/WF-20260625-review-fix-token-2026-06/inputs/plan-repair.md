# Plan

## Tasks
### PLAN-TASK-001 Add failing coverage for workflow JSON modes and compact allowlists
Spec References: SPEC-BEHAVIOR-001, SPEC-BEHAVIOR-002
Change Type: modify
TDD Applicable: yes
Files:
- test/workflow-args.test.js
- test/workflow-json-baseline.test.js
- test/cli.test.js
Skeleton:
```javascript
const REQUIRED_COMPACT_ALLOWLIST_ROWS = [
  ['state', 'preflight'],
  ['state', 'start'],
  ['state', 'context'],
  ['state', 'record-review'],
  ['state', 'record-triage'],
  ['fix-lifecycle', 'begin-fix'],
  ['fix-lifecycle', 'refresh-lock'],
  ['fix-lifecycle', 'end-fix'],
  ['fix-lifecycle', 'abort-fix'],
  ['fix-lifecycle', 'record-diff-review'],
  ['fix-lifecycle', 'finalize'],
  ['file-set', 'start-or-resume'],
  ['file-set', 'context'],
  ['file-set', 'record-review'],
  ['file-set', 'record-triage'],
  ['file-set', 'aggregate-review'],
  ['partitioned', 'plan'],
  ['partitioned', 'context'],
  ['partitioned', 'unit-review'],
  ['partitioned', 'crosscutting'],
  ['partitioned', 'aggregate'],
  ['no-state', 'preflight'],
  ['no-state', 'context'],
  ['no-state', 'record-review'],
  ['no-state', 'finalize']
];

test('workflow JSON mode accepts full and compact while preserving bare json', async () => {
  assert.equal(parseWorkflowJsonMode(['--json']), 'full');
  assert.equal(parseWorkflowJsonMode(['--json=full']), 'full');
  assert.equal(parseWorkflowJsonMode(['--json=compact']), 'compact');
  assert.throws(() => parseWorkflowJsonMode(['--json=bad']), /ERR_WORKFLOW_FLAG/);
});

test('compact context output keeps paths and omits skeleton bodies', async () => {
  const full = JSON.parse(formatWorkflowJson(contextResult, { mode: 'full', subcommand: 'context' }));
  const compact = JSON.parse(formatWorkflowJson(contextResult, { mode: 'compact', subcommand: 'context' }));
  assert.ok(full.contextPackSkeleton);
  assert.equal(compact.contextPackSkeleton, undefined);
  assert.ok(compact.contextManifestPath);
});
```
Steps:
- [ ] Add tests for bare `--json`, `--json=full`, `--json=compact`, and invalid `--json=bad` on workflow commands.
- [ ] Add tests proving `doctor --json` and `status --json` remain boolean and unaffected.
- [ ] Add an explicit compact allowlist coverage matrix for state commands: `preflight`, `start`, `context`, `record-review`, and `record-triage`.
- [ ] Add an explicit compact allowlist coverage matrix for fix lifecycle commands: `begin-fix`, `refresh-lock`, `end-fix`, `abort-fix`, `record-diff-review`, and `finalize`.
- [ ] Add an explicit compact allowlist coverage matrix for file-set route paths: start or resume, `context`, `record-review`, `record-triage`, and `aggregate-review` when emitted.
- [ ] Add an explicit compact allowlist coverage matrix for partitioned paths: partition plan/context, unit review, crosscutting review, and aggregate.
- [ ] Add an explicit compact allowlist coverage matrix for no-state route paths: `preflight`, `context`, `record-review`, and `finalize` where generated routes use them.
- [ ] Add compact formatter tests that classify every route-automated full-output field and prove compact context keeps artifact paths while omitting `contextPackSkeleton`.
- [ ] Fail the tests when a route-automated command emits a full-output field that is absent from the matrix or lacks one of the allowed purposes: `stdout required`, `user status`, `path readable`, or `debug only`.
- [ ] Include SCOPE-IN-001 in test names or assertions so compact workflow JSON scope closes in trace.
Verification: `node --test test/workflow-args.test.js test/workflow-json-baseline.test.js test/cli.test.js` fails before implementation for compact/full mode and allowlist behavior, then passes after PLAN-TASK-002.

### PLAN-TASK-002 Implement workflow JSON mode parsing and compact formatting
Spec References: SPEC-BEHAVIOR-001, SPEC-BEHAVIOR-002
Change Type: modify
TDD Applicable: yes
Files:
- bin/drfx.js
- lib/workflow/index.js
- lib/workflow-state.js
Skeleton:
```javascript
const JSON_MODES = new Set(['full', 'compact']);

function parseWorkflowJsonMode(args) {
  let mode = null;
  for (const arg of args) {
    if (arg === '--json') mode = mode || 'full';
    if (arg.startsWith('--json=')) {
      const value = arg.slice('--json='.length);
      if (!JSON_MODES.has(value)) fail('ERR_WORKFLOW_FLAG', `Invalid --json mode: ${value}`);
      mode = value;
    }
  }
  return mode || 'full';
}

function formatWorkflowJson(result, { mode = 'full', subcommand = null } = {}) {
  const full = fullWorkflowJson(result);
  return `${JSON.stringify(mode === 'compact' ? compactWorkflowJson(full, subcommand) : full)}\n`;
}
```
Steps:
- [ ] Move workflow JSON mode parsing out of the boolean-only `json` path without changing non-workflow commands.
- [ ] Preserve compatibility boolean `json` where existing workflow internals or tests expect it, and add `jsonMode`.
- [ ] Add compact allowlist data with field purpose labels and full-mode fallback.
- [ ] Implement compact allowlist rows for every matrix entry from PLAN-TASK-001: state, fix lifecycle, file-set, partitioned, and no-state paths.
- [ ] Make compact formatting fail closed in tests when a route-automated subcommand lacks an allowlist entry or a field classification.
- [ ] Keep `path readable` fields as scalar paths only; never inline the body behind `contextManifestPath`, report paths, state paths, guard paths, or partition artifact paths.
- [ ] Thread `{ mode, subcommand }` from `bin/drfx.js` to `formatWorkflowJson`.
- [ ] Ensure compact mode changes stdout shape only; do not modify state files, receipts, ledgers, guards, or workflow execution.
Verification: `node --test test/workflow-args.test.js test/workflow-json-baseline.test.js test/cli.test.js` passes and shows compact output omits debug bodies while full output remains byte-compatible where expected.

### PLAN-TASK-003 Switch generated routes to compact output and add size budgets
Spec References: SPEC-BEHAVIOR-002, SPEC-BEHAVIOR-003, SPEC-BEHAVIOR-006, SCOPE-IN-002, SCOPE-IN-003, SCOPE-IN-004
Change Type: modify
TDD Applicable: yes
Files:
- lib/install.js
- lib/generator.js
- templates/claude-command.md.tmpl
- templates/codex-skill.md.tmpl
- templates/gemini-command.toml.tmpl
- templates/opencode-command.md.tmpl
- test/capability-check.test.js
- test/cli.test.js
- test/shared-assets.test.js
- test/fixtures/generated/claude/review-fix-doc.md
- test/fixtures/generated/codex/review-fix-code.md
- test/fixtures/generated/gemini/review-fix-pr.toml
- test/fixtures/generated/opencode/review-fix-r2q.md
- test/fixtures/embedded/codex/review-fix-code.md
Skeleton:
```javascript
test('generated workflow calls use compact JSON', () => {
  for (const platform of PLATFORMS) {
    for (const route of ROUTES) {
      const rendered = renderPlatformRoute(platform, route.routeName, snapshotOptions);
      assert.match(rendered, /drfx workflow .*--json=compact/);
      assert.doesNotMatch(rendered, /contextPackSkeleton/);
    }
  }
});

test('route shell size stays within budget', () => {
  const allowed = baselineBytes + Math.max(4096, Math.ceil(baselineBytes * 0.08));
  assert.ok(actualBytes <= allowed, `${platform}/${route}: ${actualBytes} > ${allowed}`);
});
```
Steps:
- [ ] Update generated route workflow invocations to use `--json=compact` for automated route chaining after PLAN-TASK-002 tests pass.
- [ ] Keep debug guidance for `--json=full` and artifact paths.
- [ ] Add compact/full byte-ratio tests for context and partitioned context outputs.
- [ ] Add platform x route shell size budgets using `max(4096, ceil(baselineBytes * 0.08))`.
- [ ] Split Codex shared work into an unconditional measurement phase and a guarded implementation phase.
- [ ] In the measurement phase, add Codex shared measurement for route bytes, embedded shared bytes, copied shared bytes, duplicate bytes, largest-shell shrink bytes, largest-shell shrink percent, and whether any Codex route would grow.
- [ ] Record the measurement result in `test/shared-assets.test.js` as a deterministic expected measurement or developer-facing assertion. If the de-duplication gate fails, this recorded no-op result is the accepted implementation outcome and Codex routes keep static embedding.
- [ ] Enter the guarded implementation phase only when the measurement shows largest Codex route shrink `>= 16 KiB`, largest Codex route shrink `>= 12%`, no Codex route grows, and the fail-closed tests below can be made passing.
- [ ] If the guarded phase is entered, update `lib/install.js`, `lib/generator.js`, and `templates/codex-skill.md.tmpl` so Codex installs a manifest-owned copied shared source, route invocation reads that source offline, and a missing or unowned copied source fails closed instead of silently falling back.
- [ ] If the guarded phase is entered, add tests for offline install, offline invocation, missing copied-source fail-closed behavior, no Codex route growth, and preservation of all embedded safety constraints currently covered by generated/embedded fixtures.
- [ ] Refresh all affected generated and embedded fixtures by hand, not only the representative files listed above. This closes SCOPE-IN-002, SCOPE-IN-003, and SCOPE-IN-004.
Verification: `node --test test/shared-assets.test.js test/workflow-json-baseline.test.js` passes, generated route fixture diffs show `--json=compact`, and size-budget failures report platform, route, baseline bytes, actual bytes, allowed bytes, and growth.

### PLAN-TASK-004 Align fix-report schema and prompt/parser contract
Spec References: SPEC-BEHAVIOR-004
Change Type: modify
TDD Applicable: yes
Files:
- lib/semantic-parsers.js
- lib/workflow/fix-lifecycle.js
- lib/workflow/file-set-fix.js
- test/semantic-parsers.test.js
- test/workflow-e2e.test.js
- shared/prompts/fixer.md
- shared/prompts/coordinator.md
Skeleton:
```javascript
test('document and file-set fix reports share optional Verification schema', () => {
  const withoutVerification = parseFixReport(validFourSectionReport, { allowVerification: true });
  assert.equal(withoutVerification.verification, null);

  const withVerification = parseFixReport(validFiveSectionReport, { allowVerification: true });
  assert.deepEqual(withVerification.verification, ['npm test passes']);

  assert.throws(() => parseFixReport(emptyVerificationReport, { allowVerification: true }), /Verification/);
});
```
Steps:
- [ ] Add parser tests for document and file-set reports with no `Verification:`, non-empty `Verification:`, empty `Verification:`, wrong order, and unknown sections.
- [ ] Add prompt/schema contract tests for reviewer, triage, fix, diff review, and final response payload sections.
- [ ] Change document `end-fix` to parse with `{ allowVerification: true }`.
- [ ] Change file-set `end-fix` so missing verification does not block, while present verification remains non-empty and is recorded only when present.
- [ ] Update shared prompts and generated embedded fixtures only where wording must match the accepted schema. This closes SCOPE-IN-005.
Verification: `node --test test/semantic-parsers.test.js test/workflow-e2e.test.js --test-name-pattern="fix report|Verification|end-fix"` passes, and no test requires absent verification to block.

### PLAN-TASK-005 Implement safe document `fix-report-mismatch` retry
Spec References: SPEC-BEHAVIOR-005, SPEC-BEHAVIOR-006
Change Type: modify
TDD Applicable: yes
Files:
- lib/workflow/fix-lifecycle.js
- lib/workflow/helpers.js
- test/workflow-e2e.test.js
Skeleton:
```javascript
test('document fix-report-mismatch can retry without a new fix attempt', () => {
  const before = readManifest(targetStateDir);
  const retry = runWorkflowCommand('begin-fix', [targetStateDir]);
  const after = readManifest(targetStateDir);
  assert.equal(retry.nextAction, 'retry end-fix with a valid fix report');
  assert.equal(after.fixAttemptCount, before.fixAttemptCount);
  assert.equal(after.currentRound, before.currentRound);
});

for (const unsafeCase of [
  'non-retryable manifest status',
  'wrong currentPhase',
  'wrong blockingReason',
  'failed guard baseline',
  'baseline target mismatch',
  'missing passed rollback anchor',
  'missing passed target-only guard'
]) {
  test(`document fix-report-mismatch retry blocks on ${unsafeCase}`, () => {
    assertRetryBlocked(unsafeCase);
  });
}
```
Steps:
- [ ] Add RED workflow test where invalid document fix report blocks as `fix-report-mismatch`, `begin-fix` retry reuses the original guard baseline, corrected `end-fix` advances to `diff-review`, and full re-review is still required before PASS.
- [ ] Add negative tests for missing baseline, unparseable baseline, failed baseline, baseline target mismatch, missing passed rollback anchor, reference mutation, non-target mutation, target-only guard unavailable, missing passed target-only guard result, and lock reacquisition failure.
- [ ] Add negative tests proving retry is unavailable for non-retryable manifest status, wrong `currentPhase`, wrong `blockingReason`, or any state that is not the document `fix-report-mismatch` block created by the immediately preceding invalid `end-fix`.
- [ ] Add preservation test for `fixAttemptCount`, `currentRound`, accepted issue IDs, ledger issue statuses, and no pre-`end-fix` fixed marking.
- [ ] Implement document blocked retry helper using the existing guard report reader, reference fingerprint check, target-only guard, rollback anchor, lock reacquisition, and manifest state update.
- [ ] Keep unsafe retry blocked with recovery-oriented `nextAction` and no raw payload output. This closes SCOPE-IN-006.
Verification: `node --test --test-name-pattern="fix-report-mismatch|begin-fix retry|diff-review" test/workflow-e2e.test.js` passes and proves retry transitions only to `diff-review`.

### PLAN-TASK-006 Update documentation and run final verification
Spec References: SPEC-BEHAVIOR-006
Change Type: modify
TDD Applicable: yes
Files:
- README.md
- README.zh-CN.md
- test/readme-content.test.js
Skeleton:
```javascript
test('README documents workflow compact and full JSON modes in both languages', () => {
  assert.match(readmeEn, /--json=compact/);
  assert.match(readmeEn, /--json=full/);
  assert.match(readmeZh, /--json=compact/);
  assert.match(readmeZh, /--json=full/);
});
```
Steps:
- [ ] Document workflow `--json`, `--json=full`, `--json=compact`, compact route defaults, full/debug artifact paths, and safe retry behavior.
- [ ] Keep `README.md` and `README.zh-CN.md` structurally aligned.
- [ ] Add or update README content tests for compact/full and retry guidance.
- [ ] Run targeted tests from PLAN-TASK-001 through PLAN-TASK-005.
- [ ] Run final `npm run syntaxcheck` and `npm test`. This closes SCOPE-IN-007.
Verification: `node --test test/readme-content.test.js` passes, `npm run syntaxcheck` passes, and `npm test` passes.

## Trace
<!-- Map this stage's IDs to upstream/downstream. R3 derives & checks closure. -->
| This ID | Upstream | Status |
|---|---|---|
| PLAN-TASK-001 | SPEC-BEHAVIOR-001 [ADDRESSED], SPEC-BEHAVIOR-002 [ADDRESSED], SCOPE-IN-001 | [ADDRESSED] |
| PLAN-TASK-002 | SPEC-BEHAVIOR-001 [ADDRESSED], SPEC-BEHAVIOR-002 [ADDRESSED], SCOPE-IN-001 | [ADDRESSED] |
| PLAN-TASK-003 | SPEC-BEHAVIOR-002 [ADDRESSED], SPEC-BEHAVIOR-003 [ADDRESSED], SPEC-BEHAVIOR-006 [ADDRESSED], SCOPE-IN-002 [ADDRESSED], SCOPE-IN-003 [ADDRESSED], SCOPE-IN-004 [ADDRESSED] | [ADDRESSED] |
| PLAN-TASK-004 | SPEC-BEHAVIOR-004 [ADDRESSED], SCOPE-IN-005 | [ADDRESSED] |
| PLAN-TASK-005 | SPEC-BEHAVIOR-005 [ADDRESSED], SPEC-BEHAVIOR-006 [ADDRESSED], SCOPE-IN-006 | [ADDRESSED] |
| PLAN-TASK-006 | SPEC-BEHAVIOR-006 [ADDRESSED], SCOPE-IN-007 | [ADDRESSED] |

## Upstream Summary (read-only)
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
