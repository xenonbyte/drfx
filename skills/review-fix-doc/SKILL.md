---
name: review-fix-doc
description: Review and fix COMMON documents through the shared document-review-loop workflow.
---

# review-fix-doc

Fixed document type: COMMON.

Users must not pass type. This entry skill always treats the target as `COMMON` for generic documents that do not fit `SPEC`, `PLAN`, or `DESIGN`.

Invocation syntax:

```text
review-fix-doc target=<path> [ref=<path>...] [read-only|review-and-fix] [strict|normal] [assurance=practical|strict-verified|advisory] [resume] [ledger=<target-local path>] [root=<project-root>] [debug]
```

Valid target invocations may omit mode. Codex and Claude Code generated routes select `review-and-fix assurance=practical` by default when mode and assurance are omitted; missing mode selects `review-and-fix` and missing assurance selects `practical`. Explicit `assurance=advisory` without mode selects `read-only` on Codex and Claude Code. Gemini generated routes select `read-only assurance=advisory` by default. Help-style or invalid invocations explain usage only and do not read files, run workflow commands, run probes, create state, or declare review results.

`assurance=practical|strict-verified|advisory` controls runtime assurance. `strict` and `normal` are review strictness only.

Pass `debug` to print redacted workflow audit details. Default output is concise and must not expose raw workflow JSON, prompt text, subagent transcripts, or internal issue IDs in `Issues:`, `Fixed:`, or `Unfixed:` lists.

Practical Mode requires a live reviewer subagent probe that returns exactly `DRFX_REVIEWER_READY`, plus verified stdin handoff for semantic payloads. If subagent delegation is unavailable or invalid, downgrade only through the allowed advisory downgrade reasons. If fingerprint guard or stdin handoff is unavailable, fail closed; stdin handoff failure is `unsafe-handoff-file`.

Strict Verified requires same-flow `drfx check --json` values: `descriptorPath`, `descriptorDirectory`, and `runId`. It does not use cached or installer-default descriptors. The internal workflow command decides whether strict proof is valid.

Automatic writes require `review-and-fix`, a tracked clean HEAD-backed git target, target-only guard success, and target-local lock refresh. Fixers and coordinators may modify only the target document; references remain read-only.

Persistent state lives under `.docs-review-fix/targets/<target-key>/`. One-shot read-only without `ledger=` and without `resume` is no-state and keeps tokens in memory only.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/common.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
