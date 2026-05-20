# Document Review Loop Core

This file is the shared workflow source for `review-fix-spec`, `review-fix-plan`, `review-fix-design`, and `review-fix-doc`. Entry skills fix the document type; users must not pass type.

## Loop

Canonical loop:

```text
review -> triage -> fix -> diff review -> full re-review -> repeat until PASS or a defined terminal/pause state
```

The initial `review` and every `full re-review` must inspect the whole target document through an isolated read-only reviewer task. A `diff review` after fixes is mandatory, but it is only a gate before the next full-document re-review.

## Roles

- Coordinator: owns the loop, reads instructions and rules, dispatches reviewer work, triages findings, manages target state, applies fixes by default, performs diff review, and decides terminal status.
- Reviewer: mandatory isolated read-only critic for every initial review and full re-review. The reviewer reports `PASS` or structured `FAIL` findings and must not edit files.
- Fixer: the coordinator by default. A fixer subagent is optional, bounded, serial, and may modify only the target document for accepted issue IDs.

The coordinator is the only role allowed to mark workflow PASS.

## PASS Criteria

General PASS requires:

- The relevant full-document review returns `PASS`, or returns only low issues that the coordinator explicitly accepts as non-blocking in normal mode.
- The coordinator independently agrees with the reviewer result.
- No unresolved high or medium issues remain.
- Accepted high and medium issues are fixed, merged into fixed issues, downgraded with rationale, or rejected with rationale.
- Deferred high or medium issues are not treated as PASS; they stop as `stopped-with-deferrals`.
- Required sections contain no blocking placeholders such as `TBD`, `TODO`, `later`, or "to be discussed".
- Scope, constraints, assumptions, risks, and verification path are clear enough for the selected document type.

Strict PASS additionally requires unresolved low issues to be fixed or explicitly accepted as non-blocking and carried into later reviewer context.

## Terminal And Pause States

The loop stops only at one of these states:

- `pass`: the full-document review gate passes and the coordinator agrees.
- `stopped-with-deferrals`: high or medium issues are intentionally deferred with reason and owner; final response includes issue IDs, reasons, owners, and next action.
- `read-only-findings`: read-only mode found issues that block PASS under the selected strictness.
- `blocked`: the workflow cannot continue until a concrete blocker is resolved.
- `unsupported`: the runtime lacks verified reviewer isolation for automatic review-fix work.
- `externally-changed`: the target changed outside the current lock or known fix round.
- `possible-target-replacement`: the same path appears to contain a different document.
- user stop: the user explicitly stops the loop.
- `checkpoint`: the task pauses with durable target-local state and a concrete next action.

## Reviewer Guard

Before dispatching a reviewer, record SHA-256, file size, and modified timestamp for the target and all reference documents. After the reviewer returns, recompute the same fingerprints.

If any target or reference fingerprint changed and the coordinator did not intentionally write the file, stop as `blocked: reviewer-mutated-file`. Report the changed path and ask for user confirmation before restoring, continuing, or discarding state. Do not fix or claim PASS after a reviewer mutation.

Prompt-only read-only instructions are not enough for automatic PASS. Automatic review-fix work requires verified isolated reviewer execution, verified reviewer write blocking, and an available fingerprint guard. Runtimes without those capabilities may provide advisory review only.

## Triage

The coordinator triages every reviewer finding before fixing:

- `accepted`: valid and should be fixed.
- `merged`: duplicate or covered by another issue.
- `downgraded`: valid but lower severity, with rationale.
- `rejected`: incorrect, out of scope, or based on a false premise, with rationale.
- `deferred`: valid but intentionally not fixed now, with reason and owner.

Accepted high and medium issues block PASS until resolved. Deferred high and medium issues stop as `stopped-with-deferrals`, not PASS. Low issues are non-blocking in normal mode unless they affect the objective; low issues block strict PASS unless explicitly accepted as non-blocking.

## Fixer Constraints

Fix accepted issues directly by default. Use one serial fixer subagent only when the accepted issue list is bounded, every issue has a clear ID and location, and the fixer can work from a compact context pack.

Fixers must:

- Modify only the target document.
- Treat reference documents as read-only.
- Fix only coordinator-accepted issue IDs unless the coordinator expands scope.
- Preserve intent, terminology, and structure where possible.
- Avoid broad rewrites unless a confirmed issue requires structural repair.
- Not invent background, goals, requirements, external facts, product decisions, or risk decisions.
- Redact sensitive values as `[REDACTED:<kind>]` in reports, ledgers, receipts, and final responses.

## Diff Review

After each fix round, the coordinator reviews the changed target and confirms:

- Every claimed fix maps to an accepted issue.
- No unrelated scope was introduced.
- Terminology and structure remain coherent.
- No required-section placeholder was added.
- Sensitive values were not copied into workflow state or responses.

Diff review is not sufficient for PASS. It only allows the next full re-review.

## Final Response Contract

Final responses must state:

- Final status: one of the terminal or pause states above.
- Changes made, including issue IDs when available.
- Files changed, limited to files actually modified.
- Verification performed, including reviewer passes and any local checks.
- Not fixed items, deferrals with issue IDs, reason, owner, and next action, blockers, or unsupported capability reasons.
- Residual risk, or `none identified`.

Do not print raw secrets, credentials, cookies, tokens, private keys, raw sensitive logs, or partial secret values. Use `[REDACTED:<kind>]` and location anchors.

## Read-Only Behavior

In `read-only` mode, review and triage only. Do not modify the target document or reference documents. If blocking findings remain, stop as `read-only-findings` and report how to rerun in `review-and-fix` mode.

One-shot `read-only` without `ledger=` and without `resume` must not create `.docs-review-fix`, `MANIFEST.md`, `ISSUES.md`, `CONTINUITY.md`, `SUMMARY.md`, or `rounds/`. Keep fingerprints in memory unless a guard failure must be reported.

## Runtime Independence

The workflow must not depend on runtime objective/session/platform memory. Durable state for long work is file-backed under `.docs-review-fix/targets/<target-key>/`, and each reviewer or fixer context pack must be self-contained enough to work without chat history.
