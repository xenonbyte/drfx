# DESIGN: code review routes

## Upstream References

| Artifact | Reference | Status |
|---|---|---|
| Raw Requirement | `.req-to-plan/WF-20260603-code-review-routes-2026-06/00-raw-requirement.md` | available |
| Requirement Brief | `.req-to-plan/WF-20260603-code-review-routes-2026-06/03-requirement-brief.md` | approved |
| Risk & Question Discovery | `.req-to-plan/WF-20260603-code-review-routes-2026-06/04-risk-discovery.md` | approved |

## Design Entry Gate

- Status: pass
- Requirement Brief Checkpoint: approved
- Risk Discovery Checkpoint: approved
- Missing / Invalid Inputs: none
- Failure Routing: N/A
- Safe next step: Design Scope Gate

## Design Scope Gate

- Design Levels: `standard_design`, `architecture_design`, `migration_design`, `safety_design`, `dependency_design`
- Required Design Topics: route registry, invocation parsing, target context, PR diff target discovery, code scope discovery, file-set guard/snapshot behavior, persistent/no-state state keys, rulebook extension, platform generation, `rounds=<n>` loop control, documentation and verification boundaries.
- Source Triggers: locked tier modifiers `migration`, `cross_project`, `dependency`, `safety`, `scope_expanding`; Risk Discovery triggers `RISK-DES-001` through `RISK-DES-008`.
- Trigger-to-Level Mapping:
  - `RISK-DES-001` -> `architecture_design`, `safety_design`
  - `RISK-DES-002` -> `architecture_design`, `dependency_design`
  - `RISK-DES-003` -> `architecture_design`, `safety_design`
  - `RISK-DES-004` -> `safety_design`
  - `RISK-DES-005` -> `architecture_design`, `safety_design`
  - `RISK-DES-006` -> `dependency_design`
  - `RISK-DES-007` -> `architecture_design`, `safety_design`
  - `RISK-DES-008` -> `standard_design`
- Safe next step: Design Discovery and Option Analysis

## Inputs

The design must add two route families:

- Document routes: existing `review-fix-spec`, `review-fix-plan`, `review-fix-design`, `review-fix-doc`; they keep document target semantics and gain `rounds=<n>`.
- Code routes: new `review-fix-pr` and `review-fix-code`; they use file-set target semantics and PR/code-specific invocation contracts.

The existing codebase has a small central route registry in `lib/generator.js`, document-only invocation parsing in `lib/input.js`, document target state in `lib/workflow/start.js` and `lib/workflow/helpers.js`, custom document rule loading in `lib/rulebook.js`, and single-target git/snapshot guards in `lib/fix-guard.js` and `lib/snapshot-guard.js`.

## Problem

The existing workflow is intentionally single-document oriented: one target file, optional reference files, document type, target-local state key, single-target fingerprint guard, and document rubric selection. The new routes require the same coordinator/reviewer/fixer/re-review safety model but with different targets:

- `review-fix-pr`: local git PR diff file set derived from `base`, merge-base, and current branch.
- `review-fix-code`: project-root or scoped source file set derived from safe in-root `scope=<path>` values and exclusions.

The design problem is to add these target types without weakening existing document route safety, without adding a second workflow engine, and without letting platform generation or Gemini advisory behavior drift.

## Goals

- Use one shared route model for all six routes.
- Keep document route behavior backward compatible except for explicit `rounds=<n>` support.
- Introduce a file-set target context that can be consumed by guards, state, reviewer context, diff review, receipts, and finalization.
- Keep the coordinator/reviewer/fixer/full-re-review lifecycle shared.
- Make invalid invocations stop before target reads, state creation, probes, or edits.
- Keep Gemini advisory-only for code routes and avoid claiming automatic fix PASS.
- Keep new behavior testable through existing `node --test` style tests.

## Non-goals

- No platform-native `/review` wrapping.
- No large dependency or new runtime.
- No remote fetch, push, publish, PR creation, or remote mutation.
- No full rewrite of the workflow engine.
- No speculative extensibility beyond the six confirmed routes.

## Context

- `lib/generator.js` owns current `ROUTES` and renders platform templates for all current document routes.
- `lib/input.js` currently maps route name to document type and parses document-only arguments.
- `lib/workflow/start.js` creates persistent single-target state and checks `guard=git` availability.
- `lib/workflow/helpers.js` centralizes workflow state helpers, target metadata, no-state metadata, rule loading, locks, receipts, guards, and semantic payload handling.
- `lib/fix-guard.js` currently checks one target file and allows only target/state changes.
- `lib/snapshot-guard.js` currently snapshots/restores one target body and monitors target/reference fingerprints.
- `lib/rulebook.js` currently supports document rule files for `COMMON`, `SPEC`, `PLAN`, and `DESIGN`.
- `lib/adapters/gemini.js` already reports unsupported isolated reviewer and write-blocking capabilities, matching the advisory-only requirement.
- Platform generation and install manifests already iterate over `ROUTES`, so a shared registry change naturally flows into generated command/skill inventory and manifest tests.

## Options

### Recommended Option: shared route registry plus target context abstraction

Approach:

- Replace duplicated route/type constants with one route registry module, for example `lib/routes.js`.
- Each route descriptor records `routeName`, `routeKind` (`document`, `pr`, `code`), platform capability policy, default mode policy, guard support, rubric key, rule file key, invocation grammar, target kind, and generated shared asset requirements.
- Keep the existing document flow as the `document` target implementation.
- Add a `targetContext` layer that resolves and validates route-specific targets:
  - document target: existing single target and refs.
  - PR target: project root, base input, resolved base revision, current branch, current HEAD, merge-base, initial PR file set, and route-owned file-set state.
  - code target: project root, normalized scopes, exclusions, discovered source file set, and route-owned file-set state.
- Extend git/snapshot guards from single target helpers into file-set helpers while preserving existing single-target functions for document routes.
- Add `roundLimit` metadata to parsed invocations and workflow state, separate from `currentRound` and receipt `rounds/` paths.
- Extend `rulebook.js` to allow PR/CODE rule files through route descriptors, not through document type spoofing.
- Extend platform invocation text and generated assets from route descriptors so Gemini can have advisory-only code route text while Claude/Codex advertise automatic fixing.

Benefits:

- Reuses current workflow engine and install model.
- Keeps document routes compatible.
- Makes target semantics explicit and testable.
- Avoids spreading route-specific `if` branches through templates and parsers.
- Gives SPEC and PLAN a coherent contract surface.

Costs:

- Requires moderate refactoring of route metadata, parser dispatch, target state, and guard APIs.
- File-set guard implementation is more complex than single-target guard.
- Tests need a route matrix to prevent drift.

Safety / compatibility:

- Existing single-target helpers stay as compatibility wrappers or document target implementation.
- New file-set guard blocks any path outside the resolved target context and route-owned state.
- State keys include route kind and target identity, preventing PR/code/document collisions.

### Minimal Option: add two hard-coded routes beside document routes

Approach:

- Add route names to `ROUTES`, add special-case parser branches, and embed PR/CODE instructions into platform invocation text.
- Keep workflow state mostly document-shaped and only adapt prompts.

Benefits:

- Smaller initial patch.
- Fewer helper modules.

Costs and risks:

- File-set targets would be simulated through document-oriented state, increasing guard and resume ambiguity.
- PR/code route behavior would rely on prompt discipline rather than explicit state contracts.
- `rounds=<n>` and rule precedence would likely be scattered across parser, templates, and workflow code.

Decision: rejected because it does not adequately mitigate `RISK-001`, `RISK-004`, or `RISK-008`.

### Rejected Option: wrap platform-native `/review`

Approach:

- Generate route entries that delegate to Claude/Codex/Gemini review commands.

Decision: rejected because the raw requirement explicitly forbids it and because platform-native `/review` is not a stable cross-platform programmable API.

### Rejected Option: build a separate code-review workflow engine

Approach:

- Keep document review-fix untouched and add a parallel PR/code workflow implementation.

Decision: rejected because it duplicates hard-won safety mechanisms and violates the requirement that code routes stay isomorphic with document routes unless code targets require extension.

## Decision

Select the recommended option: introduce a shared route registry and a route-specific target context abstraction, then extend existing workflow, guard, state, rulebook, and platform generation around that abstraction.

The selected design keeps one coordinator/reviewer/fixer lifecycle. The route descriptor chooses target resolution and rule/rubric input; the target context chooses state key, monitored files, diff boundaries, and guard behavior. Document routes continue through the existing document target path, with `roundLimit` added as workflow metadata.

## User Decision Gate

| Decision | Options | Recommendation | User Choice | Reason | Impact |
|---|---|---|---|---|---|
| Route architecture | Shared route registry + target context; hard-coded special cases; separate engine | Shared route registry + target context | No additional user choice required | The raw requirement already requires shared workflow mechanics and forbids `/review`; tradeoff is technical, not product-owned. | Enables SPEC without blocking user decision. |
| Gemini behavior | Advisory-only unsupported `review-and-fix`; silently downgrade to read-only; no Gemini route | Advisory-only unsupported `review-and-fix` with guidance to Claude/Codex | No additional user choice required | Raw requirement explicitly requires Gemini install but advisory-only limitation. | Prevents overclaiming. |

## Rationale

This design chooses the smallest durable abstraction that removes real complexity: `route descriptor -> target context -> workflow lifecycle`. The existing implementation already centralizes generated routes, target state, guards, rule loading, and workflow outputs. Extending those seams is safer than embedding PR/code behavior in prompts or creating a separate engine.

The design also keeps guard and state semantics executable. PR/code review correctness depends on knowing which files are monitored, which files are route-owned, and when a file set is stale. That cannot be represented reliably as a single Markdown target.

## Rejected Options

| Option | Rejection reason |
|---|---|
| Hard-code PR/CODE branches without shared descriptors | Route semantics would drift between parser, generator, README, tests, and workflow state. |
| Treat PR/code as document routes with fake targets | Guard, snapshot, receipts, and resume would lie about monitored files. |
| Wrap `/review` | Explicitly forbidden and cross-platform unstable. |
| Separate code-review engine | Duplicates safety gates and violates isomorphic workflow requirement. |

## Impact

- `lib/routes.js` or equivalent route descriptor module is added.
- `lib/generator.js`, `lib/input.js`, and generated templates consume route descriptors instead of maintaining document-only constants.
- `lib/rulebook.js` expands from document section names to route rubric/rule keys, while preserving existing document rule behavior.
- `lib/workflow/start.js` and `lib/workflow/helpers.js` consume target context metadata and `roundLimit`.
- `lib/fix-guard.js` and `lib/snapshot-guard.js` gain file-set variants while retaining document wrappers.
- `shared/rubrics/` gains PR and CODE rubrics, or equivalent generated shared route content.
- `skills/`, `templates/`, README files, and tests expand to six routes.
- No package dependency change is required.

## Change Point Inventory

| Area | Current State | Change Type | Target State | Reason | Spec Input | Plan Input |
|---|---|---|---|---|---|---|
| Route metadata | `ROUTES` in `lib/generator.js`; `DOCUMENT_TYPES` in `lib/input.js` | replace | Single shared route registry with document/pr/code descriptors | Prevent drift across parser/generator/platforms | DES-SPEC-001 | DES-PLAN-001 |
| Invocation parsing | Document-only target/ref grammar | modify | Route-kind parser dispatch for document, PR, and code routes | Support `base`, `scope`, `rounds`, and invalid usage stops | DES-SPEC-002 | DES-PLAN-002 |
| `rounds=<n>` | No user loop limit metadata | add | `roundLimit` parse/state/check separate from `currentRound` and receipts | Meet loop-limit acceptance | DES-SPEC-003 | DES-PLAN-003 |
| Target state | Single target key from file path | modify | Target context keys for document, PR, and code target identities | Safe resume and stale-state rejection | DES-SPEC-004 | DES-PLAN-004 |
| Git guard | Single target worktree guard | modify | File-set git guard with route-owned baseline and unrelated-change blocking | Protect user changes for PR/code | DES-SPEC-005 | DES-PLAN-005 |
| Snapshot guard | Single target snapshot body | modify | File-set snapshot/fingerprint protection for monitored files | Explicit snapshot fallback for PR/code | DES-SPEC-006 | DES-PLAN-005 |
| Rulebook | COMMON/SPEC/PLAN/DESIGN only | modify | Route/rubric rule keys for PR and CODE plus existing document rules | Required PR/CODE rules | DES-SPEC-007 | DES-PLAN-006 |
| Platform generation | Four document routes | modify | Six generated routes with platform-specific capability text | Install new routes and Gemini limitation | DES-SPEC-008 | DES-PLAN-007 |
| Workflow prompts/context | Document target wording | modify | Target-context wording for document/PR/code while preserving lifecycle | Reviewers and coordinator need correct target boundary | DES-SPEC-009 | DES-PLAN-008 |
| README files | Document route behavior only | modify | Aligned English/Chinese docs for new routes and rounds | Public acceptance | DES-SPEC-010 | DES-PLAN-009 |
| Tests | Existing document/generation/guard tests | modify | Matrix covering route parsing, generation, guards, state, rules, docs, Gemini, rounds | Prevent regressions | DES-SPEC-011 | DES-PLAN-010 |

## Requirement Trace Check

| Requirement / Scope Item | Source | Design Handling | Status | Spec Input | Plan Input |
|---|---|---|---|---|---|
| Add `review-fix-pr` | Requirement Brief Scope | Route descriptor with `routeKind=pr` and PR target context | [ADDRESSED] | DES-SPEC-001, DES-SPEC-002 | DES-PLAN-001, DES-PLAN-002 |
| Add `review-fix-code` | Requirement Brief Scope | Route descriptor with `routeKind=code` and scope target context | [ADDRESSED] | DES-SPEC-001, DES-SPEC-002 | DES-PLAN-001, DES-PLAN-002 |
| Preserve document routes and add rounds | Requirement Brief Scope | Document route descriptors keep existing target context; add shared `roundLimit` | [ADDRESSED] | DES-SPEC-003 | DES-PLAN-003 |
| PR base/merge-base semantics | `RISK-DES-002` | PR target resolver validates local base/current branch/merge-base before review | [ADDRESSED] | DES-SPEC-012 | DES-PLAN-002 |
| Code scope containment/exclusions | `RISK-DES-003` | Code target resolver normalizes scopes inside root and applies built-in exclusions | [ADDRESSED] | DES-SPEC-013 | DES-PLAN-002 |
| Multi-round guard safety | `RISK-DES-004` | File-set git guard records initial baseline and route-owned change set | [ADDRESSED] | DES-SPEC-005 | DES-PLAN-005 |
| Persistent/resume state | `RISK-DES-005` | Target context stores route/base/scope/guard/file-set identity and rejects stale state | [ADDRESSED] | DES-SPEC-004 | DES-PLAN-004 |
| Gemini advisory-only | `RISK-DES-006` | Platform capability policy in route/platform generation; omitted mode is unsupported `review-and-fix` request for code routes on Gemini | [ADDRESSED] | DES-SPEC-008 | DES-PLAN-007 |
| PR/CODE rule precedence | `RISK-DES-007` | Rulebook loads hard constraints, built-in rubric, user-global, project-local and validates conflicts | [ADDRESSED] | DES-SPEC-007 | DES-PLAN-006 |
| `rounds=<n>` metadata | `RISK-DES-008` | Parse and persist `roundLimit`; check before entering next repair loop | [ADDRESSED] | DES-SPEC-003 | DES-PLAN-003 |

## Boundary Coverage Check

| Boundary ID | Boundary | Current Side | Target Side | Responsibility | Input / Output | Data / State | Errors | Compatibility | Migration | Rollback | Spec Inputs | Plan Inputs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DES-BND-001 | Route descriptor boundary | `lib/generator.js` and `lib/input.js` local constants | Shared route registry | Registry owns route facts; parser/generator consume them | route name -> descriptor | No persistent data | Unknown route fails usage/preflight | Existing four route names unchanged | Metadata migration only in code | Revert descriptor change restores prior route set | DES-SPEC-001 | DES-PLAN-001 |
| DES-BND-002 | Invocation parsing boundary | Document parser | Route-kind parser dispatch | Parser validates tokens before any target read/state/probe | tokens -> normalized invocation | `roundLimit` added as metadata | Invalid values stop usage-only | Existing document tokens preserved | Parser extension | Revert parser dispatch to document-only | DES-SPEC-002, DES-SPEC-003 | DES-PLAN-002, DES-PLAN-003 |
| DES-BND-003 | Target context boundary | Single file target metadata | Document/PR/code target context | Target resolver owns path/revision/scope/file-set discovery | invocation -> target context | Target key, normalized files, baseline fingerprints | Missing/unsafe target blocks before review/fix | Document target context remains equivalent | File-set context added | Stale context refuses resume | DES-SPEC-004, DES-SPEC-012, DES-SPEC-013 | DES-PLAN-004 |
| DES-BND-004 | Git guard boundary | `checkTargetOnlyWorktree` single target | File-set git guard | Guard blocks unrelated changes and validates route-owned files | target context + git status -> guard result | Baseline status/fingerprints/current route-owned set | Guard unavailable or unexpected change blocks | Single-target wrapper preserved | Guard extension | No remote mutation; local state recoverable | DES-SPEC-005 | DES-PLAN-005 |
| DES-BND-005 | Snapshot guard boundary | Single target snapshot | File-set snapshot anchor | Snapshot stores monitored file fingerprints/content where safe | target context -> snapshots/fingerprints | Per-file snapshots and metadata | Missing/symlink/outside files block | Existing document snapshot wrapper preserved | Snapshot extension | Restore only monitored files | DES-SPEC-006 | DES-PLAN-005 |
| DES-BND-006 | Rulebook boundary | Document rule files | Route/rubric rule files | Rulebook owns load order and hard-constraint conflict validation | route key -> merged rules | No persistent data except receipts/debug | Symlink/invalid/conflict blocks | Existing document rule files preserved | Rule key expansion | Revert PR/CODE rule support | DES-SPEC-007 | DES-PLAN-006 |
| DES-BND-007 | Platform generation boundary | Four generated routes | Six generated routes | Generator/templates own platform wording and shared assets | descriptor -> command/skill/TOML | Install manifest records generated files | Unsupported platform/route fails | Existing generated doc routes stable except rounds text | Generated route expansion | Manifest uninstall remains owned-only | DES-SPEC-008 | DES-PLAN-007 |
| DES-BND-008 | Workflow lifecycle boundary | Document lifecycle context | Route target context lifecycle | Coordinator remains owner of final pass; reviewers remain read-only | target context + reports -> status | Receipts, ledger, manifest, round limit | Missing full re-review blocks PASS | Existing terminal statuses preserved | Lifecycle extension | Existing finalization semantics preserved | DES-SPEC-009 | DES-PLAN-008 |

## Integration Boundaries

| Integration Boundary ID | Integration Boundary | Current Project / Module | Target Project / Module | Current Operation | Target Capability | Responsibility Split | Input / Output | Data / State Mapping | Error Handling | Compatibility | Migration | Rollback | Spec Inputs | Plan Inputs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DES-INT-001 | Platform route installation | `lib/install.js`, `lib/generator.js`, templates | Claude Code, Codex, Gemini local command/skill locations | Generate and install document routes | Generate and install document plus code routes | Package owns generated content and manifest; platforms execute entries | route descriptor -> generated file/directory | Manifest records ownership/checksums | Existing install errors continue; unsupported route/platform fails | Existing document route install paths preserved | Add generated entries only | Manifest-backed uninstall removes package-owned files only | DES-SPEC-008 | DES-PLAN-007 |
| DES-INT-002 | Runtime workflow entry | Generated route content | `drfx workflow` commands and workflow helpers | Materialize document target payload | Materialize document/PR/code target payload | Generated entry owns usage/default materialization; workflow owns validation/state | user invocation -> semantic payload | State manifest stores normalized invocation and target context | Invalid input stops before body reads/state | Existing document behavior preserved | Payload schema expands | Resume rejects stale schema/context | DES-SPEC-002, DES-SPEC-004 | DES-PLAN-002, DES-PLAN-004 |
| DES-INT-003 | Rule file integration | `.docs-review-fix/rules/*.md` | `lib/rulebook.js` | Load document rule files | Load PR/CODE route rule files too | User/project owns rule files; package validates and merges | rule paths -> merged review context | No mutation of rules | Invalid/conflicting rules block or warn per strictness | Existing document rules unchanged | Rule name allowlist expands | Removing PR/CODE support leaves document rules unaffected | DES-SPEC-007 | DES-PLAN-006 |

## Migration / Compatibility

- Migration type: internal feature migration from four document-only routes to six route descriptors with two target kinds.
- Existing document route names, default mode/assurance behavior, strictness, `ref`, `ledger`, `root`, `resume`, `debug`, and guard semantics are preserved.
- `rounds=<n>` is additive; omitted `rounds` keeps current loop behavior.
- Existing target state remains valid for document routes because document target key derivation stays compatible. New route descriptors must not reinterpret existing document target state as PR/code state.
- Generated platform outputs add new files/directories and update existing route text; manifest ownership rules remain the compatibility boundary for uninstall.
- No data migration command is required. Stale or incompatible new code-route state is refused rather than migrated silently.

## Failure / Rollback

- If PR base cannot be resolved locally, current branch equals base, or merge-base is missing, `review-fix-pr` stops before review/fix and does not fetch.
- If `scope=<path>` is outside root, missing, excluded, symlink-unsafe, or otherwise unsafe, `review-fix-code` stops before review/fix.
- If git guard cannot run, selected `guard=git` stops with a guard-unavailable reason and does not switch to snapshot.
- If snapshot guard cannot protect all monitored files, selected `guard=snapshot` stops.
- If unrelated local changes appear, file-set guard blocks before automatic fix completion.
- If route state is stale because route/base/scope/head/file-set identity changed, resume is refused with an explicit reason.
- Rollback for implementation remains git-based local code rollback; workflow runtime rollback is guard/snapshot based and never mutates remote state.

## Dependency / Safety

- Dependency risk is limited to local `git`, Node.js 20, existing package modules, and platform-generated command/skill conventions. No new large dependency is selected.
- `review-fix-pr` uses only local refs/revisions; it does not fetch.
- File path safety requires normalized in-root paths, symlink checks for monitored files, and explicit exclusions for `.git`, `.docs-review-fix`, dependency directories, build outputs, caches, and temporary directories.
- Reviewer write blocking and fingerprint guards remain mandatory for Claude Code and Codex automatic fix paths.
- Gemini remains advisory-only and cannot create automatic-fix state or claim PASS.
- Debug output and receipts keep redaction and bounded-output rules.

## Risk / Attack Gate

| Attack Dimension | Depth | Risk / Failure Mode | Mitigation / Design Response | Verification or SPEC/PLAN Input | Status |
|---|---|---|---|---|---|
| Dependency failure | dependency_design | `git` unavailable, base invalid, platform capability missing, or rule file invalid. | Stop explicitly with unsupported/blocked/usage result; no fallback unless user selected it. | DES-SPEC-005, DES-SPEC-007, DES-SPEC-012; DES-PLAN-002, DES-PLAN-006 | [ADDRESSED] |
| Scale explosion | architecture_design | Whole-project code review file set becomes too broad or includes generated/cache files. | Scope resolver excludes non-source directories and records file-set boundaries; PLAN prioritizes matrix tests. | DES-SPEC-013; DES-PLAN-010 | [ADDRESSED] |
| Rollback cost | safety_design | File-set fixes touch many files and cannot be safely attributed. | Route-owned baseline/change tracking; stale resume refusal; snapshot file-set protection when selected. | DES-SPEC-004, DES-SPEC-005, DES-SPEC-006; DES-PLAN-005 | [ADDRESSED] |
| Data safety | safety_design | User files, rule files, manifests, or unrelated local edits are overwritten. | In-root path validation, owned manifest checks, no remote mutation, guard refusal on unrelated changes. | DES-SPEC-005, DES-SPEC-006, DES-SPEC-008; DES-PLAN-005, DES-PLAN-007 | [ADDRESSED] |
| Compatibility | migration_design | Existing document routes or installed manifests regress. | Preserve document target implementation and add tests for no-rounds behavior and generated route output. | DES-SPEC-003, DES-SPEC-008; DES-PLAN-003, DES-PLAN-007 | [ADDRESSED] |
| Execution safety | safety_design | Repair loop claims pass without full re-review or read-only creates state. | Lifecycle remains coordinator-owned with full re-review; read-only route path stays no-state. | DES-SPEC-009; DES-PLAN-008 | [ADDRESSED] |

## Verification Strategy / Test Architecture

- Unit tests for route registry and route lookup.
- Parser tests for document `rounds=<n>`, PR `base`, CODE `scope`, invalid tokens, invalid rounds, and `read-only rounds=<n>`.
- Target context tests for PR base resolution/no-fetch constraints and code scope containment/exclusions.
- Guard tests for file-set git guard, file-set snapshot guard, route-owned changes, unrelated local changes, and stale state.
- Rulebook tests for PR/CODE built-in rubrics, user-global/project-local rule loading, precedence, unknown files, symlink rejection, and hard-constraint conflict rejection.
- Generated output tests for Claude, Codex, and Gemini route entries.
- Install manifest tests for two new routes and owned-only uninstall behavior.
- Workflow tests for read-only no-state, review-and-fix full re-review requirement, rounds limit stop conditions, and Gemini advisory-only unsupported automatic fix.
- README alignment tests or focused assertions ensuring both README files include the new routes, rounds, guards, rules, examples, and Gemini limitation.

## Resolved Blockers

| Blocker / Trigger | Resolution |
|---|---|
| `RISK-DES-001` | [ADDRESSED] File-set target context selected. |
| `RISK-DES-002` | [ADDRESSED] PR target resolver selected with local base/merge-base validation. |
| `RISK-DES-003` | [ADDRESSED] Code target resolver selected with normalized in-root scopes and exclusions. |
| `RISK-DES-004` | [ADDRESSED] File-set git guard selected with route-owned baseline/change tracking. |
| `RISK-DES-005` | [ADDRESSED] Route/base/scope/guard/file-set state identity selected. |
| `RISK-DES-006` | [ADDRESSED] Platform capability policy selected; Gemini advisory-only remains explicit. |
| `RISK-DES-007` | [ADDRESSED] Rulebook extension and conflict validation selected. |
| `RISK-DES-008` | [ADDRESSED] Dedicated `roundLimit` metadata selected. |

## Remaining Assumptions

| ID | Assumption | Impact | Carry To |
|---|---|---|---|
| DES-A-001 | Current repository tests can exercise local git cases without remote network access. | If false, PLAN must use temporary local repos or fixtures. | PLAN |
| DES-A-002 | Existing generated route templates can be parameterized from route descriptors without replacing the install model. | If false, SPEC/PLAN may need focused template refactor while preserving install behavior. | SPEC, PLAN |
| DES-A-003 | Exact code source file discovery can be implemented with deterministic filesystem traversal and exclusions rather than an external dependency. | If false, dependency introduction would need user approval. | SPEC |

## Spec Inputs

| Spec Input ID | Source Artifact | Source Item ID | Item | Required SPEC Contract | Reason | Status |
|---|---|---|---|---|---|---|
| DES-SPEC-001 | DESIGN | DES-BND-001 | Route registry | Define route descriptor fields, supported route kinds, platform policy, rubric/rule keys, and compatibility for existing routes. | Shared route facts prevent drift. | [DEFERRED] |
| DES-SPEC-002 | DESIGN | DES-BND-002 | Invocation parsing | Define exact token grammar and preflight ordering for document, PR, and CODE routes. | Invalid inputs must be side-effect-free. | [DEFERRED] |
| DES-SPEC-003 | DESIGN | DES-BND-002 | `rounds=<n>` | Define `roundLimit`, validation, persistence, stop checks, early clean stop, and `read-only rounds=<n>` behavior. | Loop semantics must be testable. | [DEFERRED] |
| DES-SPEC-004 | DESIGN | DES-BND-003 | Target context and state identity | Define target context schemas and stale resume refusal rules for document, PR, and code. | Resume safety. | [DEFERRED] |
| DES-SPEC-005 | DESIGN | DES-BND-004 | File-set git guard | Define route-owned baseline, allowed changes, unrelated change blocking, and guard-unavailable status. | User work protection. | [DEFERRED] |
| DES-SPEC-006 | DESIGN | DES-BND-005 | File-set snapshot guard | Define monitored file snapshots/fingerprints, restore limits, symlink handling, and unavailable status. | Explicit snapshot safety. | [DEFERRED] |
| DES-SPEC-007 | DESIGN | DES-BND-006 | PR/CODE rulebook | Define built-in rubrics, rule paths, load order, precedence, and conflict handling. | Review policy correctness. | [DEFERRED] |
| DES-SPEC-008 | DESIGN | DES-BND-007 | Platform generation and install | Define generated route outputs, Gemini advisory-only behavior, manifest ownership, and uninstall safety. | Cross-platform acceptance. | [DEFERRED] |
| DES-SPEC-009 | DESIGN | DES-BND-008 | Workflow lifecycle | Define coordinator/reviewer/fixer/full-re-review contracts for file-set targets and no-state read-only. | PASS safety. | [DEFERRED] |
| DES-SPEC-010 | DESIGN | README Change Point | Documentation | Define required README sections, examples, and EN/ZH structure alignment. | Public docs acceptance. | [DEFERRED] |
| DES-SPEC-011 | DESIGN | Tests Change Point | Verification contracts | Define acceptance scenarios that PLAN must implement as tests. | Coverage closure. | [DEFERRED] |
| DES-SPEC-012 | DESIGN | DES-BND-003 | PR target resolver | Define local base/current branch/merge-base behavior and no implicit fetch/ref mutation. | PR boundary correctness. | [DEFERRED] |
| DES-SPEC-013 | DESIGN | DES-BND-003 | CODE target resolver | Define scope normalization, exclusions, source file selection, and outside-root refusal. | Code scope safety. | [DEFERRED] |

## Plan Inputs

| Plan Input ID | Source Artifact | Source Item ID | Item | Required PLAN Constraint | Covers | Status |
|---|---|---|---|---|---|---|
| DES-PLAN-001 | DESIGN | DES-BND-001 | Route registry work | Implement registry first and migrate parser/generator to consume it before adding route behavior. | Controlled refactor. | [DEFERRED] |
| DES-PLAN-002 | DESIGN | DES-BND-002 | Parser and resolver tests | Add failing tests for PR/CODE/document rounds before implementation. | TDD and invalid input safety. | [DEFERRED] |
| DES-PLAN-003 | DESIGN | DES-SPEC-003 | Rounds implementation | Keep `roundLimit` separate from `currentRound` and receipt paths; verify no-rounds compatibility. | Loop control. | [DEFERRED] |
| DES-PLAN-004 | DESIGN | DES-SPEC-004 | State/resume implementation | Implement and test target context state keys and stale refusal. | Resume safety. | [DEFERRED] |
| DES-PLAN-005 | DESIGN | DES-SPEC-005, DES-SPEC-006 | File-set guard implementation | Implement git/snapshot file-set guard in small helpers with tests before workflow integration. | User work protection. | [DEFERRED] |
| DES-PLAN-006 | DESIGN | DES-SPEC-007 | Rulebook implementation | Add PR/CODE rubrics and rule loading tests, including hard-constraint conflict cases. | Rule safety. | [DEFERRED] |
| DES-PLAN-007 | DESIGN | DES-SPEC-008 | Platform generation/install | Update templates and manifest tests for six routes and Gemini advisory-only code behavior. | Install acceptance. | [DEFERRED] |
| DES-PLAN-008 | DESIGN | DES-SPEC-009 | Workflow lifecycle integration | Preserve reviewer readiness, write-blocking, stdin proof, diff review, full re-review, redaction, and final validation. | Workflow hard constraints. | [DEFERRED] |
| DES-PLAN-009 | DESIGN | DES-SPEC-010 | Documentation update | Update `README.md` and `README.zh-CN.md` in the same pass and verify structural alignment. | Docs acceptance. | [DEFERRED] |
| DES-PLAN-010 | DESIGN | DES-SPEC-011 | Verification matrix | Run focused tests, `npm test`, and package/generation checks appropriate to changed surfaces. | Definition of done. | [DEFERRED] |

## Closure Status

| Upstream ID | Closure |
|---|---|
| RISK-001 | [ADDRESSED] Mitigated by file-set guard, target context state, and tests. |
| RISK-002 | [ADDRESSED] Mitigated by PR target resolver and base/merge-base contracts. |
| RISK-003 | [ADDRESSED] Mitigated by dedicated `roundLimit` metadata and compatibility tests. |
| RISK-004 | [ADDRESSED] Mitigated by route/base/scope/guard/file-set state identity. |
| RISK-005 | [ADDRESSED] Mitigated by preserving redaction/default-output boundaries. |
| RISK-006 | [ADDRESSED] Mitigated by manifest ownership preservation and generated route tests. |
| RISK-007 | [ADDRESSED] Mitigated by platform capability policy and Gemini advisory-only contract. |
| RISK-008 | [ADDRESSED] Mitigated by rulebook precedence and hard-constraint conflict validation. |
| RISK-009 | [ADDRESSED] Mitigated by parser preflight ordering and usage-only invalid stops. |
| RISK-010 | [ADDRESSED] Mitigated by verification matrix handoff. |
| RISK-DES-001 | [ADDRESSED] Target context abstraction selected. |
| RISK-DES-002 | [ADDRESSED] PR resolver strategy selected. |
| RISK-DES-003 | [ADDRESSED] CODE scope resolver strategy selected. |
| RISK-DES-004 | [ADDRESSED] File-set guard strategy selected. |
| RISK-DES-005 | [ADDRESSED] State key/stale validation strategy selected. |
| RISK-DES-006 | [ADDRESSED] Platform capability policy selected. |
| RISK-DES-007 | [ADDRESSED] Rulebook strategy selected. |
| RISK-DES-008 | [ADDRESSED] `roundLimit` strategy selected. |
| RISK-SPEC-001 | [DEFERRED] Covered by DES-SPEC-001 and DES-SPEC-002. |
| RISK-SPEC-002 | [DEFERRED] Covered by DES-SPEC-001 and DES-SPEC-002. |
| RISK-SPEC-003 | [DEFERRED] Covered by DES-SPEC-002 and DES-SPEC-009. |
| RISK-SPEC-004 | [DEFERRED] Covered by DES-SPEC-005 and DES-SPEC-006. |
| RISK-SPEC-005 | [DEFERRED] Covered by DES-SPEC-003. |
| RISK-SPEC-006 | [DEFERRED] Covered by DES-SPEC-012. |
| RISK-SPEC-007 | [DEFERRED] Covered by DES-SPEC-013. |
| RISK-SPEC-008 | [DEFERRED] Covered by DES-SPEC-004 and DES-SPEC-009. |
| RISK-SPEC-009 | [DEFERRED] Covered by DES-SPEC-009. |
| RISK-SPEC-010 | [DEFERRED] Covered by DES-SPEC-007. |
| RISK-SPEC-011 | [DEFERRED] Covered by DES-SPEC-009. |
| RISK-SPEC-012 | [DEFERRED] Covered by DES-SPEC-008. |
| RISK-SPEC-013 | [DEFERRED] Covered by DES-SPEC-010. |
| RISK-SPEC-014 | [DEFERRED] Covered by DES-SPEC-008. |
| RISK-SPEC-015 | [DEFERRED] Covered by DES-SPEC-009 and DES-SPEC-011. |
| RISK-PLAN-001 | [DEFERRED] Covered by DES-PLAN-010. |
| RISK-PLAN-002 | [DEFERRED] Covered by DES-PLAN-002. |
| RISK-PLAN-003 | [DEFERRED] Covered by DES-PLAN-002. |
| RISK-PLAN-004 | [DEFERRED] Covered by DES-PLAN-003. |
| RISK-PLAN-005 | [DEFERRED] Covered by DES-PLAN-005. |
| RISK-PLAN-006 | [DEFERRED] Covered by DES-PLAN-007. |
| RISK-PLAN-007 | [DEFERRED] Covered by DES-PLAN-007. |
| RISK-PLAN-008 | [DEFERRED] Covered by DES-PLAN-008. |
| RISK-PLAN-009 | [DEFERRED] Covered by DES-PLAN-006. |
| RISK-PLAN-010 | [DEFERRED] Covered by DES-PLAN-009. |

## Design Quality Gate

- Status: ready
- Reason: One design direction is selected, rejected options are documented, all `RISK-DES-*` triggers are addressed, P0/P1 risks have mitigations, boundaries have stable IDs, verification strategy is explicit, and downstream SPEC/PLAN inputs use stable IDs with closure status.
- Requirement scope changed: no
- Unconfirmed requirement converted to design fact: no
- Safe next node: DESIGN Checkpoint, then SPEC

## DESIGN Checkpoint

- Status: ready for checkpoint decision
- Review Sources: main-agent review of approved Requirement Brief, approved Risk Discovery, CodeGraph context, and relevant local source files.
- Required Changes: none known.
- User Confirmations:
  - SPEC Authorization: yes, after checkpoint approval.
