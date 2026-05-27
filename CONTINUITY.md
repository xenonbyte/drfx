# Snapshot

- 2026-05-27 [USER] Current branch `0.2.0-optimization`; implement Phase 3-8 Tasks 20-26.
- 2026-05-27 [CODE] Worktree initially had unrelated untracked `design/OPTIMIZATION-2026-05-27.md`; leave untouched.

# Decisions

- 2026-05-27 [CODE] Bare target path is the recommended invocation form; `target=<path>` remains supported as full form.
- 2026-05-27 [CODE] Unknown `.md` rule files warn in `normal` strictness and block in `strict`.
- 2026-05-27 [CODE] `README.zh-CN.md` is repo documentation only and remains outside `package.json files`.

# Done

- 2026-05-27 [CODE] Added tests for route usage text, blocker wording, rule warnings, `drfx check` warnings, and `workflow start` warnings.
- 2026-05-27 [CODE] Archived `design/DESIGN-v1.md` and `design/DESIGN-v2.md` under `design/archive/`.

# Now

- 2026-05-27 [CODE] Implementing Tasks 20-26 and preparing verification.

# Next

- 2026-05-27 [CODE] Run targeted tests, full `node --test`, `npm pack --dry-run`, then commit 1-3 changesets.

# Receipts

- 2026-05-27 [TOOL] Red tests observed for `test/rulebook.test.js`, `test/shared-assets.test.js`, `test/capability-check.test.js`, and `test/workflow-args.test.js` before implementation.
