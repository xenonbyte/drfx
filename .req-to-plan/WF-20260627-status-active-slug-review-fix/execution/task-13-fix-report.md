# PLAN-TASK-013 Fix Report

Status: completed

## Findings fixed

1. Major - rendered r2p routes no longer leak legacy rollback-anchor / `guard=snapshot` blocker text.
   - Added route-aware preflight-block output generation in `lib/generator.js`.
   - Updated `templates/claude-command.md.tmpl`, `templates/codex-skill.md.tmpl`, and `templates/opencode-command.md.tmpl` to consume the new placeholder instead of hard-coded rollback guidance.
   - New r2p blocker text now speaks in the `workId=<WF-...>` / active-run / `r2p-reopen` / `r2p-gap-open` model and never suggests `guard=snapshot`.

2. Minor - rendered-route regression coverage now pins the blocker text.
   - Added rendered-route assertions in `test/r2p-docs.test.js`.
   - Extended `test/shared-assets.test.js` to reject legacy rollback wording in the masked r2p route shell and to require the new run-state repair guidance.
   - Synchronized generated shell snapshots for `review-fix-r2p` on Claude, Codex, and opencode.

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

## Verification

- PASS `node --test test/r2p-docs.test.js`
- PASS `node --test test/r2p-advisory.test.js test/shared-assets.test.js test/source-skill-descriptors.test.js`
- PASS `npm run syntaxcheck`

## Evidence

- Rendered `review-fix-r2p` shells for Claude/Codex/opencode now contain:
  - `Blocked: \`review-fix-r2p workId=<WF-...>\` cannot run repair commands from the current run state.`
  - `r2p-reopen` / `r2p-gap-open` in the next-action guidance
- Rendered `review-fix-r2p` shells no longer contain:
  - `clean rollback anchor`
  - `guard=snapshot when Git rollback is unavailable`

## Notes

- I left unrelated worktree files untouched, including existing `.req-to-plan` run artifacts outside this report.
