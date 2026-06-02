---
r2p_stage: risk_discovery
r2p_version: 2
r2p_status: approved
r2p_created_at: 2026-06-02T18:24:59.432199+00:00
r2p_updated_at: 2026-06-02T18:26:26.042261+00:00
---

# Risk & Question Discovery: code review routes

## Upstream References

| Artifact | Reference | Status |
|---|---|---|
| Raw Requirement | `.req-to-plan/WF-20260603-code-review-routes-2026-06/00-raw-requirement.md` | available |
| Requirement Brief | `.req-to-plan/WF-20260603-code-review-routes-2026-06/03-requirement-brief.md` | approved |
| Repository | `/Users/xubo/x-studio/document-review-fix` at `10bab786329a77f965704745ac4132991223279d` on `main` | available |

## Context Coverage

- Level: repository-aware requirement scan.
- Sources: raw requirement, approved requirement brief, `package.json`, repository file listing for `bin/`, `lib/`, `lib/adapters/`, `lib/workflow/`, `skills/`, `shared/`, `templates/`, `test/`, `README.md`, and `README.zh-CN.md`.
- Not inspected: full source bodies for all implementation modules, historical commits before `10bab786329a77f965704745ac4132991223279d`, user-global rule files under `~/.docs-review-fix/`, and external platform internals. These are not blockers for Risk Discovery and must be handled in DESIGN/SPEC/PLAN where relevant.

| Dimension | Coverage | Findings / routed items |
|---|---|---|
| Scope | Covered | The requirement spans two new code routes, four existing document routes, platform generation, guards, rules, state, docs, and tests. See `RISK-001`, `RISK-002`, `RISK-003`, `RISK-DES-001`, `RISK-DES-002`, `RISK-DES-003`. |
| Acceptance | Covered | Acceptance is explicit and confirmed in the raw requirement. Risk is coverage drift due many route/platform combinations. See `RISK-010`, `RISK-SPEC-001` through `RISK-SPEC-015`. |
| Context | Covered | Local repository source and package identity are confirmed. Exact implementation module impact remains DESIGN work. See `A-001`, `RISK-DES-001`. |
| Data | Covered | Persistent workflow state, receipts, locks, manifests, and no-state read-only behavior are in scope. See `RISK-004`, `RISK-006`, `RISK-DES-005`, `RISK-SPEC-008`. |
| Interfaces | Covered | User-facing route invocations, platform generated entries, external rule files, and CLI/install surfaces are in scope. See `RISK-007`, `RISK-008`, `RISK-SPEC-001` through `RISK-SPEC-006`. |
| Permissions | Covered | Routes must not commit, push, publish, fetch implicitly, mutate remote state, or delete user files. See `RISK-001`, `RISK-005`, `RISK-009`, `RISK-PLAN-006`. |
| Dependencies | Covered | Requirement forbids large new dependencies and new runtime; existing platform capability differences matter. See `RISK-007`, `RISK-DES-006`, `RISK-PLAN-007`. |
| Compatibility | Covered | Existing document routes must preserve behavior except `rounds=<n>`. Existing install/uninstall manifest safety must remain intact. See `RISK-003`, `RISK-006`, `RISK-010`. |
| Execution | Covered | Multi-round review/fix/re-review loops, verification after fixes, invalid argument stops, and Gemini advisory-only handling are in scope. See `RISK-002`, `RISK-009`, `RISK-PLAN-001` through `RISK-PLAN-005`. |
| Rollback | Covered | No remote mutation is allowed; local guard/state behavior must keep changes recoverable and not overwrite unrelated work. See `RISK-001`, `RISK-004`, `RISK-PLAN-006`. |
| Observability | Covered | User output must stay concise; debug/receipts must be redacted and bounded. See `RISK-005`, `RISK-SPEC-011`, `RISK-PLAN-008`. |
| Scale | Covered | Scope-expanding modifier applies because target semantics expand from single files to project/file sets. See `RISK-002`, `RISK-010`, `RISK-DES-001`. |

## Subagent Discovery Findings

| Dimension / Topic | Source | Finding IDs | Evidence |
|---|---|---|---|
| All 12 dimensions | Main-agent direct scan | `RISK-001` through `RISK-010`, `RISK-DES-001` through `RISK-DES-008`, `RISK-SPEC-001` through `RISK-SPEC-015`, `RISK-PLAN-001` through `RISK-PLAN-010` | Raw requirement and approved Requirement Brief. |

## Blocking Questions

| ID | Question | Why it blocks | Resolve in | Owner | Needed before |
|---|---|---|---|---|---|
| None | No requirement-definition blocker remains. Design and execution choices are routed below as discussion points, design triggers, spec inputs, and plan inputs. | N/A | N/A | N/A | N/A |

## Assumptions

| ID | Assumption | Source | Impact if wrong | Conflict status / handling | Carry to |
|---|---|---|---|---|---|
| A-001 | The local repository at `/Users/xubo/x-studio/document-review-fix` is the only project to change for this requirement. | Requirement Brief Source Provenance. | Scope, tests, and docs would need expansion if another package is involved. | No conflict found. | DESIGN, SPEC, PLAN |
| A-002 | User-provided acceptance bullets are confirmed acceptance criteria. | Requirement Brief Acceptance. | SPEC would need user reconfirmation before final contracts. | No conflict found. | SPEC |
| A-003 | User-global rule files may or may not exist at execution time and must be handled as optional inputs without weakening hard constraints. | Raw requirement lists optional external rule paths. | Rule-loading behavior could be overspecified if absence is treated as failure. | No conflict found. | DESIGN, SPEC |
| A-004 | Gemini's advisory-only limitation applies to both new code routes and generated documentation examples for this release. | Raw requirement and Requirement Brief. | Generated Gemini entries could mislead users or overclaim PASS. | No conflict found. | SPEC, PLAN |
| A-005 | Exact code-scope exclusion patterns beyond the explicitly named directories can be finalized later if they preserve the named exclusions and project-root boundary. | Requirement Brief Open Inputs. | Overbroad or underbroad exclusion behavior could affect review coverage. | No conflict found. | DESIGN, SPEC |

## Risks

| ID | Risk | Impact | Likelihood | Priority | Mitigation direction | Carry to |
|---|---|---|---|---|---|---|
| RISK-001 | File-set guard logic could overwrite or mask unrelated local user changes when moving from single-document targets to PR/code target sets. | User work loss or unsafe automatic fixes. | Medium | P0 | DESIGN must define file-set ownership/guard invariants; SPEC must state overwrite refusal behavior; PLAN must include guard regression tests. | DESIGN, SPEC, PLAN |
| RISK-002 | PR diff boundaries could be implemented as whole-repo scan or wrong diff base instead of merge-base/base semantics. | False findings, missed PR regressions, or edits outside PR scope. | Medium | P1 | DESIGN must define base resolution and merge-base comparison model without implicit fetch; SPEC must cover missing, invalid, same-branch, and no-merge-base cases. | DESIGN, SPEC, PLAN |
| RISK-003 | Adding `rounds=<n>` to existing document routes could change current default loop behavior or confuse user-provided limit with receipt round directories. | Existing users see changed loop semantics or broken resume behavior. | Medium | P1 | DESIGN/SPEC must separate invocation metadata from runtime counters and receipt paths; PLAN must test unchanged no-rounds behavior. | DESIGN, SPEC, PLAN |
| RISK-004 | Persistent state keys for PR/global code routes could collide across route, base, scope, or guard combinations, or resume stale state after scope changes. | Unsafe resume, incorrect target context, or false pass/fail status. | Medium | P1 | DESIGN must define route-specific state identity and stale-state rejection; SPEC must include resume validation contracts. | DESIGN, SPEC, PLAN |
| RISK-005 | Debug, receipt, subagent, or final-output paths could expose raw prompts, raw logs, secrets, internal issue IDs, or unredacted transcripts. | Secret leakage or noisy user output. | Low-Medium | P1 | SPEC must preserve existing redaction/output boundaries; PLAN must include debug/default-output checks. | SPEC, PLAN |
| RISK-006 | Install/uninstall manifest updates for two new routes could accidentally remove user files or leave stale generated entries. | Data loss or broken installed commands/skills. | Medium | P1 | SPEC must preserve manifest ownership rules; PLAN must include manifest/generation safety regression tests. | SPEC, PLAN |
| RISK-007 | Platform capability differences could be flattened, causing Gemini to imply automatic fixes or PASS capability. | Misleading user behavior and invalid workflow status. | Medium | P1 | DESIGN/SPEC must keep platform-specific capability contracts; PLAN must verify Gemini text and behavior. | DESIGN, SPEC, PLAN |
| RISK-008 | External PR/CODE rule precedence could accidentally allow project/user rules to relax hard workflow constraints. | Unsafe review policy or bypassed guard requirements. | Medium | P1 | DESIGN/SPEC must define merge/conflict semantics; PLAN must test conflict blocking/reporting. | DESIGN, SPEC, PLAN |
| RISK-009 | Invalid argument handling could still read targets, create state, inspect diffs, or begin repair despite usage-only requirements. | Surprising side effects from invalid invocations. | Medium | P1 | SPEC must define preflight ordering; PLAN must test missing/invalid base, invalid scope, invalid rounds, and `read-only rounds=<n>`. | SPEC, PLAN |
| RISK-010 | Broad matrix coverage across two code routes, four document routes, three platforms, guards, modes, rules, and rounds may leave acceptance untested. | Regressions ship despite apparent feature completion. | High | P1 | PLAN must build a coverage matrix and prioritize targeted tests for route generation, parsing, guard/state, docs, and platform behavior. | PLAN |

## Discussion Points

| ID | Topic | Options | Decision owner | Needed before |
|---|---|---|---|---|
| DP-001 | File-set target representation for PR/code routes. | Extend existing target abstraction; add route-specific target type; introduce a small file-set layer around existing workflow state. | DESIGN | SPEC |
| DP-002 | PR base and merge-base handling. | Use local resolvable revisions only; support branches/tags/commits uniformly; decide no-merge-base failure wording. | DESIGN | SPEC |
| DP-003 | Global code scope exclusion list. | Fixed built-in exclusions; configurable exclusions; reuse existing generated/state exclusions where safe. | DESIGN | SPEC |
| DP-004 | `rounds=<n>` persistence and resume semantics. | Persist invocation metadata in workflow state; derive from route state; store in a dedicated metadata field separate from receipt directories. | DESIGN | SPEC |
| DP-005 | External rule conflict handling. | Block immediately; report unsupported; include redacted debug details only with `debug`. | DESIGN, SPEC | PLAN |
| DP-006 | Documentation examples and section shape. | Minimal examples per route; matrix table; platform-specific examples with Gemini limitation callouts. | SPEC | PLAN |

## Design Triggers

| Design Trigger ID | Source Artifact | Source Item ID | Trigger | Required design topic | Status |
|---|---|---|---|---|---|
| RISK-DES-001 | Requirement Brief | Scope Inventory | Code review targets are file sets, not single Markdown targets. | Target model, monitored file sets, guard/snapshot/diff-review adaptation. | open |
| RISK-DES-002 | Requirement Brief | `review-fix-pr` Acceptance | PR route requires local base resolution and merge-base/base diff semantics without implicit fetch. | PR target discovery and diff boundary strategy. | open |
| RISK-DES-003 | Requirement Brief | `review-fix-code` Acceptance | Code route supports project root and `scope=<path>` with exclusions and path traversal protection. | Scope normalization and source inclusion/exclusion model. | open |
| RISK-DES-004 | Requirement Brief | Shared Guard Constraints | `guard=git` must allow route-owned multi-round changes but block unrelated local changes. | Route-owned change tracking and guard refresh strategy. | open |
| RISK-DES-005 | Requirement Brief | Persistent State Constraints | Resume must not depend on chat history and must reject stale route/base/scope/guard state. | Code-route state key and stale-state validation. | open |
| RISK-DES-006 | Requirement Brief | Gemini Constraint | Gemini installs same route names but is advisory-only. | Platform capability separation and generated entry behavior. | open |
| RISK-DES-007 | Requirement Brief | Rule System | PR/CODE built-in and external rules must layer without relaxing hard constraints. | Rulebook extension, precedence, and conflict handling. | open |
| RISK-DES-008 | Requirement Brief | Rounds Extension | User `rounds=<n>` must be separate from existing round counters and receipts. | Loop limit metadata and stop-condition design. | open |

## Spec Inputs

| Spec Input ID | Source Artifact | Source Item ID | Item | Required SPEC Contract | Reason | Status |
|---|---|---|---|---|---|---|
| RISK-SPEC-001 | Requirement Brief | Scope | `review-fix-pr` invocation contract. | `base=<branch>` required; mode/guard/rounds options; usage-only failures. | User-facing behavior must be testable. | open |
| RISK-SPEC-002 | Requirement Brief | Scope | `review-fix-code` invocation contract. | Optional repeated `scope=<path>`; rejects `base=<branch>`; default project-root review. | Prevent PR/global semantics from merging. | open |
| RISK-SPEC-003 | Requirement Brief | Acceptance | Mode semantics. | Default `review-and-fix`; `read-only` no writes, no auto-fix state, no PASS claim. | Safety and platform behavior. | open |
| RISK-SPEC-004 | Requirement Brief | Acceptance | Guard semantics. | Default `guard=git`; explicit `guard=snapshot`; no silent fallback; unavailable guard stops. | Safety-critical behavior. | open |
| RISK-SPEC-005 | Requirement Brief | Acceptance | `rounds=<n>` semantics. | Positive integer only; max rounds not exact rounds; early clean stop; invalid usage-only stop; `read-only rounds=<n>` unsupported. | Loop control correctness. | open |
| RISK-SPEC-006 | Requirement Brief | PR Acceptance | PR base/diff behavior. | Missing base, invalid base, current branch equals base, no merge-base, and no implicit fetch/ref mutation. | PR safety and reproducibility. | open |
| RISK-SPEC-007 | Requirement Brief | CODE Acceptance | Scope path behavior. | Normalize inside root, reject missing/outside/excluded/unsafe scope, and prevent traversal. | Filesystem safety. | open |
| RISK-SPEC-008 | Requirement Brief | Internal Workflow Consistency | Persistent and no-state behavior. | Review-and-fix state resumable; read-only no `.docs-review-fix/targets/` auto-fix state. | Resume and no-side-effect contracts. | open |
| RISK-SPEC-009 | Requirement Brief | Internal Workflow Consistency | Reviewer/fixer/coordinator lifecycle. | Coordinator owns final pass; reviewers read-only; full re-review after fixes. | Prevent invalid PASS claims. | open |
| RISK-SPEC-010 | Requirement Brief | Rules | PR/CODE rubric and external rules. | Built-in categories; user-global and project-local paths; precedence; hard-constraint conflict behavior. | Review policy correctness. | open |
| RISK-SPEC-011 | Requirement Brief | Output Constraints | Default/debug output boundaries. | Default concise output; debug redacted only; no raw prompts/transcripts/logs/secrets/internal IDs. | Security and UX. | open |
| RISK-SPEC-012 | Requirement Brief | Platform | Gemini advisory-only. | Gemini cannot auto-fix or claim review-and-fix PASS; generated entry must guide to Claude Code/Codex. | Platform contract. | open |
| RISK-SPEC-013 | Requirement Brief | Documentation | README sync. | `README.md` and `README.zh-CN.md` sections and information coverage aligned. | Public docs acceptance. | open |
| RISK-SPEC-014 | Requirement Brief | Install/Manifest | Generated artifacts and manifests. | New route descriptors included in generated outputs and manifest ownership tests. | Installation safety. | open |
| RISK-SPEC-015 | Requirement Brief | Verification | Minimal verification after each fix round. | Route output must name verification run/result or explicit residual risk if unavailable. | Workflow trust. | open |

## Plan Inputs

| Plan Input ID | Source Artifact | Source Item ID | Item | Required PLAN Constraint | Covers | Status |
|---|---|---|---|---|---|---|
| RISK-PLAN-001 | Risks | RISK-010 | Coverage matrix. | Include route x platform x mode x guard x rounds x rule-file test planning, with pragmatic prioritization. | Broad acceptance coverage. | open |
| RISK-PLAN-002 | Spec Inputs | RISK-SPEC-001, RISK-SPEC-006 | PR argument and base tests. | Test missing base, invalid base, same branch, no implicit fetch/ref mutation, and default mode/guard. | PR route acceptance. | open |
| RISK-PLAN-003 | Spec Inputs | RISK-SPEC-002, RISK-SPEC-007 | CODE argument and scope tests. | Test `base` rejection, root review defaults, scope normalization, outside-root rejection, excluded path rejection, and unsafe path handling. | CODE route acceptance. | open |
| RISK-PLAN-004 | Spec Inputs | RISK-SPEC-005 | Rounds tests. | Test invalid rounds usage-only stop, `rounds=1`, early clean stop, no-rounds existing behavior, and `read-only rounds=<n>` unsupported messaging. | Loop control. | open |
| RISK-PLAN-005 | Risks | RISK-001, RISK-004 | Guard/state tests. | Test route-owned multi-round changes, unrelated local change refusal, snapshot file-set coverage, stale-state rejection, and no-state read-only. | Safety and resume. | open |
| RISK-PLAN-006 | Risks | RISK-006 | Manifest/install tests. | Ensure generated route ownership is tracked and uninstall remains package-owned only. | Install/uninstall safety. | open |
| RISK-PLAN-007 | Risks | RISK-007 | Platform output tests. | Verify Claude/Codex mention automatic fix capability and Gemini says advisory-only for code routes. | Platform divergence. | open |
| RISK-PLAN-008 | Risks | RISK-005 | Output/redaction tests. | Verify default output avoids raw workflow JSON/prompts/transcripts/logs and debug output is redacted. | Security and UX. | open |
| RISK-PLAN-009 | Spec Inputs | RISK-SPEC-010 | Rule loading tests. | Test built-in PR/CODE rubrics, user-global/project-local load order, precedence, and hard-constraint conflict behavior. | Rule system. | open |
| RISK-PLAN-010 | Spec Inputs | RISK-SPEC-013 | Documentation verification. | Check `README.md` and `README.zh-CN.md` remain structurally aligned and cover required examples/semantics. | Docs acceptance. | open |

## Quality Gate

- Status: ready
- Reason: All 12 scan dimensions are covered. No requirement-definition blocker remains. Design and execution choices are routed to DESIGN, SPEC, and PLAN with stable IDs. Assumptions have source, impact, conflict status, and carry targets. Requirement Brief downstream attention items are classified into risks, discussion points, design triggers, spec inputs, and plan inputs.
- Safe next node: Risk Discovery Checkpoint, then Design Entry Gate.
- All 12 scan dimensions appear in the artifact.

## Closure Status

| Upstream ID | Closure |
|---|---|
| RISK-DES-001 | [DEFERRED] Routed to DESIGN as a target model trigger. |
| RISK-DES-002 | [DEFERRED] Routed to DESIGN as a PR diff/base trigger. |
| RISK-DES-003 | [DEFERRED] Routed to DESIGN as a code scope trigger. |
| RISK-DES-004 | [DEFERRED] Routed to DESIGN as a git guard trigger. |
| RISK-DES-005 | [DEFERRED] Routed to DESIGN as a state/resume trigger. |
| RISK-DES-006 | [DEFERRED] Routed to DESIGN as a platform capability trigger. |
| RISK-DES-007 | [DEFERRED] Routed to DESIGN as a rule precedence trigger. |
| RISK-DES-008 | [DEFERRED] Routed to DESIGN as a rounds metadata trigger. |
| RISK-SPEC-001 | [DEFERRED] Routed to SPEC as the `review-fix-pr` invocation contract. |
| RISK-SPEC-002 | [DEFERRED] Routed to SPEC as the `review-fix-code` invocation contract. |
| RISK-SPEC-003 | [DEFERRED] Routed to SPEC as mode semantics. |
| RISK-SPEC-004 | [DEFERRED] Routed to SPEC as guard semantics. |
| RISK-SPEC-005 | [DEFERRED] Routed to SPEC as `rounds=<n>` semantics. |
| RISK-SPEC-006 | [DEFERRED] Routed to SPEC as PR base/diff behavior. |
| RISK-SPEC-007 | [DEFERRED] Routed to SPEC as code scope path behavior. |
| RISK-SPEC-008 | [DEFERRED] Routed to SPEC as persistent/no-state behavior. |
| RISK-SPEC-009 | [DEFERRED] Routed to SPEC as reviewer/fixer/coordinator lifecycle. |
| RISK-SPEC-010 | [DEFERRED] Routed to SPEC as PR/CODE rule behavior. |
| RISK-SPEC-011 | [DEFERRED] Routed to SPEC as output boundary behavior. |
| RISK-SPEC-012 | [DEFERRED] Routed to SPEC as Gemini advisory-only behavior. |
| RISK-SPEC-013 | [DEFERRED] Routed to SPEC as README sync behavior. |
| RISK-SPEC-014 | [DEFERRED] Routed to SPEC as generated artifact and manifest behavior. |
| RISK-SPEC-015 | [DEFERRED] Routed to SPEC as per-round verification behavior. |
| RISK-PLAN-001 | [DEFERRED] Routed to PLAN as coverage matrix work. |
| RISK-PLAN-002 | [DEFERRED] Routed to PLAN as PR argument/base tests. |
| RISK-PLAN-003 | [DEFERRED] Routed to PLAN as CODE argument/scope tests. |
| RISK-PLAN-004 | [DEFERRED] Routed to PLAN as rounds tests. |
| RISK-PLAN-005 | [DEFERRED] Routed to PLAN as guard/state tests. |
| RISK-PLAN-006 | [DEFERRED] Routed to PLAN as manifest/install tests. |
| RISK-PLAN-007 | [DEFERRED] Routed to PLAN as platform output tests. |
| RISK-PLAN-008 | [DEFERRED] Routed to PLAN as output/redaction tests. |
| RISK-PLAN-009 | [DEFERRED] Routed to PLAN as rule loading tests. |
| RISK-PLAN-010 | [DEFERRED] Routed to PLAN as documentation verification. |

## Risk Discovery Checkpoint

- Status: ready for checkpoint decision
- Review Sources: main-agent direct review of raw requirement, approved Requirement Brief, repository metadata, and repository file inventory.
- Required Changes: none known.
- User Confirmations:
  - DESIGN Entry Authorization: yes, after checkpoint approval.
