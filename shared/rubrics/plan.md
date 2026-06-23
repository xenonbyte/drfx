# PLAN Rubric

Use `PLAN` for implementation plans, migration plans, rollout plans, refactor plans, and execution checklists. Apply `shared/rubrics/common.md` first, then this rubric.

Review for:

- Executable order: steps are ordered so another agent or engineer can execute them without re-planning.
- Prerequisites: dependencies, environment assumptions, credentials, data setup, and approvals are identified.
- Tooling: commands, scripts, fixtures, CLIs, services, and local checks are named where needed.
- Sequencing: route, ownership, migration, rollout, and handoff decisions are resolved before execution depends on them.
- Test strategy: every implementation task that produces verifiable behavior names a concrete test approach (test-first / TDD where practical) — unit, integration, or e2e — sufficient to prove the task. Tasks that produce no verifiable behavior (copy edits, doc-only, config-only, asset moves) are explicitly exempt and should say why.
- Acceptance criteria: every material task states observable acceptance / done criteria (a clear pass/fail), except the non-behavioral tasks above.
- Rollback: rollback or stop-the-line behavior is included where failure would matter.
- Failure handling: blockers, partial progress, retries, degraded states, and operator communication are covered when material.
- Data safety: migrations, destructive operations, sensitive data, backups, privacy, and production boundaries are handled.
- Compatibility: runtime, API, schema, dependency, platform, and backwards-compatibility impacts are acknowledged.
- Blast radius: affected files, services, users, data, and external systems are visible.
- Handoff readiness: another agent or engineer can pick up the plan with context, working set, checks, and expected outcomes.
- Source authority: the PLAN identifies the source it is executing from, such as a SPEC, DESIGN, issue, approved user plan, Superpowers-generated plan, task prompt, or acceptance notes.
- Task source fit: material execution steps are grounded in a declared source of authority without requiring a specific ID format.
- Reference Conformance: when references are provided, the PLAN does not violate their material behavior, scope, constraints, non-goals, safety rules, acceptance expectations, or risk boundaries.
- Stop conditions: the PLAN says when execution should stop instead of inventing a new requirement, design decision, external-state mutation, or verification shortcut.

A PLAN does not require a SPEC reference. SPEC-to-task mapping is optional and is not blocking by default. Missing SPEC IDs, stable IDs, trace tables, or coverage matrices is not blocking unless the PLAN claims complete coverage of a reference, custom rules require that structure, or the missing structure makes the PLAN unsafe or unverifiable for its stated purpose.

Blocking findings include missing execution order, missing prerequisites, unverifiable steps, hidden external state changes, no rollback for risky operations, material reference conflict, unsupported new requirement embedded in execution steps, unresolved architecture or product decisions embedded in execution steps, and a task that produces verifiable behavior with no named test strategy or no acceptance criteria (trivial non-behavioral tasks exempt).

PASS for `PLAN` means the document is ordered, executable, verifiable, rollback-aware where needed, and ready to hand to another agent or engineer.
