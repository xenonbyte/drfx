# Changelog

## 0.3.0 - 2026-05-31

### Added

- Manifest schema v2 records Codex skill directory tree metadata so uninstall can verify generated directory contents before removal.
- Snapshot guard monitoring now supports opaque file symlink entries and reports infrastructure directory exclusions through `monitorScope`.

### Fixed

- Uninstall now keeps user-modified generated files, retains a narrowed manifest for those files, and reports partial uninstall status.
- Snapshot guard now excludes common infrastructure directories unless the target or explicit references live inside them, while continuing to block unsupported directory symlinks.

### Internal

- Removed `test/` from the npm package whitelist and added package-content coverage.
- Added audit remediation docs and implementation plan updates for the 2026-05-31 review pass.

## 0.2.1 - 2026-05-31

### Added

- Review-and-fix convergence controls, including fix-attempt caps and stopped-no-progress outcomes.
- Fix-effectiveness checks, severity anchors, and re-review regression guidance for generated workflows.

### Fixed

- Rejected no-op subsequent fixes during multi-cycle review-and-fix runs.
- Scoped coverage wording to PASS Summary output.
- Preserved `guard=git` rollback behavior across multi-cycle review-and-fix flows.

### Internal

- Added and refined implementation plans for review-fix workflow quality improvements.

## 0.2.0 - 2026-05-27

### Added

- `guard=snapshot` opt-in route mode for non-git rollback/guard flows, including snapshot capture/restore and end-to-end workflow coverage.
- Bare-path invocation as the recommended form, for example `review-fix-spec docs/spec.md`.
- Simplified Chinese README at `docs/README.zh-CN.md`.

### Changed

- Split `lib/workflow.js` into `lib/workflow/*` modules while preserving existing public CLI behavior.
- Distinguished user-facing blocker wording for `rollback-unavailable`, `target-only-guard-unavailable`, and `unexpected-worktree-change`.
- Downgraded unknown `.md` custom rules to warnings in `normal` strictness (still blocking in `strict`).
- Shared Codex runtime-flag documentation through `shared/runtime-flags.md`.

### Fixed

- Propagated `guard=snapshot` through generated Claude, Codex, and Gemini workflow commands.
- Hardened snapshot guard restore and target-only checks against symlink parent replacement and cross-directory non-target edits.
- Removed package lifecycle hooks that hid tracked localized README files during `npm pack`.

### Internal

- Archived `design/DESIGN-v1.md` and `design/DESIGN-v2.md` to `design/archive/`.
- Compacted and refreshed `CONTINUITY.md` for 0.2.0 handoff state.
