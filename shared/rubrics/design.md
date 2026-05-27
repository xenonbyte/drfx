# DESIGN Rubric

Use `DESIGN` for UX, UI, product, workflow, system, architecture, and interaction design documents. Apply `shared/rubrics/common.md` first, then this rubric.

Review for:

- Flows: user, system, operational, and error flows are covered at the detail needed for implementation.
- Implementation detail: the design gives enough concrete behavior, structure, state, and boundary detail for implementation planning without inventing core decisions.
- States: loading, empty, error, disabled, permission, edge, persisted, and transitional states are specified when material.
- Transitions: state changes, navigation, lifecycle, retries, rollbacks, and event sequencing are clear.
- Contracts: API, component, module, command, storage, event, and integration contracts are explicit.
- Data flow: data sources, transformations, ownership, validation, persistence, and privacy boundaries are understandable.
- Ownership: responsibilities across users, components, services, jobs, and operators are assigned.
- Accessibility: keyboard, screen-reader, contrast, focus, semantics, motion, and assistive needs are addressed when relevant.
- Responsiveness: layout, viewport, density, performance, and device constraints are addressed when relevant.
- Localization: language, formatting, directionality, copy length, and locale-sensitive behavior are considered when relevant.
- Constraints: current code, architecture, design system, dependencies, runtime, operational, and business constraints are reflected.
- Risks: implementation, UX, reliability, data, privacy, migration, and scope risks are handled or accepted.
- Hidden scope: new work implied by the design is called out as explicit scope, tradeoff, or non-goal.
- Stage-aware design boundary: the design chooses or records design decisions without redefining requirements, writing full behavior contracts, or splitting executor tasks.
- Decision clarity: selected approaches, rejected alternatives, unresolved decisions, and user-owned tradeoffs are visible where they affect implementation.
- Boundary coverage: module, API/CLI, data, state, permission, compatibility, migration, rollback, dependency, and execution boundaries are clear when material.
- Change points: important add, modify, replace, remove, preserve, and no-op areas are visible without requiring a fixed table format.
- Reference Conformance: when reference documents are provided, the design does not conflict with reference requirements, constraints, terminology, non-goals, or risk boundaries.

A DESIGN does not require downstream SPEC or PLAN handoff tables. Missing `Spec Inputs`, `Plan Inputs`, stable IDs, or coverage matrices is not blocking unless the design claims to provide complete downstream handoff, custom rules require that structure, or the missing structure makes the design unusable for its stated purpose.

Blocking findings include missing behavior, unresolved state or boundary decisions, contracts that cannot be implemented, design/code mismatch, ignored material accessibility or responsiveness needs, and hidden scope expansion.

PASS for `DESIGN` means the document is decision-complete enough to become a spec or implementation plan.
