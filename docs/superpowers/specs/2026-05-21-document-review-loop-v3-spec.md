# Document Review Loop V3 Spec

## Upstream Sources

This Spec decomposes `design/DESIGN-v3.md` into implementation-ready
requirements under `/Users/xubo/Desktop/SPEC-RULE.md`.

Primary upstream source:

- `design/DESIGN-v3.md`

Governing review rule:

- `/Users/xubo/Desktop/SPEC-RULE.md`

Inherited design context:

- `design/DESIGN-v2.md`

V3 supersedes only the parts of V2 named in `design/DESIGN-v3.md`: custom
rulebook configuration, user-facing route mode defaults, subagent model quality
policy, concise default route output with explicit debug mode, and
review-and-fix write eligibility preflight.

All workflow, state, capability, review, triage, fix, diff-review,
full-re-review, resume, receipt, and final-response behavior from V2 remains in
force unless V3 explicitly replaces it.

## Goal

Implement the V3 behavior described in `design/DESIGN-v3.md` as a breaking
change for the in-development `@xenonbyte/document-review-fix` package.

The implementation must:

- replace the single custom `RULE.md` interface with document-type-scoped
  `rules/*.md` files;
- make generated Codex and Claude Code routes default to useful
  `review-and-fix assurance=practical` behavior when users omit mode and
  assurance;
- keep generated Gemini routes advisory-only by default;
- fail early before semantic review when automatic writes cannot be performed
  safely;
- render concise user-facing output by default while preserving detailed
  workflow audit output behind a `debug` route token;
- state subagent quality requirements without pinning concrete model names.

## Scope

This Spec covers these V3 requirement areas:

- custom rule file layout and validation;
- rule loading, merge order, and source metadata;
- user-facing route mode and assurance defaults;
- route-level `review-and-fix` write eligibility preflight;
- subagent quality policy text in generated routes;
- concise default route output and `debug` output;
- README, source skill, generated route template, and shared prompt updates;
- tests proving the V3 behavior.

## Non-Scope

This Spec does not:

- introduce automatic migration from old `RULE.md`;
- support legacy `RULE.md` as a fallback;
- add a runtime dependency;
- change built-in rubrics under `shared/rubrics/`;
- change the core V2 review-fix loop;
- add automatic target writes to Gemini;
- bind routes to a concrete provider model, model version, or deployment alias;
- remove machine validation, receipts, manifests, ledgers, reports, target-local
  audit state, or final-response validation;
- require Git eligibility for `read-only` review;
- implement a future persistent `audit` or `debug-persist` token.

## Terms

- `rules directory`: `~/.docs-review-fix/rules/` or
  `.docs-review-fix/rules/`.
- `custom rule file`: one of `COMMON.md`, `SPEC.md`, `PLAN.md`, or
  `DESIGN.md` inside a rules directory.
- `legacy rulebook`: `~/.docs-review-fix/RULE.md` or
  `.docs-review-fix/RULE.md`.
- `content read`: reading a custom rule file body.
- `directory inspection`: listing entries in an existing rules directory
  without reading unrelated custom rule file bodies.
- `write eligibility preflight`: route-level check that proves a target can be
  safely auto-fixed before semantic review and before target-local state
  creation.
- `default output`: normal route output when `debug` is absent.
- `debug output`: detailed route output when the user passes the `debug` route
  token.

## Requirements

### 1. Custom Rule File Layout

Upstream design scope: `design/DESIGN-v3.md` sections 1, 2, 3, 4, 9, 10, 11,
12, 13, 14, and 15.

The only supported custom rule files are:

```text
~/.docs-review-fix/rules/COMMON.md
~/.docs-review-fix/rules/SPEC.md
~/.docs-review-fix/rules/PLAN.md
~/.docs-review-fix/rules/DESIGN.md
.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/SPEC.md
.docs-review-fix/rules/PLAN.md
.docs-review-fix/rules/DESIGN.md
```

The implementation must treat `.docs-review-fix/rules/` as shared project
configuration, not target-local workflow state.

Persistent workflow state remains under:

```text
.docs-review-fix/targets/<target-key>/
```

The implementation must not read or merge `RULE.md` as a compatibility
fallback.

### 2. Rule Loading

Upstream design scope: `design/DESIGN-v3.md` sections 3, 9, 10, 12, 13, 14, and
15.

Rule loading receives a resolved document type: `COMMON`, `SPEC`, `PLAN`, or
`DESIGN`.

For `COMMON`, content reads are limited to:

```text
~/.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/COMMON.md
```

For `SPEC`, content reads are limited to:

```text
~/.docs-review-fix/rules/COMMON.md
~/.docs-review-fix/rules/SPEC.md
.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/SPEC.md
```

For `PLAN`, content reads are limited to:

```text
~/.docs-review-fix/rules/COMMON.md
~/.docs-review-fix/rules/PLAN.md
.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/PLAN.md
```

For `DESIGN`, content reads are limited to:

```text
~/.docs-review-fix/rules/COMMON.md
~/.docs-review-fix/rules/DESIGN.md
.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/DESIGN.md
```

The implementation must inspect directory entries for each existing user-global
and project-local rules directory before workflow start writes target state.
Directory inspection is required to detect stale or misspelled Markdown
configuration. Directory inspection must not read unrelated document-type file
bodies.

Empty or missing custom rule files are treated as absent.

Custom rule file contents are plain Markdown fragments. They do not require a
wrapping `## SPEC`, `## PLAN`, `## DESIGN`, or `## COMMON` heading.

### 3. Rule Validation

Upstream design scope: `design/DESIGN-v3.md` sections 3, 4, 11, 13, 14, and 15.

Workflow start must stop before writing target state when either of these
conditions exists:

- a legacy rulebook exists at `~/.docs-review-fix/RULE.md` or
  `.docs-review-fix/RULE.md`;
- an unknown Markdown file exists under an inspected rules directory.

Unknown Markdown examples include:

```text
Spec.md
SPEC-RULE.md
REQUIREMENTS.md
```

The blocked result must use:

```text
Status: blocked
Blocking reason: state-validation-failed
```

The implementation must not read or merge the stale or unknown file as a
fallback.

Non-Markdown files under rules directories are ignored unless the implementation
uses them as package-owned metadata. V3 does not require such metadata.

If a custom rule file weakens workflow hard constraints, the run must stop with
the same hard-constraint conflict behavior as V2.

### 4. Rule Merge Order And Metadata

Upstream design scope: `design/DESIGN-v3.md` sections 3, 10, 12, 13, 14, and
15.

The merge order remains:

1. workflow hard constraints
2. built-in COMMON rubric
3. built-in document-type rubric
4. user-global `COMMON.md`
5. user-global document-type rule file
6. project-local `COMMON.md`
7. project-local document-type rule file

For `COMMON` documents, document-type-specific layers are omitted.

Merged rule metadata must identify file-backed sources instead of heading-backed
sections. Source identifiers surfaced in context packs, JSON, reports, or
debug output must use stable redacted identifiers such as:

```text
user-global:rules/COMMON.md
user-global:rules/SPEC.md
project-local:rules/COMMON.md
project-local:rules/SPEC.md
```

The source category model remains:

- `package built-in`
- `user-global`
- `project-local`

`context/merged-rules.md` must include only hard constraints, relevant built-in
rubrics, and the custom rule files loaded for the current document type.

### 5. User-Facing Mode And Assurance Defaults

Upstream design scope: `design/DESIGN-v3.md` sections 1, 3, 4, 5, 13, 14, and
15.

Generated routes must not treat a missing mode token as explain-only when a
target invocation is otherwise valid.

Platform defaults are:

| Route platform | Missing mode selects | Missing assurance selects |
|---|---|---|
| Codex | `review-and-fix` | `practical` |
| Claude Code | `review-and-fix` | `practical` |
| Gemini | `read-only` | `advisory` |

Generated routes must pass the selected mode explicitly to every
`drfx workflow ...` command.

Explicit user tokens override defaults:

- `read-only` forces read-only review on every platform.
- `review-and-fix` requests automatic fixes where supported.
- `assurance=practical|strict-verified|advisory` selects runtime assurance.
- `strict` and `normal` select review strictness only.

Codex and Claude Code route behavior:

- missing mode plus missing assurance is equivalent to
  `review-and-fix assurance=practical`;
- explicit `assurance=advisory` without mode selects `read-only`;
- explicit `assurance=strict-verified` without mode selects `review-and-fix`
  and then requires same-flow strict proof before strict verified state can be
  persisted;
- practical probe failure may still downgrade to advisory read-only using V2
  downgrade rules.

Gemini route behavior:

- missing mode plus missing assurance is equivalent to
  `read-only assurance=advisory`;
- explicit `review-and-fix` remains unsupported;
- Gemini must not edit target files;
- Gemini must not declare workflow `pass`.

Help-style or invalid invocations still explain usage without reading target or
reference bodies, running probes, creating state, or declaring review results.
Examples include missing target, unknown usage, and explicit help requests.

Internal workflow command parsing remains separate from user-facing route
defaults. Direct manual or test workflow calls may keep conservative internal
defaults. Generated routes must not depend on those defaults.

### 6. Review-And-Fix Write Eligibility Preflight

Upstream design scope: `design/DESIGN-v3.md` sections 1, 3, 4, 6, 13, 14, and
15.

`read-only` may review any readable target inside the resolved project root. It
does not require the target to be tracked by Git, clean, or non-ignored.

When the effective route mode is `review-and-fix`, generated Codex and Claude
Code routes must run a write eligibility preflight before:

- reviewer subagent dispatch;
- semantic document review;
- target-local workflow state creation.

A target is write-eligible only when all of these conditions are true:

- project root is inside a Git work tree;
- `HEAD` exists;
- target is tracked by Git;
- target is index-clean;
- target is worktree-clean;
- target is not deleted;
- target is not renamed;
- target is not copied;
- target is not unmerged;
- target is not unreadable;
- target-only guard passes;
- target-only guard rejects no unsafe non-target worktree changes;
- target-only guard output is available and parseable.

If a target path is ignored by Git and not tracked, it is not write-eligible.
This is a blocker for `review-and-fix`, not for `read-only`.

If write eligibility fails, the route must stop before creating target-local
state. Default output and `debug` output both remain non-persistent on this
path.

The default blocker output must be concise and actionable:

```text
Blocked: <target> cannot be auto-fixed because it is not a clean tracked Git target.

Next: commit or restore the target, or rerun with read-only.
```

Debug output may include normalized redacted guard reason metadata, such as
`rollback-unavailable`, `target-only-guard-unavailable`, or
`unexpected-worktree-change`. Debug output must not create target-local state
and must not print raw file contents or broad worktree details.

This route-level preflight is not the authoritative pre-write guard.
`workflow begin-fix` must still rerun the full rollback anchor and target-only
guard immediately before any target write.

### 7. Subagent Quality Policy

Upstream design scope: `design/DESIGN-v3.md` sections 1, 3, 4, 7, 13, 14, and
15.

Generated route text must not pin concrete model names such as `gpt-5.5`.

Generated route text may specify required quality class:

- runtime readiness probes may use lower reasoning effort;
- semantic reviewer subagents inherit coordinator model quality and reasoning
  effort by default;
- semantic fixer subagents inherit coordinator model quality and reasoning
  effort by default;
- generated routes must not downgrade semantic reviewer or fixer work below
  coordinator quality unless the user explicitly requests a low-cost or
  advisory-only run.

If a host runtime exposes only named models and no abstract quality controls,
route text must express the policy as "inherit coordinator model quality"
instead of naming a model.

### 8. Default Route Output

Upstream design scope: `design/DESIGN-v3.md` sections 1, 3, 4, 8, 13, 14, and
15.

Default route output must be concise.

Default output must not print:

- `Goal / Now / Next / Open Questions` handoff blocks;
- the 14-line final-response machine block;
- raw workflow JSON;
- runtime probe transcripts;
- reviewer prompt text;
- fixer prompt text;
- raw subagent transcripts.

Default output must include only information the user needs to act:

- terminal status in plain language;
- target path;
- files changed, if any;
- fixed issue locations, problem summaries, and change summaries when issues
  were fixed;
- unresolved issue locations, problem summaries, and suggested fixes or needed
  decisions when issues remain;
- blocker or unsupported reason when the run cannot proceed;
- state directory or receipt path only when needed for resume, audit, or
  follow-up;
- one concrete next action when blocked or unsupported.

Default `Issues:`, `Fixed:`, and `Unfixed:` lists must not expose internal
issue IDs such as `ISSUE-001`.

Every issue item in default output must be stable enough for a later user
message such as "please fix the issues" to identify the unresolved or fixed
work without relying on hidden issue IDs.

Default read-only findings use this shape:

```text
Findings: <target> has blocking issues.

Issues:
- Location: <line, heading, section, or safe anchor>
  Problem: <specific problem>
  Fix: <suggested correction>

Next: rerun with review-and-fix to apply fixes.
```

Default clean read-only output uses this shape:

```text
Clean: <target> has no blocking findings.

Verification: full-document read-only review completed.
```

Default successful review-and-fix output that changed the target uses this
shape:

```text
Pass: <target> was updated.

Fixed:
- Location: <line, heading, section, or safe anchor>
  Problem: <specific problem that was fixed>
  Change: <what changed>

Verification: <short reviewer/check summary>
```

Default successful review-and-fix output that found no blocking issues and
changed no files uses this shape:

```text
Pass: <target> has no blocking findings.

Files changed: none
Verification: <short reviewer/check summary>
```

Default partially fixed or blocked review-and-fix output uses this shape:

```text
Blocked: <one-sentence reason>.

Fixed:
- Location: <line, heading, section, or safe anchor>
  Problem: <specific problem that was fixed>
  Change: <what changed>

Unfixed:
- Location: <line, heading, section, or safe anchor>
  Problem: <specific problem that remains>
  Needed: <decision, manual input, or environmental fix required>

Next: <one concrete action>
State: <target-state-dir when persistent state exists>
```

Read-only routes must state whether findings remain and must not call a clean
read-only result `PASS`.

### 9. Debug Output

Upstream design scope: `design/DESIGN-v3.md` sections 1, 3, 4, 6, 8, 13, 14,
and 15.

Generated routes must support an optional `debug` route token.

`debug` is a route token, not a workflow mode.

When `debug` is present, generated routes may print a detailed workflow view:

- final-response machine block;
- target state directory;
- receipt paths;
- normalized blocker or status reason;
- runtime probe results;
- relevant `drfx workflow ... --json` outputs;
- report paths and internal issue IDs.

Debug output must still redact sensitive values.

Debug output must not print:

- raw target body;
- raw reference body;
- raw prompts;
- raw subagent transcripts;
- secrets;
- tokens;
- raw logs.

Debug must not change final status, effective mode, assurance, validation
behavior, or persisted state. Internal workflow commands may accept `--debug`
only for CLI diagnostics.

### 10. Final Response And Concise Rendering

Upstream design scope: `design/DESIGN-v3.md` sections 8, 13, 14, and 15.

The internal final-response machine block still exists.

Generated routes must:

- build the internal final-response machine block;
- pass it to `drfx workflow finalize --final-response-stdin`;
- wait for validation;
- render default concise output from the validated result, manifest, ledger,
  and latest report paths.

Default output rendering must not bypass final-response validation.

Debug output may surface the validated machine block and audit details after
finalization, subject to redaction and raw-content restrictions.

### 11. Documentation And Generated Text

Upstream design scope: `design/DESIGN-v3.md` sections 1, 3, 4, 5, 7, 8, 9, 10,
11, 13, 14, and 15.

Public docs, source skills, shared route content, and generated route templates
must describe the V3 behavior.

They must remove or replace statements that describe legacy `RULE.md` as a
supported configuration interface.

They must describe:

- the `rules/*.md` layout;
- document-type-scoped content reads;
- stale `RULE.md` blocking behavior;
- unknown Markdown rule filename blocking behavior;
- Codex and Claude Code default mode and assurance;
- Gemini default mode and assurance;
- explicit token override behavior;
- `review-and-fix` write eligibility preflight;
- concise default output;
- `debug` output;
- subagent quality policy without concrete model names.

README examples must no longer teach users that a mode token is required for a
valid target invocation on Codex or Claude Code generated routes.

Help-style examples may still demonstrate explicit modes.

### 12. Implementation Context

Upstream design scope: `design/DESIGN-v3.md` sections 13 and 14.

The implementation is expected to update these existing areas:

- `lib/rulebook.js` for file-based loading, filename validation, hard-constraint
  conflict validation, merge order, and file-backed source metadata;
- `lib/workflow.js` for workflow rule loading, start-time validation, no-state
  behavior, and final rendering support where applicable;
- `lib/check.js` for reporting V3 rule locations and stale `RULE.md` state;
- `lib/target-state.js` so `.docs-review-fix/rules/` is project configuration
  while `.docs-review-fix/targets/` remains target state;
- generated route templates for mode defaults, write eligibility preflight,
  debug output, concise output rendering, and subagent quality text;
- source skills under `skills/review-fix-*`;
- shared prompts and route guidance under `shared/`;
- README examples and configuration documentation;
- tests under `test/`.

This implementation context does not authorize behavior outside this Spec. If
an implementation detail conflicts with the requirements above, the requirement
wins.

## Acceptance Criteria

### Rule Files

- `SPEC` reviews load user/project `COMMON.md` and `SPEC.md`, and do not read
  `PLAN.md` or `DESIGN.md` contents.
- `PLAN` reviews load user/project `COMMON.md` and `PLAN.md`, and do not read
  `SPEC.md` or `DESIGN.md` contents.
- `DESIGN` reviews load user/project `COMMON.md` and `DESIGN.md`, and do not
  read `SPEC.md` or `PLAN.md` contents.
- `COMMON` reviews load only user/project `COMMON.md`.
- Merge order remains equivalent to V2's seven-layer model.
- Existing hard-constraint weakening rules are still rejected.
- Legacy `RULE.md` blocks before persistent target state is written.
- Unknown Markdown filenames under rules directories are rejected.
- Non-Markdown files under rules directories are ignored unless package-owned
  metadata is explicitly implemented.
- Project-root `.docs-review-fix/rules/` is not treated as a target state
  directory.
- `context/merged-rules.md` contains only the relevant loaded custom rule
  files.

### Mode Defaults

- Generated Codex skill defaults missing mode to `review-and-fix` and missing
  assurance to `practical`.
- Generated Claude Code command defaults missing mode to `review-and-fix` and
  missing assurance to `practical`.
- Generated Gemini command defaults missing mode to `read-only` and missing
  assurance to `advisory`.
- Generated routes pass selected mode explicitly to every `drfx workflow ...`
  command.
- Missing mode is not treated as explain-only when a valid target is present.
- Help-style or invalid invocations still explain usage without reading targets,
  running probes, creating state, or declaring review results.
- Codex and Claude Code `assurance=advisory` without mode selects `read-only`.
- Gemini explicit `review-and-fix` remains unsupported and does not edit target
  files.

### Write Eligibility Preflight

- `read-only` can run against readable untracked or ignored targets without Git
  write eligibility.
- `review-and-fix` stops before semantic reviewer dispatch and before target
  state creation when the target lacks Git `HEAD`.
- `review-and-fix` stops before semantic reviewer dispatch and before target
  state creation when the target is untracked, staged, dirty, ignored, deleted,
  renamed, copied, unmerged, or unreadable.
- `review-and-fix` stops before semantic reviewer dispatch and before target
  state creation when unsafe non-target worktree changes are present.
- `review-and-fix` stops before semantic reviewer dispatch and before target
  state creation when target-only guard output is unavailable or unparseable.
- Route-level write eligibility preflight does not replace `begin-fix`.
- Tests prove `begin-fix` still blocks if the target becomes ineligible after
  route-level preflight.

### Output And Debug

- Default generated-route output does not print the final-response machine
  block.
- Default generated-route output does not print handoff summary blocks.
- Default generated-route output does not print raw workflow JSON.
- Default generated-route output does not print probe transcripts, prompt text,
  or raw subagent transcripts.
- Default read-only findings output includes concrete `Location`, `Problem`,
  and `Fix` fields for each finding.
- Default fixed output includes concrete `Location`, `Problem`, and `Change`
  fields for each repaired issue.
- Default blocked output includes blocker reason, unresolved
  `Location` / `Problem` / `Needed` items when issues exist, one next action,
  and state path only when persistent state exists.
- Default `Issues:`, `Fixed:`, and `Unfixed:` lists do not expose internal
  issue IDs.
- `debug` route output includes final-response machine block and workflow audit
  details when available.
- `debug` output preserves redaction and raw-transcript restrictions.
- `debug` does not change final status, mode, assurance, validation, or
  persistence behavior.

### Subagent Quality

- Generated route text does not pin concrete model names for reviewer or fixer
  subagents.
- Generated route text allows lower-effort runtime readiness probes.
- Generated route text requires coordinator-quality semantic reviewer and fixer
  work by default.
- Generated route text states that semantic work may be lower than coordinator
  quality only when the user explicitly requests low-cost or advisory-only
  behavior.

### Documentation

- README no longer describes legacy `RULE.md` as a supported configuration
  interface.
- README documents `rules/*.md` layout and stale `RULE.md` blocking behavior.
- Generated route text no longer describes legacy `RULE.md` as supported.
- Source skills no longer describe old "missing mode means explain only"
  behavior as the normal valid-target path for Codex and Claude Code.
- Public docs state Gemini remains advisory-only.

## Required Verification

Implementation is not complete until this check passes:

```bash
npm test
```

Tests must include focused coverage for:

- file-based custom rule loading;
- stale and misspelled rule validation;
- hard-constraint conflict preservation;
- source metadata identifiers;
- target-state detection for `.docs-review-fix/rules/`;
- route mode and assurance defaults;
- explicit token override behavior;
- Gemini advisory-only behavior;
- write eligibility preflight failure cases;
- `begin-fix` continuing to enforce authoritative pre-write guards;
- concise default output rendering;
- `debug` output rendering and redaction;
- README, generated route text, source skill, and shared prompt text updates.

## Traceability Matrix

| Design sections | Spec coverage |
|---|---|
| 1 Scope | Goal, Scope, Non-Scope, all requirements |
| 2 Problem | Requirements 1, 2, 5, 8 |
| 3 Goals | All requirements and acceptance criteria |
| 4 Non-goals | Non-Scope, Requirements 5, 6, 7, 9 |
| 5 User-Facing Mode Defaults | Requirement 5, mode default acceptance criteria |
| 6 Review-And-Fix Write Eligibility Preflight | Requirement 6, write preflight acceptance criteria |
| 7 Subagent Quality Policy | Requirement 7, subagent quality acceptance criteria |
| 8 Route Output And Debug Mode | Requirements 8, 9, 10, output acceptance criteria |
| 9 New Configuration Layout | Requirements 1, 11 |
| 10 Rule Loading Contract | Requirement 2 |
| 11 Validation Contract | Requirement 3 |
| 12 Source Metadata | Requirement 4 |
| 13 Implementation Impact | Requirement 12 |
| 14 Test Requirements | Acceptance Criteria, Required Verification |
| 15 Acceptance Criteria | Acceptance Criteria, Required Verification |

## Open Questions

None. This Spec intentionally defers future persistent `audit` or
`debug-persist` behavior because `design/DESIGN-v3.md` marks it as future work
that must define its own token and receipt path before implementation.
