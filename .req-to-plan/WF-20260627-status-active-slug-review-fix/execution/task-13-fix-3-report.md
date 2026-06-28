# PLAN-TASK-013 Fix Report 3

Status: completed

## Findings fixed

1. Important - fully rendered `review-fix-r2p` routes no longer leak legacy `rollback-unavailable` / `target-only-guard-unavailable` blocker language.
   - Added route-aware rendered wording in `lib/generator.js` for r2p embedded shared content and preflight-blocker guidance.
   - Kept shared source files unchanged; only the rendered r2p route surface is rewritten away from rollback-anchor / target-only-guard language and into the `workId` / run-state / repair-command model.
   - Updated `templates/claude-command.md.tmpl`, `templates/codex-skill.md.tmpl`, and `templates/opencode-command.md.tmpl` to consume the route-aware preflight blocker wording.
   - Refreshed r2p generated/embedded fixtures for the affected rendered routes.

2. Important - regression coverage now inspects the full rendered r2p routes, including Gemini, for the retired blocker vocabulary.
   - `test/r2p-docs.test.js` now scans full rendered `review-fix-r2p` output for all four platforms instead of masked shells.
   - `test/shared-assets.test.js` now asserts full rendered r2p routes do not contain `rollback-unavailable`, `target-only-guard-unavailable`, rollback-anchor prose, or target-only-guard blocker prose.

3. Important - `test/shared-assets.test.js` no longer incorrectly expects Gemini to emit command-style `drfx workflow start ...` lines.
   - Narrowed the start-command assertion to the command-style platforms (`claude`, `codex`, `opencode`).
   - Kept Gemini covered with an r2p-specific assertion that its advisory route still documents the non-user-facing guard model without inventing a `start` flow.
   - Updated the Codex copied-source de-dup expectation block and r2p snapshots to match the intentional rendered-route change.

## Changed files

- `lib/generator.js`
- `templates/claude-command.md.tmpl`
- `templates/codex-skill.md.tmpl`
- `templates/opencode-command.md.tmpl`
- `test/r2p-docs.test.js`
- `test/shared-assets.test.js`
- `test/fixtures/generated/claude/review-fix-r2p.md`
- `test/fixtures/generated/codex/review-fix-r2p.md`
- `test/fixtures/generated/opencode/review-fix-r2p.md`
- `test/fixtures/embedded/claude/review-fix-r2p.md`
- `test/fixtures/embedded/gemini/review-fix-r2p.toml`
- `test/fixtures/embedded/opencode/review-fix-r2p.md`

## Verification

- PASS `node --test test/r2p-docs.test.js`
- PASS `node --test test/r2p-advisory.test.js test/shared-assets.test.js test/source-skill-descriptors.test.js`
- PASS `npm run syntaxcheck`

## Evidence

- Fresh rendered-route scan across `claude`, `codex`, `gemini`, and `opencode` returns no match for:
  - `rollback-unavailable`
  - `target-only-guard-unavailable`
  - rollback-anchor blocker prose
  - target-only-guard blocker prose
- Fresh rendered r2p blocker text now reads in the run-state model:
  - `Blocked: review-fix-r2p workId=<WF-...> cannot run repair commands from the current run state.`
  - `Next: rerun with read-only ... or restore the active run so r2p-reopen or r2p-gap-open can run ...`

## Notes

- I left unrelated worktree state untouched, including the pre-existing `.req-to-plan/.../run.md` modification and unrelated untracked review artifacts.
