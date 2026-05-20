# V2 Manual Smoke Receipts

Date: 2026-05-21

These receipts record what could be executed from this non-interactive shell. Live generated Codex skill invocation and live Claude Code command invocation are not exposed here, so no Practical PASS is claimed from manual smoke. Deterministic coverage is provided by `node --test test/workflow-e2e.test.js`.

## Codex Practical

- Fixture target: `test/fixtures/workflow/practical-target.md`
- Install command: `node bin/drfx.js install --platform codex`
- Install result: `installed: codex`
- Invocation: generated Codex route with `review-and-fix assurance=practical` was not invoked because the live generated-skill runtime is not available from this shell.
- Final status: no live route final response produced.
- Assurance: not established; Practical PASS not claimed.
- State directory: none created by manual smoke.
- Target diff: none; `git diff -- test/fixtures/workflow/practical-target.md` produced no output.
- Runtime checks: subagent probe not executed; fingerprint guard not executed; stdin handoff not executed because the generated route host was unavailable.
- Acceptance: ACCEPTED-FAIL-CLOSED-LIMITED. No target edit occurred and no pass was claimed; a real Codex route smoke must still complete subagent, fingerprint, stdin handoff, diff review, and full re-review before reporting Practical PASS.

## Claude Code

- Fixture target: `test/fixtures/workflow/practical-target.md`
- Install command: `node bin/drfx.js install --platform claude`
- Install result: `installed: claude`
- Invocation: generated Claude Code command with `review-and-fix assurance=practical` was not invoked because the live Claude Code command runtime is not available from this shell.
- Final status: no live route final response produced.
- Assurance: not established; Practical PASS not claimed.
- State directory: none created by manual smoke.
- Target diff: none; `git diff -- test/fixtures/workflow/practical-target.md` produced no output.
- Runtime checks: subagent probe not executed; fingerprint guard not executed; stdin handoff not executed because the generated route host was unavailable.
- Acceptance: ACCEPTED-FAIL-CLOSED-LIMITED. No target edit occurred and no pass was claimed; a real Claude Code route smoke must still complete Practical prerequisites or prove the documented Advisory downgrade/fail-closed behavior before reporting acceptance.
