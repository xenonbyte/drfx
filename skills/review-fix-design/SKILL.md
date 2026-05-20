---
name: review-fix-design
description: Review and fix DESIGN documents through the shared document-review-loop workflow.
---

# review-fix-design

Fixed document type: DESIGN.

Users must not pass type. This entry skill always treats the target as a `DESIGN` for UX, UI, product design, architecture design, system design, and workflow design documents.

Invocation syntax:

```text
review-fix-design target=<path> [ref=<path>...] read-only|review-and-fix [strict|normal] [assurance=practical|strict-verified|advisory] [resume] [ledger=<target-local path>] [root=<project-root>]
```

`read-only` or `review-and-fix` is required to start workflow. If no mode is provided, explain usage only: do not read target/reference files, do not run `drfx workflow`, do not create state, and do not declare review results.

`assurance=practical|strict-verified|advisory` controls runtime assurance. `strict` and `normal` are review strictness only.

Practical Mode requires a live reviewer subagent probe that returns exactly `DRFX_REVIEWER_READY`, plus verified stdin handoff for semantic payloads. If subagent delegation is unavailable or invalid, downgrade only through the allowed advisory downgrade reasons. If fingerprint guard or stdin handoff is unavailable, fail closed; stdin handoff failure is `unsafe-handoff-file`.

Strict Verified requires a same-flow `drfx check --json` descriptor path and `runId`. It does not use cached or installer-default descriptors. The internal workflow command decides whether strict proof is valid.

Automatic writes require `review-and-fix`, a tracked clean HEAD-backed git target, target-only guard success, and target-local lock refresh. Fixers and coordinators may modify only the target document; references remain read-only.

Persistent state lives under `.docs-review-fix/targets/<target-key>/`. One-shot read-only without `ledger=` and without `resume` is no-state and keeps tokens in memory only.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/common.md`
- `shared/rubrics/design.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
