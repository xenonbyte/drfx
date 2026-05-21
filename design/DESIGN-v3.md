# Document Review Loop Design v3

## 1. Scope

V3 supersedes two parts of `design/DESIGN-v2.md`:

- custom rulebook configuration
- user-facing route mode defaults
- subagent model quality policy
- concise default route output with explicit debug mode
- review-and-fix write eligibility preflight

All workflow, state, capability, review, triage, fix, diff-review, full
re-review, resume, receipt, and final-response design from V2 remains in force
unless this document explicitly replaces it.

The changes are intentionally breaking. The package is still in development and
has one active operator, so there is no compatibility requirement for the old
single-file `RULE.md` interface or the old "missing mode means explain only"
route behavior.

## 2. Problem

V2 uses these optional rulebook files:

```text
~/.docs-review-fix/RULE.md
.docs-review-fix/RULE.md
```

Each file contains multiple second-level headings:

```markdown
## COMMON
## SPEC
## PLAN
## DESIGN
```

This format works, but it creates two avoidable problems:

- The runtime must read and parse the whole rulebook even when the current
  review only needs `COMMON` plus one document type.
- The authoring surface does not match the mental model. `SPEC`, `PLAN`,
  `DESIGN`, and `COMMON` are independent rule sets, but they are edited inside
  one file.

The V3 design changes the storage model from one multi-section file to one file
per rule section.

V2 also requires user-facing generated routes to receive `read-only` or
`review-and-fix` before they start the workflow. Missing mode falls back to an
explain-only response. That made the first release conservative, but it makes
the main skill path noisy. The route name already says `review-fix-*`, and
automatic writes are protected later by runtime probes, fingerprint guards,
git rollback checks, target-only guards, locks, diff review, and full
re-review.

V3 changes the user-facing default: Codex and Claude Code routes default to
`review-and-fix`; Gemini defaults to `read-only` advisory review because Gemini
is advisory-only in this design.

V2 also exposes too much workflow machinery in normal route output. A blocked
or completed run may print the handoff summary plus the full final-response
machine block. Those details are useful for debugging and audit trails, but they
make the default skill result hard to scan.

## 3. Goals

- Manage custom rules as separate files by document type.
- Read only the rule files needed for the current document type.
- Keep the existing rule precedence model.
- Preserve hard-constraint conflict detection.
- Fail loudly on stale or misspelled rule configuration instead of silently
  ignoring it.
- Keep project-local rules separate from target-local workflow state.
- Let Codex and Claude Code users omit the mode token for the normal
  `review-and-fix` path.
- Keep Gemini safe by defaulting missing mode to `read-only` with advisory
  assurance.
- Make normal generated-route output short and user-focused.
- Keep full workflow details available through an explicit `debug` token.
- Fail early when `review-and-fix` cannot write safely because the target is
  not a clean tracked Git file.

## 4. Non-goals

- No automatic migration from `RULE.md`.
- No support for legacy `RULE.md` as a fallback.
- No new runtime dependency.
- No change to built-in rubric files under `shared/rubrics/`.
- No change to the document review-fix loop itself.
- No automatic target writes in Gemini.
- No change that lets internal `drfx workflow ...` commands write targets
  without the generated route first selecting and passing a mode.
- No binding to a concrete model name, provider model version, or deployment
  alias.
- No removal of machine validation, receipts, manifests, ledgers, reports, or
  target-local audit state.
- No Git requirement for one-shot `read-only` review.

## 5. User-Facing Mode Defaults

Generated routes no longer treat a missing mode token as explain-only.

Platform defaults:

| Route platform | Missing mode selects | Missing assurance selects |
|---|---|---|
| Codex | `review-and-fix` | `practical` |
| Claude Code | `review-and-fix` | `practical` |
| Gemini | `read-only` | `advisory` |

Explicit user tokens still win:

- `read-only` forces read-only review on every platform.
- `review-and-fix` requests automatic fixes where the platform supports them.
- `assurance=practical|strict-verified|advisory` still selects runtime
  assurance and must remain separate from `strict|normal` review strictness.

Codex and Claude Code behavior:

- `review-fix-spec target=docs/spec.md` is equivalent to
  `review-fix-spec target=docs/spec.md review-and-fix assurance=practical`.
- The route must run the existing Practical Mode probes before starting the
  persistent review-fix loop.
- If the Practical probes fail in a way that allows advisory downgrade, the
  route normalizes effective mode to `read-only` and records the downgrade
  reason, matching V2.
- If the user explicitly requests `assurance=advisory` without a mode token,
  the route selects `read-only`; advisory assurance cannot write targets.
- If the user explicitly requests `assurance=strict-verified` without a mode
  token, the route selects `review-and-fix` on Codex and Claude Code, then
  requires same-flow strict proof before any strict verified state is persisted.

Gemini behavior:

- `review-fix-spec target=docs/spec.md` is equivalent to
  `review-fix-spec target=docs/spec.md read-only assurance=advisory`.
- `review-and-fix` remains unsupported on Gemini and must not edit targets.
- Gemini may still return `unsupported-runtime-capability` for explicit
  `review-and-fix`, but missing mode must not choose that path.

Internal command boundary:

- Generated routes must pass the selected mode explicitly into
  `drfx workflow ...` commands.
- Internal workflow commands still accept only `read-only` and
  `review-and-fix`. They do not gain an `explain` mode.
- Direct manual/test workflow calls may keep their conservative default, but
  generated routes must not depend on that default.

Explain-only behavior remains available only for help-style invocations, such
as missing target, unknown usage, or an explicit help request. Missing mode is
no longer a help request.

## 6. Review-And-Fix Write Eligibility Preflight

`read-only` may review any readable target inside the resolved project root. It
does not require the target to be tracked by Git.

`review-and-fix` may also read any valid target, but automatic target writes
require a write-eligible target. Generated Codex and Claude Code routes must run
a write eligibility preflight before full semantic review when the effective
mode is `review-and-fix`.

A target is write-eligible only when all of these are true:

- the project root is inside a Git work tree
- `HEAD` exists
- the target is tracked by Git
- the target is index-clean and worktree-clean
- the target is not deleted, renamed, copied, unmerged, or unreadable
- the target-only guard can run and parse Git status

If write eligibility fails, the route must stop before reviewer dispatch, before
semantic document review, and before creating target-local workflow state unless
an explicit audit/debug path requires a preflight receipt. The default output
must be concise:

```text
Blocked: <target> cannot be auto-fixed because it is not a clean tracked Git target.

Next: commit or restore the target, or rerun with read-only.
```

Debug output may include the normalized guard reason, such as
`rollback-unavailable`, and redacted status metadata. It must not print raw file
contents or broad worktree details.

The preflight is only a user-experience shortcut. `begin-fix` must still rerun
the full rollback anchor and target-only guard immediately before any target
write, because the worktree can change after the route-level preflight.

## 7. Subagent Quality Policy

Generated routes must not pin a concrete model name such as `gpt-5.5`.
They may specify the required quality class for subagent work.

Quality rules:

- Runtime readiness probes may use a low reasoning effort because they only
  prove that subagent dispatch works and return `DRFX_REVIEWER_READY`.
- Actual reviewer subagents must use the coordinator's model quality and
  reasoning effort by default.
- Actual fixer subagents, when used, must use the coordinator's model quality
  and reasoning effort by default.
- Generated routes must not downgrade semantic reviewer or fixer work below the
  coordinator's quality unless the user explicitly requests a low-cost or
  advisory-only run.
- If the host runtime exposes only named models and not abstract quality
  controls, the route should express the policy as "inherit coordinator model
  quality" rather than naming a model.

The observable distinction is intentional:

```text
readiness probe      -> lower effort allowed
semantic reviewer    -> coordinator-quality required
semantic fixer       -> coordinator-quality required
```

This keeps cheap probes cheap while preserving review quality for the decisions
that can block PASS or approve target edits.

## 8. Route Output And Debug Mode

Generated routes support an optional `debug` token.

Default output is concise. It must not print:

- `Goal / Now / Next / Open Questions` handoff blocks
- the 14-line final-response machine block
- raw workflow JSON
- runtime probe transcripts
- reviewer or fixer prompt text
- raw subagent transcripts

Default output must include only what the user needs to act:

- terminal status in plain language
- target path
- files changed, if any
- fixed issue locations, problem summaries, and change summaries, if any issues
  were fixed
- unresolved issue locations, problem summaries, and suggested fixes or needed
  decisions, if any issues remain
- blocker or unsupported reason, when the run cannot proceed
- state directory or receipt path only when needed for resume, audit, or
  follow-up
- one concrete next action when blocked or unsupported

Default output must not expose internal issue IDs such as `ISSUE-001` in
`Issues:`, `Fixed:`, or `Unfixed:` lists. Those IDs remain available in debug
output, ledgers, reports, receipts, and persisted state.

Each issue item in default output must be stable enough for a later user message
such as "please fix the issues" to be actionable. Use these field names:

- `Location`: line, heading, section, or safe anchor.
- `Problem`: the issue in one sentence.
- `Fix`: suggested correction for read-only findings.
- `Change`: what was changed for fixed findings.
- `Needed`: decision or manual input required for unresolved findings.

For read-only findings, use this shape:

```text
Findings: <target> has blocking issues.

Issues:
- Location: <line, heading, section, or safe anchor>
  Problem: <specific problem>
  Fix: <suggested correction>

Next: rerun with review-and-fix to apply fixes.
```

For clean read-only runs, use this shape:

```text
Clean: <target> has no blocking findings.

Verification: full-document read-only review completed.
```

For a successful review-and-fix run, the route should use this shape:

```text
Pass: <target> was updated.

Fixed:
- Location: <line, heading, section, or safe anchor>
  Problem: <specific problem that was fixed>
  Change: <what changed>

Verification: <short reviewer/check summary>
```

For a partially fixed or blocked review-and-fix run, the route should use this
shape:

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

For read-only runs, the route should state whether findings remain and should
not call a clean result `PASS`.

The internal final-response machine block still exists. Generated routes must
build it and pass it to `drfx workflow finalize --final-response-stdin` for
validation. After finalization, the route renders the concise user output from
the validated result, manifest, ledger, and latest report paths.

When `debug` is present, generated routes may print the detailed workflow view:

- the final-response machine block
- target state directory
- receipt paths
- normalized blocker/status reason
- runtime probe results
- relevant `drfx workflow ... --json` outputs
- report paths and issue IDs

Debug output must still redact sensitive values and must not print raw target
body, reference body, raw prompts, raw subagent transcripts, secrets, tokens, or
raw logs.

`debug` is a route token, not a workflow mode. Internal workflow commands may
accept `--debug` only for CLI diagnostics, but final status and persisted state
must not depend on debug being enabled.

## 9. New Configuration Layout

User-global rules:

```text
~/.docs-review-fix/rules/COMMON.md
~/.docs-review-fix/rules/SPEC.md
~/.docs-review-fix/rules/PLAN.md
~/.docs-review-fix/rules/DESIGN.md
```

Project-local rules:

```text
.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/SPEC.md
.docs-review-fix/rules/PLAN.md
.docs-review-fix/rules/DESIGN.md
```

`.docs-review-fix/rules/` is shared project configuration. It is not target
state. Persistent workflow state remains under:

```text
.docs-review-fix/targets/<target-key>/
```

## 10. Rule Loading Contract

The loader receives a resolved `documentType` of `COMMON`, `SPEC`, `PLAN`, or
`DESIGN`.

For `COMMON`, it reads at most:

```text
~/.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/COMMON.md
```

For `SPEC`, it reads at most:

```text
~/.docs-review-fix/rules/COMMON.md
~/.docs-review-fix/rules/SPEC.md
.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/SPEC.md
```

`PLAN` and `DESIGN` follow the same pattern. A `SPEC` review must not read
`PLAN.md` or `DESIGN.md`; a `PLAN` review must not read `SPEC.md` or
`DESIGN.md`; a `DESIGN` review must not read `SPEC.md` or `PLAN.md`.

The merge order remains:

1. workflow hard constraints
2. built-in COMMON rubric
3. built-in document-type rubric
4. user-global `COMMON.md`
5. user-global document-type rule file
6. project-local `COMMON.md`
7. project-local document-type rule file

For `COMMON` documents, document-type-specific layers are omitted, matching V2
behavior.

## 11. Validation Contract

Allowed custom rule filenames are exactly:

```text
COMMON.md
SPEC.md
PLAN.md
DESIGN.md
```

The loader may inspect directory entries under `rules/` to catch typos, but it
must only read file contents for the current document type and `COMMON`.

Validation rules:

- A legacy `RULE.md` at `~/.docs-review-fix/RULE.md` or
  `.docs-review-fix/RULE.md` is stale configuration. Workflow start must stop
  with `Status: blocked` plus `Blocking reason: state-validation-failed` before
  writing target state. It must not read or merge the stale file.
- Unknown Markdown files under `rules/`, such as `Spec.md`, `SPEC-RULE.md`, or
  `REQUIREMENTS.md`, are configuration errors.
- Non-Markdown files under `rules/` are ignored unless they are used by the
  implementation as package-owned metadata. V3 does not require such metadata.
- Custom rule file contents are plain Markdown fragments. They no longer need
  a wrapping `## SPEC` or `## DESIGN` heading.
- If a custom rule file contains text that weakens workflow hard constraints,
  the run stops with the same hard-constraint conflict behavior as V2.
- Empty or missing rule files are treated as absent.

## 12. Source Metadata

Merged rule metadata must identify file-backed sources instead of heading-backed
sections.

Source identifiers should be stable and redacted when surfaced in context packs
or JSON output:

```text
user-global:rules/COMMON.md
user-global:rules/SPEC.md
project-local:rules/COMMON.md
project-local:rules/SPEC.md
```

The existing source category model still applies:

- `package built-in`
- `user-global`
- `project-local`

`context/merged-rules.md` remains a generated snapshot of the merged rule set.
It must include only the hard constraints, built-in relevant rubrics, and the
custom rule files loaded for the current document type.

## 13. Implementation Impact

Expected code changes:

- Replace multi-heading `parseRulebook(text)` usage with file-based rule
  loading.
- Keep `CANONICAL_SECTIONS` or replace it with a canonical document-type list
  used for filename validation.
- Keep `mergeRules` semantics and seven-layer ordering.
- Update `lib/workflow.js` rule loading to read `rules/COMMON.md` plus the
  current type file from user-global and project-local roots.
- Update `lib/check.js` to report the new rule file locations and warn/block on
  stale `RULE.md`.
- Update `lib/target-state.js` state-root detection so `.docs-review-fix/rules/`
  counts as project configuration, while `.docs-review-fix/targets/` remains
  target state.
- Update generated prompts and shared docs so routes instruct agents to read
  only relevant rule files.
- Update README examples and tests to remove the legacy `RULE.md` contract.
- Update generated route templates and source skills so missing mode defaults
  to platform-specific behavior instead of explain-only.
- Update route logic so Codex/Claude Code pass `review-and-fix` plus
  `--assurance practical` by default, while Gemini passes `read-only` plus
  `--assurance advisory` by default.
- Keep internal workflow command parsing separate from user-facing route
  defaults.
- Update generated route text so readiness probes may use low effort, while
  reviewer and fixer subagents inherit coordinator model quality and reasoning
  effort by default.
- Add `debug` as a supported route token.
- Update generated routes to render concise default output from validated
  workflow results and reserve machine blocks, JSON, receipt details, and probe
  details for debug output.
- Update concise output rendering so `Issues:`, `Fixed:`, and `Unfixed:` use
  `Location` / `Problem` / `Fix` / `Change` / `Needed` fields and do not expose
  internal issue IDs by default.
- Add a route-level `review-and-fix` write eligibility preflight that reuses the
  same Git rollback/target-only checks as `begin-fix` where possible, but runs
  before semantic review and state creation.
- Keep `begin-fix` as the authoritative pre-write guard even when route-level
  preflight passed earlier.

## 14. Test Requirements

Required tests:

- `SPEC` loads user/project `COMMON.md` and `SPEC.md`, and does not read
  `PLAN.md` or `DESIGN.md`.
- `PLAN` loads user/project `COMMON.md` and `PLAN.md`, and does not read
  `SPEC.md` or `DESIGN.md`.
- `DESIGN` loads user/project `COMMON.md` and `DESIGN.md`, and does not read
  `SPEC.md` or `PLAN.md`.
- `COMMON` loads only user/project `COMMON.md`.
- Merge order remains equivalent to V2.
- Existing hard-constraint weakening rules are still rejected.
- Stale `RULE.md` blocks before persistent target state is written.
- Unknown Markdown filenames under `rules/` are rejected.
- Project-root `.docs-review-fix/rules/` is not treated as a target state
  directory.
- `context/merged-rules.md` contains only the loaded relevant custom files.
- README and generated route text no longer mention legacy `RULE.md` as a
  supported configuration interface.
- Generated Codex skill defaults missing mode to `review-and-fix` and missing
  assurance to `practical`.
- Generated Claude Code command defaults missing mode to `review-and-fix` and
  missing assurance to `practical`.
- Generated Gemini command defaults missing mode to `read-only` and missing
  assurance to `advisory`.
- Generated routes pass the selected mode explicitly to every
  `drfx workflow ...` command.
- Missing mode is not treated as explain-only when a target is present.
- Help-style or invalid invocations still explain usage without reading targets,
  running probes, creating state, or declaring review results.
- Codex/Claude Code `assurance=advisory` without mode selects `read-only`.
- Gemini explicit `review-and-fix` remains unsupported and does not edit
  targets.
- Generated route text does not pin concrete model names for reviewer or fixer
  subagents.
- Generated route text allows lower-effort runtime probes but requires
  coordinator-quality semantic reviewer and fixer work.
- Default generated-route output instructions reject printing the final-response
  machine block and handoff summary blocks.
- Default read-only findings output includes concrete `Location`, `Problem`,
  and `Fix` fields for each finding.
- Default fixed output includes concrete `Location`, `Problem`, and `Change`
  fields for each repaired issue.
- Default blocked output includes the blocker reason, unresolved
  `Location` / `Problem` / `Needed` items, one next action, and state path when
  persistent state exists.
- Default `Issues:`, `Fixed:`, and `Unfixed:` lists do not expose internal
  issue IDs.
- `debug` route output includes the final-response machine block and workflow
  audit details while preserving redaction and raw-transcript restrictions.
- `read-only` can run against readable untracked or ignored targets without Git
  write eligibility.
- `review-and-fix` stops before semantic reviewer dispatch and before target
  state creation when the target lacks Git `HEAD`, is untracked, staged, dirty,
  ignored, deleted, renamed, copied, unmerged, unreadable, or when the
  target-only guard is unavailable.
- Route-level write eligibility preflight does not replace `begin-fix`; tests
  still prove `begin-fix` blocks if the target becomes ineligible after the
  preflight.

## 15. Acceptance Criteria

V3 is complete when:

- The only supported custom rule interface is `rules/*.md`.
- Runtime loading is document-type scoped and does not read unrelated rule file
  contents.
- Legacy `RULE.md` is rejected as stale config, not read as a fallback.
- Codex and Claude Code user-facing routes default to `review-and-fix
  assurance=practical` when mode and assurance are omitted.
- Gemini user-facing routes default to `read-only assurance=advisory` when mode
  and assurance are omitted.
- Explicit `read-only`, `review-and-fix`, and `assurance=` tokens override the
  platform defaults according to the rules above.
- Runtime probes may be lower effort, but actual reviewer and fixer subagents
  inherit coordinator model quality by default without naming a concrete model.
- Default route output is concise, while `debug` exposes the detailed workflow
  block and audit paths.
- Default issue output is stable enough for a later "please fix the issues"
  request to identify unresolved work without relying on hidden issue IDs.
- `review-and-fix` fails early with a concise blocker when automatic writes are
  impossible, while `read-only` remains available for readable non-Git targets.
- All public docs and generated instructions describe the new layout.
- The test suite proves stale config, typo detection, merge order, scoped reads,
  hard-constraint validation, platform-specific mode defaults, Gemini's
  advisory-only default, subagent quality-policy text, and concise output/debug
  behavior, and write eligibility preflight behavior.
