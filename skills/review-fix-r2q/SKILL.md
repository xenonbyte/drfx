---
name: review-fix-r2q
description: Review and fix an r2p requirement plan (07-plan.md) through the shared review-fix loop workflow.
---

# review-fix-r2q

Review target: an r2p requirement directory `<project>/.req-to-plan/WF-*`.

This entry skill reviews the requirement plan (`07-plan.md`) against its owning upstream docs (`03–06`) inside the same requirement directory. It has a fixed document type: PLAN. Users must not pass `type`.

Invocation syntax:

```text
review-fix-r2q target=<requirement-dir> [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]
```

Full form: `review-fix-r2q target=<requirement-dir> ...`. A bare requirement directory is shorthand for `target=<requirement-dir>`. The target is the requirement directory, not a single `.md` file.

This route accepts only the tokens above. It does not accept `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, `scope=`, or `base=`; it has a fixed PLAN rubric and no reference-document surface.

Valid target invocations may omit mode. Codex, Claude Code, and opencode generated routes select `review-and-fix` (internally materializing `practical` assurance) by default when mode is omitted. Gemini generated routes select `read-only` and are advisory-only. Help-style or invalid invocations explain usage only and do not read files, run workflow commands, run probes, create state, or declare review results.

Review anchor and backward-fix scope: the review judges `07-plan.md`. The deterministic write boundary is the resolved `03–07` file set — fix plan-local execution defects directly in `07-plan.md`, and when a finding's root cause is upstream edit the owning upstream doc (`03–06`) and re-align the affected `07-plan.md` section. Never edit `run.md` or any file outside `03–07`.

`run.md` is a protected read-only gate: it is read to confirm the plan stage is generated/approved, never written. Any drift in `run.md` (or in the `03–07` file set) makes stored eligibility stale, so a drifted run can never claim a workflow PASS.

`rounds=<n>` sets the maximum repair-loop count for review-and-fix; it is unsupported with `read-only`.

`resume` continues target-local state. `reset` archives existing target-local state and starts fresh. `resume` and `reset` are mutually exclusive.

Pass `debug` to print redacted workflow audit details. Default output is concise and must not expose raw workflow JSON, prompt text, subagent transcripts, or internal issue IDs in `Issues:`, `Fixed:`, or `Unfixed:` lists.

Automatic requirement-directory writes require `review-and-fix` plus a selected guard mode (default `snapshot`): use `guard=git` with a clean worktree before the first fix and route-owned changes that stay inside the resolved `03–07` file set, or `guard=snapshot` with a valid snapshot rollback anchor. `run.md` must remain unchanged.

Persistent state lives under `.drfx/targets/<target-key>/`. One-shot read-only without `resume` or `reset` is no-state and keeps tokens in memory only.

Gemini is advisory-only: it produces read-only findings, does not edit files, and cannot claim a workflow PASS.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/common.md`
- `shared/rubrics/plan.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `stopped-no-progress`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
