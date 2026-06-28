# PLAN-TASK-013 Report

Status: completed

## Scope delivered

- Rewrote the `review-fix-r2p` skill, route-contract fragments, invocation-gate fragments, and prompt text to the new `workId=<WF-...>` / active-run / read-only-artifacts / repair-command model.
- Kept the generator/template surfaces aligned so rendered route text no longer teaches `target=<requirement-dir>` or direct artifact edits for r2p.
- Updated task-owned tests and synchronized generated + embedded golden fixtures to the current rendered output.
- Trimmed `CLAUDE.md` to the new r2p model only.

## Changed files

- Docs / prompts / skill:
  - `CLAUDE.md`
  - `shared/core.md`
  - `shared/long-task.md`
  - `shared/prompts/coordinator.md`
  - `shared/prompts/fixer.md`
  - `shared/runtime-flags.r2p.md`
  - `skills/review-fix-r2p/SKILL.md`
- Generator / templates:
  - `lib/generator.js`
  - `templates/claude-command.md.tmpl`
  - `templates/codex-skill.md.tmpl`
  - `templates/gemini-command.toml.tmpl`
  - `templates/opencode-command.md.tmpl`
  - `templates/fragments/invocation-gate.r2p.{claude,codex,gemini,opencode}.md`
  - `templates/fragments/route-contract.r2p.{claude,codex,gemini,opencode}.md`
- Tests / fixtures:
  - `test/r2p-advisory.test.js`
  - `test/shared-assets.test.js`
  - `test/source-skill-descriptors.test.js`
  - `test/fixtures/generated/**/review-fix-{spec,plan,design,doc,pr,code,r2p}.*`
  - `test/fixtures/embedded/**/review-fix-{spec,plan,design,doc,pr,code,r2p}.*`

## Verification

- PASS: `node --test test/r2p-docs.test.js`
- PASS: `node --test test/r2p-advisory.test.js test/shared-assets.test.js test/source-skill-descriptors.test.js`
- PASS: `npm run syntaxcheck`
- NOT GREEN: `npm test`

## npm test residual failures

The remaining `npm test` failures are outside Task 13’s prompt/template/doc surface. They are legacy r2p suites that still expect the retired path-based / in-place-edit lifecycle and fail immediately on the new invocation contract (`workId=<WF-...>` only) or the removed direct-write flow.

Observed failing areas:

- `test/r2p-e2e.test.js`
- `test/r2p-finalize.test.js`
- `test/r2p-fix.test.js`
- `test/r2p-gate-freshness.test.js`
- `test/workflow-fileset-dispatch.test.js`

Representative failure mode:

- blocked as `invalid-r2p-invocation` because the test still invokes `review-fix-r2p target=<requirement-dir> ...`
- or still expects the retired `begin-fix` / `end-fix` / in-place artifact-edit lifecycle

## Concerns

- Full-suite green still requires a separate sweep of the older r2p runtime tests listed above. That work is broader than PLAN-TASK-013’s owned surface and was not changed here.
