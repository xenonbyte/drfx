---
r2p_stage: plan
r2p_version: 2
r2p_status: approved
r2p_created_at: 2026-06-02T18:53:29.555244+00:00
r2p_updated_at: 2026-06-03T12:30:00+00:00
---

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
3. Add target-context resolvers for PR and CODE, extend the persistent `MANIFEST.md` schema for file-set identity, then wire file-set state and guards around those contexts.
4. Unify the document-centric workflow dispatcher (`lib/workflow/index.js` and `lib/workflow/helpers.js` each carry their own `workflowBase`/`resolveTargetMetadata`) into one route-kind-aware resolver, then extend rulebooks, platform generation (template generalization is the dominant surface — see PLAN-TASK-008), and workflow lifecycle text without weakening existing document-route behavior.
5. Update docs and run the coverage matrix after targeted checks pass.

The plan is executor-neutral. It does not choose an agent runtime, prompt orchestration method, or platform-specific execution format.

## Contract-to-Task Mapping

| SPEC Contract | Source | Task / Check | Coverage Type | Closure Status | Resolution / Route |
|---|---|---|---|---|---|
| SPEC-FR-001, SPEC-IF-001 | Route descriptors | PLAN-TASK-001 | implementation + tests | [ADDRESSED] | Shared route registry and lookup tests. |
| SPEC-FR-002, SPEC-IF-003, SPEC-ERR-002, SPEC-COMPAT-004, SPEC-EDGE-001, SPEC-EDGE-002 | PR route | PLAN-TASK-003 | implementation + tests | [ADDRESSED] | PR resolver tests for base, current branch, merge-base, no fetch, rename/delete file sets. |
| SPEC-FR-003, SPEC-IF-004, SPEC-ERR-003, SPEC-SAFE-005, SPEC-EDGE-003 | CODE route | PLAN-TASK-004 | implementation + tests | [ADDRESSED] | CODE scope resolver tests for root, scope, exclusions, unsafe traversal. |
| SPEC-FR-004, SPEC-STATE-002, SPEC-ERR-004, SPEC-COMPAT-001, SPEC-EDGE-006, SPEC-EDGE-007 | rounds | PLAN-TASK-002, PLAN-TASK-005 | implementation + tests | [ADDRESSED] | `rounds` parsing/validation (SPEC-ERR-004) in PLAN-TASK-002; `roundLimit` state/loop in PLAN-TASK-005. |
| SPEC-FR-005, SPEC-IF-005, SPEC-ERR-008, SPEC-EDGE-004, SPEC-EDGE-005 | rulebook | PLAN-TASK-007 | implementation + tests | [ADDRESSED] | PR/CODE rubrics, load order, precedence, conflict tests. |
| SPEC-FR-006, SPEC-IF-006, SPEC-COMPAT-002 | platform generation/install | PLAN-TASK-008 | implementation + tests | [ADDRESSED] | Six route generated outputs and manifest-owned install/uninstall tests. |
| SPEC-FR-007, SPEC-SAFE-004 | workflow lifecycle | PLAN-TASK-009 | implementation + tests | [ADDRESSED] | Coordinator PASS, reviewer read-only, full re-review, write-blocking checks. |
| SPEC-FR-008, SPEC-COMPAT-003 | documentation | PLAN-TASK-010 | implementation + tests | [ADDRESSED] | Aligned README updates and documentation assertions. |
| SPEC-FR-009, SPEC-STATE-004, SPEC-ERR-009, SPEC-ACC-011, SPEC-ACC-012 | defaults and read-only | PLAN-TASK-002, PLAN-TASK-009 | implementation + tests | [ADDRESSED] | Default mode/guard parser tests and read-only no-state/no-PASS workflow tests. |
| SPEC-FR-010, SPEC-SAFE-007, SPEC-ACC-015 | no platform `/review` | PLAN-TASK-008 | implementation + tests | [ADDRESSED] | Generated route text assertions. |
| SPEC-STATE-001, SPEC-STATE-003, SPEC-ERR-005, SPEC-ACC-016, SPEC-ACC-017 | target context state | PLAN-TASK-002, PLAN-TASK-003, PLAN-TASK-004, PLAN-TASK-009 | implementation + tests | [ADDRESSED] | Route/base/scope/file-set identity, explicit `resume`, stale resume, and no-silent-resume tests. |
| SPEC-SAFE-001, SPEC-SAFE-002, SPEC-SAFE-003, SPEC-ERR-006, SPEC-ERR-007, SPEC-ACC-008, SPEC-ACC-009 | guards | PLAN-TASK-006 | implementation + tests | [ADDRESSED] | File-set git/snapshot guard tests. |
| SPEC-SAFE-006 | forbidden side effects | PLAN-TASK-003, PLAN-TASK-006, PLAN-TASK-008, PLAN-TASK-011 | safety + verification | [ADDRESSED] | No fetch/remote mutation/destructive operation checks. |
| SPEC-OBS-001, SPEC-OBS-002, SPEC-OBS-003, SPEC-EDGE-008 | observability | PLAN-TASK-009, PLAN-TASK-011 | implementation + verification | [ADDRESSED] | Concise output, redaction, residual-risk reporting tests. |
| SPEC-ACC-001 through SPEC-ACC-017 | acceptance scenarios | PLAN-TASK-002 through PLAN-TASK-011 | verification | [ADDRESSED] | Acceptance mapped to targeted tests and final matrix. |
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
| PLAN-TASK-002 | SPEC-IF-002, SPEC-IF-003, SPEC-IF-004, SPEC-ERR-004, SPEC-FR-009 | yes | red parser/default/rounds tests, green parser normalization, refactor dispatch | N/A |
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
- SPEC-ERR-004: invalid `rounds` value usage-only and `read-only rounds=<n>` unsupported (parser-level; owned here, not in PLAN-TASK-005).
- SPEC-FR-009: Default `review-and-fix`, default `guard=git`, explicit-only `guard=snapshot`.
- SPEC-ACC-001, SPEC-ACC-003, SPEC-ACC-005, SPEC-ACC-006, SPEC-ACC-011, SPEC-ACC-016, SPEC-ACC-017: parser/default/resume acceptance.
- SPEC-PLAN-002: Parser/preflight tests.

Goal:
Normalize all six route invocations before target reads or state creation, including defaults, route-specific tokens, invalid token usage-only stops, and read-only rounds handling.

Change Type: modify

TDD Applicable: yes

Files:
- Modify: `lib/input.js`
- Modify: `lib/workflow/index.js`
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

test('review-fix-code rejects base token (parser throws, no status object)', () => {
  // parseInvocation is throw-based (lib/input.js `fail()` throws a coded Error);
  // it never returns a { status: 'usage' } object. base= belongs to review-fix-pr.
  assert.throws(
    () => parseInvocation('review-fix-code', ['base=main']),
    (error) => typeof error.code === 'string' && /review-fix-pr/.test(error.message)
  );
});

// Usage-only OUTPUT and the no-side-effects guarantee (no target reads, no state)
// live at the workflow/CLI boundary, not on the pure parser return value:
// parseWorkflowArgs/runWorkflowCommand surface parser throws before reads/state, and
// the CLI top-level --json catch formats coded parser errors via formatWorkflowError.
// Assert them in test/workflow-args.test.js through parseWorkflowArgs/runWorkflowCommand
// and CLI --json cases, not on parseInvocation returning a status object.
```

Steps:
- [ ] red: Add document route tests for valid `rounds=<n>` (positive integers only), invalid `rounds` values (zero, negative, non-integer) producing usage-only stops, and no-rounds compatibility. PLAN-TASK-002 owns all `rounds=<n>` token parsing and value validation; PLAN-TASK-005 only consumes the parsed `roundLimit`.
- [ ] red: Add PR parser tests for missing base usage output, valid base token, invalid route tokens, default mode/guard, explicit `guard=snapshot`, and explicit `resume` token normalization without implicit resume.
- [ ] red: Add CODE parser tests for default root scope, repeated `scope=<path>`, invalid `base=<branch>`, invalid tokens, default mode/guard, explicit `guard=snapshot`, and explicit `resume` token normalization without implicit resume.
- [ ] red: Add `read-only rounds=<n>` tests for all route kinds showing unsupported loop semantics and no workflow start.
- [ ] red: Add `drfx workflow` arg tests (`test/workflow-args.test.js`) proving `parseWorkflowArgs`/`validateRuntimeArgs`/`validateNoStateArgs` accept PR `base=<branch>` and CODE `scope=<path>` invocations with optional explicit `resume`, and do not assume a single `target=<path>` token or infer resume from existing state.
- [ ] green: Implement route-kind parser dispatch and normalized invocation payloads.
- [ ] green: Parse and validate `rounds=<n>` in `lib/input.js` (positive integer; usage-only on invalid; `read-only rounds=<n>` unsupported), exposing the validated `roundLimit` on the normalized invocation for PLAN-TASK-005 to persist and enforce. Do not add a second rounds parser in PLAN-TASK-005.
- [ ] green: Define the internal workflow CLI token contract for code routes — PR subcommands carry `base=<branch>` and CODE subcommands carry optional `scope=<path>` in place of `target=<path>`; expose route kind and the route-specific target tokens to `lib/workflow/index.js`.
- [ ] green: Ensure usage-only failures return before target/reference/diff reads, state creation, reviewer probes, or fixes.
- [ ] refactor: Keep document parser compatibility visible through existing public parser helpers.

Verification:
Run `node --test test/input-parsing.test.js test/workflow-args.test.js test/workflow-json-baseline.test.js`. Confirm invalid cases do not create state or read targets.

Rollback / Safety:
Stop if parser changes make existing documented document-route invocations ambiguous. Do not add silent fallbacks for unknown tokens or invalid `rounds`. Stop if `lib/workflow/index.js` retains the single-`target=<path>` assumption on PR/CODE invocation paths. Keep `parseInvocation` throw-based; do not change it to return a `{ status }` object without a separate, explicitly-scoped parser-API-migration task.

### PLAN-TASK-003: Implement PR target resolver and PR state identity

Spec References:
- SPEC-FR-002: PR diff semantics.
- SPEC-IF-003: PR target context.
- SPEC-ERR-002: missing/unresolvable/same branch/no merge-base stops.
- SPEC-STATE-001, SPEC-STATE-003: target context and explicit stale resume identity.
- SPEC-SAFE-006: no fetch or remote mutation.
- SPEC-COMPAT-004: local refs/revisions only.
- SPEC-ACC-001, SPEC-ACC-002, SPEC-ACC-016, SPEC-ACC-017: PR acceptance and explicit resume behavior.
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
- Modify: `lib/workflow-state.js`
- Modify: `lib/target-state.js`
- Create/Modify: `test/target-context.test.js`
- Modify: `test/target-state.test.js`
- Modify: `test/workflow-state-v2.test.js`
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
- [ ] red: Add state identity tests showing PR state keys include route kind, base identity, merge-base/current HEAD or equivalent stale-detection fields, guard mode, `roundLimit`, and file-set identity, all of which must match on explicit `resume`; include explicit `resume` stale-refusal cases (any mismatch, including `roundLimit`) and matching-state-without-`resume` no-silent-resume behavior.
- [ ] green: Implement PR target resolver using local git commands only.
- [ ] green: Provide a PR state-identity helper — schema parse/format plus a stale-resume comparison over route kind, base, head, merge-base, guard, `roundLimit`, and file set — without creating live persistent PR state in the workflow. Live PR persistent-state creation and its consumer wiring are scoped to PLAN-TASK-009 (see Rollback / Safety), so this task ships the resolver, schema, and identity helpers as pure functions that are unit-tested in isolation.
- [ ] green: Extend the persistent `MANIFEST.md` schema (`formatManifestV2` and its `workflow-state.js` parse/serialize, plus the V1/V2 routing in `lib/target-state.js` `parseManifest`/`MANIFEST_FIELDS`) so file-set targets store route kind, base/merge-base/HEAD identity, and a file-set fingerprint instead of the single-file `target`/`initialContentSha256`/`fileSize` fields, keeping existing document manifests backward compatible.
- [ ] green: Confirm the schema consumers `lib/workflow/finalize.js`, `lib/workflow/fix-lifecycle.js`, and `lib/workflow/persistent-context.js` still read document manifests unchanged. Their file-set branching is scoped to PLAN-TASK-009, so this task must extend the schema without breaking those existing document-manifest reads (no file-set manifest may exist that these consumers cannot parse until PLAN-TASK-009 lands).
- [ ] refactor: Keep target-context shape usable by file-set guards and workflow prompts.

Verification:
Run `node --test test/target-context.test.js test/target-state.test.js test/workflow-state-v2.test.js test/workflow-e2e.test.js`. Confirm no command path performs `git fetch`, push, branch mutation, or remote update, and confirm the file-set `MANIFEST.md` schema extension remains backward compatible for existing document manifests.

Rollback / Safety:
Stop if resolving PR context requires network access or remote ref mutation. Roll back PR resolver wiring if state identity cannot reject stale PR contexts.

### PLAN-TASK-004: Implement CODE scope resolver and deterministic source discovery

Spec References:
- SPEC-FR-003: project root or `scope=<path>` CODE review.
- SPEC-IF-004: CODE grammar and default exclusions.
- SPEC-ERR-003: invalid base/scope stops.
- SPEC-SAFE-005: reject outside, symlink-unsafe, excluded, missing, unsafe scopes.
- SPEC-STATE-001, SPEC-STATE-003: CODE target identity and explicit stale resume.
- SPEC-ACC-003, SPEC-ACC-004, SPEC-ACC-014, SPEC-ACC-016, SPEC-ACC-017: CODE scope and explicit resume acceptance.
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
- Modify: `lib/workflow-state.js`
- Modify: `lib/target-state.js`
- Create/Modify: `test/target-context.test.js`
- Create/Modify: `test/code-scope.test.js`
- Modify: `test/target-state.test.js`
- Modify: `test/workflow-state-v2.test.js`

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
- [ ] red: Add CODE state identity tests covering normalized scopes, exclusions, file-set identity, guard mode, and `roundLimit` (all must match on explicit `resume`), explicit stale resume refusal on any mismatch including `roundLimit`, and matching-state-without-`resume` no-silent-resume behavior.
- [ ] green: Implement deterministic traversal and scope normalization without adding a new dependency.
- [ ] green: Provide a CODE state-identity helper (normalized scopes/exclusions, file-set fingerprint, guard, `roundLimit`, and stale-resume comparison) as pure functions, without wiring live persistent CODE state into workflow start/helper paths. Live CODE persistent-state creation is scoped to PLAN-TASK-009, matching the PR sequencing in PLAN-TASK-003.
- [ ] green: Reuse the file-set `MANIFEST.md` schema extension from PLAN-TASK-003 so CODE state stores normalized scopes/exclusions and a file-set fingerprint rather than single-file manifest fields.
- [ ] refactor: Keep exclusion constants owned by target-context or route descriptor code, not duplicated in prompts.

Verification:
Run `node --test test/code-scope.test.js test/target-context.test.js test/target-state.test.js test/workflow-state-v2.test.js`. Confirm no files outside project root are inspected or persisted in state, and confirm CODE file-set identity is covered by the shared manifest schema tests.

Rollback / Safety:
Stop if source discovery requires a new dependency with meaningful maintenance/licensing/security impact; request a new decision before adding it.

### PLAN-TASK-005: Add `rounds=<n>` loop limit metadata

Spec References:
- SPEC-FR-004: positive integer maximum rounds with early clean stop.
- SPEC-STATE-002: `roundLimit` separate from counters and receipt paths.
- SPEC-ERR-004: invalid rounds usage-only and `read-only rounds=<n>` unsupported (parser-level validation owned by PLAN-TASK-002; this task only consumes the validated `roundLimit`).
- SPEC-COMPAT-001: no-rounds document route behavior preserved.
- SPEC-EDGE-006, SPEC-EDGE-007: limit reached with remaining findings; early clean on round 2.
- SPEC-ACC-005, SPEC-ACC-006: rounds acceptance.
- SPEC-PLAN-003: rounds behavior.

Goal:
Consume the validated `roundLimit` parsed by PLAN-TASK-002 and make it durable workflow metadata for all routes without reusing `currentRound` or receipt directory names, enforcing it only as a maximum. This task does not parse or re-validate the `rounds=<n>` token.

Change Type: modify

TDD Applicable: yes

Files:
- Modify: `lib/workflow-state.js`
- Modify: `lib/workflow/fix-lifecycle.js`
- Modify: `lib/workflow/helpers.js`
- Modify: `lib/receipts.js`
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
- [ ] red: Add workflow tests for `rounds=1`, early clean before `rounds=5`, and no-rounds existing behavior (the `rounds=<n>` token parsing and value validation, plus the `read-only rounds=<n>` usage-only stop, are owned and tested by PLAN-TASK-002).
- [ ] red: Add state/receipt tests proving `roundLimit` is invocation/workflow metadata, not current round or receipt path data.
- [ ] green: Persist or carry `roundLimit` through workflow state/no-state payloads.
- [ ] green: Check the limit at loop boundaries after full re-review and before another fix cycle.
- [ ] refactor: Keep no-rounds behavior identical to current terminal conditions.

Verification:
Run `node --test test/workflow-state-v2.test.js test/workflow-e2e.test.js test/receipts.test.js`.

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
- [ ] red: Add file-set snapshot tests for monitored file fingerprints, missing files, symlink/outside paths, restore limited to monitored files, snapshot-unavailable cases, and newly recorded dependency files that must receive a snapshot/fingerprint baseline before their first write.
- [ ] red: Add compatibility tests proving existing document single-target guard behavior still passes.
- [ ] green: Implement file-set guard helpers and route-owned change tracking inputs, accepting an explicit allowed/monitored set that includes recorded necessary dependency files (the `{ path, reason, issueId }` records consumed by the fixer boundary in PLAN-TASK-009), not just the primary target. When the monitored set expands for a dependency file under `guard=snapshot`, capture or validate its snapshot/fingerprint baseline before any write; block if the baseline cannot be established or already differs unexpectedly.
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
- [ ] red: Assert that user-placed `~/.docs-review-fix/rules/PR.md`/`CODE.md` and project-local `.docs-review-fix/rules/PR.md`/`CODE.md` are accepted as recognized rule files (today `rulebook.js` warns/skips any `.md` not in `ALLOWED_RULE_FILE_SET = {COMMON,SPEC,PLAN,DESIGN}.md`), and that PR/CODE rule loading does NOT pull in `COMMON.md` (unlike document routes, whose sections are `['COMMON', documentType]`), matching the SPEC-IF-005 layer order with no COMMON layer.
- [ ] red: Assert `shared/rubrics/pr.md` and `shared/rubrics/code.md` encode the actionable-only triage boundary (pure style preferences, no-risk refactors, and over-abstraction are not blocking findings), and that `code.md` lists the CODE priority-scan surfaces (entry points, public API, CLI, config/schema, template generation, install/uninstall safety, state machine, persistence, test fixtures, cross-platform branches).
- [ ] green: Add built-in rubrics and route-kind loading support: extend `ALLOWED_RULE_FILENAMES`/`ALLOWED_RULE_FILE_SET` to recognize `PR.md`/`CODE.md`, and add a route-kind rule path that loads `[hard-constraints, built-in route rubric, user-global PR/CODE, project-local PR/CODE]` WITHOUT inheriting the document `['COMMON', documentType]` section logic (PR/CODE do not load `COMMON.md`). Keep `CANONICAL_SECTIONS` document-only so PR/CODE are not treated as document types.
- [ ] green: Author the `pr.md`/`code.md` rubric bodies covering their categories, the actionable-only boundary, and the CODE priority-scan surfaces.
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

Sizing note: Template generalization is the dominant effort in this plan, not a thin parameterization. The shared templates currently encode the entire runtime protocol (preflight, runtime probes, the persistent 13-step loop, and the no-state flow) plus the Invocation Gate and Route Contract in single-document `target=<path>` terms and document-only grammar (`ref=`, `strict|normal`, `assurance=`, `ledger=`, `{{DOCUMENT_TYPE}}`). DESIGN assumption DES-A-002 ("templates can be parameterized") must be treated as load-bearing work here, not a trivially non-blocking assumption.

Template strategy (pinned 2026-06-03): default to parameterizing the route-varying regions — invocation grammar, Route Contract, target-token syntax (`target=` vs `base=`/`scope=`), and per-platform assurance policy — via new generator-filled placeholders in the existing three templates **and the Codex `shared/runtime-flags.md` partial** (pulled in via `{{RUNTIME_FLAGS}}`, which today hardcodes `target=<path>` in its no-state commands and receives only `ROUTE_NAME`/`RUNTIME_PLATFORM` from `runtimeFlagsContent()`), while keeping the shared runtime protocol (preflight, probes, 13-step loop, no-state flow) as literal template text. This matches the existing `{{PLACEHOLDER}}` substitution engine and the single-source-of-route-facts goal of PLAN-TASK-001, and avoids duplicating ~200 lines of identical protocol per platform. Guard the route-varying template shell with the `test/fixtures/generated/` document-route golden snapshot after normalizing out the `{{EMBEDDED_SHARED_CONTENT}}` region (see Steps): if parameterization cannot keep that shell snapshot green (beyond the additive `rounds=<n>` token) with reasonable placeholder logic, fall back to a dedicated code-route template file per platform. Embedded shared content is allowed to change under PLAN-TASK-009 and is guarded there by shared-asset semantic assertions, not by the TASK-008 shell snapshot. Do not duplicate the runtime protocol pre-emptively.

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
- Modify: `shared/runtime-flags.md` (Codex `{{RUNTIME_FLAGS}}` partial; hardcodes `target=<path>` in no-state commands)
- Modify: `skills/review-fix-spec/SKILL.md`
- Modify: `skills/review-fix-plan/SKILL.md`
- Modify: `skills/review-fix-design/SKILL.md`
- Modify: `skills/review-fix-doc/SKILL.md`
- Create: `skills/review-fix-pr/SKILL.md`
- Create: `skills/review-fix-code/SKILL.md`
- Create: `test/fixtures/generated/` (golden snapshots of the current document-route generated template shell after masking the embedded shared-content region, per platform/route; fixture extension matches the platform artifact — `.md` for Claude/Codex, `.toml` for Gemini)
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
  assert.match(command.body, /review-and-fix[\s\S]{0,160}unsupported|unsupported[\s\S]{0,160}review-and-fix/i);
  assert.match(command.body, /workflow PASS[\s\S]{0,120}(?:unavailable|must not claim)|must not claim[\s\S]{0,120}workflow PASS/i);
  assert.doesNotMatch(command.body, /Pass:\s*<target>|workflow PASS\s+(?:is\s+)?(?:available|supported)|automatic fixes?\s+(?:available|supported|will run)/i);
});
```

Steps:
- [ ] red: Capture a golden snapshot of the current four document-route generated template shells per platform under `test/fixtures/generated/<platform>/<routeName>.<ext>` (`.md` for Claude/Codex, `.toml` for Gemini) after replacing the embedded shared-content region with a stable sentinel. The normalizer must strip only the `{{EMBEDDED_SHARED_CONTENT}}` expansion bounded by the platform markers (`## Embedded Shared Content` for Claude/Codex, `Embedded shared content:` for Gemini, plus the generated `<!-- shared/... -->` chunk markers) and must leave the rendered `{{RUNTIME_FLAGS}}` partial in the shell because that partial is route-varying for Codex no-state commands. Assert in `test/shared-assets.test.js` that regenerated document-route shells equal the snapshots byte-for-byte except for the additive `rounds=<n>` token. This baseline must exist before any template parameterization so template-shell drift fails loudly while legitimate PLAN-TASK-009 shared-text edits do not fail TASK-008.
- [ ] red: Add generated output tests for all six routes on Claude, Codex, and Gemini.
- [ ] red: Add assertions that Claude/Codex generated entries describe automatic fix capability where supported, while Gemini code routes say advisory-only and direct automatic-fix requests to Claude Code/Codex.
- [ ] red: Add Gemini code-route generated-output assertions that omitted mode follows the shared route default (`review-and-fix`) and is rendered as an unsupported/advisory-only request with guidance to Claude Code/Codex, rather than silently defaulting to `read-only`. These assertions must allow required negative safety wording such as "workflow PASS is unavailable" or "must not claim workflow PASS", and must reject positive PASS examples or automatic-fix-available claims.
- [ ] red: Add assertions that code route generated text does not call, wrap, or mention invoking platform-native `/review`.
- [ ] red: Add assertions that code-route generated text uses `base=<branch>` (PR) or optional `scope=<path>` (CODE) in every `drfx workflow` command instead of `target=<path>`, that the code-route invocation grammar includes optional explicit `resume`, and that it omits `ref=`, `strict|normal`, `assurance=`, and `ledger=`.
- [ ] red: Add assertions specifically for the Codex `{{RUNTIME_FLAGS}}` no-state commands rendered from `shared/runtime-flags.md` (`context`/`record-review`/`record-triage`/`finalize`) so PR/CODE routes emit `base=`/`scope=` and never `target=<path>` — the target token lives in `runtime-flags.md`, not the platform template, so template-only parameterization would miss it.
- [ ] red: Add assertions that all existing document-route generated entries and source skill files include `rounds=<n>` in Invocation Gate / usage text and pass the materialized `rounds` value through every relevant generated `drfx workflow` command while preserving omitted-rounds compatibility.
- [ ] red: Add assertions that Claude/Codex code-route entries internally materialize `practical` (or `strict-verified`) assurance for `review-and-fix` without exposing an `assurance=` token to the user, so code-route auto-fix is not rejected as `advisory-review-and-fix-unsupported`.
- [ ] red: Add assertions that code-route entries replace the document-only Route Contract text and `{{DOCUMENT_TYPE}}` content with route-kind-appropriate contract text.
- [ ] red: Add manifest install/uninstall tests for new route ownership and owned-only removal.
- [ ] green: Generalize the shared templates by route kind so the Invocation Gate, Route Contract, preflight, runtime probes, persistent 13-step loop, and no-state flow emit file-set target tokens (`base=`/`scope=`) for code routes while keeping the existing document route template shell stable except for the additive `rounds=<n>` token and its workflow propagation; embedded shared content may change only through PLAN-TASK-009 and remains covered by shared-asset semantic assertions.
- [ ] green: Add a route-kind target-token placeholder (e.g. `{{TARGET_TOKEN}}`) to `shared/runtime-flags.md` and pass it from `runtimeFlagsContent()` in `lib/generator.js` (today it injects only `ROUTE_NAME`/`RUNTIME_PLATFORM`), so the Codex no-state commands render `target=<path>` for document routes and `base=`/`scope=` for code routes.
- [ ] green: Inject the per-platform code-route assurance policy from route descriptors (Claude/Codex internal `practical`; Gemini advisory-only). For Gemini code routes, keep omitted mode as the shared default `review-and-fix` at the route-invocation layer, then render it as unsupported/advisory-only with guidance to Claude Code/Codex; do not reuse the existing Gemini document-route omitted-mode behavior that defaults to `read-only`.
- [ ] green: Update generator/platform adapters/source skills to emit six route entries from descriptors and refresh existing document source skills so installed-route guidance matches parser support for `rounds=<n>`.
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
- SPEC-ACC-016, SPEC-ACC-017: explicit resume stale-refusal and no-silent-resume acceptance.
- SPEC-EDGE-008: unavailable verification residual risk.
- SPEC-PLAN-008: workflow lifecycle.

Goal:
Wire document/PR/CODE target contexts into workflow start, persistent/no-state paths, reviewer context, fixer boundaries, diff review, full re-review, redaction, receipts, and finalization.

Change Type: modify

TDD Applicable: yes

Files:
- Modify: `lib/workflow/index.js`
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
- Modify: `shared/long-task.md`
- Modify: `shared/prompts/coordinator.md`
- Modify: `shared/prompts/reviewer.md`
- Modify: `shared/prompts/fixer.md`
- Modify: `test/shared-assets.test.js`
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

test('review-and-fix records minimum verification after every fix cycle', async () => {
  const result = await runPersistentWorkflow({ routeName: 'review-fix-code', fixCycles: 2 });
  assert.deepEqual(result.rounds.map((round) => round.verification.status), ['passed', 'passed']);
  assert.ok(result.rounds.every((round) => round.verification.command));
});
```

Steps:
- [ ] red: Add no-state read-only tests for document, PR, and CODE route kinds showing no `.docs-review-fix/targets/` auto-fix state and no workflow PASS claim.
- [ ] red: Add persistent workflow tests for route target context storage, explicit stale resume refusal, matching-state-without-`resume` no-silent-resume behavior, reviewer write-blocking/fingerprint guard, diff review, and required full re-review before PASS.
- [ ] red: Add persistent workflow tests proving each accepted fix cycle runs the minimum necessary verification before continuing to the next review or final PASS, records the verification command and result, and blocks or reports residual risk when verification fails or cannot run.
- [ ] red: Add output tests for concise per-round status, final stop reason, redacted debug, no raw prompts/transcripts/logs/secrets/internal IDs, and residual risk when verification cannot run.
- [ ] red: Add fixer-edit-boundary tests proving an edit to an unrecorded or out-of-root dependency file is blocked, while a properly recorded dependency file (declared `{ path, reason, issueId }`, validated in-root and non-excluded, present in the monitored file set) is allowed; assert the dependency record is what the file-set guard checks against. For `guard=snapshot`, assert a newly recorded dependency file is snapshotted/fingerprinted before its first write and blocks when the pre-write baseline cannot be established or already changed unexpectedly.
- [ ] red: Add shared-asset assertions that `shared/long-task.md` and generated PR/CODE route content describe route target contexts, file-set manifest identity, file-set lock/receipt/resume rules, and read-only no-state behavior without leaking document-only claims such as "target key is derived from the normalized target path relative to the document project root", document-only `Document type` manifest requirements, or single-file sha/size-only state.
- [ ] green: Make the duplicated `workflowBase`/`resolveTargetMetadata` in both `lib/workflow/index.js` and `lib/workflow/helpers.js` route-kind aware (or collapse them into one shared helper) so PR/CODE invocations resolve a file-set target context instead of calling `deriveTargetKey(projectRoot, parsed.invocation.target)` on an undefined single-file `target`. Cover the dispatch fallthrough, `unsupportedFrom`, `blockedFrom`, and advisory-downgrade paths in `index.js`.
- [ ] green: Replace the single-file `target=<path>` assumption in every persistent and no-state subcommand (`context`, `record-review`, `record-triage`, `begin-fix`, `refresh-lock`, `end-fix`, `abort-fix`, `record-diff-review`, `finalize`) with the file-set target context.
- [ ] green: Create and persist live PR/CODE file-set state here (and only here) — writing the file-set `MANIFEST.md` through the schema/identity helpers from PLAN-TASK-003/004 — at the same time `finalize.js`/`fix-lifecycle.js`/`persistent-context.js` become file-set-aware, so no file-set manifest is ever written before its consumers can parse it. This is the live-persistence step deferred out of PLAN-TASK-003/004. PR/CODE resume handling must require the explicit `resume` token; without it, matching state is not silently reused.
- [ ] green: Thread target context and `roundLimit` through persistent and no-state workflow payloads.
- [ ] green: Update `shared/long-task.md` so its target-state directory, manifest, lock, receipts, resume, stale-PASS, and continuity sections describe the generalized document/PR/CODE route target context while preserving existing document-route semantics as the document-specific case.
- [ ] green: Thread per-round verification records through fix reports, receipts, concise user output, and final-response validation so every automatic fix round includes the command or inspection method used, its result, and residual risk when no suitable verification can run.
- [ ] green: Limit fixer file edits to target-related files and recorded necessary dependency files. Each recorded dependency file must be declared with `{ path, reason, issueId }`, validated to be in-root and non-excluded, and added to the monitored file set so the file-set guard (PLAN-TASK-006) covers it before any write. For `guard=snapshot`, adding a dependency file to the monitored set must establish or validate a pre-write snapshot/fingerprint baseline first; the workflow blocks rather than taking a late baseline after mutation. No edit is permitted to a dependency file absent from this recorded, guarded set; today `buildFixerGuard` (`lib/workflow/helpers.js`) pins `expectedChangedFileSet` to a single `normalizedTarget`, so this step widens it to the recorded set rather than to an unbounded list.
- [ ] green: Preserve existing terminal statuses and final-response validation semantics.
- [ ] refactor: Keep document workflow behavior as a document target context path rather than a separate engine.

Verification:
Run `node --test test/no-state-tokens.test.js test/finalize-resume.test.js test/workflow-e2e.test.js test/redaction.test.js test/shared-assets.test.js`.

Rollback / Safety:
Stop if workflow integration skips full re-review after fixes or allows reviewer writes. Do not claim PASS from read-only, Gemini advisory-only, diff-review-only, or unverified paths. Stop if any PR/CODE path still calls `deriveTargetKey`/`computeFingerprint` against an undefined single-file `target`.

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
- [ ] red: Add README assertions for `review-fix-pr`, `review-fix-code`, document route `rounds=<n>`, PR/CODE explicit `resume`, default `review-and-fix`, `read-only`, `guard=git`, `guard=snapshot`, PR/CODE rule paths, Gemini advisory-only, and common examples.
- [ ] red: Add section-alignment assertions or focused content parity checks for `README.md` and `README.zh-CN.md`.
- [ ] green: Update both READMEs in the same pass.
- [ ] green: Include examples for PR review, CODE root review, CODE scoped review, read-only, explicit snapshot guard, rounds, and explicit PR/CODE resume.
- [ ] refactor: Keep technical literals unchanged across languages.

Verification:
Run `node --test test/readme-content.test.js test/shared-assets.test.js` if a new README test file is added; otherwise include the README assertions in `test/shared-assets.test.js`.

Rollback / Safety:
Stop if documentation would describe behavior not implemented or verified by earlier tasks. Do not let Gemini examples imply automatic fixing or workflow PASS.

### PLAN-TASK-011: Run final verification matrix and package checks

Spec References:
- SPEC-PLAN-010: verification matrix.
- SPEC-PLAN-011: repaired SPEC findings coverage.
- SPEC-ACC-001 through SPEC-ACC-017: acceptance scenarios.
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

- PR route: missing base, invalid base, same current branch, no implicit fetch, default mode/guard, explicit snapshot guard, explicit `resume`, stale resume refusal, and no silent resume without `resume`.
- CODE route: root review, scoped review, `base` rejection, outside-root scope, excluded scopes, default mode/guard, explicit `resume`, stale resume refusal, and no silent resume without `resume`.
- Document routes: no-rounds compatibility, valid rounds, invalid rounds, `read-only rounds=<n>`.
- Platforms: Claude/Codex automatic-fix wording where supported; Gemini advisory-only code route wording, including omitted-mode unsupported `review-and-fix` guidance and no positive workflow PASS/automatic-fix claims.
- Rules: built-in PR/CODE categories, user-global/project-local load order, conflict handling.
- Guards/state: route-owned changes allowed, unrelated changes blocked, snapshot file set protected including pre-write baselines for newly recorded dependency files, stale resume refused, matching persistent state not silently resumed without `resume`, read-only no-state.
- Verification loop: each automatic fix round records the minimum necessary verification command or inspection method, result, and residual risk when verification cannot run before continuing or claiming PASS.

Rollback / Safety:
Do not commit, push, publish, create PRs, fetch remote refs, delete user files, or mutate remote state during verification. Stop and repair if a required check fails or if verification would require an unapproved external side effect.

## Verification Plan

| Check | Purpose | Command / Method | Expected Result | Covers |
|---|---|---|---|---|
| Route registry tests | Six route descriptors and document compatibility | `node --test test/routes.test.js` | All descriptors expose expected route facts. | SPEC-FR-001, SPEC-IF-001 |
| Parser/preflight tests | Grammar, defaults, explicit `resume`, usage-only invalid stops | `node --test test/input-parsing.test.js test/workflow-args.test.js` | Valid invocations normalize; explicit PR/CODE `resume` is accepted; invalid invocations produce usage without side effects; resume is not inferred from existing state. | SPEC-IF-002, SPEC-IF-003, SPEC-IF-004, SPEC-FR-009 |
| PR resolver tests | Local base/merge-base/no-fetch behavior and PR file-set identity schema | `node --test test/target-context.test.js test/target-state.test.js test/workflow-state-v2.test.js` | PR context resolves or blocks with explicit reasons; PR file-set manifest identity serializes/parses without breaking document manifests; explicit stale resume is refused. | SPEC-FR-002, SPEC-ERR-002, SPEC-COMPAT-004 |
| CODE resolver tests | Scope containment, exclusions, and CODE file-set identity schema | `node --test test/code-scope.test.js test/target-context.test.js test/target-state.test.js test/workflow-state-v2.test.js` | Safe scopes pass; unsafe/excluded scopes block; CODE file-set manifest identity serializes/parses without breaking document manifests; explicit stale resume is refused. | SPEC-FR-003, SPEC-SAFE-005 |
| Rounds tests | Loop limit metadata and compatibility | `node --test test/workflow-state-v2.test.js test/workflow-e2e.test.js` | `roundLimit` works as max and no-rounds behavior is preserved. | SPEC-FR-004, SPEC-STATE-002 |
| Guard tests | File-set git/snapshot safety | `node --test test/fix-guard.test.js test/snapshot-guard.test.js` | Route-owned changes allowed; unrelated changes blocked; snapshot explicit. | SPEC-SAFE-001, SPEC-SAFE-002, SPEC-SAFE-003 |
| Rulebook tests | PR/CODE rubrics and rule order | `node --test test/rulebook.test.js` | Built-ins, paths, precedence, and conflicts match SPEC. | SPEC-FR-005, SPEC-IF-005 |
| Generation/install tests | Six route outputs, document rounds text, Gemini code-route unsupported default semantics, byte-stable document template shell, and manifest ownership | `node --test test/shared-assets.test.js test/capability-check.test.js test/manifest-schema-v2.test.js test/pack-contents.test.js` | Claude/Codex/Gemini entries generated; document route outputs/source skills expose and propagate `rounds=<n>`; Gemini code routes treat omitted mode as unsupported `review-and-fix` rather than silent `read-only`, include negative "workflow PASS unavailable / must not claim" safety text, and avoid positive PASS or automatic-fix-available claims; document-route output matches the `test/fixtures/generated/` shell snapshot after masking the embedded shared-content region and excepting the additive `rounds=<n>` token; manifest-owned uninstall remains safe. | SPEC-FR-006, SPEC-COMPAT-001, SPEC-COMPAT-002 |
| Workflow lifecycle tests | full re-review, per-round verification, read-only no-state, explicit resume/no-silent-resume, redaction, long-task shared wording | `node --test test/no-state-tokens.test.js test/finalize-resume.test.js test/workflow-e2e.test.js test/redaction.test.js test/shared-assets.test.js` | No invalid PASS; every fix cycle records verification command/result or residual risk; read-only no state; explicit stale resume is refused; matching state is not silently resumed without `resume`; output bounded/redacted; `shared/long-task.md` and generated PR/CODE route content no longer leak document-only target-state/resume claims. | SPEC-FR-007, SPEC-STATE-004, SPEC-OBS-* |
| README tests | Public docs coverage and alignment | `node --test test/readme-content.test.js` or shared asset assertions | Both READMEs include required aligned content including PR/CODE explicit `resume`. | SPEC-FR-008, SPEC-COMPAT-003 |
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
| Snapshot guard | Restore only monitored files and do not touch unmonitored files; newly recorded dependency files must be snapshotted/fingerprinted before first write. | Revert snapshot file-set helper. | Snapshot restore would affect unmonitored paths, or dependency-file baseline is established only after mutation. | Snapshot tests. |
| Rulebook | External rules cannot relax hard constraints. | Revert PR/CODE rule loading. | Hard-constraint conflict is accepted silently. | Rulebook conflict tests. |
| Platform generation/install | Manifest-owned uninstall only; no `/review` delegation; Gemini code routes keep unsupported `review-and-fix` default semantics without positive PASS/auto-fix claims. | Revert generated route additions and manifest updates. | Generated code route delegates to `/review`, uninstall targets unowned files, Gemini code routes silently default omitted mode to `read-only`, or Gemini generated text includes positive workflow PASS/automatic-fix-available claims. | Shared asset and manifest tests. |
| Workflow lifecycle | Coordinator-only PASS, reviewer read-only, full re-review after fixes. | Revert target-context workflow integration. | PASS can occur without full re-review or read-only creates auto-fix state. | Workflow lifecycle tests. |
| Workflow dispatcher (`index.js`/`helpers.js`) | Document and code routes share one route-kind-aware target resolver. | Revert dispatcher unification and restore the document-only resolver. | A PR/CODE path resolves an undefined single-file target. | Workflow lifecycle and target-context tests. |
| Shared long-task protocol | Generated route content must not describe PR/CODE state as a single document target. | Revert `shared/long-task.md` edits together with file-set workflow integration. | `shared/long-task.md` or generated PR/CODE content still claims document-root target-key derivation, document-only manifest fields, or single-file sha/size-only identity for code routes. | Shared asset and workflow lifecycle tests. |
| Template generalization | Document generated template shell stays byte-stable except for the additive `rounds=<n>` token, enforced by the `test/fixtures/generated/` shell snapshot after masking embedded shared content, while code routes gain file-set output. | Revert template parameterization to the document-only templates. | Document route template shell regresses beyond the additive `rounds=<n>` token, or code routes emit `target=<path>`/document-only grammar. | Golden snapshot, generated asset/shared asset tests, and `npm pack --dry-run`. |
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
| Gemini code-route generated text silently defaults omitted mode to `read-only`, lacks unsupported `review-and-fix` guidance for omitted mode, omits required negative workflow PASS safety wording, or implies positive automatic fixing/workflow PASS. | Stop | PLAN-TASK-008 | Repair generated Gemini output before install checks. |
| Generated code routes call or wrap platform-native `/review`. | Stop | PLAN-TASK-008 | Remove delegation and use project workflow contract. |
| Parameterizing the existing templates cannot keep the document-route template-shell golden snapshot green (after masking embedded shared content and beyond the additive `rounds=<n>` token) while adding file-set output. | Stop | PLAN-TASK-008 | Fall back to the pinned alternative — a dedicated code-route template file per platform — before emitting partial generation; do not relax or delete the shell snapshot, and do not expand it to cover PLAN-TASK-009 shared semantic edits. |
| A PR/CODE invocation reaches `workflowBase`/`resolveTargetMetadata` with an undefined single-file `target`. | Stop | PLAN-TASK-009 | Unify the `index.js`/`helpers.js` dispatcher to be route-kind aware before continuing integration. |
| `shared/long-task.md` or generated code-route content still uses document-only target-state/resume wording for PR/CODE routes. | Stop | PLAN-TASK-009 | Update the shared long-task protocol and generated-content assertions before docs/final verification. |
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
| SPEC-ERR-004 | [ADDRESSED] PLAN-TASK-002 (parser validation) and PLAN-TASK-005 (loop metadata). |
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
| SPEC-ACC-005 | [ADDRESSED] PLAN-TASK-002 and PLAN-TASK-005. |
| SPEC-ACC-006 | [ADDRESSED] PLAN-TASK-002 and PLAN-TASK-005. |
| SPEC-ACC-007 | [ADDRESSED] PLAN-TASK-008. |
| SPEC-ACC-008 | [ADDRESSED] PLAN-TASK-006. |
| SPEC-ACC-009 | [ADDRESSED] PLAN-TASK-006. |
| SPEC-ACC-010 | [ADDRESSED] PLAN-TASK-010. |
| SPEC-ACC-011 | [ADDRESSED] PLAN-TASK-002. |
| SPEC-ACC-012 | [ADDRESSED] PLAN-TASK-009. |
| SPEC-ACC-013 | [ADDRESSED] PLAN-TASK-007. |
| SPEC-ACC-014 | [ADDRESSED] PLAN-TASK-004. |
| SPEC-ACC-015 | [ADDRESSED] PLAN-TASK-008. |
| SPEC-ACC-016 | [ADDRESSED] PLAN-TASK-002, PLAN-TASK-003, PLAN-TASK-004, and PLAN-TASK-009. |
| SPEC-ACC-017 | [ADDRESSED] PLAN-TASK-002, PLAN-TASK-003, PLAN-TASK-004, and PLAN-TASK-009. |
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
- The runtime dispatcher (`lib/workflow/index.js`), the persistent `MANIFEST.md` file-set schema, and route-kind template generalization are explicitly scoped in PLAN-TASK-002, PLAN-TASK-003/004, PLAN-TASK-008, and PLAN-TASK-009.
- The byte-stable document template-shell invariant is reconciled with the additive `rounds=<n>` token and with PLAN-TASK-009 shared-text edits by masking the embedded shared-content region in the executable `test/fixtures/generated/` golden snapshot; the template strategy is pinned (parameterization first, dedicated code-route template as fallback) rather than deferred to execution time.
- The shared long-task protocol (`shared/long-task.md`) is explicitly scoped in PLAN-TASK-009 so generated PR/CODE route content cannot retain document-only target-state, manifest, lock, receipt, or resume claims.
- Gemini code-route generation is explicitly guarded so omitted mode stays the shared `review-and-fix` default but renders as unsupported/advisory-only with guidance, and so required negative workflow PASS wording is not rejected by an over-broad `/PASS/i` test.
- Safe next node: PLAN Checkpoint.

## PLAN Checkpoint

- Status: ready for checkpoint decision
- Review Sources: approved Requirement Brief, Risk Discovery, DESIGN v2, SPEC v2, DESIGN subagent review, SPEC subagent review, PLAN workflow rules, and repository file inventory.
- Required Changes: none known.
- Post-approval revision (2026-06-03): applied implementation-completeness refinements after a plan-vs-requirement validation pass. (F1) Added `lib/workflow/index.js` to PLAN-TASK-002/009 and required unifying the duplicated `workflowBase`/`resolveTargetMetadata` into one route-kind-aware resolver. (F2) Sized route-kind template generalization as the dominant effort in PLAN-TASK-008 with explicit file-set command-arg, grammar, contract, and per-platform assurance-injection steps. (F3) Pinned the internal `drfx workflow` token contract (`base=`/`scope=` replacing `target=<path>`) in PLAN-TASK-002 and across all subcommands in PLAN-TASK-009. (F4) Made the persistent `MANIFEST.md` file-set schema extension explicit in PLAN-TASK-003/004. (F5) Pinned the actionable-only triage boundary and CODE priority-scan surfaces to rubric assertions in PLAN-TASK-007. No SPEC contract, requirement scope, or task numbering changed.
- Post-approval revision 2 (2026-06-03): plan-vs-code consistency fixes after verifying claims against the repository. (F6 SUPERSEDED by F17) Initially reconciled the "byte-stable" invariant with the additive `rounds=<n>` token; revision 5 narrows the invariant from whole generated output to the generated template shell with embedded shared content masked. (F7 SUPERSEDED by F17) Initially added a `test/fixtures/generated/` document-output golden snapshot as the executable guard; revision 5 scopes that snapshot to the normalized template shell because PLAN-TASK-009 may intentionally edit embedded shared content. (F8) Pinned the template strategy: parameterize route-varying regions via generator-filled placeholders in the existing templates, golden-snapshot-guarded, with a dedicated per-platform code-route template as the named fallback — replacing the prior execution-time "escalate" deferral. (F9) Named the `MANIFEST.md` schema consumers (`finalize.js`, `fix-lifecycle.js`, `persistent-context.js`) and the `target-state.js` V1/V2 routing in PLAN-TASK-003 so the schema/consumer coupling across PLAN-TASK-003 and PLAN-TASK-009 is explicit. No SPEC contract, requirement scope, or task numbering changed.
- Post-approval revision 3 (2026-06-03): second plan-vs-code pass closed three correctness gaps and two strengthening items. (F10) PLAN-TASK-008 now includes `shared/runtime-flags.md` — the Codex `{{RUNTIME_FLAGS}}` partial hardcodes `target=<path>` in its no-state commands and `runtimeFlagsContent()` passes only `ROUTE_NAME`/`RUNTIME_PLATFORM`, so a route-kind `{{TARGET_TOKEN}}` placeholder plus a Codex no-state assertion were added; template-only parameterization would otherwise leak `target=<path>` into Codex code routes. (F11) Resolved the PLAN-TASK-003/004 vs PLAN-TASK-009 sequencing conflict: TASK-003/004 now ship resolver + schema + identity helpers as pure, unit-tested functions, and live PR/CODE persistent-state creation (writing the file-set `MANIFEST.md`) moved into TASK-009 where the consumers become file-set-aware in the same task, so no unparsable manifest is ever written. (F12) Corrected PLAN-TASK-002's skeleton to the throw-based parser contract (`parseInvocation` throws a coded Error via `lib/input.js` `fail()`; it does not return `{ status: 'usage' }`); usage-only output and no-side-effects assertions were relocated to the workflow preflight layer (`test/workflow-args.test.js`), and a Rollback note forbids a silent parser-API migration. (F13) Defined the fixer dependency-file schema (`{ path, reason, issueId }`, in-root/non-excluded validation, membership in the monitored set) in PLAN-TASK-006/009, widening `buildFixerGuard`'s single-`normalizedTarget` `expectedChangedFileSet` to the recorded, guarded set. (F14) Fixed the golden-snapshot fixture extension to match each platform artifact (`.md` for Claude/Codex, `.toml` for Gemini) instead of a misleading `.md` for all. No SPEC contract, requirement scope, or task numbering changed.
- Post-approval revision 4 (2026-06-03): fixed the follow-up plan review findings. (F15) Added `shared/long-task.md` to PLAN-TASK-009 files, steps, verification, rollback, stop conditions, and quality-gate wording because Codex skill generation copies/embeds it and the current file contains document-only target-state, manifest, lock, receipt, and resume language that would otherwise leak into PR/CODE generated content. (F16) Corrected PLAN-TASK-002's parser error-handling note: `parseInvocation` remains throw-based, `parseWorkflowArgs`/`runWorkflowCommand` surface parser throws before reads/state, and CLI `--json` error formatting happens in `bin/drfx.js` via `formatWorkflowError`, not in `lib/workflow/index.js` catching parser throws. No SPEC contract, requirement scope, or task numbering changed.
- Post-approval revision 5 (2026-06-03): fixed the golden-snapshot/shared-content conflict. (F17) Narrowed PLAN-TASK-008's byte-stable golden snapshot from the whole generated document-route body to the generated template shell with the `{{EMBEDDED_SHARED_CONTENT}}` expansion masked out, while leaving rendered `{{RUNTIME_FLAGS}}` in scope. This keeps F7 focused on template parameterization drift and lets PLAN-TASK-009 intentionally edit `shared/core.md`, `shared/long-task.md`, and shared prompts under separate semantic shared-asset assertions. No SPEC contract, requirement scope, or task numbering changed.
- Post-approval revision 6 (2026-06-03): third plan-vs-code pass fixed two task-boundary defects. (F18) De-duplicated `rounds=<n>` parsing ownership: PLAN-TASK-002 now owns all `rounds=<n>` token parsing and value validation (positive-integer, usage-only, `read-only rounds=<n>` unsupported), so `lib/input.js` and `test/input-parsing.test.js` were removed from PLAN-TASK-005's files and its parser red step dropped — PLAN-TASK-005 had a parser red test with no parser green step and shared `lib/input.js` with PLAN-TASK-002, risking double implementation. SPEC-ERR-004 traceability was repointed to PLAN-TASK-002 (parser) plus PLAN-TASK-005 (loop metadata) in the Contract-to-Task mapping, TDD decomposition, TASK-002/005 spec references, and Coverage Closure. (F19) Made PLAN-TASK-007 name the structural rulebook work: extend `ALLOWED_RULE_FILENAMES`/`ALLOWED_RULE_FILE_SET` to recognize `PR.md`/`CODE.md` (otherwise `rulebook.js` warns/skips them as unknown rule files) and add a route-kind loading path that does not inherit the document `['COMMON', documentType]` section logic, since SPEC-IF-005 PR/CODE order has no COMMON layer. No SPEC contract, requirement scope, or task numbering changed.
- Post-approval revision 7 (2026-06-03): fixed the follow-up PLAN review findings. (F20) Replaced the over-broad Gemini `assert.doesNotMatch(command.body, /PASS/i)` skeleton with assertions that require negative workflow PASS safety wording and reject only positive PASS/automatic-fix claims. (F21) Added TASK-008 red/green coverage that Gemini code routes must treat omitted mode as the shared `review-and-fix` default and render it as unsupported/advisory-only with guidance to Claude Code/Codex, rather than silently defaulting to `read-only`. (F22) Added `test/workflow-state-v2.test.js` to TASK-003 and TASK-004 verification plus the global PR/CODE resolver verification rows so manifest schema changes are exercised where they are introduced. No SPEC contract, requirement scope, or task numbering changed.
- Post-approval revision 8 (2026-06-03): fixed the latest PLAN review findings. (F23) Added explicit `guard=snapshot` pre-write baseline requirements and tests for newly recorded dependency files in PLAN-TASK-006, PLAN-TASK-009, the final verification matrix, and rollback/safety plan so snapshot/fingerprint baselines cannot be established only after mutation. (F24) Corrected Coverage Closure for `SPEC-ACC-005` and `SPEC-ACC-006` to point to both PLAN-TASK-002 parser/usage validation and PLAN-TASK-005 loop metadata. No SPEC contract, requirement scope, or task numbering changed.
- Post-approval revision 9 (2026-06-03): resolved the PR/CODE resume open question by updating requirement/SPEC/PLAN to make code-route `resume` an explicit token, not an inferred continuation. (F25) Added SPEC coverage for explicit PR/CODE `resume`, stale resume refusal, and no silent resume without `resume` (`SPEC-ACC-016`/`SPEC-ACC-017`). (F26) Mapped the new resume contracts into PLAN-TASK-002 parser/arg tests, PLAN-TASK-003/004 target identity helpers, PLAN-TASK-008 generated grammar assertions, PLAN-TASK-009 workflow lifecycle tests, PLAN-TASK-010 README assertions, the final verification matrix, and Coverage Closure.
- Post-approval revision 10 (2026-06-03): fixed cross-artifact resume traceability and wording. (F27) Re-cited `SPEC-ACC-016`/`SPEC-ACC-017` and the SPEC Traceability table from "Requirement Brief resume acceptance" (the Requirement Brief carries no resume content) to `DES-SPEC-004`, the actual DESIGN grounding for PR/CODE resume, consistent with the sibling `SPEC-IF-003`/`SPEC-IF-004`/`SPEC-STATE-003`/`SPEC-ERR-005` citations. (F28) Synced the canonical Raw Requirement (`00-raw-requirement.md`) with the explicit PR/CODE `resume` token, grammar, and no-silent-reuse clauses already added to `docs/REQUIREMENT-code-review-routes-2026-06-03.md`, removing the divergence between the two requirement copies. (F29) Aligned `roundLimit` resume wording to strict match across `SPEC-STATE-003` and PLAN-TASK-003/004 identity tests (was the undefined "compatibility"), consistent with `SPEC-ACC-016` and the requirement's "不匹配时必须拒绝". This revision changed the SPEC traceability citations and the Raw Requirement copy to remove inconsistencies; no SPEC contract behavior, requirement scope, or task numbering changed.
- User Confirmations:
  - Execution Authorization: not part of this r2p workflow.
