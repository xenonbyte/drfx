# Changelog

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

### Internal

- Archived `design/DESIGN-v1.md` and `design/DESIGN-v2.md` to `design/archive/`.
- Compacted and refreshed `CONTINUITY.md` for 0.2.0 handoff state.
