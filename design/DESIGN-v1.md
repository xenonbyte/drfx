# Document Review Loop Design v1

## 1. Purpose

`document-review-loop` is a shared workflow behind four user-facing skills that review and fix documents until they pass the required full-document review gate. An initial full-document review can pass without a fix round; after any fix round, the gate is a full re-review. It does not depend on runtime objective state, but it does require the runtime adapter to provide a reviewer subagent or an equivalent isolated read-only review task. Fixing defaults to the coordinator and may use one serial fixer subagent only when the accepted issue list is bounded.

The workflow applies to four document types:

- `SPEC`: requirements and product behavior documents.
- `PLAN`: implementation, migration, execution, or rollout plans.
- `DESIGN`: UX, system, product, or architecture design documents.
- `COMMON`: generic documents that do not fit a specialized type.

The core problem it solves is that one-shot document review is usually too weak. A reviewer may find issues, a fixer may patch them, but without a controlled loop the process often stops before the document is actually coherent. This workflow makes the loop explicit:

```text
review -> triage -> fix -> diff review -> full re-review -> repeat until PASS or a defined terminal/pause state
```

The four entry skills share the same core rules, prompts, issue format, workspace files, and PASS criteria. Each entry skill fixes the document type so users do not have to pass a type parameter.

## 2. Background

Agent-written `SPEC`, `PLAN`, `DESIGN`, and general documents often fail in predictable ways. The first draft may look complete, but a later implementation pass exposes missing acceptance criteria, unclear scope, conflicting assumptions, or steps that cannot be executed without re-planning. A single review pass catches some of these issues, but it does not guarantee that the repaired document is still coherent after edits.

The current agent workflow has another problem: review and repair tend to live in the same context window. As the conversation grows, the agent may lose the original objective, forget why an issue was accepted, or stop after fixing the first batch of findings. The reviewer must therefore run as an isolated read-only subagent. This keeps each review pass independent from the fixer's editing context. A reviewer should not rewrite the document, and a fixer should not invent new requirements while repairing accepted issues.

The workflow cannot rely on runtime objective state if it needs to survive long sessions. The main agent owns the loop and records durable state in `.docs-review-fix`. Reviewer subagents perform mandatory read-only audits, and the coordinator applies confirmed changes directly unless a bounded fix round is safer to delegate to one fixer subagent. If the task runs long, the next session resumes from the target-specific state directory under `.docs-review-fix/targets/<target-key>/` instead of trying to reconstruct state from chat history.

This design captures that workflow as a portable process. It keeps durable rules in one shared core, keeps document-type judgment in separate rubrics, and exposes four short entry skills.

Current repository baseline for v1 implementation:

- At the time this design is written, aside from OS metadata such as `.DS_Store`, the workspace contains only `design/DESIGN-RULE.md` and `design/DESIGN-v1.md`.
- The workspace is not yet a git repository and does not yet contain `package.json`, `README.md`, runtime code, skill files, templates, or generated shared assets.
- V1 implementation therefore starts by creating the package skeleton in the current workspace root.
- The design files stay under `design/` unless a later implementation plan explicitly migrates them.
- Any claim about current package scripts, package metadata, runtime adapters, generated skills, or installer behavior is a target design requirement, not an existing implementation fact, until those files are created.

## 3. Requirements

### 3.1 Functional Requirements

- The package must expose four user-facing skills: `review-fix-spec`, `review-fix-plan`, `review-fix-design`, and `review-fix-doc`.
- The package must provide a CLI installer with `drfx install --platform <claude|codex|gemini[,...]>`.
- The package must provide a CLI uninstaller with `drfx uninstall --platform <claude|codex|gemini[,...]>`.
- The installer and uninstaller must support `claude`, `codex`, and `gemini` as platform route targets.
- The package must provide a root `README.md` that documents installation, platform setup, command usage, built-in rubrics, workflow behavior, and rule configuration.
- Each entry skill must accept a target document path as the primary input.
- Each entry skill may accept one or more reference document paths as read-only context.
- The target document must be unique. If the user provides multiple documents and the target cannot be identified, the workflow must ask for clarification before reading or editing.
- Reference documents must never be modified.
- Each entry skill must set its document type internally: `SPEC`, `PLAN`, `DESIGN`, or `COMMON`.
- The built-in `COMMON` rubric must apply to every document type as the shared base rubric.
- The coordinator must dispatch a reviewer subagent in read-only mode for every initial review and full re-review.
- The workflow must stop as unsupported if no reviewer subagent or equivalent isolated read-only review task is available.
- Reviewer subagents must return structured findings with severity, location, issue, `why_it_matters`, suggested fix, and confidence.
- The coordinator must triage reviewer findings before any fix is applied.
- The workflow must maintain stable issue IDs for accepted findings.
- The workflow must store durable working data under `.docs-review-fix` when persistent state is needed.
- The workflow must read user-global `~/.docs-review-fix/RULE.md` when it exists and merge applicable global review rules.
- The workflow must read project-local `.docs-review-fix/RULE.md` when it exists and merge applicable project review rules.
- The coordinator should fix accepted issues directly by default.
- A fixer subagent may be used only for a bounded accepted issue list and must run serially.
- The fixer must repair only confirmed issues unless the coordinator expands scope.
- Only one fixer may edit the target document at a time.
- The fixer must not edit reference documents.
- Every fix round must be followed by a full-document re-review.
- The workflow must continue until it reaches one of the defined terminal or pause states: `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint for resumable long-running work.
- The workflow must checkpoint state after every review and fix round when the task is long-running.
- The workflow must support resume from target-specific state under `.docs-review-fix/targets/<target-key>/`.
- The final response must report changes made, verification performed, and any residual risk.

### 3.2 Quality Requirements

- The workflow must be portable across agents that can read and edit files and provide reviewer subagent isolation.
- Platform installation must be manifest-backed so uninstall removes only files created by this package.
- Core rules, rubrics, and prompt templates must have one source of truth in the package and be reused by all four entry skills.
- Subagent prompts must be self-contained enough to work without full chat history.
- The issue ledger and continuity summary must be compact, stable, and safe to carry across context compaction.
- The workflow must distinguish blocking issues from low-priority polish.
- The coordinator must remain the final authority for PASS.
- The process must prefer explicit deferral over silent omission when a valid issue is not fixed.
- User-facing invocation must stay short. Long reviewer, fixer, and coordinator prompts are internal implementation details.
- User-facing documentation must explain the short invocation model without requiring users to read internal prompts or shared workflow files.

### 3.3 Safety and Scope Requirements

- The workflow must not print or store secrets, credentials, session cookies, private keys, or raw sensitive logs.
- The workflow must not mutate external systems or production state.
- The fixer must not introduce unconfirmed requirements, product decisions, or external facts.
- The workflow must respect repository-local instructions and higher-priority user instructions.
- The workflow must avoid broad document rewrites unless structure itself blocks PASS.
- Persistent state must live under `.docs-review-fix`, not in raw transcripts.
- User-global `~/.docs-review-fix/RULE.md` and project-local `.docs-review-fix/RULE.md` may extend review rules, but they must not override workflow hard constraints.
- User-global `~/.docs-review-fix` must not store project-specific state.

Sensitive content handling:

- Reviewer, fixer, and coordinator outputs must never quote raw secrets, credentials, session cookies, private keys, bearer tokens, or raw sensitive logs.
- If a finding concerns suspected sensitive content, the finding must identify only the document path, heading, line number, or short non-sensitive anchor, plus the secret class, such as `api-token`, `private-key`, `cookie`, or `credential`.
- The canonical redaction token is `[REDACTED:<kind>]`; do not include partial secret prefixes, suffixes, hashes, or checksums in ledgers, round receipts, final responses, or prompts.
- `ISSUES.md`, `CONTINUITY.md`, `SUMMARY.md`, `rounds/`, manifest notes, fixer reports, and final responses must use redacted values only.
- When a reviewer sees a raw secret in the target document, it reports `sensitive: true`, `why_it_matters` with redacted wording, and a location anchor; it must not copy the secret into `issue` or `suggested_fix`.
- Fixers may remove or replace the sensitive value in the target document when that issue is accepted, but their reports must still describe the change without reproducing the raw value.

### 3.4 Portability Requirements

- Runtime notes must not duplicate the full core workflow.
- The workflow must not require runtime objective state or any equivalent session feature.
- Runtime adapters may map the reviewer subagent to native subagents, Task tools, or equivalent isolated read-only delegation features.
- Platform routes may be installed even when the runtime is advisory-only, but they must not claim automatic workflow PASS unless reviewer isolation is available.
- The workflow must not claim automatic review-fix PASS support on runtimes without reviewer subagent isolation.
- Long-task support must come from `.docs-review-fix` state files rather than runtime-specific memory.
- Platform install and uninstall must not delete user-global `~/.docs-review-fix/RULE.md` or project-local `.docs-review-fix` state.

## 4. Usage

The user should not paste the long internal prompts. The skill should hide the review loop, subagent prompts, and runtime details behind a short command.

Expected user-facing invocations:

```text
使用 review-fix-spec docs/spec.md
使用 review-fix-plan docs/plan.md
使用 review-fix-design docs/design.md
使用 review-fix-doc docs/notes.md
```

Optional flags:

```text
使用 review-fix-plan docs/plan.md strict
使用 review-fix-design docs/design.md read-only
使用 review-fix-doc docs/notes.md resume
```

Reference documents:

```text
使用 review-fix-spec target=docs/spec.md ref=docs/prd.md
使用 review-fix-plan target=docs/plan.md ref=docs/spec.md
使用 review-fix-design target=docs/design.md ref=docs/requirements.md ref=docs/brand.md
```

Natural-language input is allowed when the roles are clear:

```text
使用 review-fix-spec 修改 docs/spec.md，参考 docs/prd.md。
```

If the user provides more than one document without a clear target/reference split, the skill must ask which file is the target and which files are references. It must not guess.

The skill expands this short request into the internal loop:

```text
select rubric -> read global and project rules -> reviewer subagent -> triage -> fix -> diff review -> reviewer subagent full re-review -> repeat until PASS or a defined terminal/pause state
```

Installation:

```text
drfx install --platform claude,codex,gemini
drfx uninstall --platform claude,codex,gemini
drfx check
```

## 5. Goals

The workflow must:

- Provide a repeatable audit-and-repair loop for `SPEC`, `PLAN`, `DESIGN`, and `COMMON` documents.
- Require reviewer subagents for independent read-only audits without letting subagents become the final authority.
- Keep the coordinator as the owner of the loop, state, issue ledger, and final PASS decision.
- Prevent multiple agents from editing the same document concurrently.
- Preserve enough durable context to survive context compaction or long-running sessions.
- Separate tool-independent workflow rules from runtime-specific execution details.
- Make every finding actionable, traceable, and linked to an eventual fix or explicit deferral.
- Allow user-global review rules through `~/.docs-review-fix/RULE.md`.
- Allow project-local review rules through `.docs-review-fix/RULE.md`.
- Require a full-document re-review after each fix round, not only a diff review.

## 6. Non-Goals

The workflow does not:

- Replace human approval when the user explicitly requires it.
- Guarantee that a document is correct against unknown external facts.
- Mutate external systems, deploy code, or change production state.
- Require three separate tool implementations of the same process.
- Require runtime objective state or any agent-specific equivalent.
- Provide automatic review-fix PASS loops on runtimes without reviewer subagent isolation.
- Use fixer subagents as the default editing path.
- Let multiple fixer subagents rewrite the same target document in parallel.
- Treat low-priority editorial preferences as blockers unless the user asks for strict polish.
- Store private credentials, raw logs, transcripts, or sensitive data in workflow state files.
- Let user-global or project-local rules disable reviewer read-only mode, serial fixing, full re-review, or PASS criteria.

## 7. Core Model

The workflow has four conceptual roles.

### 7.1 Coordinator

The coordinator is the main agent in the current session. It owns the review-fix loop, receives the document type from the entry skill, prepares context packs, dispatches mandatory reviewer subagents, optionally dispatches one bounded fixer subagent, validates findings, manages the issue ledger, reviews diffs, and decides whether the workflow is complete.

Responsibilities:

- Identify the target document and document type.
- Select the correct rubric.
- Load `~/.docs-review-fix/RULE.md` and `.docs-review-fix/RULE.md` when they exist.
- Read any relevant repository instructions before editing.
- Create or update durable state only when the task is long-running or compaction-prone.
- Dispatch reviewer subagents with read-only instructions for every initial review and full re-review.
- Confirm, reject, merge, or downgrade findings.
- Fix accepted issues directly by default.
- Dispatch one serial fixer subagent only when the accepted issue list is bounded and safe to delegate.
- Re-run full-document review after every fix round.
- Checkpoint `.docs-review-fix` state after each review and fix round when the task is long-running.
- Stop only when the workflow reaches `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, explicit user stop, or a resumable checkpoint.

The coordinator is the only role allowed to mark the workflow complete.

### 7.2 Reviewer Subagent

The reviewer subagent is a mandatory read-only critic. Its job is to inspect the full target document against the merged rule set and return structured findings. The coordinator must not replace this role with local reviewer mode for the automatic review-fix loop.

Reviewer constraints:

- Must not modify files.
- Must read the whole target document unless the coordinator explicitly scopes a narrow review.
- Must use the merged review rule set: workflow hard constraints, built-in `COMMON`, built-in document-type rubric, applicable user-global rules, applicable project-local rules, and strictness-specific PASS rules.
- Must produce `PASS` in `normal` mode only when there are no unresolved high or medium issues.
- Must produce `PASS` in `strict` mode only when there are no unresolved high, medium, or unaccepted low issues.
- Must mark uncertain claims as `UNCONFIRMED`.
- Must avoid broad rewrites or vague quality complaints.

Reviewer output must be structured enough for the coordinator to turn findings into issue ledger entries.

### 7.3 Fixer

The fixer applies confirmed changes. The default fixer is the coordinator. A fixer subagent is optional and may be used only for a bounded, confirmed issue list.

Fixer constraints:

- Must work serially. Only one fixer edits a target document at a time.
- Must fix only confirmed issues unless the coordinator explicitly expands scope.
- Must preserve document intent, terminology, and structure where possible.
- Must not introduce unconfirmed requirements or design decisions.
- Must report which issue IDs were fixed.
- Must call out any issue that could not be fixed cleanly.

The coordinator should fix directly when the document is small, issues are few, semantics must be preserved carefully, or the fix requires judgment. A fixer subagent is useful only when:

- The target document is long or the accepted issue list is large.
- Every delegated issue has a clear issue ID, location, and expected correction.
- The fixer can operate from a compact context pack without reading chat history.
- The fixer is allowed to modify only the target document.
- The coordinator will run diff review and full re-review after the fix round.

### 7.4 Issue Ledger

The issue ledger is the workflow's durable state. It records findings, their status, fixes, and open risks.

The issue ledger may live in:

- The coordinator's working notes for short sessions.
- `.docs-review-fix/targets/<target-key>/ISSUES.md` for persistent issue tracking.
- A user-specified `ledger=` path only when it resolves inside `.docs-review-fix/targets/<target-key>/` for the selected target and passes the reserved-path rules.

The ledger is not a transcript. It should contain only durable state that affects future work.
`CONTINUITY.md` is handoff state, not an issue ledger. It may summarize current issue status, but `MANIFEST.md` must never point `Ledger path` at `CONTINUITY.md`.

### 7.5 Long-Task State

Long tasks must not depend on chat history or runtime memory. The coordinator writes enough state for a later session to continue without re-deciding the work.

Long-task state includes:

- The target document path.
- The target key and target-specific state directory.
- The ledger path. Defaults to `.docs-review-fix/targets/<target-key>/ISSUES.md`; if `ledger=` is supplied, the resolved target-local path is recorded in `MANIFEST.md`.
- Reference document paths and their read-only role.
- The entry skill and fixed document type.
- The strictness: `normal` or `strict`.
- The mode: `review-and-fix` or `read-only`.
- The merged rule set version or source list.
- The current round number.
- Accepted, fixed, rejected, deferred, and reopened issues.
- The current phase: `review`, `triage`, `fix`, `diff-review`, `full-re-review`, `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, or `checkpoint`.
- The next concrete action.

The coordinator updates state after each review round, after each fix round, and before stopping because of context pressure, tool limits, or user interruption.

State semantics:

- `pass`: the relevant full-document review gate passed and the coordinator agrees.
- `stopped-with-deferrals`: unresolved high or medium issues were intentionally deferred with rationale and owner; this is not PASS.
- `read-only-findings`: read-only mode found blocking issues; the coordinator reports findings and does not fix.
- `blocked`: the workflow cannot continue until a concrete blocker is resolved.
- `unsupported`: the runtime lacks required reviewer isolation for the automatic workflow.
- `externally-changed`: resume detected target content drift and requires full re-review before prior state can be trusted.
- `possible-target-replacement`: resume detected a likely different document at the same path and requires user choice before continuing.
- `checkpoint`: the task is paused with enough state for a later resume.

### 7.6 Rulebooks

`~/.docs-review-fix/RULE.md` is the user-global rulebook. It defines extra review rules that apply across projects.

`.docs-review-fix/RULE.md` is the project-local rulebook. It defines extra review rules for this workspace. It can tighten or extend the built-in rubrics, but it cannot weaken workflow hard constraints.

Expected format:

```markdown
## COMMON

Extra rules that apply to every document type.

## SPEC

Extra rules for requirements and spec documents.

## PLAN

Extra rules for plan documents.

## DESIGN

Extra rules for design documents.
```

The coordinator reads `COMMON` plus the selected document type section from both rulebooks. For a `COMMON` document, the coordinator reads only `COMMON`. Project-local rules have higher priority than user-global rules.

Rulebook heading parsing is identical for user-global and project-local `RULE.md` files:

- V1 supports only second-level headings whose trimmed text is exactly `COMMON`, `SPEC`, `PLAN`, or `DESIGN`.
- Aliases such as `REQUIREMENTS`, `DOC`, `GENERAL`, or lowercase variants are invalid in both rulebook locations.
- Unknown second-level headings are rejected with a clear message that names the file path and heading.
- A rulebook parse error blocks automatic review-fix work until corrected. Advisory read-only output may explain the parse error, but must not claim workflow PASS.
- Canonical sections that are not selected for the current document type are ignored, not treated as errors.

## 8. Workflow

### 8.1 Entry

Inputs:

- `target_document`: path to the document being reviewed.
- `reference_documents`: optional read-only documents used as context.
- `entry_skill`: one of `review-fix-spec`, `review-fix-plan`, `review-fix-design`, or `review-fix-doc`.
- Optional `strictness`: `normal` or `strict`.
- Optional `mode`: `review-and-fix` or `read-only`.
- Optional `resume`: continue from existing target-specific `.docs-review-fix` state.
- Optional `ledger_path`: project-local path for persistent issue tracking. Defaults to `.docs-review-fix/targets/<target-key>/ISSUES.md` when persistent state is needed. Accepted as `ledger=<path>` only when the resolved path is inside `.docs-review-fix/targets/<target-key>/` for the selected target.
- Optional `project_root`: explicit workspace root for target-key and `.docs-review-fix` state derivation. Accepted as `root=<path>` in user-facing input.

Input parsing contract:

- The supported structured form is:

  ```text
  <entry-skill> [target=<path>] [ref=<path> ...] [strict|normal] [read-only|review-and-fix] [resume] [ledger=<path>] [root=<path>]
  ```

- A single bare path may be used as `target_document` only when no `target=` token is present.
- When `target=` is present, every other document path must be labeled with `ref=`, `ledger=`, or `root=`. Unlabeled extra paths are invalid.
- Multiple `target=` tokens are invalid.
- Duplicate `ref=` tokens are allowed, but the coordinator must de-duplicate them after resolving paths.
- Multiple `root=` tokens are invalid.
- `ledger=` must resolve inside `<project-root>/.docs-review-fix/targets/<target-key>/` after target-key derivation and must pass the reserved-path rules below. External ledger paths and project-level shared ledger files are not supported in v1 because persistent workflow state must stay isolated by target.
- A reference path that resolves to the same file as the target is invalid.
- `strict` and `normal` are mutually exclusive. If both are present, the coordinator must stop and ask for a corrected invocation.
- `read-only` and `review-and-fix` are mutually exclusive. If both are present, the coordinator must stop and ask for a corrected invocation.
- Unknown flags are invalid. The coordinator must report the unknown token rather than silently ignoring it.
- Path tokenization must use shell-style quoting for CLI-style input. Paths containing whitespace must be quoted or supplied through `target=` / `ref=` values that the host runtime already preserves as one argument.
- Natural-language input is accepted only when one path is tied to an edit verb such as "fix", "review and fix", "修改", or "修复", and all other paths are tied to reference words such as "reference", "ref", "参考", or "对照". If the language does not make the roles explicit, the coordinator asks for `target=` and `ref=`.
- `read-only` mode performs review and triage only. It must not modify the target document. It may write a ledger only when `ledger=` resolves under `<project-root>/.docs-review-fix/targets/<target-key>/` or `resume` requires updating existing target state; otherwise it reports findings in the final response without creating project state.
- In `read-only` mode, any unresolved issue that would block PASS in the selected strictness ends the workflow as `read-only-findings`, not `pass`, `blocked`, or `stopped-with-deferrals`.

Persistent state creation in `read-only` mode:

- If `read-only` is invoked without `ledger=` and without `resume`, the coordinator derives the target key and fingerprints in memory only. It must not create `.docs-review-fix`, `MANIFEST.md`, `ISSUES.md`, `CONTINUITY.md`, `SUMMARY.md`, or `rounds/`.
- If `read-only` is invoked with `ledger=` or `resume`, persistent state is allowed and must follow the same target-specific `.docs-review-fix/targets/<target-key>/` rules as review-and-fix mode.
- If `read-only` uses `ledger=`, the persistent `MANIFEST.md` must record that ledger path so later `resume` reads the same ledger instead of the default `ISSUES.md`.
- The reviewer guard protocol still runs in one-shot read-only mode, but its fingerprints are kept in memory and reported only when a guard failure occurs.

Entry skill mapping:

```text
review-fix-spec   -> SPEC
review-fix-plan   -> PLAN
review-fix-design -> DESIGN
review-fix-doc    -> COMMON
```

The coordinator starts by validating:

- The target document exists.
- There is exactly one target document.
- Each reference document exists.
- No reference document is treated as writable.
- Any supplied `root=` path exists and contains the resolved target path.
- Any supplied `ledger=` path resolves inside the selected target's `.docs-review-fix/targets/<target-key>/` directory, does not resolve to the target document or any reference document, and does not target a reserved state file or directory.
- The entry skill maps to a known document type.
- The repository or workspace instructions do not conflict with the requested work.
- User-global `~/.docs-review-fix/RULE.md` exists or can be safely skipped.
- `.docs-review-fix/RULE.md` exists or can be safely skipped.
- Existing target-specific state can be validated after target-key derivation when `resume` is requested.
- Natural-language input unambiguously identifies target and reference roles when multiple paths are present.

If multiple paths are present and the target is unclear, the coordinator asks the user to identify:

```text
target=<path to edit>
ref=<path to read only>
```

The coordinator must not infer the target from filename similarity, path order, or document type alone.

The coordinator derives target-specific state before reading or writing persistent workflow files.

Document project root resolution is deterministic:

1. If the user or platform supplies an explicit project root, use it only when the target path resolves inside that root.
2. Otherwise, if a git root can be detected from the target path or current working directory, use the git root.
3. Otherwise, if the target path is inside an ancestor that already contains `.docs-review-fix/RULE.md` or `.docs-review-fix/targets/`, use the nearest such ancestor.
4. Otherwise, if the current working directory is an ancestor of the target path, use the current working directory.
5. Otherwise, stop and ask for an explicit project root before creating `.docs-review-fix` state.

For the first implementation of this repository, the expected project root is the workspace root confirmed at runtime with `pwd` or `process.cwd()`, because no git root or package root exists yet.

Target state derivation:

1. Resolve the document project root using the rules above.
2. Resolve the target path and every reference path to canonical absolute paths for validation.
3. Reject the target path if it escapes the project root. Reference paths may live outside the project root, but they must be recorded as external read-only references and must never affect target-key calculation.
4. Normalize the target path relative to the project root using POSIX separators.
5. Compute a stable path hash from `<normalized-relative-target-path>`.
6. Create a readable target key such as `<target-slug>-<hash12>`.
7. Use `.docs-review-fix/targets/<target-key>/` for that target's `MANIFEST.md`, default `ISSUES.md`, `CONTINUITY.md`, `SUMMARY.md`, `rounds/`, `LOCK/`, and `stale-locks/`.
8. If `ledger=` was supplied, validate it after target-key derivation and reject it unless it resolves inside `.docs-review-fix/targets/<target-key>/` and passes the reserved-path rules.
9. Record the resolved ledger path in `MANIFEST.md` when persistent state is created. If `ledger=` is absent, record `.docs-review-fix/targets/<target-key>/ISSUES.md`.

Reserved-path rules for `ledger=`:

- The default `.docs-review-fix/targets/<target-key>/ISSUES.md` is allowed.
- A custom ledger must be a file path, not a directory path.
- A custom ledger must not resolve to `MANIFEST.md`, `CONTINUITY.md`, `SUMMARY.md`, `LOCK`, `LOCK/lease.json`, `stale-locks`, or any path under `LOCK/`, `stale-locks/`, or `rounds/`.
- A custom ledger must not have basename `MANIFEST.md`, `CONTINUITY.md`, or `SUMMARY.md` in any nested target-local subdirectory.
- A custom ledger must not resolve through a symlink to any reserved path or outside `.docs-review-fix/targets/<target-key>/`.

The key hash must be based on the target path, not the document content, because the target content changes during repair. SHA-256 truncated to 12 hex characters is recommended. MD5 is acceptable only as a non-security local fallback when SHA-256 is unavailable.

Target slug derivation is deterministic and readability-only:

1. Take the POSIX basename of `normalized-relative-target-path`.
2. Convert ASCII letters to lowercase.
3. Replace every character outside `[a-z0-9]` with `-`.
4. Collapse repeated `-` characters.
5. Trim leading and trailing `-`.
6. If the result is empty, use `target`.
7. Truncate the slug to 48 characters.

Slug collisions are allowed because the 12-hex hash segment is the identity. Implementations must not add counters or content-derived suffixes to resolve slug collisions.

The coordinator also records a target fingerprint in `MANIFEST.md`. The fingerprint is not used to locate the state directory. It is used only to detect stale state, external edits, or possible replacement when a user deletes a file and creates a different file at the same path.

The coordinator then builds the merged rule set in this order:

1. Workflow hard constraints.
2. Built-in `COMMON` rubric.
3. Built-in selected document-type rubric.
4. User-global `~/.docs-review-fix/RULE.md` `COMMON` section when present.
5. User-global `~/.docs-review-fix/RULE.md` selected type section when present.
6. Project-local `.docs-review-fix/RULE.md` `COMMON` section when present.
7. Project-local `.docs-review-fix/RULE.md` selected type section when present.

If `resume` is requested, the coordinator first reads `.docs-review-fix/targets/<target-key>/MANIFEST.md`, then reads the manifest's `Ledger path` value or defaults to `.docs-review-fix/targets/<target-key>/ISSUES.md`, then reads `CONTINUITY.md` when present before dispatching new work. Current repository state and the target document override stale state. If the manifest target path does not match the requested target, the coordinator must stop and ask for explicit target or state-directory confirmation instead of merging states.

### 8.2 Initial Context Pack

The coordinator prepares a compact context pack for each reviewer subagent and for any optional fixer subagent:

```text
Target document: <path>
Reference documents: <paths, read-only>
Document type: SPEC | PLAN | DESIGN | COMMON
Strictness: normal | strict
Mode: review-and-fix | read-only
Objective: review the full document, fix confirmed blocking issues when mode permits, and continue until a defined terminal or pause state is reached
Rules: <merged concise rule set>
Accepted non-blocking low issues: <issue IDs and anchors, or none>
Constraints:
- reviewer subagent is mandatory and read-only
- fixer subagent is optional and serial
- coordinator fixes directly by default
- only target document may be modified
- reference documents are read-only
- no unconfirmed requirements
- preserve scope and terminology
Strictness handling:
- normal: high and medium issues block PASS; low issues are reported but non-blocking unless they affect the objective
- strict: high, medium, and unresolved low issues block PASS; low issues stop blocking only when explicitly accepted as non-blocking by the coordinator and included in the review context
Output format: <structured findings or fix report>
```

The context pack should include only what the subagent needs. It should not include the full conversation history unless the history contains required requirements that are not captured elsewhere.

When reviewer subagents are unavailable, the automatic review-fix loop is unsupported. The coordinator may provide a read-only advisory review, but it must not claim PASS for the review-fix workflow.

Reviewer isolation is a capability, not a prompt promise. Before the first reviewer run, the coordinator must confirm that the runtime adapter can provide one of these mechanisms:

- A subagent or task context with no write-capable filesystem tools.
- A sandboxed reviewer workspace that cannot write to the target or reference files.
- A platform adapter that enforces write blocking around reviewer execution.

If the runtime can only ask the reviewer to behave read-only through text instructions, the route is advisory-only and must not enter the automatic review-fix loop.

### 8.3 Review Round

The coordinator dispatches a reviewer subagent with:

- The target path.
- Reference document paths and their read-only role.
- The merged rule set.
- Strictness: `normal` or `strict`.
- Mode: `review-and-fix` or `read-only`.
- The output schema.
- Read-only constraint.

This step is mandatory for every initial review. If the runtime cannot create an isolated reviewer subagent or equivalent read-only review task, the coordinator stops before fixing and reports the unsupported runtime capability.

Reviewer guard protocol:

1. Before dispatch, record SHA-256, file size, and modified timestamp for the target and all reference documents.
2. Dispatch the reviewer using an adapter that declares reviewer write isolation.
3. After the reviewer returns, recompute the same fingerprints.
4. If any target or reference fingerprint changed and the coordinator did not intentionally write the file, mark the round `blocked: reviewer-mutated-file`.
5. When `reviewer-mutated-file` occurs, the coordinator must stop before fixing or claiming PASS, report the changed path, and ask for user confirmation before restoring or continuing. It must not silently accept reviewer-written edits.

The initial review is a full-document review. If the initial reviewer returns `PASS`, the guard protocol passes, and the coordinator independently agrees, the workflow may complete without a fix round. A `full re-review` is required only after at least one fix round changes the target document.

The reviewer returns either:

```text
PASS
```

or:

```text
FAIL
Findings:
- id: R001
  severity: high | medium | low
  location: <section, heading, line, or quoted anchor>
  issue: <concrete problem>
  why_it_matters: <impact, with sensitive values redacted>
  suggested_fix: <specific correction>
  confidence: confirmed | unconfirmed
```

### 8.4 Finding Triage

The coordinator reviews findings before fixing.

For each finding, the coordinator decides:

- `accepted`: valid and should be fixed.
- `merged`: duplicate of another issue.
- `downgraded`: valid but lower severity.
- `rejected`: incorrect, out of scope, or based on a false premise.
- `deferred`: valid but intentionally not fixed now, with reason and owner. Deferral is a stop state for unresolved high or medium issues, not a PASS path.

All accepted high or medium issues block PASS until fixed or rejected. Deferred high or medium issues also block PASS; the workflow may stop as `stopped-with-deferrals`, with user-visible rationale and owner, but it must not report PASS. Deferred low issues do not block PASS in normal mode, but they block strict PASS unless explicitly accepted as non-blocking by the coordinator.

For long tasks, the coordinator writes triage results to the resolved ledger path recorded in `MANIFEST.md` before applying fixes. The default ledger is `.docs-review-fix/targets/<target-key>/ISSUES.md`; a valid `ledger=` value replaces only that target's ledger path.

### 8.5 Fix Round

The coordinator fixes accepted issues directly by default. It may dispatch a single fixer subagent only when the accepted issue list is bounded and every delegated issue has enough location and correction detail.

Target write lock:

- Before any coordinator or fixer writes the target document, the coordinator must acquire a target lock at `.docs-review-fix/targets/<target-key>/LOCK/` by atomically creating that directory.
- The lock directory contains `lease.json` with: `schemaVersion`, `targetKey`, `targetPath`, `ownerId`, `processId` when available, `hostname`, `startedAt`, `updatedAt`, `expiresAt`, `mode`, `strictness`, and `targetFingerprintAtAcquire`.
- `targetFingerprintAtAcquire` records the target content SHA-256, file size, and filesystem modified timestamp when available.
- Default lease duration is 15 minutes. The coordinator refreshes `updatedAt` and `expiresAt` before each target write and at least once every 60 seconds during a delegated fixer run.
- If an unexpired lock exists, the workflow stops as `blocked` with reason `lock-held`, reports the owner metadata, and must not write the target.
- If a lock directory exists without parseable `lease.json`, the workflow stops as `blocked` with reason `corrupt-lock`; it must not guess ownership or remove the lock automatically.
- If an expired lock exists, the coordinator may replace it only after recording the stale lease under `.docs-review-fix/targets/<target-key>/stale-locks/<timestamp>.json` and verifying that the current target fingerprint matches the last known fingerprint. If the fingerprint differs, stop as `externally-changed`.
- Immediately before applying any fix, the coordinator recomputes the target fingerprint. If it differs from `targetFingerprintAtAcquire` or the latest manifest `Last known content sha256`, the workflow stops as `externally-changed` before writing.
- The coordinator releases the lock only when the lock owner matches its own `ownerId`. Release means: reread `LOCK/lease.json`, verify `ownerId`, delete `LOCK/lease.json`, then remove the now-empty `LOCK/` directory. It must not leave a `released` marker inside `LOCK/`, because the presence of `LOCK/` blocks future atomic acquisition.
- If release fails after owner verification, the workflow records `blocked: lock-release-failed`, reports the lock path and owner metadata, and must not delete or modify another owner's lock.
- One-shot `read-only` without persistent state does not acquire a lock because it does not write the target or project state.

The fixer receives:

- Target document path.
- Reference document paths, if needed, marked read-only.
- Confirmed issue list.
- Scope and constraints.
- Required output format.

Fixer subagent constraints:

- Only one fixer subagent may run for a target document at a time.
- The fixer subagent may modify only the target document.
- The fixer subagent may fix only coordinator-accepted issue IDs.
- The fixer subagent must not add new background, goals, requirements, risk decisions, or external facts.
- The fixer subagent must not rewrite the whole document unless the accepted issue explicitly requires a structural rewrite.

Fix output:

```text
Fixed:
- ISSUE-001: <summary>
- ISSUE-002: <summary>

Files changed:
- <path>

Not fixed:
- ISSUE-003: <reason>

Residual risk:
- <risk, or "none identified">
```

For long tasks, the coordinator writes `.docs-review-fix/targets/<target-key>/CONTINUITY.md` after fixes and before the full re-review.

### 8.6 Diff Review

After a fix round, the coordinator checks the changed document and confirms:

- Every claimed fix maps to an accepted issue.
- The fix did not introduce unrelated scope.
- The document still uses consistent terminology.
- No placeholder text was added.
- The file remains readable and structurally coherent.

This diff review is not enough to complete the workflow. It only gates the next full re-review.

### 8.7 Full Re-Review

The coordinator dispatches a fresh reviewer subagent for a full new review. A runtime may reuse a prior reviewer only if it can provide a clean, self-contained review context equivalent to a fresh subagent.

The reviewer must review the full document, not only the diff.

If the reviewer returns new high or medium issues, the loop continues:

```text
triage -> fix -> diff review -> full re-review
```

If the reviewer returns only low issues, the coordinator may:

- Fix them when strict polish is requested.
- Record them as accepted low issues and complete if they do not block the stated objective.

### 8.8 Completion

The coordinator may complete the workflow only when:

- The initial full-document review returns PASS, or a post-fix full re-review returns PASS, or the relevant full-document review returns only accepted non-blocking low issues in normal mode.
- The coordinator independently agrees that there are no unresolved high or medium issues.
- The issue ledger is updated if one was used.
- The final response states what changed, what was verified, and any residual risk.

If any high or medium issue is deferred, the coordinator must not complete as PASS. It writes or reports `stopped-with-deferrals`, including the deferred issue IDs, reasons, owners, and next action.

If mode is `read-only` and the selected strictness leaves any blocking issue unresolved, the coordinator must not complete as PASS or attempt fixes. It writes or reports `read-only-findings`, including the issue IDs, severities, locations, and the command needed to rerun in `review-and-fix` mode.

If the task cannot finish in the current session, the coordinator must not claim PASS. It writes a checkpoint with the current phase and next action, then reports that the workflow is resumable.

## 9. Document Type Rubrics

Rubric selection has two layers:

- The built-in `COMMON` base rubric applies to every document.
- The selected type rubric applies on top: `SPEC`, `PLAN`, `DESIGN`, or `COMMON`.

User-global and project-local rules are merged after the built-in rubrics. Project-local rules have higher priority than user-global rules. Neither can override workflow hard constraints.

### 9.1 Common Base Rubric

Use for every document type. Also use as the full rubric for generic documents whose type is `COMMON`.

Missing background and goals do not require headings named `Background` or `Goals`, but the document must answer:

- why this document exists
- what outcome it is trying to achieve
- what source context, assumptions, and constraints it depends on

If this context is missing and cannot be derived from the target document or reference documents, the workflow must treat it as a blocking issue. The fixer must not invent background, goals, requirements, project facts, or risk decisions. It may add clearly marked `UNCONFIRMED` notes only when the workflow must stop for user input.

Blocking quality gates:

- The document does not contain enough background and objective context to judge correctness.
- The document's purpose is unclear.
- The document does not respond to its stated background, objective, or requirements.
- The document contradicts itself.
- The document contains ambiguity that affects understanding, execution, review, or acceptance.
- The document leaves unresolved questions that block execution, review, or acceptance.
- Material assumptions, constraints, dependencies, or source references are missing.
- Material risks are not identified, explained, mitigated, verified, constrained, or explicitly accepted.
- The document conflicts with current project code, architecture, conventions, dependencies, runtime environment, or established repository instructions.
- Current project alignment is relevant but cannot be verified from available context, and the document presents it as confirmed.
- The document is not concrete enough for the next step; a reader would have to invent key decisions, requirements, behavior, or acceptance criteria.
- The document is not actionable or cannot be turned into execution, review, or acceptance work.
- The document uses unstable external facts without verification.
- Terms are used inconsistently in a way that changes meaning.
- Placeholders such as `TBD`, `TODO`, "later", or "to be discussed" remain in sections needed for use.
- The document cannot be reviewed because important claims lack enough detail.

Reviewer questions:

- Can a reader understand what the document is for?
- Can a reader see why the document exists and what outcome it is trying to achieve?
- Does the content satisfy the stated background, goals, and requirements?
- Are assumptions, constraints, dependencies, source references, and risk decisions visible?
- Are terms used consistently?
- Are unresolved questions non-blocking and explicitly called out?
- Are material risks handled or explicitly accepted?
- Does the document align with the current project state?
- Can the next actor use the document without reopening major decisions?

PASS for `COMMON` means the document has sufficient context, is coherent, is aligned with known project facts, is actionable for its stated purpose, and has no unresolved high or medium issues.

### 9.2 Spec Rubric

Use for requirements, product behavior, API behavior, feature definition, or acceptance documents.

Additional blockers:

- Objective is unclear or internally inconsistent.
- Requirements do not respond to the background, goals, or source context.
- Scope and non-scope are missing where ambiguity affects implementation.
- Requirements contradict each other.
- Requirements leave unresolved product questions that block implementation or acceptance.
- Actors, permissions, inputs, outputs, data ownership, or integration boundaries are missing where they affect behavior.
- Key user or system behaviors, success paths, failure paths, or state transitions are unspecified.
- Acceptance criteria are missing, vague, or not verifiable.
- Error states, edge cases, concurrency, limits, permissions, privacy, security, or data boundaries are omitted when material.
- Requirements conflict with current system capabilities, data model, APIs, permission model, architecture, or runtime constraints.
- Requirement risks are not described, mitigated, constrained, or explicitly accepted.
- Requirements are not concrete enough for implementation; the implementer would need to redefine product behavior.

Reviewer questions:

- Can an implementer build from this without guessing product intent?
- Can a reviewer verify whether the implementation satisfies the spec?
- Are assumptions, non-goals, and product decisions explicit?
- Are boundaries, actors, inputs, outputs, data rules, and failure cases clear?
- Does the spec fit the current project implementation constraints?
- Are risks and product decisions resolved enough for implementation?

PASS for `SPEC` means the document is product-decision-complete, implementation-ready, and verifiable.

### 9.3 Plan Rubric

Use for implementation plans, migration plans, rollout plans, refactor plans, or execution checklists.

Additional blockers:

- The plan does not serve the background, objective, or approved spec/design context.
- Steps are not executable in order.
- Dependencies, prerequisites, environment assumptions, credentials, or required tooling are missing.
- A step requires a product, architecture, sequencing, ownership, or rollout decision that the plan has not made.
- The plan leaves unresolved technical route, sequencing, ownership, migration, or rollout questions.
- Plan steps conflict with each other.
- The plan conflicts with current code structure, build flow, deployment flow, dependency graph, architecture, or runtime environment.
- Verification commands, acceptance checks, smoke checks, or inspection criteria are absent.
- Rollback, failure handling, migration safety, data safety, compatibility, or operator communication is missing where material.
- Risks are not described, mitigated, verified, or explicitly accepted, especially migration, compatibility, data safety, security, and rollback risks.
- The plan changes more files, services, or external state than it acknowledges.
- The plan contains placeholders such as `TBD`, `TODO`, `later`, or "similar to above".
- The plan cannot be handed to another agent or engineer without re-planning.

Reviewer questions:

- Can another agent execute this plan without making architectural decisions?
- Does every meaningful change have a verification path?
- Are risks and blast radius explicit?
- Is there a safe stopping point or rollback story?
- Does the plan match the current project structure and tooling?
- Can the executor start without asking for route, order, or validation decisions?

PASS for `PLAN` means the document is ordered, executable, verifiable, rollback-aware where needed, and ready to hand to another agent or engineer.

### 9.4 Design Rubric

Use for UX, UI, architecture, system design, product design, or workflow design documents.

Additional blockers:

- The design does not respond to the background, goals, or user/system needs.
- The design is not detailed enough for implementation planning; implementers would have to fill in key behavior, state, or boundary decisions.
- The design contains ambiguity that affects implementation, review, or acceptance.
- The design leaves unresolved design, interaction, architecture, state, or boundary questions that block implementation.
- The design contradicts itself.
- The design conflicts with current project code, architecture, component system, dependencies, design system, or runtime constraints.
- User flows, states, or transitions are incomplete.
- Component responsibilities, system boundaries, contracts, data flow, or ownership boundaries are unclear.
- Empty, error, loading, disabled, permission, or edge states are missing where material.
- Accessibility, responsiveness, or localization implications are ignored when relevant.
- Implementation feasibility depends on unverified assumptions.
- Design risks are not described, mitigated, verified, or explicitly accepted.
- The design is not actionable enough to become a spec or implementation plan.
- The design over-specifies decorative details while under-specifying behavior.
- The design introduces hidden scope expansion that is not called out as an explicit tradeoff.

Reviewer questions:

- Can the design be implemented without inventing missing behavior?
- Are the important states and flows covered?
- Are constraints, tradeoffs, and rejected alternatives clear?
- Does the design avoid hidden scope expansion?
- Does the design align with the current project implementation surface?
- Are risks handled or explicitly accepted?
- Can this design be converted into a spec or plan without reopening core decisions?

PASS for `DESIGN` means the document is decision-complete enough to become a spec or implementation plan.

## 10. Severity Model

Use three severity levels.

### High

The document is misleading, contradictory, unsafe to execute, or missing information that will likely cause a wrong implementation.

High issues always block PASS.

### Medium

The document is mostly understandable but leaves meaningful ambiguity, verification gaps, or risk that should be resolved before execution.

Medium issues block PASS until fixed, merged into fixed issues, downgraded with rationale, or rejected with rationale. Deferring a medium issue stops the workflow as `stopped-with-deferrals`; it does not allow PASS.

### Low

The issue affects polish, readability, minor consistency, or optional completeness.

Low issues do not block PASS by default. They may block PASS in strict mode.

## 11. Issue Ledger Format

Recommended ledger schema:

```markdown
## Issue Ledger

| ID | Severity | Status | Location | Summary | Resolution |
| --- | --- | --- | --- | --- | --- |
| ISSUE-001 | high | fixed | Requirements / Auth | Missing failure behavior | Added explicit invalid-token flow |
| ISSUE-002 | medium | accepted | Rollout | No rollback step | Pending fix |
```

Allowed statuses:

- `accepted`
- `fixed`
- `merged`
- `rejected`
- `deferred`
- `reopened`

Ledger rules:

- Every accepted issue gets a stable ID.
- Fix reports must reference issue IDs.
- Reopened issues keep their original ID.
- Rejected issues need a short reason.
- Deferred issues need a reason and owner.
- Do not store raw sensitive logs, private credentials, tokens, cookies, private keys, or partial secret values.
- Secret-related issues must use `[REDACTED:<kind>]` and location anchors instead of raw values.

## 12. Project Working Directory and Context Management

The workflow should avoid relying on long chat history.

There are two `.docs-review-fix` locations with different responsibilities:

- `~/.docs-review-fix` is the user-global home. It stores global review rules plus installer-owned metadata and shared package assets.
- `<project>/.docs-review-fix` is the project working directory. It stores project-local rules and project-specific workflow state.

User-global layout:

```text
~/.docs-review-fix/
├── RULE.md
├── preferences.md
├── manifests/
├── capabilities/
├── backups/
├── shared/
```

User-global file roles:

- `RULE.md` stores global extra review rules.
- `preferences.md` is optional and may store non-sensitive user preferences.
- `manifests/` stores platform install manifests.
- `capabilities/` stores package-owned reviewer-isolation capability descriptors written by `drfx check`.
- `backups/` stores installer backups before overwrites.
- `shared/` stores installer-owned shared package assets.

User-global files must not store project-specific issue state, continuity state, raw logs, transcripts, or secrets. Uninstall may remove installer-owned `manifests/`, `capabilities/`, `backups/`, and `shared/` entries, but it must preserve user-authored `RULE.md` and `preferences.md`.

Persistent project working data should live under `.docs-review-fix` at the document project root. Project-local rules remain shared at the project level, but review state must be isolated per target document. The coordinator creates files lazily: do not create a file until the workflow has data that belongs there.

Project-local layout:

```text
.docs-review-fix/
├── RULE.md
├── index.md
└── targets/
    ├── <target-key>/
    │   ├── MANIFEST.md
    │   ├── CONTINUITY.md
    │   ├── ISSUES.md
    │   ├── LOCK/
    │   │   └── lease.json
    │   ├── stale-locks/
    │   ├── SUMMARY.md
    │   └── rounds/
    │       ├── 001-review.md
    │       ├── 001-fix.md
    │       └── 002-review.md
    └── <target-key>/
        └── ...
```

File roles:

- `RULE.md` stores project-local extra review rules.
- `index.md` optionally lists known target keys, target paths, document types, and last statuses.
- `targets/<target-key>/MANIFEST.md` stores the target path, document type, target key, ledger path, current status, current round, reference document list, and timestamps.
- `targets/<target-key>/CONTINUITY.md` stores compact handoff state for that target's long-running work.
- `targets/<target-key>/ISSUES.md` is the default ledger for accepted, fixed, rejected, deferred, and reopened issues for that target only. A custom `ledger=` path may replace it only when recorded in `MANIFEST.md`.
- `targets/<target-key>/LOCK/lease.json` stores the active target write lease when a fix round or coordinator write is in progress.
- `targets/<target-key>/stale-locks/` stores expired lock leases before takeover.
- `targets/<target-key>/SUMMARY.md` stores the current high-level review status for that target when useful.
- `targets/<target-key>/rounds/` stores review and fix artifacts for that target only when the user wants an auditable trail or the loop is long enough to need receipts.

Target key contract:

```text
normalized_target = normalized relative target path from the document project root
slug_source = POSIX basename(normalized_target)
safe_target_slug = deterministic_slug(slug_source)
hash_input = normalized_target
target_key = <safe-target-slug> + "-" + first_12_hex(sha256(hash_input))
```

Rules:

- The document project root must be resolved with the deterministic algorithm in section 8.1. The coordinator must not invent a "nearest stable" directory when none of the allowed root signals exists.
- If no root can be resolved and persistent state is needed, the coordinator must stop and ask for an explicit project root instead of writing `.docs-review-fix` beside the target by default.
- The project root is not included in `hash_input` because target state is already stored inside that project. This keeps target keys stable when the project directory is moved.
- The state directory identity is path-based, not content-based. Content hashes are unstable because the target document changes during repair.
- Content fingerprints must not participate in `target_key` calculation.
- Content fingerprints should include the current file content SHA-256, file size, and last modified timestamp when available.
- The normalized target path must use POSIX separators so the key is stable across shells.
- The target slug is for readability only. The hash segment is the identity.
- The target slug must use the deterministic slug derivation from section 8.1: POSIX basename, ASCII lowercase, non-`[a-z0-9]` to `-`, collapsed dashes, trimmed dashes, fallback `target`, and max length 48.
- Slug collisions must not change `target_key`; only the hash segment identifies the state directory.
- SHA-256 is the default hash. MD5 may be used only as a non-security fallback if the runtime cannot compute SHA-256.
- If the target file is renamed, the new path creates a new target key unless the user explicitly asks to migrate state.
- If the target path is the same but the current content fingerprint differs from `MANIFEST.md`, the coordinator must treat prior state as stale until a full re-review confirms the current document.
- The coordinator must never write target review state to project-root `.docs-review-fix/ISSUES.md`, `.docs-review-fix/CONTINUITY.md`, or `.docs-review-fix/SUMMARY.md`.

Example target workspace:

```text
.docs-review-fix/
├── RULE.md
├── index.md
└── targets/
    └── spec-md-3f9a12c8d441/
        ├── MANIFEST.md
        ├── CONTINUITY.md
        ├── ISSUES.md
        ├── LOCK/
        │   └── lease.json
        ├── stale-locks/
        ├── SUMMARY.md
        └── rounds/
```

Suggested `MANIFEST.md` shape:

```markdown
# Review Target Manifest

Target: docs/spec.md
Normalized target: docs/spec.md
Document type: SPEC
Strictness: normal | strict
Mode: review-and-fix | read-only
Target key: spec-md-3f9a12c8d441
Ledger path: .docs-review-fix/targets/spec-md-3f9a12c8d441/ISSUES.md
Status: review | triage | fix | diff-review | full-re-review | pass | stopped-with-deferrals | read-only-findings | blocked | unsupported | externally-changed | possible-target-replacement | checkpoint
Current round: 3
Initial content sha256: <sha256>
Last known content sha256: <sha256>
Last reviewed content sha256: <sha256>
Last passed content sha256: <sha256 or none>
Last modified at: <filesystem timestamp>
File size: <bytes>
References:
- docs/prd.md
Created at: 2026-05-19T00:00:00Z
Updated at: 2026-05-19T00:00:00Z
```

Checkpoint contract:

- After review: write the review result, accepted finding candidates, and next triage step.
- After triage: write stable issue IDs and statuses.
- After fix: write fixed issue IDs, files changed, and residual risks.
- Before stopping: write the current phase, current round, blocker if any, and exact next action.
- On resume: derive the target key, read that target's `MANIFEST.md`, read the manifest `Ledger path` or default `ISSUES.md`, read `CONTINUITY.md` when present, restore strictness and mode, verify the current content fingerprint, rebuild rules from current files, then continue from the recorded next action.

Resume must preserve strictness and mode:

- `MANIFEST.md` records the strictness and mode used when the target state was created or last intentionally changed.
- If resume is invoked without explicit strictness or mode, use the manifest values.
- If resume is invoked with different strictness or mode, stop before review or fixing and ask whether to continue with the manifest values or start a new review round with the new values.
- A `read-only` manifest must never resume into `review-and-fix` without explicit user confirmation.

Fingerprint resume rules:

- If the current fingerprint matches `Last known content sha256`, continue normally.
- If the current fingerprint differs and the manifest status is not `pass`, set status to `externally-changed`, require a full re-review, and reopen affected issues when uncertain.
- If the current fingerprint differs and the manifest status is `pass`, do not reuse the old PASS result. Mark the prior PASS as stale and start a new review round.
- If the target file is missing, mark the target state `blocked` and stop.
- If the current file appears to be a replacement at the same path, such as a different title, purpose, or structure with no continuity from the manifest, set status to `possible-target-replacement` and ask the user whether to restart with the existing target key or archive/migrate the old state.

Fingerprint update rules:

| Event | Initial content sha256 | Last known content sha256 | Last reviewed content sha256 | Last passed content sha256 | Status notes |
|---|---|---|---|---|---|
| Create persistent target state | Set to current content. | Set to current content. | `none` until first full review completes. | `none` until PASS. | Create `MANIFEST.md` before the first reviewer run only when persistent state is needed. One-shot `read-only` without `ledger=` or `resume` does not create `MANIFEST.md`. |
| Full review returns FAIL | Unchanged. | Set to reviewed content. | Set to reviewed content. | Unchanged. | Store findings in the resolved ledger path recorded in `MANIFEST.md`. |
| Initial full review returns PASS | Unchanged. | Set to passed content. | Set to passed content. | Set to passed content. | Status becomes `pass` without a fix round. |
| Fix round changes target | Unchanged. | Set to fixed content. | Unchanged until the next full re-review. | Unchanged. | Status becomes `diff-review` or `full-re-review`. |
| Full re-review returns PASS | Unchanged. | Set to passed content. | Set to passed content. | Set to passed content. | Status becomes `pass`. |
| External edit detected on resume | Unchanged. | Do not overwrite before recording stale state. | Unchanged until full re-review. | Unchanged. | Set status to `externally-changed`; require full re-review. |
| Same-path replacement confirmed | Set from the new document only after restart is confirmed. | Set from the new document only after restart is confirmed. | `none` until full review. | `none` until PASS. | Archive or migrate old state before restart. |

If the user chooses to restart after same-path replacement, the coordinator archives the old target directory under `.docs-review-fix/targets/archive/<target-key>-<timestamp>/` before creating a fresh `MANIFEST.md` at the original target key. If the user chooses to migrate, the coordinator must write a migration note to the new `MANIFEST.md` and keep old issue IDs closed rather than silently reusing them.

Use `.docs-review-fix/targets/<target-key>/CONTINUITY.md` when:

- The review loop is likely to span multiple rounds.
- The target document is large.
- Multiple subagents are used.
- The context window may compact before completion.
- There are important decisions that future agents must preserve.

Suggested `.docs-review-fix/targets/<target-key>/CONTINUITY.md` sections:

```markdown
# Continuity

## Snapshot
- <date> [USER] Objective: review and fix <path> as <type> until PASS or a defined terminal/pause state.

## Decisions
- <date> [CODE] D001: Use <rubric> rubric.
- <date> [CODE] D002: Strictness is <normal|strict>; mode is <review-and-fix|read-only>.

## Done (recent)
- <date> [TOOL] Reviewer round 1 completed.

## Now
- Current round: fix accepted issues.

## Next
- Full re-review after fixes.

## Open questions
- None.

## Working set
- <target path>
- references: <read-only paths>

## Receipts
- <date> [TOOL] Reviewer round 1: FAIL, 3 findings.
```

Continuity files must stay compact. They are handoff briefs, not logs.

## 13. Subagent Prompt Templates

### 13.1 Reviewer Prompt

```text
You are the reviewer subagent for document-review-loop.

Mode: read-only. Do not modify files.

Target document: <path>
Reference documents: <paths, read-only>
Document type: <SPEC|PLAN|DESIGN|COMMON>
Strictness: <normal|strict>
Mode: <review-and-fix|read-only>
Merged review rules:
<merged common + type + project rules>
Accepted non-blocking low issues:
<issue IDs and anchors, or none>

Objective:
Review the full target document and decide whether it can PASS.

Instructions:
- Review the whole document, not only recent changes.
- Use reference documents only to check consistency, coverage, and constraints.
- Do not request or make changes to reference documents.
- Report concrete issues only.
- Do not suggest broad rewrites unless the structure itself blocks execution.
- Mark uncertain external facts as UNCONFIRMED.
- If you find suspected secrets or credentials, do not quote them. Use the path, line, heading, or non-sensitive anchor, set `sensitive: true`, and redact values as `[REDACTED:<kind>]`.
- In normal strictness, PASS only if there are no high or medium issues.
- In `strict` strictness, PASS only if there are no high or medium issues and no low issues except coordinator-accepted non-blocking low issues explicitly listed in this prompt.
- Always report low issues that would block strict PASS, even when running in normal strictness.

Output:
PASS

or:

FAIL
Findings:
- id: R001
  severity: high | medium | low
  location: <heading, section, line, or quoted anchor>
  issue: <specific issue>
  why_it_matters: <impact, with sensitive values redacted>
  suggested_fix: <specific fix>
  confidence: confirmed | unconfirmed
  sensitive: true | false
```

### 13.2 Fixer Prompt

```text
You are the fixer subagent for document-review-loop.

Target document: <path>
Reference documents: <paths, read-only>

Confirmed issues:
<issue list>

Constraints:
- Fix only confirmed issues.
- Modify only the target document unless explicitly instructed.
- Treat reference documents as read-only.
- Do not expand scope.
- Do not invent requirements.
- Preserve terminology and structure unless an issue requires changing them.
- Do not quote raw secrets, credentials, cookies, tokens, private keys, or raw sensitive logs in the fix report. Use `[REDACTED:<kind>]` and location anchors.
- If an issue cannot be fixed cleanly, report it instead of guessing.

Output:
Fixed:
- ISSUE-001: <summary>

Files changed:
- <path>

Not fixed:
- <issue and reason, or none>

Residual risk:
- <risk, or none identified>
```

### 13.3 Coordinator Prompt

```text
You are the coordinator for document-review-loop.

Own the review-fix loop. Use reviewer subagents for every read-only review. Fix accepted issues directly by default, or use one serial fixer subagent only for bounded issue lists.

Target document: <path>
Reference documents: <paths, read-only>
Document type: <SPEC|PLAN|DESIGN|COMMON>
Entry skill: <review-fix-spec|review-fix-plan|review-fix-design|review-fix-doc>
Strictness: <normal|strict>
Mode: <review-and-fix|read-only>

Loop:
1. Select the rubric.
2. Read `~/.docs-review-fix/RULE.md` and `.docs-review-fix/RULE.md` if present.
3. Derive `.docs-review-fix/targets/<target-key>/`.
4. Merge built-in and project rules, including strictness handling.
5. Send a compact context pack to a reviewer subagent.
6. Triage findings into the resolved ledger path recorded in `MANIFEST.md` when persistent state is needed.
7. If the initial full-document reviewer PASSes and the coordinator agrees, complete as PASS.
8. If mode is read-only and findings block PASS under the selected strictness, stop as `read-only-findings`; otherwise report PASS or non-blocking findings without fixing.
9. Acquire the target write lock before any target modification.
10. Fix accepted issues directly by default, or with one bounded fixer subagent.
11. Checkpoint `.docs-review-fix/targets/<target-key>/CONTINUITY.md` when the task is long-running.
12. Review the diff.
13. Run a full-document re-review through a reviewer subagent.
14. Repeat until PASS, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.

All issue summaries, ledgers, round receipts, and final responses must redact sensitive values as `[REDACTED:<kind>]` and use location anchors instead of raw secrets.

Only mark complete as PASS when an initial full-document review or a post-fix full re-review passes and the coordinator review also passes. Do not require a post-fix full re-review when no fix round changed the target document.
```

## 14. Entry Skill Package

The package exposes four small user-facing skills. Each entry skill fixes one document type and delegates to the shared core workflow.

```text
review-fix-spec
  type: SPEC
  use: requirements, product behavior, API behavior, acceptance criteria

review-fix-plan
  type: PLAN
  use: implementation plans, migration plans, rollout plans, execution checklists

review-fix-design
  type: DESIGN
  use: UX, UI, product design, architecture design, workflow design

review-fix-doc
  type: COMMON
  use: generic documents that do not fit SPEC, PLAN, or DESIGN
```

Entry skill body requirements:

- Keep each `SKILL.md` short.
- State the fixed document type.
- Load the shared core workflow.
- Load `rubrics/common.md` and the type-specific rubric.
- Read user-global `~/.docs-review-fix/RULE.md` and project-local `.docs-review-fix/RULE.md` when present.
- Run the loop until `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, or checkpoint.

The entry skills in the source package must not copy the full workflow. They should reference the same shared source files so the process cannot drift across document types. Generated platform routes may contain installer-produced copies only when the target runtime needs self-contained files; those copies are build artifacts regenerated from the shared source, not independently maintained workflow definitions.

## 15. Runtime Execution Notes

The workflow must run on supported agents through the same coordinator/reviewer/fixer contract. Claude and Codex adapters should map reviewer work to their native subagent or Task-style delegation features. Any additional platform adapter must provide equivalent reviewer isolation or mark the workflow as advisory-only.

### 15.1 Reviewer Subagent Requirement

The automatic review-fix loop requires a reviewer subagent or equivalent isolated read-only review task.

- Reviewer subagents are mandatory for initial review and every full re-review.
- Reviewer subagents are read-only.
- The coordinator must stop before fixing if reviewer subagent isolation is unavailable.
- A local same-context review may be offered only as advisory output and must not produce workflow PASS.
- The coordinator remains responsible for triage, diff review, full re-review, and PASS.

Minimum adapter contract for reviewer isolation:

- `can_spawn_isolated_reviewer`: the adapter can run a reviewer in a separate context from the coordinator.
- `reviewer_write_blocked`: the adapter can prevent writes to the target and reference paths during reviewer execution.
- `fingerprint_guard_available`: the coordinator can hash and stat the target and references before and after review.
- `advisoryReason`: required when any of `can_spawn_isolated_reviewer`, `reviewer_write_blocked`, or `fingerprint_guard_available` is not `verified`.

`drfx check` must report these capabilities per installed platform. A platform is PASS-capable only when the first three fields are `verified`. Otherwise the generated route may run advisory review, but it must not fix files or report workflow PASS.

Capability values:

- `verified`: proven by the current `drfx check` run through a runtime capability API or local fixture probe that does not touch user documents.
- `unverified`: the route exists, but the installer cannot prove write blocking or isolated reviewer execution.
- `unsupported`: the platform route cannot provide the capability.

`drfx check` must not mark `reviewer_write_blocked` as `verified` from platform name, generated prompt text, or reviewer instructions alone. If no machine-verifiable adapter contract or local probe exists for Claude or Codex in the current installation, the route is advisory-only until that capability can be verified. The fingerprint guard is required but is not sufficient by itself; it detects accidental mutation after the fact, while write blocking is required to enter the automatic PASS workflow.

Capability descriptor contract:

- `drfx check` writes package-owned capability reports to `~/.docs-review-fix/capabilities/<platform>.json`.
- The descriptor is mutable check output, not install-owned immutable input. `drfx check` may read an existing descriptor only to report previous status or detect stale package versions; it must run the adapter checks again before writing any `verified` value.
- The installer may create a descriptor with `unverified` or `unsupported` values and `provenance.source: "installer-default"`, but installer-created descriptors must never contain `verified`.
- Descriptor schema:

  ```json
  {
    "schemaVersion": 1,
    "packageName": "@xenonbyte/document-review-fix",
    "packageVersion": "<semver>",
    "platform": "claude|codex|gemini",
    "adapterVersion": "<string or none>",
    "checkedAt": "<ISO-8601 timestamp>",
    "provenance": {
      "source": "drfx-check-probe|runtime-capability-api|installer-default",
      "runId": "<uuid or none>",
      "generatedBy": "drfx check|drfx install",
      "packageVersion": "<semver>"
    },
    "capabilities": {
      "can_spawn_isolated_reviewer": {
        "status": "verified|unverified|unsupported",
        "proof": "adapter-descriptor|local-probe|none",
        "proofRunId": "<same runId when verified, otherwise none>",
        "detail": "<short non-sensitive explanation>"
      },
      "reviewer_write_blocked": {
        "status": "verified|unverified|unsupported",
        "proof": "adapter-descriptor|local-probe|none",
        "proofRunId": "<same runId when verified, otherwise none>",
        "detail": "<short non-sensitive explanation>"
      },
      "fingerprint_guard_available": {
        "status": "verified|unverified|unsupported",
        "proof": "node-crypto-stat-probe|none",
        "proofRunId": "<same runId when verified, otherwise none>",
        "detail": "<short non-sensitive explanation>"
      }
    },
    "advisoryReason": "<required unless all three statuses are verified>"
  }
  ```

Verification rules:

- `fingerprint_guard_available` is verified by a local Node fixture that writes two temporary files under the OS temp directory, computes SHA-256, file size, and mtime, mutates one fixture, and confirms the change is detected.
- `can_spawn_isolated_reviewer` is verified only by the current run's runtime capability API response or local adapter probe proving the reviewer runs in a separate context from the coordinator.
- `reviewer_write_blocked` is verified only by the current run's runtime capability API response or local adapter probe proving the reviewer context has no write-capable filesystem tools or is sandbox-denied from writing the fixture target and reference files.
- A prompt that tells the reviewer "do not write" is not proof.
- A fingerprint guard success is not proof of write blocking.
- Gemini v1 descriptors must set `can_spawn_isolated_reviewer` and `reviewer_write_blocked` to `unsupported` unless a future design defines a verified adapter.
- If `~/.docs-review-fix/capabilities/<platform>.json` is missing, malformed, stale for a different package version, has `provenance.source: "installer-default"`, has missing or mismatched `proofRunId` for a `verified` capability, or contains any non-verified required capability after the current run, `drfx check` reports the platform as advisory-only.

Probe implementation contract:

- `lib/check.js` calls `lib/adapters/<platform>.js` `checkCapabilities({ packageVersion, tmpDir, timeoutMs })` for each installed platform.
- Each adapter probe creates a temporary target and reference file under the OS temp directory, never under a user document project.
- A probe result may mark `can_spawn_isolated_reviewer` as `verified` only when the adapter can show a separate reviewer execution context through a runtime-provided capability API, tool policy descriptor, or probe runner that returns a reviewer context ID distinct from the coordinator context.
- A probe result may mark `reviewer_write_blocked` as `verified` only when the adapter attempts a fixture write from the reviewer context and observes a deterministic denial, or when the runtime capability API reports no write-capable filesystem tool is available to that reviewer context.
- If the adapter cannot execute the reviewer-context probe non-interactively, it must return `unverified`, not prompt the user to perform a manual test.
- A stored descriptor is never proof by itself. `adapter-descriptor` proof is valid only inside the same `drfx check` invocation that obtained a runtime capability API response or local probe result and wrote a matching `proofRunId`. A hand-authored descriptor, old descriptor, platform name, install presence, or generated prompt text is not proof.
- Generated review routes must call `drfx check` or the same check library at workflow start before entering automatic PASS mode; they must not trust a previously written descriptor without rerunning the current adapter checks.
- Claude and Codex are `verified` only when their installed route exposes the probe or capability API above. Otherwise they are advisory-only. Gemini is advisory-only in v1.

### 15.2 Fixer Execution

Fixing defaults to the coordinator. A fixer subagent is an optional optimization, not a required role.

- Use coordinator fixing for small documents, judgment-heavy edits, or tightly coupled wording.
- Use one fixer subagent only when the accepted issue list is confirmed, bounded, and location-specific.
- Only one fixer may edit the target document at a time.
- The fixer subagent may modify only the target document and only accepted issue IDs.
- The coordinator must review the diff before requesting the next reviewer subagent pass.

### 15.3 Long-Task Support

Long-task support is file-backed. It does not depend on runtime memory or a session-specific objective feature.

The coordinator must checkpoint when:

- The document is large.
- The loop has more than one review/fix round.
- Multiple subagents have contributed findings.
- Context pressure is likely.
- The user interrupts or asks to pause.
- The agent cannot finish in the current run.

Resume behavior:

- Derive `.docs-review-fix/targets/<target-key>/` from the requested target path.
- Read `.docs-review-fix/targets/<target-key>/MANIFEST.md`.
- Read `.docs-review-fix/targets/<target-key>/CONTINUITY.md`.
- Read the ledger path recorded in `MANIFEST.md`, defaulting to `.docs-review-fix/targets/<target-key>/ISSUES.md` when absent.
- Confirm the target document still matches the manifest target path.
- Restore strictness and mode from `MANIFEST.md`. If the current invocation supplies different strictness or mode, stop and ask whether to resume with the recorded settings or start a new review round with the new settings.
- Compute the current content fingerprint and compare it with `MANIFEST.md`.
- Rebuild the merged rule set from current files.
- Continue from the recorded `next action`.
- If state conflicts with the current document, trust the current document and reopen affected issues.
- If the manifest target path conflicts with the requested target, stop and ask before reading or merging another target's state.
- If the prior status was `pass` but the current content fingerprint differs from the last passed fingerprint, clear PASS and start a new review round.
- If the file appears to be a different document at the same path, stop and ask whether to restart or archive/migrate old state.

## 16. Platform Installation and Uninstallation

The package provides an OpsX-style CLI for installing and removing platform routes.

```text
drfx install --platform <claude|codex|gemini[,...]>
drfx uninstall --platform <claude|codex|gemini[,...]>
drfx check
```

Supported platforms:

- `claude`
- `codex`
- `gemini`

Platform capability matrix:

| Platform | Route install | Reviewer isolation | Automatic PASS workflow |
|---|---:|---|---|
| `claude` | yes | PASS-capable only when the installed route can run an isolated reviewer with verified write blocking and fingerprint guard. | yes when `drfx check` reports all reviewer isolation fields as `verified` |
| `codex` | yes | PASS-capable only when generated skills can delegate reviewer work to an isolated read-only context with verified write blocking and fingerprint guard. | yes when `drfx check` reports all reviewer isolation fields as `verified` |
| `gemini` | yes | v1 generated Gemini routes are advisory-only. | no in v1 |

Installed routes for advisory-only platforms may run read-only review and explain missing runtime capability. They must not run fixes or report workflow PASS.

The installer must write a manifest for each platform:

```text
~/.docs-review-fix/manifests/claude.manifest
~/.docs-review-fix/manifests/codex.manifest
~/.docs-review-fix/manifests/gemini.manifest
```

The manifest records generated platform files and directories. The uninstaller reads the manifest and removes only recorded paths under allowed install roots.

Manifest schema:

```yaml
schemaVersion: 1
packageName: "@xenonbyte/document-review-fix"
packageVersion: "<semver>"
platform: "claude | codex | gemini"
installedAt: "<ISO-8601 timestamp>"
updatedAt: "<ISO-8601 timestamp>"
installRoot: "<platform install root>"
allowedRoots:
  - "<absolute allowed root>"
sharedAssets:
  path: "~/.docs-review-fix/shared"
  checksum: "<sha256 or none>"
capabilityDescriptor:
  path: "~/.docs-review-fix/capabilities/<platform>.json"
  mutable: true
generated:
  - path: "<absolute generated file or directory>"
    kind: "file | directory"
    action: "created | overwritten"
    checksum: "<sha256 for files, none for directories>"
backups:
  - originalPath: "<absolute overwritten path>"
    backupPath: "~/.docs-review-fix/backups/<platform>/<timestamp>/<name>"
    checksum: "<sha256>"
```

`capabilityDescriptor` is recorded as a mutable report path, not as a checksum-locked install artifact. `drfx check` owns updates to that file after install, so the platform manifest must not treat descriptor checksum drift as uninstall tampering.

Manifest rules:

- `generated[].path` is the only source of truth for uninstall.
- `allowedRoots` must be checked before removing any path.
- `backups[]` records overwritten files but uninstall must not restore backups automatically unless the user explicitly requests restore.
- `packageVersion` lets future installers migrate generated files.
- Missing manifests make uninstall idempotent: report nothing to remove and exit successfully.

### 16.1 Shared Install Home

`~/.docs-review-fix` has two user-global responsibilities:

- User-authored global rules: `RULE.md` and optional `preferences.md`.
- Installer-owned metadata and shared package assets.

Recommended user-global layout:

```text
~/.docs-review-fix/
├── RULE.md
├── preferences.md
├── manifests/
│   ├── claude.manifest
│   ├── codex.manifest
│   └── gemini.manifest
├── capabilities/
│   ├── claude.json
│   ├── codex.json
│   └── gemini.json
├── backups/
├── shared/
    ├── core.md
    ├── long-task.md
    ├── rubrics/
    └── prompts/
```

Installer-owned files may be removed when all platform manifests are gone. User-authored `RULE.md` and `preferences.md` must survive uninstall.

### 16.2 Claude Install

Claude installs command files:

```text
~/.claude/commands/review-fix-spec.md
~/.claude/commands/review-fix-plan.md
~/.claude/commands/review-fix-design.md
~/.claude/commands/review-fix-doc.md
```

Claude invocation:

```text
/review-fix-spec target=docs/spec.md ref=docs/prd.md
```

Uninstall removes only manifest-recorded `review-fix-*` command files.

### 16.3 Codex Install

Codex installs generated skills, not slash-command files. This is the important platform difference.

Install paths:

```text
~/.codex/skills/review-fix-spec/SKILL.md
~/.codex/skills/review-fix-plan/SKILL.md
~/.codex/skills/review-fix-design/SKILL.md
~/.codex/skills/review-fix-doc/SKILL.md
```

Each generated Codex skill must:

- Have a distinct `name` matching the public skill route.
- Fix the document type internally.
- Include or reference the shared core workflow, long-task protocol, prompts, and rubrics.
- Be self-contained enough for Codex progressive disclosure to work without asking the user to paste prompts.

Codex install ownership rules:

- Each generated skill directory must contain a package ownership marker, such as `.document-review-loop-owned`, plus generated `SKILL.md`.
- If the target skill directory does not exist, install creates it.
- If the target skill directory exists and contains this package's ownership marker, install backs up the entire directory before replacing generated contents.
- If the target skill directory exists without this package's ownership marker, install must refuse to overwrite, merge, or back up the directory automatically. It reports the path and asks the user to move, remove, or explicitly handle the existing user-owned skill.
- If the target path exists as a file or symlink instead of a directory, install must refuse and report the path.

Codex invocation:

```text
$review-fix-spec target=docs/spec.md ref=docs/prd.md
$review-fix-plan target=docs/plan.md ref=docs/spec.md
```

Codex uninstall:

- Read `~/.docs-review-fix/manifests/codex.manifest`.
- Remove only recorded generated skill directories under `~/.codex/skills/review-fix-*`.
- Clean up legacy generated prompt routes under `~/.codex/prompts/review-fix-*` only when an older manifest records those paths or the files contain a package ownership marker written by this package.
- Do not remove unrelated user skills in `~/.codex/skills`.
- Do not remove `~/.docs-review-fix/RULE.md`, `~/.docs-review-fix/preferences.md`, or any project-local `.docs-review-fix` directory.

### 16.4 Gemini Install

Gemini installs command TOML files. Gemini support is route-install support in v1. V1 Gemini routes are advisory-only because the design does not define a verified Gemini reviewer-isolation adapter yet. Generated Gemini commands must run read-only review, report findings, and explain that automatic fixing and workflow PASS are unavailable on Gemini v1 routes.

```text
~/.gemini/commands/review-fix-spec.toml
~/.gemini/commands/review-fix-plan.toml
~/.gemini/commands/review-fix-design.toml
~/.gemini/commands/review-fix-doc.toml
```

Gemini invocation:

```text
/review-fix-spec target=docs/spec.md ref=docs/prd.md
```

Uninstall removes only manifest-recorded `review-fix-*` TOML files.

### 16.5 Safety Rules

- Install must back up existing generated target files and package-owned generated directories before overwriting them.
- Install must write platform manifests after successful generation.
- Uninstall must refuse to remove paths outside allowed platform roots.
- Uninstall must be idempotent when a manifest is missing.
- Uninstall must preserve user-global rules and project-local workflow state.
- `drfx check` must report installed platform manifests, capability descriptor status under `~/.docs-review-fix/capabilities/<platform>.json`, global rule presence, project-local `.docs-review-fix` status for the current directory, and reviewer-isolation capability fields for each installed platform.

Path and ownership safety:

- All install, backup, and uninstall paths must be resolved with platform path normalization before use.
- `~` must be expanded only for documented user-home locations. Environment variable expansion is not allowed in manifest paths.
- `allowedRoots` entries must be absolute canonical directories.
- A generated path is removable only when its canonical path is inside an allowed root and it matches the platform route allowlist:
  - Claude: `~/.claude/commands/review-fix-*.md`
  - Codex: `~/.codex/skills/review-fix-*/`
  - Codex legacy prompts: `~/.codex/prompts/review-fix-*` only with manifest or ownership marker
  - Gemini: `~/.gemini/commands/review-fix-*.toml`
- Install must refuse to overwrite a symlink at any generated file path.
- Uninstall must refuse to remove a symlink even if the manifest records it.
- Directory removal is allowed only for generated route directories that contain a package ownership marker or whose children are all recorded in the manifest.
- Directory overwrite is allowed only for package-owned generated directories. Non-owned directories are never merged, overwritten, or auto-backed-up in v1.
- Existing non-generated user files at a target path must be backed up before overwrite, and the manifest must record `action: overwritten`.
- Missing manifests are idempotent: uninstall reports "nothing to remove" and exits successfully. It must not scan broad directories looking for unrecorded files.
- Backup restore is never automatic during uninstall. Restore requires an explicit future command or user instruction.

## 17. PASS Criteria

General PASS:

- The merged rule set returns no high or medium issues.
- The coordinator agrees with the PASS result.
- All accepted high and medium issues are fixed, merged into fixed issues, downgraded with rationale, or rejected with rationale.
- Deferred high or medium issues are not PASS-compatible. They produce `stopped-with-deferrals` with user-visible rationale, owner, and next action.
- No placeholders remain in sections required for execution.
- The document's scope, constraints, assumptions, risks, and validation path are clear enough for its type.

Type-specific PASS:

- `COMMON`: coherent, usable for its stated purpose, and internally consistent.
- `SPEC`: implementation-ready and acceptance-testable.
- `PLAN`: executable by another agent or engineer without re-planning.
- `DESIGN`: decision-complete enough to become a spec or implementation plan.

Strict PASS additionally requires:

- Low issues fixed or explicitly accepted as non-blocking by the coordinator and carried into any later reviewer context.
- Terminology and formatting are consistent.
- The final document reads as a polished handoff artifact.

## 18. Documentation Output

The package must ship a root `README.md`. A localized `README-zh.md` may be added later, but v1 requires `README.md`.

The README is user-facing. It should not expose internal reviewer, fixer, or coordinator prompt templates as the primary interface.

Required README sections:

### 18.1 Installation

The README must show npm installation:

```text
npm install -g @xenonbyte/document-review-fix
```

It must state that the installed CLI binary is `drfx`.

### 18.2 Platform Install and Uninstall

The README must show platform installation and removal:

```text
drfx install --platform claude,codex,gemini
drfx uninstall --platform claude,codex,gemini
drfx check
```

It must explain platform differences:

- Claude installs `/review-fix-*` command files under `~/.claude/commands`.
- Gemini installs `/review-fix-*` TOML command files under `~/.gemini/commands`.
- Codex installs generated `$review-fix-*` skills under `~/.codex/skills/review-fix-*`.
- Claude and Codex are PASS-capable only when `drfx check` reports isolated reviewer execution, write blocking, and fingerprint guard support as `verified`.
- Gemini v1 routes are advisory-only. They must not run fixes or report workflow PASS.
- `drfx check` reads `~/.docs-review-fix/capabilities/<platform>.json`, runs safe local probes where available, and reports the exact reason a platform is advisory-only.

The Codex note is required because Codex uses skills, not slash-command files.

### 18.3 Four Command Usage Guide

The README must document all four commands:

```text
review-fix-spec    review and fix SPEC documents
review-fix-plan    review and fix PLAN documents
review-fix-design  review and fix DESIGN documents
review-fix-doc     review and fix COMMON documents
```

It must include examples for:

```text
review-fix-spec docs/spec.md
review-fix-plan docs/plan.md strict
review-fix-design docs/design.md read-only
review-fix-doc docs/notes.md resume
review-fix-spec target=docs/spec.md ref=docs/prd.md
```

It must explain that `target` is the only writable document and `ref` documents are read-only.
It must document the input parsing rules from section 8.1, including `target=`, repeated `ref=`, `ledger=` being restricted to `<project-root>/.docs-review-fix/targets/<target-key>/`, mutually exclusive flags, unknown flag handling, and the behavior of `read-only` mode.
It must explain strictness:

- `normal` is the default. High and medium issues block PASS; low issues are reported but non-blocking unless they affect the objective.
- `strict` makes unresolved low issues block PASS.
- A low issue may stop blocking strict PASS only when the coordinator explicitly accepts it as non-blocking and carries that accepted low issue into later reviewer context.

It must explain that `read-only` mode never fixes the target. If read-only mode finds issues that block PASS under the selected strictness, the route ends as `read-only-findings` and reports how to rerun in `review-and-fix` mode.

### 18.4 Built-In Review Rules

The README must summarize the built-in review constraints for all four document types:

- `COMMON`: sufficient background and objective context, stated purpose, response to goals and requirements, internal consistency, no blocking ambiguity, visible assumptions and constraints, no blocking unresolved questions, handled or accepted risks, alignment with current project facts, actionability, terminology consistency, no required-section placeholders, and verified external facts.
- `SPEC`: requirement completeness, response to goals and source context, scope and non-scope boundaries, actors, permissions, inputs, outputs, data ownership, integration boundaries, user/system behavior, success and failure paths, acceptance criteria, material edge cases, implementation fit, product decision resolution, risk handling, and verifiability.
- `PLAN`: relation to approved spec/design context, executable step order, dependencies, prerequisites, environment assumptions, required tooling, resolved route and sequencing decisions, project/tooling fit, verification commands or acceptance checks, rollback, failure handling, migration and data safety, compatibility, blast radius, risk handling, and handoff readiness.
- `DESIGN`: response to background, goals, and user/system needs, sufficient implementation detail, no blocking ambiguity, resolved interaction/state/boundary decisions, internal consistency, project/code/component-system fit, user flows, states, transitions, contracts, data flow, ownership boundaries, accessibility, responsiveness, localization, implementation constraints, risk handling, and no hidden scope expansion.

The README should link to or mention the detailed rubric files under `shared/rubrics/`.

### 18.5 Review-Fix Flow

The README must explain the loop:

```text
review -> triage -> fix -> diff review -> full re-review -> repeat until PASS or a defined terminal/pause state
```

It must state:

- Reviewer work runs in a mandatory read-only subagent or equivalent isolated review task.
- The coordinator fixes directly by default.
- A fixer subagent is optional, bounded, and serial.
- Only the target document may be modified.
- Target modification requires the target lock and pre-fix fingerprint guard.
- Every fix round requires a full-document re-review.
- PASS requires no unresolved high or medium issues.
- Deferred high or medium issues stop as `stopped-with-deferrals`; they do not count as PASS.
- The loop may also stop as `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or a resumable checkpoint.
- Long tasks checkpoint to `.docs-review-fix/targets/<target-key>/`.
- Findings, ledgers, receipts, and final responses redact secret-like values as `[REDACTED:<kind>]`.
- Runtimes without reviewer subagent isolation can provide advisory review only; they must not claim workflow PASS.

### 18.6 User-Global and Project-Local Rule Configuration

The README must document both rule locations:

```text
~/.docs-review-fix/RULE.md
<project>/.docs-review-fix/RULE.md
```

It must show the expected format:

```markdown
## COMMON

Extra common rules.

## SPEC

Extra spec rules.

## PLAN

Extra plan rules.

## DESIGN

Extra design rules.
```

It must explain precedence:

```text
1. workflow hard constraints
2. built-in COMMON rubric
3. built-in selected type rubric
4. user-global RULE.md COMMON
5. user-global RULE.md selected type
6. project-local RULE.md COMMON
7. project-local RULE.md selected type
```

It must state that user-global rules apply across projects, project-local rules apply only to the current project, and neither can override workflow hard constraints.
It must explain that both user-global and project-local `RULE.md` files support only the canonical headings `COMMON`, `SPEC`, `PLAN`, and `DESIGN`; aliases and unknown headings are rejected instead of ignored.

### 18.7 State and Resume

The README must explain project-local state files:

```text
.docs-review-fix/
├── RULE.md
├── index.md
└── targets/
    └── <target-key>/
        ├── MANIFEST.md
        ├── CONTINUITY.md
        ├── ISSUES.md
        ├── LOCK/
        │   └── lease.json
        ├── stale-locks/
        ├── SUMMARY.md
        └── rounds/
```

It must explain that `RULE.md` is shared project configuration, while `targets/<target-key>/` stores isolated state for one reviewed document. It must explain that the target key is derived from the normalized target path, not document content, so state survives document edits. It must also explain that `MANIFEST.md` stores content fingerprints, strictness, mode, and ledger path to detect stale state, external edits, same-path file replacement, and custom-ledger resume. It must explain that `LOCK/lease.json` and `stale-locks/` prevent concurrent writes to the same target. It must explain when `resume` is useful and that resume reads the selected target's `MANIFEST.md`, recorded ledger path, and `CONTINUITY.md`.

## 19. Failure Modes and Mitigations

### 19.1 Subagents Drift from Scope

Risk: A reviewer or fixer rewrites the task or introduces unrelated improvements.

Mitigation:

- Give each subagent a narrow context pack.
- Require issue IDs.
- Require read-only mode for reviewers.
- Let the coordinator reject out-of-scope findings.

### 19.2 Multiple Fixers Conflict

Risk: Parallel fixers edit the same file and produce incompatible changes.

Mitigation:

- Allow only one fixer at a time per target document.
- Use the target lock and lease before any write, including coordinator writes and fixer subagent writes.
- Recheck the target fingerprint immediately before applying fixes.
- Use parallelism only for independent read-only reviews.

### 19.3 Review Stops After First Fix

Risk: The loop ends after patching initial findings but before confirming the full document.

Mitigation:

- Make full re-review a required gate after every fix round.
- Do not complete on diff review alone.

### 19.4 Context Compaction Loses Decisions

Risk: Long sessions lose why issues were accepted, rejected, or deferred.

Mitigation:

- Maintain the target-local ledger path recorded in `MANIFEST.md`, defaulting to `.docs-review-fix/targets/<target-key>/ISSUES.md`.
- Use `.docs-review-fix/targets/<target-key>/CONTINUITY.md` for long-running work.
- Keep each target document's state in its own `.docs-review-fix/targets/<target-key>/` directory.
- Keep subagent prompts self-contained.

### 19.5 Reviewer Over-Blocks on Low Issues

Risk: The loop never finishes because the reviewer treats polish as blocking.

Mitigation:

- Define severity levels clearly.
- Let low issues block only in strict mode.
- Coordinator makes final PASS decision.

### 19.6 External Fact Uncertainty

Risk: A document claims unstable facts that cannot be verified from local context.

Mitigation:

- Mark uncertain external facts as `UNCONFIRMED`.
- Use authoritative sources when verification is part of the task.
- Do not invent missing facts during fixing.

### 19.7 Project Rules Override Hard Constraints

Risk: `.docs-review-fix/RULE.md` tries to weaken the workflow, such as allowing reviewers to edit files or skipping full re-review.

Mitigation:

- Treat workflow hard constraints as higher priority than project rules.
- Use project rules only to add review scope or tighten type-specific expectations.
- Reject conflicting project rules and report the conflict to the user.

### 19.8 Target State Cross-Contamination

Risk: Multiple documents in the same project share one issue ledger or continuity file, causing resume to load the wrong target state or issue IDs from another document.

Mitigation:

- Derive a target key from the normalized target path before writing persistent state.
- Store `MANIFEST.md`, default `ISSUES.md`, `CONTINUITY.md`, `SUMMARY.md`, `rounds/`, `LOCK/`, and `stale-locks/` under `.docs-review-fix/targets/<target-key>/`.
- Validate the target manifest before resume.
- Keep project-root `.docs-review-fix/RULE.md` shared, but never store target review state at the project root.

### 19.9 Same-Path Target Replacement

Risk: A user deletes a reviewed file and later creates a different document at the same path. Path-based target keys would resolve to the old state directory.

Mitigation:

- Keep path hash as the stable state directory identity.
- Store content fingerprints in `MANIFEST.md`.
- Compare the current content fingerprint during resume.
- Treat mismatched fingerprints as stale state and require full re-review.
- If the document appears to be a same-path replacement, ask whether to restart, archive, or migrate old state before continuing.

### 19.10 Reviewer Mutates Files

Risk: A runtime exposes write-capable tools to the reviewer, and the reviewer changes the target or reference document while the coordinator believes the pass was read-only.

Mitigation:

- Treat prompt-only read-only instructions as insufficient for automatic PASS.
- Require adapter-declared reviewer write blocking before entering the automatic loop.
- Record target and reference fingerprints before reviewer dispatch.
- Recompute fingerprints after reviewer return.
- Block the workflow and ask for user confirmation if any reviewer-touched file changed.

### 19.11 Unsafe Uninstall or Manifest Tampering

Risk: A stale, corrupted, or malicious manifest causes uninstall to remove files outside the package-owned route paths.

Mitigation:

- Canonicalize manifest paths and allowed roots before removal.
- Remove only paths that are both manifest-recorded and matched by the platform route allowlist.
- Refuse symlink overwrite and symlink removal.
- Require ownership markers or manifest-complete children before removing generated directories.
- Treat missing manifests as "nothing to remove" instead of scanning broad user directories.

### 19.12 Sensitive Content Leakage

Risk: A reviewer, fixer, ledger, round receipt, or final response copies a secret from the target document into `.docs-review-fix` or chat output.

Mitigation:

- Require reviewer, fixer, and coordinator prompts to redact secret-like values.
- Store only location anchors and `[REDACTED:<kind>]` in issue ledgers, continuity files, summaries, round receipts, and final responses.
- Treat raw secret values, partial prefixes/suffixes, hashes, and checksums as disallowed in workflow state.
- Add redaction fixture tests for reviewer findings, fixer reports, ledgers, and final response formatting.

## 20. Recommended Repository Layout

```text
document-review-loop/
├── package.json
├── README.md
├── design/
│   ├── DESIGN-RULE.md
│   └── DESIGN-v1.md
├── bin/
│   └── drfx.js
├── lib/
│   ├── adapters/
│   │   ├── claude.js
│   │   ├── codex.js
│   │   └── gemini.js
│   ├── install.js
│   ├── generator.js
│   ├── manifest.js
│   └── check.js
├── skills/
│   ├── review-fix-spec/
│   │   └── SKILL.md
│   ├── review-fix-plan/
│   │   └── SKILL.md
│   ├── review-fix-design/
│   │   └── SKILL.md
│   └── review-fix-doc/
│       └── SKILL.md
├── shared/
│   ├── core.md
│   ├── long-task.md
│   ├── rubrics/
│   │   ├── common.md
│   │   ├── spec.md
│   │   ├── plan.md
│   │   └── design.md
│   └── prompts/
│       ├── coordinator.md
│       ├── reviewer.md
│       └── fixer.md
├── templates/
│   ├── claude-command.md.tmpl
│   ├── codex-skill.md.tmpl
│   └── gemini-command.toml.tmpl
└── test/
    ├── input-parsing.test.js
    ├── target-state.test.js
    ├── capability-check.test.js
    ├── locking.test.js
    ├── redaction.test.js
    ├── rulebook.test.js
    └── fixtures/
        ├── docs/
        ├── descriptors/
        └── state/
```

Each entry skill should stay small and point to shared resources. The shared files carry the workflow, long-task protocol, rubrics, and internal prompts.

User-global directory:

```text
~/.docs-review-fix/
├── RULE.md
├── preferences.md
├── manifests/
├── capabilities/
├── backups/
└── shared/
```

This user-global directory stores cross-project rules and installer metadata. It must not store project workflow state.

Project-local working directory:

```text
.docs-review-fix/
├── RULE.md
├── index.md
└── targets/
    └── <target-key>/
        ├── MANIFEST.md
        ├── CONTINUITY.md
        ├── ISSUES.md
        ├── LOCK/
        │   └── lease.json
        ├── stale-locks/
        ├── SUMMARY.md
        └── rounds/
```

The skill implementation belongs in the skill package. `~/.docs-review-fix` belongs to the user. Project-local `.docs-review-fix` belongs in the document project being reviewed.

Aside from OS metadata such as `.DS_Store`, the current workspace starts with only the `design/` files. The implementation must create `package.json` and the package tree shown above before any npm packaging or CLI acceptance check can pass.

### 20.1 Node Package Baseline

V1 implementation decisions:

- Runtime: Node.js `>=20.0.0`, declared in `package.json` `engines.node`.
- Module format: CommonJS with `package.json` `"type": "commonjs"`.
- CLI entry: `bin.drfx` points to `bin/drfx.js` with a Node shebang.
- Transpilation: none. Source files in `bin/` and `lib/` are plain JavaScript.
- Test framework: Node built-in test runner via `node --test`; assertions use `node:assert/strict`.
- `npm test`: runs the full local test suite without network access.
- Runtime dependencies: none in v1 unless the implementation plan explicitly justifies and approves a dependency. Use Node standard library modules such as `node:fs`, `node:path`, `node:crypto`, `node:os`, and `node:child_process`.
- Dev dependencies: none by default. Add only if a concrete v1 check cannot be implemented with built-in tooling.
- Package manager: npm. The repository should not require `pnpm`, `yarn`, TypeScript, Babel, or a bundler for v1.

## 21. Version 1 Acceptance Checks

The v1 workflow is acceptable when:

- It ships a root `README.md` with installation, platform setup, command usage, built-in rubrics, workflow flow, and rule configuration.
- It ships `package.json` with package name `@xenonbyte/document-review-fix`, `type: commonjs`, `engines.node: >=20.0.0`, a `bin.drfx` entry pointing to `bin/drfx.js`, an `npm test` script using `node --test`, and package files that include `bin/`, `lib/`, `skills/`, `shared/`, `templates/`, `test/`, `README.md`, and `design/`.
- It exposes `review-fix-spec`, `review-fix-plan`, `review-fix-design`, and `review-fix-doc`.
- It provides `drfx install --platform <claude|codex|gemini[,...]>`.
- It provides `drfx uninstall --platform <claude|codex|gemini[,...]>`.
- It documents platform capability differences, including Gemini v1 advisory-only behavior.
- It defines the platform install manifest schema used by uninstall.
- It defines and implements `~/.docs-review-fix/capabilities/<platform>.json` descriptors and `drfx check` probes for reviewer-isolation capability reporting.
- It implements the section 8.1 input parsing contract, including duplicate target rejection, repeated `ref=`, conflicting flag rejection, unknown flag rejection, and read-only behavior.
- It implements deterministic project-root resolution and refuses to create persistent state when no allowed root can be resolved.
- It keeps one-shot `read-only` reviews without `ledger=` or `resume` fully non-persistent; no `.docs-review-fix` files are created for that case.
- It passes strictness and mode into reviewer and coordinator contexts, stores them in `MANIFEST.md`, and preserves them on resume.
- It defines all status values used by resume and completion logic, including `read-only-findings`, `externally-changed`, and `possible-target-replacement`.
- It uses `why_it_matters` as the canonical reviewer finding field for impact.
- It redacts secrets in reviewer, fixer, coordinator, ledger, receipt, and final-response outputs using `[REDACTED:<kind>]`.
- Each entry skill fixes the document type internally.
- It supports one writable target document and multiple read-only reference documents.
- Ambiguous multi-document input triggers clarification instead of guessing.
- User-facing invocation stays short and does not require pasting internal prompts.
- No workflow step requires runtime-specific objective state.
- Initial review and full re-review run through a mandatory read-only reviewer subagent or equivalent isolated review task.
- Reviewer execution uses the fingerprint guard. A reviewer mutation blocks the loop and prevents PASS.
- Runtimes without reviewer subagent isolation do not claim automatic workflow PASS.
- Fixing defaults to the coordinator, with one optional serial fixer subagent only for bounded issue lists.
- All entry skills share the same core workflow and prompts.
- Reviewer and fixer prompts are self-contained.
- User-global `~/.docs-review-fix/RULE.md` can add cross-project rules without storing project state.
- `.docs-review-fix/RULE.md` can add type-specific project rules without overriding hard constraints.
- Platform install writes manifests under `~/.docs-review-fix/manifests`.
- Platform uninstall removes only manifest-recorded files under canonical allowed platform roots and refuses symlink removal.
- Codex install creates generated skills under `~/.codex/skills/review-fix-*`, not slash-command files.
- Codex install refuses to overwrite existing non-owned `~/.codex/skills/review-fix-*` directories.
- Codex uninstall removes only generated `review-fix-*` Codex skills and legacy generated prompt routes that are manifest-recorded or ownership-marked.
- README documents Codex install/uninstall as generated skills rather than slash-command files.
- README documents user-global and project-local rule configuration, including precedence.
- Both user-global and project-local rulebooks reject unknown headings and aliases outside `COMMON`, `SPEC`, `PLAN`, and `DESIGN`.
- The target-local ledger path recorded in `MANIFEST.md` and `.docs-review-fix/targets/<target-key>/CONTINUITY.md` give each reviewed target a clear isolated state location.
- `MANIFEST.md` stores target content fingerprints and resume detects stale PASS, external edits, and same-path replacement.
- Resume mode can continue a stopped long task from the selected `.docs-review-fix/targets/<target-key>/` state directory.
- The workflow prevents concurrent edits to the same target document with an atomic target lock, lease refresh, stale-lock handling, and pre-fix fingerprint guard.
- PASS criteria are explicit and type-aware.
- High or medium deferrals produce `stopped-with-deferrals`, not PASS.
- Strict mode makes unresolved low issues block PASS unless they are explicitly accepted as non-blocking and carried into later reviewer context.
- Read-only mode with blocking findings produces `read-only-findings`, not PASS or a fix round.
- Long-running state has a clear place to live.
- `drfx check` reports installed manifests, global and project rule presence, and per-platform reviewer-isolation capability fields as `verified`, `unverified`, or `unsupported`, using the capability descriptor/probe contract.
- `npm pack --dry-run` includes the expected package files and excludes project-local `.docs-review-fix` state.
- Local unit or fixture checks under `test/` cover input parsing, `ledger=` path rejection outside `.docs-review-fix/targets/<target-key>/`, `ledger=` reserved-path rejection, custom ledger path resume through `MANIFEST.md`, target-key derivation including slug normalization, manifest path validation, capability descriptor provenance parsing and fingerprint guard probe, target lock acquisition/lease/corrupt-lock/stale-lock handling, pre-fix fingerprint mismatch, secret redaction, uninstall symlink refusal, non-owned Codex skill directory refusal, read-only no-state behavior, read-only reviewer mutation detection, rulebook heading rejection, and resume stale-fingerprint detection.

## 22. V1 Decisions and Future Work

These decisions close the remaining v1 design questions. Items marked as future work are explicitly non-blocking for v1.

V1 decisions:

- Persistent `MANIFEST.md`, `ISSUES.md`, and `CONTINUITY.md` are created lazily when a loop is long-running, when `resume` is requested, when more than one review/fix round is needed, when `ledger=` is supplied, or when the user requests an auditable trail. One-round `read-only` reviews without `ledger=` or `resume` do not create project state.
- `normal` is the default strictness for every document type, including `DESIGN`. `strict` is opt-in and makes low issues blocking.
- V1 uses Node.js `>=20.0.0`, CommonJS, no transpilation, npm, Node's built-in test runner, and no runtime dependencies by default.
- A second independent reviewer is not required for v1 PASS. High-risk plans may add a second reviewer in a future strict mode, but v1 PASS requires one isolated full reviewer pass plus coordinator agreement.
- Reviewer-isolation capability is reported through `~/.docs-review-fix/capabilities/<platform>.json`; missing or unverified descriptors make the platform advisory-only.
- Target writes require an atomic target lock under `.docs-review-fix/targets/<target-key>/LOCK/` plus a pre-fix fingerprint guard.
- Raw secrets must never be copied into workflow state or final responses; use `[REDACTED:<kind>]`.
- Both user-global `~/.docs-review-fix/RULE.md` and project-local `.docs-review-fix/RULE.md` support only the four canonical headings in v1: `COMMON`, `SPEC`, `PLAN`, and `DESIGN`. Aliases such as `REQUIREMENTS` are rejected with a clear message.
- `rounds/` receipts are written when the user requests an auditable trail, when the loop reaches round 2, or when the coordinator stops due to interruption, context pressure, or blocker state.
- Generated Codex skills copy the minimal shared references they need into each `~/.codex/skills/review-fix-*` directory. `~/.docs-review-fix/shared` remains the installer-owned source for regeneration, not a runtime dependency for Codex skill execution.
- Existing Codex skill directories without this package's ownership marker are treated as user-owned and must not be overwritten or merged by install.
- Gemini v1 generated routes are advisory-only. PASS-capable Gemini support requires a future design update that defines a verified reviewer-isolation adapter.
- Because the current workspace is not a git repository and has no package metadata yet, v1 implementation creates `package.json` and package directories at the workspace root while keeping the design documents under `design/`.
- v1 ships only `README.md`. `README-zh.md` is deferred until the English README and generated platform files are stable.

Future work:

- Extend deterministic checker coverage for broken anchors and issue ID consistency beyond the required v1 fixture checks.
- Add optional second-reviewer policy for high-risk or strict workflows.
- Add localized documentation after v1 command behavior and installer layout stabilize.

## 23. Recommended Next Step

Create the workflow files from this design in the following order:

1. `package.json`
2. `README.md`
3. `shared/core.md`
4. `shared/long-task.md`
5. `shared/rubrics/common.md`
6. `shared/rubrics/spec.md`
7. `shared/rubrics/plan.md`
8. `shared/rubrics/design.md`
9. `shared/prompts/reviewer.md`
10. `shared/prompts/fixer.md`
11. `shared/prompts/coordinator.md`
12. `skills/review-fix-spec/SKILL.md`
13. `skills/review-fix-plan/SKILL.md`
14. `skills/review-fix-design/SKILL.md`
15. `skills/review-fix-doc/SKILL.md`
16. `templates/claude-command.md.tmpl`
17. `templates/codex-skill.md.tmpl`
18. `templates/gemini-command.toml.tmpl`
19. `lib/adapters/claude.js`
20. `lib/adapters/codex.js`
21. `lib/adapters/gemini.js`
22. `lib/generator.js`
23. `lib/manifest.js`
24. `lib/install.js`
25. `lib/check.js`
26. `bin/drfx.js`
27. `test/input-parsing.test.js`
28. `test/target-state.test.js`
29. `test/capability-check.test.js`
30. `test/locking.test.js`
31. `test/redaction.test.js`
32. `test/rulebook.test.js`
33. `test/fixtures/docs/`
34. `test/fixtures/descriptors/`
35. `test/fixtures/state/`

After those files exist, minimum verification is:

```text
npm test
npm pack --dry-run
node bin/drfx.js check
```

Then run the workflow on `design/DESIGN-v1.md` itself as the first validation case.
