# PLAN-TASK-013 Fix Report 2

Status: completed with concern

## Findings fixed

1. Important - Gemini generated `review-fix-r2p` route no longer renders legacy rollback / target-only-guard blocker wording.
   - Replaced the hard-coded Gemini blocker prose in `templates/gemini-command.toml.tmpl` with the shared route-aware `{{PREFLIGHT_BLOCKED_OUTPUT}}` placeholder.
   - Evidence in rendered Gemini r2p shell now reads:
     - `Blocked: \`review-fix-r2p workId=<WF-...>\` cannot run repair commands from the current run state.`
     - `Next: rerun with \`read-only\` ... so \`r2p-reopen\` or \`r2p-gap-open\` can run ...`
   - The legacy strings `clean rollback anchor` and `target-only guard is unavailable or unparseable` are no longer present in the Gemini r2p shell.

2. Important - Gemini regression coverage now includes the rendered r2p route path.
   - `test/r2p-docs.test.js` now checks Gemini as well and uses `maskEmbeddedSharedContent(...)` so the assertion inspects the route shell consistently across platforms.
   - `test/shared-assets.test.js` now includes Gemini in the r2p rendered-route regression and updates Gemini shell byte baselines to the current masked snapshots.

## Changed files

- `templates/gemini-command.toml.tmpl`
- `test/r2p-docs.test.js`
- `test/shared-assets.test.js`
- `test/fixtures/generated/gemini/review-fix-spec.toml`
- `test/fixtures/generated/gemini/review-fix-plan.toml`
- `test/fixtures/generated/gemini/review-fix-design.toml`
- `test/fixtures/generated/gemini/review-fix-doc.toml`
- `test/fixtures/generated/gemini/review-fix-pr.toml`
- `test/fixtures/generated/gemini/review-fix-code.toml`
- `test/fixtures/generated/gemini/review-fix-r2p.toml`

## Verification

- PASS `node --test test/r2p-docs.test.js`
- FAIL (unrelated residual) `node --test test/r2p-advisory.test.js test/shared-assets.test.js test/source-skill-descriptors.test.js`
  - Remaining failure:
    - `test/shared-assets.test.js`: `Claude and Codex generated starts preserve materialized rounds and state-control tokens`
    - The current assertion still iterates Gemini even though Gemini has no `drfx workflow start ...` path; this is outside Task 13 review-report scope and was left unchanged.
- PASS `npm run syntaxcheck`

## Evidence

- Generated Gemini `review-fix-r2p` snapshot now contains route-state blocker guidance, not rollback/guard guidance.
- Gemini generated shell snapshots were refreshed in masked-shell form so the regression suite compares the correct shell representation.

## Notes

- I left unrelated worktree files untouched, including existing `.req-to-plan` run artifacts and the pre-existing `run.md` modification.
