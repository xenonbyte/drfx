# CODE Rubric

Use for focused code review of a file, module, or code area. Apply this rubric to evaluate the correctness, design, and safety of the code under review.

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
