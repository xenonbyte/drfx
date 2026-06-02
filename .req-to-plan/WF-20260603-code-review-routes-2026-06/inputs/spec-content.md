# SPEC: code review routes

## Upstream References

| Artifact | Reference | Status |
|---|---|---|
| Raw Requirement | `.req-to-plan/WF-20260603-code-review-routes-2026-06/00-raw-requirement.md` | available |
| Requirement Brief | `.req-to-plan/WF-20260603-code-review-routes-2026-06/03-requirement-brief.md` | approved |
| Risk & Question Discovery | `.req-to-plan/WF-20260603-code-review-routes-2026-06/04-risk-discovery.md` | approved |
| DESIGN | `.req-to-plan/WF-20260603-code-review-routes-2026-06/05-design.md` | approved |

## Summary

After implementation, `@xenonbyte/document-review-fix` must expose six review-fix routes from one shared route model: four existing document routes plus new `review-fix-pr` and `review-fix-code`. Document routes keep current document semantics and add `rounds=<n>`. Code routes use file-set target contexts, route-specific validation, PR/CODE rubrics, external PR/CODE rules, file-set guards, and platform-specific generated entries. Claude Code and Codex can perform automatic repair where workflow hard constraints pass; Gemini remains advisory-only and must not claim automatic fixes or workflow PASS for code review routes.

## Design Coverage Import

| Design Source | Source ID | Item | Required SPEC Contract | Closure Status | Resolution / Route |
|---|---|---|---|---|---|
| DESIGN Spec Input | DES-SPEC-001 | Route registry | Route descriptors define all supported route facts. | [ADDRESSED] | Covered by `SPEC-FR-001`, `SPEC-IF-001`. |
| DESIGN Spec Input | DES-SPEC-002 | Invocation parsing | Route-kind token grammar and preflight order are defined. | [ADDRESSED] | Covered by `SPEC-IF-002` through `SPEC-IF-004`, `SPEC-ERR-001`. |
| DESIGN Spec Input | DES-SPEC-003 | `rounds=<n>` | `roundLimit` validation and loop behavior are defined. | [ADDRESSED] | Covered by `SPEC-FR-004`, `SPEC-STATE-002`, `SPEC-ERR-004`. |
| DESIGN Spec Input | DES-SPEC-004 | Target context and state identity | Document, PR, and code target contexts and stale resume behavior are defined. | [ADDRESSED] | Covered by `SPEC-STATE-001`, `SPEC-STATE-003`, `SPEC-ERR-005`. |
| DESIGN Spec Input | DES-SPEC-005 | File-set git guard | File-set git guard behavior is defined. | [ADDRESSED] | Covered by `SPEC-SAFE-001`, `SPEC-SAFE-002`, `SPEC-ERR-006`. |
| DESIGN Spec Input | DES-SPEC-006 | File-set snapshot guard | File-set snapshot behavior is defined. | [ADDRESSED] | Covered by `SPEC-SAFE-003`, `SPEC-ERR-007`. |
| DESIGN Spec Input | DES-SPEC-007 | PR/CODE rulebook | Built-in and external rule behavior is defined. | [ADDRESSED] | Covered by `SPEC-FR-005`, `SPEC-IF-005`, `SPEC-ERR-008`. |
| DESIGN Spec Input | DES-SPEC-008 | Platform generation and install | Generated output and install/manifest behavior are defined. | [ADDRESSED] | Covered by `SPEC-FR-006`, `SPEC-IF-006`, `SPEC-COMPAT-002`. |
| DESIGN Spec Input | DES-SPEC-009 | Workflow lifecycle | Coordinator/reviewer/fixer lifecycle is defined for file-set targets. | [ADDRESSED] | Covered by `SPEC-FR-007`, `SPEC-SAFE-004`, `SPEC-OBS-001`. |
| DESIGN Spec Input | DES-SPEC-010 | Documentation | README behavior and structure alignment are defined. | [ADDRESSED] | Covered by `SPEC-FR-008`, `SPEC-COMPAT-003`. |
| DESIGN Spec Input | DES-SPEC-011 | Verification contracts | Required verification coverage is defined. | [ADDRESSED] | Covered by `SPEC-PLAN-001` through `SPEC-PLAN-010`. |
| DESIGN Spec Input | DES-SPEC-012 | PR target resolver | PR base/current branch/merge-base behavior is defined. | [ADDRESSED] | Covered by `SPEC-IF-003`, `SPEC-ERR-002`, `SPEC-COMPAT-004`. |
| DESIGN Spec Input | DES-SPEC-013 | CODE target resolver | Code scope normalization/exclusion behavior is defined. | [ADDRESSED] | Covered by `SPEC-IF-004`, `SPEC-ERR-003`, `SPEC-SAFE-005`. |
| DESIGN Boundary | DES-BND-001 | Route descriptor boundary | Route descriptor behavior is covered. | [ADDRESSED] | Covered by `SPEC-IF-001`. |
| DESIGN Boundary | DES-BND-002 | Invocation parsing boundary | Parser behavior is covered. | [ADDRESSED] | Covered by `SPEC-IF-002`, `SPEC-ERR-001`. |
| DESIGN Boundary | DES-BND-003 | Target context boundary | Target context behavior is covered. | [ADDRESSED] | Covered by `SPEC-STATE-001`, `SPEC-STATE-003`. |
| DESIGN Boundary | DES-BND-004 | Git guard boundary | Git guard behavior is covered. | [ADDRESSED] | Covered by `SPEC-SAFE-001`, `SPEC-SAFE-002`. |
| DESIGN Boundary | DES-BND-005 | Snapshot guard boundary | Snapshot guard behavior is covered. | [ADDRESSED] | Covered by `SPEC-SAFE-003`. |
| DESIGN Boundary | DES-BND-006 | Rulebook boundary | Rulebook behavior is covered. | [ADDRESSED] | Covered by `SPEC-IF-005`, `SPEC-ERR-008`. |
| DESIGN Boundary | DES-BND-007 | Platform generation boundary | Generated/install behavior is covered. | [ADDRESSED] | Covered by `SPEC-IF-006`, `SPEC-COMPAT-002`. |
| DESIGN Boundary | DES-BND-008 | Workflow lifecycle boundary | Lifecycle behavior is covered. | [ADDRESSED] | Covered by `SPEC-FR-007`, `SPEC-SAFE-004`. |
| DESIGN Integration Boundary | DES-INT-001 | Platform route installation | Install integration behavior is covered. | [ADDRESSED] | Covered by `SPEC-IF-006`, `SPEC-COMPAT-002`. |
| DESIGN Integration Boundary | DES-INT-002 | Runtime workflow entry | Runtime payload behavior is covered. | [ADDRESSED] | Covered by `SPEC-IF-002`, `SPEC-STATE-001`. |
| DESIGN Integration Boundary | DES-INT-003 | Rule file integration | Rule file behavior is covered. | [ADDRESSED] | Covered by `SPEC-IF-005`. |
| DESIGN Assumption | DES-A-001 | Local tests can exercise git cases | Non-blocking; PLAN must use local repos/fixtures if needed. | [DEFERRED] | Carried by `SPEC-PLAN-003`, `SPEC-PLAN-005`. |
| DESIGN Assumption | DES-A-002 | Templates can be parameterized | Non-blocking; SPEC defines outputs, PLAN verifies implementation path. | [DEFERRED] | Carried by `SPEC-PLAN-007`. |
| DESIGN Assumption | DES-A-003 | Deterministic traversal is enough | Non-blocking; no new dependency unless later approved. | [DEFERRED] | Carried by `SPEC-IF-004`, `SPEC-PLAN-004`. |

## Functional Requirements

| ID | Contract | Trace | Status |
|---|---|---|---|
| SPEC-FR-001 | The system must recognize exactly these route names as first-class route descriptors: `review-fix-spec`, `review-fix-plan`, `review-fix-design`, `review-fix-doc`, `review-fix-pr`, and `review-fix-code`. Existing document routes must retain their document type/rubric behavior. | DES-SPEC-001 | [ADDRESSED] |
| SPEC-FR-002 | `review-fix-pr` must review the current branch relative to a required local `base=<branch>` or resolvable revision using PR diff semantics, not a whole-repository global scan. | DES-SPEC-012 | [ADDRESSED] |
| SPEC-FR-003 | `review-fix-code` must review project-root source code by default, or one or more validated `scope=<path>` scopes when supplied. | DES-SPEC-013 | [ADDRESSED] |
| SPEC-FR-004 | For all six routes, `rounds=<n>` must mean a positive integer maximum number of review/fix/re-review rounds, with early stop on clean review before the limit. | DES-SPEC-003 | [ADDRESSED] |
| SPEC-FR-005 | PR and CODE routes must include built-in rubrics and merge external user/project rules without allowing external rules to relax workflow hard constraints. | DES-SPEC-007 | [ADDRESSED] |
| SPEC-FR-006 | Platform generation must install both code routes for Claude Code, Codex, and Gemini, with generated text matching each platform's capability. | DES-SPEC-008 | [ADDRESSED] |
| SPEC-FR-007 | `review-and-fix` must preserve the existing lifecycle: review, triage, fix, diff review, full re-review, repeat, and only the coordinator may decide final PASS. | DES-SPEC-009 | [ADDRESSED] |
| SPEC-FR-008 | `README.md` and `README.zh-CN.md` must cover the same route behavior, defaults, guards, rules, Gemini advisory-only limitation, and examples with aligned section structure. | DES-SPEC-010 | [ADDRESSED] |

## Interfaces

| ID | Interface Contract | Inputs | Outputs | Error Behavior | Trace | Status |
|---|---|---|---|---|---|---|
| SPEC-IF-001 | Route descriptors must expose route name, route kind (`document`, `pr`, `code`), default mode, default guard, platform policy, rubric/rule key, and target context kind. | Route name | Descriptor or unsupported-route error | Unknown route fails before target reads or state creation. | DES-SPEC-001 | [ADDRESSED] |
| SPEC-IF-002 | Document route invocation must keep current grammar and add optional `rounds=<n>`: `<path>` or `target=<path>`, repeated `ref=<path>`, strictness, mode, assurance, guard, resume, ledger, root, debug, rounds. | Document route tokens | Normalized invocation with `roundLimit` or usage-only error | Invalid token/value stops before target/reference body reads. | DES-SPEC-002, DES-SPEC-003 | [ADDRESSED] |
| SPEC-IF-003 | `review-fix-pr` invocation grammar is `base=<branch>` plus optional mode, `guard=git|snapshot`, and `rounds=<n>`; `base` is required. | PR route tokens | PR target context or usage/blocked result | Missing base, invalid base, same current branch, or missing merge-base stop before review/fix. | DES-SPEC-012 | [ADDRESSED] |
| SPEC-IF-004 | `review-fix-code` invocation grammar is optional repeated `scope=<path>` plus optional mode, `guard=git|snapshot`, and `rounds=<n>`; `base=<branch>` is invalid. | CODE route tokens | Code target context or usage/blocked result | Invalid base/scope/rounds stop before review/fix. | DES-SPEC-013 | [ADDRESSED] |
| SPEC-IF-005 | PR/CODE rule files are loaded from `~/.docs-review-fix/rules/PR.md`, `.docs-review-fix/rules/PR.md`, `~/.docs-review-fix/rules/CODE.md`, and `.docs-review-fix/rules/CODE.md` according to route kind. | Route kind, project root, home dir | Merged rule context and warnings/errors | Symlink, invalid path, or hard-constraint conflict blocks or reports per existing strictness rules. | DES-SPEC-007 | [ADDRESSED] |
| SPEC-IF-006 | Generated platform entries must be produced under existing platform install roots and manifest ownership records for all six routes. | Platform and route descriptors | Claude command files, Codex skill directories, Gemini TOML commands | Unsupported platform/route fails without partial unowned output. | DES-SPEC-008 | [ADDRESSED] |

## Data / State

| ID | State Contract | State Transition / Persistence | Trace | Status |
|---|---|---|---|
| SPEC-STATE-001 | Every workflow start must persist or carry a route target context that includes route kind, normalized invocation, guard mode, and target identity. | Persistent review-and-fix stores it in target/project-local state; read-only no-state carries it only in preflight/review tokens. | DES-SPEC-004 | [ADDRESSED] |
| SPEC-STATE-002 | User `roundLimit` must be stored or carried as invocation/workflow metadata and must not reuse `currentRound`, report text, or receipt directory names as the user limit. | On each loop boundary, compare current completed round count to `roundLimit`; no limit preserves current behavior. | DES-SPEC-003 | [ADDRESSED] |
| SPEC-STATE-003 | PR/code target state keys must include route kind and target identity: PR includes base/merge-base/current HEAD or equivalent stale-detection fields; CODE includes normalized scopes/exclusions/file-set identity. | Resume succeeds only when the stored identity still matches; mismatch returns stale/externally-changed style status. | DES-SPEC-004, DES-SPEC-012, DES-SPEC-013 | [ADDRESSED] |
| SPEC-STATE-004 | `read-only` mode must not create `.docs-review-fix/targets/` automatic-fix state for document, PR, or CODE routes. | No-state tokens/guards may be used in memory or command payloads only. | DES-SPEC-009 | [ADDRESSED] |

## Error Behavior

| ID | Error Contract | Required Behavior | Trace | Status |
|---|---|---|---|---|
| SPEC-ERR-001 | Unknown or invalid tokens must produce usage/help output only. | No target reads, reference reads, diff reads, state creation, reviewer probes, or fixes may occur. | DES-SPEC-002 | [ADDRESSED] |
| SPEC-ERR-002 | `review-fix-pr` missing/unresolvable/same-current-branch base, or missing merge-base, must stop with a specific user-facing reason. | No implicit `git fetch`, no ref mutation, no review, and no fix. | DES-SPEC-012 | [ADDRESSED] |
| SPEC-ERR-003 | `review-fix-code` invalid `base` or unsafe `scope` must stop with a specific user-facing reason. | No traversal outside project root, no review, and no fix. | DES-SPEC-013 | [ADDRESSED] |
| SPEC-ERR-004 | Invalid `rounds=<n>` must stop as usage-only for all six routes. | Positive integers only; `read-only rounds=<n>` reports unsupported loop semantics and suggests `review-and-fix rounds=<n>`. | DES-SPEC-003 | [ADDRESSED] |
| SPEC-ERR-005 | Stale PR/code state must refuse resume. | The output must state stale target context rather than silently using old base/scope/file-set data. | DES-SPEC-004 | [ADDRESSED] |
| SPEC-ERR-006 | Selected `guard=git` unavailable or failed must stop with guard-specific reason. | It must not switch to snapshot unless the user explicitly selected `guard=snapshot`. | DES-SPEC-005 | [ADDRESSED] |
| SPEC-ERR-007 | Selected `guard=snapshot` unavailable or unable to protect the monitored file set must stop with guard-specific reason. | It must not switch to git or continue unguarded. | DES-SPEC-006 | [ADDRESSED] |
| SPEC-ERR-008 | Rule files that conflict with workflow hard constraints must block or report a rule conflict. | External rules cannot relax reviewer isolation, full re-review, redaction, state locality, or write safety. | DES-SPEC-007 | [ADDRESSED] |

## Permissions / Safety

| ID | Safety Contract | Required Behavior | Trace | Status |
|---|---|---|---|---|
| SPEC-SAFE-001 | `guard=git` for file-set targets must allow route-owned prior-round changes but reject unrelated local changes. | The guard must use the route target context and stored baseline/change set, not require clean HEAD after each route-owned round. | DES-SPEC-005 | [ADDRESSED] |
| SPEC-SAFE-002 | Automatic fixes for PR/CODE routes must be limited to target-related files and necessary dependency files recorded in the file-set context. | Files outside the allowed set or route-owned state cause blocked/externally-changed style status. | DES-SPEC-005 | [ADDRESSED] |
| SPEC-SAFE-003 | `guard=snapshot` must snapshot or fingerprint the monitored file set before automatic fixes. | Restore/recovery behavior is limited to monitored files and must not touch unmonitored user files. | DES-SPEC-006 | [ADDRESSED] |
| SPEC-SAFE-004 | Reviewer subagents must remain isolated and read-only for initial review and every full re-review. | Any monitored-file write by a reviewer blocks the workflow and prevents PASS. | DES-SPEC-009 | [ADDRESSED] |
| SPEC-SAFE-005 | CODE scope resolution must reject paths outside project root, symlink-unsafe paths, excluded directories, missing paths, and unsafe traversal. | Rejected scopes cannot produce partial review output or state. | DES-SPEC-013 | [ADDRESSED] |
| SPEC-SAFE-006 | Routes must not commit, push, publish, create PRs, mutate remote state, fetch implicitly, or delete user files. | Any such action remains outside route behavior unless later explicitly requested by the user. | Requirement Brief | [ADDRESSED] |

## Compatibility

| ID | Compatibility Contract | Required Behavior | Trace | Status |
|---|---|---|---|---|
| SPEC-COMPAT-001 | Existing document routes must remain callable with current documented arguments when `rounds=<n>` is omitted. | No-rounds behavior continues until existing terminal conditions. | DES-SPEC-003 | [ADDRESSED] |
| SPEC-COMPAT-002 | Install/uninstall behavior must remain manifest-owned. | New generated routes are tracked; uninstall removes only package-owned generated files/directories. | DES-SPEC-008 | [ADDRESSED] |
| SPEC-COMPAT-003 | README English and Simplified Chinese documents must remain structurally aligned. | Technical literals remain untranslated unless already translated in prose context. | DES-SPEC-010 | [ADDRESSED] |
| SPEC-COMPAT-004 | PR base resolution must use existing local refs/revisions only. | Lack of local base is a user input problem, not a trigger for implicit network fetch. | DES-SPEC-012 | [ADDRESSED] |

## Observability

| ID | Observability Contract | Required Behavior | Trace | Status |
|---|---|---|---|---|
| SPEC-OBS-001 | Each route round must produce concise status: round, mode, scope/PR boundary where relevant, finding summary, fix summary, verification command/result, and continue/stop reason. | Default output must not print raw workflow JSON, prompts, subagent transcripts, raw logs, secrets, tokens, or internal issue IDs. | DES-SPEC-009 | [ADDRESSED] |
| SPEC-OBS-002 | `debug` output may include audit details only after redaction and output bounding. | Debug must preserve existing redaction behavior. | DES-SPEC-009 | [ADDRESSED] |
| SPEC-OBS-003 | If no suitable verification can be run after a fix round, output must explicitly state residual risk. | The route cannot present unverified fixes as fully verified. | DES-SPEC-009 | [ADDRESSED] |

## Boundary Contract Check

| Boundary | Contract Area | Input / Output | Data / State | Error Behavior | Compatibility | Migration-visible Behavior | Rollback / Recovery | Required Behavior | Trace | Testability |
|---|---|---|---|---|---|---|---|---|---|---|
| DES-BND-001 | Route descriptors | route name -> descriptor | No persistent data | Unknown route usage/preflight error | Existing route names preserved | Metadata migration only | Revert descriptor change | Registry is single source of route facts. | SPEC-IF-001 | Unit route lookup tests |
| DES-BND-002 | Invocation parsing | tokens -> normalized invocation | `roundLimit` metadata | Usage-only invalid stops | Existing doc grammar preserved | Parser extension | Revert parser dispatch | Parser validates before reads/state/probes. | SPEC-IF-002, SPEC-IF-003, SPEC-IF-004 | Parser tests |
| DES-BND-003 | Target context | invocation -> target context | target key, file set, baseline | Unsafe target blocks | Document context equivalent | File-set state added | Stale resume refused | Target context identity is explicit. | SPEC-STATE-001, SPEC-STATE-003 | Target resolver tests |
| DES-BND-004 | Git guard | context + git status -> guard result | route-owned baseline/change set | Guard failure blocks | Single-target wrapper preserved | Guard extension | No remote mutation | Unrelated changes block; route-owned changes allowed after prior round. | SPEC-SAFE-001, SPEC-SAFE-002 | Guard tests |
| DES-BND-005 | Snapshot guard | context -> snapshots/fingerprints | monitored file snapshots | Missing/symlink/outside blocks | Document snapshot preserved | Snapshot extension | Restore monitored files only | Snapshot fallback protects file set explicitly. | SPEC-SAFE-003 | Snapshot tests |
| DES-BND-006 | Rulebook | route key -> merged rules | No mutation | Invalid/conflicting rules block/report | Document rules preserved | Allowlist expansion | Remove PR/CODE support safely | Hard constraints outrank external rules. | SPEC-IF-005, SPEC-ERR-008 | Rulebook tests |
| DES-BND-007 | Platform generation | descriptor -> generated files | Manifest ownership | Unsupported platform/route fails | Existing install paths preserved | Generated route expansion | Manifest-backed uninstall | Six routes generated with correct platform wording. | SPEC-IF-006 | Shared asset/install tests |
| DES-BND-008 | Workflow lifecycle | context + reports -> status | receipts, ledger, manifest | Missing full re-review blocks PASS | Terminal statuses preserved | Lifecycle extension | Existing finalize semantics | Coordinator owns final pass; read-only no-state. | SPEC-FR-007, SPEC-SAFE-004 | Workflow tests |
| DES-INT-001 | Platform installation | descriptor -> command/skill/TOML | Manifest checksums | Existing install errors continue | Existing document paths preserved | Add generated entries | Owned-only uninstall | Code routes appear in Claude/Codex/Gemini generated outputs. | SPEC-IF-006 | Install manifest tests |
| DES-INT-002 | Runtime workflow entry | user invocation -> semantic payload | normalized invocation + context | Invalid stops before reads/state | Document payload preserved | Payload schema expands | Resume stale refusal | Generated entries materialize defaults before workflow calls. | SPEC-IF-002, SPEC-STATE-001 | Workflow JSON tests |
| DES-INT-003 | Rule file integration | rule paths -> merged context | No mutation | Invalid/conflict handling | Document rule files preserved | Rule name allowlist expands | No user rule deletion | PR/CODE rule paths participate in review context. | SPEC-IF-005 | Rulebook tests |

## Acceptance Scenarios

| ID | Scenario | Verification Idea | Trace | Status |
|---|---|---|---|---|
| SPEC-ACC-001 | Given `review-fix-pr` is invoked without `base`, when parsing runs, then only usage/example output is produced and no diff/review/state/fix starts. | Parser/preflight test with file-read/state spies or fixture assertions. | Requirement Brief `review-fix-pr` acceptance | [ADDRESSED] |
| SPEC-ACC-002 | Given `review-fix-pr base=<current-branch>`, when preflight runs, then it reports base cannot equal current branch and stops. | Temporary git repo test. | Requirement Brief `review-fix-pr` acceptance | [ADDRESSED] |
| SPEC-ACC-003 | Given `review-fix-code base=main`, when parsing runs, then it reports that `base` belongs to `review-fix-pr` and stops. | Parser test. | Requirement Brief `review-fix-code` acceptance | [ADDRESSED] |
| SPEC-ACC-004 | Given `review-fix-code scope=../outside`, when preflight runs, then it rejects the scope and does not inspect outside-root files. | Scope resolver test. | Requirement Brief CODE acceptance | [ADDRESSED] |
| SPEC-ACC-005 | Given any route with `rounds=0` or non-integer rounds, when parsing runs, then it prints usage and starts no workflow. | Parser test for all route kinds. | Requirement Brief common acceptance | [ADDRESSED] |
| SPEC-ACC-006 | Given `read-only rounds=3`, when any route is invoked, then it reports read-only is single-review and suggests `review-and-fix rounds=3`. | Parser/preflight test. | Requirement Brief common acceptance | [ADDRESSED] |
| SPEC-ACC-007 | Given Gemini generated code route receives `review-and-fix`, when invoked, then it reports advisory-only and points to Claude Code/Codex for automatic fixes. | Generated Gemini text/behavior test. | Gemini acceptance | [ADDRESSED] |
| SPEC-ACC-008 | Given a route-owned prior-round file-set change, when `guard=git` checks the next round, then it does not fail solely because of that route-owned change. | File-set guard test. | Guard acceptance | [ADDRESSED] |
| SPEC-ACC-009 | Given an unrelated local change appears, when automatic fix completion is guarded, then the workflow blocks before PASS. | File-set guard test. | Guard acceptance | [ADDRESSED] |
| SPEC-ACC-010 | Given README updates are complete, when documentation assertions run, then both README files include new routes, rounds, guards, rules, Gemini limitation, and examples. | README structural/content test. | Documentation acceptance | [ADDRESSED] |

## Edge Cases

| ID | Edge Case | Required Behavior | Trace | Status |
|---|---|---|---|---|
| SPEC-EDGE-001 | PR base is a tag, commit, or local branch. | Accept any locally resolvable revision that is not the current branch identity and has a merge-base. | DES-SPEC-012 | [ADDRESSED] |
| SPEC-EDGE-002 | PR diff has deleted or renamed files. | Target context records affected paths safely; fixes may only touch valid necessary files and must not resurrect/delete unrelated files. | DES-SPEC-005, DES-SPEC-012 | [ADDRESSED] |
| SPEC-EDGE-003 | CODE scope points at excluded infrastructure. | Reject before scanning, even if the path exists. | DES-SPEC-013 | [ADDRESSED] |
| SPEC-EDGE-004 | External rule file is empty or absent. | Continue with built-in and other available rules; absence does not weaken hard constraints. | DES-SPEC-007 | [ADDRESSED] |
| SPEC-EDGE-005 | External rule file is a symlink. | Reject according to existing custom rule safety behavior. | DES-SPEC-007 | [ADDRESSED] |
| SPEC-EDGE-006 | `rounds=1` finds and fixes issues, then full re-review still has findings. | Stop at the limit and report remaining findings/stop reason; do not claim clean. | DES-SPEC-003, DES-SPEC-009 | [ADDRESSED] |
| SPEC-EDGE-007 | `rounds=5` becomes clean on round 2. | Stop at round 2 and report clean/stop reason. | DES-SPEC-003 | [ADDRESSED] |
| SPEC-EDGE-008 | Verification command is unavailable. | Report residual risk and do not describe the change as fully verified. | DES-SPEC-009 | [ADDRESSED] |

## Traceability

| Source | Covered By | Status |
|---|---|---|
| Requirement Brief Scope | `SPEC-FR-001` through `SPEC-FR-008` | [ADDRESSED] |
| Requirement Brief Acceptance | `SPEC-ACC-001` through `SPEC-ACC-010` | [ADDRESSED] |
| DESIGN Change Point Inventory | `SPEC-IF-*`, `SPEC-STATE-*`, `SPEC-SAFE-*`, `SPEC-COMPAT-*` | [ADDRESSED] |
| DESIGN Boundary Coverage | Boundary Contract Check table | [ADDRESSED] |
| DESIGN Integration Boundaries | Boundary Contract Check rows `DES-INT-001` through `DES-INT-003` | [ADDRESSED] |
| Risk / Attack Gate | `SPEC-SAFE-*`, `SPEC-ERR-*`, `SPEC-COMPAT-*`, `SPEC-PLAN-*` | [ADDRESSED] |

## External Documentation Checked

| dependency | version | check date | conclusion |
|---|---|---|---|
| Node.js built-in modules (`require`, `node:path`, `node:fs`, `node:child_process`) | v20 docs | 2026-06-03 | Context7 checked `/websites/nodejs_latest-v20_x`: CommonJS `require` can load built-in modules; `path`, `fs`, and `child_process.execFile` APIs are documented for local filesystem and command execution without extra package dependencies. |
| Git CLI (`rev-parse`, `merge-base`, `status --porcelain`, `fetch`) | Git docs | 2026-06-03 | Context7 checked `/git/htmldocs`: `rev-parse` supports local revision parsing in a repository; `merge-base` computes common ancestors; `status --porcelain` is stable script output; `fetch` is a separate command to download remote refs and is not implied by local revision checks. |

## Plan Inputs

| Plan Input ID | Source Artifact | Source Item ID | Item | Required PLAN Constraint | Covers | Status |
|---|---|---|---|---|---|---|
| SPEC-PLAN-001 | SPEC | SPEC-FR-001 | Route registry | Implement shared route registry before parser/generator changes; verify all six routes. | DES-PLAN-001 | [DEFERRED] |
| SPEC-PLAN-002 | SPEC | SPEC-IF-002, SPEC-IF-003, SPEC-IF-004 | Invocation parsing | Add parser/preflight tests before implementation for document rounds, PR base, CODE scope, invalid tokens, invalid rounds, and read-only rounds. | DES-PLAN-002 | [DEFERRED] |
| SPEC-PLAN-003 | SPEC | SPEC-FR-004, SPEC-STATE-002, SPEC-ERR-004 | Rounds behavior | Verify invalid rounds, `rounds=1`, early clean stop, no-rounds compatibility, and `read-only rounds=<n>`. | DES-PLAN-003, RISK-PLAN-004 | [DEFERRED] |
| SPEC-PLAN-004 | SPEC | SPEC-STATE-001, SPEC-STATE-003 | Target context/state | Implement target context state keys and stale resume refusal; use local fixtures if needed. | DES-PLAN-004 | [DEFERRED] |
| SPEC-PLAN-005 | SPEC | SPEC-SAFE-001, SPEC-SAFE-002, SPEC-SAFE-003 | File-set guards | Implement git and snapshot file-set guard helpers with route-owned and unrelated-change tests. | DES-PLAN-005, RISK-PLAN-005 | [DEFERRED] |
| SPEC-PLAN-006 | SPEC | SPEC-IF-005, SPEC-ERR-008 | Rulebook | Add PR/CODE rubrics and rule loading/conflict tests. | DES-PLAN-006, RISK-PLAN-009 | [DEFERRED] |
| SPEC-PLAN-007 | SPEC | SPEC-IF-006, SPEC-COMPAT-002 | Platform generation/install | Update generated outputs and manifest tests for six routes and Gemini advisory-only code behavior. | DES-PLAN-007, RISK-PLAN-006, RISK-PLAN-007 | [DEFERRED] |
| SPEC-PLAN-008 | SPEC | SPEC-FR-007, SPEC-SAFE-004, SPEC-OBS-001 | Workflow lifecycle | Preserve reviewer readiness, write blocking, stdin proof, diff review, full re-review, redaction, and final validation. | DES-PLAN-008, RISK-PLAN-008 | [DEFERRED] |
| SPEC-PLAN-009 | SPEC | SPEC-FR-008, SPEC-COMPAT-003 | Documentation | Update both README files in one pass and verify aligned content. | DES-PLAN-009, RISK-PLAN-010 | [DEFERRED] |
| SPEC-PLAN-010 | SPEC | All SPEC contracts | Verification matrix | Run targeted tests, full `npm test`, and package/generation checks appropriate to changed surfaces. | DES-PLAN-010, RISK-PLAN-001 | [DEFERRED] |

## Coverage Closure

| Upstream ID | Closure |
|---|---|
| DES-SPEC-001 | [ADDRESSED] Covered by route registry contracts. |
| DES-SPEC-002 | [ADDRESSED] Covered by invocation parser contracts. |
| DES-SPEC-003 | [ADDRESSED] Covered by rounds contracts. |
| DES-SPEC-004 | [ADDRESSED] Covered by target context/state contracts. |
| DES-SPEC-005 | [ADDRESSED] Covered by file-set git guard contracts. |
| DES-SPEC-006 | [ADDRESSED] Covered by file-set snapshot guard contracts. |
| DES-SPEC-007 | [ADDRESSED] Covered by rulebook contracts. |
| DES-SPEC-008 | [ADDRESSED] Covered by platform generation/install contracts. |
| DES-SPEC-009 | [ADDRESSED] Covered by workflow lifecycle contracts. |
| DES-SPEC-010 | [ADDRESSED] Covered by documentation contracts. |
| DES-SPEC-011 | [ADDRESSED] Covered by Plan Inputs and verification matrix. |
| DES-SPEC-012 | [ADDRESSED] Covered by PR resolver contracts. |
| DES-SPEC-013 | [ADDRESSED] Covered by CODE resolver contracts. |
| DES-BND-001 | [ADDRESSED] Covered by `SPEC-IF-001`. |
| DES-BND-002 | [ADDRESSED] Covered by `SPEC-IF-002` through `SPEC-IF-004`. |
| DES-BND-003 | [ADDRESSED] Covered by `SPEC-STATE-001` and `SPEC-STATE-003`. |
| DES-BND-004 | [ADDRESSED] Covered by `SPEC-SAFE-001` and `SPEC-SAFE-002`. |
| DES-BND-005 | [ADDRESSED] Covered by `SPEC-SAFE-003`. |
| DES-BND-006 | [ADDRESSED] Covered by `SPEC-IF-005`. |
| DES-BND-007 | [ADDRESSED] Covered by `SPEC-IF-006`. |
| DES-BND-008 | [ADDRESSED] Covered by `SPEC-FR-007` and `SPEC-SAFE-004`. |
| DES-INT-001 | [ADDRESSED] Covered by platform install contracts. |
| DES-INT-002 | [ADDRESSED] Covered by runtime workflow entry contracts. |
| DES-INT-003 | [ADDRESSED] Covered by rule file integration contracts. |
| DES-A-001 | [DEFERRED] Non-blocking assumption carried to PLAN via `SPEC-PLAN-003` and `SPEC-PLAN-005`. |
| DES-A-002 | [DEFERRED] Non-blocking assumption carried to PLAN via `SPEC-PLAN-007`. |
| DES-A-003 | [DEFERRED] Non-blocking assumption carried to SPEC/PLAN via CODE scope contracts and `SPEC-PLAN-004`. |
| DES-PLAN-001 | [DEFERRED] Carried to `SPEC-PLAN-001`. |
| DES-PLAN-002 | [DEFERRED] Carried to `SPEC-PLAN-002`. |
| DES-PLAN-003 | [DEFERRED] Carried to `SPEC-PLAN-003`. |
| DES-PLAN-004 | [DEFERRED] Carried to `SPEC-PLAN-004`. |
| DES-PLAN-005 | [DEFERRED] Carried to `SPEC-PLAN-005`. |
| DES-PLAN-006 | [DEFERRED] Carried to `SPEC-PLAN-006`. |
| DES-PLAN-007 | [DEFERRED] Carried to `SPEC-PLAN-007`. |
| DES-PLAN-008 | [DEFERRED] Carried to `SPEC-PLAN-008`. |
| DES-PLAN-009 | [DEFERRED] Carried to `SPEC-PLAN-009`. |
| DES-PLAN-010 | [DEFERRED] Carried to `SPEC-PLAN-010`. |
| RISK-PLAN-001 | [DEFERRED] Carried to `SPEC-PLAN-010`. |
| RISK-PLAN-002 | [DEFERRED] Carried to `SPEC-PLAN-002`. |
| RISK-PLAN-003 | [DEFERRED] Carried to `SPEC-PLAN-002`. |
| RISK-PLAN-004 | [DEFERRED] Carried to `SPEC-PLAN-003`. |
| RISK-PLAN-005 | [DEFERRED] Carried to `SPEC-PLAN-005`. |
| RISK-PLAN-006 | [DEFERRED] Carried to `SPEC-PLAN-007`. |
| RISK-PLAN-007 | [DEFERRED] Carried to `SPEC-PLAN-007`. |
| RISK-PLAN-008 | [DEFERRED] Carried to `SPEC-PLAN-008`. |
| RISK-PLAN-009 | [DEFERRED] Carried to `SPEC-PLAN-006`. |
| RISK-PLAN-010 | [DEFERRED] Carried to `SPEC-PLAN-009`. |

## Testability Gate

- Status: ready
- Functional requirements have observable route, output, state, or generated-file outcomes.
- Interface contracts include inputs, outputs, and error behavior.
- State contracts include persistence/no-state and stale-resume semantics.
- Compatibility contracts define what remains compatible.
- Acceptance scenarios include verification ideas.
- No contract depends on hidden implementation assumptions.

## Spec Quality Gate

- Status: ready
- Reason: All DESIGN Spec Inputs, change points, boundaries, integration boundaries, acceptance criteria, and carried Risk/Plan inputs have testable contracts or deferred PLAN inputs with closure status. External documentation was checked for Git and Node.js dependencies. No requirement scope or DESIGN decision was changed.
- Safe next node: SPEC Checkpoint, then PLAN.

## SPEC Checkpoint

- Status: ready for checkpoint decision
- Review Sources: main-agent review of approved Requirement Brief, Risk Discovery, DESIGN, DESIGN subagent review, SPEC workflow rules, and Context7 documentation checks.
- Required Changes: none known.
- User Confirmations:
  - PLAN Authorization: yes, after checkpoint approval.
