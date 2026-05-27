# Snapshot

- 2026-05-27 [USER] Execute `docs/superpowers/plans/2026-05-27-0.2.0-optimization-implementation-plan.md` on branch `0.2.0-optimization`.
- 2026-05-27 [CODE] Phase 1-2 complete: workflow modular split + `guard=snapshot` (with snapshot path symlink-hardening).
- 2026-05-27 [CODE] Phase 3-8 complete: bare-path docs/templates, blocker wording split, rules warning downgrade, zh-CN README, design archive, runtime-flags shared block.
- 2026-05-27 [CODE] Review follow-up fixed: write preflight now honors `guard=snapshot`; packaging no longer hides tracked README files.

# Decisions

- 2026-05-27 [CODE] Unknown `.md` rule files are warnings in `normal`, blocking in `strict`.
- 2026-05-27 [CODE] `docs/README.zh-CN.md` stays repo-only; top-level README points to GitHub `docs/README.zh-CN.md` because npm forcibly packs top-level `README*.md`.
- 2026-05-27 [CODE] Keep unrelated untracked `design/OPTIMIZATION-2026-05-27.md` untouched.

# Done (recent)

- 2026-05-27 [CODE] Archived `design/DESIGN-v1.md` and `design/DESIGN-v2.md` to `design/archive/`.
- 2026-05-27 [CODE] Added workflow warnings propagation for start/context/no-state context + tests.
- 2026-05-27 [CODE] Removed `prepack`/`postpack` README rename hook and deleted `scripts/pack-readme-zh.js`.
- 2026-05-27 [TOOL] `npm test` passing (384/384) after review fixes.

# Now

- 2026-05-27 [CODE] Review fixes are implemented and verified locally; changes are not committed.

# Next

- 2026-05-27 [CODE] If requested, commit review-fix changes on `0.2.0-optimization`; leave unrelated untracked design draft untouched.

# Working set

- 2026-05-27 [CODE] `lib/workflow/no-state.js`
- 2026-05-27 [CODE] `lib/workflow/helpers.js`
- 2026-05-27 [CODE] `package.json`
- 2026-05-27 [CODE] `README.md`
- 2026-05-27 [CODE] `docs/README.zh-CN.md`
- 2026-05-27 [CODE] `CHANGELOG.md`
- 2026-05-27 [CODE] `test/workflow-args.test.js`
- 2026-05-27 [CODE] `test/shared-assets.test.js`

# Receipts

- 2026-05-27 [TOOL] `npm pack --dry-run --json` with temp npm cache reports readmes: `README.md` only.
- 2026-05-27 [TOOL] `npm test` passes 384/384.
