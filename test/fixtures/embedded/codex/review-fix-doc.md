## Embedded Shared Content

Codex copied shared source mode is active. The full shared prompt, rubric, and workflow text is intentionally not embedded inline in this `SKILL.md`.

Before reading target/reference bodies, running probes, or invoking any `drfx workflow` command, resolve this skill directory offline and verify both ownership markers are present and readable:

- `.drfx-owned`
- `shared/.drfx-owned`

Then read these required copied shared source files from this skill directory, in this order:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/common.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

If any ownership marker or required copied shared source file is missing, unreadable, outside this skill directory, or not a regular file, fail closed with a concise `Blocked:` result before workflow invocation.

Do not silently fall back to package source files, `~/.drfx/shared`, runtime memory, chat history, network fetches, or stale copies. Debug output may include the verified copied-source artifact paths, but it must not print raw shared source bodies unless explicitly requested for diagnosis.
