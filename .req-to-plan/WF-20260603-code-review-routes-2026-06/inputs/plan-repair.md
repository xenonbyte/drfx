# PLAN: code review routes

## Upstream References

| Artifact | Reference | Status |
|---|---|---|
| Raw Requirement | `.req-to-plan/WF-20260603-code-review-routes-2026-06/00-raw-requirement.md` | available |
| Requirement Brief | `.req-to-plan/WF-20260603-code-review-routes-2026-06/03-requirement-brief.md` | approved |
| Risk & Question Discovery | `.req-to-plan/WF-20260603-code-review-routes-2026-06/04-risk-discovery.md` | approved |
| DESIGN | `.req-to-plan/WF-20260603-code-review-routes-2026-06/05-design.md` | approved |
| SPEC | `.req-to-plan/WF-20260603-code-review-routes-2026-06/06-spec.md` | approved v2 |
| DESIGN Subagent Review | `.req-to-plan/WF-20260603-code-review-routes-2026-06/reviews/design-subagent-review-v2.md` | pass |
| SPEC Subagent Review | `.req-to-plan/WF-20260603-code-review-routes-2026-06/reviews/spec-subagent-review-v2.md` | pass |

## Plan Entry Gate

- Status: pass
- SPEC Checkpoint: approved
- Missing / Invalid Inputs: none
- Upstream Gap: none detected
- Safe next step: Contract-to-Task Mapping

## Implementation Strategy

Implement in a dependency-safe order:

1. Establish shared route descriptors so parser, generator, rulebook, and workflow code consume one source of route facts.
2. Add parser/default/rounds coverage before resolver and workflow changes.
3. Add target-context resolvers for PR and CODE, then wire file-set state and guards around those contexts.
4. Extend rulebooks, platform generation, and workflow lifecycle text without weakening existing document-route behavior.
5. Update docs and run the coverage matrix after targeted checks pass.

The plan is executor-neutral. It does not choose an agent runtime, prompt orchestration method, or platform-specific execution format.

## Contract-to-Task Mapping

| SPEC Contract | Source | Task / Check | Coverage Type | Closure Status | Resolution / Route |
|---|---|---|---|---|---|
| SPEC-FR-001, SPEC-IF-001 | Route descriptors | PLAN-TASK-001 | implementation + tests | [ADDRESSED] | Shared route registry and lookup tests. |
| SPEC-FR-002, SPEC-IF-003, SPEC-ERR-002, SPEC-COMPAT-004, SPEC-EDGE-001, SPEC-EDGE-002 | PR route | PLAN-TASK-003 | implementation + tests | [ADDRESSED] | PR resolver tests for base, current branch, merge-base, no fetch, rename/delete file sets. |
| SPEC-FR-003, SPEC-IF-004, SPEC-ERR-003, SPEC-SAFE-005, SPEC-EDGE-003 | CODE route | PLAN-TASK-004 | implementation + tests | [ADDRESSED] | CODE scope resolver tests for root, scope, exclusions, unsafe traversal. |
| SPEC-FR-004, SPEC-STATE-002, SPEC-ERR-004, SPEC-COMPAT-001, SPEC-EDGE-006, SPEC-EDGE-007 | rounds | PLAN-TASK-005 | implementation + tests | [ADDRESSED] | `roundLimit` parser/state/loop tests. |
| SPEC-FR-005, SPEC-IF-005, SPEC-ERR-008, SPEC-EDGE-004, SPEC-EDGE-005 | rulebook | PLAN-TASK-007 | implementation + tests | [ADDRESSED] | PR/CODE rubrics, load order, precedence, conflict tests. |
| SPEC-FR-006, SPEC-IF-006, SPEC-COMPAT-002 | platform generation/install | PLAN-TASK-008 | implementation + tests | [ADDRESSED] | Six route generated outputs and manifest-owned install/uninstall tests. |
| SPEC-FR-007, SPEC-SAFE-004 | workflow lifecycle | PLAN-TASK-009 | implementation + tests | [ADDRESSED] | Coordinator PASS, reviewer read-only, full re-review, write-blocking checks. |
| SPEC-FR-008, SPEC-COMPAT-003 | documentation | PLAN-TASK-010 | implementation + tests | [ADDRESSED] | Aligned README updates and documentation assertions. |
| SPEC-FR-009, SPEC-STATE-004, SPEC-ERR-009, SPEC-ACC-011, SPEC-ACC-012 | defaults and read-only | PLAN-TASK-002, PLAN-TASK-009 | implementation + tests | [ADDRESSED] | Default mode/guard parser tests and read-only no-state/no-PASS workflow tests. |
| SPEC-FR-010, SPEC-SAFE-007, SPEC-ACC-015 | no platform `/review` | PLAN-TASK-008 | implementation + tests | [ADDRESSED] | Generated route text assertions. |
| SPEC-STATE-001, SPEC-STATE-003, SPEC-ERR-005 | target context state | PLAN-TASK-003, PLAN-TASK-004, PLAN-TASK-009 | implementation + tests | [ADDRESSED] | Route/base/scope/file-set identity and stale resume tests. |
| SPEC-SAFE-001, SPEC-SAFE-002, SPEC-SAFE-003, SPEC-ERR-006, SPEC-ERR-007, SPEC-ACC-008, SPEC-ACC-009 | guards | PLAN-TASK-006 | implementation + tests | [ADDRESSED] | File-set git/snapshot guard tests. |
| SPEC-SAFE-006 | forbidden side effects | PLAN-TASK-003, PLAN-TASK-006, PLAN-TASK-008, PLAN-TASK-011 | safety + verification | [ADDRESSED] | No fetch/remote mutation/destructive operation checks. |
| SPEC-OBS-001, SPEC-OBS-002, SPEC-OBS-003, SPEC-EDGE-008 | observability | PLAN-TASK-009, PLAN-TASK-011 | implementation + verification | [ADDRESSED] | Concise output, redaction, residual-risk reporting tests. |
| SPEC-ACC-001 through SPEC-ACC-015 | acceptance scenarios | PLAN-TASK-002 through PLAN-TASK-011 | verification | [ADDRESSED] | Acceptance mapped to targeted tests and final matrix. |
| SPEC-PLAN-001 through SPEC-PLAN-011 | Plan Inputs | PLAN-TASK-001 through PLAN-TASK-011 | implementation + verification | [ADDRESSED] | Each SPEC Plan Input maps to one or more tasks below. |

## Risk Discovery Plan Input Traceability

| Risk Discovery Plan Input | DESIGN Plan Input | SPEC-PLAN ID | PLAN Coverage | Closure Status | Resolution / Route |
|---|---|---|---|---|---|
| RISK-PLAN-001 | DES-PLAN-010 | SPEC-PLAN-010 | PLAN-TASK-011 | [ADDRESSED] | Route x platform x mode x guard x rounds x rule-file verification matrix. |
| RISK-PLAN-002 | DES-PLAN-002 | SPEC-PLAN-002 | PLAN-TASK-002, PLAN-TASK-003 | [ADDRESSED] | PR parser/base/default tests. |
| RISK-PLAN-003 | DES-PLAN-002 | SPEC-PLAN-002, SPEC-PLAN-004 | PLAN-TASK-002, PLAN-TASK-004 | [ADDRESSED] | CODE parser/scope/exclusion tests. |
| RISK-PLAN-004 | DES-PLAN-003 | SPEC-PLAN-003 | PLAN-TASK-005 | [ADDRESSED] | Rounds validation, loop limit, early stop, no-rounds compatibility. |
| RISK-PLAN-005 | DES-PLAN-005 | SPEC-PLAN-005 | PLAN-TASK-006, PLAN-TASK-009 | [ADDRESSED] | File-set guards, stale state, read-only no-state. |
| RISK-PLAN-006 | DES-PLAN-007 | SPEC-PLAN-007 | PLAN-TASK-008 | [ADDRESSED] | Generated route ownership and owned-only uninstall. |
| RISK-PLAN-007 | DES-PLAN-007 | SPEC-PLAN-007 | PLAN-TASK-008 | [ADDRESSED] | Claude/Codex automatic-fix wording and Gemini advisory-only wording. |
| RISK-PLAN-008 | DES-PLAN-008 | SPEC-PLAN-008 | PLAN-TASK-009 | [ADDRESSED] | Output/redaction/default/debug boundaries. |
| RISK-PLAN-009 | DES-PLAN-006 | SPEC-PLAN-006 | PLAN-TASK-007 | [ADDRESSED] | Rule loading order, precedence, conflict behavior. |
| RISK-PLAN-010 | DES-PLAN-009 | SPEC-PLAN-009 | PLAN-TASK-010 | [ADDRESSED] | README structural alignment and content assertions. |

## TDD Decomposition

| Task | SPEC Contract | TDD Applicable | Steps | Alternative Verification |
|---|---|---|---|---|
| PLAN-TASK-001 | SPEC-FR-001, SPEC-IF-001 | yes | red route registry tests, green descriptor migration, refactor duplicate constants | N/A |
| PLAN-TASK-002 | SPEC-IF-002, SPEC-IF-003, SPEC-IF-004, SPEC-FR-009 | yes | red parser/default tests, green parser normalization, refactor dispatch | N/A |
| PLAN-TASK-003 | SPEC-FR-002, SPEC-ERR-002, SPEC-COMPAT-004 | yes | red local git fixture tests, green PR resolver, refactor target context schema | N/A |
| PLAN-TASK-004 | SPEC-FR-003, SPEC-SAFE-005 | yes | red scope/exclusion tests, green CODE resolver, refactor traversal helpers | N/A |
| PLAN-TASK-005 | SPEC-FR-004, SPEC-STATE-002 | yes | red rounds tests, green `roundLimit`, refactor loop boundary | N/A |
| PLAN-TASK-006 | SPEC-SAFE-001, SPEC-SAFE-002, SPEC-SAFE-003 | yes | red guard tests, green file-set guard helpers, refactor document wrappers | N/A |
| PLAN-TASK-007 | SPEC-FR-005, SPEC-IF-005 | yes | red rulebook tests, green rubrics/load order, refactor conflict validation | N/A |
| PLAN-TASK-008 | SPEC-FR-006, SPEC-FR-010, SPEC-SAFE-007 | yes | red generated output/install tests, green platform generation, refactor templates | N/A |
| PLAN-TASK-009 | SPEC-FR-007, SPEC-STATE-004, SPEC-OBS-001 | yes | red workflow lifecycle tests, green integration, refactor payload/context handling | N/A |
| PLAN-TASK-010 | SPEC-FR-008, SPEC-COMPAT-003 | yes | red README assertions, green docs updates, refactor docs only if structure drifts | N/A |
| PLAN-TASK-011 | SPEC-PLAN-010, all acceptance | no | final verification after implementation tasks | Full targeted and full-suite verification replaces TDD because this task changes no product behavior. |

## Execution Sequencing

| Order | Task | Depends On | Why This Order | Safe Checkpoint |
|---|---|---|---|---|
| 1 | PLAN-TASK-001 | none | Shared descriptors reduce parser/generator drift before behavior changes. | Route registry tests pass. |
| 2 | PLAN-TASK-002 | PLAN-TASK-001 | Parser defaults and usage-only stops define all later inputs. | Parser tests pass with no target reads/state creation on invalid input. |
| 3 | PLAN-TASK-003 | PLAN-TASK-001, PLAN-TASK-002 | PR target context needs normalized invocation. | PR resolver tests pass in local git fixtures. |
| 4 | PLAN-TASK-004 | PLAN-TASK-001, PLAN-TASK-002 | CODE scope resolver needs normalized invocation and route metadata. | CODE scope tests pass. |
| 5 | PLAN-TASK-005 | PLAN-TASK-002 | Rounds metadata can be added after parser output is stable. | Rounds tests pass and no-rounds compatibility holds. |
| 6 | PLAN-TASK-006 | PLAN-TASK-003, PLAN-TASK-004 | File-set guards need target contexts and monitored file sets. | Guard tests pass for route-owned and unrelated changes. |
| 7 | PLAN-TASK-007 | PLAN-TASK-001 | Rulebook depends on route/rubric keys, not guard behavior. | Rulebook tests pass. |
| 8 | PLAN-TASK-008 | PLAN-TASK-001, PLAN-TASK-002, PLAN-TASK-007 | Generated entries need descriptors, usage text, and rule/rubric names. | Generated asset and manifest tests pass. |
| 9 | PLAN-TASK-009 | PLAN-TASK-003, PLAN-TASK-004, PLAN-TASK-005, PLAN-TASK-006, PLAN-TASK-007 | Workflow integration depends on stable target context, rounds, guards, and rule context. | Workflow lifecycle and read-only tests pass. |
| 10 | PLAN-TASK-010 | PLAN-TASK-001 through PLAN-TASK-009 | Public docs should reflect final implemented behavior. | README assertions pass. |
| 11 | PLAN-TASK-011 | PLAN-TASK-001 through PLAN-TASK-010 | Final matrix and package checks run after all implementation/docs are present. | `npm test`, `npm pack --dry-run`, and generation checks pass. |

## Task Breakdown

### PLAN-TASK-001: Add shared route registry

Spec References:
- SPEC-FR-001: Six first-class routes.
- SPEC-IF-001: Route descriptors expose route facts and defaults.
- SPEC-PLAN-001: Implement shared route registry before parser/generator changes.

Goal:
Create a single route descriptor source for document, PR, and CODE routes while preserving existing document route behavior.

Change Type: add

TDD Applicable: yes

Files:
- Create: `lib/routes.js`
- Modify: `lib/generator.js`
- Modify: `lib/input.js`
- Create/Modify: `test/routes.test.js`
- Modify: `test/input-parsing.test.js`
- Modify: `test/shared-assets.test.js`

Skeleton:
```javascript
test('route registry exposes six supported routes with defaults', () => {
  const { getRouteDescriptor, listRoutes } = require('../lib/routes');
  assert.deepEqual(listRoutes().map((route) => route.routeName), [
    'review-fix-spec',
    'review-fix-plan',
    'review-fix-design',
    'review-fix-doc',
    'review-fix-pr',
    'review-fix-code',
  ]);
  assert.equal(getRouteDescriptor('review-fix-pr').defaultMode, 'review-and-fix');
  assert.equal(getRouteDescriptor('review-fix-pr').defaultGuard, 'git');
});
```

Steps:
- [ ] red: Add registry tests for all six route names, route kinds, default mode `review-and-fix`, default guard `git`, platform policy, rule/rubric key, and target context kind.
- [ ] red: Add compatibility assertions that existing document routes still resolve to their current document/rubric behavior.
- [ ] green: Add `lib/routes.js` and migrate generator/input route lookup to consume descriptors.
- [ ] refactor: Remove or wrap duplicated route/type constants so descriptor data is the source of truth.
- [ ] verify: Run route, input parsing, and shared asset tests.

Verification:
Run `node --test test/routes.test.js test/input-parsing.test.js test/shared-assets.test.js`. The tests must prove SPEC-FR-001, SPEC-IF-001, and document route compatibility.

Rollback / Safety:
Stop if descriptor migration requires changing existing document route names or install paths without a SPEC change. Revert descriptor migration if route lookup regresses document behavior.

### PLAN-TASK-002: Extend invocation parsing and side-effect-free preflight

Spec References:
- SPEC-IF-002: Document route invocation grammar plus `rounds=<n>`.
- SPEC-IF-003: PR invocation grammar and required `base`.
- SPEC-IF-004: CODE invocation grammar and invalid `base`.
- SPEC-ERR-001: Invalid token stops before reads/state/probes/fixes.
- SPEC-FR-009: Default `review-and-fix`, default `guard=git`, explicit-only `guard=snapshot`.
- SPEC-ACC-001, SPEC-ACC-003, SPEC-ACC-005, SPEC-ACC-006, SPEC-ACC-011: parser/default acceptance.
- SPEC-PLAN-002: Parser/preflight tests.

Goal:
Normalize all six route invocations before target reads or state creation, including defaults, route-specific tokens, invalid token usage-only stops, and read-only rounds handling.

Change Type: modify

TDD Applicable: yes

Files:
- Modify: `lib/input.js`
- Modify: `lib/workflow/serialization.js`
- Modify: `test/input-parsing.test.js`
- Modify: `test/workflow-args.test.js`
- Modify: `test/workflow-json-baseline.test.js`

Skeleton:
```javascript
test('review-fix-pr requires base and defaults mode and guard', () => {
  const result = parseInvocation('review-fix-pr', ['base=main']);
  assert.equal(result.mode, 'review-and-fix');
  assert.equal(result.guard, 'git');
  assert.equal(result.base, 'main');
});

test('review-fix-code rejects base before target reads', () => {
  const result = parseInvocation('review-fix-code', ['base=main']);
  assert.equal(result.status, 'usage');
  assert.match(result.message, /review-fix-pr/);
});
```

Steps:
- [ ] red: Add document route tests for valid `rounds=<n>`, invalid rounds, and no-rounds compatibility.
- [ ] red: Add PR parser tests for missing base usage output, valid base token, invalid route tokens, default mode/guard, and explicit `guard=snapshot`.
- [ ] red: Add CODE parser tests for default root scope, repeated `scope=<path>`, invalid `base=<branch>`, invalid tokens, default mode/guard, and explicit `guard=snapshot`.
- [ ] red: Add `read-only rounds=<n>` tests for all route kinds showing unsupported loop semantics and no workflow start.
- [ ] green: Implement route-kind parser dispatch and normalized invocation payloads.
- [ ] green: Ensure usage-only failures return before target/reference/diff reads, state creation, reviewer probes, or fixes.
- [ ] refactor: Keep document parser compatibility visible through existing public parser helpers.

Verification:
Run `node --test test/input-parsing.test.js test/workflow-args.test.js test/workflow-json-baseline.test.js`. Confirm invalid cases do not create state or read targets.

Rollback / Safety:
Stop if parser changes make existing documented document-route invocations ambiguous. Do not add silent fallbacks for unknown tokens or invalid `rounds`.

### PLAN-TASK-003: Implement PR target resolver and PR state identity

Spec References:
- SPEC-FR-002: PR diff semantics.
- SPEC-IF-003: PR target context.
- SPEC-ERR-002: missing/unresolvable/same branch/no merge-base stops.
- SPEC-STATE-001, SPEC-STATE-003: target context and stale resume identity.
- SPEC-SAFE-006: no fetch or remote mutation.
- SPEC-COMPAT-004: local refs/revisions only.
- SPEC-ACC-001, SPEC-ACC-002: PR acceptance.
- SPEC-EDGE-001, SPEC-EDGE-002: tags/commits/branches and rename/delete file sets.
- SPEC-PLAN-004: target context/state.

Goal:
Resolve PR target contexts from local git state, including base revision, current branch, current HEAD, merge-base, and initial file set, without fetching or mutating refs.

Change Type: add

TDD Applicable: yes

Files:
- Create: `lib/target-context.js`
- Modify: `lib/workflow/start.js`
- Modify: `lib/workflow/helpers.js`
- Modify: `lib/target-state.js`
- Create/Modify: `test/target-context.test.js`
- Modify: `test/target-state.test.js`
- Modify: `test/workflow-e2e.test.js`

Skeleton:
```javascript
test('pr resolver rejects current branch as base before review starts', async () => {
  const repo = await createLocalGitFixture();
  await assert.rejects(
    resolveTargetContext({ routeName: 'review-fix-pr', base: 'feature', cwd: repo.path }),
    /base cannot equal current branch/
  );
});

test('pr resolver uses merge-base without fetching', async () => {
  const context = await resolveTargetContext({ routeName: 'review-fix-pr', base: 'main', cwd: repo.path });
  assert.equal(context.routeKind, 'pr');
  assert.ok(context.mergeBase);
  assert.doesNotMatch(repo.commandLog.join('\n'), /git fetch/);
});
```

Steps:
- [ ] red: Add local temporary git fixture tests for missing base, unresolvable base, current branch equals base, no merge-base, branch/tag/commit base, and no implicit `git fetch`.
- [ ] red: Add tests for PR file-set discovery including modified, deleted, and renamed files.
- [ ] red: Add state identity tests showing PR state keys include route kind, base identity, merge-base/current HEAD or equivalent stale-detection fields, guard mode, and file-set identity.
- [ ] green: Implement PR target resolver using local git commands only.
- [ ] green: Persist PR target context into review-and-fix state and refuse stale resume when base, head, merge-base, guard, or file set no longer matches.
- [ ] refactor: Keep target-context shape usable by file-set guards and workflow prompts.

Verification:
Run `node --test test/target-context.test.js test/target-state.test.js test/workflow-e2e.test.js`. Confirm no command path performs `git fetch`, push, branch mutation, or remote update.

Rollback / Safety:
Stop if resolving PR context requires network access or remote ref mutation. Roll back PR resolver wiring if state identity cannot reject stale PR contexts.

### PLAN-TASK-004: Implement CODE scope resolver and deterministic source discovery

Spec References:
- SPEC-FR-003: project root or `scope=<path>` CODE review.
- SPEC-IF-004: CODE grammar and default exclusions.
- SPEC-ERR-003: invalid base/scope stops.
- SPEC-SAFE-005: reject outside, symlink-unsafe, excluded, missing, unsafe scopes.
- SPEC-STATE-001, SPEC-STATE-003: CODE target identity and stale resume.
- SPEC-ACC-003, SPEC-ACC-004, SPEC-ACC-014: CODE scope acceptance.
- SPEC-EDGE-003: excluded infrastructure.
- SPEC-PLAN-004: target context/state and mandatory exclusions.

Goal:
Resolve CODE target contexts with normalized in-root scopes, deterministic source traversal, mandatory exclusions, and safe stale-state identity.

Change Type: add

TDD Applicable: yes

Files:
- Modify: `lib/target-context.js`
- Modify: `lib/workflow/start.js`
- Modify: `lib/workflow/helpers.js`
- Modify: `lib/target-state.js`
- Create/Modify: `test/target-context.test.js`
- Create/Modify: `test/code-scope.test.js`
- Modify: `test/target-state.test.js`

Skeleton:
```javascript
test('code resolver rejects excluded scopes before review starts', async () => {
  for (const scope of ['.git', '.docs-review-fix', 'node_modules', 'dist', 'build', 'coverage']) {
    const result = await resolveCodeTarget({ cwd: fixture.root, scopes: [scope] });
    assert.equal(result.status, 'blocked');
  }
});

test('code resolver keeps normalized scopes inside project root', async () => {
  await assert.rejects(
    resolveCodeTarget({ cwd: fixture.root, scopes: ['../outside'] }),
    /outside project root/
  );
});
```

Steps:
- [ ] red: Add tests for no-scope project-root traversal that excludes `.git`, `.docs-review-fix`, `node_modules`, build outputs, dependency caches, temporary files, and other obvious non-source directories.
- [ ] red: Add tests for valid repeated scopes, missing scope, outside-root scope, symlink-unsafe scope, excluded scope, and unsafe traversal.
- [ ] red: Add CODE state identity tests covering normalized scopes, exclusions, file-set identity, guard mode, and stale resume refusal.
- [ ] green: Implement deterministic traversal and scope normalization without adding a new dependency.
- [ ] green: Wire CODE target context into workflow start/helper state paths.
- [ ] refactor: Keep exclusion constants owned by target-context or route descriptor code, not duplicated in prompts.

Verification:
Run `node --test test/code-scope.test.js test/target-context.test.js test/target-state.test.js`. Confirm no files outside project root are inspected or persisted in state.

Rollback / Safety:
Stop if source discovery requires a new dependency with meaningful maintenance/licensing/security impact; request a new decision before adding it.

### PLAN-TASK-005: Add `rounds=<n>` loop limit metadata

Spec References:
- SPEC-FR-004: positive integer maximum rounds with early clean stop.
- SPEC-STATE-002: `roundLimit` separate from counters and receipt paths.
- SPEC-ERR-004: invalid rounds usage-only and `read-only rounds=<n>` unsupported.
- SPEC-COMPAT-001: no-rounds document route behavior preserved.
- SPEC-EDGE-006, SPEC-EDGE-007: limit reached with remaining findings; early clean on round 2.
- SPEC-ACC-005, SPEC-ACC-006: rounds acceptance.
- SPEC-PLAN-003: rounds behavior.

Goal:
Add durable `roundLimit` metadata for all routes without reusing `currentRound` or receipt directory names, and enforce it only as a maximum.

Change Type: modify

TDD Applicable: yes

Files:
- Modify: `lib/input.js`
- Modify: `lib/workflow-state.js`
- Modify: `lib/workflow/fix-lifecycle.js`
- Modify: `lib/workflow/helpers.js`
- Modify: `lib/receipts.js`
- Modify: `test/input-parsing.test.js`
- Modify: `test/workflow-state-v2.test.js`
- Modify: `test/workflow-e2e.test.js`
- Modify: `test/receipts.test.js`

Skeleton:
```javascript
test('roundLimit stops after one repair round without claiming clean', async () => {
  const result = await runWorkflowFixture({ rounds: 1, reviewerFindingsAfterFix: true });
  assert.equal(result.stopReason, 'round-limit');
  assert.equal(result.status, 'stopped-with-deferrals');
});

test('rounds metadata is not derived from receipt round directories', () => {
  assert.equal(readInvocationMetadata(state).roundLimit, 5);
  assert.notEqual(readInvocationMetadata(state).roundLimitSource, 'receipts');
});
```

Steps:
- [ ] red: Add parser tests for positive integers only and usage-only invalid values.
- [ ] red: Add workflow tests for `rounds=1`, early clean before `rounds=5`, no-rounds existing behavior, and `read-only rounds=<n>` unsupported.
- [ ] red: Add state/receipt tests proving `roundLimit` is invocation/workflow metadata, not current round or receipt path data.
- [ ] green: Persist or carry `roundLimit` through workflow state/no-state payloads.
- [ ] green: Check the limit at loop boundaries after full re-review and before another fix cycle.
- [ ] refactor: Keep no-rounds behavior identical to current terminal conditions.

Verification:
Run `node --test test/input-parsing.test.js test/workflow-state-v2.test.js test/workflow-e2e.test.js test/receipts.test.js`.

Rollback / Safety:
Stop if the implementation would require altering existing receipt directory naming or current round semantics. Do not present round-limit stops as clean PASS.

### PLAN-TASK-006: Extend git and snapshot guards to file sets

Spec References:
- SPEC-SAFE-001: git guard allows route-owned prior-round changes and rejects unrelated changes.
- SPEC-SAFE-002: automatic fixes limited to target-related and necessary dependency files.
- SPEC-SAFE-003: snapshot/fingerprint monitored file set.
- SPEC-ERR-006, SPEC-ERR-007: selected guard unavailable stops without fallback.
- SPEC-SAFE-006: no destructive local or remote mutation.
- SPEC-ACC-008, SPEC-ACC-009: route-owned and unrelated-change acceptance.
- SPEC-PLAN-005: file-set guards.

Goal:
Add file-set git and snapshot guard helpers while preserving single-target document guard wrappers.

Change Type: modify

TDD Applicable: yes

Files:
- Modify: `lib/fix-guard.js`
- Modify: `lib/snapshot-guard.js`
- Modify: `lib/workflow/helpers.js`
- Modify: `lib/workflow/fix-lifecycle.js`
- Modify: `test/fix-guard.test.js`
- Modify: `test/snapshot-guard.test.js`
- Modify: `test/workflow-e2e.test.js`

Skeleton:
```javascript
test('file-set git guard allows route-owned prior-round changes only', async () => {
  const result = await checkFileSetWorktree({
    monitoredFiles: ['lib/a.js'],
    routeOwnedFiles: ['lib/a.js'],
    changedFiles: ['lib/a.js'],
  });
  assert.equal(result.status, 'ok');
});

test('file-set git guard blocks unrelated local changes', async () => {
  const result = await checkFileSetWorktree({
    monitoredFiles: ['lib/a.js'],
    routeOwnedFiles: ['lib/a.js'],
    changedFiles: ['README.md'],
  });
  assert.equal(result.status, 'blocked');
});
```

Steps:
- [ ] red: Add file-set git guard tests for clean baseline, route-owned prior-round changes, unrelated changes, files outside allowed set, and guard-unavailable cases.
- [ ] red: Add file-set snapshot tests for monitored file fingerprints, missing files, symlink/outside paths, restore limited to monitored files, and snapshot-unavailable cases.
- [ ] red: Add compatibility tests proving existing document single-target guard behavior still passes.
- [ ] green: Implement file-set guard helpers and route-owned change tracking inputs.
- [ ] green: Wire selected guard behavior so `guard=git` never silently switches to snapshot and `guard=snapshot` never silently switches to git.
- [ ] refactor: Keep guard result/status names compatible with workflow terminal semantics.

Verification:
Run `node --test test/fix-guard.test.js test/snapshot-guard.test.js test/workflow-e2e.test.js`.

Rollback / Safety:
Stop if guard logic cannot distinguish route-owned from unrelated changes. Do not add fallback behavior that continues unguarded.

### PLAN-TASK-007: Add PR/CODE rubrics and rulebook load order

Spec References:
- SPEC-FR-005: built-in PR/CODE rubrics and categories.
- SPEC-IF-005: exact external rule paths and load order.
- SPEC-ERR-008: hard-constraint conflicts block or report.
- SPEC-EDGE-004, SPEC-EDGE-005: absent/empty and symlink rule files.
- SPEC-ACC-013: rule loading acceptance.
- SPEC-PLAN-006: rulebook implementation.

Goal:
Extend rulebook support to PR and CODE while preserving existing document rule files and hard-constraint precedence.

Change Type: modify

TDD Applicable: yes

Files:
- Modify: `lib/rulebook.js`
- Create: `shared/rubrics/pr.md`
- Create: `shared/rubrics/code.md`
- Modify: `test/rulebook.test.js`
- Modify: `test/shared-assets.test.js`

Skeleton:
```javascript
test('PR rules load after hard constraints and built-in rubric', () => {
  const context = loadRuleContext({ routeKind: 'pr', homeRules, projectRules });
  assert.deepEqual(context.layers.map((layer) => layer.name), [
    'workflow-hard-constraints',
    'built-in-pr-rubric',
    'user-global-pr-rules',
    'project-local-pr-rules',
  ]);
});
```

Steps:
- [ ] red: Add assertions for PR categories: `correctness`, `regression`, `safety`, `tests`, `contracts`, `maintainability`, `platform`.
- [ ] red: Add assertions for CODE categories: `correctness`, `architecture`, `state-and-io`, `safety`, `tests`, `contracts`, `maintainability`, `platform`.
- [ ] red: Add rule loading tests for absent/empty files, user-global and project-local paths, project-local loaded last, symlink rejection, invalid paths, and hard-constraint conflict blocking/reporting.
- [ ] green: Add built-in rubrics and route-key loading support.
- [ ] green: Preserve document COMMON/SPEC/PLAN/DESIGN rule behavior.
- [ ] refactor: Keep hard constraints outside external rule override paths.

Verification:
Run `node --test test/rulebook.test.js test/shared-assets.test.js`.

Rollback / Safety:
Stop if external rules can weaken reviewer isolation, full re-review, redaction, state locality, or write safety.

### PLAN-TASK-008: Generate and install code routes for all platforms

Spec References:
- SPEC-FR-006: install code routes for Claude Code, Codex, and Gemini.
- SPEC-IF-006: generated platform entries and manifest ownership.
- SPEC-COMPAT-002: owned-only install/uninstall behavior.
- SPEC-FR-010, SPEC-SAFE-007: no platform-native `/review` delegation.
- SPEC-ACC-007, SPEC-ACC-015: Gemini advisory-only and no `/review` generated text.
- SPEC-PLAN-007: platform generation/install.

Goal:
Update generated command/skill/TOML outputs and manifest tests so six routes install safely, with Gemini advisory-only code route behavior.

Change Type: modify

TDD Applicable: yes

Files:
- Modify: `lib/generator.js`
- Modify: `lib/install.js`
- Modify: `lib/adapters/claude.js`
- Modify: `lib/adapters/codex.js`
- Modify: `lib/adapters/gemini.js`
- Modify: `templates/claude-command.md.tmpl`
- Modify: `templates/codex-skill.md.tmpl`
- Modify: `templates/gemini-command.toml.tmpl`
- Create: `skills/review-fix-pr/SKILL.md`
- Create: `skills/review-fix-code/SKILL.md`
- Modify: `test/shared-assets.test.js`
- Modify: `test/capability-check.test.js`
- Modify: `test/manifest-schema-v2.test.js`
- Modify: `test/pack-contents.test.js`

Skeleton:
```javascript
test('generated code routes do not delegate to platform review commands', () => {
  for (const output of generateAllPlatformRoutes()) {
    if (output.routeKind === 'pr' || output.routeKind === 'code') {
      assert.doesNotMatch(output.body, /\/review\b/);
    }
  }
});

test('Gemini code routes are advisory only', () => {
  const command = generateRoute({ platform: 'gemini', routeName: 'review-fix-code' });
  assert.match(command.body, /advisory-only/i);
  assert.doesNotMatch(command.body, /PASS/i);
});
```

Steps:
- [ ] red: Add generated output tests for all six routes on Claude, Codex, and Gemini.
- [ ] red: Add assertions that Claude/Codex generated entries describe automatic fix capability where supported, while Gemini code routes say advisory-only and direct automatic-fix requests to Claude Code/Codex.
- [ ] red: Add assertions that code route generated text does not call, wrap, or mention invoking platform-native `/review`.
- [ ] red: Add manifest install/uninstall tests for new route ownership and owned-only removal.
- [ ] green: Update generator/templates/platform adapters/skills to emit six route entries from descriptors.
- [ ] green: Update package contents checks so new skills/rubrics are included.
- [ ] refactor: Preserve existing document route installed paths and manifest ownership behavior.

Verification:
Run `node --test test/shared-assets.test.js test/capability-check.test.js test/manifest-schema-v2.test.js test/pack-contents.test.js` and `npm pack --dry-run`.

Rollback / Safety:
Stop if uninstall behavior would remove user-created rule files or unowned directories. Do not add any platform command that mutates remote state.

### PLAN-TASK-009: Integrate target contexts into workflow lifecycle

Spec References:
- SPEC-FR-007: review -> triage -> fix -> diff review -> full re-review -> repeat.
- SPEC-FR-009: read-only no writes/no fixes/no auto-fix state/no PASS.
- SPEC-STATE-001, SPEC-STATE-003, SPEC-STATE-004: target context persistence/no-state/stale resume.
- SPEC-ERR-005, SPEC-ERR-009: stale state and read-only automatic-fix loop refusal.
- SPEC-SAFE-004: reviewer subagents read-only.
- SPEC-OBS-001, SPEC-OBS-002, SPEC-OBS-003: concise/redacted/residual-risk output.
- SPEC-ACC-012: read-only acceptance.
- SPEC-EDGE-008: unavailable verification residual risk.
- SPEC-PLAN-008: workflow lifecycle.

Goal:
Wire document/PR/CODE target contexts into workflow start, persistent/no-state paths, reviewer context, fixer boundaries, diff review, full re-review, redaction, receipts, and finalization.

Change Type: modify

TDD Applicable: yes

Files:
- Modify: `lib/workflow/start.js`
- Modify: `lib/workflow/helpers.js`
- Modify: `lib/workflow/no-state.js`
- Modify: `lib/workflow/persistent-context.js`
- Modify: `lib/workflow/fix-lifecycle.js`
- Modify: `lib/workflow/diff-review.js`
- Modify: `lib/workflow/finalize.js`
- Modify: `lib/no-state.js`
- Modify: `lib/context-pack.js`
- Modify: `lib/final-response.js`
- Modify: `lib/redaction.js`
- Modify: `shared/core.md`
- Modify: `shared/prompts/coordinator.md`
- Modify: `shared/prompts/reviewer.md`
- Modify: `shared/prompts/fixer.md`
- Modify: `test/no-state-tokens.test.js`
- Modify: `test/finalize-resume.test.js`
- Modify: `test/workflow-e2e.test.js`
- Modify: `test/redaction.test.js`

Skeleton:
```javascript
test('read-only code route creates no automatic-fix state and claims no pass', async () => {
  const result = await runNoStateWorkflow({ routeName: 'review-fix-code', mode: 'read-only' });
  assert.equal(result.createdTargetState, false);
  assert.notEqual(result.status, 'pass');
  assert.match(result.status, /^read-only-/);
});

test('review-and-fix cannot pass without full re-review after a fix', async () => {
  const result = await runPersistentWorkflow({ skipFullReReviewAfterFix: true });
  assert.equal(result.status, 'blocked');
});
```

Steps:
- [ ] red: Add no-state read-only tests for document, PR, and CODE route kinds showing no `.docs-review-fix/targets/` auto-fix state and no workflow PASS claim.
- [ ] red: Add persistent workflow tests for route target context storage, stale resume refusal, reviewer write-blocking/fingerprint guard, diff review, and required full re-review before PASS.
- [ ] red: Add output tests for concise per-round status, final stop reason, redacted debug, no raw prompts/transcripts/logs/secrets/internal IDs, and residual risk when verification cannot run.
- [ ] green: Thread target context and `roundLimit` through persistent and no-state workflow payloads.
- [ ] green: Limit fixer file edits to target-related and recorded necessary dependency files.
- [ ] green: Preserve existing terminal statuses and final-response validation semantics.
- [ ] refactor: Keep document workflow behavior as a document target context path rather than a separate engine.

Verification:
Run `node --test test/no-state-tokens.test.js test/finalize-resume.test.js test/workflow-e2e.test.js test/redaction.test.js`.

Rollback / Safety:
Stop if workflow integration skips full re-review after fixes or allows reviewer writes. Do not claim PASS from read-only, Gemini advisory-only, diff-review-only, or unverified paths.

### PLAN-TASK-010: Update public documentation in both languages

Spec References:
- SPEC-FR-008: README coverage and aligned structure.
- SPEC-COMPAT-003: English and Simplified Chinese README alignment.
- SPEC-ACC-010: documentation acceptance.
- SPEC-PLAN-009: documentation update.

Goal:
Update `README.md` and `README.zh-CN.md` together so public route behavior, defaults, guards, rules, Gemini advisory-only limitation, and examples are aligned.

Change Type: modify

TDD Applicable: yes

Files:
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify/Create: `test/readme-content.test.js`
- Modify: `test/shared-assets.test.js`

Skeleton:
```javascript
test('README files cover code routes and rounds with aligned sections', () => {
  const en = fs.readFileSync('README.md', 'utf8');
  const zh = fs.readFileSync('README.zh-CN.md', 'utf8');
  for (const literal of ['review-fix-pr', 'review-fix-code', 'rounds=<n>', 'guard=git', 'guard=snapshot']) {
    assert.match(en, new RegExp(escapeRegExp(literal)));
    assert.match(zh, new RegExp(escapeRegExp(literal)));
  }
});
```

Steps:
- [ ] red: Add README assertions for `review-fix-pr`, `review-fix-code`, document route `rounds=<n>`, default `review-and-fix`, `read-only`, `guard=git`, `guard=snapshot`, PR/CODE rule paths, Gemini advisory-only, and common examples.
- [ ] red: Add section-alignment assertions or focused content parity checks for `README.md` and `README.zh-CN.md`.
- [ ] green: Update both READMEs in the same pass.
- [ ] green: Include examples for PR review, CODE root review, CODE scoped review, read-only, explicit snapshot guard, and rounds.
- [ ] refactor: Keep technical literals unchanged across languages.

Verification:
Run `node --test test/readme-content.test.js test/shared-assets.test.js` if a new README test file is added; otherwise include the README assertions in `test/shared-assets.test.js`.

Rollback / Safety:
Stop if documentation would describe behavior not implemented or verified by earlier tasks. Do not let Gemini examples imply automatic fixing or workflow PASS.

### PLAN-TASK-011: Run final verification matrix and package checks

Spec References:
- SPEC-PLAN-010: verification matrix.
- SPEC-PLAN-011: repaired SPEC findings coverage.
- SPEC-ACC-001 through SPEC-ACC-015: acceptance scenarios.
- SPEC-SAFE-006: no forbidden remote/destructive operations.
- SPEC-OBS-001 through SPEC-OBS-003: output behavior.

Goal:
Verify the completed implementation across the highest-risk route/platform/mode/guard/rounds/rule combinations and package contents.

Change Type: preserve

TDD Applicable: no

Files:
- Modify: none required unless final verification exposes a covered issue.

Skeleton:
```text
N/A - final verification task changes no product behavior; it runs the checks defined below.
```

Steps:
- [ ] Run targeted parser, target context, guard, rulebook, generated asset, workflow, README, and manifest tests.
- [ ] Run `npm test`.
- [ ] Run `npm pack --dry-run`.
- [ ] Run `node bin/drfx.js check`.
- [ ] Run install-generation smoke checks in a temporary home/workspace if existing tests do not already cover generated route files for all platforms.
- [ ] Inspect final diff for accidental remote mutation commands, destructive operations, raw prompt/log leakage, or platform-native `/review` delegation.

Verification:
Required commands:

```bash
npm test
npm pack --dry-run
node bin/drfx.js check
```

The final matrix must cover:

- PR route: missing base, invalid base, same current branch, no implicit fetch, default mode/guard, explicit snapshot guard.
- CODE route: root review, scoped review, `base` rejection, outside-root scope, excluded scopes, default mode/guard.
- Document routes: no-rounds compatibility, valid rounds, invalid rounds, `read-only rounds=<n>`.
- Platforms: Claude/Codex automatic-fix wording where supported; Gemini advisory-only code route wording.
- Rules: built-in PR/CODE categories, user-global/project-local load order, conflict handling.
- Guards/state: route-owned changes allowed, unrelated changes blocked, snapshot file set protected, stale resume refused, read-only no-state.

Rollback / Safety:
Do not commit, push, publish, create PRs, fetch remote refs, delete user files, or mutate remote state during verification. Stop and repair if a required check fails or if verification would require an unapproved external side effect.

## Verification Plan

| Check | Purpose | Command / Method | Expected Result | Covers |
|---|---|---|---|---|
| Route registry tests | Six route descriptors and document compatibility | `node --test test/routes.test.js` | All descriptors expose expected route facts. | SPEC-FR-001, SPEC-IF-001 |
| Parser/preflight tests | Grammar, defaults, usage-only invalid stops | `node --test test/input-parsing.test.js test/workflow-args.test.js` | Valid invocations normalize; invalid invocations produce usage without side effects. | SPEC-IF-002, SPEC-IF-003, SPEC-IF-004, SPEC-FR-009 |
| PR resolver tests | Local base/merge-base/no-fetch behavior | `node --test test/target-context.test.js` | PR context resolves or blocks with explicit reasons. | SPEC-FR-002, SPEC-ERR-002, SPEC-COMPAT-004 |
| CODE resolver tests | Scope containment and exclusions | `node --test test/code-scope.test.js test/target-context.test.js` | Safe scopes pass; unsafe/excluded scopes block. | SPEC-FR-003, SPEC-SAFE-005 |
| Rounds tests | Loop limit metadata and compatibility | `node --test test/workflow-state-v2.test.js test/workflow-e2e.test.js` | `roundLimit` works as max and no-rounds behavior is preserved. | SPEC-FR-004, SPEC-STATE-002 |
| Guard tests | File-set git/snapshot safety | `node --test test/fix-guard.test.js test/snapshot-guard.test.js` | Route-owned changes allowed; unrelated changes blocked; snapshot explicit. | SPEC-SAFE-001, SPEC-SAFE-002, SPEC-SAFE-003 |
| Rulebook tests | PR/CODE rubrics and rule order | `node --test test/rulebook.test.js` | Built-ins, paths, precedence, and conflicts match SPEC. | SPEC-FR-005, SPEC-IF-005 |
| Generation/install tests | Six route outputs and manifest ownership | `node --test test/shared-assets.test.js test/capability-check.test.js test/manifest-schema-v2.test.js test/pack-contents.test.js` | Claude/Codex/Gemini entries generated; manifest-owned uninstall remains safe. | SPEC-FR-006, SPEC-COMPAT-002 |
| Workflow lifecycle tests | full re-review, read-only no-state, redaction | `node --test test/no-state-tokens.test.js test/finalize-resume.test.js test/workflow-e2e.test.js test/redaction.test.js` | No invalid PASS; read-only no state; output bounded/redacted. | SPEC-FR-007, SPEC-STATE-004, SPEC-OBS-* |
| README tests | Public docs coverage and alignment | `node --test test/readme-content.test.js` or shared asset assertions | Both READMEs include required aligned content. | SPEC-FR-008, SPEC-COMPAT-003 |
| Full test suite | Regression coverage | `npm test` | All tests pass. | SPEC-PLAN-010 |
| Package dry run | Published contents include new assets | `npm pack --dry-run` | Package contains required files and no unexpected omissions. | SPEC-IF-006 |
| Capability check | Local command capability consistency | `node bin/drfx.js check` | Capability output matches platform policies. | SPEC-FR-006 |

## Rollback / Safety Plan

| Risky Area | Safety Constraint | Rollback Method | Stop Condition | Verification |
|---|---|---|---|---|
| Route registry migration | Existing document route names and behavior preserved. | Revert descriptor migration and restore prior constants. | Any document route invocation or generated output regresses unexpectedly. | Registry, input parsing, shared asset tests. |
| Parser/preflight | Invalid input must not read targets, create state, or start probes/fixes. | Revert parser dispatch changes. | Usage-only failure has side effects. | Parser tests with spies/fixtures. |
| PR resolver | No implicit `git fetch` or ref mutation. | Remove PR resolver wiring. | Any PR test requires network or ref mutation. | PR resolver fixture command log. |
| CODE resolver | No outside-root traversal or excluded directory review. | Remove CODE resolver wiring. | Scope normalization inspects outside root or excluded paths. | CODE scope tests. |
| File-set guards | Never overwrite unrelated local user changes. | Revert file-set guard integration. | Guard cannot distinguish route-owned from unrelated changes. | Guard tests. |
| Snapshot guard | Restore only monitored files and do not touch unmonitored files. | Revert snapshot file-set helper. | Snapshot restore would affect unmonitored paths. | Snapshot tests. |
| Rulebook | External rules cannot relax hard constraints. | Revert PR/CODE rule loading. | Hard-constraint conflict is accepted silently. | Rulebook conflict tests. |
| Platform generation/install | Manifest-owned uninstall only; no `/review` delegation. | Revert generated route additions and manifest updates. | Generated code route delegates to `/review` or uninstall targets unowned files. | Shared asset and manifest tests. |
| Workflow lifecycle | Coordinator-only PASS, reviewer read-only, full re-review after fixes. | Revert target-context workflow integration. | PASS can occur without full re-review or read-only creates auto-fix state. | Workflow lifecycle tests. |
| Documentation | Docs must describe implemented behavior only. | Revert README changes. | README claims unimplemented or unverified behavior. | README assertions and final review. |
| Final verification | No commit, push, publish, PR creation, remote mutation, implicit fetch, or user file deletion. | Stop and restore local implementation changes through normal code rollback only. | Verification requires an unapproved external or destructive action. | Command list review and test outputs. |

## Stop / Escalation Conditions

| Condition | Stop / Escalate | Responsible Stage | Required Action |
|---|---|---|---|
| A PLAN task discovers behavior required by acceptance but absent from SPEC v2. | Stop | SPEC | Mark `upstream_gap_detected` and repair SPEC before continuing implementation planning/execution. |
| A task needs a new runtime, large dependency, or external package to satisfy CODE traversal. | Escalate | User / DESIGN | Ask for explicit dependency approval or redesign around existing dependencies. |
| PR base resolution cannot be tested without network access. | Stop | PLAN / execution | Use local temporary git fixtures; do not fetch implicitly. |
| File-set guard cannot prove unrelated local changes are blocked. | Stop | PLAN-TASK-006 | Do not integrate automatic fixing until guard proof exists. |
| Workflow can PASS after only diff review or without full re-review. | Stop | PLAN-TASK-009 | Fix lifecycle before continuing. |
| Read-only path writes files or creates automatic-fix state. | Stop | PLAN-TASK-009 | Repair no-state/read-only behavior before docs/final verification. |
| Gemini generated text implies automatic fixing or workflow PASS for code routes. | Stop | PLAN-TASK-008 | Repair generated Gemini output before install checks. |
| Generated code routes call or wrap platform-native `/review`. | Stop | PLAN-TASK-008 | Remove delegation and use project workflow contract. |
| README files cannot remain structurally aligned without changing public behavior. | Stop | PLAN-TASK-010 | Route mismatch back to SPEC/docs decision. |
| Any required targeted check or `npm test` fails unexpectedly. | Stop | Relevant task | Fix the failing task or mark unresolved risk; do not claim completion. |

## Coverage Closure

| Upstream ID | Closure |
|---|---|
| SPEC-FR-001 | [ADDRESSED] PLAN-TASK-001. |
| SPEC-FR-002 | [ADDRESSED] PLAN-TASK-003. |
| SPEC-FR-003 | [ADDRESSED] PLAN-TASK-004. |
| SPEC-FR-004 | [ADDRESSED] PLAN-TASK-005. |
| SPEC-FR-005 | [ADDRESSED] PLAN-TASK-007. |
| SPEC-FR-006 | [ADDRESSED] PLAN-TASK-008. |
| SPEC-FR-007 | [ADDRESSED] PLAN-TASK-009. |
| SPEC-FR-008 | [ADDRESSED] PLAN-TASK-010. |
| SPEC-FR-009 | [ADDRESSED] PLAN-TASK-002 and PLAN-TASK-009. |
| SPEC-FR-010 | [ADDRESSED] PLAN-TASK-008. |
| SPEC-IF-001 | [ADDRESSED] PLAN-TASK-001. |
| SPEC-IF-002 | [ADDRESSED] PLAN-TASK-002. |
| SPEC-IF-003 | [ADDRESSED] PLAN-TASK-002 and PLAN-TASK-003. |
| SPEC-IF-004 | [ADDRESSED] PLAN-TASK-002 and PLAN-TASK-004. |
| SPEC-IF-005 | [ADDRESSED] PLAN-TASK-007. |
| SPEC-IF-006 | [ADDRESSED] PLAN-TASK-008. |
| SPEC-STATE-001 | [ADDRESSED] PLAN-TASK-003, PLAN-TASK-004, PLAN-TASK-009. |
| SPEC-STATE-002 | [ADDRESSED] PLAN-TASK-005. |
| SPEC-STATE-003 | [ADDRESSED] PLAN-TASK-003, PLAN-TASK-004, PLAN-TASK-009. |
| SPEC-STATE-004 | [ADDRESSED] PLAN-TASK-009. |
| SPEC-ERR-001 | [ADDRESSED] PLAN-TASK-002. |
| SPEC-ERR-002 | [ADDRESSED] PLAN-TASK-003. |
| SPEC-ERR-003 | [ADDRESSED] PLAN-TASK-004. |
| SPEC-ERR-004 | [ADDRESSED] PLAN-TASK-005. |
| SPEC-ERR-005 | [ADDRESSED] PLAN-TASK-003, PLAN-TASK-004, PLAN-TASK-009. |
| SPEC-ERR-006 | [ADDRESSED] PLAN-TASK-006. |
| SPEC-ERR-007 | [ADDRESSED] PLAN-TASK-006. |
| SPEC-ERR-008 | [ADDRESSED] PLAN-TASK-007. |
| SPEC-ERR-009 | [ADDRESSED] PLAN-TASK-009. |
| SPEC-SAFE-001 | [ADDRESSED] PLAN-TASK-006. |
| SPEC-SAFE-002 | [ADDRESSED] PLAN-TASK-006 and PLAN-TASK-009. |
| SPEC-SAFE-003 | [ADDRESSED] PLAN-TASK-006. |
| SPEC-SAFE-004 | [ADDRESSED] PLAN-TASK-009. |
| SPEC-SAFE-005 | [ADDRESSED] PLAN-TASK-004. |
| SPEC-SAFE-006 | [ADDRESSED] PLAN-TASK-003, PLAN-TASK-006, PLAN-TASK-008, PLAN-TASK-011. |
| SPEC-SAFE-007 | [ADDRESSED] PLAN-TASK-008. |
| SPEC-COMPAT-001 | [ADDRESSED] PLAN-TASK-005. |
| SPEC-COMPAT-002 | [ADDRESSED] PLAN-TASK-008. |
| SPEC-COMPAT-003 | [ADDRESSED] PLAN-TASK-010. |
| SPEC-COMPAT-004 | [ADDRESSED] PLAN-TASK-003. |
| SPEC-OBS-001 | [ADDRESSED] PLAN-TASK-009 and PLAN-TASK-011. |
| SPEC-OBS-002 | [ADDRESSED] PLAN-TASK-009. |
| SPEC-OBS-003 | [ADDRESSED] PLAN-TASK-009. |
| SPEC-ACC-001 | [ADDRESSED] PLAN-TASK-002. |
| SPEC-ACC-002 | [ADDRESSED] PLAN-TASK-003. |
| SPEC-ACC-003 | [ADDRESSED] PLAN-TASK-002 and PLAN-TASK-004. |
| SPEC-ACC-004 | [ADDRESSED] PLAN-TASK-004. |
| SPEC-ACC-005 | [ADDRESSED] PLAN-TASK-005. |
| SPEC-ACC-006 | [ADDRESSED] PLAN-TASK-005. |
| SPEC-ACC-007 | [ADDRESSED] PLAN-TASK-008. |
| SPEC-ACC-008 | [ADDRESSED] PLAN-TASK-006. |
| SPEC-ACC-009 | [ADDRESSED] PLAN-TASK-006. |
| SPEC-ACC-010 | [ADDRESSED] PLAN-TASK-010. |
| SPEC-ACC-011 | [ADDRESSED] PLAN-TASK-002. |
| SPEC-ACC-012 | [ADDRESSED] PLAN-TASK-009. |
| SPEC-ACC-013 | [ADDRESSED] PLAN-TASK-007. |
| SPEC-ACC-014 | [ADDRESSED] PLAN-TASK-004. |
| SPEC-ACC-015 | [ADDRESSED] PLAN-TASK-008. |
| SPEC-EDGE-001 | [ADDRESSED] PLAN-TASK-003. |
| SPEC-EDGE-002 | [ADDRESSED] PLAN-TASK-003 and PLAN-TASK-006. |
| SPEC-EDGE-003 | [ADDRESSED] PLAN-TASK-004. |
| SPEC-EDGE-004 | [ADDRESSED] PLAN-TASK-007. |
| SPEC-EDGE-005 | [ADDRESSED] PLAN-TASK-007. |
| SPEC-EDGE-006 | [ADDRESSED] PLAN-TASK-005. |
| SPEC-EDGE-007 | [ADDRESSED] PLAN-TASK-005. |
| SPEC-EDGE-008 | [ADDRESSED] PLAN-TASK-009. |
| SPEC-PLAN-001 | [ADDRESSED] PLAN-TASK-001. |
| SPEC-PLAN-002 | [ADDRESSED] PLAN-TASK-002 and PLAN-TASK-003. |
| SPEC-PLAN-003 | [ADDRESSED] PLAN-TASK-005. |
| SPEC-PLAN-004 | [ADDRESSED] PLAN-TASK-003 and PLAN-TASK-004. |
| SPEC-PLAN-005 | [ADDRESSED] PLAN-TASK-006. |
| SPEC-PLAN-006 | [ADDRESSED] PLAN-TASK-007. |
| SPEC-PLAN-007 | [ADDRESSED] PLAN-TASK-008. |
| SPEC-PLAN-008 | [ADDRESSED] PLAN-TASK-009. |
| SPEC-PLAN-009 | [ADDRESSED] PLAN-TASK-010. |
| SPEC-PLAN-010 | [ADDRESSED] PLAN-TASK-011. |
| SPEC-PLAN-011 | [ADDRESSED] PLAN-TASK-002, PLAN-TASK-004, PLAN-TASK-007, PLAN-TASK-008, PLAN-TASK-009, PLAN-TASK-011. |
| DES-PLAN-001 | [ADDRESSED] PLAN-TASK-001. |
| DES-PLAN-002 | [ADDRESSED] PLAN-TASK-002, PLAN-TASK-003, PLAN-TASK-004. |
| DES-PLAN-003 | [ADDRESSED] PLAN-TASK-005. |
| DES-PLAN-004 | [ADDRESSED] PLAN-TASK-003, PLAN-TASK-004, PLAN-TASK-009. |
| DES-PLAN-005 | [ADDRESSED] PLAN-TASK-006. |
| DES-PLAN-006 | [ADDRESSED] PLAN-TASK-007. |
| DES-PLAN-007 | [ADDRESSED] PLAN-TASK-008. |
| DES-PLAN-008 | [ADDRESSED] PLAN-TASK-009. |
| DES-PLAN-009 | [ADDRESSED] PLAN-TASK-010. |
| DES-PLAN-010 | [ADDRESSED] PLAN-TASK-011. |
| RISK-PLAN-001 | [ADDRESSED] PLAN-TASK-011. |
| RISK-PLAN-002 | [ADDRESSED] PLAN-TASK-002, PLAN-TASK-003. |
| RISK-PLAN-003 | [ADDRESSED] PLAN-TASK-002, PLAN-TASK-004. |
| RISK-PLAN-004 | [ADDRESSED] PLAN-TASK-005. |
| RISK-PLAN-005 | [ADDRESSED] PLAN-TASK-006, PLAN-TASK-009. |
| RISK-PLAN-006 | [ADDRESSED] PLAN-TASK-008. |
| RISK-PLAN-007 | [ADDRESSED] PLAN-TASK-008. |
| RISK-PLAN-008 | [ADDRESSED] PLAN-TASK-009. |
| RISK-PLAN-009 | [ADDRESSED] PLAN-TASK-007. |
| RISK-PLAN-010 | [ADDRESSED] PLAN-TASK-010. |

## PLAN Quality Gate

- Status: ready
- Upstream references are present and accessible.
- SPEC Checkpoint is approved.
- Every SPEC contract maps to a task, check, rollback/safety item, or explicit preserve item.
- Every PLAN task has at least one SPEC reference.
- No orphan PLAN tasks exist.
- TDD decomposition is present for all implementation tasks where TDD applies.
- Alternative verification is justified for the final verification-only task.
- Task granularity is independently executable and verifiable.
- Execution sequencing is explicit and dependency-aware.
- Verification Plan covers SPEC contracts and DESIGN Verification Strategy / Test Architecture.
- Rollback / Safety Plan covers file-set guard, manifest, workflow PASS, read-only, Gemini, and remote mutation risks.
- Stop / Escalation Conditions are explicit.
- Risk Discovery Plan Inputs trace through DESIGN Plan Inputs, SPEC-PLAN IDs, and PLAN task coverage.
- No upstream gap is being guessed into PLAN.
- Safe next node: PLAN Checkpoint.

## PLAN Checkpoint

- Status: ready for checkpoint decision
- Review Sources: approved Requirement Brief, Risk Discovery, DESIGN v2, SPEC v2, DESIGN subagent review, SPEC subagent review, PLAN workflow rules, and repository file inventory.
- Required Changes: none known.
- User Confirmations:
  - Execution Authorization: not part of this r2p workflow.
