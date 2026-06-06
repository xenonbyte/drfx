# Changelog

## 0.6.3 - 2026-06-06

Development tooling housekeeping: honest naming for the syntax check script and CI coverage for the current Node LTS line.

### Changed

- The `typecheck` npm script is renamed to `syntaxcheck` (`scripts/syntaxcheck.js`): it runs per-file `node --check`, so the name now says what it does. Published package contents are unaffected.
- CI now also tests on Node 24 — the current LTS line users install on — alongside Node 20 and 22. Node 20 stays in the matrix while `engines` still declares `>=20`.

## 0.6.2 - 2026-06-06

Template/prompt consistency for the PR/CODE file-set routes, reason-aware blocker next actions, and a minimal CI workflow.

### Fixed

- The shared final-response machine block now documents both finalize formats: a single target path for document routes, and `Target: none` plus comma-separated in-set relative paths for PR/CODE file-set routes — matching what the payload parser already accepted, so file-set coordinators are no longer steered into a rejected single-target payload.
- Generated PR/CODE routes no longer inherit document-only fix-loop prose: new route-aware placeholders render the resolved-file-set write boundary ("edit only files inside the resolved target file set") and the real file-set guard contract (clean worktree before the first fix, route-owned in-set changes afterward). Document route output stays byte-identical.
- `file-set-too-large` and other CODE resolve blockers now carry the reason-aware next action (for example `pass scope=<path> to narrow the review`) across no-state context/preflight/record-review/record-triage/finalize, persistent context, start, and resume — instead of the generic "resolve a valid base/scope file set" line. The message already named the cause; now the suggested remedy matches it.

### Changed

- The PR/CODE source skill descriptions use the route-neutral "review-fix loop" naming, matching the generated route text.

### Added

- A minimal GitHub Actions CI workflow runs `npm run typecheck` and `npm test` on Node 20 and 22 for pushes to `main` and pull requests.

## 0.6.1 - 2026-06-06

`review-fix-code` file-set discovery now honors version-control ignores, gives `.drfxignore` full gitignore syntax, and accepts file scopes — with scope always winning over every ignore source.

### Added

- Version-control-ignored files are excluded from CODE review automatically: one local read-only `git ls-files --others --ignored --exclude-standard --directory` query captures the full gitignore stack (nested `.gitignore` files, the global excludes file, `.git/info/exclude`) with git's own semantics — tracked files are never version-ignored. Non-git roots simply skip this source.
- The project-root `.drfxignore` file uses gitignore syntax: `#` comments, blank lines, `!` negation with last-match-wins, leading-`/` anchoring, trailing-`/` directory-only patterns, and `*` / `?` / `[...]` / `**` globs. The zero-dependency matcher is differential-tested against real `git check-ignore`, including character classes never matching `/` and the `dir/**` (re-inclusion allowed) vs `dir/` (pruned) contrast.
- `scope=` accepts a single file in addition to directories. Explicit scopes always win over both ignore sources; scopes an ignore source would have covered — including under a directory-only ignored parent — are reported as `scopeIgnoreOverrides`, never silently re-included. Built-in exclusions stay policy: scoping an excluded directory or an OS scratch file (`.DS_Store`, `Thumbs.db`) still blocks as `excluded-scope`.
- Privacy: the target identity and manifest carry ordered, domain-separated sha256 digests of the `.drfxignore` pattern lines (duplicates preserved — a repeated rule changes last-match-wins semantics); raw pattern text never enters workflow state, user-facing output shows redacted pattern text, and `--json` results surface `userExcludes` / `scopeIgnoreOverrides`.

### Changed

- The whole-root CODE cap (300 files / 1,500,000 bytes) counts after all exclusions, and the `file-set-too-large` message reports its early-termination counts as a floor (`at least N files / N+ bytes (counting stopped at the cap)`) with `.drfxignore` as a suggested remedy. Scopes that normalize to the project root (such as `scope=.`) remain capped.
- A symlinked, non-regular, or unreadable `.drfxignore` blocks strict resolution loudly instead of being silently treated as empty; identity derivation stays lenient and deterministic.
- Both READMEs document the complete built-in exclusion list (bound to the source constants by a parity test), the version-ignore and `.drfxignore` contracts, and directory-or-file scopes.
- Gemini code-route invocation gates materialize the documented `read-only`/`advisory` defaults directly instead of describing a review-and-fix default rendered as unsupported; explicit `review-and-fix` renders the unsupported result.

## 0.6.0 - 2026-06-05

Make the PR/CODE code routes more engineering-grade: actionable rubric standards, route-neutral prompts, a whole-root size gate, broader redaction, and a resolved-set-only fixer.

### Added

- The PR and CODE rubrics gain an `## Engineering standards` section: tiered (high/medium/low) hardcoded-value findings with allowed contract-constant cases, plus error-handling and logging rules. It is gated by the existing actionable-only boundary, so it does not turn into a style war.
- `review-fix-code` whole-root review is capped at 300 files or 1,500,000 bytes. Larger whole-root file sets block as `file-set-too-large` and ask for a narrower `scope=<path>` instead of claiming a full review they cannot prove. The gate blocks during traversal, before any file content is read, and the cap is surfaced in the generated route text and README. The cap wording is bound to the source constants by a test.
- Redaction now covers AWS access key IDs and Slack incoming webhook URLs (GCP service-account private keys were already covered; a regression test locks this). A negative test guards against redacting high-entropy non-secrets such as git OIDs and SHA-256 digests.
- A byte-for-byte snapshot regression guard for the embedded shared prompts/rubrics/core across every route and platform, plus a Codex copied-shared-asset fidelity test.

### Changed

- PR/CODE unknown Markdown rule files under `rules/` now warn and continue instead of blocking — these routes expose no `strict|normal` token, so the normal policy applies. Symlinked or non-regular `.md` entries are still rejected, and `loadRouteRuleContext` now surfaces the warnings.
- The shared reviewer/coordinator/fixer prompts and `shared/core.md` are route-neutral (target document vs resolved file set), so PR/CODE reviews no longer inherit a document-first framing. Output schemas are unchanged.
- Code-route invocation text no longer describes a "bare project root" token; omitting `scope=` reviews the whole project root.

### Removed

- The recorded-dependency mechanism for PR/CODE auto-fix. The fixer write boundary is now exactly the resolved file set; an accepted issue that needs a file outside that set is reported `Not fixed` rather than edited.

## 0.5.0 - 2026-06-05

Archive passed/clean workflow state at finalization so a re-run starts fresh without `reset`.

### Added

- On `finalize`, a `pass` or `read-only-clean` run archives its target state directory to `.drfx/archived/<target-key>-<timestamp>` (renamed, never deleted) so the next run starts fresh without an explicit `reset`. Archiving is best-effort: if the rename fails, finalization still reports the terminal status plus an `archiveWarning` and a concrete delete/reset/retry next action, leaving the state directory in place.
- `resume` over a leftover live `pass`/`read-only-clean` manifest (a pre-upgrade leftover or an archive-failed finalize) archives it and starts a fresh review instead of re-reporting PASS or re-reviewing in place; if archiving fails it blocks with a repair next action. When the post-archive fresh start itself fails or throws, the result still carries `archivedStatePath` so callers learn the old state was already moved.
- Archive-root hardening: a symlinked or non-directory `.drfx/archived` is refused rather than followed.

### Changed

- Generated route output (Claude/Codex/Gemini) and the shared workflow docs document finalize-time archiving and the `archiveWarning` default-output contract. README/README.zh-CN note that `.drfx/archived/` is now populated by successful `pass`/`read-only-clean` finalization, not only by `reset`.

### Removed

- Dead `stalePass` resume field and the now-unreachable `validateResumeState` pass branch, plus the orphaned `evaluateResumeState`/`compareManifestTarget` helpers.

## 0.4.2 - 2026-06-05

Close a finalize gap in the generated PR/CODE coordinator loop: a clean initial review still requires a full re-review before PASS.

### Fixed

- Generated Claude/Codex route instructions now document that an initial `record-review` PASS is not terminal: the coordinator must run a full re-review before finalization. Previously only the post-`DIFF-OK` re-review path was documented, so a clean initial review with no fix round could attempt `finalize` and hit `ERR_FINAL_FULL_REVIEW_REQUIRED`. This matches the enforced state machine (`triageOutcome` → `full-re-review`; `validatePass` requires `requiredFullReReviewComplete` even with no fix round).

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
