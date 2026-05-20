# SPEC Rubric

Use `SPEC` for requirements, product behavior, API behavior, feature definitions, and acceptance documents. Apply `shared/rubrics/common.md` first, then this rubric.

Review for:

- Requirements: behavior is concrete, internally consistent, and tied to the objective.
- Scope: in-scope and out-of-scope boundaries are clear where ambiguity affects implementation.
- Actors: users, systems, roles, and responsibilities are identified where behavior depends on them.
- Permissions: authorization, privacy, security, and access rules are explicit when material.
- Inputs/outputs: inputs, outputs, formats, validation, errors, and state changes are clear.
- Data ownership: ownership, lifecycle, retention, mutation rules, and privacy boundaries are specified when relevant.
- Integrations: API, service, event, dependency, and boundary contracts are clear.
- Success/failure paths: normal flows, failure flows, error handling, and recovery behavior are covered.
- Acceptance criteria: verification criteria are concrete and testable.
- Edge cases: concurrency, limits, empty states, malformed input, permissions, security, and privacy cases are covered when material.
- Product decisions: unresolved product choices are either decided or explicitly blocked for user input.
- Implementation fit: requirements match known implementation constraints, system capabilities, data model, APIs, permission model, architecture, and runtime boundaries.
- Risks: product, technical, data, security, compliance, and rollout risks are handled or accepted.
- Verifiability: implementers and reviewers can prove whether the spec is satisfied.

Blocking findings include vague requirements, missing acceptance criteria, undefined failure behavior, omitted material permissions or data boundaries, contradictions, and requirements that force implementers to redefine product behavior.

PASS for `SPEC` means the document is product-decision-complete, implementation-ready, and verifiable.
