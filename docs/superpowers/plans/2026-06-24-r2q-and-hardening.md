# r2q Route + Doc-Rubric & Atomic-Copy/Strict-Verified Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four items as one minor release (`0.7.1` → `0.8.0`): harden `atomicCopyFile` (P2), correct the strict-verified docs (P3), strengthen the PLAN rubric + add a no-silent-ambiguity review loop (Item 3), and add a 7th drfx route `review-fix-r2q` that reviews an r2p requirement directory's `07-plan.md` and fixes findings backward into the owning upstream docs in place (Item 4).

**Architecture:** drfx is a zero-dependency Node 20 CommonJS CLI that generates platform-specific review-fix routes from a shared route registry (`lib/routes.js`), a generator (`lib/generator.js`) that renders `templates/` + `templates/fragments/` with embedded `shared/` content, and a workflow engine (`lib/workflow/`) that runs review → triage → fix → diff-review → re-review, guarded by git or snapshot file-set guards. Items 1–3 are small, self-contained edits to `lib/atomic-write.js`, the docs, and `shared/`. Item 4 adds `review-fix-r2q` as a **file-set-style route** (it resolves a set — the editable `03–07` doc chain plus a read-only `run.md` gate — and reuses the file-set guard/lifecycle machinery) whose rubric stack is the **document** PLAN stack (COMMON → PLAN), anchored on `07-plan.md`.

**Tech Stack:** Node 20, CommonJS, zero npm dependencies, `node:test` test runner, `node:assert/strict`. No new languages, runtimes, or dependencies are introduced.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the approved design `docs/OPTIMIZATION-2026-06-23-r2q-and-hardening.md`.

- **Principle 1 — HARD cutover.** No legacy/back-compat shims, no old-version/old-data compatibility layers.
- **Principle 2 — NO over-engineering / over-defense.** Make the smallest change that makes the contract true; reject defensive code with no present requirement.
- **Zero npm deps; Node 20 CommonJS.** No new dependency, language, or runtime.
- **"PASS is earned, never assumed."** read-only / advisory / Gemini / diff-review-only / unverified / stale/drifted runs can never claim a workflow PASS.
- **No released-CHANGELOG history rewrite.** Tasks append notes under a new top `## Unreleased` section (standard Keep-a-Changelog). The eventual `chore(release): v0.8.0` commit (NOT in this plan) folds `## Unreleased` into a dated section and bumps `package.json`. Do **not** date a release or bump the version inside these tasks.
- **r2q never writes `run.md` and never invokes the r2p CLI.** `run.md` is a read-only, fingerprinted gate; r2q errors out on a wrong/invalid/incomplete/archived state.
- **r2q archive standard:** archived runs live under `*/.req-to-plan/archive/WF-*`; active runs directly under `<project>/.req-to-plan/WF-*`. The not-archived gate blocks when an `archive` segment sits between `.req-to-plan/` and the `WF-*` directory.
- **Gemini stays advisory-only** on every route (review + finding→owner-doc map, edits nothing, never claims PASS).
- **No new rubric file for r2q** — it reuses `shared/rubrics/plan.md` + `shared/rubrics/common.md` via `documentType: 'PLAN'`, and stays OUT of the PR/CODE route-rule set `ROUTE_KIND_SET = {'pr','code'}` (`lib/rulebook.js:14`).
- **Fixture regeneration is the established mechanism.** Editing shared `rubrics/`/`prompts/` moves ONLY `test/fixtures/embedded/<platform>/<route>.*` (the `generated/` shells mask embedded shared content to a sentinel; the codex copied-asset test compares to live source). Regenerate per `platform × route` by writing `extractEmbeddedSharedContent(renderPlatformRoute(platform, route, {packageVersion:'0.0.0-snapshot'}))` to `embeddedSnapshotPath(platform, route)` (the exact calls `test/shared-assets.test.js` makes). Do **not** commit a regeneration script.
- **Repo language is English** (code, comments, in-repo docs, commit messages).
- **Commit footer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. One local commit per task on branch `optimize`. Stage only the named files (never `git add -A`). `docs/` is gitignored — `git add -f` only the design/plan docs if a task must touch them (no Phase task should). Do **not** push or open PRs.
- **Verify per task:** `npm run syntaxcheck && npm test` (full suite, ~1107 tests at the start of this plan) green before commit.

---

## File Structure

**Phase 1 — created/modified:**
- Modify `lib/atomic-write.js` — extract `existingRegularTargetMode()`; share it between `atomicWriteFile`/`atomicCopyFile`; add dest-mode preservation to `atomicCopyFile`.
- Modify `test/atomic-write.test.js` — 3 new `atomicCopyFile` tests.
- Modify `CHANGELOG.md` — new `## Unreleased` section, accumulated across tasks.
- Modify `README.md`, `README.zh-CN.md`, `AGENTS.md` — strict-verified clarification.
- Modify `shared/rubrics/plan.md` — per-task test-strategy + acceptance bullets + blocking sentence.
- Modify `shared/rubrics/common.md` — Resolution review-for line + blocking sentence.
- Modify `shared/prompts/fixer.md` — "Surfacing is a valid fix" constraint.
- Modify `shared/prompts/coordinator.md` — human-decision → `deferred` + surface-and-defer marker triage rules.
- Regenerate `test/fixtures/embedded/<platform>/*` for routes whose embedded rubric/prompt content changed.

**Phase 2 (r2q) — created/modified:**
- Modify `lib/routes.js` — 7th descriptor `review-fix-r2q`.
- Modify `lib/generator.js` — `sharedRelativePathsForRoute` (COMMON for r2q), `targetTokenFor`, the `*For(route)` switches, fragment loading.
- Create `templates/fragments/invocation-gate.r2q.{claude,codex,gemini,opencode}.md` and `templates/fragments/route-contract.r2q.{claude,codex,gemini,opencode}.md` (8 fragments).
- Modify `lib/input.js` — `parseInvocationR2q` + dispatch in `parseInvocation`.
- Modify `lib/rulebook.js` and its workflow consumers — ensure r2q (documentType PLAN) takes the document rule stack.
- Modify `lib/target-context.js` — `resolveR2qTarget` (resolve WF dir, parse+fingerprint `run.md`, gate predicates, `03–07` editable-set fingerprint, protected `run.md` dependency) + r2q identity build/compare.
- Modify `lib/workflow/target-resolution.js` — `isFileSetRoute` and `resolveRouteTargetMetadata` learn `r2q`.
- Modify `lib/workflow-state.js` — `r2q` `targetContextKind`, `MANIFEST_V2_R2Q_FILESET_FIELDS`, `manifestV2FieldsForKind`, `requiredManifestV2Keys`, `resolveTargetContextKind`.
- Modify `lib/workflow/file-set-context.js`, `lib/workflow/file-set-fix.js`, `lib/workflow/file-set-finalize.js`, `lib/workflow/file-set-no-state.js`, `lib/no-state.js`, `lib/semantic-parsers.js`, `lib/final-response.js` — r2q lifecycle (gate → review `07-plan` → map → in-place backward fix → diff-review → re-review → finalize) + gate-freshness revalidation.
- Create `skills/review-fix-r2q/SKILL.md`.
- Modify `shared/core.md`, `shared/long-task.md`, `shared/prompts/fixer.md`, `shared/prompts/coordinator.md` — extend target-context wording for the r2q requirement directory.
- Create `test/fixtures/{generated,embedded}/<platform>/review-fix-r2q.*`; create a `WF-*` fixture directory; add r2q lifecycle/gating tests.
- Modify six→seven-route assertions in `test/routes.test.js`, `test/shared-assets.test.js`, `test/manifest-schema-v2.test.js`, `test/input-parsing.test.js`, `test/readme-content.test.js`, `test/pack-contents.test.js`, `test/cli.test.js`, `test/capability-check.test.js`.
- Modify `README.md`, `README.zh-CN.md`, `AGENTS.md`, `CLAUDE.md`, `package.json` — "six routes" → "seven routes" + r2q docs.

---

## Phase 1 — Hardening, docs, and rubric (Items 1, 2, 3)

These three tasks are small, independent, and land first to keep CI green before the larger r2q work.

### Task 1: atomicCopyFile target preflight + destination-mode preservation (Item 1 / P2)

**Files:**
- Modify: `lib/atomic-write.js`
- Test: `test/atomic-write.test.js`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `existingRegularTargetMode(targetPath) -> number|null` (module-internal; NOT exported). `atomicCopyFile(sourcePath, destinationPath)` now refuses non-regular destinations with `ERR_ATOMIC_WRITE_TARGET_KIND` and preserves an existing destination's mode. `module.exports` stays `{ atomicWriteFile, atomicCopyFile }`.

- [ ] **Step 1: Write the 3 failing tests** in `test/atomic-write.test.js` (reuse the file's existing `makeSandbox(t)` and `tempSiblings(target)` helpers):

```javascript
test('atomicCopyFile refuses to replace a symlink target', { skip: process.platform === 'win32' }, (t) => {
  const root = makeSandbox(t);
  const source = path.join(root, 'src.txt');
  const dest = path.join(root, 'link');
  fs.writeFileSync(source, 'payload\n');
  fs.symlinkSync(source, dest);

  assert.throws(() => atomicCopyFile(source, dest), /non-regular/);
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
  assert.deepEqual(tempSiblings(dest), []);
});

test('atomicCopyFile refuses to replace a directory target', (t) => {
  const root = makeSandbox(t);
  const source = path.join(root, 'src.txt');
  const dest = path.join(root, 'adir');
  fs.writeFileSync(source, 'payload\n');
  fs.mkdirSync(dest);

  assert.throws(() => atomicCopyFile(source, dest), /non-regular/);
  assert.equal(fs.statSync(dest).isDirectory(), true);
  assert.deepEqual(tempSiblings(dest), []);
});

test('atomicCopyFile preserves existing destination mode', { skip: process.platform === 'win32' }, (t) => {
  const root = makeSandbox(t);
  const source = path.join(root, 'src.txt');
  const dest = path.join(root, 'manifest');
  fs.writeFileSync(source, 'NEW CONTENT\n', { mode: 0o644 });
  fs.writeFileSync(dest, 'old\n', { mode: 0o600 });
  fs.chmodSync(dest, 0o600);

  atomicCopyFile(source, dest);

  assert.equal(fs.readFileSync(dest, 'utf8'), 'NEW CONTENT\n');
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  assert.deepEqual(tempSiblings(dest), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/atomic-write.test.js`
Expected: the 3 new tests FAIL (current `atomicCopyFile` does no preflight: the symlink/dir tests do not throw `/non-regular/`; the mode test ends with `0o644`, not `0o600`).

- [ ] **Step 3: Add the shared helper** in `lib/atomic-write.js` (place above `atomicWriteFile`):

```javascript
// Preflight shared by atomicWriteFile and atomicCopyFile: refuse to atomically
// replace a non-regular target (symlink/dir/device) and report the existing
// regular file's permission bits so the staged write can re-apply them. Returns
// null when the target does not exist (ENOENT) — the caller keeps the source mode.
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

- [ ] **Step 4: Replace `atomicWriteFile`'s inline lstat block** (current lines 28–39) with a single call, leaving its later `if (existingMode !== null) fs.chmodSync(...)` unchanged:

```javascript
  const targetPath = path.resolve(filePath);
  const tempPath = tempSiblingPath(targetPath);
  let existingMode = existingRegularTargetMode(targetPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
```

- [ ] **Step 5: Add the preflight + chmod to `atomicCopyFile`:**

```javascript
function atomicCopyFile(sourcePath, destinationPath) {
  const absoluteSource = path.resolve(sourcePath);
  const targetPath = path.resolve(destinationPath);
  const tempPath = tempSiblingPath(targetPath);
  const existingMode = existingRegularTargetMode(targetPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    fs.copyFileSync(absoluteSource, tempPath, fs.constants.COPYFILE_EXCL);
    if (existingMode !== null) fs.chmodSync(tempPath, existingMode);
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort temp cleanup; the reported failure remains the original copy error.
    }
    throw error;
  }
}
```

Mode semantics (deliberate, keep exactly): `copyFileSync` copies the **source** mode onto the temp; the added `chmod` fires only when the destination already exists, overriding source mode with the destination's current bits — matching `atomicWriteFile`'s "preserve the target's existing permissions" contract. Rollback caller (restore store→worktree) preserves the live file's perms; capture caller (worktree→fresh store path) sees `null` and keeps the source mode. Do not remove the `chmod`.

- [ ] **Step 6: Run the focused test to verify it passes**

Run: `node --test test/atomic-write.test.js`
Expected: PASS (3 new + all existing `atomicWriteFile`/`atomicCopyFile` tests; the refactor must not change `atomicWriteFile` behavior).

- [ ] **Step 7: Add the CHANGELOG note.** Create a NEW `## Unreleased` section at the very top of `CHANGELOG.md` (above `## 0.7.1 - 2026-06-23`):

```markdown
## Unreleased

### Fixed

- `atomicCopyFile` now shares the non-regular-target refusal (`ERR_ATOMIC_WRITE_TARGET_KIND`) and
  destination-mode preservation that `atomicWriteFile` already had, making the "every atomic write …
  refuses to clobber non-regular targets and preserves existing file permissions" guarantee true for
  snapshot rollback bodies (`lib/snapshot-guard.js`) as well.
```

- [ ] **Step 8: Run the full suite**

Run: `npm run syntaxcheck && npm test`
Expected: clean syntaxcheck; full suite green (3 net-new tests).

- [ ] **Step 9: Commit**

```bash
git add lib/atomic-write.js test/atomic-write.test.js CHANGELOG.md
git commit -m "fix(safety): share non-regular-target refusal and dest-mode preservation in atomicCopyFile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: strict-verified doc clarification (Item 2 / P3)

Doc-only. No code change, no CHANGELOG history rewrite. `lib/adapters/{claude,codex,opencode}.js` are byte-identical and all return `status: 'unverified'`, so strict-verified PASS is unreachable on **every** platform — the live README states a *requirement*, which is accurate; this task adds an explicit "presently unreachable" clarification so operators are not misled.

**Files:**
- Modify: `README.md` (near the `assurance=strict-verified` section, ~lines 163–165)
- Modify: `README.zh-CN.md` (the mirrored assurance section)
- Modify: `AGENTS.md` (operator-facing capability note)

**Interfaces:** None (documentation).

- [ ] **Step 1: Locate the assurance section** in `README.md`. Run: `grep -n "strict-verified" README.md` and read the surrounding paragraph (the one describing `assurance=practical|strict-verified|advisory`).

- [ ] **Step 2: Add this clarifying paragraph** immediately after the existing `assurance=strict-verified` description in `README.md`:

```markdown
> `assurance=strict-verified` requires a verified `drfx doctor` capability proof. No adapter currently
> emits verified reviewer-isolation or write-blocking proof, so strict-verified PASS is presently
> unreachable on all platforms (Claude, Codex, and opencode alike); `assurance=practical` is the
> supported automatic-fix path. strict-verified remains wired end-to-end and will activate unchanged
> once an adapter can supply verified proof.
```

- [ ] **Step 3: Mirror it in `README.zh-CN.md`.** Run `grep -n "strict-verified" README.zh-CN.md`, then add a faithful Chinese translation in the same place, matching the surrounding document's tone/format:

```markdown
> `assurance=strict-verified` 需要一份经过验证的 `drfx doctor` 能力证明。目前没有任何适配器能给出经过验证的
> 审查者隔离或写入阻断证明,因此 strict-verified 的 PASS 在所有平台(Claude、Codex、opencode)上当前都不可达;
> `assurance=practical` 才是受支持的自动修复路径。strict-verified 的端到端链路保持完好,一旦某个适配器能提供经过
> 验证的证明即可原样启用。
```

- [ ] **Step 4: Record the operator constraint in `AGENTS.md`.** Find the capability/doctor/assurance area (`grep -n "strict-verified\|assurance\|doctor" AGENTS.md`) and add one line, e.g.:

```markdown
- `assurance=strict-verified` is unreachable today: all adapters report reviewer capabilities as `unverified`, so `drfx doctor` never emits a verified proof. Use `assurance=practical` for automatic fixes; strict-verified stays wired for when an adapter supplies verified proof.
```

- [ ] **Step 5: Run the full suite** (verify `test/readme-content.test.js` and any doc-content assertions still pass).

Run: `npm run syntaxcheck && npm test`
Expected: green. If `test/readme-content.test.js` asserts exact strings that this insertion shifts, the assertions are about presence/markers, not these new sentences — do not weaken a test to pass; if one genuinely conflicts, STOP and report it (it would indicate the insertion landed in the wrong section).

- [ ] **Step 6: Commit**

```bash
git add README.md README.zh-CN.md AGENTS.md
git commit -m "docs: clarify strict-verified PASS is presently unreachable on all platforms

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: PLAN rubric + no-silent-ambiguity review loop (Item 3 / 3a + 3b)

Four `shared/` edits delivered together (one coherent doc-quality change, one fixture regeneration, one review gate). **3a** (`plan.md`) reaches the PLAN route only. **3b** spans: the reviewer rule in `common.md` reaches **document routes only** (COMMON is not layered for PR/CODE), while the surface-and-defer behavior in `fixer.md` + `coordinator.md` are shared prompts → **all routes** (intentional — fixers should surface, not guess, on every route). This approach was VALIDATED test-green on 2026-06-23 (then reverted); this task lands it.

**Files:**
- Modify: `shared/rubrics/plan.md` (3a)
- Modify: `shared/rubrics/common.md` (3b reviewer rule)
- Modify: `shared/prompts/fixer.md` (3b surfacing fix)
- Modify: `shared/prompts/coordinator.md` (3b triage)
- Regenerate: `test/fixtures/embedded/<platform>/*` for affected routes (see Step 9).

**Interfaces:** None (prompt/rubric text embedded into generated routes; verified by byte-for-byte snapshot tests).

- [ ] **Step 1 (3a): Replace the single "Verification" bullet** in `shared/rubrics/plan.md` (line 11) with two sharper bullets:

```markdown
- Test strategy: every implementation task that produces verifiable behavior names a concrete test approach (test-first / TDD where practical) — unit, integration, or e2e — sufficient to prove the task. Tasks that produce no verifiable behavior (copy edits, doc-only, config-only, asset moves) are explicitly exempt and should say why.
- Acceptance criteria: every material task states observable acceptance / done criteria (a clear pass/fail), except the non-behavioral tasks above.
```

- [ ] **Step 2 (3a): Extend the Blocking-findings sentence** in `shared/rubrics/plan.md` (line 25). Append, before the trailing period:

```
, and a task that produces verifiable behavior with no named test strategy or no acceptance criteria (trivial non-behavioral tasks exempt)
```

- [ ] **Step 3 (3b): Add a "Resolution" review-for line** to `shared/rubrics/common.md` (in the `Review for:` list, after the `External facts:` bullet, line 34):

```markdown
- Resolution: every material ambiguous or uncertain point is either resolved or explicitly surfaced — as a decision to be made, an `UNCONFIRMED` mark, or an accepted assumption/risk — and is never left silent, vague, or glossed over.
```

- [ ] **Step 4 (3b): Broaden the Blocking-findings sentence** in `shared/rubrics/common.md` (line 38). Insert, after "unresolved questions that block use,":

```
any material ambiguous or uncertain point left silent or unresolved (a genuine open point must be explicitly surfaced — decision-to-make, `UNCONFIRMED`, or accepted — not glossed),
```

- [ ] **Step 5 (3b): Authorize surfacing as a valid fix** in `shared/prompts/fixer.md`. Add a new Constraints bullet (after the existing "If an issue cannot be fixed cleanly, report it instead of guessing." line):

```markdown
- Surfacing is a valid fix. When an accepted issue is an ambiguous/uncertain point you cannot resolve without inventing a decision or external fact, resolve it by making the uncertainty explicit in the document — `UNCONFIRMED: <assumption>`, `DECISION NEEDED: <question + options>`, or an explicitly accepted assumption/risk — rather than guessing. A point that needs a human decision is surfaced and reported as needing human input; never halt the loop or guess.
```

- [ ] **Step 6 (3b): Route human-decision points to `deferred`** in `shared/prompts/coordinator.md`. Add to the "Triage and PASS rules:" list (after the `Deferred high/medium findings produce stopped-with-deferrals, not PASS.` line, ~line 112):

```markdown
- A finding whose real resolution requires a human product / risk / scope decision the fixer must not invent is triaged `deferred` (`deferred_owner: user`, `deferred_next_action: <the decision>`).
- Surfacing and deferring are one action, not a fix. When deferring such a finding, the coordinator (or fixer, which fixes directly by default) writes the `DECISION NEEDED: <question + options>` marker into the document — the marker is the in-document evidence of the deferral, not a resolved fix, so the finding stays `deferred` and does not count toward PASS. On the next round the reviewer sees the point is now explicitly surfaced (per the COMMON Resolution rule) and does not re-raise it as silent ambiguity, so it never trips `stopped-no-progress`. The loop continues on the other findings and ends `stopped-with-deferrals` (not PASS), the surfaced points listed.
```

- [ ] **Step 7: Verify the no-interrupt guarantee holds** (read-only confirmation; no code change). Confirm the loop is round-bounded and cannot hang: `lib/workflow/diff-review.js` defers at the round limit, and `shared/prompts/coordinator.md` enforces the fix-attempt cap of 5 (line 116). A human-decision point is surfaced (fixer) + deferred (coordinator), so it is no longer *silent*, the reviewer won't re-raise it, and the run terminates `stopped-with-deferrals`, never a hang. Record this confirmation in the task report.

- [ ] **Step 8: Regenerate the affected embedded fixtures.** Editing `common.md` affects every **document** route's embedded content; editing `plan.md` affects `review-fix-plan`; editing `fixer.md`/`coordinator.md` affects **all** routes. Regenerate using the same calls `test/shared-assets.test.js` makes — write a throwaway (uncommitted) Node script under the scratch dir that requires `lib/generator.js` + the test helpers and, for each `platform × route`, writes:

```javascript
const { renderPlatformRoute } = require('./lib/generator');
// extractEmbeddedSharedContent + embeddedSnapshotPath are defined in test/shared-assets.test.js;
// import or re-derive them exactly as that file does (do not invent new shapes).
for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
  for (const route of /* the six current routes */) {
    const embedded = extractEmbeddedSharedContent(
      renderPlatformRoute(platform, route, { packageVersion: '0.0.0-snapshot' })
    );
    fs.writeFileSync(embeddedSnapshotPath(platform, route), embedded);
  }
}
```

Do **not** commit this script. Only `test/fixtures/embedded/*` files should change (the `generated/` shells mask shared content; the codex copied-asset test compares to live source).

- [ ] **Step 9: Run the full suite to confirm the snapshots match**

Run: `npm run syntaxcheck && npm test`
Expected: green. `test/shared-assets.test.js` confirms the regenerated `embedded/` fixtures byte-match the live shared content; no `generated/` fixture should have changed (if one did, the regeneration touched the wrong files — STOP and investigate).

- [ ] **Step 10: Commit**

```bash
git add shared/rubrics/plan.md shared/rubrics/common.md shared/prompts/fixer.md shared/prompts/coordinator.md test/fixtures/embedded
git commit -m "feat(rubric): add per-task TDD/acceptance to PLAN and a no-silent-ambiguity surface-and-defer loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2 — `review-fix-r2q` route (Item 4)

r2q is a 7th route. It is a **file-set-style** route for resolution/guard (it resolves a set — the editable `03–07` doc chain + a read-only `run.md` gate — and uses the file-set guard), but its **rubric stack is the document PLAN stack** (`documentType: 'PLAN'`, COMMON → PLAN). It reviews `07-plan.md` and fixes findings in place in `07-plan.md` and the owning upstream doc (`06/05/04/03`). It never writes `run.md` or invokes the r2p CLI.

**Build order (keeps the tree green per commit):** land the green-additive new functions first (Tasks 4–5: target resolver + manifest kind, nothing calls them yet), then the registry+generation increment that makes the route exist (Task 6), then the advisory review path (Task 7); then the persistent backward-fix lifecycle (Milestone 2, Tasks 8–11); then docs + e2e (Milestone 3, Tasks 12–13).

> **Documented residual unknown (design §Unknowns):** the exact `run.md` field formatting. The gate parser below is written against the design's documented sections (`## Status`, `## Active Artifacts`). The first step of Task 4 reads a couple of real `WF-*/run.md` files to confirm formatting before finalizing the parser; if the real format differs, adjust the parser's field extraction (only) to match — the gate predicates and the error-loudly-on-unrecognized contract do not change.

### Milestone 1 — scaffold + gating + advisory review

### Task 4: `resolveR2qTarget` + `run.md` gate parser + r2q identity (target-context.js)

Green-additive: new functions with their own unit tests; nothing in the workflow calls them yet.

**Files:**
- Modify: `lib/target-context.js`
- Test: `test/r2q-target-context.test.js` (new)

**Interfaces:**
- Consumes: `computeFileSetFingerprint(files)` (`target-context.js:251`), `crypto`, `fs`, `path` (already required).
- Produces:
  - `parseRunMdGate(runMdText) -> { planApproved: boolean, status: string }` — defensive parser; throws `ERR_R2Q_RUNMD_UNRECOGNIZED` on a `run.md` that lacks the fields the gate needs (no silent fallback — principle 2).
  - `isArchivedRequirementDir(absDir) -> boolean` — true when an `archive` segment sits between `.req-to-plan/` and the `WF-*` directory.
  - `resolveR2qTarget({ cwd, target, commandLog }) -> { routeKind:'r2q', targetContextKind:'r2q', requirementDir, projectRoot, editableFiles:[{relativePath, absolutePath, sha256, size}], fileSetFingerprint, runMdPath, runMdSha256, gate:{planApproved,status} }`. Resolves and validates the `WF-*` directory, enforces the gating predicates (plan generated AND not archived — else `fail('ERR_R2Q_GATE_*', ...)`), computes the editable-set fingerprint over the existing `03–07` `*.md` files, and fingerprints `run.md` as a protected read-only dependency.
  - `buildR2qIdentity({ context, guardMode, roundLimit }) -> object`, `formatR2qIdentityFields`, `parseR2qIdentityFields`, `compareR2qIdentity({ stored, requested })` — mirror the `buildCodeIdentity`/`compareCodeIdentity` family (`target-context.js:1175`+). Identity scalars: `targetContextKind`, `guardMode`, `roundLimit`, `requirementDir` (root-relative), `runMdSha256`, `fileSetFingerprint`. (Drift in `runMdSha256` or `fileSetFingerprint` ⇒ identity mismatch ⇒ never PASS from stale eligibility.)

- [ ] **Step 1: Confirm `run.md` formatting.** Read 1–2 real `WF-*/run.md` files (e.g. under `~/.req-to-plan/` or a project `.req-to-plan/`) to confirm the exact heading/field text for `## Status` and the plan-stage approval in `## Active Artifacts`. Record the confirmed field shapes in the task report. (If none is reachable, proceed against the design's documented shapes and mark the parser `UNCONFIRMED` in the report.)

- [ ] **Step 2: Write failing unit tests** in `test/r2q-target-context.test.js` covering the gate parser, the archive predicate, and resolution. Build `WF-*` fixtures under a `t`-scoped `os.tmpdir()` sandbox (a directory `<root>/.req-to-plan/WF-20260101-aaa-demo/` containing `03-requirement-brief.md` … `07-plan.md` + a `run.md`). Assert:

```javascript
// gate parser
assert.deepEqual(parseRunMdGate(planApprovedRunMd), { planApproved: true, status: 'closed_at_plan_checkpoint' });
assert.throws(() => parseRunMdGate('garbage with no Status section'), /ERR_R2Q_RUNMD_UNRECOGNIZED/);

// archive predicate
assert.equal(isArchivedRequirementDir('/p/.req-to-plan/archive/WF-x'), true);
assert.equal(isArchivedRequirementDir('/p/.req-to-plan/WF-x'), false);

// resolution: happy path returns 5 editable files (03..07) + fingerprints
const ctx = resolveR2qTarget({ cwd: root, target: wfDir });
assert.equal(ctx.targetContextKind, 'r2q');
assert.equal(ctx.editableFiles.length, 5);
assert.match(ctx.fileSetFingerprint, /^[a-f0-9]{64}$/);
assert.match(ctx.runMdSha256, /^[a-f0-9]{64}$/);

// gating: incomplete plan blocks
assert.throws(() => resolveR2qTarget({ cwd: root, target: incompletePlanWfDir }), /ERR_R2Q_GATE_PLAN_INCOMPLETE/);
// gating: archived dir blocks
assert.throws(() => resolveR2qTarget({ cwd: root, target: archivedWfDir }), /ERR_R2Q_GATE_ARCHIVED/);
```

- [ ] **Step 3: Run the tests to verify they fail** — `node --test test/r2q-target-context.test.js` → FAIL (functions not defined).

- [ ] **Step 4: Implement the gate parser + archive predicate** in `lib/target-context.js` (near the other resolvers). Parse defensively; error loudly on an unrecognized `run.md`:

```javascript
const R2Q_EDITABLE_PREFIXES = Object.freeze(['03', '04', '05', '06', '07']);

// Parse the FEW run.md fields the gate needs. Throws on an unrecognized run.md
// rather than guessing (no silent fallback — principle 2). r2q never writes run.md.
function parseRunMdGate(runMdText) {
  const text = String(runMdText || '');
  const statusMatch = text.match(/^##\s+Status\s*\n+\s*([^\n]+)/m);
  if (!statusMatch) fail('ERR_R2Q_RUNMD_UNRECOGNIZED', 'run.md has no recognizable "## Status" section');
  const status = statusMatch[1].trim();
  // Plan generated: status closed at the plan checkpoint, OR the plan stage is
  // approved/active in "## Active Artifacts". Confirm the exact token against a
  // real run.md in Step 1 and adjust ONLY this extraction if needed.
  const planApproved =
    /closed_at_plan_checkpoint/.test(status) ||
    /^.*\bplan\b.*\b(approved|active)\b.*$/im.test(activeArtifactsSection(text));
  return { planApproved, status };
}

function activeArtifactsSection(text) {
  const m = text.match(/^##\s+Active Artifacts\s*\n([\s\S]*?)(?:\n##\s|\s*$)/m);
  return m ? m[1] : '';
}

function isArchivedRequirementDir(absDir) {
  const parts = String(absDir).split(path.sep);
  const reqIdx = parts.lastIndexOf('.req-to-plan');
  if (reqIdx === -1) return false;
  // archived ⇒ an "archive" segment sits between .req-to-plan/ and the WF-* dir.
  return parts.slice(reqIdx + 1, parts.length - 1).includes('archive');
}
```

- [ ] **Step 5: Implement `resolveR2qTarget`** — validate the directory is a real existing directory (reuse the `realExistingDirectory`-style checks, no symlink escape), enforce gating, read `run.md`, build the editable set over existing `0[3-7]-*.md` files, and fingerprint. Use the existing `computeFileSetFingerprint(files)` (`target-context.js:251`) for `fileSetFingerprint` and `crypto.createHash('sha256')` over the `run.md` bytes for `runMdSha256`:

```javascript
function resolveR2qTarget({ cwd, target, commandLog } = {}) {
  const requirementDir = fs.realpathSync.native(path.resolve(cwd || process.cwd(), target));
  if (!fs.statSync(requirementDir).isDirectory()) fail('ERR_R2Q_TARGET_KIND', `r2q target must be a directory: ${requirementDir}`);
  if (isArchivedRequirementDir(requirementDir)) fail('ERR_R2Q_GATE_ARCHIVED', `requirement directory is archived: ${requirementDir}`);

  const runMdPath = path.join(requirementDir, 'run.md');
  let runMdText;
  try { runMdText = fs.readFileSync(runMdPath, 'utf8'); }
  catch { fail('ERR_R2Q_RUNMD_MISSING', `requirement directory has no run.md gate: ${runMdPath}`); }
  const gate = parseRunMdGate(runMdText);
  if (!gate.planApproved) fail('ERR_R2Q_GATE_PLAN_INCOMPLETE', `plan stage is not generated/approved: ${runMdPath}`);

  const editableFiles = [];
  for (const name of fs.readdirSync(requirementDir).sort()) {
    if (!/\.md$/.test(name)) continue;
    if (!R2Q_EDITABLE_PREFIXES.includes(name.slice(0, 2))) continue;
    const absolutePath = path.join(requirementDir, name);
    if (!fs.lstatSync(absolutePath).isFile()) continue;
    const buf = fs.readFileSync(absolutePath);
    editableFiles.push({
      relativePath: name,
      absolutePath,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length
    });
  }
  if (!editableFiles.some((f) => f.relativePath.startsWith('07-'))) {
    fail('ERR_R2Q_NO_PLAN_DOC', `requirement directory has no 07-plan.md review anchor: ${requirementDir}`);
  }

  return {
    routeKind: 'r2q',
    targetContextKind: 'r2q',
    requirementDir,
    projectRoot: requirementDir, // refined to the resolved root in Task 6 metadata
    editableFiles,
    fileSetFingerprint: computeFileSetFingerprint(editableFiles),
    runMdPath,
    runMdSha256: crypto.createHash('sha256').update(runMdText).digest('hex'),
    gate
  };
}
```

(Confirm the `computeFileSetFingerprint` input shape against `target-context.js:251` and pass it the exact field names it expects — adapt `editableFiles` field names if that helper keys on `relativePath`/`sha256`/`size` differently.)

- [ ] **Step 6: Implement the r2q identity family** mirroring `buildCodeIdentity`/`formatCodeIdentityFields`/`parseCodeIdentityFields`/`compareCodeIdentity` (`target-context.js:1175`–`1255`). Scalars: `targetContextKind`, `guardMode`, `roundLimit`, `requirementDir` (root-relative), `runMdSha256`, `fileSetFingerprint`. Add a test asserting `compareR2qIdentity` reports a mismatch when `runMdSha256` OR `fileSetFingerprint` differs (this is the stale-eligibility guard).

- [ ] **Step 7: Export the new functions** from `lib/target-context.js` `module.exports`.

- [ ] **Step 8: Run tests** — `node --test test/r2q-target-context.test.js` → PASS, then `npm run syntaxcheck && npm test` → green (purely additive).

- [ ] **Step 9: Commit**

```bash
git add lib/target-context.js test/r2q-target-context.test.js
git commit -m "feat(r2q): add resolveR2qTarget gate parser, editable-set resolution, and identity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: r2q manifest kind + fields (workflow-state.js)

Green-additive: adds the `r2q` `targetContextKind` and its manifest field set so persistent r2q state (Milestone 2) can be formatted/parsed/validated.

**Files:**
- Modify: `lib/workflow-state.js`
- Test: `test/manifest-schema-v2.test.js`

**Interfaces:**
- Consumes: the existing `MANIFEST_V2_*` field arrays and the `manifestV2FieldsForKind`/`requiredManifestV2Keys`/`resolveTargetContextKind` dispatch (`workflow-state.js:95`–`213`, `:364`).
- Produces: `TARGET_CONTEXT_KINDS` includes `'r2q'`; a new `MANIFEST_V2_R2Q_FILESET_FIELDS` (and list fields if needed); `manifestV2FieldsForKind('r2q')`, `requiredManifestV2Keys('r2q')`, and `resolveTargetContextKind` all handle `'r2q'`.

- [ ] **Step 1: Write the failing assertions** in `test/manifest-schema-v2.test.js`: a round-trip `formatManifestV2`→`parseManifestV2`→`normalizeManifestV2` for an `r2q` manifest carrying the required keys (target-context kind `r2q`, `requirementDir`, `runMdSha256`, `fileSetFingerprint`, `lastKnownContentSha256`/round-limit etc. as the code-fileset analog requires), and an assertion that `requiredManifestV2Keys('r2q')` returns exactly the r2q key set. Run → FAIL.

- [ ] **Step 2: Add `'r2q'` to `TARGET_CONTEXT_KINDS`** (`workflow-state.js:95`): `Object.freeze(['document', 'pr', 'code', 'r2q'])`.

- [ ] **Step 3: Define `MANIFEST_V2_R2Q_FILESET_FIELDS`** mirroring `MANIFEST_V2_CODE_FILESET_FIELDS` (`:158`) — `fileSetFingerprint`, `lastModifiedAt`, plus r2q-specific `requirementDir` and `runMdSha256` (the protected read-only `run.md` fingerprint). Add a list field for `editableFiles` if the manifest records the `03–07` set explicitly (mirror `MANIFEST_V2_CODE_LIST_FIELDS`).

- [ ] **Step 4: Extend the dispatch** — add the `'r2q'` branches to `manifestV2FieldsForKind` (`:206`), `requiredManifestV2Keys` (`:212`), `MANIFEST_V2_LABELS`, and `resolveTargetContextKind` (`:364`) so an r2q manifest validates. Keep r2q's required-key set minimal (principle 2): only what guard-freshness + identity comparison actually read.

- [ ] **Step 5: Run tests** — `node --test test/manifest-schema-v2.test.js` then `npm run syntaxcheck && npm test` → green.

- [ ] **Step 6: Commit**

```bash
git add lib/workflow-state.js test/manifest-schema-v2.test.js
git commit -m "feat(r2q): register the r2q target-context kind and manifest field set

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Register the route + generation + parser + rulebook (the route exists and generates)

This is the green-atomic scaffold: after it, `review-fix-r2q` is a real, generatable, parseable route on all four platforms, mapped to the document PLAN rule stack. Author the inert pieces (generator branches, fragments, fixtures) **before** adding the descriptor so the single end-of-task commit is green.

**Files:**
- Modify: `lib/routes.js` (7th descriptor)
- Modify: `lib/generator.js` (route-varying branches, `targetTokenFor`, `sharedRelativePathsForRoute`)
- Create: `templates/fragments/invocation-gate.r2q.{claude,codex,gemini,opencode}.md`, `templates/fragments/route-contract.r2q.{claude,codex,gemini,opencode}.md` (8 files)
- Modify: `lib/input.js` (`parseInvocationR2q` + dispatch)
- Modify: `lib/rulebook.js` and its workflow consumer (document-stack dispatch for r2q)
- Modify: `lib/workflow/target-resolution.js` (`isFileSetRoute`, `resolveRouteTargetMetadata`)
- Create: `skills/review-fix-r2q/SKILL.md`
- Create: `test/fixtures/generated/<platform>/review-fix-r2q.*`, `test/fixtures/embedded/<platform>/review-fix-r2q.*`
- Modify: route-count assertions in `test/routes.test.js`, `test/input-parsing.test.js`, `test/shared-assets.test.js`, `test/pack-contents.test.js`, `test/cli.test.js`, `test/capability-check.test.js`

**Interfaces:**
- Consumes: `resolveR2qTarget` (Task 4), the `r2q` manifest kind (Task 5), `getRouteDescriptor`.
- Produces: `getRouteDescriptor('review-fix-r2q')` returns the r2q descriptor; `renderPlatformRoute(platform, 'review-fix-r2q', …)` renders on all four platforms; `parseInvocation('review-fix-r2q', tokens)` returns `{ routeKind:'r2q', documentType:'PLAN', target, … }`; `isFileSetRoute({invocation:{routeKind:'r2q'}})` is `true`.

- [ ] **Step 1: Add the descriptor** to `ROUTE_LIST` in `lib/routes.js` (after `review-fix-code`):

```javascript
  Object.freeze({
    routeName: 'review-fix-r2q',
    routeKind: 'r2q',
    documentType: 'PLAN',
    rubric: 'plan',
    defaultMode: 'review-and-fix',
    defaultGuard: 'snapshot',
    targetContextKind: 'r2q',
    platformPolicy: DEFAULT_PLATFORM_POLICY
  })
```

Update the registry comment ("six routes"/"all six route kinds") to "seven routes". Note: `listDocumentRoutes()` filters `routeKind === 'document'`, so r2q is correctly excluded from it (it is not a single-file document route); the `ROUTES` back-compat export (`generator.js:15`) stays the four single-document routes — leave it unchanged.

- [ ] **Step 2: Make `sharedRelativePathsForRoute` layer COMMON for r2q** (`generator.js:64`):

```javascript
  if (route.routeKind === 'document' || route.routeKind === 'r2q') paths.push(path.join('shared', 'rubrics', 'common.md'));
```

r2q's `rubric: 'plan'` already adds `plan.md` via the existing `if (route.rubric)` line, so r2q embeds COMMON + PLAN.

- [ ] **Step 3: Add the `targetTokenFor` r2q branch** (`generator.js:115`): `if (route.routeKind === 'r2q') return 'target=<requirement-dir>';`.

- [ ] **Step 4: Add r2q branches to the route-varying `*For(route)` helpers** in `generator.js`. Each currently switches on `pr`/`code` then falls through to the document text — r2q needs explicit, requirement-directory-appropriate wording (do NOT let r2q silently inherit the single-document fallthrough where it would be wrong):
  - `routeSummaryFor` → `'r2p requirement plans (07-plan.md)'`
  - `metadataTypeFor` → `'review_target = "r2p-requirement"'`
  - `routeHeaderFor` → `Route name: review-fix-r2q\nReview target: r2p requirement directory (07-plan.md, fixes backward into 03–06)`
  - `reviewUnitVerificationFor`/`reviewSemanticNounFor`/`reviewBodyNounFor` → document-style wording (r2q reviews a document anchor) — return the document branch text.
  - `fixWriteBoundaryFor` → `'Edit only 07-plan.md and the owning upstream doc (03–06) inside the resolved requirement directory; never edit run.md or any file outside 03–07.'`
  - `guardWriteRequirementFor` → the file-set guard wording (r2q uses the file-set guard; default `snapshot`), adding that `run.md` is a protected read-only dependency that must remain unchanged.
  - `invocationGrammarFor` → an r2q grammar line: `review-fix-r2q target=<requirement-dir> [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]` (Gemini variant: `[read-only]`, no rounds/resume).
  - `platformInvocationText` → an r2q branch (mirror the document branch's mode/guard prose, but target a requirement directory and state the read-only run.md gate + backward-fix scope; Gemini stays advisory-only).
  - `partitionedReviewFlowFor` → returns `''` for r2q (not a partitioned code route).

- [ ] **Step 5: Author the 8 fragments.** `routeContractFor`/`invocationGateBodyFor` read `…${route.routeKind}.${platform}.md`, so r2q needs `route-contract.r2q.<platform>.md` and `invocation-gate.r2q.<platform>.md` for claude/codex/gemini/opencode. Base each on the corresponding `*.document.<platform>.md` fragment (r2q is document-rubric), then adjust: the target is a requirement directory; r2q reviews `07-plan.md` and fixes backward into `03–06`; `run.md` is a read-only gate (never written); the guard defaults to `snapshot`; Gemini variants stay advisory-only (no fix, no PASS). Use the `{{ROUTE_NAME}}`, `{{DOCUMENT_TYPE}}`, `{{TARGET_TOKEN}}` placeholders the loader substitutes.

- [ ] **Step 6: Add `parseInvocationR2q`** to `lib/input.js` and dispatch to it in `parseInvocation` (`input.js:435`): `if (routeKind === 'r2q') return parseInvocationR2q(entrySkill, tokens, options);`. Model it on `parseInvocationDocument` (`input.js:122`) but: the positional/`target=` argument is a **requirement directory** (not a `.md` file); accept the shared flags `read-only|review-and-fix`, `guard=git|snapshot` (default **snapshot** for r2q — override `DEFAULT_GUARD_MODE` per route), `resume|reset`, `rounds=<n>`, `root=`, `debug`; reject `ref=`, `strict|normal`, `assurance=`, `ledger=`, `scope=`, `base=` (r2q has a fixed PLAN rubric and no document-route assurance surface). Return `{ entrySkill, routeKind:'r2q', documentType:'PLAN', target, mode, guardMode, resume, reset, rounds, root, debug }`.

- [ ] **Step 7: Wire the document rule stack for r2q.** r2q maps to `documentType: 'PLAN'`, so wherever the workflow chooses between the **document** rule stack (`mergeRules({documentType})`, `lib/rulebook.js:290`) and the **route** rule stack (`loadRouteRuleContext({routeKind})`, `:351`), r2q must take the document path. Find the dispatch (search consumers of `rulebook.js`: `lib/workflow/helpers.js`, `lib/workflow/start.js`, `lib/context-pack.js`, `lib/check.js`) and ensure the branch keys on `routeKind === 'pr' || routeKind === 'code'` (the `ROUTE_KIND_SET`) for the route stack, so r2q (kind `r2q`) falls to the document stack. Do NOT add r2q to `ROUTE_RULE_FILENAMES`/`ROUTE_KIND_SET`. Add a unit assertion that the merged rule sections for r2q are `COMMON + PLAN` (same as `review-fix-plan`).

- [ ] **Step 8: Teach `target-resolution.js` about r2q.** In `lib/workflow/target-resolution.js`: `isFileSetRoute` returns true for `kind === 'r2q'` (`:46`); `fileSetIdentitySeed` gets an r2q branch seeding on the resolved requirement-dir identity; `resolveRouteTargetMetadata` (`:153`) gets an r2q branch returning `{ routeKind:'r2q', projectRoot, targetKey, normalizedTarget:null, requirementDir }` (derive `targetKey` as `r2q-<hash12>` from the requirement-dir seed, mirroring `deriveFileSetTargetKey`).

- [ ] **Step 9: Create `skills/review-fix-r2q/SKILL.md`** modeled on `skills/review-fix-plan/SKILL.md` (52 lines): describe the requirement-directory target, the `07-plan.md` anchor, the backward-fix scope (`03–07`), the read-only `run.md` gate, the `snapshot` default guard, and the advisory-only-on-Gemini policy. (Install/uninstall ownership of the generated Codex skill directory propagates automatically because `generatePlatformFiles`→`listRoutes` now includes r2q; no `install.js` change is required — confirm with the pack-contents test in Step 11.)

- [ ] **Step 10: Generate the r2q fixtures.** Run the repo's fixture generation the same way `test/shared-assets.test.js` derives expectations — write the `generated/<platform>/review-fix-r2q.*` shells (shared content masked to the sentinel) and the `embedded/<platform>/review-fix-r2q.*` (actual embedded COMMON+PLAN+prompts) for all four platforms, via `renderPlatformRoute(platform, 'review-fix-r2q', {packageVersion:'0.0.0-snapshot'})` and the test's `extractEmbeddedSharedContent`/`embeddedSnapshotPath` helpers. Do not commit a generation script.

- [ ] **Step 11: Update route-count assertions.** Update hardcoded six→seven expectations: `test/routes.test.js` (route count/names), `test/input-parsing.test.js`, `test/shared-assets.test.js` (route iteration list), `test/pack-contents.test.js` (skills/fixtures present), `test/cli.test.js`, `test/capability-check.test.js`. Where a test iterates `listRoutes()`, no count edit is needed — only the explicit `=== 6` / hardcoded route-name lists.

- [ ] **Step 12: Run the full suite** — `npm run syntaxcheck && npm test` → green. Confirm `renderPlatformRoute` produces byte-stable r2q output matching the new fixtures, the four existing routes' fixtures are unchanged, and Gemini's r2q output is advisory-only.

- [ ] **Step 13: Commit**

```bash
git add lib/routes.js lib/generator.js lib/input.js lib/rulebook.js lib/workflow/target-resolution.js templates/fragments skills/review-fix-r2q test/fixtures test/routes.test.js test/input-parsing.test.js test/shared-assets.test.js test/pack-contents.test.js test/cli.test.js test/capability-check.test.js
git commit -m "feat(r2q): register review-fix-r2q route with document PLAN stack and four-platform generation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Advisory / read-only review lifecycle for r2q (no-state path)

After this task, `review-fix-r2q` in `read-only` (or under Gemini) resolves the WF dir, gates on `run.md`, reviews `07-plan.md` against COMMON+PLAN, and reports the finding→owner-doc map — editing nothing and never claiming PASS.

**Files:**
- Modify: `lib/no-state.js`, `lib/workflow/file-set-no-state.js`, `lib/semantic-parsers.js`, `lib/final-response.js` (r2q branches in helpers that currently switch document vs PR/CODE)
- Modify: `shared/core.md`, `shared/long-task.md`, `shared/prompts/fixer.md`, `shared/prompts/coordinator.md` (target-context wording for the requirement directory)
- Regenerate: affected `test/fixtures/embedded/*`
- Test: `test/r2q-advisory.test.js` (new)

**Interfaces:**
- Consumes: `resolveR2qTarget` (Task 4), `isFileSetRoute` (now true for r2q), the document PLAN merged rules (Task 6).
- Produces: a no-state advisory r2q review path that returns `read-only-clean`/`read-only-findings` (never `pass`), surfaces gate errors as blockers, and includes the finding→owner-doc mapping in output.

- [ ] **Step 1: Map the no-state advisory path.** Use codegraph (`codegraph_explore "file-set-no-state review no-state.js semantic-parsers final-response advisory read-only"`) to find every helper that branches on document vs PR/CODE for the read-only/no-state review (target metadata, no-state read-only review, stdin payload validation, final-response validation). List them in the task report.

- [ ] **Step 2: Add the finding→owner-doc map** as a shared reference the reviewer/coordinator prompt surfaces. Add to `shared/prompts/coordinator.md` (and `shared/core.md` target-context wording) an r2q-specific note: r2q reviews `07-plan.md`; a finding whose root cause is upstream maps to the owning doc per this table (acceptance/behavior → `06-spec.md`; architecture/interface/sequencing → `05-design.md`; unmitigated risk/rollback → `04-risk-discovery.md`; scope/requirement ambiguity → `03-requirement-brief.md`; pure execution-ordering/tooling local to the plan → `07-plan.md` only). Editable set is `03–07`; `run.md` is read-only/protected.

- [ ] **Step 3: Extend target-context wording** in `shared/core.md` and `shared/long-task.md` beyond "single document" and "PR/CODE file set" to cover r2q: reviews `07-plan.md`, may edit only `03–07`, treats `run.md` as read-only/protected, reports multi-file changes in the final machine payload.

- [ ] **Step 4: Write a failing advisory e2e test** in `test/r2q-advisory.test.js`: build a `WF-*` fixture with a `07-plan.md` containing a planted PLAN-rubric gap, run the r2q advisory/read-only review path, and assert: status is `read-only-findings` (never `pass`); no `03–07` file or `run.md` was modified (compare sha256 before/after); the output references the owning upstream doc for the planted finding. Add a gating test: an incomplete-plan `run.md` yields the `ERR_R2Q_GATE_PLAN_INCOMPLETE` blocker, and an archived dir yields `ERR_R2Q_GATE_ARCHIVED` — neither runs a review.

- [ ] **Step 5: Implement the r2q advisory branch** in the no-state helpers so r2q routes through `resolveR2qTarget` + the document PLAN review, returning read-only statuses only. Reuse the existing file-set no-state review machinery (`lib/workflow/file-set-no-state.js`) — r2q's "file set" is the `03–07` set, but in read-only mode it only reviews the `07-plan.md` anchor and reports; it writes nothing.

- [ ] **Step 6: Regenerate affected embedded fixtures** (the `shared/` prose edits move embedded fixtures for affected routes). Run the suite — only `embedded/*` should move.

- [ ] **Step 7: Run** `npm run syntaxcheck && npm test` → green; the advisory + gating tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/no-state.js lib/workflow/file-set-no-state.js lib/semantic-parsers.js lib/final-response.js shared test/fixtures/embedded test/r2q-advisory.test.js
git commit -m "feat(r2q): advisory/read-only review path with run.md gating and finding-to-owner-doc map

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Milestone 2 — in-place backward-fix lifecycle

After Milestone 2, `review-fix-r2q` in `review-and-fix` earns PASS by reviewing `07-plan.md`, fixing each blocking finding in `07-plan.md` and/or the owning upstream doc (`03–06`), diff-reviewing, and re-reviewing — guarded by git/snapshot over the `03–07` set, with `run.md` re-validated as a protected dependency. No `run.md` writes, no r2p CLI.

> For Tasks 8–11, before writing code, run `codegraph_explore` on the file-set lifecycle to read the exact functions you mirror: `codegraph_explore "file-set-context assemble persistent context; file-set-fix runEndFix begin-fix lock; file-set-finalize validatePass earned; fix-guard"`. Each step below names the function to mirror and the test that gates it; the implementer writes the body against the real source.

### Task 8: r2q persistent context resolution (editable 03–07 set + protected run.md)

**Files:**
- Modify: `lib/workflow/file-set-context.js` (and `lib/workflow/start.js` if it persists the manifest)
- Test: `test/r2q-context.test.js` (new)

**Interfaces:**
- Consumes: `resolveR2qTarget` (Task 4), `buildR2qIdentity` (Task 4), the `r2q` manifest kind (Task 5).
- Produces: an r2q persistent context whose editable file set is exactly the `03–07` `*.md` files, with `run.md` recorded as a protected read-only dependency (fingerprint stored, never in the editable set), and a manifest carrying the r2q identity (requirementDir, runMdSha256, fileSetFingerprint).

- [ ] **Step 1: Write failing tests** — assert that the assembled r2q context lists exactly the `03–07` files as editable, that `run.md` appears as a protected dependency (not editable), and that the persisted manifest round-trips with `targetContextKind: 'r2q'` and the correct `runMdSha256`/`fileSetFingerprint`. Run → FAIL.

- [ ] **Step 2: Add the r2q context branch** in `file-set-context.js` mirroring the CODE/PR context assembly but sourcing the file set from `resolveR2qTarget(...).editableFiles` and adding `run.md` to a protected-dependency list. Persist the manifest via the Task 5 field set.

- [ ] **Step 3: Run** `node --test test/r2q-context.test.js` then `npm run syntaxcheck && npm test` → green.

- [ ] **Step 4: Commit** (`git add lib/workflow/file-set-context.js lib/workflow/start.js test/r2q-context.test.js`; message `feat(r2q): persistent context over the 03–07 editable set with run.md as a protected dependency`; footer).

---

### Task 9: r2q in-place backward-fix (07-plan + owning upstream)

**Files:**
- Modify: `lib/workflow/file-set-fix.js`, `lib/fix-guard.js` (editable-set enforcement)
- Test: `test/r2q-fix.test.js` (new)

**Interfaces:**
- Consumes: the r2q context (Task 8), the finding→owner-doc map wording (Task 7).
- Produces: an r2q fix phase that edits only files inside `03–07` (07-plan plus the owning upstream doc), guarded by the file-set guard; an attempt to edit `run.md` or any file outside `03–07` is refused as out-of-set.

- [ ] **Step 1: Write failing tests** — (a) a finding whose root cause is upstream results in edits to BOTH `07-plan.md` and the mapped upstream doc, both inside the set; (b) any write to `run.md` or a path outside `03–07` is refused (`ERR_*` out-of-set, no write); (c) the fix phase requires a clean guard (git clean worktree over the set, or a valid snapshot anchor) before the first write. Run → FAIL.

- [ ] **Step 2: Add the r2q fix branch** mirroring the file-set fix lifecycle (`runEndFix`/begin-fix/lock), bounding writes to the `03–07` editable set via the existing fix-guard membership check (extend it to treat `run.md` and non-`03–07` paths as out-of-set for r2q). The fixer edits in place — no versions, no checkpoints, no reopen, no `run.md` write.

- [ ] **Step 3: Run** the new test + `npm run syntaxcheck && npm test` → green.

- [ ] **Step 4: Commit** (`git add lib/workflow/file-set-fix.js lib/fix-guard.js test/r2q-fix.test.js`; message `feat(r2q): in-place backward fix bounded to the 03–07 set, run.md never written`; footer).

---

### Task 10: gate-freshness revalidation (TOCTOU) for r2q

**Files:**
- Modify: `lib/workflow/file-set-fix.js` / `lib/workflow/file-set-finalize.js` (the begin-fix / lock-refresh / end-fix / final-PASS checkpoints)
- Test: `test/r2q-gate-freshness.test.js` (new)

**Interfaces:**
- Consumes: the stored `runMdSha256` (Task 8), `parseRunMdGate` (Task 4).
- Produces: r2q rechecks `run.md` (unchanged fingerprint AND still satisfies the gate) before `begin-fix`, before any lock refresh that precedes writes, after `end-fix`, and before final PASS. If `run.md` changed, became unreadable, or now indicates incomplete/archived/invalid, r2q stops as a guarded drift/blocker instead of writing or passing from stale eligibility.

- [ ] **Step 1: Write failing tests** — start an r2q fix, mutate `run.md` between gate and `begin-fix`, assert the run stops as a guarded drift blocker (not a write, not a PASS); separately mutate `run.md` to an archived/incomplete state mid-run and assert the same. Run → FAIL.

- [ ] **Step 2: Add the revalidation checkpoints** — at each named checkpoint, re-read `run.md`, recompute its sha256, compare to the stored `runMdSha256`, and re-run `parseRunMdGate`; on any mismatch/failure, stop as a guarded blocker. Reuse the existing file-set guard drift/blocker plumbing.

- [ ] **Step 3: Run** the new test + full suite → green.

- [ ] **Step 4: Commit** (`git add lib/workflow/file-set-fix.js lib/workflow/file-set-finalize.js test/r2q-gate-freshness.test.js`; message `feat(r2q): revalidate the run.md gate at every write/PASS checkpoint (TOCTOU)`; footer).

---

### Task 11: r2q finalize — earned PASS + 3b deferral terminal

**Files:**
- Modify: `lib/workflow/file-set-finalize.js`, `lib/final-response.js`
- Test: `test/r2q-finalize.test.js` (new)

**Interfaces:**
- Consumes: the r2q fix + diff-review + re-review results, the guard state, the Item 3b surface-and-defer behavior.
- Produces: r2q PASS is earned the normal way (07-plan reviewed, every blocking finding fixed in 07-plan and/or owning upstream, diff-reviewed, guard satisfied). There is NO `stopped-pending-human` state. A finding needing a human product/risk/scope decision is surfaced + deferred → `stopped-with-deferrals` (not PASS). read-only / advisory (Gemini) / drifted-set runs still cannot PASS.

- [ ] **Step 1: Write failing tests** — (a) a fixable PLAN gap is fixed and r2q reaches `pass`, with `Files changed` listing the edited `03–07` files; (b) a planted human-decision finding (one requiring a product decision) ends `stopped-with-deferrals`, NOT `pass`, with the deferral's owner=user + next action recorded; (c) a Gemini r2q run never reaches `pass`. Run → FAIL.

- [ ] **Step 2: Add the r2q finalize branch** — reuse `validatePass` (require diff-review-complete AND full-re-review-complete, guard satisfied, mode review-and-fix). Ensure the final-response payload's `Files changed` reports the multi-file (03–07) edits and surfaces the accepted execution-state risk note (design Decision 1 "accepted consequence").

- [ ] **Step 3: Run** the new test + full suite → green.

- [ ] **Step 4: Commit** (`git add lib/workflow/file-set-finalize.js lib/final-response.js test/r2q-finalize.test.js`; message `feat(r2q): earn PASS over the 03–07 set; human-decision findings defer, never pending-human`; footer).

---

### Milestone 3 — docs + end-to-end

### Task 12: docs (six routes → seven) + r2q documentation

**Files:**
- Modify: `README.md`, `README.zh-CN.md`, `AGENTS.md`, `CLAUDE.md`, `package.json`, `CHANGELOG.md`

**Interfaces:** None (documentation).

- [ ] **Step 1: Update "six routes" → "seven routes"** everywhere it appears (`grep -rn "six route\|\bsix\b" README.md README.zh-CN.md AGENTS.md CLAUDE.md package.json`), and add `review-fix-r2q` to every route enumeration (the four document + two code routes lists).

- [ ] **Step 2: Document r2q** in `README.md` + `README.zh-CN.md`: a requirement-directory review route that reviews `07-plan.md` with the PLAN rubric and fixes findings backward into the owning upstream docs (`03–06`) in place; `run.md` is a read-only gate (r2q never writes it or invokes the r2p CLI); guard defaults to `snapshot` because active `.req-to-plan/WF-*` dirs are commonly untracked; gating requires plan-generated + not under `*/.req-to-plan/archive/*`; advisory-only on Gemini. State the accepted execution-state risk (no `r2p-execute` marker; archive-location is a pre-archive proxy).

- [ ] **Step 3: Update `AGENTS.md` + `CLAUDE.md`** route/architecture sections to include r2q (`routeKind: 'r2q'`, `targetContextKind: 'r2q'`, document PLAN stack, read-only run.md gate, no r2p CLI).

- [ ] **Step 4: Add the CHANGELOG `### Added` line** under `## Unreleased`:

```markdown
### Added

- **`review-fix-r2q` route.** Reviews an r2p requirement directory's `07-plan.md` with the PLAN rubric and fixes findings backward into the owning upstream docs (`03–06`) in place. `run.md` is a read-only, fingerprinted gate (r2q never writes it or invokes the r2p CLI); the route gates on a generated plan that is not under `*/.req-to-plan/archive/*`, guards the `03–07` edit set with `snapshot` (default) or `git`, and is advisory-only on Gemini.
```

- [ ] **Step 5: Run** `npm run syntaxcheck && npm test` → green (`test/readme-content.test.js` and any "seven routes" content assertions pass).

- [ ] **Step 6: Commit** (`git add README.md README.zh-CN.md AGENTS.md CLAUDE.md package.json CHANGELOG.md`; message `docs(r2q): document review-fix-r2q and update route count to seven`; footer).

---

### Task 13: end-to-end r2q lifecycle + gating tests with a WF-* fixture

**Files:**
- Create: `test/fixtures/r2q/WF-*/…` (a realistic requirement-directory fixture: `03`–`07` + `run.md`)
- Test: `test/r2q-e2e.test.js` (new)

**Interfaces:** Consumes the full r2q route (Tasks 4–12).

- [ ] **Step 1: Build a `WF-*` fixture directory** with `03-requirement-brief.md`, `04-risk-discovery.md`, `05-design.md`, `06-spec.md`, `07-plan.md`, and a `run.md` whose `## Status`/`## Active Artifacts` indicate a generated/approved plan. Include a `07-plan.md` with a planted PLAN-rubric gap whose root cause is upstream (e.g., a missing acceptance criterion owned by `06-spec.md`).

- [ ] **Step 2: Write the e2e tests** exercising:
  - **Gating:** incomplete-plan run.md → `ERR_R2Q_GATE_PLAN_INCOMPLETE` block; archived dir (`…/.req-to-plan/archive/WF-*`) → `ERR_R2Q_GATE_ARCHIVED` block; neither runs a review.
  - **run.md drift:** mutate run.md mid-run → guarded drift blocker (no write, no PASS).
  - **Editable-set enforcement:** a fix never touches `run.md` or any path outside `03–07`.
  - **Default guard:** an untracked `.req-to-plan/WF-*` runs with `guard=snapshot` by default; a tracked-clean fixture runs with optional `guard=git`.
  - **Finding→owner-doc map:** the planted finding edits BOTH `07-plan.md` and the owning `06-spec.md`.
  - **Earned PASS:** the fixed run reaches `pass`; a planted human-decision finding ends `stopped-with-deferrals`, not `pass`.

- [ ] **Step 3: Run** `npm run syntaxcheck && npm test` → full suite green.

- [ ] **Step 4: Commit** (`git add test/fixtures/r2q test/r2q-e2e.test.js`; message `test(r2q): end-to-end lifecycle, gating, drift, editable-set, and finding-to-owner coverage`; footer).

---

## Self-Review

Checked against the design `docs/OPTIMIZATION-2026-06-23-r2q-and-hardening.md`:

**1. Spec coverage.**
- Item 1 (P2 atomicCopyFile) → Task 1. ✅ (helper extraction, both callers, 3 tests, CHANGELOG `### Fixed`).
- Item 2 (P3 strict-verified docs) → Task 2. ✅ (README + README.zh-CN + AGENTS, no history rewrite, no code).
- Item 3a (PLAN TDD/acceptance) → Task 3 Steps 1–2. ✅. Item 3b (no-silent-ambiguity, 3 files + no-interrupt) → Task 3 Steps 3–7. ✅.
- Item 4 Milestone 1 (scaffold + gating + advisory) → Tasks 4–7. ✅. Milestone 2 (backward-fix) → Tasks 8–11. ✅. Milestone 3 (docs + e2e) → Tasks 12–13. ✅.
- Architecture surface (design §"Architecture surface"): routes.js → T6; rulebook → T6; generator + 8 fragments → T6; input → T6; target-context → T4; workflow/no-state/semantic-parsers/final-response → T7–T11; workflow-state/manifest → T5; shared prose → T7; skills/install → T6; tests/fixtures + six→seven → T6/T12/T13; README/AGENTS/CLAUDE/package.json → T12. ✅.
- Guard/PASS/gate-freshness/inherits-3b (design §"Guard, PASS, and the run.md gate") → T9 (guard) / T10 (gate-freshness/TOCTOU) / T11 (earned PASS + 3b deferral). ✅.
- Archive standard `*/.req-to-plan/archive/*` (committed correction) → T4 `isArchivedRequirementDir` + T12 docs. ✅.

**2. Placeholder scan.** No "TBD/TODO/implement later". Phase 1 and the bounded r2q pieces (descriptor, fragments, gate parser, identity, manifest fields) carry complete code. The deep lifecycle tasks (8–11) specify exact files, Consumes/Produces interfaces, the named function to mirror (with file:line), and concrete failing tests — these are precise specs with pattern references, not vague placeholders; the one genuine unknown (exact `run.md` field text) is called out with a first-step verification against a real file. ✅.

**3. Type/name consistency.** `resolveR2qTarget` (T4) → consumed by T6 (target-resolution), T7 (advisory), T8 (context). `runMdSha256`/`fileSetFingerprint` identity fields (T4) → used by T8 (manifest) and T10 (gate-freshness). `targetContextKind: 'r2q'` defined in T5, returned by T4/T6, validated in T5. `MANIFEST_V2_R2Q_FILESET_FIELDS` (T5) consumed by T8. `parseRunMdGate` (T4) reused by T10. `isArchivedRequirementDir` (T4) used by T4 resolution + T12 docs. Editable set `03–07` is consistent across T4/T7/T8/T9/T11/T13. ✅.

**Residual risk (called out, not blocking):** the precise `run.md` parse fields are confirmed only at implementation time (T4 Step 1); the gate predicates and error-loudly contract are fixed regardless. The deep lifecycle integration (T8–T11) depends on file-set machinery the implementer must read via codegraph before writing — each such task names its mirror function and gates on a concrete failing test.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-24-r2q-and-hardening.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks (spec + quality), fast iteration. Tasks 1–3 are mechanical (cheap/standard model); r2q Tasks 4–11 are integration/judgment (standard→capable model, with a codegraph read of the mirror function first).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**
