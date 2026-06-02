# SPEC Checkpoint Review

## Status
changes_requested

## Coverage Findings

1. SPEC v1 does not fully pin the shared mode and guard defaults from the raw requirement.

   Required upstream coverage: omitted mode defaults to `review-and-fix`; omitted guard defaults to `guard=git`; `guard=snapshot` is only used when explicitly selected; `read-only` performs no fixes, creates no automatic-fix state, and must not claim workflow PASS.

   Current SPEC coverage is partial: `SPEC-IF-001` says descriptors expose default mode/default guard, `SPEC-STATE-004` covers read-only no-state, and `SPEC-ERR-004` covers `read-only rounds=<n>`, but no contract states the actual default values or the general `read-only` non-fix/non-PASS result semantics.

   Required change: update `06-spec.md` in `Functional Requirements`, `Interfaces`, or `Error Behavior` to state the exact default values and full `read-only` semantics for all six routes, and add or adjust an acceptance/PLAN handoff item so PLAN tests those defaults and read-only result behavior.

2. SPEC v1 does not enumerate the required PR/CODE rubric categories or exact external rule loading order.

   Required upstream coverage: PR rubric categories are `correctness`, `regression`, `safety`, `tests`, `contracts`, `maintainability`, and `platform`; CODE rubric categories are `correctness`, `architecture`, `state-and-io`, `safety`, `tests`, `contracts`, `maintainability`, and `platform`. Rule loading order is workflow hard constraints, built-in rubric, user-global rule file, then project-local rule file, with project-local rules more specific and no external rule allowed to relax hard constraints.

   Current SPEC coverage is partial: `SPEC-FR-005` and `SPEC-IF-005` require built-in rubrics and external rules, but they do not list the rubric categories or the exact precedence/order.

   Required change: update the PR/CODE rulebook contract in `06-spec.md`, preferably around `SPEC-FR-005` / `SPEC-IF-005`, to include the exact categories, paths, and precedence semantics from the raw requirement.

3. SPEC v1 does not list the required CODE scope exclusions.

   Required upstream coverage: default `review-fix-code` must exclude `.git`, `.docs-review-fix`, dependency directories, build outputs, caches, temporary files, and other obvious non-source directories; `scope=<path>` pointing to excluded locations must stop.

   Current SPEC coverage is partial: `SPEC-SAFE-005` says excluded directories are rejected, but it does not identify the mandatory exclusion set, and `SPEC-ACC-*` does not include an excluded-scope scenario.

   Required change: update `SPEC-IF-004` or `SPEC-SAFE-005` to name the required exclusion set, and add a PLAN or acceptance scenario that verifies excluded scopes such as `.git`, `.docs-review-fix`, `node_modules`, and build/cache/temp directories.

## Contract Findings

1. SPEC v1 does not explicitly preserve the non-goal that code review routes must not call or wrap platform-native `/review`.

   Required upstream coverage: both new routes must use this project's workflow contract and must not implement review by invoking platform `/review`.

   Current SPEC coverage is implicit through the shared route model and DESIGN rejection, but the SPEC itself does not contain a testable contract forbidding `/review` delegation.

   Required change: add this as a safety, compatibility, or platform-generation contract in `06-spec.md`, and carry it to PLAN as a generated-route/workflow-text verification item.

## Risk Findings

The unresolved items above keep several upstream risks only partially closed at SPEC level:

- `RISK-SPEC-003` mode semantics is not fully testable without exact defaults and read-only non-PASS behavior.
- `RISK-SPEC-004` guard semantics is not fully testable without explicit `guard=git` default and `guard=snapshot` explicit-only behavior.
- `RISK-SPEC-010` rule behavior is not fully testable without exact PR/CODE rubric categories and load order.
- `RISK-SPEC-007` CODE scope behavior is not fully testable without the mandatory exclusion list.

No additional architecture/design change is required; these are SPEC contract completion issues.

## PLAN Handoff Findings

PLAN handoff is otherwise strong: route registry, parser, rounds, target context, guards, rulebook, platform generation, workflow lifecycle, docs, and verification matrix are all present as `SPEC-PLAN-*` items.

However, PLAN should not proceed until the four findings above are repaired, because otherwise implementation tasks can satisfy the current SPEC text while missing explicit raw acceptance criteria.

## Recommendation
changes_requested
