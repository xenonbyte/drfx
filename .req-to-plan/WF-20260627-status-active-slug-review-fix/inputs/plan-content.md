# Plan

## Tasks

### PLAN-TASK-001 r2p route test suite (gates 1-10, redaction, drift) — test-first
Spec References: SPEC-INPUT-001, SPEC-PREFLIGHT-001, SPEC-RESOLVE-001, SPEC-LIFECYCLE-001, SPEC-STATUS-001, SPEC-PLAN-001, SPEC-EXEC-001, SPEC-PASS-001
Scope: SCOPE-IN-001, SCOPE-IN-009
Change Type: create
TDD Applicable: yes
Files:
- test/r2p-route.test.js
Skeleton:
```js
const { test } = require('node:test');
const assert = require('node:assert');
// Fake r2p binaries under a temp dir emit the documented R2P_JSON payloads
// (reopen -> {new_work_id}; gap-open -> {route_id, staled_stages}; status -> {status,current_stage,open_routes_detail}).
test('gate1 invocation accept/reject incl. archive-bypass and flag-injection', () => {});
test('gate2 command-env + R2P_JSON probe', () => {});
test('gate3 workspace preflight', () => {});
test('gate4 artifact preflight', () => {});
test('gate5 no-direct-write both directions (drfx fails; r2p-authored change allowed)', () => {});
test('gate6 repair exec argv shell:false; capture new_work_id/route_id; checkpoint, no PASS', () => {});
test('gate7 rerun-PASS only after clean re-review', () => {});
test('gate8 status-contract parses multiple owner stages; missing contract blocks', () => {});
test('gate9 current-stage checkpoint', () => {});
test('gate10 earliest-stage aggregation + r2p-repair-plan-ambiguous', () => {});
test('redaction receipt omits raw reason/secrets', () => {});
test('drift guard blocks instead of executing', () => {});
```
Steps:
- [ ] Add fake r2p binary fixtures that emit the documented `R2P_JSON` payloads.
- [ ] Author the gate-1..10 cases plus the receipt-redaction and drift-guard-block cases (red until later tasks implement them).
Verification: `node --test test/r2p-route.test.js` executes and reports every named case (red before PLAN-TASK-003..013 land, green after).

### PLAN-TASK-002 documentation and module-boundary compliance test (gate 11) — test-first
Spec References: SPEC-DOCS-001
Scope: SCOPE-IN-011
Change Type: create
TDD Applicable: yes
Files:
- test/r2p-docs.test.js
Skeleton:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
test('gate11 r2p docs describe only the new model, no legacy/migration language', () => {
  const files = ['skills/review-fix-r2p/SKILL.md', 'shared/prompts/coordinator.md', 'shared/prompts/fixer.md'];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.match(text, /workId/);
    assert.doesNotMatch(text, /target=<requirement-dir>|\br2q\b|migrat|backward compat/i);
  }
});
test('no source file imports the retired file-set-r2p-gate module', () => {});
```
Steps:
- [ ] Assert the r2p docs/prompts contain only the new model and no legacy/migration language.
- [ ] Assert no source or test file imports the retired module.
Verification: `node --test test/r2p-docs.test.js` executes and reports both cases (red before PLAN-TASK-011..013 land, green after).

### PLAN-TASK-003 workId invocation parser
Spec References: SPEC-INPUT-001
Scope: SCOPE-IN-001, SCOPE-IN-002
Change Type: modify
TDD Applicable: yes
Files:
- lib/input.js
Skeleton:
```js
const R2P_WORK_ID_RE = /^WF-[A-Za-z0-9._-]+$/;
function isValidWorkId(value) {
  return typeof value === 'string' && R2P_WORK_ID_RE.test(value) && !value.includes('..');
}
function parseInvocationR2p(tokens) {
  let workId = null; // accept workId=<WF-...> or one bare WF-...; reject extra/dup/conflicting tokens
  // reject target=, ref=, scope=, base=, assurance=, ledger=, guard=, strict, normal, and bare paths
  // parse read-only|review-and-fix, resume|reset, rounds=<n> (needs review-and-fix), root=, debug
  if (!isValidWorkId(workId)) {
    return { status: 'blocked', blockingReason: 'invalid-r2p-invocation',
             nextAction: 'rerun as review-fix-r2p workId=<WF-...>' };
  }
  return { routeKind: 'r2p', workId, mode, resume, reset, roundLimit, projectRootArg, debug };
}
```
Steps:
- [ ] Replace the path/target grammar with the workId=/bare-WF grammar and the strict-parse error set.
- [ ] Enforce the workId value shape (regex plus explicit `..` rejection) and the path-token rejection message.
- [ ] Return the exact `invalid-r2p-invocation` blocked payload on any error; parse `debug` as a verbosity-only boolean.
Verification: `node --test --test-name-pattern='gate1' test/r2p-route.test.js` passes (accepts `workId=WF-x` and bare `WF-x`; rejects `target=...`, `.req-to-plan/...`, `07-plan.md`, `workId=archive/WF-x`, `workId=../x`, `workId=--from=x`, and ref/scope/base/assurance/ledger/guard/strict/normal).

### PLAN-TASK-004 r2p route descriptor semantic fields
Spec References: SPEC-LIFECYCLE-001
Scope: SCOPE-IN-005
Change Type: modify
TDD Applicable: yes
Files:
- lib/routes.js
Skeleton:
```js
Object.freeze({
  routeName: 'review-fix-r2p',
  routeKind: 'r2p',
  documentType: 'PLAN',
  rubric: 'plan',
  defaultMode: 'review-and-fix',
  targetContextKind: 'r2p',
  artifactWritePolicy: 'forbidden',
  repairPolicy: 'r2p-lifecycle',
  repairCommands: ['r2p-reopen', 'r2p-gap-open'],
  platformPolicy: DEFAULT_PLATFORM_POLICY
});
```
Steps:
- [ ] Add `artifactWritePolicy:'forbidden'`, `repairPolicy:'r2p-lifecycle'`, `repairCommands:['r2p-reopen','r2p-gap-open']`.
- [ ] Remove `defaultGuard` from the r2p descriptor (no guard token for this route).
Verification: `node --test --test-name-pattern='descriptor' test/r2p-route.test.js` passes (descriptor exposes the three new fields and no `defaultGuard`).

### PLAN-TASK-005 add workId resolver, content-independent key, and filesystem preflight
Spec References: SPEC-RESOLVE-001, SPEC-PREFLIGHT-001
Scope: SCOPE-IN-004, SCOPE-IN-003
Change Type: modify
TDD Applicable: yes
Files:
- lib/workflow/target-resolution.js
- lib/target-context.js
- lib/target-state.js
Skeleton:
```js
function deriveR2pTargetKey({ projectRoot, workId }) {
  const root = realExistingDirectory(projectRoot, 'project root');
  const slug = slugifyTarget(workId);
  const hash12 = crypto.createHash('sha256').update(['r2p', root, workId].join('')).digest('hex').slice(0, 12);
  return { slug, hash12, targetKey: `${slug}-${hash12}` };
}
function resolveR2pWorkIdTarget({ projectRoot, workId }) {
  // FS preflight (fail-closed, in order): root, .req-to-plan workspace, active/archive on a validated
  // single-segment workId with realpath direct-child containment, run dir, then run.md + 03-07 regular non-symlink.
  const activeDir = path.join(projectRoot, '.req-to-plan', workId);
  assertDirectChildOf(activeDir, path.join(projectRoot, '.req-to-plan'));
  return { routeKind: 'r2p', workId, runDir: activeDir,
           reviewFiles: ['03-requirement-brief.md','04-risk-discovery.md','05-design.md','06-spec.md','07-plan.md'],
           protectedDependencies: ['run.md'], editableFiles: [],
           runMdSha256, reviewSetFingerprint,
           targetKey: deriveR2pTargetKey({ projectRoot, workId }).targetKey };
}
```
Steps:
- [ ] Add `deriveR2pTargetKey` (content-independent) in lib/target-state.js and `resolveR2pWorkIdTarget` plus the ordered FS preflight in lib/workflow/target-resolution.js / lib/target-context.js, each FS check blocking with its exact reason.
- [ ] Keep `runMdSha256` and the review-set fingerprint as freshness outputs only; do NOT remove the legacy `resolveR2pTarget`/`buildR2pIdentity` yet (their callers are migrated in PLAN-TASK-010).
Verification: `node --test --test-name-pattern='gate3' test/r2p-route.test.js` passes the workspace/artifact preflight cases and the same-workId-stable-key assertion.

### PLAN-TASK-006 r2p-repair module: probe, status, repair plan, execution, drift guard, receipt
Spec References: SPEC-PREFLIGHT-001, SPEC-STATUS-001, SPEC-PLAN-001, SPEC-EXEC-001
Scope: SCOPE-IN-003, SCOPE-IN-006, SCOPE-IN-007, SCOPE-IN-008, SCOPE-IN-009
Change Type: create
TDD Applicable: yes
Files:
- lib/workflow/r2p-repair.js
Skeleton:
```js
const { execFile } = require('node:child_process');
const REQUIRED_CMDS = ['r2p-status', 'r2p-reopen', 'r2p-gap-open', 'r2p-continue'];
const MUTATING_ALLOWLIST = new Set(['r2p-reopen', 'r2p-gap-open']);
function resolveR2pCommands() { /* PATH then ~/.req-to-plan/bin; returns {name->absPath}; missing -> r2p-command-unavailable */ }
function probeJsonContract(paths) { /* run paths['r2p-status'] --all with R2P_JSON=1; parse JSON; a run entry must have status+current_stage else r2p-json-contract-unavailable */ }
function readRunStatus(paths, workId) { /* r2p-status --all + R2P_JSON=1; select by work_id; never r2p-switch */ }
function mapRepairMode(status, currentStage, findings) { /* reopen | gap-open | current-stage checkpoint | unsupported */ }
function buildRepairPlan(accepted, mode, currentStage) { /* one command_kind; earliest STAGE_ORDER stage; all issue_ids; else r2p-repair-plan-ambiguous */ }
function driftGuard(state) { /* commands resolve; active exists; archive absent; fingerprints unchanged; live status matches command_kind */ }
function runRepairCommand(paths, plan) {
  const bin = paths[plan.command_kind]; // resolved absolute path, not the bare verb (binaries are not on PATH)
  const argv = plan.command_kind === 'r2p-gap-open'
    ? ['--work-id', plan.workId, '--owner-stage', plan.owner_stage, '--required-action', plan.required_action, '--confirm']
    : ['--from', plan.workId, '--stage', plan.owner_stage, '--reason', plan.reason];
  return execFile(bin, argv, { env: { ...process.env, R2P_JSON: '1' } }); // shell:false
}
function writeReceipt(result) { /* redacted argv/stdout/stderr; capture newWorkId or route_id/staled_stages; nextAction */ }
module.exports = { resolveR2pCommands, probeJsonContract, readRunStatus, mapRepairMode, buildRepairPlan, driftGuard, runRepairCommand, writeReceipt };
```
Steps:
- [ ] Implement command resolution (returning absolute paths because the binaries are not on PATH), the `R2P_JSON` probe (parse-as-JSON plus a `status`+`current_stage` key check on a run entry from the `r2p-status --all` array), and the status read.
- [ ] Implement the four-way repair-mode mapping, finding-to-owner-stage mapping, the single-line/NUL-free/shell-free reason rules, repair-plan validation, and earliest-stage aggregation.
- [ ] Implement the always-on pre-execution drift guard, argv-array `shell:false` execution using the resolved path (`--confirm` on gap-open), and the redacted receipt capturing `new_work_id`/`route_id`.
Verification: `node --test --test-name-pattern='gate6|gate8|gate10|drift|redaction' test/r2p-route.test.js` passes against the fake r2p binaries.

### PLAN-TASK-007 r2p lifecycle subcommands, write-lifecycle prohibition, preflight ordering
Spec References: SPEC-LIFECYCLE-001
Scope: SCOPE-IN-005
Change Type: modify
TDD Applicable: yes
Files:
- lib/workflow/index.js
- lib/workflow/file-set-fix.js
Skeleton:
```js
const R2P_SUBCOMMANDS = new Set(['record-r2p-repair-plan', 'apply-r2p-repair']);
const R2P_FORBIDDEN_WRITE_SUBCOMMANDS = new Set(['begin-fix', 'refresh-lock', 'end-fix', 'abort-fix', 'record-diff-review']);
function dispatch(parsed, subcommand) {
  if (parsed.routeKind === 'r2p' && R2P_FORBIDDEN_WRITE_SUBCOMMANDS.has(subcommand)) {
    return { status: 'blocked', blockingReason: 'r2p-direct-artifact-write-forbidden' };
  }
  // preflight order for r2p: r2p-repair command-env + R2P_JSON probe FIRST, then resolveR2pWorkIdTarget FS checks
  // context returns { routeKind:'r2p', workId, runDir, runLocation, reviewFiles, protectedDependencies:['run.md'],
  //   editableFiles:[], directArtifactWrites:'forbidden', repairMode }
}
```
Steps:
- [ ] Dispatch `record-r2p-repair-plan` and `apply-r2p-repair` to the r2p-repair module; stop routing r2p through the file-set write/diff functions.
- [ ] Block every write/diff subcommand and any direct write for r2p with `r2p-direct-artifact-write-forbidden`.
- [ ] Wire the r2p preflight so the r2p-repair command-environment + `R2P_JSON` probe run before the resolver FS checks, and emit the r2p `context` payload.
Verification: `node --test --test-name-pattern='gate2|gate5' test/r2p-route.test.js` passes (subcommands dispatch, write/diff subcommands return `r2p-direct-artifact-write-forbidden`, command-env preflight precedes FS checks, context payload has `editableFiles:[]`).

### PLAN-TASK-008 finalize, PASS semantics, state lifecycle, and receipt linkage
Spec References: SPEC-PASS-001
Scope: SCOPE-IN-010
Change Type: modify
TDD Applicable: yes
Files:
- lib/workflow/file-set-finalize.js
Skeleton:
```js
function finalizeR2p(state) {
  if (state.repairApplied) {
    return { finalStatus: 'checkpoint', statusReason: 'r2p-repair-applied',
             coordinatorAgreement: 'none', nextAction: nextActionForRepair(state) };
  }
  if (state.platform === 'gemini' || state.reviewFindings.length) return advisoryOrFindings(state);
  return { finalStatus: 'pass' }; // only on a clean re-review of regenerated artifacts
}
// resume continues target-local state; reset archives + starts fresh; read-only w/o resume/reset is no-state.
// reopen records prior workId + prior receipt id under the new key; gap-open carries the receipt forward.
```
Steps:
- [ ] Implement checkpoint-after-repair (`r2p-repair-applied`, never PASS) and PASS only on a clean re-review of regenerated artifacts.
- [ ] Implement `resume`/`reset`/no-state and receipt linkage across reopen (new key) vs gap-open (same key); keep Gemini advisory-only.
Verification: `node --test --test-name-pattern='gate7' test/r2p-route.test.js` passes (repair round finalizes at checkpoint and never PASSes; clean re-review PASSes; resume links the prior receipt; Gemini never PASSes).

### PLAN-TASK-009 manifest V2 r2p field rework
Spec References: SPEC-RESOLVE-001, SPEC-DOCS-001
Scope: SCOPE-IN-011
Change Type: modify
TDD Applicable: yes
Files:
- lib/workflow-state.js
Skeleton:
```js
const MANIFEST_V2_R2P_FIELDS = Object.freeze([
  ['workId', 'Work id'],
  ['runMdSha256', 'Run md sha256'],
  ['reviewSetFingerprint', 'Review set fingerprint'],
  ['lastModifiedAt', 'Last modified at']
]);
function manifestV2FieldsForKind(kind) {
  if (kind === 'r2p') return [...MANIFEST_V2_COMMON_HEAD_FIELDS, ...MANIFEST_V2_R2P_FIELDS];
  // document/code/pr branches unchanged
}
```
Steps:
- [ ] Replace `MANIFEST_V2_R2P_FILESET_FIELDS` with read-only review-set fields (drop requirementDir-as-key/editable-set semantics; add `workId`).
- [ ] Update the r2p parse/format branch and `requiredManifestV2Keys`; leave the document/pr/code branches untouched.
Verification: `node --test --test-name-pattern='manifest' test/r2p-route.test.js` round-trips an r2p manifest with the new fields, and `npm test` confirms the document/pr/code field sets are unchanged.

### PLAN-TASK-010 migrate legacy r2p-target callers to the workId model and remove the old functions
Spec References: SPEC-RESOLVE-001, SPEC-DOCS-001
Scope: SCOPE-IN-004, SCOPE-IN-011
Change Type: modify
TDD Applicable: yes
Files:
- lib/workflow/start.js
- lib/workflow/file-set-context.js
- lib/workflow/file-set-no-state.js
- lib/workflow/file-set-finalize.js
- lib/workflow/helpers.js
- lib/target-context.js
Skeleton:
```js
// Decision: every r2p branch is MIGRATED to the workId model (r2p is still a supported, read-only route),
// not removed. Replace each call to resolveR2pTarget / buildR2pIdentity / compareR2pIdentity:
//   start.js, file-set-context.js, file-set-no-state.js: resolveR2pTarget(...) -> resolveR2pWorkIdTarget({ projectRoot, workId })
//   file-set-finalize.js: buildR2pIdentity/compareR2pIdentity freshness -> compare the new manifest workId + reviewSetFingerprint
//   helpers.js: re-export resolveR2pWorkIdTarget / deriveR2pTargetKey (drop the old re-exports)
//   target-context.js: delete the path-based resolveR2pTarget and buildR2pIdentity definitions
```
Steps:
- [ ] Rewire `start.js`, `file-set-context.js`, and `file-set-no-state.js` r2p branches to call `resolveR2pWorkIdTarget` with the parsed `workId`.
- [ ] Replace `file-set-finalize.js` `buildR2pIdentity`/`compareR2pIdentity` freshness logic with a comparison of the new manifest `workId` + `reviewSetFingerprint`, and update the `helpers.js` re-exports to the workId functions.
- [ ] Delete the path-based `resolveR2pTarget` and `buildR2pIdentity` (and `compareR2pIdentity` if now unused) in `lib/target-context.js`; this task runs AFTER PLAN-TASK-005 added the replacements.
Verification: `grep -rn "resolveR2pTarget\|buildR2pIdentity\|compareR2pIdentity" lib` returns no matches, and `npm test` passes with no dangling reference.

### PLAN-TASK-011 scrub the file-set-r2p-gate importers
Spec References: SPEC-DOCS-001
Scope: SCOPE-IN-011
Change Type: modify
TDD Applicable: yes
Files:
- lib/workflow/file-set-fix.js
- lib/workflow/file-set-finalize.js
- test/workflow-module-boundaries.test.js
Skeleton:
```js
// The only three importers of file-set-r2p-gate are file-set-fix.js, file-set-finalize.js, and the
// module-boundary test. Remove the import and every use of its six symbols (snapshotForceIncludeDirs,
// resolveR2pLiveFileSet, revalidateR2pGate, beginGateBlockArgs, endGateBlockArgs, RESTORE_BEFORE_CONTINUE),
// including the four-checkpoint revalidation and the snapshot force-include of the WF dir; drop the
// retired-module entry from the boundary test.
```
Steps:
- [ ] Remove the `file-set-r2p-gate` import and all call sites from `file-set-fix.js` and `file-set-finalize.js`.
- [ ] Update `test/workflow-module-boundaries.test.js` to no longer expect the retired module.
Verification: `grep -rn "file-set-r2p-gate" lib test` returns no matches, and `npm test` passes.

### PLAN-TASK-012 delete the retired write-guard module
Spec References: SPEC-DOCS-001
Scope: SCOPE-IN-011
Change Type: delete
TDD Applicable: no
Files:
- lib/workflow/file-set-r2p-gate.js
Skeleton:
```text
Delete the module after PLAN-TASK-011 removed every importer; the module-boundary test and a clean
npm test verify no consumer remains.
```
Steps:
- [ ] Delete lib/workflow/file-set-r2p-gate.js.
- [ ] Confirm no remaining importer references it.
Verification: `test -e lib/workflow/file-set-r2p-gate.js` is false and `node --test test/r2p-docs.test.js` plus `npm test` pass.

### PLAN-TASK-013 rewrite skill, route contracts, and prompts to the new model
Spec References: SPEC-DOCS-001
Scope: SCOPE-IN-011
Change Type: modify
TDD Applicable: no
Files:
- skills/review-fix-r2p/SKILL.md
- templates/fragments/route-contract.r2p.claude.md
- templates/fragments/route-contract.r2p.codex.md
- templates/fragments/route-contract.r2p.gemini.md
- templates/fragments/route-contract.r2p.opencode.md
- templates/fragments/invocation-gate.r2p.claude.md
- templates/fragments/invocation-gate.r2p.codex.md
- templates/fragments/invocation-gate.r2p.gemini.md
- templates/fragments/invocation-gate.r2p.opencode.md
- shared/prompts/coordinator.md
- shared/prompts/fixer.md
Skeleton:
```text
New model only: workId=<WF-...> input (no target=/path), active-only run, four required r2p commands,
03-07 + run.md read-only, direct artifact writes forbidden, repair = r2p-reopen/r2p-gap-open, checkpoint
after repair, PASS only on clean rerun. Replace the coordinator r2p finding-to-owner-doc map (which
named 03-07 editable) with finding-to-ownerStage mapping plus the r2p repair-plan rule; state the fixer
authors no file edits for this route. No legacy or migration language anywhere.
```
Steps:
- [ ] Rewrite SKILL.md and all eight r2p route-contract/invocation-gate fragments to the workId/read-only/repair-command model.
- [ ] Replace the coordinator r2p passage with finding-to-ownerStage + repair-plan + checkpoint-after-repair rules and the fixer no-direct-edit rule; remove all legacy/migration language.
Verification: `node --test test/r2p-docs.test.js` passes (docs mention `workId`, forbid direct writes, and contain none of `target=<requirement-dir>`, `03-07` editable, `r2q`, `migrat`, or `backward compat`).

## Trace

| This ID | Upstream | Status |
|---|---|---|
| PLAN-TASK-001 | SPEC-INPUT-001..SPEC-PASS-001 / SCOPE-IN-001, SCOPE-IN-009 | planned |
| PLAN-TASK-002 | SPEC-DOCS-001 / SCOPE-IN-011 | planned |
| PLAN-TASK-003 | SPEC-INPUT-001 / SCOPE-IN-001, SCOPE-IN-002 | planned |
| PLAN-TASK-004 | SPEC-LIFECYCLE-001 / SCOPE-IN-005 | planned |
| PLAN-TASK-005 | SPEC-RESOLVE-001, SPEC-PREFLIGHT-001 / SCOPE-IN-004, SCOPE-IN-003 | planned |
| PLAN-TASK-006 | SPEC-PREFLIGHT-001, SPEC-STATUS-001, SPEC-PLAN-001, SPEC-EXEC-001 / SCOPE-IN-006..009 | planned |
| PLAN-TASK-007 | SPEC-LIFECYCLE-001 / SCOPE-IN-005 | planned |
| PLAN-TASK-008 | SPEC-PASS-001 / SCOPE-IN-010 | planned |
| PLAN-TASK-009 | SPEC-RESOLVE-001, SPEC-DOCS-001 / SCOPE-IN-011 | planned |
| PLAN-TASK-010 | SPEC-RESOLVE-001, SPEC-DOCS-001 / SCOPE-IN-004, SCOPE-IN-011 | planned |
| PLAN-TASK-011 | SPEC-DOCS-001 / SCOPE-IN-011 | planned |
| PLAN-TASK-012 | SPEC-DOCS-001 / SCOPE-IN-011 | planned |
| PLAN-TASK-013 | SPEC-DOCS-001 / SCOPE-IN-011 | planned |

## Upstream Summary (read-only)
# Spec

## Behavior Contracts

### SPEC-INPUT-001 workId invocation grammar and value shape
implements DES-INPUT-001 [ADDRESSED]; closes RISK-SEC-001 [ADDRESSED] (covers SCOPE-IN-001, SCOPE-IN-002)
- Accept `review-fix-r2p workId=<WF-...>` and a single bare `WF-...` token (shorthand for `workId=`).
- Full grammar: `workId=<WF-...> [read-only|review-and-fix] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`.
- The `workId` value MUST match `^WF-[A-Za-z0-9._-]+$` AND MUST NOT contain the substring `..`; any value
  failing this — path-shaped (`archive/WF-x`, `../../x`), flag-shaped (`--from=x`, leading `-`), NUL-bearing,
  or over the length bound — is an invalid invocation and is never resolved.
- Strict parse errors: duplicate `workId=`, more than one bare workId, `read-only` together with
  `review-and-fix`, `resume` together with `reset`, `rounds=` without `review-and-fix`.
- Reject `target=<anything>` (including `.req-to-plan/...` and `07-plan.md`) and any bare path token with
  the single message `Blocked: review-fix-r2p expects workId=<WF-...>, not a path.`; reject
  `ref=/scope=/base=/assurance=/ledger=/guard=/strict/normal` as unknown tokens for this route.
- `debug` is a parsed boolean raising diagnostic verbosity only; it never relaxes preflight, read-only,
  or PASS rules.
- On any invocation error, return exactly
  `{ "status":"blocked", "blockingReason":"invalid-r2p-invocation", "nextAction":"rerun as review-fix-r2p workId=<WF-...>" }`.

### SPEC-PREFLIGHT-001 fail-closed preflight chain
implements DES-PREFLIGHT-001 [ADDRESSED]; closes RISK-DEP-001 [ADDRESSED], RISK-CROSS-001 [ADDRESSED] (covers SCOPE-IN-003)
Run in order, before any review work, drfx state, reviewer run, or r2p command; each failure blocks:
1. Resolve `r2p-status`, `r2p-reopen`, `r2p-gap-open`, `r2p-continue` via PATH then `~/.req-to-plan/bin`;
   any missing -> `r2p-command-unavailable`. Then probe `R2P_JSON`: run a read-only status command with
   `R2P_JSON=1`; the output must parse as JSON and contain at least `status` and `current_stage` to count
   as honoring the contract; otherwise -> `r2p-json-contract-unavailable`.
2. Project root (`root=` else cwd) exists, is a directory, not a symlink, else -> `invalid-project-root`.
3. `<root>/.req-to-plan` exists and is a real directory, else -> `r2p-workspace-not-found`
   (missing) / `unsafe-r2p-workspace` (symlink).
4. workId active/archive resolution on a validated single-segment workId: realpath-resolve
   `activeDir=<root>/.req-to-plan/<workId>` and `archiveDir=<root>/.req-to-plan/archive/<workId>` and assert
   each is a DIRECT child of `.req-to-plan` (resp. `.req-to-plan/archive`); then branch — active only ->
   continue; archive only -> `r2p-run-archived`; both -> `r2p-work-id-conflict`; neither ->
   `r2p-run-not-found`.
5. `activeDir` is a directory and not a symlink, else -> `unsafe-r2p-run-dir`.
6. `run.md` and each of `03-07` exist as regular non-symlink files, else -> `r2p-artifact-missing-or-unsafe`.

### SPEC-RESOLVE-001 workId-based read-only resolver and stable key
implements DES-RESOLVE-001 [ADDRESSED]; closes RISK-WRITE-001 [ADDRESSED] (covers SCOPE-IN-004)
- `resolveR2pWorkIdTarget({ projectRoot, workId })` returns `reviewFiles=[03,04,05,06,07]`,
  `protectedDependencies=['run.md']`, `editableFiles=[]`, the `runDir`/`runLocation`, `runMdSha256`, and a
  review-set fingerprint over `03-07`.
- The target key comes from `deriveR2pTargetKey({ projectRoot, workId })` = `slug-hash12` over a
  domain-separated SHA-256 of (`r2p`, realpath project root, workId); it is independent of any
  `run.md`/`03-07` content, so the same workId yields the same key across r2p regeneration, while a reopen
  (new workId) yields a new key.
- `runMdSha256` and the review-set fingerprint are persisted to the manifest ONLY as freshness gates; a
  changed fingerprint marks the prior review stale and forces a re-read before any PASS, but never changes
  the key.
- The path-based `resolveR2pTarget` and `buildR2pIdentity` are removed; all r2p-branch consumers migrate to
  the workId resolver (see SPEC-DOCS-001).

### SPEC-LIFECYCLE-001 r2p workflow lifecycle and write prohibition
implements DES-LIFECYCLE-001 [ADDRESSED]; closes RISK-WRITE-001 [ADDRESSED] (covers SCOPE-IN-005)
- Lifecycle: `start -> context -> record-review -> record-triage -> record-r2p-repair-plan ->
  apply-r2p-repair -> finalize/checkpoint`.
- `context` returns `routeKind:'r2p'`, `workId`, `runDir`, `runLocation`, `reviewFiles` (`03-07`),
  `protectedDependencies:['run.md']`, `editableFiles:[]`, `directArtifactWrites:'forbidden'`, and the
  resolved `repairMode`.
- Two new subcommands exist: `record-r2p-repair-plan` and `apply-r2p-repair`.
- For the r2p route the write/diff subcommands `begin-fix`, `refresh-lock`, `end-fix`, `abort-fix`,
  `record-diff-review` and any direct artifact write block with `r2p-direct-artifact-write-forbidden`.

### SPEC-STATUS-001 status resolution and finding-to-owner-stage mapping
implements DES-STATUS-001 [ADDRESSED]; closes RISK-CROSS-001 [ADDRESSED] (covers SCOPE-IN-006, SCOPE-IN-007)
- Resolve `status`, `current_stage`, and `open_routes_detail[]` (each with `owner_stage`) by running
  `r2p-status --all` with `R2P_JSON=1` and selecting the entry whose `work_id` matches; never `r2p-switch`.
- Repair-mode mapping: `closed_at_plan_checkpoint`/`executing` -> reopen; open run + finding owned strictly
  upstream of `current_stage` -> gap-open; open run + owner==`current_stage` finding -> checkpoint
  `r2p-current-stage-repair-required`; anything else -> `r2p-run-status-unsupported`.
- Each finding maps to an `ownerStage` over `[raw_requirement, requirement_brief, risk_discovery, design,
  spec, plan]` via the requirement's finding-type table.
- `reason`/`required-action` are single-line, non-empty, length-bounded, NUL-free, with no embedded shell
  command.

### SPEC-PLAN-001 repair-plan schema, validation, earliest-stage aggregation
implements DES-PLAN-001 [ADDRESSED] (covers SCOPE-IN-008)
- One repair plan per round with exactly one `command_kind` (`r2p-reopen` or `r2p-gap-open`); `issue_id`s
  from accepted findings; `owner_stage` a valid stage; `reason`/`required_action` pass the string rules.
- Aggregation applies the SPEC-STATUS-001 mapping first, then collapses accepted findings into one command
  at the EARLIEST repairable `STAGE_ORDER` stage, recording every aggregated `issue_id`.
- An open run with no accepted finding strictly upstream of `current_stage` yields the current-stage
  checkpoint (no plan).
- Block `r2p-repair-plan-ambiguous` only when, after the status mapping, accepted findings still cannot map
  to valid owner stages or one allowed command.

### SPEC-EXEC-001 allowlisted execution, drift guard, redacted receipt
implements DES-EXEC-001 [ADDRESSED]; closes RISK-SEC-001 [ADDRESSED], RISK-DRIFT-001 [ADDRESSED], RISK-DATA-001 [ADDRESSED] (covers SCOPE-IN-009)
- Mutating allowlist is exactly `r2p-reopen`, `r2p-gap-open`; read-only allowlist is `r2p-status`; every
  other r2p verb is forbidden to drfx.
- Execute via an argv array with `shell:false` and `R2P_JSON=1`; pass `--confirm` on `r2p-gap-open`.
- Immediately before execution, an always-on drift guard re-checks: the four commands still resolve; the
  active run still exists and the archive run still does not; the `run.md`+`03-07` fingerprints are
  unchanged since review/triage; and the live `R2P_JSON` status still matches the plan's `command_kind` —
  any mismatch blocks instead of executing.
- The receipt records only: command, a reduced single-line argv with `reason`/`required-action` redacted,
  exit code, redacted stdout/stderr, captured `newWorkId` (reopen) or `route_id`/`staled_stages`
  (gap-open), and `nextAction`. It never records raw prompts, transcripts, secrets, or large artifact
  bodies.

### SPEC-PASS-001 PASS semantics, linkage, state lifecycle, Gemini
implements DES-PASS-001 [ADDRESSED]; closes RISK-PASS-001 [ADDRESSED] (covers SCOPE-IN-010)
- A round that executed a repair command finalizes at a checkpoint (`Final status: checkpoint`,
  `Status reason: r2p-repair-applied`, `Coordinator agreement: none`) and can never PASS.
- PASS is reachable only on a clean re-review of the current active run's regenerated artifacts.
- `nextAction` instructs running `r2p-continue` until r2p finishes, then rerunning
  `review-fix-r2p workId=<...>` (new workId after reopen, same after gap-open).
- State lifecycle: `resume` continues the workId's target-local state (linking the prior receipt); `reset`
  archives it and starts fresh; a one-shot `read-only` run without `resume`/`reset` is no-state. On reopen
  the new workId's `start` state records the prior workId and prior receipt id; on gap-open the same key
  carries the receipt forward.
- Gemini is advisory-only and can never claim PASS.

### SPEC-DOCS-001 documentation rewrite and complete retirement
implements DES-DOCS-001 [ADDRESSED]; closes RISK-MIG-001 [ADDRESSED] (covers SCOPE-IN-011)
- Rewrite `skills/review-fix-r2p/SKILL.md`, `templates/fragments/route-contract.r2p.*`,
  `templates/fragments/invocation-gate.r2p.*`, `shared/prompts/coordinator.md`, and
  `shared/prompts/fixer.md` to the new model only, with no legacy or migration language; the
  coordinator's old "r2p finding-to-owner-doc map" (which names `03-07` as the editable set) is replaced.
- Retire `lib/workflow/file-set-r2p-gate.js` entirely. Remove EVERY import and use of its six exported
  symbols — `snapshotForceIncludeDirs`, `resolveR2pLiveFileSet`, `revalidateR2pGate`, `beginGateBlockArgs`,
  `endGateBlockArgs`, `RESTORE_BEFORE_CONTINUE` — across `lib/workflow/file-set-fix.js` and
  `lib/workflow/file-set-finalize.js` (the import block and all call sites in both files, including the
  final-PASS `revalidateR2pGate`), leaving no dangling import; update `test/workflow-module-boundaries.test.js`
  to drop the retired module entry.
- Migrate the other r2p-branch consumers of `resolveR2pTarget`/`buildR2pIdentity` (e.g.
  `lib/workflow/file-set-context.js`, `lib/workflow/start.js`, and any other caller) to the workId model.
- Replace `MANIFEST_V2_R2P_FILESET_FIELDS` with read-only review-set freshness fields (drop the
  requirementDir-as-key/editable-set semantics, add `workId`; keep `runMdSha256` and a review-set
  fingerprint as freshness gates), keeping `manifestV2FieldsForKind` valid for the six non-r2p kinds.

## API / Data / Config Contracts

- **workId value contract**: regex `^WF-[A-Za-z0-9._-]+$`, additionally rejecting any value containing
  `..`; single path segment; length-bounded; NUL-free. Used both at parse (SPEC-INPUT-001) and as the
  `--from`/`--work-id` argv value (SPEC-EXEC-001).
- **Blocked result shape**: `{ status:'blocked', blockingReason:<token>, nextAction:<string> }`. Checkpoint
  result shape: `{ status:'checkpoint', statusReason:<token>, nextAction:<string> }`.
- **`context` payload**: `{ routeKind:'r2p', workId, runDir, runLocation, reviewFiles:['03..07'],
  protectedDependencies:['run.md'], editableFiles:[], directArtifactWrites:'forbidden', repairMode }`.
- **Repair-plan schema**: `{ command_kind:'r2p-reopen'|'r2p-gap-open', owner_stage:<stage>,
  issue_ids:[...], reason?:<string>, required_action?:<string> }` (reason for reopen, required_action for
  gap-open).
- **Receipt schema**: `{ command, argv:[redacted], exitCode, stdout:<redacted>, stderr:<redacted>,
  newWorkId?|routeId?, staledStages?, nextAction, receiptId, priorWorkId?, priorReceiptId? }`.
- **r2p `R2P_JSON` parse contract (input from r2p, read-only)**: status-run -> `{ status, current_stage,
  open_routes, open_routes_detail:[{ route_id, from_stage, owner_stage, required_action }] }`; reopen ->
  `{ new_work_id }`; gap-open -> `{ route_id, staled_stages }`.
- **Manifest V2 r2p fields (new)**: `targetContextKind='r2p'`, `workId`, `runMdSha256`, review-set
  fingerprint, timestamps; selected by `manifestV2FieldsForKind('r2p')`; no editable-set field.

## External Documentation Checked

| Dependency | Version | Check Date | Conclusion |
|---|---|---|---|
| req-2-plan CLI (`@xenonbyte/req-2-plan`) | 0.7.3 | 2026-06-27 | Verified against `~/x-skills/req-to-plan`: env-gated `R2P_JSON` JSON contract (`output.py:is_json_mode`), command signatures for reopen/gap-open/status, `STAGE_ORDER`, `--confirm` accepted-but-inert on gap-open. Binaries live at `~/.req-to-plan/bin` (not on PATH). |

## Test Matrix

| Gate | Scenario | Expected | SPEC ref |
|---|---|---|---|
| 1 Invocation | `workId=WF-x` / bare `WF-x`; then `target=...`, raw `.req-to-plan/...`, `07-plan.md`, `ref/scope/base/assurance/ledger/guard/strict/normal`, dup/conflict tokens; then `workId=archive/WF-x`, `workId=../x`, `workId=--from=x` | accept the first two; all others -> `invalid-r2p-invocation` | SPEC-INPUT-001 |
| 2 Command-env | one of the four r2p commands missing; then an r2p that ignores `R2P_JSON` | `r2p-command-unavailable`; then `r2p-json-contract-unavailable` | SPEC-PREFLIGHT-001 |
| 3 Workspace | missing/symlinked `.req-to-plan`; missing active workId; archive-only; active+archive conflict; real active | block reasons per step; real active passes | SPEC-PREFLIGHT-001 |
| 4 Artifact | missing/symlinked `run.md` or any `03-07`; all six regular | `r2p-artifact-missing-or-unsafe`; all-present passes | SPEC-PREFLIGHT-001 |
| 5 No-direct-write | drfx attempts a write to `03-07`/`run.md`; then r2p itself changes an artifact | drfx-driven change FAILS; r2p-authored change is NOT a failure | SPEC-LIFECYCLE-001, SPEC-RESOLVE-001 |
| 6 Repair-exec (fake r2p binaries emitting `R2P_JSON`) | closed-run finding; open-run upstream-gap finding | `r2p-reopen` captures `new_work_id`; `r2p-gap-open` (with `--confirm`) captures `route_id`; argv + `shell:false`; ends at checkpoint; no PASS; `nextAction` names `r2p-continue` + correct rerun workId | SPEC-EXEC-001, SPEC-PLAN-001 |
| 7 Rerun-PASS | regenerated artifacts re-review clean; then a repair command in the same round | clean rerun can PASS; same-round repair cannot PASS | SPEC-PASS-001 |
| 8 Status-contract | `R2P_JSON` payload with multiple open-route owner stages; then an r2p without the contract | parses deterministically; missing contract -> `r2p-json-contract-unavailable` | SPEC-STATUS-001, SPEC-PREFLIGHT-001 |
| 9 Current-stage | open run, owner==`current_stage` finding | neither gap-open nor reopen; checkpoint `r2p-current-stage-repair-required` | SPEC-STATUS-001, SPEC-PLAN-001 |
| 10 Aggregation | accepted findings spanning multiple owner stages; then a post-mapping unmappable set | one command at the earliest repairable stage with all `issue_ids`; unmappable -> `r2p-repair-plan-ambiguous` | SPEC-PLAN-001 |
| 11 Documentation | scan SKILL.md, route-contract/invocation-gate fragments, coordinator.md, fixer.md; module-boundary test | only the new model, no legacy/migration language; no dangling `file-set-r2p-gate` import | SPEC-DOCS-001 |

## Non-goals

- No compatibility with `review-fix-r2q` (SCOPE-OUT-001).
- No migration or reading of prior r2p/r2q `.drfx/targets` state (SCOPE-OUT-002).
- No acceptance of `target=<requirement-dir>` (SCOPE-OUT-003), a raw `.req-to-plan/WF-*` path
  (SCOPE-OUT-004), or a `07-plan.md` path (SCOPE-OUT-005).
- No reviewing an archived run (SCOPE-OUT-006) and no auto-promotion of an archived run to active
  (SCOPE-OUT-007).
- No auto-running `r2p-continue`, `r2p-execute`, or `r2p-archive` (SCOPE-OUT-008).
- No drfx-driven edit of `03-07` or `run.md` (SCOPE-OUT-009) and no treating r2p artifacts as an ordinary
  document or file-set fix target (SCOPE-OUT-010).
- No legacy-behavior or migration language in docs, skills, or route contracts (SCOPE-OUT-011).

## PLAN Handoff

Each SPEC contract maps to one or more PLAN tasks; PLAN must consume every SPEC id via `Spec References`
and carry every SCOPE-IN id in a task body. Suggested task grouping by build phase:

- Phase 1 (compliance): SPEC-INPUT-001, SPEC-PREFLIGHT-001, SPEC-RESOLVE-001, SPEC-LIFECYCLE-001,
  SPEC-STATUS-001 (recommend-only, no execution), and the Phase-1 slice of SPEC-DOCS-001 (route
  contracts/skill reflect workId + read-only + forbidden writes).
- Phase 2 (controlled execution): SPEC-PLAN-001, SPEC-EXEC-001 (argv execution, drift guard, redacted
  receipt, checkpoint-after-repair).
- Phase 3 (closed loop): SPEC-PASS-001 (capture ids, precise `nextAction`, receipt linkage, PASS only on
  clean rerun), plus the SPEC-DOCS-001 retirement (delete `file-set-r2p-gate.js`, scrub all imports across
  both consumer files, update the boundary test, replace manifest fields).
- Risk closure: RISK-DEP-001, RISK-SEC-001, RISK-WRITE-001, RISK-DRIFT-001, RISK-CROSS-001, RISK-DATA-001,
  RISK-PASS-001, RISK-MIG-001 are each addressed by the contracts above.
- Test fixtures: fake `r2p-reopen`/`r2p-gap-open`/`r2p-status` binaries emitting the documented `R2P_JSON`
  payloads, used by gates 6, 8, 9, 10.

## Trace

| This ID | Upstream | Status |
|---|---|---|
| SPEC-INPUT-001 | DES-INPUT-001 / SCOPE-IN-001, SCOPE-IN-002 | addressed |
| SPEC-PREFLIGHT-001 | DES-PREFLIGHT-001 / SCOPE-IN-003 | addressed |
| SPEC-RESOLVE-001 | DES-RESOLVE-001 / SCOPE-IN-004 | addressed |
| SPEC-LIFECYCLE-001 | DES-LIFECYCLE-001 / SCOPE-IN-005 | addressed |
| SPEC-STATUS-001 | DES-STATUS-001 / SCOPE-IN-006, SCOPE-IN-007 | addressed |
| SPEC-PLAN-001 | DES-PLAN-001 / SCOPE-IN-008 | addressed |
| SPEC-EXEC-001 | DES-EXEC-001 / SCOPE-IN-009 | addressed |
| SPEC-PASS-001 | DES-PASS-001 / SCOPE-IN-010 | addressed |
| SPEC-DOCS-001 | DES-DOCS-001 / SCOPE-IN-011 | addressed |
<!-- /r2p-read-only -->

## Project Context (read-only)
# Project Context Pack

- repo_root: `/Users/xubo/x-studio/document-review-fix`
- languages: {'JavaScript': 54039}
- package_managers: npm
- test_commands: ['npm test']
- entrypoints: ['lib/workflow/index.js']
- config_files: none
- dependencies (0): none
- source_dirs: ['bin', 'docs', 'lib', 'requirements', 'scripts', 'shared', 'skills', 'templates', 'test']
<!-- /r2p-read-only -->
