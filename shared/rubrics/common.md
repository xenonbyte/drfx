# COMMON Rubric

Use `COMMON` as the base rubric for every document type and as the full rubric for generic documents.

## Severity anchors

Apply these to all document types; type rubrics do not redefine them:

- high: blocks the document's stated purpose, or makes execution/acceptance unsafe or impossible.
- medium: materially weakens correctness or completeness, but a competent next actor can still proceed with caution.
- low: a clarity, consistency, or structure improvement that does not block use in normal mode.

## Coverage groups

State, in the reviewer Summary line, which of these groups you exercised (terse, e.g. `covered background/objective/coherence/constraints/risks/reference`):

- COMMON: background, objective, coherence, actionability, constraints, risks, project-alignment, reference.
- SPEC adds: requirements, scope, actors, permissions, io/errors, acceptance, edge cases.
- PLAN adds: executable-order, prerequisites, verification, rollback, blast-radius, stop-conditions.
- DESIGN adds: flows, states, transitions, contracts, data-flow, accessibility, hidden-scope.

Review for:

- Background: the document explains why it exists and what source context matters.
- Objective: the intended outcome is clear enough to judge success.
- Coherence: the document is internally consistent and does not contradict itself.
- Actionability: the next actor can use it without inventing key decisions.
- Assumptions: material assumptions are explicit and marked `UNCONFIRMED` when not verified.
- Constraints: technical, product, operational, timing, security, or process constraints are visible.
- Risks: material risks are described, mitigated, constrained, verified, or explicitly accepted.
- Project alignment: claims fit known project code, architecture, conventions, dependencies, runtime environment, and repository instructions.
- Terminology: terms are used consistently where differences would change meaning.
- Placeholders: required sections contain no blocking `TBD`, `TODO`, `later`, "to be discussed", or equivalent placeholder text.
- External facts: unstable or external facts are verified with authoritative sources, or marked `UNCONFIRMED`.
- Resolution: every material ambiguous or uncertain point is either resolved or explicitly surfaced — as a decision to be made, an `UNCONFIRMED` mark, or an accepted assumption/risk — and is never left silent, vague, or glossed over.
- Document type fit: if the document is functioning as a DESIGN, SPEC, or PLAN, flag that the user may get a better review from the matching route.
- Reference Conformance: when references are provided, the document remains consistent with their material facts, constraints, terminology, scope, non-goals, and risks.

Blocking findings include missing purpose, missing required context, ambiguity that affects execution or acceptance, unresolved questions that block use, any material ambiguous or uncertain point left silent or unresolved (a genuine open point must be explicitly surfaced — decision-to-make, `UNCONFIRMED`, or accepted — not glossed), unsupported project claims, and risk omissions that make the document unsafe to rely on.

Missing DESIGN, SPEC, or PLAN-specific structure is not blocking for `COMMON` unless the document's stated purpose depends on that structure.

PASS for `COMMON` means the document has sufficient background and objective context, is coherent, is aligned with known project facts, is actionable for its stated purpose, and has no unresolved high or medium issues.
