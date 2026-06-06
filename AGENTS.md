# Repository Guidelines

## Project Structure & Module Organization

This repository is a Node.js 20 CommonJS package for installing document and code review-fix routes.

- `bin/drfx.js` is the CLI entry point.
- `lib/` contains implementation modules: input parsing, install/uninstall, manifests, capabilities, locks, ledgers, receipts, redaction, rulebooks, and route generation.
- `lib/adapters/` contains platform capability adapters for Claude, Codex, and Gemini.
- `skills/` stores source skill descriptors.
- `shared/` stores reusable workflow text, prompts, rubrics, and long-task protocol content.
- `templates/` contains generated route templates for supported platforms.
- `scripts/` contains development utility scripts such as `syntaxcheck.js`.
- `test/` contains Node test files and fixtures.

## Build, Test, and Development Commands

- `npm test` runs the full `node --test` suite.
- `npm run syntaxcheck` parse-checks (`node --check`) every `.js` file under `bin/`, `lib/`, and `test/` without executing it.
- `node bin/drfx.js doctor` runs local capability checks and validates advisory/pass capability reporting.
- `node bin/drfx.js status` reports which generated routes are installed per platform.
- `node bin/drfx.js install [--platform claude,codex,gemini]` installs generated routes for local manual testing (`--platform` is optional; omit it for all platforms).
- `node bin/drfx.js uninstall [--platform claude,codex,gemini]` removes manifest-owned generated routes.
- `npm pack --dry-run` verifies package contents before publishing or release checks.

CI (`.github/workflows/ci.yml`) runs `npm run syntaxcheck` and `npm test` on Node 20, 22, and 24 for pushes to `main` and pull requests.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and keep files plain JavaScript. Follow the existing style: two-space indentation, semicolons, single quotes, small pure helpers, and explicit error codes such as `ERR_UNKNOWN_TOKEN`. Prefer narrow modules with clear boundaries. Keep generated-route text in `shared/` or `templates/`, not embedded in implementation code.

## Testing Guidelines

Tests use Node's built-in `node:test` and `assert`. Name test files as `*.test.js` under `test/`. Add focused tests beside the behavior being changed: parser changes in `input-parsing.test.js`, manifest/state changes in `target-state.test.js`, route text checks in `shared-assets.test.js`, install behavior in `capability-check.test.js`, file-set PR/CODE lifecycle in `workflow-fileset-lifecycle.test.js`, and CLI command behavior in `cli.test.js`.

## Documentation Synchronization

When updating public README behavior, keep `README.md` and `README.zh-CN.md` structurally aligned. Preserve technical literals such as commands, paths, option names, payload fields, and status codes in English.

## Commit & Pull Request Guidelines

The git history uses concise conventional-style prefixes, for example `feat:` and `chore:`. Keep commits scoped and imperative, such as `feat: add workflow parser`. Pull requests should include a short problem statement, implementation summary, tests run, and any installer, filesystem, or security implications.

## Security & Configuration Tips

Never store raw secrets, credentials, cookies, private keys, or raw logs in workflow state, tests, receipts, or generated prompts. Preserve manifest-backed install safety: uninstall must remove only package-owned files and must not delete user rule files or project `.drfx` state.
