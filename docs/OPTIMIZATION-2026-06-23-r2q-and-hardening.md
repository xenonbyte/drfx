# OPTIMIZATION 2026-06-23 — r2q route, doc rubric & review-loop, atomic-copy & strict-verified hardening

Status: **approved design** (think output). Implementation starts only when requested.

This document covers four work items reviewed against the current code on branch `optimize`
(package `0.7.1`):

| # | Item | Verdict | Size |
|---|------|---------|------|
| 1 | `atomicCopyFile()` target preflight + mode preservation (P2) | Real gap (code + doc) | Small |
| 2 | strict-verified doc over-promise (P3) | Real but mis-scoped (doc-only) | Tiny |
| 3 | Doc rubric enhancements: 3a PLAN TDD/acceptance; 3b no-unresolved-ambiguity (common.md + fixer.md + coordinator.md, with no-interrupt loop) | Real gaps | Small |
| 4 | `review-fix-r2q` requirement-review route | Real new feature | Large |

## Guiding principles (apply to every item)

1. **Hard cutover, no legacy/back-compat shims.** No old-version or old-data compatibility layers.
2. **No over-engineering, no over-defense.** Prefer the smallest change that makes the contract true.
   Reject defensive code that adds fragility without a present requirement.

---

## Item 1 — `atomicCopyFile()` target preflight + mode preservation (P2)

### Finding (confirmed real)

`lib/atomic-write.js`:

- `atomicWriteFile()` (lines 25–54) does a target preflight: `lstatSync` → refuse non-regular
  targets with `ERR_ATOMIC_WRITE_TARGET_KIND`, and captures `existingMode` to re-apply after the
  temp write.
- `atomicCopyFile()` (lines 60–76) does **neither**: it `mkdir`s the parent, `copyFileSync(..., COPYFILE_EXCL)`
  to a temp, then renames. No non-regular refusal, no destination-mode preservation.

`atomicCopyFile()` has two production callers, both in `lib/snapshot-guard.js`:

- line 279 — `atomicCopyFile(targetPath, absolutePath)`: capture worktree file → internal snapshot store.
- line 636 — `atomicCopyFile(absolutePath, absoluteTarget)`: **restore** snapshot → worktree target (rollback).

The `0.7.1` CHANGELOG explicitly claims that *"Every atomic write — … snapshot rollback bodies … —
now flows through one shared helper that refuses to clobber non-regular targets and preserves
existing file permissions."* Snapshot rollback bodies flow through `atomicCopyFile()`, which does
neither. So this is **both a code gap and a doc-accuracy gap**.

### Fix (small, not over-defensive)

Extract a shared preflight in `lib/atomic-write.js` and call it from both functions:

```js
function existingRegularTargetMode(targetPath) {
  try {
    const stats = fs.lstatSync(targetPath);
    if (!stats.isFile()) {
      const error = new Error(`refusing to atomically replace non-regular file: ${targetPath}`);
      error.code = 'ERR_ATOMIC_WRITE_TARGET_KIND';
      throw error;
    }
    return stats.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}
```

- `atomicWriteFile()`: replace its inline lstat block (lines 28–39) with `existingMode = existingRegularTargetMode(targetPath)`.
- `atomicCopyFile()`: call `existingRegularTargetMode(targetPath)` before the copy; after `copyFileSync`
  to temp, `if (existingMode !== null) fs.chmodSync(tempPath, existingMode)`, then rename.

**Mode semantics (deliberate decision).** `copyFileSync` already copies the *source*'s mode onto the
temp. The added `chmod` only fires when the destination already exists, overriding source mode with
the destination's current bits — matching `atomicWriteFile()`'s "preserve the target's existing
permissions" contract. For the rollback caller (636) the destination is the live worktree file, so we
preserve the file's current perms while restoring its content; for the capture caller (279) the
destination normally does not pre-exist (`null` → source mode kept). This is the intended behavior, not
an accident — recorded here because "preserve destination mode" vs "preserve source mode" is a real
choice for a copy.

### Tests (add to `test/atomic-write.test.js`)

- `atomicCopyFile refuses to replace a symlink target` (skip on win32) — assert throws `/non-regular/`,
  symlink intact, no temp sibling.
- `atomicCopyFile refuses to replace a directory target` — assert throws `/non-regular/`, dir intact.
- `atomicCopyFile preserves existing destination mode` (skip on win32) — pre-create dest `0o600`, copy,
  assert dest mode still `0o600`.

### Docs

Do **not** rewrite the released `0.7.1` entry. Add a `### Fixed` line under the next release noting that
`atomicCopyFile` now shares the non-regular-target refusal and destination-mode preservation, making the
"every atomic write" claim true for snapshot rollback bodies as well.

---

## Item 2 — strict-verified doc over-promise (P3)

### Finding (confirmed real, but **not** opencode-specific)

`lib/adapters/opencode.js`, `lib/adapters/claude.js`, and `lib/adapters/codex.js` are **byte-for-byte
identical**: all three return `status: 'unverified'` for both `can_spawn_isolated_reviewer` and
`reviewer_write_blocked`. `validateCurrentDescriptor(..., requireVerified: true)` (consumed by
`lib/check.js:82`, i.e. `drfx doctor`) only reports `trusted`/`passCapable` when **all** capabilities are
verified (`lib/capability.js:339–380`). Therefore:

> strict-verified PASS is currently **unreachable on every fix-capable platform** (Claude, Codex, opencode),
> not just opencode.

The original P3 framing ("opencode is over-promised") would, if applied only to opencode, create a false
asymmetry against Claude/Codex whose code is identical.

The **live README is already accurate**: line 164 says `assurance=strict-verified` *requires* same-flow
`drfx doctor … --json` proof — it states a requirement, not an achievement. The only loose wording is in
the released **CHANGELOG v0.6.0** entry ("opencode … passes the practical and strict-verified runtime
trust gates, supports strict-verified capability descriptors").

### Fix (doc-only, uniform, no history rewrite)

Add one clarifying sentence to `README.md` (near the assurance section, ~lines 163–165), mirror it in
`README.zh-CN.md`, and record the operator-facing constraint in `AGENTS.md`:

> `assurance=strict-verified` requires a verified `drfx doctor` capability proof. No adapter currently
> emits verified reviewer-isolation or write-blocking proof, so strict-verified PASS is presently
> unreachable on all platforms (Claude, Codex, and opencode alike); `assurance=practical` is the supported
> automatic-fix path. strict-verified remains wired end-to-end and will activate unchanged once an adapter
> can supply verified proof.

Do not edit the historical CHANGELOG v0.6.0 entry. No code change.

---

## Item 3 — Document rubric & review-loop enhancements

Two changes under `shared/`: **3a** strengthens the PLAN rubric (per-task TDD + acceptance — `plan.md`
only). **3b** is the no-unresolved-ambiguity behavior, delivered as three coordinated edits with **different
route scope**: the reviewer rule in `common.md` reaches **document routes only** (COMMON is not layered for
PR/CODE), while the surface-and-defer behavior in `fixer.md` + `coordinator.md` are **shared prompts → all
routes** (intentional; harmless and beneficial for code routes too — fixers should surface, not guess, on
every route).

### 3a — PLAN: per-task TDD + acceptance checks

#### Finding (confirmed partial gap)

`shared/rubrics/plan.md` line 11 already lists *"Verification: each meaningful change has tests, type
checks, builds, smoke checks, inspection criteria, or acceptance checks."* — but it is a soft `OR` with no
explicit, per-task **test strategy** check and no standalone **acceptance criteria** check. The user wants
both checked per task, with a narrow exemption for genuinely non-behavioral tasks (copy/doc/config).

#### Fix (strengthen rubric; keep an explicit escape hatch to avoid over-rigidity)

In `shared/rubrics/plan.md`, replace the single "Verification" bullet with two sharper bullets and extend
the blocking list:

- **Test strategy:** every implementation task that produces verifiable behavior names a concrete test
  approach (test-first / TDD where practical) — unit, integration, or e2e — sufficient to prove the task.
  Tasks that produce no verifiable behavior (copy edits, doc-only, config-only, asset moves) are explicitly
  exempt and should say why.
- **Acceptance criteria:** every material task states observable acceptance / done criteria (a clear
  pass/fail), except the non-behavioral tasks above.

Add to the **Blocking findings** sentence: *"…, and a task that produces verifiable behavior with no named
test strategy or no acceptance criteria (trivial non-behavioral tasks exempt)."*

**Decision (per user):** missing test strategy or acceptance on a behavioral task is **blocking** — this is
consistent with the rubric already treating "unverifiable steps" as blocking. The explicit non-behavioral
exemption is the guard against over-rigid false positives (principle 2).

### 3b — No unresolved ambiguity or uncertainty (rule + surface-and-defer loop)

#### Finding (confirmed gap)

No document rubric has an explicit, first-class "no ambiguous or uncertain points" rule. The closest
existing items are **narrower**: COMMON blocks only *"ambiguity that affects execution or acceptance"* and
*"unresolved questions that block use"* (`common.md:38`), requires assumptions be marked `UNCONFIRMED`
(`:28`), and forbids placeholders (`:33`); SPEC blocks *"vague requirements"*; PLAN blocks *"unresolved
architecture or product decisions embedded in execution steps"*; DESIGN blocks *"unresolved state or boundary
decisions"*. None states the general rule.

#### Constraint conflict (named, resolved — not silently overridden)

The user's literal ask ("no ambiguous or uncertain points") conflicts with the user's own global rules
(`~/.claude/CLAUDE.md`: *"Mark unknowns `UNCONFIRMED` instead of guessing"*, *"Prefer progress with explicit
assumptions over blocking on minor ambiguity"*) and with the existing rubric philosophy (marking
`UNCONFIRMED` is allowed). A literal "zero uncertainty" rule would force documents to fake certainty —
worse, and over-rigid (principle 2). **Resolution:** forbid *silent / unresolved* ambiguity and uncertainty;
genuine residual uncertainty is allowed **only when explicitly surfaced** (a decision to make, an
`UNCONFIRMED` mark, or an accepted assumption/risk). The escape valve is honest surfacing, not hidden
certainty.

#### Fix — three coordinated edits (so the rule converges instead of stalling)

The rubric rule alone (reviewer side) only generates more blocking findings; without matching fixer/
coordinator behavior the auto loop would grind unfixable human-decision points to the round/convergence cap.
Apply all three together:

1. **`shared/rubrics/common.md`** (reviewer side) — add one "Review for" line:
   - **Resolution:** every material ambiguous or uncertain point is either resolved or **explicitly surfaced**
     — as a decision to be made, an `UNCONFIRMED` mark, or an accepted assumption/risk — and is never left
     silent, vague, or glossed over.

   And broaden the Blocking-findings sentence: *"…, any material ambiguous or uncertain point left silent or
   unresolved (a genuine open point must be explicitly surfaced — decision-to-make, `UNCONFIRMED`, or accepted
   — not glossed), …"*.

2. **`shared/prompts/fixer.md`** (fixer side) — authorize surfacing as a valid fix, giving the loop a
   convergent move for points it must not decide. Add:
   - **Surfacing is a valid fix.** When an accepted issue is an ambiguous/uncertain point you cannot resolve
     without inventing a decision or external fact, resolve it by making the uncertainty **explicit in the
     document** — `UNCONFIRMED: <assumption>`, `DECISION NEEDED: <question + options>`, or an explicitly
     accepted assumption/risk — rather than guessing. A point that needs a human decision is surfaced and
     reported as needing human input; **never halt the loop or guess**.

3. **`shared/prompts/coordinator.md`** (triage side) — route human-decision points to `deferred` so they are
   shown, not ground. Add to the triage rules:
   - A finding whose real resolution requires a human product / risk / scope decision the fixer must not
     invent is triaged **`deferred`** (`deferred_owner: user`, `deferred_next_action: <the decision>`).
   - **Surfacing and deferring are one action, not a fix.** When deferring such a finding the coordinator (or
     fixer, which "fixes directly by default") writes the `DECISION NEEDED: <question + options>` marker into
     the document — the marker is the in-document *evidence* of the deferral, **not** a resolved fix, so the
     finding stays `deferred` and does not count toward PASS. On the next round the reviewer sees the point is
     now explicitly surfaced (per the `common.md` rule) and does **not** re-raise it as silent ambiguity, so
     it never trips `stopped-no-progress`. The loop continues on the other findings and ends
     `stopped-with-deferrals` (not PASS), the surfaced points listed.

**Decision (per user, recommended wording):** "no silent/unresolved ambiguity" is **blocking** across all
document routes; explicitly-surfaced uncertainty stays allowed. The **strict** variant (block even marked
`UNCONFIRMED`) is a one-line change but contradicts the global "mark `UNCONFIRMED`" guidance and is exactly
what would force human-decision docs to the round cap — flagged, not chosen.

#### Loop behavior & no-interrupt guarantee (per user, 2026-06-23)

The review-fix loop must **not interrupt** when it hits a point that needs a human decision — it keeps looping
and only **reports the un-PASSed points in the final result**. This holds because:

- The document loop is **autonomous and round-bounded** — it never pauses mid-loop to wait for a human; worst
  case it reaches the round / convergence cap and terminates cleanly (`stopped-with-deferrals` /
  `stopped-no-progress`), never a hang (`diff-review.js` round-limit deferral; `coordinator.md` fix-attempt
  cap = 5).
- A human-decision point is **surfaced (fixer) + deferred (coordinator)** → it is no longer a *silent*
  ambiguity (the reviewer won't re-raise it, so no `stopped-no-progress` grind) and is carried as an explicit
  **deferred / open item**.
- Final status is **`stopped-with-deferrals`, not PASS** — surfaced human-decision points appear in the
  result as un-PASSed items (the coordinator final-response already records deferrals with owner + next
  action). Genuinely-incomplete docs still fail their type rubric; honestly-surfaced minor uncertainty does
  not block.

Net: no interrupt, the loop runs to a clean terminal state, and the un-PASSed human-decision points are shown
— exactly the requested behavior.

### Ripple (3a + 3b)

`shared/rubrics/plan.md` is embedded into generated `review-fix-plan` (and reused by `review-fix-r2q`);
`shared/rubrics/common.md` affects document-rule routes only (the four single-document routes plus r2q once
its PLAN stack is wired), while `shared/prompts/fixer.md` and `shared/prompts/coordinator.md` are embedded
into **every** route. Regenerate `test/fixtures/{generated,embedded}/<platform>/*` and run
`npm run syntaxcheck && npm test` (`test/shared-assets.test.js` snapshots will move — 3b's prompt edits touch
the most fixtures since fixer/coordinator are shared across all routes).

> **VALIDATED 2026-06-23 (not landed).** To confirm 3b's approach is implementable, the three edits were
> applied to a throwaway working tree and the suite was run — `npm run syntaxcheck` (89 files) + `npm test`
> **1104/1104 pass, 0 fail** — and the diff confirmed the route scope (document routes gain the common.md rule
> + fixer + coordinator; pr/code gain only fixer + coordinator, since COMMON is not layered for PR/CODE).
> Fixture impact: only `test/fixtures/embedded/*` moves (`generated/` masks shared content; the codex
> copied-asset test compares to live source). The working-tree edits were then **reverted** — 3b is **not
> landed/committed**; like 3a, P2, P3, and r2q it awaits document review and the batch implementation. The
> validation only proves the documented approach is test-green and safe.

---

## Item 4 — `review-fix-r2q` requirement-review route

### Intent

A new agent route `review-fix-r2q` that takes an r2p **requirement directory** path
(e.g. `.req-to-plan/WF-20260621-vzi-fidelity-hardening-plan-status`), reviews the generated **`07-plan.md`**
with drfx's existing PLAN rubric, and — when a PLAN finding's root cause is upstream — fixes it *backward* by
editing the owning upstream document in place. `run.md` is a **read-only gate** (r2q errors out on a wrong
state and never writes it); r2q does not touch r2p's state machine or CLI.

### r2p requirement-directory facts (verified on disk)

Document chain inside a `WF-*` directory:

```
00-raw-requirement.md
01-intake-brief.md
02-project-context.{json,md}
03-requirement-brief.md   (stage: requirement_brief)
04-risk-discovery.md      (stage: risk_discovery)
05-design.md              (stage: design)
06-spec.md                (stage: spec)
07-plan.md                (stage: plan)        <- review anchor
run.md                    (r2p state machine)
inputs/  reviews/
```

`run.md` carries `## Status` (e.g. `closed_at_plan_checkpoint`), `## Current Stage`,
`## Approved Checkpoints` (per-stage version + approval), `## Active Artifacts` (per-stage version + status),
`## Stale / Superseded Artifacts`, `## Open Routes`, `## Resume Context`, `## Reopen Lineage`. Artifact
versions bump on repair (observed: spec v2, plan v3). r2p `0.4.5` ships these bin commands at
`/Users/xubo/.req-to-plan/bin` — `r2p-start, r2p-continue, r2p-tier-lock, r2p-status, r2p-switch,
r2p-reopen, r2p-gap-open, r2p-gap-resolve`. **There is no `r2p-execute` command.**

### Decision 1 — behavior: in-place review-and-fix of the doc chain; run.md is a read-only gate (revised 2026-06-23)

`review-fix-r2q` is a **requirement-directory target context** that applies the document PLAN stack to the
requirement directory's doc chain, anchored on `07-plan.md`. It is not a normal single-file document route:
it has one review anchor, a bounded editable doc-chain set, and read-only gate dependencies. It does **not**
engage r2p's state machine: it never invokes the r2p CLI and never writes `run.md`.

- **Review** `07-plan.md` against the PLAN + COMMON rubric (same rubric path as `review-fix-plan`).
- **Fix in place**: for each finding, edit `07-plan.md`; when the root cause is upstream, **also edit the
  owning upstream document in place** (`06-spec.md` / `05-design.md` / `04-risk-discovery.md` /
  `03-requirement-brief.md`) and re-align the affected `07-plan.md` section to match. Plain file edits — no
  versions, no checkpoints, no reopen, no new `-rN` dir.
- **`run.md` is read-only**: r2q parses it only to gate (Decision 2). **r2q never modifies `run.md`** — it
  does not need to, because r2q is a terminal QA-polish pass over already-generated artifacts, not a step in
  r2p's workflow. If `run.md` is in a state where editing the docs would be unsafe or meaningless, r2q
  **errors out** instead of editing.

**Why r2q stays out of r2p's machinery** (supersedes the earlier "drive r2p CLI / sync run.md" direction).
Verified against `req-to-plan/tools/workflow_cli/cli.py`: `r2p-reopen` is **not** an in-place edit — for a
`CLOSED_AT_PLAN_CHECKPOINT` run it forks a new `WF-…-rN` dir, drops the target stage + downstream for
re-authoring, and runs r2p's human checkpoints; `r2p-gap-open` only works on an open run. Engaging that
machinery for a terminal polish pass is heavy, human-gated, and tightly coupled to r2p's schema (violates
principle 2). r2q deliberately treats the chain as plain files and leaves r2p's state alone.

**Accepted consequence (stated, not a blocker).** Editing `06-spec.md` (etc.) without touching `run.md`
leaves r2p's recorded version/approval cosmetically stale relative to the file. This is acceptable only as a
pre-archive QA-polish pass: r2q can prove plan generation and "not archived," but it cannot prove the artifacts
were not already consumed because r2p has no execution marker. r2q therefore treats execution-state
unobservability as an accepted risk that must be surfaced in route docs/output; if a user needs proof that a
run has not been used, they must keep the run out of execution or use an external marker outside r2q's scope.
`r2p-status`/`r2p-continue` on a closed run only read or no-op, so r2p state staleness remains benign for the
r2p workflow itself. Re-processing the dir with r2p afterward is an explicit r2p action outside r2q's scope.

Finding → owner-document mapping (each is a plain in-place edit; no r2p stage transition):

| PLAN finding root cause | Owner document edited in place |
|---|---|
| Missing/wrong acceptance criteria, behavior contract gap | `06-spec.md` (+ re-align `07-plan.md`) |
| Unresolved architecture/interface/sequencing decision | `05-design.md` (+ re-align `07-plan.md`) |
| Unmitigated risk, missing rollback/failure handling at risk level | `04-risk-discovery.md` (+ re-align `07-plan.md`) |
| Scope/requirement ambiguity | `03-requirement-brief.md` (+ re-align `07-plan.md`) |
| Pure execution-ordering / tooling / handoff defect local to the plan | `07-plan.md` only |

### Decision 2 — gating: run.md status + archive path (per user)

`review-fix-r2q` proceeds only when **both** hold:

- **Plan generated:** `run.md` shows the `plan` stage approved in `## Active Artifacts` (or `## Status` is
  `closed_at_plan_checkpoint`). If plan generation is incomplete → block with a clear reason.
- **Not archived:** the requirement directory is **not** under an `*/archive/.req-to-plan/*` path
  (archived runs live at `docs/archive/.req-to-plan/WF-*`; active runs at `<project>/.req-to-plan/WF-*`).

"Executed" has **no** r2p marker (no `r2p-execute`), so archive-location is only a pre-archive proxy, not
proof that artifacts have not been consumed. r2q uses status + archive-path; it does not silently run on an
archived or incomplete requirement, and it surfaces the execution-state uncertainty as an accepted risk.

### Guard, PASS, and the run.md gate (revised 2026-06-23)

r2q inherits the same guarded review-and-fix guarantees as existing routes — it does **not** invoke the r2p
CLI or write `run.md`, so the human-checkpoint / reopen-fork concerns do not apply.

- **Guard.** The git/snapshot r2q guard monitors the editable doc-chain files (`03–07` within the resolved
  `WF-*` dir) **and** the read-only gate dependency `run.md`. `run.md` is fingerprinted and re-parsed as a
  protected dependency, but is never in the editable set. A clean `git` guard (or a valid snapshot anchor) is
  required before any write, same as every other route.
- **Gate freshness.** r2q records the parsed gate result plus the `run.md` fingerprint in the target context.
  Before `begin-fix`, before any lock refresh that precedes writes, after `end-fix`, and before final PASS, it
  rechecks that `run.md` is unchanged and still satisfies the gate. If `run.md` changes, becomes unreadable, or
  now indicates an incomplete/archived/invalid state, r2q stops as a guarded drift/blocker instead of writing
  or passing from stale eligibility.
- **PASS.** Earned the normal way — `07-plan.md` reviewed, every blocking finding fixed (in `07-plan.md`
  and/or the owning upstream doc), diff-reviewed, guard satisfied. There is **no** `stopped-pending-human`
  state, because r2q never hands off to an r2p human gate. read-only / advisory (Gemini) / drifted-file-set
  runs still cannot PASS, per the existing rules.
- **Inherits 3b.** Because r2q uses the document rubric stack (COMMON + PLAN), a `07-plan` finding whose root
  cause needs a human product/risk/scope decision is surfaced + deferred → r2q ends `stopped-with-deferrals`
  (not PASS), the open point listed. This is the generic loop behavior from Item 3b, distinct from the
  r2p-specific `stopped-pending-human` (which does not apply here).
- **run.md gate (read-only).** r2q parses `run.md` solely to decide whether it may run (Decision 2) and
  **errors out** on a wrong/invalid/incomplete/archived state. It never writes `run.md`.
- **Gemini.** Advisory-only — review + finding→owner-doc map, edits nothing (mirrors every other route).

### Decision: packaging — new drfx route reusing the PLAN rubric

`review-fix-r2q` is a 7th drfx route (not a standalone script): it reuses `shared/rubrics/plan.md` +
`shared/rubrics/common.md`, the file-set guard machinery, and the generator/installer pipeline. It carries a
new `targetContextKind` for the requirement directory and a **read-only** dependency on r2p's `run.md`
format (the route only makes sense for r2p-generated directories); it does **not** invoke the r2p CLI.

- Platform policy: review-and-fix on Claude/Codex/opencode; advisory-only on Gemini (mirrors existing routes).
- Guard: `snapshot` default because active `.req-to-plan/WF-*` directories are commonly ignored/untracked
  (this repository ignores `.req-to-plan/`). `guard=git` remains available when the selected WF directory is
  tracked and has a clean rollback anchor.
- Editable file set: `{03,04,05,06,07}-*.md` within the resolved `WF-*` directory only.
- Protected read-only dependency: `run.md` (gate, fingerprinted/revalidated, never written).

### Architecture surface (per `AGENTS.md` route/platform sync notes)

A new route + new `targetContextKind` touches (non-exhaustive):

- `lib/routes.js` — add the `review-fix-r2q` descriptor (`routeKind: 'r2q'`, `targetContextKind: 'r2q'`,
  `rubric: 'plan'`, `documentType: 'PLAN'`, `defaultGuard: 'snapshot'`, platform policy). Treat
  `routeKind: 'r2q'` as a first-class branch everywhere route kind is switched; do not rely on
  `targetContextKind` to be inferred from it.
- `lib/rulebook.js` — **no new rule stack.** r2q maps to `documentType: 'PLAN'`, so it must get the same
  document stack as `review-fix-plan` (COMMON → PLAN → user-global → project-local). Keep r2q out of the
  PR/CODE route-rule set (`{'pr','code'}`) and update any helper that currently assumes "non-document route
  kind means PR/CODE rubric only."
- `lib/generator.js` — update `sharedRelativePathsForRoute` so r2q embeds COMMON + PLAN, update
  `targetTokenFor`, platform invocation text, route listing/generation helpers, and add
  `templates/fragments/{invocation-gate,route-contract}.r2q.<platform>.md` (2 × 4 = 8 fragments). Preserve the
  existing backwards-compatible `ROUTES` export if external consumers still expect only the four
  single-document descriptors.
- `lib/input.js` — parse the requirement-directory argument + shared flags.
- `lib/target-context.js` — resolve + validate the `WF-*` directory, parse `run.md`, enforce the gating
  predicates, compute the editable file-set fingerprint over `03–07`, and record a protected read-only
  dependency fingerprint for `run.md`.
- `lib/workflow/`, `lib/no-state.js`, and `lib/semantic-parsers.js` — add the r2q lifecycle: gate (parse
  `run.md`, error on wrong state) → review `07-plan` → map findings to owner docs → apply in-place fixes
  across the editable doc chain → diff-review → full re-review → finalize. Add explicit r2q handling in
  helpers that currently branch only on document vs PR/CODE, including target metadata, no-state read-only
  review, stdin payload validation, final-response validation, and any `isFileSetRoute`/target-resolution
  shortcut.
- `lib/workflow-state.js` / manifest — register the `r2q` `targetContextKind` discriminator and its required
  keys: requirement directory identity, review anchor `07-plan.md`, editable doc-chain files, read-only
  `run.md` gate fingerprint/result, file-set fingerprint, and changed-files semantics.
- `shared/core.md`, `shared/long-task.md`, `shared/prompts/fixer.md`, and `shared/prompts/coordinator.md` —
  extend the target-context wording beyond "single document" and "PR/CODE file set": r2q reviews `07-plan.md`,
  may edit only `03–07`, treats `run.md` as read-only/protected, and reports multi-file changes in the final
  machine payload.
- Tests + fixtures — regenerate `test/fixtures/{generated,embedded}/<platform>/*`; add r2q lifecycle tests
  and a `WF-*` fixture directory; cover gating (incomplete plan, archived dir), `run.md` drift after start,
  editable-set enforcement, ignored/untracked active dirs using default `guard=snapshot`, optional `guard=git`
  on a tracked clean fixture, and the finding→owner-doc mapping. Update hard-coded six-route assertions in
  `test/shared-assets.test.js`, `test/manifest-schema-v2.test.js`, `test/pack-contents.test.js`,
  `test/cli.test.js`, and `test/capability-check.test.js`.
- `skills/`, install metadata, and docs — add `skills/review-fix-r2q/SKILL.md`, ensure install/uninstall
  ownership covers the new Codex skill directory, update `README.md`, `README.zh-CN.md`, `AGENTS.md`,
  `CLAUDE.md`, and `package.json` wording that currently says "six routes", and document that r2q never writes
  `run.md` or invokes the r2p CLI.

### Fragile assumptions (premise collapse) + mitigations

- **A1 — r2p `run.md` format stability (read-only).** r2q parses `run.md` only for the gate. *Mitigation:*
  parse defensively for the few fields it needs (`## Status`, plan-stage approval); **error out loudly** on an
  unrecognized/invalid `run.md` rather than guessing or editing (no silent fallback — principle 2). r2q never
  writes `run.md` or calls the r2p CLI, and it fingerprints/revalidates `run.md` during the guarded workflow so
  r2p's internal schema churn cannot silently invalidate a running review.
- **A2 — stale run.md after edits (accepted).** Editing the docs leaves r2p's recorded versions cosmetically
  stale, and r2q cannot prove whether the artifacts have already been consumed because r2p has no execution
  marker. *Mitigation:* gating confines r2q to a post-plan/pre-archive proxy window, `run.md` is protected
  against drift during the review, and route docs/output surface the execution-state uncertainty as an accepted
  risk rather than claiming a proven pre-execution state.
- **A3 — archived/executed detection.** No `r2p-execute` marker exists. *Mitigation:* gate on archive-path
  (Decision 2) and block, not guess; revisit if r2p later adds an execution marker.

### Build order for Item 4 (internal milestones of this one plan — not a separate plan)

`review-fix-r2q` ships **as part of this requirement**, together with Items 1–3, in a single delivery.
The milestones below are build order to keep the tree green during implementation, not separately released
plans:

1. Route scaffold + gating resolver: `routes.js`, `input.js`, `target-context.js` (resolve `WF-*`, parse and
   fingerprint `run.md`, enforce gating + error on wrong state), generator wiring + 8 fragments, shared
   target-context wording, skills/install surfaces, fixtures — plus the advisory/read-only review that reports
   the finding→owner-doc map.
2. In-place backward-fix: workflow lifecycle that applies the doc-chain edits (`07-plan` + owning upstream
   docs), guarded by git/snapshot. No r2p CLI, no `run.md` writes.
3. Docs (README/AGENTS) + end-to-end lifecycle tests.

Milestone 1 leaves a usable advisory r2q at each commit; milestone 2 adds the fix capability. All three are
completed and merged within this same requirement — r2q is **not** deferred to its own plan or release.

---

## Release & verification

All four items are **one requirement, delivered together** in a single minor release — `review-fix-r2q`
is in scope here, not split out into its own plan. Implementation build order (each step keeps the tree
green; not separate releases):

1. Items 1 + 2 + 3 + the README/AGENTS lines (small, low-risk; land first to keep CI green).
2. Item 4 milestones 1→2→3 (see Item 4 build order).

Verify at the end (and incrementally): `npm run syntaxcheck && npm test`; confirm the new atomic-copy tests
pass, the PLAN-rubric snapshot fixtures regenerate cleanly, and the r2q lifecycle + gating tests pass with a
`WF-*` fixture. Single release covers Items 1–4.

### Non-scope

- No back-compat shims for any item (principle 1).
- No rewrite of released CHANGELOG history (P3).
- No `run.md` writes and no r2p CLI invocation from drfx (r2q treats the chain as plain files; r2p state is
  left alone).
- No change to Gemini's advisory-only posture.
- No new rubric file for r2q (reuses PLAN + common).

### Unknowns (explicitly deferred — none blocks approval)

- **Fixture-regeneration mechanism — CONFIRMED (2026-06-23).** No env flag / regen script; fixtures are
  byte-compared in `test/shared-assets.test.js`. Editing shared `rubrics/`/`prompts/` moves **only**
  `test/fixtures/embedded/<platform>/<route>.*` (the `generated/` shells mask embedded shared content to a
  sentinel; the codex copied-asset test compares to live source). Regenerate by writing, per
  `platform × route`, `extractEmbeddedSharedContent(renderPlatformRoute(platform, route, {packageVersion:'0.0.0-snapshot'}))`
  to `embeddedSnapshotPath(...)` (the same calls the embedded test makes). Used for the 3b validation above.
- **r2q gate fields.** Which exact `run.md` fields the gate parses (`## Status`, `## Active Artifacts`
  plan-stage approval, archive-path) — read a couple of real `WF-*` `run.md` files when writing the gate.
- The earlier r2p-CLI ergonomics question is **moot** under the revised model (r2q never invokes the r2p CLI).
