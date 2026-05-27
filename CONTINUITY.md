# Snapshot

- 2026-05-27 [USER] Execute `docs/superpowers/plans/2026-05-27-0.2.0-optimization-implementation-plan.md` on branch `0.2.0-optimization`.
- 2026-05-27 [CODE] Phase 1-2 complete: workflow modular split + `guard=snapshot` (with snapshot path symlink-hardening).
- 2026-05-27 [CODE] Phase 3-8 complete: bare-path docs/templates, blocker wording split, rules warning downgrade, zh-CN README, design archive, runtime-flags shared block.
- 2026-05-27 [CODE] Review follow-up fixed: write preflight now honors `guard=snapshot`; packaging no longer hides tracked README files.
- 2026-05-27 [CODE] Second review follow-up fixed: generated routes pass materialized guard tokens; snapshot target-only guard monitors target directory trees.
- 2026-05-27 [CODE] Third review follow-up fixed: snapshot restore rejects missing targets when an existing parent was replaced by a symlink.
- 2026-05-27 [CODE] Fourth review follow-up fixed: snapshot target-only guard now monitors the project tree and blocks non-target changes outside the target directory.

# Decisions

- 2026-05-27 [CODE] Unknown `.md` rule files are warnings in `normal`, blocking in `strict`.
- 2026-05-27 [CODE] `docs/README.zh-CN.md` stays repo-only; top-level README points to GitHub `docs/README.zh-CN.md` because npm forcibly packs top-level `README*.md`.
- 2026-05-27 [CODE] Keep unrelated untracked `design/OPTIMIZATION-2026-05-27.md` untouched.

# Done (recent)

- 2026-05-27 [CODE] Archived `design/DESIGN-v1.md` and `design/DESIGN-v2.md` to `design/archive/`.
- 2026-05-27 [CODE] Added workflow warnings propagation for start/context/no-state context + tests.
- 2026-05-27 [CODE] Removed `prepack`/`postpack` README rename hook and deleted `scripts/pack-readme-zh.js`.
- 2026-05-27 [CODE] Added route text tests for `guard=<selectedGuard>` on workflow commands.
- 2026-05-27 [CODE] Added snapshot guard tests for nested and cross-directory non-target changes plus project tree monitor scope.
- 2026-05-27 [CODE] Added snapshot restore regression test for deleted target plus symlinked parent escape.
- 2026-05-27 [TOOL] `npm test` passing (391/391) after fourth review fix.

# Now

- 2026-05-27 [CODE] Review fixes through fourth P1 are implemented and verified locally; current changes are not committed.

# Next

- 2026-05-27 [CODE] If requested, commit accumulated review-fix changes on `0.2.0-optimization`; leave unrelated untracked design draft untouched.

# Working set

- 2026-05-27 [CODE] `lib/generator.js`
- 2026-05-27 [CODE] `lib/snapshot-guard.js`
- 2026-05-27 [CODE] `shared/runtime-flags.md`
- 2026-05-27 [CODE] `templates/claude-command.md.tmpl`
- 2026-05-27 [CODE] `templates/codex-skill.md.tmpl`
- 2026-05-27 [CODE] `templates/gemini-command.toml.tmpl`
- 2026-05-27 [CODE] `test/shared-assets.test.js`
- 2026-05-27 [CODE] `test/snapshot-guard.test.js`

# Receipts

- 2026-05-27 [TOOL] `npm pack --dry-run --json` with temp npm cache reports readmes: `README.md` only.
- 2026-05-27 [TOOL] `node --test test/workflow-e2e.test.js test/shared-assets.test.js test/snapshot-guard.test.js` passes 74/74.
- 2026-05-27 [TOOL] `node --test test/snapshot-guard.test.js test/workflow-e2e.test.js` passes 23/23.
- 2026-05-27 [TOOL] `node --test test/snapshot-guard.test.js test/workflow-e2e.test.js test/fix-guard.test.js` passes 51/51.
- 2026-05-27 [TOOL] `npm test` passes 391/391.
