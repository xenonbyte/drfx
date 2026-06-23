# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See AGENTS.md for project structure, build/test/lint commands, coding conventions, and commit guidelines. This file covers architecture that requires reading multiple files to understand.

## Architecture Overview

This is a Node.js 20 CommonJS CLI package (`@xenonbyte/drfx`) that installs seven review-fix routes — four document routes (SPEC, PLAN, DESIGN, COMMON), two code routes (PR, CODE), and one requirement-plan route (R2Q) — into AI agent platforms (Claude, Codex, Gemini, opencode). The CLI entry point is `bin/drfx.js` with user commands `version`, `help`, `doctor`, `status`, `install`, and `uninstall`, plus the internal `workflow` dispatcher invoked by generated routes.

## Core Data Flow

1. **Routes & Generator** (`lib/routes.js`, `lib/generator.js`): `lib/routes.js` is the shared registry of the seven routes (`review-fix-spec/plan/design/doc` plus `review-fix-pr/code` plus `review-fix-r2q`), each with a `routeKind` (document/pr/code/r2q) and a `targetContextKind` (single-document vs file-set vs r2q). `review-fix-r2q` has `routeKind: 'r2q'` and `targetContextKind: 'r2q'`; it reuses the document PLAN rubric stack but targets a requirement directory's `07-plan.md` and fixes findings backward into upstream docs `03`–`06`; `run.md` is a read-only gate (r2q never writes it or invokes the r2p CLI). `lib/generator.js` renders platform-specific output files from `templates/` and `templates/fragments/`, embedding shared content from `shared/` — core workflow docs, rubrics, and reviewer/fixer/coordinator prompt fragments. Template rendering uses `{{PLACEHOLDER}}` substitution.

2. **Installer** (`lib/install.js`) orchestrates: parse platform list → normalize platform roots → plan generated files via Generator → preflight safety checks (no symlinks, ownership markers for Codex) → backup existing → write with atomic rename (staging dir → target) → write capability descriptor → write install manifest. On failure, it rolls back by restoring backups.

3. **Capability system** (`lib/capability.js`) checks three capabilities per platform: `can_spawn_isolated_reviewer`, `reviewer_write_blocked`, `fingerprint_guard_available`. The fingerprint guard runs a real OS-temp probe: creates fixture files, mutates one, checks if SHA-256/size/mtime differ. Verified capabilities require a `runId` (UUID) that must match across descriptors to prevent stale cache reuse. `installer-default` provenance descriptors are explicitly non-verified.

4. **Manifest** (`lib/manifest.js`) uses a custom human-readable text format (not JSON) for install manifests stored at `~/.drfx/manifests/<platform>.manifest`. Format: `key: value` scalars, `section:` with indented fields, and `- firstField: value` list entries with `    subsequentField: value`. Uninstall validates manifests strictly — refuses symlinks, requires ownership markers for directories, and checks path allowlists per platform. (Persistent workflow state uses a separate `MANIFEST.md` under `.drfx/targets/<key>/`; its V2 schema carries a `targetContextKind` discriminator — absent ⇒ single document, `pr`/`code` ⇒ file set.)

5. **Platform adapters** (`lib/adapters/`) each export `checkCapabilities()`. Currently all adapters report capabilities as `unverified` (Claude/Codex/opencode) or `unsupported` (Gemini). Real verification would require runtime-provided proof.

6. **Input parsing** (`lib/input.js`) dispatches by route kind. Document routes accept `target=`, repeated `ref=`, `strict`/`normal`, `assurance=`, `ledger=`. PR routes require `base=`; CODE routes accept repeated `scope=` (omit ⇒ whole project). All routes share `read-only`/`review-and-fix`, `rounds=<n>`, `guard=git|snapshot`, `resume`, `root=`. Parsing is strict — duplicate tokens, unknown keys, and unlabeled paths after labeled ones are all errors.

7. **Target resolution & file-set workflow** (`lib/target-context.js`, `lib/workflow/`): `lib/target-context.js` resolves PR file sets (local read-only git diff `base..HEAD`, never fetches) and CODE file sets (deterministic FS traversal; scopes may be directories or single files), computing a per-file-set fingerprint from current worktree content. CODE traversal excludes built-in infrastructure directories, version-control-ignored files (one read-only `git ls-files --others --ignored` query; tracked files never ignored; non-git roots skip this source), and project-root `.drfxignore` patterns (gitignore syntax via `lib/drfxignore-matcher.js`; ordered domain-separated SHA-256 digests of the raw pattern lines join the target identity — raw pattern text never enters workflow state, user-facing output shows redacted text). An explicit `scope=` always wins over every ignore source. `lib/workflow/file-set-*.js` runs the PR/CODE lifecycle (context → review → triage → fix loop → diff review → finalize), bounded by `rounds=<n>` and guarded by git or snapshot file-set guards.

## Key Design Constraints

- **Manifest-backed safety**: Uninstall removes only files listed in the manifest. Ownership markers (`.drfx-owned`, whose content is the package name) gate Codex directory removal. Symlinks are never removed.
- **Atomic writes**: Install writes to staging paths, then `fs.renameSync` for atomic replacement. Failed writes restore the original.
- **Capability proof freshness**: Every `drfx doctor` run generates a new `runId`. All capability proofs must reference the current run. Stale descriptors from previous runs are rejected.
- **Gemini is advisory-only**: Gemini routes must not edit files or claim workflow PASS. The adapter reports both reviewer capabilities as `unsupported`, and code routes (PR/CODE) and r2q are advisory-only on every platform under Gemini.
- **Route structure differs by platform**: Claude/Gemini/opencode install single command files (Claude/opencode under `commands/`, Gemini as TOML); Codex installs full skill directories with embedded shared files. opencode is a full review-and-fix platform (parity with Claude/Codex), installed to `~/.config/opencode/commands/` with `--runtime-platform opencode`.
- **Code routes are self-contained**: PR/CODE use a no-COMMON 4-layer rule stack (hard constraints → built-in PR/CODE rubric → user-global → project-local), unlike document routes which layer COMMON first.
- **PASS is earned, never assumed**: read-only, advisory, Gemini, diff-review-only, unverified, and stale/drifted file-set runs can never claim a workflow PASS. File-set fixes stay inside the resolved file set, guarded by git (real `git status`) or snapshot (whole-tree fingerprint) file-set guards before any write.
