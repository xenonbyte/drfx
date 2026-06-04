# Changelog

## 0.4.1 - 2026-06-04

File-set (PR/CODE) review-fix lifecycle hardening, agent/tool state exclusions, and a new `reset` token.

### Added

- `reset` token (PR/CODE/document routes): archives the existing target state to `.drfx/archived/<target-key>-<timestamp>` — never deleting it — and starts fresh under the current resolver policy. It is the explicit escape when stale state can no longer be resumed, and is mutually exclusive with `resume`.
- CODE review and snapshot monitoring now exclude local agent/tool state directories (`.claude`, `.codex`, `.codegraph`, `.gemini`, `.req-to-plan`) so their churn no longer destabilizes the file-set fingerprint.

### Changed

- `record-review` re-anchors the stored file-set identity to the validated reviewed set, so `begin-fix` and `finalize` compare against what was actually reviewed rather than the start-time snapshot. This removes spurious `unexpected-worktree-change` blocks after benign or policy drift.
- CODE resume tolerates additive default-exclusion drift when the file-set fingerprint is unchanged.

### Fixed

- `abort-fix` restores monitored files from the persisted baseline bodies instead of blocking as `rollback-unavailable`.
- A fix round blocked as `fix-report-mismatch` or `unexpected-worktree-change` can be retried through `begin-fix` without consuming a fix attempt.
- Workflow `--*-stdin` payload flags now read piped stdin; previously they always received empty input.

## 0.4.0 - 2026-06-04

Renamed to `@xenonbyte/drfx` and added code review routes. This is a breaking release; see Migration below.

### Added

- `review-fix-pr` route: review a `base..HEAD` pull request diff (local git only — never fetches).
- `review-fix-code` route: review a source scope or the whole project root.
- File-set review-and-fix workflow for PR/CODE routes: git or snapshot guards, a `rounds=<n>` repair limit, worktree-content identity, explicit/stale resume, and a no-COMMON 4-layer rule stack.
- CLI commands `drfx version`, `drfx status` (installed routes per platform), and `drfx help`.
- MIT `LICENSE`.

### Changed

- Renamed the package `@xenonbyte/document-review-fix` to `@xenonbyte/drfx`.
- Renamed the runtime state directory `~/.docs-review-fix` to `~/.drfx` and the ownership marker `.document-review-loop-owned` to `.drfx-owned`.
- Renamed `drfx check` to `drfx doctor`; the strict-verified proof is now `drfx doctor --platform <platform> --json`.
- Made `--platform` optional for `install` and `uninstall` (omit it to target all platforms).
- Restructured the English and Chinese READMEs into a usage-doc layout.

### Fixed

- `drfx status` no longer reports a corrupt or incomplete manifest as installed; it validates the manifest shape and reports an invalid manifest instead.

### Migration

Uninstall with the old `@xenonbyte/document-review-fix` package first, then `npm install -g @xenonbyte/drfx` and re-run `drfx install`. Old capability descriptors and `~/.docs-review-fix` / `.document-review-loop-owned` state are not recognized by the renamed runtime.

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
