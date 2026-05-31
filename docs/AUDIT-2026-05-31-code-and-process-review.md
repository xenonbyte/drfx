# Code and Process Review - 2026-05-31

## 中文摘要

这份审查文档记录了 3 个需要处理的问题。P1 是 `drfx uninstall` 可能删除安装后被用户改过的生成文件，属于用户数据风险，应优先修；建议分两步落地——先做文件级 checksum 校验（P1a，改动小、可独立发布），再做 Codex 目录的 tree-checksum（P1b，需把 manifest `schemaVersion` 从 1 升到 2）。P2 是 `guard=snapshot` 对项目树扫描过宽：表面问题是任何 symlink 都会让 guard 不可用，但更主要的矛盾是对 `node_modules` 这类大目录做全树递归 hash，会让 guard 即使可用也慢到不可用，因此基础设施目录排除应作为主方案而非兜底；对无关 symlink 采用"不透明条目"时还要明确残留风险——写穿目录型 symlink 无法被 lstat 检测到。P3 是 npm 包包含 `test/`，增加安装包体积但没有运行时价值，pack 回归检查应把顶层文件集合钉成白名单。

## Summary

This is a read-only audit of the current `@xenonbyte/document-review-fix` repository. The core workflow is in good shape: the CLI, install/uninstall path, route generation, persistent workflow state, fix lifecycle, guards, final response validation, receipts, redaction, and no-state path all have meaningful coverage.

Three issues are worth fixing because they reduce real user risk or operational friction:

| Priority | Area | Finding | Recommended action | Effort |
| --- | --- | --- | --- | --- |
| P1 | Uninstall safety | `drfx uninstall` can remove generated files that were modified after install. | Phase it: P1a compares file checksums on uninstall and skips modified files; P1b records Codex directory tree checksums (manifest `schemaVersion` bump). Preserve partial uninstall state when artifacts are skipped. | P1a small, P1b medium |
| P2 | `guard=snapshot` | Snapshot target-only guard scans the whole project tree, hashes every file, and blocks on any symlink. | Make bounded infrastructure exclusion the primary fix for performance; treat unrelated file symlinks as opaque entries (reject directory symlinks) with an explicit residual-risk note; always disclose the scoped monitor set. | medium–large |
| P3 | Packaging | The npm package includes `test/`, increasing package size without runtime value. | Remove `test/` from `package.json` `files` and add a pack contents check that pins the allowed top-level set as a whitelist. | small |

## Verification Baseline

Commands run during audit:

```bash
npm test
node bin/drfx.js check --json
npm pack --dry-run --json
git status --short
```

Results:

- `npm test`: passed, 421/421.
- `node bin/drfx.js check --json`: passed. Claude, Codex, and Gemini correctly report advisory-only because reviewer isolation and write-blocking are not verified for the current run.
- `npm pack --dry-run --json`: passed. The package includes 80 entries and an unpacked size of 1,001,851 bytes.
- `git status --short`: clean before and after audit.

## P1 - Uninstall Can Delete Modified Generated Files

### Problem

`drfx install` records a checksum for generated file entries, but `drfx uninstall` does not use that checksum before deleting the file. If a user edits an installed command file after installation, uninstall still removes it.

### Evidence

- `lib/install.js` records generated file checksums:
  - [`lib/install.js:329`](../lib/install.js#L329)
  - [`lib/install.js:333`](../lib/install.js#L333)
- `lib/manifest.js` validates path, kind, allowlist, and ownership, but does not compare file contents against `entry.checksum`:
  - [`lib/manifest.js:452`](../lib/manifest.js#L452)
  - [`lib/manifest.js:477`](../lib/manifest.js#L477)
  - [`lib/manifest.js:498`](../lib/manifest.js#L498)
- `lib/install.js` deletes every removable artifact returned by manifest validation:
  - [`lib/install.js:438`](../lib/install.js#L438)
  - [`lib/install.js:441`](../lib/install.js#L441)
  - [`lib/install.js:442`](../lib/install.js#L442)

### Reproduction

A temporary isolated home was used:

1. Install Claude route into a temp `homeDir`.
2. Append user text to `review-fix-spec.md`.
3. Run `uninstallPlatform('claude', ...)`.
4. Result: the modified route no longer exists.

Observed output:

```json
{"routeExists":false}
```

### Impact

This can delete user-modified command files. The current safety model is strong on path containment and symlink refusal, but it treats manifest-recorded files as disposable even when their current contents no longer match the package-generated contents.

Codex skill directories need extra care: an ownership marker proves this package created the directory, but it does not prove every current child file is still package-generated or safe to delete.

### Recommended Fix

Use the manifest checksum as an uninstall precondition. Ship this in two phases — file-level first, directory-level as a follow-up.

#### Phase P1a — file entries (ship first, small)

- If `entry.checksum !== 'none'`, compute the current file checksum and compare it to `entry.checksum`.
- Compute it with the same byte convention as install (`checksumContent(item.content)` in `lib/install.js`): hash the raw file bytes, and do not re-normalize line endings or trailing newlines, or unchanged files will be misreported as `modified`.
- If the current checksum differs, do not delete the file. Return it in `skipped` with a reason such as `modified` or `checksum-mismatch`.
- This closes the file-level data-loss case (Claude and Gemini command files) on its own, with no manifest format change.

#### Phase P1b — Codex skill directories (follow-up, requires a manifest schema bump)

- New manifests should record the generated child file list for each Codex skill directory, derived from `generatePlatformFiles('codex', { packageVersion })` at install time, plus a deterministic tree checksum.
- This is a manifest format change: bump `schemaVersion` from `1` to `2`, and keep reading `schemaVersion: 1` manifests written by older installs.
- Old (`schemaVersion: 1`) manifests have no child file lists or tree checksums. For those, use the conservative path: if an owned directory contains files beyond the known generated names for that package version, skip the directory instead of deleting it.
- Do not delete a directory when the current tree contains user-added files or when tree ownership cannot be proved.

Recommended user-facing behavior:

- Prefer skip-and-report over failing the whole uninstall. It preserves user data and still removes artifacts that remain package-owned and unchanged.
- If any artifact is skipped, return a partial uninstall result and keep or update the manifest so ownership and skipped paths are not lost. The CLI should print a visible partial status instead of only `uninstalled: <platform>`.
- If all manifest-recorded generated artifacts are removed, remove the manifest as it does today.
- If a manifest itself is corrupt, keep the current fail-fast behavior.

### Tests to Add

- `uninstall skips modified manifest-recorded Claude command file`.
- `uninstall skips modified manifest-recorded Gemini command file`.
- `uninstall skips owned Codex skill directory when it contains an unknown user file`.
- `uninstall removes unchanged generated files and directories as before`.
- `partial uninstall preserves manifest ownership for skipped modified artifacts`.

## P2 - Snapshot Guard Over-Scans Project Trees

### Problem

`guard=snapshot` uses a project-tree monitor to prove target-only writes. It recursively scans the full project root and rejects any symlink it encounters. This creates real friction in common repositories that contain `node_modules`, package-manager symlinks, `.git`, build caches, or generated directories.

### Evidence

- Recursive scan starts at project root:
  - [`lib/snapshot-guard.js:277`](../lib/snapshot-guard.js#L277)
  - [`lib/snapshot-guard.js:302`](../lib/snapshot-guard.js#L302)
- Every symlink under the scan root blocks the guard:
  - [`lib/snapshot-guard.js:290`](../lib/snapshot-guard.js#L290)
  - [`lib/snapshot-guard.js:291`](../lib/snapshot-guard.js#L291)
- The current monitor scope is documented as `project-tree-files-and-references`:
  - [`lib/snapshot-guard.js:336`](../lib/snapshot-guard.js#L336)

### Reproduction

A temporary project containing `node_modules/pkg` and a symlinked package under `node_modules` was checked with `checkSnapshotTargetOnly(...)`. On a symlink the guard throws: `collectMonitorRecords` raises a `guardError`, and `checkSnapshotTargetOnly` re-throws it because the error carries `blockingReason`. So the JSON below is the thrown error serialized, not a returned value, and the actual property name is `error.code` — it is shown as `errorCode` here only for readability.

Serialized thrown error:

```json
{
  "errorCode": "ERR_TARGET_ONLY_GUARD_UNAVAILABLE",
  "blockingReason": "target-only-guard-unavailable",
  "message": "target-only-guard-unavailable: monitored project directory entry must not be a symlink"
}
```

### Impact

Two separate problems are bundled here. The symlink policy makes `guard=snapshot` unavailable in normal Node repositories. Independently, the full-tree scan hashes every non-symlink file under the root, so a populated `node_modules` (tens of thousands of files) makes each guard run slow even after the symlink issue is fixed. The feature is intended as the fallback when Git rollback is unavailable, but either problem can make that fallback unusable for reasons unrelated to the target document.

### Recommended Fix

Keep the safety invariant explicit. The current guard proves target-only changes across the scanned project tree. A fix that skips directories without recording the reduced scope would weaken that proof.

Recommended behavior:

Because the performance problem dominates in real Node repositories (see Impact), bounded infrastructure exclusion is the primary fix, not a fallback. The steps are ordered so the safety invariants — rejecting symlink targets and refs — stay first.

1. Always reject symlink targets.
2. Always reject symlink `ref=` documents.
3. Bound the traversal (primary fix): exclude well-known infrastructure directories from recursive monitoring by default, so a populated `node_modules` is not hashed on every guard run. Whenever any directory is excluded, return and persist an explicit `monitorScope` such as `project-tree-files-and-references-excluding-infrastructure`, plus the excluded directory names. Documentation must state that target-only proof is scoped to that monitor set.
4. For symlinks that remain inside the monitored set, do not follow them. Record file symlinks as opaque monitored entries with lstat-derived metadata and a path hash; if an opaque entry changes between baseline and end-fix inspection, block with `unexpected-worktree-change`. Reject directory symlinks instead of treating them as opaque (see residual risk below).
5. Keep ordinary non-target project files in the baseline so non-target edits still block automatic fixing.

Residual risk to disclose: an opaque, lstat-only entry does not detect writes made *through* a symlink to its resolved target. For a directory symlink this could let a fixer modify content outside the monitored tree undetected — exactly the proof `guard=snapshot` claims to provide. Treating only file symlinks as opaque and rejecting directory symlinks keeps that hole closed. If directory symlinks must ever be tolerated, the docs must state that target-only proof excludes writes made through them.

Default infrastructure exclusions for bounded traversal:

```text
.git
node_modules
.pnpm-store
.yarn
.cache
dist
build
coverage
```

Avoid a user-configurable ignore file until there is a clear product requirement. Configurable ignores can hide non-target writes and make the guard claim stronger proof than it has.

### Tests to Add

- `snapshot target-only guard records unrelated file symlinks as opaque entries without following them`.
- `snapshot target-only guard rejects a directory symlink instead of treating it as opaque`.
- `snapshot target-only guard still rejects symlink target`.
- `snapshot target-only guard still rejects symlink reference`.
- `snapshot target-only guard still blocks ordinary non-target file changes`.
- `snapshot target-only guard blocks when an opaque symlink entry changes`.
- `snapshot target-only guard excludes infrastructure directories and records them in monitorScope and the persisted guard report`.
- `snapshot target-only guard stays responsive with a populated node_modules (infrastructure not hashed)`.

### Documentation to Update

- `README.md`
- `README.zh-CN.md`
- `shared/core.md`

Document that `guard=snapshot` monitors target and refs, ordinary project files, and unrelated symlinks as opaque entries when applicable.

If bounded infrastructure exclusions are added, docs must use scoped wording. They should not say snapshot mode proves target-only writes across the whole project tree.

## P3 - npm Package Includes Tests

### Problem

`package.json` includes `test/` in the published package file list.

### Evidence

`package.json`:

```json
"files": ["bin/", "lib/", "skills/", "shared/", "templates/", "test/", "README.md", "README.zh-CN.md"]
```

Source: [`package.json:11`](../package.json#L11).

`npm pack --dry-run --json` reports:

- 80 package entries.
- unpacked size: 1,001,851 bytes.
- test files included: 27 files.
- local `test/` size: about 496 KB.

### Impact

The tests are valuable in the repository but not required at runtime. Publishing them increases install payload and exposes internal fixtures without improving user behavior.

### Recommended Fix

Remove `test/` from `package.json` `files`.

Add a regression test or release check that runs `npm pack --dry-run --json` and asserts:

- The published top-level entries are exactly `bin/`, `lib/`, `skills/`, `shared/`, `templates/`, `README.md`, and `README.zh-CN.md`. Pin this as a whitelist so any future addition fails the check, not only `test/`.
- `test/` and its fixtures are absent.

## Not Recommended Right Now

### Defer splitting `lib/workflow/helpers.js` (known debt, not "no problem")

[`lib/workflow/helpers.js`](../lib/workflow/helpers.js) is about 1,988 lines — well past the 300–500 line guideline — so it is real structural debt, not a clean file. It is deferred, not dismissed: it is currently guarded by [`test/workflow-module-boundaries.test.js`](../test/workflow-module-boundaries.test.js), and no immediate correctness failure forces a refactor now. When it is split, the stable seams are reports, receipts, manifest path resolution, and final-state assembly.

### Do not add configurable snapshot ignore rules yet

Configurable ignores would add policy complexity and could weaken the safety model. Use a fixed, code-owned set of infrastructure exclusions with explicit scoped monitor output, not a user-editable ignore file. The distinction matters: fixed exclusions keep the monitor scope auditable, while user ignores could silently hide non-target writes and let the guard claim stronger proof than it has.

## Suggested Implementation Order

1. P1 first — the only finding with direct user data loss risk. Effort: P1a (file-level checksum skip) is small and ships independently; P1b (Codex directory tree-checksum plus the manifest `schemaVersion` bump) is medium and can follow.
2. P2 second — improves `guard=snapshot` usability without changing the main `guard=git` path. Effort: medium–large, because the primary fix is bounded traversal plus scoped `monitorScope` plumbing, not just symlink handling.
3. P3 last — low risk, handled with a whitelist-pinned pack contents check. Effort: small.

## Acceptance Criteria

P1:

- (P1a) Modified generated files are not deleted on uninstall.
- (P1a) Unchanged generated files are still removed.
- (P1a) Uninstall result reports skipped modified artifacts clearly, and the CLI prints a visible partial status instead of only `uninstalled: <platform>`.
- (P1b) Codex owned directories are not deleted if they contain user-added files.
- Partial uninstall keeps or updates manifest state for skipped artifacts.

P2:

- Snapshot guard works and stays responsive in a project with a populated `node_modules` (infrastructure directories are not hashed on every run).
- Target and explicit references remain symlink-protected; directory symlinks inside the monitored set are rejected, not treated as opaque.
- Non-target ordinary project changes still block automatic fixing.
- Excluded infrastructure directories are recorded in the persisted guard output as a scoped monitor set.
- Docs describe the monitor scope accurately and disclose the opaque-entry residual risk.

P3:

- `npm pack --dry-run --json` no longer includes `test/`.
- Runtime package files remain present.
- README behavior stays structurally aligned between English and Simplified Chinese.

## Verification Plan

Targeted checks:

```bash
node --test test/capability-check.test.js test/snapshot-guard.test.js test/shared-assets.test.js
npm pack --dry-run --json
```

Full check:

```bash
npm test
node bin/drfx.js check --json
git status --short
```
