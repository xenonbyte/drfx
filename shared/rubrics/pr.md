# PR Rubric

Use for pull request code review. Apply this rubric to evaluate the correctness, safety, and maintainability impact of the changes introduced by the PR. This rubric is self-contained: route-kind reviews have no COMMON layer, so do not apply `shared/rubrics/common.md`.

## Actionable-only triage boundary

Raise findings only when there is a concrete, actionable problem. Do NOT raise blocking findings for:

- Pure style preferences (naming conventions, whitespace, comment style) when they do not affect correctness or understanding.
- No-risk refactors that are behavior-equivalent and are not the stated purpose of the PR.
- Over-abstraction opinions when the existing structure is internally consistent and functional.

A finding is blocking only when it affects correctness, safety, test coverage, or behavioral contracts in a material way.

## Coverage groups

Review for:

- Correctness: the changed code is logically correct — no off-by-one errors, wrong conditions, incorrect state transitions, missing null/undefined guards, or incorrect data transformations.
- Regression: the change does not silently break existing behavior, contracts, or invariants. New code paths are consistent with the expectations callers already have.
- Safety: inputs are validated, error paths are handled explicitly, sensitive data is not leaked in logs or outputs, and destructive operations are guarded appropriately.
- Tests: changed or new behavior has adequate test coverage. Existing tests are not deleted or weakened without a sound reason tied to an accepted finding.
- Contracts: public interfaces, exported functions, event schemas, configuration shapes, and API surfaces remain backward-compatible unless the PR explicitly intends a breaking change with documented rationale.
- Maintainability: the change does not introduce hidden complexity, unexplained magic values, silent fallbacks, or speculative abstractions beyond a present requirement. Code is readable and followable by the next contributor without the author present.
- Platform: the change does not introduce platform-specific behavior that would break other supported environments without explicit guards or documentation.

## Blocking findings

Blocking findings include incorrect logic, unhandled error paths that could cause data loss or incorrect program state, missing tests for new behavior, breaking public interface changes without documentation, and security or privacy violations.

PASS for `PR` means the change is correct, safe, tested, non-breaking, and leaves the codebase in a maintainable state.

## Engineering standards

Apply these only when the issue is concrete and actionable. Do not block on pure style preferences unless the style creates correctness, safety, portability, testability, or maintainability risk.

### Hardcoded values

- High (blocking): hardcoded secrets, credentials, tokens, private keys, cookies, production identifiers, or raw sensitive log values.
- Medium (blocking when a config/constant/injection/documented-default was expected): environment-specific URLs, hosts, ports, filesystem paths, branch names, model names, tenant/region IDs, feature flags, timeouts, retry counts, limits, locale/timezone assumptions, or platform-specific commands.
- Low (report, rarely blocking): unexplained magic strings/numbers in local logic that hurt readability or make future change risky but do not currently affect behavior.

Allowed, not findings: named constants with clear scope and rationale; obviously fake local test fixtures; protocol constants, documented file names, CLI command/token names, schema enum values, and route names that are part of the public contract.

### Error handling and logging

- Do not silently swallow errors, downgrade a security check, or continue after a failed validation; fallbacks must be explicit, observable, and safe by default.
- Do not log raw secrets, credentials, tokens, cookies, private keys, or PII. Findings must identify a secret's location without quoting its value.
