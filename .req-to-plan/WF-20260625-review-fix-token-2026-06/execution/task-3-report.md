# PLAN-TASK-003 Report

Status: complete

Date: 2026-06-25

## Changed Files

- `lib/generator.js`, `lib/install.js`
- `shared/runtime-flags.md`, `shared/runtime-flags.r2q.md`
- `templates/claude-command.md.tmpl`, `templates/codex-skill.md.tmpl`, `templates/gemini-command.toml.tmpl`, `templates/opencode-command.md.tmpl`
- `test/shared-assets.test.js`, `test/workflow-json-baseline.test.js`, `test/capability-check.test.js`, `test/r2q-advisory.test.js`, `test/helpers/route-shell-snapshot.js`
- Generated shell fixtures under `test/fixtures/generated/{claude,codex,gemini,opencode}/`
- Codex embedded fixtures under `test/fixtures/embedded/codex/`

## RED Evidence

Added failing tests before implementation for compact route workflow commands, compact/full byte-ratio budgets, generated shell byte budgets, and Codex shared de-dup measurement/gate behavior.

Initial RED command:

```text
node --test test/shared-assets.test.js test/workflow-json-baseline.test.js
```

Observed RED result: 106 tests, 102 pass, 4 fail. Failures covered:

- generated route workflow commands still used bare `--json` instead of `--json=compact`
- Codex de-dup measurement gate was not active (`largestShellShrinkBytes: 0`, `gateEntered: false`)
- existing full-re-review/no-state route regex expectations still matched bare `--json`

## Measurement Result And Gate Decision

Codex measurement recorded in `test/shared-assets.test.js`:

- route bytes: 569562
- embedded shared bytes: 408089
- copied shared bytes: 406124
- duplicate bytes: 406124
- largest shell shrink bytes: 58655
- largest shell shrink percent: 65.83
- any Codex route would grow: false
- gate entered: true

Decision: entered the guarded implementation phase because the largest route shrink is at least 16 KiB, at least 12%, no Codex route grows, and fail-closed install/runtime guidance tests pass.

## Implementation Summary

- Switched automated generated-route `drfx workflow ... --json` invocations to `--json=compact`; left user-facing `doctor/status --json` boolean behavior intact.
- Kept debug guidance for artifact paths and `drfx workflow ... --json=full` outputs.
- Added compact/full byte-ratio tests for normal context and partitioned context.
- Added platform x route shell size budgets using `max(4096, ceil(baselineBytes * 0.08))` with diagnostic failure messages.
- Split Codex route generation into embedded measurement mode and copied shared source implementation mode.
- Added manifest-owned Codex copied shared source files, offline route guidance, ownership markers, and fail-closed install plan validation.
- Refreshed affected generated and embedded fixtures.

## Verification

Final GREEN commands:

```text
node --test test/shared-assets.test.js test/workflow-json-baseline.test.js
node --test test/capability-check.test.js test/cli.test.js
node --test test/r2q-advisory.test.js
npm test
npm run syntaxcheck
```

Final GREEN evidence:

- `test/shared-assets.test.js` + `test/workflow-json-baseline.test.js`: 106/106 pass
- `test/capability-check.test.js` + `test/cli.test.js`: 56/56 pass
- `test/r2q-advisory.test.js`: 5/5 pass
- `npm test`: 1244/1244 pass
- `npm run syntaxcheck`: passed, 98 files checked
