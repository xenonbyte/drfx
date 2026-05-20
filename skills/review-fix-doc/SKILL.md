---
name: review-fix-doc
description: Review and fix COMMON documents through the shared document-review-loop workflow.
---

# review-fix-doc

Fixed document type: COMMON.

Users must not pass type. This entry skill always treats the target as `COMMON` for generic documents that do not fit `SPEC`, `PLAN`, or `DESIGN`.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/common.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
