# CODE Rubric

Use for focused code review of a file, module, or code area. Apply this rubric to evaluate the correctness, design, and safety of the code under review. This rubric is self-contained: route-kind reviews have no COMMON layer, so do not apply `shared/rubrics/common.md`.

## Actionable-only triage boundary

Raise findings only when there is a concrete, actionable problem. Do NOT raise blocking findings for:

- Pure style preferences (naming conventions, whitespace, comment style) when they do not affect correctness or understanding.
- No-risk refactors that are behavior-equivalent and are not the stated purpose of the review.
- Over-abstraction opinions when the existing structure is internally consistent and functional.

A finding is blocking only when it affects correctness, architecture integrity, safety, test coverage, or behavioral contracts in a material way.

## Priority-scan surfaces

When reviewing code, prioritize these surfaces first, as defects there carry the highest blast radius:

- Entry points: main functions, CLI handlers, script entry points, and command dispatch — incorrect parsing or dispatch propagates through the whole system.
- Public API: exported functions, classes, and modules — incorrect signatures or contracts break callers.
- CLI: argument parsing, flag validation, help text, and error output — user-facing correctness and security.
- Config and schema: configuration loading, validation, defaults, and schema shape — silent misconfiguration causes runtime failures.
- Template generation: code that generates files, renders templates, or produces platform-specific output — defects produce systematically wrong artifacts.
- Install and uninstall safety: file writes, atomic renames, backup/restore, manifest recording, and rollback — defects here corrupt installations or leave orphaned state.
- State machine: state transitions, terminal conditions, and invariant preservation — incorrect state handling causes inconsistent or non-recoverable runtime state.
- Persistence: file I/O, manifest reads/writes, caches, and serialization — data loss or corruption risk.
- Test fixtures: fixture setup, teardown, and isolation — fixture defects produce unreliable test results that hide real bugs.
- Cross-platform branches: OS-specific guards, path normalization, symlink handling, and file permission logic — defects surface only on specific environments.

## Coverage groups

Review for:

- Correctness: logic is correct — no off-by-one errors, wrong conditions, incorrect state transitions, missing null/undefined guards, or incorrect data transformations.
- Architecture: the structure and boundaries of modules, classes, and functions are appropriate. Concerns are separated. Dependencies flow in a sensible direction. No circular imports or hidden coupling.
- State-and-io: state is managed explicitly. I/O is bounded and error-handled. Async operations are correctly awaited or handled. Side effects are visible and intentional.
- Safety: inputs are validated at trust boundaries, error paths are handled explicitly, sensitive data is not leaked in logs or outputs, and destructive operations are guarded appropriately.
- Tests: the code has adequate test coverage for its intended behavior. Tests are reliable, isolated, and do not depend on global mutable state or timing.
- Contracts: public interfaces, exported types, configuration shapes, event schemas, and file formats behave according to their documented or implied contracts.
- Maintainability: the code does not introduce hidden complexity, unexplained magic values, silent fallbacks, or speculative abstractions beyond a present requirement. It is readable and followable by the next contributor without the author present.
- Platform: platform-specific behavior is explicitly guarded. Cross-platform paths, file permissions, symlink handling, and environment assumptions are visible and correct.

## Blocking findings

Blocking findings include incorrect logic, unhandled error paths that could cause data loss or incorrect program state, missing tests for new behavior, broken public interface contracts, and security or privacy violations.

PASS for `CODE` means the code is correct, architecturally sound, safely handles errors and I/O, adequately tested, and leaves the codebase in a maintainable state.

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

## Partitioned project review

When a whole-root review is too large for one pass, the route runs as **partitioned project review**: the project is split into review **units** that never split a file; each unit is reviewed in a **bounded** context — only that unit's file bodies, the merged rules, and the unit's `suggestedRefs` (the in-root files it `require()/import`s) as read-only references. The reviewer may read those refs up to the contract-read budget; any read beyond budget, any metadata-only review, or any property it cannot positively confirm is recorded `coverage_risk: high` (honest non-confirmation, never a silent pass).

**A unit PASS is NOT a project PASS.** Project PASS is earned only when every unit AND the crosscutting backstop report `coverage_risk: none`, all findings are triaged, and no open high/medium remains. Any miss ends `stopped-with-deferrals` + `coverage-incomplete` — never PASS.

A **cross-unit finding MUST name the specific dependency edge / caller path** it relies on (the `suggestedRefs` entry or the caller→callee path), never a vague "some other module."

The four **locally-checkable disciplines** (each verifiable inside one unit without whole-project context):

1. **redaction-at-write-boundary** — secrets/tokens/credentials/cookies/private keys/raw logs must be redacted at every persistence/write boundary (workflow state, receipts, generated prompts).
2. **identity-field-coverage** — any fingerprint/identity projection must cover every identity-bearing field; a silently dropped field is a finding.
3. **allowlist-only-git** — git invocations stay within the read-only allowlist; no fetch/push/remote/branch/ref mutation.
4. **status/phase legality** — status + phase combinations must be legal per the state machine; no active-status misuse or fabricated PASS.
