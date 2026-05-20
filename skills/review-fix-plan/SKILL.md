---
name: review-fix-plan
description: Review and fix PLAN documents through the shared document-review-loop workflow.
---

# review-fix-plan

Fixed document type: PLAN.

Users must not pass type. This entry skill always treats the target as a `PLAN` for implementation plans, migration plans, rollout plans, refactor plans, and execution checklists.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/common.md`
- `shared/rubrics/plan.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
