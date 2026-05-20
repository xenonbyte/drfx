---
name: review-fix-spec
description: Review and fix SPEC documents through the shared document-review-loop workflow.
---

# review-fix-spec

Fixed document type: SPEC.

Users must not pass type. This entry skill always treats the target as a `SPEC` for requirements, product behavior, API behavior, feature definition, and acceptance documents.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/common.md`
- `shared/rubrics/spec.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
