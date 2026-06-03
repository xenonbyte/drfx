English | [简体中文](README.zh-CN.md)

# document-review-fix

`@xenonbyte/document-review-fix` installs six review routes: four document routes (SPEC, PLAN, DESIGN, COMMON) and two code routes (`review-fix-pr` for pull request diffs and `review-fix-code` for source scope review). All routes can run a read-only review or a review-and-fix loop.

## Requirements

- Node.js 20 or newer.
- One or more supported agent platforms: Claude Code, Codex, or Gemini.
- For automatic fixes, use `guard=git` with a tracked clean `HEAD` target, or use `guard=snapshot` with a valid snapshot rollback anchor.

## Install

Install the package globally:

```bash
npm install -g @xenonbyte/document-review-fix
```

Check the CLI:

```bash
drfx --help
drfx check
```

Install generated routes into the agent platforms you use:

```bash
drfx install --platform claude,codex,gemini
drfx install --platform claude
drfx install --platform codex
drfx install --platform gemini
```

Uninstall manifest-owned generated routes:

```bash
drfx uninstall --platform claude,codex,gemini
```

If uninstall finds user-modified generated files or Codex skill directory contents, it keeps those files, reports `partially uninstalled: <platform> (... manifest retained)`, and retains a narrowed manifest so a later uninstall can remove the remaining package-owned files after they are restored or deleted.

`drfx install --platform` supports:

- `claude`: installs command files under `~/.claude/commands`.
- `codex`: installs generated skill directories under `~/.codex/skills/review-fix-*`.
- `gemini`: installs command TOML files under `~/.gemini/commands`. Gemini routes are advisory-only.

`drfx check` reports local platform capability status. Use `drfx check --platform <platform> --json` when a strict verified route needs same-flow capability proof.

## Routes

The installed user-facing routes are:

```text
review-fix-spec   SPEC documents
review-fix-plan   PLAN documents
review-fix-design DESIGN documents
review-fix-doc    COMMON documents
review-fix-pr     PR diff (base..HEAD file set)
review-fix-code   source scope file set
```

The route name selects the review target. Document routes: do not pass `type=`. Code routes (`review-fix-pr`, `review-fix-code`): do not pass `target=`, `ref=`, `strict`, `normal`, `assurance=`, or `ledger=`.

## Quick Start

Review and automatically fix a SPEC document on Codex or Claude Code:

```text
review-fix-spec docs/spec.md
```

Bare path is shorthand for `target=<path>`. The full form remains supported:

```text
review-fix-spec target=docs/spec.md
```

Review without editing:

```text
review-fix-design docs/design.md read-only
```

Review with reference documents:

```text
review-fix-plan docs/plan.md ref=docs/spec.md ref=docs/design.md
```

Run strict review-and-fix:

```text
review-fix-plan docs/plan.md review-and-fix strict guard=git
```

Resume from target-local workflow state:

```text
review-fix-doc docs/notes.md read-only resume
```

Print redacted workflow details for debugging:

```text
review-fix-design docs/design.md debug
```

Use explicit practical assurance:

```text
review-fix-spec docs/spec.md review-and-fix assurance=practical guard=snapshot
```

Use advisory read-only review:

```text
review-fix-design docs/design.md ref=docs/requirements.md read-only assurance=advisory
```

Run a document route repair loop (maximum 3 rounds):

```text
review-fix-plan docs/plan.md rounds=3
```

## Code Review Routes

Review a pull request diff (local git only, no fetch):

```text
review-fix-pr base=main
```

Review-and-fix a PR diff with explicit snapshot guard:

```text
review-fix-pr base=main guard=snapshot
```

Read-only PR review:

```text
review-fix-pr base=main read-only
```

PR review with explicit resume:

```text
review-fix-pr base=main resume
```

PR review with repair loop (maximum 2 rounds):

```text
review-fix-pr base=main rounds=2
```

Review the whole project root (`scope=` omitted means whole project):

```text
review-fix-code
```

Scoped code review (one or more roots):

```text
review-fix-code scope=lib scope=test
```

Read-only code review of a single directory:

```text
review-fix-code scope=lib read-only
```

Code review with explicit snapshot guard:

```text
review-fix-code scope=lib guard=snapshot
```

Code review with explicit resume:

```text
review-fix-code scope=lib resume
```

## Invocation Syntax

### Document routes (review-fix-spec / plan / design / doc)

Supported tokens:

- A bare `<path>` is the recommended target form and is shorthand for `target=<path>`.
- `target=<path>` is the full target form. In `review-and-fix` mode, this is the only file the route may edit.
- `ref=<path>` adds a read-only reference document. Repeat `ref=` for multiple references.
- `read-only` reviews and triages without editing.
- `review-and-fix` reviews, triages, fixes accepted issues, checks the diff, and re-reviews.
- `normal` uses default strictness.
- `strict` makes low-severity findings blocking unless they are explicitly accepted as non-blocking.
- `assurance=practical` uses live platform checks suitable for normal automatic fixing on Codex and Claude Code.
- `assurance=strict-verified` requires same-flow `drfx check --platform <platform> --json` proof.
- `assurance=advisory` allows read-only advisory review only.
- `resume` continues from target-local state.
- `rounds=<n>` sets the maximum repair-loop count (positive integer). Unsupported with `read-only`.
- `debug` prints redacted workflow audit details. Default output is concise.
- `root=<path>` sets the project root used for containment and state layout.
- `ledger=<path>` selects a custom issue ledger path inside the target state directory.
- `guard=git|snapshot` selects the rollback and target-only guard family. `guard=git` is the default; `guard=snapshot` uses file snapshots when a Git rollback anchor is unavailable. The route never silently switches guard modes.

### review-fix-pr

Syntax:

```text
review-fix-pr base=<branch> [read-only|review-and-fix] [guard=git|snapshot] [resume] [rounds=<n>] [root=<path>] [debug]
```

- `base=<branch>` is required. The diff is `base..HEAD`, resolved locally with no fetch, push, or ref mutation.
- `read-only` or `review-and-fix` (default `review-and-fix` on Claude Code and Codex; advisory read-only on Gemini).
- `guard=git` is the default; use `guard=snapshot` when a Git rollback anchor is unavailable. The route never silently switches guard modes.
- `resume` explicitly continues from saved state. Stale state is refused; there is no silent reuse.
- `rounds=<n>` sets the maximum repair-loop count (positive integer). Unsupported with `read-only`.
- `root=<path>` sets the project root.
- Does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, or `ledger=`.

### review-fix-code

Syntax:

```text
review-fix-code [scope=<path>...] [read-only|review-and-fix] [guard=git|snapshot] [resume] [rounds=<n>] [root=<path>] [debug]
```

- `scope=<path>` names a source root to review. Repeat `scope=` for multiple roots. Empty scope means the whole project root.
- Mandatory exclusions: `.git`, `.docs-review-fix`, `node_modules`, build outputs, and similar infrastructure directories are always excluded from the reviewed file set.
- `read-only` or `review-and-fix` (default `review-and-fix` on Claude Code and Codex; advisory read-only on Gemini).
- `guard=git` is the default; use `guard=snapshot` when a Git rollback anchor is unavailable. The route never silently switches guard modes.
- `resume` explicitly continues from saved state. Stale state is refused; there is no silent reuse.
- `rounds=<n>` sets the maximum repair-loop count (positive integer). Unsupported with `read-only`.
- `root=<path>` sets the project root.
- Does not accept `target=`, `ref=`, `base=`, `strict`, `normal`, `assurance=`, or `ledger=`.

`guard=snapshot` monitoring details:

- It monitors the target, explicit `ref=` documents, ordinary project files, and unrelated file symlinks as opaque entries.
- Well-known infrastructure directories (`.git`, `node_modules`, `.pnpm-store`, `.yarn`, `.cache`, `dist`, `build`, `coverage`) are excluded from monitoring unless the target or a reference lives inside one.
- When any directory is excluded, the guard reports `monitorScope: project-tree-files-and-references-excluding-infrastructure`.
- Directory symlinks are not supported and block the guard.
- Opaque file-symlink entries are checked by symlink metadata and `readlink` target text, but they do not detect writes made through the symlink to its resolved target.

Parsing is strict:

- A single unlabeled target path is allowed.
- If `target=` is used, unlabeled paths are rejected.
- Duplicate `target=` and duplicate `root=` are rejected.
- Unknown `key=value` tokens and unknown dash options are rejected.
- Paths with spaces must be passed as one shell-quoted token.
- Natural-language input is accepted only when target and reference roles are unambiguous.

For valid target invocations, Codex and Claude Code routes default missing mode to `review-and-fix` and missing assurance to `practical`. Explicit `assurance=advisory` without mode selects `read-only` on Codex and Claude Code. Gemini routes default missing mode to `read-only` and missing assurance to `advisory`.

Help-style or invalid invocations explain usage only and must not read files, run `drfx workflow`, create state, run probes, or declare review results.

## Modes

`read-only`:

- Reads the target and references.
- Runs semantic review and triage.
- Does not edit files.
- Reports either `Clean:` or `Issues:`.

`review-and-fix`:

- Reads the target and references.
- Runs review, triage, fix, diff review, and full re-review.
- Edits only the target document.
- Reports `Fixed:` when changes were applied.
- Reports `Unfixed:` when accepted issues remain.

Gemini supports advisory read-only review. Gemini does not support `review-and-fix` or `assurance=strict-verified`.

Code routes (`review-fix-pr`, `review-fix-code`) on Gemini are advisory-only: `review-and-fix` is unsupported, `rounds=<n>` is not accepted, workflow PASS is unavailable, and automatic fixing never runs. Use Claude Code or Codex for automatic code fixing.

`read-only` paths never claim PASS and create no auto-fix state, on any platform.

## Output

Default output is designed to be short and usable by another AI agent.

Clean read-only review:

```text
Clean: docs/spec.md has no blocking issues.
```

Read-only review with findings:

```text
Issues:
- Location: docs/spec.md:42
  Problem: The acceptance criteria do not define the empty-state behavior.
  Why it matters: Implementers can ship incompatible behavior.
  Suggested fix: Add explicit empty-state acceptance criteria.
Next: Apply fixes manually or rerun on Codex/Claude Code in review-and-fix mode.
```

Successful review-and-fix:

```text
Fixed:
- Location: docs/spec.md:42
  Change: Added explicit empty-state acceptance criteria.
Files changed:
- docs/spec.md
```

Review-and-fix with remaining issues:

```text
Fixed:
- Location: docs/spec.md:42
  Change: Added explicit empty-state acceptance criteria.
Unfixed:
- Location: docs/spec.md:88
  Problem: The rollout owner is still unspecified.
  Next: Add the accountable owner or defer with reason, owner, and next action.
Files changed:
- docs/spec.md
```

Blocked run when the target lacks a rollback anchor:

```text
Blocked: docs/spec.md cannot be auto-fixed because it lacks a clean rollback anchor.
Next: Commit or restore the target, rerun with read-only, or use guard=snapshot when Git rollback is unavailable.
```

Other guard blockers use different wording: `target-only-guard-unavailable` means the target-only guard is unavailable or unparseable, while `unexpected-worktree-change` means non-target worktree changes make automatic fixing unsafe.

`debug` may include redacted state paths, blocker codes, runtime probe status, and workflow audit details. It must not print raw target bodies, raw prompts, subagent transcripts, secrets, or unredacted sensitive logs.

## Review Rules

### Document routes

Every document route applies the COMMON rubric first. Specialized routes add one type-specific rubric:

- `review-fix-spec`: COMMON plus SPEC.
- `review-fix-plan`: COMMON plus PLAN.
- `review-fix-design`: COMMON plus DESIGN.
- `review-fix-doc`: COMMON only.

Built-in rubrics:

- COMMON: purpose, coherence, actionability, assumptions, constraints, risks, project alignment, terminology, placeholders, and external facts.
- SPEC: requirements, product behavior, API behavior, scope, actors, permissions, integrations, acceptance criteria, edge cases, and verifiability.
- PLAN: implementation steps, prerequisites, tooling, verification, rollback, failure handling, data safety, compatibility, and handoff readiness.
- DESIGN: UX, UI, product workflows, system or architecture design, states, transitions, contracts, data flow, accessibility, responsiveness, localization, constraints, and risks.

### Code routes

Code routes (`review-fix-pr`, `review-fix-code`) use self-contained rubrics with no COMMON layer:

- `review-fix-pr`: correctness, regression, safety, tests, contracts, maintainability, and platform.
- `review-fix-code`: correctness, architecture, state-and-io, safety, tests, contracts, maintainability, and platform.

Code review is actionable-only: pure style preferences, no-risk refactors, and over-abstraction opinions are not blocking findings.

### Reference Conformance

`ref=` documents are consistency sources, not mandatory upstream chains.

- SPEC does not require a DESIGN reference.
- PLAN does not require a SPEC reference.
- `Design Coverage Import` is optional unless the SPEC claims complete coverage of a reference, custom rules require it, or the SPEC becomes unverifiable without it.
- `SPEC-to-task mapping` is optional unless the PLAN claims complete coverage of a reference, custom rules require it, or the PLAN becomes unsafe or unverifiable without it.
- Missing trace tables, stable IDs, or coverage tables are not blocking by default.

Blocking reference findings are conflicts, unsupported new requirements presented as reference-backed, omitted reference constraints required for the target's stated purpose, or execution steps that would violate a reference.

Reviewer findings include enough detail for triage: severity, location, problem, why it matters, suggested fix, confidence, and sensitive-content metadata when relevant.

## Custom Rules

Supported V3 custom rule files:

```text
~/.docs-review-fix/rules/COMMON.md
~/.docs-review-fix/rules/SPEC.md
~/.docs-review-fix/rules/PLAN.md
~/.docs-review-fix/rules/DESIGN.md
~/.docs-review-fix/rules/PR.md
~/.docs-review-fix/rules/CODE.md
.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/SPEC.md
.docs-review-fix/rules/PLAN.md
.docs-review-fix/rules/DESIGN.md
.docs-review-fix/rules/PR.md
.docs-review-fix/rules/CODE.md
```

Each custom rule file is a plain Markdown fragment. It does not need a wrapping heading.

For a typed review, the loader reads only `COMMON.md` plus the current document type file from user-global and project-local rules. A `SPEC` review does not read `PLAN.md` or `DESIGN.md`; a `PLAN` review does not read `SPEC.md` or `DESIGN.md`; a `DESIGN` review does not read `SPEC.md` or `PLAN.md`; a COMMON document review reads only `COMMON.md`.

Code routes (`review-fix-pr`, `review-fix-code`) have no COMMON layer. A `PR` review reads only `PR.md`; a `CODE` review reads only `CODE.md`. The user-global and project-local rule files for code routes follow the same two-tier layout as document routes.

Legacy `RULE.md` is stale configuration. If `~/.docs-review-fix/RULE.md` or `.docs-review-fix/RULE.md` exists, workflow start blocks with `state-validation-failed` before writing target state.

Unknown Markdown files under `rules/`, such as `Spec.md`, `SPEC-RULE.md`, or `REQUIREMENTS.md`, produce a normal-mode warning and continue. In strict mode, they block before target state is written.

Rule precedence (document routes):

1. workflow hard constraints
2. built-in COMMON rubric
3. built-in document-type rubric
4. user-global COMMON rules
5. user-global document-type rules
6. project-local COMMON rules
7. project-local document-type rules

Rule precedence (code routes — no COMMON layer):

1. workflow hard constraints
2. built-in code-route rubric (PR or CODE)
3. user-global PR.md or CODE.md rules
4. project-local PR.md or CODE.md rules

Project-local rules are more specific than user-global rules. Custom rules cannot override workflow hard constraints.

## State and Resume

Persistent state is target-local:

```text
.docs-review-fix/targets/<target-key>/
```

The target key is derived from the normalized target path relative to the project root: a readable slug plus a 12-character SHA-256 prefix. It is path-based, not content-based.

Project-local layout:

```text
.docs-review-fix/
  rules/
    COMMON.md
    SPEC.md
    PLAN.md
    DESIGN.md
  index.md
  targets/
```

`rules/` is shared project configuration. `index.md` is project-level index material when present. `targets/<target-key>/` is single-target workflow state.

Default target state layout:

```text
.docs-review-fix/targets/<target-key>/
  MANIFEST.md
  ISSUES.md
  CONTINUITY.md
  SUMMARY.md
  LOCK/
    lease.json
  stale-locks/
  rounds/
```

`MANIFEST.md` records target path, document type, strictness, mode, target key, ledger path, status, current round, file fingerprints, references, and timestamps.

The default ledger is `.docs-review-fix/targets/<target-key>/ISSUES.md`. A custom `ledger=` path must stay inside the target directory and must not point into reserved paths such as `LOCK/`, `stale-locks/`, `rounds/`, `MANIFEST.md`, `CONTINUITY.md`, or `SUMMARY.md`.

`resume` uses target-local files, not chat history. There is no runtime objective/session/platform memory dependency for resume. Resume derives the target key, reads `MANIFEST.md`, reads the ledger, loads `CONTINUITY.md` when present, rebuilds current merged rules, checks fingerprints, and continues only when state is still valid.

## Write Safety

Reference documents are read-only. Fixes must modify only the target document.

Automatic target writes require:

- `review-and-fix` mode;
- either `guard=git` with a Git worktree `HEAD` + tracked clean target, or `guard=snapshot` with a valid snapshot rollback anchor;
- a target-only guard that can prove writes stayed target-only within the selected guard mode;
- no unsafe non-target changes that make guard results ambiguous for the selected guard mode.

Before a fix, the route locks the target state directory and rechecks the target fingerprint. Concurrent edits, external changes, stale unsafe locks, or possible target replacement stop the workflow before a write is trusted.

Sensitive values must not be printed or stored in ledgers, receipts, manifests, summaries, prompts, or final responses. Use `[REDACTED:<kind>]`, for example `[REDACTED:api-token]`, `[REDACTED:private-key]`, `[REDACTED:cookie]`, or `[REDACTED:credential]`.

For sensitive findings, store location anchors and secret kind, not raw values, partial prefixes, suffixes, hashes, checksums, raw logs, or transcript excerpts.

## Troubleshooting

`Blocked: target or worktree is not write-eligible.`

Commit or restore the target document, then resolve unsafe non-target worktree changes. Rerun after `git status --short` shows the target is clean and the remaining worktree state is safe for a target-only guard.

Guard blocker wording:

- `rollback-unavailable`: the target lacks a clean rollback anchor. Commit or restore the target, rerun read-only, or use `guard=snapshot` when Git rollback is unavailable.
- `target-only-guard-unavailable`: the target-only guard is unavailable or unparseable. Restore guard inputs or rerun after guard data can be read.
- `unexpected-worktree-change`: non-target worktree changes make automatic fixing unsafe. Commit, stash, or restore unrelated changes before retrying.

`Blocked: state-validation-failed.`

Remove stale `RULE.md` files. Unknown Markdown files under `.docs-review-fix/rules/` and `~/.docs-review-fix/rules/` warn in normal mode but block strict runs.

`Unsupported: review-and-fix or strict-verified is unavailable on Gemini.`

Use Gemini for advisory read-only review, or use Codex/Claude Code for automatic fixing. For code routes (`review-fix-pr`, `review-fix-code`), Gemini is advisory-only on all platforms: `review-and-fix` is unsupported, workflow PASS is unavailable, and no files are edited. Use Claude Code or Codex for code route automatic fixing.

`Unfixed:` appears after review-and-fix.

The route fixed what it could safely fix and is reporting accepted issues that remain. Deferrals include reason, owner, and next action.

`resume` refuses to continue.

The target state no longer matches the current file fingerprints, target path, references, rules, or lock state. Start a fresh run after resolving the reported blocker.
