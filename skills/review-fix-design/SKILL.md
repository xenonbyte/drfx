---
name: review-fix-design
description: Review and fix DESIGN documents through the shared document-review-loop workflow.
---

# review-fix-design

Fixed document type: DESIGN.

Users must not pass type. This entry skill always treats the target as a `DESIGN` for UX, UI, product design, architecture design, system design, and workflow design documents.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/common.md`
- `shared/rubrics/design.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
