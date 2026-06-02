# Requirement Brief: code review routes

## Upstream References

| Artifact | Reference | Status |
|---|---|---|
| Raw Requirement | `.req-to-plan/WF-20260603-code-review-routes-2026-06/00-raw-requirement.md` | available |
| Intake Brief | `.req-to-plan/WF-20260603-code-review-routes-2026-06/01-intake-brief.md` | available |
| Repository | `/Users/xubo/x-studio/document-review-fix` | available |

## Goal

Add two code review workflow routes, `review-fix-pr` and `review-fix-code`, to `@xenonbyte/document-review-fix`, with cross-platform installation surfaces for Claude Code, Codex, and Gemini. The routes must reuse the existing document review-fix workflow model and safety controls while adapting target semantics from single document files to PR-related or code-scope file sets. Existing document routes must also gain `rounds=<n>` loop-limit semantics consistent with the new code review routes.

## Background

The package currently installs document review-fix routes for `review-fix-spec`, `review-fix-plan`, `review-fix-design`, and `review-fix-doc` across Claude Code commands, Codex skills, and Gemini TOML commands. The user wants the same distribution model to support code review workflows without wrapping platform-native `/review`, because `/review` is not a stable programmable API and cannot be called consistently across platforms. Gemini is advisory-only for this package and must not claim automatic fix capability or workflow PASS for code review routes.

## Scope

- Add `review-fix-pr` as a distinct route for reviewing the current branch relative to a required `base=<branch>` using PR-style merge-base diff semantics.
- Add `review-fix-code` as a distinct route for global project code review, optionally narrowed by one or more `scope=<path>` arguments.
- Install both new routes through the existing platform generation and installation mechanism for Claude Code, Codex, and Gemini.
- Preserve existing document route behavior while adding `rounds=<n>` support to `review-fix-spec`, `review-fix-plan`, `review-fix-design`, and `review-fix-doc`.
- Support shared route options `[read-only|review-and-fix] [guard=git|snapshot] [rounds=<n>]` for both code review routes, with default mode `review-and-fix` and default guard `guard=git`.
- Support PR-specific external rules from `~/.docs-review-fix/rules/PR.md` and `.docs-review-fix/rules/PR.md`.
- Support global code review external rules from `~/.docs-review-fix/rules/CODE.md` and `.docs-review-fix/rules/CODE.md`.
- Update public documentation in both `README.md` and `README.zh-CN.md` with structurally aligned coverage for the new routes, `rounds=<n>`, defaults, guards, rules, Gemini limitations, and examples.
- Add or update tests for generated platform outputs, install manifests, route parsing, guard behavior, rule loading, documentation-related route text, and document-route `rounds=<n>` support.

## Non-scope

- Do not replace or remove existing document routes.
- Do not call, wrap, or depend on platform-native `/review`.
- Do not add Gemini automatic fixes in this version.
- Do not commit, push, open PRs, publish packages, mutate remote state, resolve GitHub review threads, or modify remote data.
- Do not treat pure style preferences, no-risk refactors, or large architecture rewrites as default automatic-fix scope.
- Do not introduce a new language runtime or large external dependency.
- Do not decide the exact implementation architecture, internal module split, migration order, or task sequence in this requirement stage.

## Scope Inventory

| Item | Status | Requirement relevance |
|---|---|---|
| `@xenonbyte/document-review-fix` repository at `/Users/xubo/x-studio/document-review-fix` | In Scope | Primary project to change and document. |
| `bin/drfx.js` CLI entrypoint | In Scope | Route installation/check commands may need to expose new route behavior. |
| `lib/` workflow, parsing, guard, rulebook, manifest, capability, installer, generator, state, receipt, redaction, and finalization modules | In Scope | Existing route and workflow machinery must be extended rather than bypassed. |
| `lib/adapters/claude.js`, `lib/adapters/codex.js`, `lib/adapters/gemini.js` | In Scope | Platform-specific capability and generated entry behavior must reflect code routes and Gemini advisory-only limits. |
| `lib/workflow/` persistent, no-state, diff-review, fix lifecycle, start, helpers, serialization, and finalize modules | In Scope | Existing loop, safety, state, re-review, and finalize mechanisms must apply to file-set code targets. |
| `templates/claude-command.md.tmpl`, `templates/codex-skill.md.tmpl`, `templates/gemini-command.toml.tmpl` | In Scope | Generated platform entries must include the two new routes and updated option semantics. |
| `skills/review-fix-spec`, `skills/review-fix-plan`, `skills/review-fix-design`, `skills/review-fix-doc` | In Scope | Existing Codex skills must document and honor `rounds=<n>`. |
| New route skill/command descriptors for `review-fix-pr` and `review-fix-code` | In Scope | Required user entrypoints across platforms. |
| `shared/core.md`, `shared/long-task.md`, `shared/runtime-flags.md`, `shared/prompts/*` | In Scope | Hard workflow constraints and route prompts must stay coherent. |
| `shared/rubrics/spec.md`, `shared/rubrics/plan.md`, `shared/rubrics/design.md`, `shared/rubrics/common.md` | Referenced Only | Existing document rubrics provide workflow pattern and may remain unchanged unless shared routing requires updates. |
| Built-in PR rubric and built-in CODE rubric | In Scope | New review baselines are required and must not depend on a particular repository. |
| `README.md` and `README.zh-CN.md` | In Scope | Public behavior and examples must stay structurally aligned. |
| `test/` suite and fixtures | In Scope | Must cover parsing, generated routes, manifests, guards, rules, and rounds semantics. |
| `.docs-review-fix/targets/` runtime state | Referenced Only | Existing state semantics must be preserved; this requirement does not ask to alter prior target history. |
| `.req-to-plan/` workflow state | Referenced Only | Planning workflow state only, not product behavior. |
| Platform-native `/review` commands | Out of Scope | Explicitly forbidden as implementation dependency. |
| Remote GitHub state, publishing, PR creation, and external service mutation | Out of Scope | Explicitly forbidden unless later requested by the user. |

## Users / Operators

- Maintainers of `@xenonbyte/document-review-fix` who install, test, package, and review route behavior.
- Implementation agents that will execute the PLAN and must know exact route contracts, safety boundaries, and acceptance criteria.
- End users invoking `review-fix-pr`, `review-fix-code`, and existing document routes from Claude Code, Codex, or Gemini.
- Gemini users, who must receive advisory-only behavior and clear guidance to use Claude Code or Codex for automatic fixes.

## Acceptance

The following acceptance criteria are confirmed by the raw user requirement.

- `review-fix-pr` is installable on Claude Code, Codex, and Gemini.
- `review-fix-pr` requires `base=<branch>`; missing base only prints usage and does not read diff, start review, or modify files.
- Unresolvable `base` only reports that the user must provide a resolvable base; it does not implicitly `git fetch` or rewrite local remote-tracking refs.
- A `base` resolving to the current branch only reports that base cannot equal the current branch.
- `review-fix-pr` defaults to `review-and-fix`, defaults to `guard=git`, and reviews the current branch relative to merge-base/base PR semantics rather than scanning the whole repository.
- `review-fix-pr read-only` does not modify files, does not create automatic-fix state, and only outputs PR findings or clean/blocked/unsupported status.
- `review-fix-pr guard=git` supports multi-round route-owned working tree changes without requiring clean HEAD every round, while still blocking unrelated local changes from being overwritten.
- `review-fix-pr guard=snapshot` is only used when explicitly requested and protects the PR-related file set, including initially changed files and necessary dependency files touched during fixes.
- `review-fix-pr` has a built-in PR rubric covering correctness, regression, safety, tests, contracts, maintainability, and platform.
- `review-fix-pr` loads `~/.docs-review-fix/rules/PR.md` and `.docs-review-fix/rules/PR.md` after hard constraints and built-in PR rules, with project rules more specific than user-global rules and no external rule allowed to relax hard constraints.
- `review-fix-code` is installable on Claude Code, Codex, and Gemini.
- `review-fix-code` rejects `base=<branch>` as a `review-fix-pr` parameter and does not continue global code review.
- `review-fix-code` defaults to reviewing project-root code while excluding `.git`, `.docs-review-fix`, dependency directories, build outputs, caches, temporary files, and obvious non-source directories.
- `review-fix-code scope=<path>` limits review and automatic fixes to the normalized in-project scope and necessary dependencies.
- `review-fix-code` stops when `scope=<path>` is missing, outside project root, excluded, or unsafe to resolve; it must not review or modify files outside the project.
- `review-fix-code` defaults to `review-and-fix`, defaults to `guard=git`, and supports explicit `guard=snapshot`.
- `review-fix-code read-only` does not modify files, does not create automatic-fix state, and only outputs global code findings or clean/blocked/unsupported status.
- `review-fix-code guard=git` supports multi-round route-owned working tree changes without requiring clean HEAD every round, while still blocking unrelated local changes from being overwritten.
- `review-fix-code` has a built-in CODE rubric covering correctness, architecture, state-and-io, safety, tests, contracts, maintainability, and platform.
- `review-fix-code` loads `~/.docs-review-fix/rules/CODE.md` and `.docs-review-fix/rules/CODE.md` after hard constraints and built-in CODE rules, with project rules more specific than user-global rules and no external rule allowed to relax hard constraints.
- Both code routes only process actionable findings: real bugs, regressions, boundary cases, API or contract mismatches, safety issues, test gaps, verification failures, or user-visible defects.
- Both code routes follow `review -> triage -> fix -> diff review -> full re-review -> repeat` in `review-and-fix`; they cannot claim success after only diff review.
- Both code routes preserve reviewer readiness probe, reviewer write-blocking/fingerprint guard, stdin handoff proof, redaction, machine payload validation, final-response validation, receipt/debug boundaries, persistent/no-state split, and terminal status semantics.
- Reviewer subagents are isolated and read-only; any reviewer write to monitored files blocks the workflow.
- `review-and-fix` on Claude Code and Codex automatically fixes actionable findings inside the allowed target/dependency boundary, then runs the smallest meaningful verification after each fix round.
- Gemini installs advisory-only entries for both code routes; `review-and-fix` requests must tell users to use Claude Code or Codex for automatic fixes.
- All routes stop rather than silently switching guards when the selected guard is unavailable.
- `rounds=<n>` is a positive integer upper bound on review/fix/re-review rounds; invalid values only print usage and do not start workflow, create state, or read target/reference bodies.
- `rounds=1` executes at most one review/fix/verify/re-review round.
- `rounds=5` stops early if the second round is clean.
- Without `rounds`, routes continue while actionable findings remain and safe fixes can proceed, stopping at clean, blocked, no-progress, user interruption, failed verification, or guard failure.
- `read-only rounds=<n>` is unsupported for multi-round fixing on both new code routes and existing document routes; it must explain that read-only is a single complete review and suggest `review-and-fix rounds=<n>` for loops.
- Existing `review-fix-spec`, `review-fix-plan`, `review-fix-design`, and `review-fix-doc` support `rounds=<n>` without confusing user-provided `rounds` with existing `Current round` text or `rounds/` receipt directories.
- Public documentation updates in `README.md` and `README.zh-CN.md` cover new routes, document route `rounds=<n>`, defaults, guards, built-in and external rules, Gemini advisory-only behavior, and common examples with aligned structure.
- Generated artifacts and install manifest tests cover the two new routes.

## Constraints

- Code must remain a Node.js 20 CommonJS package using the repository's existing style and local workflow abstractions.
- New behavior must preserve existing safety model: no unrelated local change overwrite, no secret leakage, no user file deletion, no remote mutation, and no publish/commit/push side effects.
- Guard behavior must fail explicitly when unavailable and must not silently downgrade between `git` and `snapshot`.
- Code review targets are file sets, not a single Markdown target; guard, snapshot, lock, diff review, receipts, and state semantics must adapt to file sets.
- Persistent `review-and-fix` state must be target-local or project-local and resumable without chat history.
- No-state `read-only` must not create `.docs-review-fix/targets/` automatic-fix state.
- External PR/CODE rules can tighten review standards but cannot relax workflow hard constraints.
- `review-fix-pr` must not implicitly fetch or mutate refs to resolve `base`.
- `review-fix-code` must not follow path traversal outside project root.
- Gemini remains advisory-only for these routes in this version.
- The requirement does not authorize adding large dependencies or a new runtime.

## Assumptions

| Assumption | Source | Impact if wrong | Conflict status | Carry target |
|---|---|---|---|---|
| The active project root for this requirement is `/Users/xubo/x-studio/document-review-fix`. | Current workspace and raw requirement target package. | Source provenance and scope inventory would need correction. | No conflict found. | DESIGN, SPEC, PLAN |
| The explicit acceptance bullets in the raw requirement are user-confirmed acceptance criteria. | User supplied them under route-specific and common acceptance headings. | Requirement Brief would need user reconfirmation before downstream work. | No conflict found. | Risk Discovery, SPEC |
| Existing document routes are the compatibility baseline and should keep current behavior except for requested `rounds=<n>` support and documentation updates. | Raw requirement says not to replace existing document routes. | Backward-compatibility risk would be higher. | No conflict found. | DESIGN, SPEC, PLAN |
| Exact internal module boundaries and implementation sequencing are intentionally deferred. | Requirement-stage boundary in r2p workflow. | Premature design choices could constrain better solutions. | No conflict found. | DESIGN, PLAN |

## Downstream Attention

- Risk Discovery must classify safety risks around multi-file guards, unrelated local edits, route-owned modifications across rounds, and snapshot coverage for necessary dependency files.
- Risk Discovery must examine compatibility risk for existing document routes when adding `rounds=<n>` and new route descriptors.
- Risk Discovery must examine platform capability divergence, especially Gemini advisory-only wording and refusal to claim automatic fix PASS.
- Risk Discovery must carry the rule precedence requirement: hard constraints, built-in rubric, user-global rules, project-local rules, with conflicts blocking or reported.
- DESIGN must decide how to represent code-review targets as file sets while preserving existing single-target document workflow semantics.
- DESIGN must decide how route state keys are derived for PR and code-scope targets and how stale state is rejected.
- DESIGN must decide how PR merge-base/base diff boundaries and code-scope exclusions are computed without implicit fetch or unsafe path traversal.
- SPEC must make `rounds=<n>` metadata distinct from existing round counters and receipt directory names.
- PLAN must include verification coverage for generated platform outputs, install/uninstall manifest safety, rule loading, guard behavior, invalid arguments, read-only no-state, Gemini advisory-only behavior, and documentation sync.

## Stated Technical Direction

| Direction | Classification | Notes |
|---|---|---|
| Add `review-fix-pr` and `review-fix-code` as separate routes. | Hard Constraint | User explicitly says the routes cannot be merged. |
| Reuse existing document route workflow mechanics. | Hard Constraint | Coordinator, reviewer, fixer, triage, diff review, full re-review, guards, redaction, state, finalize, and receipts must remain isomorphic. |
| Do not call platform-native `/review`. | Hard Constraint | Explicitly forbidden. |
| Install to Claude Code, Codex, and Gemini. | Hard Constraint | Gemini is advisory-only. |
| `review-and-fix` default mode and `guard=git` default guard. | Hard Constraint | Explicit default semantics. |
| Support `guard=snapshot` as explicit fallback only. | Hard Constraint | No silent downgrade. |
| Add built-in PR and CODE rubrics plus external rule file loading. | Hard Constraint | External rules can tighten but not relax hard constraints. |
| Add document-route `rounds=<n>`. | Hard Constraint | Required for consistency with code routes. |
| Avoid new runtime or large dependencies. | Hard Constraint | Explicit non-goal. |

## Source Provenance

| Source | Provenance | Status |
|---|---|---|
| User raw requirement | Conversation input captured in `.req-to-plan/WF-20260603-code-review-routes-2026-06/00-raw-requirement.md` | confirmed |
| Local repository | `/Users/xubo/x-studio/document-review-fix` | confirmed |
| Git branch | `main` | confirmed by `git rev-parse --abbrev-ref HEAD` |
| Git commit | `10bab786329a77f965704745ac4132991223279d` | confirmed by `git rev-parse HEAD` |
| Package identity | `@xenonbyte/document-review-fix` version `0.3.0` | confirmed from `package.json` |
| Runtime/package shape | Node.js `>=20.0.0`, CommonJS, CLI bin `drfx` | confirmed from `package.json` |
| Repository structure | `bin/`, `lib/`, `lib/adapters/`, `lib/workflow/`, `skills/`, `shared/`, `templates/`, `test/`, `README.md`, `README.zh-CN.md` | confirmed from repository listing and project instructions |

## Deferred

- Exact architecture for extending workflow state, guards, rule loading, and platform generation.
- Exact names and placement of new modules, helper APIs, tests, fixtures, or templates.
- Exact validation command set for implementation verification.
- Exact fallback wording and user-facing copy beyond the required behavior.
- Whether any current helper can be refactored for file-set targets, and how much refactoring is justified.

## Open Inputs

- No requirement-definition blocker is known.
- The exact exclusion list beyond the user-named directories and "obvious non-source directories" can be finalized in DESIGN/SPEC as long as `.git`, `.docs-review-fix`, dependency directories, build outputs, caches, and temporary files remain excluded.
- Exact examples for README can be selected during SPEC/PLAN while preserving the required information coverage.

## Raw Notes

- "`review-fix-pr`：审查当前分支相对某个 `base` 的 PR diff。"
- "`review-fix-code`：审查项目全局代码，支持可选 `scope=<path>` 缩小范围。"
- "两个 route 不能合并。"
- "这两个能力都不能实现成调用平台内置 `/review`。"
- "Gemini 目前在本项目中是 advisory-only 平台，不能自动编辑文件或宣称 workflow PASS。"
- "两个 route 都必须只处理 actionable findings。"
- "`review-and-fix` 必须遵循 review -> triage -> fix -> diff review -> full re-review -> repeat 的闭环。"
- "Reviewer 必须是 isolated read-only subagent。"
- "`rounds=<n>` 表示最多执行 N 轮，不表示必须跑满 N 轮。"
- "实现时必须同步更新 `README.md` 和 `README.zh-CN.md`。"
