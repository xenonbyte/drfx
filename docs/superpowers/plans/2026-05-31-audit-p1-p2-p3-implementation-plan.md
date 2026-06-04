# Audit P1/P2/P3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three findings from `docs/AUDIT-2026-05-31-code-and-process-review.md` — uninstall can delete user-modified files (P1), `guard=snapshot` over-scans and rejects all symlinks (P2), and the npm package ships `test/` (P3) — without weakening the existing safety model.

**Architecture:** Four independently-committable phases ordered by risk and dependency. Phase 1 (P3) and Phase 2 (P1a) are small and isolated. Phase 3 (P2) is contained to `lib/snapshot-guard.js`; the richer guard result rides through the already-persisted guard report, so no workflow-layer change is needed. Phase 4 (P1b) is a manifest schema v1→v2 migration and is the heaviest phase — it is last so the first three ship value immediately.

**Tech Stack:** Node.js 20 CommonJS, `node:test` + `node:assert/strict`, no external deps. SHA-256 via `node:crypto`. Manifest is a custom line-based text format in `lib/manifest.js`.

---

## File Structure

| File | Responsibility | Phases |
| --- | --- | --- |
| `package.json` | Drop `test/` from `files` | P3 |
| `test/shared-assets.test.js` | Update the existing `packageJson.files` deepEqual | P3 |
| `test/pack-contents.test.js` (new) | Whitelist-pin the published top-level entries | P3 |
| `lib/manifest.js` | `validateGeneratedRemoval` skips modified files (P1a); schema v2 grammar + child-list/tree-checksum (P1b) | P1a, P1b |
| `lib/install.js` | Conditional manifest/descriptor removal on partial uninstall (P1a); record v2 directory metadata at install (P1b) | P1a, P1b |
| `bin/drfx.js` | Print partial uninstall status | P1a |
| `test/capability-check.test.js` | Uninstall-skip tests; uses existing `makeInstallFixture(t)` | P1a |
| `lib/snapshot-guard.js` | Infrastructure exclusion, opaque file symlinks, directory-symlink rejection, target/ref precedence, dynamic `monitorScope` | P2 |
| `test/snapshot-guard.test.js` | P2 behavior tests; uses existing `makeWorkspace(t)` | P2 |
| `test/manifest-schema-v2.test.js` (new) | Schema v2 round-trip + conservative directory uninstall | P1b |
| `README.md`, `README.zh-CN.md`, `shared/core.md` | Document the scoped monitor set | P2 |

**Ordering / dependency note:** Phases are independent. Recommended order P3 → P1a → P2 → P1b. P1b builds on the P1a `skipped`/`partial` plumbing, so do P1a before P1b.

---

## Phase 1 — P3: Stop shipping `test/`

### Task 1.1: Add a failing pack-contents whitelist test

**Files:**
- Create: `test/pack-contents.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function packTopLevelEntries() {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  const report = JSON.parse(stdout);
  const files = report[0].files.map((entry) => entry.path);
  return new Set(files.map((p) => (p.includes('/') ? `${p.split('/')[0]}/` : p)));
}

test('npm pack ships exactly the runtime whitelist and no tests', () => {
  const tops = packTopLevelEntries();
  const expected = [
    'README.md',
    'README.zh-CN.md',
    'bin/',
    'lib/',
    'package.json',
    'shared/',
    'skills/',
    'templates/'
  ];
  assert.deepEqual([...tops].sort(), expected);
  assert.equal(tops.has('test/'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pack-contents.test.js`
Expected: FAIL — actual top-level set still contains `test/`, so `deepEqual` mismatches and `tops.has('test/')` is `true`.

### Task 1.2: Remove `test/` and update the existing file-list expectation

**Files:**
- Modify: `package.json:11`
- Modify: `test/shared-assets.test.js:283-292`

- [ ] **Step 1: Remove `test/` from `package.json` `files`**

Change line 11 from:

```json
"files": ["bin/", "lib/", "skills/", "shared/", "templates/", "test/", "README.md", "README.zh-CN.md"],
```

to:

```json
"files": ["bin/", "lib/", "skills/", "shared/", "templates/", "README.md", "README.zh-CN.md"],
```

- [ ] **Step 2: Update the existing deepEqual in `test/shared-assets.test.js`**

Change the array at lines 283-292 from `['bin/', 'lib/', 'skills/', 'shared/', 'templates/', 'test/', 'README.md', 'README.zh-CN.md']` to drop `'test/'`:

```js
  assert.deepEqual(packageJson.files, [
    'bin/',
    'lib/',
    'skills/',
    'shared/',
    'templates/',
    'README.md',
    'README.zh-CN.md'
  ]);
```

- [ ] **Step 3: Run the affected tests**

Run: `node --test test/pack-contents.test.js test/shared-assets.test.js`
Expected: PASS (both).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json test/shared-assets.test.js test/pack-contents.test.js
git commit -m "chore: drop test/ from published package and pin pack whitelist"
```

---

## Phase 2 — P1a: Uninstall must not delete user-modified files

### Task 2.1: Skip modified files in `validateGeneratedRemoval`

**Files:**
- Modify: `lib/manifest.js` (add `crypto` import + `sha256File` helper; file branch in `validateGeneratedRemoval`)
- Test: `test/capability-check.test.js`

- [ ] **Step 1: Write the failing test (append to `test/capability-check.test.js`)**

```js
test('uninstall skips a modified Claude command file and retains the manifest', async (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  await installPlatform('claude', { homeDir, platformRoots });
  const routePath = path.join(platformRoots.claude, 'commands', 'review-fix-spec.md');
  fs.appendFileSync(routePath, '\n<!-- user edit -->\n');

  const result = await uninstallPlatform('claude', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.reason === 'modified' && s.path === routePath));
  assert.equal(fs.existsSync(routePath), true);
  const manifestPath = path.join(homeDir, '.drfx', 'manifests', 'claude.manifest');
  assert.equal(fs.existsSync(manifestPath), true);
  const retained = readInstallManifest('claude', { homeDir }).manifest.generated.map((entry) => entry.path);
  assert.deepEqual(retained, [routePath]);
  assert.equal(fs.existsSync(path.join(homeDir, '.drfx', 'capabilities', 'claude.json')), true);
});

test('uninstall skips a modified Gemini command file and retains the manifest', async (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  await installPlatform('gemini', { homeDir, platformRoots });
  const routePath = path.join(platformRoots.gemini, 'commands', 'review-fix-spec.toml');
  fs.appendFileSync(routePath, '\n# user edit\n');

  const result = await uninstallPlatform('gemini', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.reason === 'modified' && s.path === routePath));
  assert.equal(fs.existsSync(routePath), true);
  const retained = readInstallManifest('gemini', { homeDir }).manifest.generated.map((entry) => entry.path);
  assert.deepEqual(retained, [routePath]);
  assert.equal(fs.existsSync(path.join(homeDir, '.drfx', 'capabilities', 'gemini.json')), true);
});

test('uninstall still removes an unchanged Claude command file and its manifest', async (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  await installPlatform('claude', { homeDir, platformRoots });
  const routePath = path.join(platformRoots.claude, 'commands', 'review-fix-spec.md');

  const result = await uninstallPlatform('claude', { homeDir, platformRoots });

  assert.notEqual(result.partial, true);
  assert.equal(fs.existsSync(routePath), false);
  const manifestPath = path.join(homeDir, '.drfx', 'manifests', 'claude.manifest');
  assert.equal(fs.existsSync(manifestPath), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/capability-check.test.js`
Expected: FAIL — the modified file is currently deleted and `result.partial` is `undefined`.

- [ ] **Step 3: Add the checksum helper to `lib/manifest.js`**

After the existing `const path = require('node:path');` (line 5), add:

```js
const crypto = require('node:crypto');
```

After `function pathExists(...)` (near line 244), add:

```js
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
```

(This matches install-side `checksumContent` = `sha256(Buffer.from(content))`, since the file bytes on disk equal the written content for an unmodified file.)

- [ ] **Step 4: Skip modified files in the removable loop**

In `validateGeneratedRemoval`, replace the file branch (current lines 489-496):

```js
    } else if (!lstat.isFile()) {
      fail('ERR_FILE_KIND', `generated path is not a file: ${entry.path}`);
    } else if (manifest.platform === 'codex') {
      const skillDirectory = codexSkillDirectoryFor(entry.path, { platformRoots });
      if (skillDirectory && !hasOwnershipMarker(skillDirectory)) {
        fail('ERR_DIRECTORY_OWNERSHIP', `Codex skill file removal requires ownership marker; refusing non-owned directory: ${skillDirectory}`);
      }
    }
```

with:

```js
    } else if (!lstat.isFile()) {
      fail('ERR_FILE_KIND', `generated path is not a file: ${entry.path}`);
    } else {
      if (entry.checksum !== 'none' && sha256File(entry.path) !== entry.checksum) {
        skipped.push({ path: entry.path, kind: entry.kind, removable: false, reason: 'modified' });
        continue;
      }
      if (manifest.platform === 'codex') {
        const skillDirectory = codexSkillDirectoryFor(entry.path, { platformRoots });
        if (skillDirectory && !hasOwnershipMarker(skillDirectory)) {
          fail('ERR_DIRECTORY_OWNERSHIP', `Codex skill file removal requires ownership marker; refusing non-owned directory: ${skillDirectory}`);
        }
      }
    }
```

- [ ] **Step 5: Run to verify the skip test passes (manifest still retained needs Task 2.2)**

Run: `node --test test/capability-check.test.js`
Expected: the modified Claude and Gemini files now survive and appear in `skipped`. Both modified-file tests may still fail on retained-manifest and capability-descriptor assertions until Task 2.2 makes manifest/descriptor removal conditional and rewrites retained manifest state. The unchanged-file test should PASS.

### Task 2.2: Make manifest + descriptor removal conditional on retained files

**Files:**
- Modify: `lib/install.js` `uninstallPlatform` (lines 434-455)

- [ ] **Step 1: Replace the removal finalization in `uninstallPlatform`**

Replace (current lines 445-454):

```js
  const descriptorRemoved = removeCapabilityDescriptor(descriptorRemoval);
  fs.unlinkSync(manifestPath);

  return {
    platform: normalizedPlatform,
    missing: false,
    removed,
    skipped: validation.skipped,
    descriptorRemoved
  };
```

with:

```js
  const skipped = validation.skipped || [];
  const retained = skipped.filter((item) => item.reason === 'modified');
  const partial = retained.length > 0;

  let descriptorRemoved = false;
  if (!partial) {
    descriptorRemoved = removeCapabilityDescriptor(descriptorRemoval);
    fs.unlinkSync(manifestPath);
  } else {
    const manifest = manifestRead.manifest;
    const retainedPaths = new Set(retained.map((item) => item.path));
    writeInstallManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      generated: manifest.generated.filter((entry) => retainedPaths.has(entry.path))
    }, { homeDir });
  }

  return {
    platform: normalizedPlatform,
    missing: false,
    partial,
    removed,
    skipped,
    descriptorRemoved
  };
```

(`partial` is keyed only on `reason === 'modified'`. Pre-deleted files still carry `reason: 'missing'` and do NOT block manifest cleanup, preserving current behavior.)

- [ ] **Step 2: Run to verify both new tests pass**

Run: `node --test test/capability-check.test.js`
Expected: PASS (the modified Claude and Gemini tests assert the retained manifest contains only the skipped modified artifact, and that the capability descriptor remains while that artifact remains).

### Task 2.3: Surface partial status at the CLI

**Files:**
- Modify: `bin/drfx.js` (uninstall branch, lines 99-103)

- [ ] **Step 1: Replace the uninstall output branch**

Replace:

```js
  if (command === 'uninstall') {
    const result = await uninstallPlatforms({ platforms });
    process.stdout.write(`uninstalled: ${Object.keys(result.platforms).join(', ')}\n`);
    return 0;
  }
```

with:

```js
  if (command === 'uninstall') {
    const result = await uninstallPlatforms({ platforms });
    const entries = Object.entries(result.platforms);
    const fullyDone = entries.filter(([, o]) => !o.partial && !o.missing).map(([p]) => p);
    const lines = [];
    if (fullyDone.length > 0) lines.push(`uninstalled: ${fullyDone.join(', ')}`);
    for (const [platform, outcome] of entries) {
      if (outcome.missing) {
        lines.push(`not installed: ${platform}`);
      } else if (outcome.partial) {
        const modified = (outcome.skipped || []).filter((s) => s.reason === 'modified').length;
        lines.push(`partially uninstalled: ${platform} (kept ${modified} modified file(s); manifest retained)`);
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS. If an existing test in `test/capability-check.test.js` asserts the old comma-joined `uninstalled:` output for a missing platform, update that assertion to the new `not installed: <platform>` line shown above.

- [ ] **Step 3: Commit**

```bash
git add lib/manifest.js lib/install.js bin/drfx.js test/capability-check.test.js
git commit -m "fix: skip user-modified files on uninstall and report partial status"
```

---

## Phase 3 — P2: Snapshot guard scoping (contained to `lib/snapshot-guard.js`)

**Why no workflow change:** `lib/workflow/fix-lifecycle.js:224` persists the whole `targetOnlyGuard` object via `writeBeginFixGuardReport`, and end-fix reads it back at line 409. A richer return value (`monitorScope`, `excludedDirectories`) rides through unchanged.

### Task 3.1: Infrastructure exclusion + dynamic `monitorScope`

**Files:**
- Modify: `lib/snapshot-guard.js` (`collectMonitorRecords`, `checkSnapshotTargetOnly`)
- Test: `test/snapshot-guard.test.js`

- [ ] **Step 1: Write failing tests (append to `test/snapshot-guard.test.js`)**

```js
test('snapshot target-only guard excludes infrastructure directories and records the scoped monitor set', (t) => {
  const fixture = makeWorkspace(t);
  fs.mkdirSync(path.join(fixture.root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

  const guard = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });

  assert.equal(guard.status, 'passed');
  assert.equal(guard.monitorScope, 'project-tree-files-and-references-excluding-infrastructure');
  assert.ok(guard.excludedDirectories.includes('node_modules'));
  assert.equal(guard.entries.some((e) => e.path.startsWith('node_modules/')), false);
});

test('snapshot target-only guard keeps the plain scope when no infrastructure dir is present', (t) => {
  const fixture = makeWorkspace(t);
  const guard = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  assert.equal(guard.monitorScope, 'project-tree-files-and-references');
  assert.deepEqual(guard.excludedDirectories, []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/snapshot-guard.test.js`
Expected: FAIL — `monitorScope` is the static string and `excludedDirectories` is `undefined`.

- [ ] **Step 3: Add the exclusion set and helper near the top of `lib/snapshot-guard.js`**

After the imports (after line 10), add:

```js
const INFRASTRUCTURE_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.yarn',
  '.cache',
  'dist',
  'build',
  'coverage'
]);
```

- [ ] **Step 4: Thread exclusion + precedence through `collectMonitorRecords`**

First update `uniqueByPath` so explicit target/reference records win over project-tree neighbor records when the same path appears twice. Replace `uniqueByPath` (lines 252-261) with:

```js
function uniqueByPath(records) {
  const byPath = new Map();
  const priority = { neighbor: 0, 'opaque-symlink': 1, reference: 2, target: 3 };
  for (const record of records) {
    const previous = byPath.get(record.path);
    if (!previous || (priority[record.role] || 0) >= (priority[previous.role] || 0)) {
      byPath.set(record.path, record);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}
```

Replace the body of `collectMonitorRecords` from `const records = [];` (line 276) through `collectDirectory(monitorRoot);` (line 302) with:

```js
  const records = [];
  const excludedDirectories = [];
  const monitorRoot = path.resolve(projectRoot);
  const stateDir = allowedStateDir ? path.resolve(allowedStateDir) : null;

  const monitoredPaths = [path.resolve(targetPath), ...(referencePaths || []).map((referencePath) =>
    path.isAbsolute(referencePath) ? referencePath : path.resolve(projectRoot, referencePath))];
  for (const [index, monitoredPath] of monitoredPaths.entries()) {
    let lstat;
    try {
      lstat = fs.lstatSync(monitoredPath);
    } catch (error) {
      throw guardError('target-only-guard-unavailable', index === 0 ? 'target is unreadable' : 'reference is unreadable', { cause: error });
    }
    if (lstat.isSymbolicLink()) {
      throw guardError('target-only-guard-unavailable', index === 0 ? 'target must not be a symlink' : 'reference must not be a symlink');
    }
  }
  function containsMonitoredPath(directoryPath) {
    return monitoredPaths.some((monitored) => isInsideOrEqual(monitored, directoryPath));
  }

  function collectDirectory(directoryPath) {
    let entries;
    try {
      entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw guardError('target-only-guard-unavailable', 'monitored project directory is unreadable', { cause: error });
    }

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (stateDir && isInsideOrEqual(entryPath, stateDir)) continue;
      if (entry.isSymbolicLink()) {
        let resolved;
        try {
          resolved = fs.statSync(entryPath);
        } catch {
          resolved = null;
        }
        if (resolved && resolved.isDirectory()) {
          throw guardError('target-only-guard-unavailable', 'monitored directory symlink is not supported');
        }
        records.push(symlinkOpaqueRecord({ projectRoot, filePath: entryPath }));
        continue;
      }
      if (entry.isDirectory()) {
        if (INFRASTRUCTURE_DIRECTORIES.has(entry.name) && !containsMonitoredPath(entryPath)) {
          excludedDirectories.push(toPosix(path.relative(monitorRoot, entryPath)));
          continue;
        }
        collectDirectory(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const role = path.resolve(entryPath) === path.resolve(targetPath) ? 'target' : 'neighbor';
      records.push(monitorPathRecord({ projectRoot, filePath: entryPath, normalizedTarget, role }));
    }
  }
  collectDirectory(monitorRoot);
```

Then change the `return` of `collectMonitorRecords` (line 315) from:

```js
  return { normalizedTarget, records: uniqueByPath(records) };
```

to:

```js
  return { normalizedTarget, records: uniqueByPath(records), excludedDirectories: excludedDirectories.sort() };
```

- [ ] **Step 5: Return dynamic `monitorScope` from `checkSnapshotTargetOnly`**

Replace the success return inside `checkSnapshotTargetOnly` (lines 326-338):

```js
    const { records } = collectMonitorRecords({
      projectRoot,
      targetPath,
      allowedStateDir,
      expectedNormalizedTarget,
      referencePaths
    });
    return {
      status: 'passed',
      guardMode: 'snapshot',
      monitorScope: 'project-tree-files-and-references',
      entries: records
    };
```

with:

```js
    const { records, excludedDirectories } = collectMonitorRecords({
      projectRoot,
      targetPath,
      allowedStateDir,
      expectedNormalizedTarget,
      referencePaths
    });
    return {
      status: 'passed',
      guardMode: 'snapshot',
      monitorScope: excludedDirectories.length > 0
        ? 'project-tree-files-and-references-excluding-infrastructure'
        : 'project-tree-files-and-references',
      excludedDirectories,
      entries: records
    };
```

- [ ] **Step 6: Add the opaque symlink record builder**

Before `function monitorPathRecord(...)` (line 234), add:

```js
function symlinkOpaqueRecord({ projectRoot, filePath }) {
  const projectRelative = relativeToProject(projectRoot, filePath);
  if (!projectRelative) {
    throw guardError('target-only-guard-unavailable', 'monitored symlink must be inside project root');
  }
  let lstat;
  let linkTarget;
  try {
    lstat = fs.lstatSync(filePath);
    linkTarget = fs.readlinkSync(filePath);
  } catch (error) {
    throw guardError('target-only-guard-unavailable', 'monitored symlink is unreadable', { cause: error });
  }
  return {
    path: projectRelative,
    pathSha256: pathSha256(filePath),
    role: 'opaque-symlink',
    linkTargetSha256: crypto.createHash('sha256').update(linkTarget).digest('hex'),
    mode: lstat.mode
  };
}
```

- [ ] **Step 7: Run the new tests**

Run: `node --test test/snapshot-guard.test.js`
Expected: the two Task 3.1 tests PASS. (Opaque-symlink behavior is covered in Task 3.2.)

### Task 3.2: Opaque file symlinks, directory-symlink rejection, change detection

**Files:**
- Modify: `lib/snapshot-guard.js` (`inspectActualChangedFilesSnapshot` comparison)
- Test: `test/snapshot-guard.test.js`

- [ ] **Step 1: Write failing tests**

```js
test('snapshot target-only guard records an unrelated file symlink as opaque without following it', (t) => {
  const fixture = makeWorkspace(t);
  const realFile = path.join(fixture.root, 'docs', 'real.md');
  fs.writeFileSync(realFile, '# Real\n');
  fs.symlinkSync(realFile, path.join(fixture.root, 'docs', 'link.md'));

  const guard = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  const link = guard.entries.find((e) => e.path === 'docs/link.md');
  assert.equal(link.role, 'opaque-symlink');
  assert.ok(link.linkTargetSha256);
});

test('snapshot target-only guard rejects a directory symlink instead of treating it as opaque', (t) => {
  const fixture = makeWorkspace(t);
  fs.symlinkSync(path.join(fixture.root, 'other'), path.join(fixture.root, 'docs', 'otherlink'));
  assert.throws(
    () => checkSnapshotTargetOnly({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      allowedStateDir: fixture.targetStateDir,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error.blockingReason === 'target-only-guard-unavailable'
  );
});

test('snapshot target-only guard rejects a symlink target', (t) => {
  const fixture = makeWorkspace(t);
  const outside = path.join(fixture.root, 'outside-target.md');
  fs.writeFileSync(outside, '# Outside\n');
  fs.rmSync(fixture.target);
  fs.symlinkSync(outside, fixture.target);

  assert.throws(
    () => checkSnapshotTargetOnly({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      allowedStateDir: fixture.targetStateDir,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error.blockingReason === 'target-only-guard-unavailable'
  );
});

test('snapshot target-only guard rejects a symlink reference', (t) => {
  const fixture = makeWorkspace(t);
  const realReference = path.join(fixture.root, 'real-ref.md');
  fs.writeFileSync(realReference, '# Real ref\n');
  fs.rmSync(fixture.reference);
  fs.symlinkSync(realReference, fixture.reference);

  assert.throws(
    () => checkSnapshotTargetOnly({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      allowedStateDir: fixture.targetStateDir,
      expectedNormalizedTarget: 'docs/target.md',
      referencePaths: [fixture.reference]
    }),
    (error) => error.blockingReason === 'target-only-guard-unavailable'
  );
});

test('snapshot inspection blocks when an opaque symlink is retargeted', (t) => {
  const fixture = makeWorkspace(t);
  const realA = path.join(fixture.root, 'docs', 'a.md');
  const realB = path.join(fixture.root, 'docs', 'b.md');
  fs.writeFileSync(realA, '# A\n');
  fs.writeFileSync(realB, '# B\n');
  const link = path.join(fixture.root, 'docs', 'link.md');
  fs.symlinkSync(realA, link);

  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  fs.rmSync(link);
  fs.symlinkSync(realB, link);

  const result = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/snapshot-guard.test.js`
Expected: the opaque-record and directory-rejection tests already pass from Task 3.1; the retarget test FAILS because `inspectActualChangedFilesSnapshot` compares `fingerprintChanged` (sha256/size), which are `undefined` for opaque entries, so a retarget is not detected.

- [ ] **Step 3: Add a role-aware change comparator**

After `function fingerprintChanged(...)` (line 354), add:

```js
function monitorEntryChanged(previous, current) {
  if (!previous || !current) return true;
  if (current.role === 'opaque-symlink' || previous.role === 'opaque-symlink') {
    return previous.role !== current.role ||
      previous.linkTargetSha256 !== current.linkTargetSha256 ||
      previous.mode !== current.mode;
  }
  return fingerprintChanged(previous, current);
}
```

- [ ] **Step 4: Use it in `inspectActualChangedFilesSnapshot`**

In the neighbor comparison (line 389), change:

```js
      else if (fingerprintChanged(previous, current)) blockedEntries.push(redactedEntry(entryPath, 'modified'));
```

to:

```js
      else if (monitorEntryChanged(previous, current)) blockedEntries.push(redactedEntry(entryPath, 'modified'));
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/snapshot-guard.test.js`
Expected: PASS (all P2 tests).

### Task 3.3: Target/ref-under-infrastructure precedence test

**Files:**
- Test: `test/snapshot-guard.test.js`

- [ ] **Step 1: Write the test (the implementation already supports it via `containsMonitoredPath`)**

```js
test('snapshot target-only guard does not exclude a target that lives under an infrastructure dir', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-infra-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist', 'docs'), { recursive: true });
  const target = path.join(root, 'dist', 'docs', 'target.md');
  fs.writeFileSync(target, '# Target\n');
  const stateDir = path.join(root, '.drfx', 'targets', 'x');

  const guard = checkSnapshotTargetOnly({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: stateDir,
    expectedNormalizedTarget: 'dist/docs/target.md'
  });

  assert.equal(guard.status, 'passed');
  assert.equal(guard.entries.some((e) => e.path === 'dist/docs/target.md'), true);
  assert.equal(guard.excludedDirectories.includes('dist'), false);
});

test('snapshot target-only guard does not exclude a reference that lives under an infrastructure dir', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-ref-infra-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'refs'), { recursive: true });
  const target = path.join(root, 'docs', 'target.md');
  const reference = path.join(root, 'dist', 'refs', 'reference.md');
  fs.writeFileSync(target, '# Target\n');
  fs.writeFileSync(reference, '# Reference\n');
  const stateDir = path.join(root, '.drfx', 'targets', 'x');

  const guard = checkSnapshotTargetOnly({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: stateDir,
    expectedNormalizedTarget: 'docs/target.md',
    referencePaths: [reference]
  });

  assert.equal(guard.status, 'passed');
  assert.equal(guard.entries.some((e) => e.path === 'dist/refs/reference.md'), true);
  assert.equal(guard.entries.find((e) => e.path === 'dist/refs/reference.md').role, 'reference');
  assert.equal(guard.excludedDirectories.includes('dist'), false);

  const actual = inspectActualChangedFilesSnapshot({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: stateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: guard
  });
  assert.equal(actual.status, 'passed');
});
```

- [ ] **Step 2: Run**

Run: `node --test test/snapshot-guard.test.js`
Expected: PASS — `dist` is not excluded when it contains either the target or an explicit reference.

### Task 3.4: Persisted monitor scope + documentation + commit

**Files:**
- Test: `test/snapshot-guard.test.js`
- Modify: `README.md`, `README.zh-CN.md`, `shared/core.md`

- [ ] **Step 1: Add a guard-report persistence test**

The begin-fix guard report is written by `formatFixGuardReport` (`lib/fix-guard.js`), which `JSON.stringify`s the whole `targetOnlyGuard` object inside a fenced ```json block, and end-fix reads it back wholesale. This test pins that the new scope metadata survives that round-trip. Add the import near the top of `test/snapshot-guard.test.js`:

```js
const { formatFixGuardReport } = require('../lib/fix-guard');
```

and append:

```js
test('fix guard report persists monitorScope and excludedDirectories', () => {
  const report = formatFixGuardReport({
    round: 1,
    normalizedTarget: 'docs/target.md',
    targetFingerprint: { sha256: 'x', size: 1 },
    referenceFingerprints: [],
    rollbackAnchor: { status: 'passed', guardMode: 'snapshot' },
    targetOnlyGuard: {
      status: 'passed',
      guardMode: 'snapshot',
      monitorScope: 'project-tree-files-and-references-excluding-infrastructure',
      excludedDirectories: ['node_modules'],
      entries: []
    },
    lock: null
  });
  const json = JSON.parse(report.split('```json')[1].split('```')[0]);
  assert.equal(json.targetOnlyGuard.monitorScope, 'project-tree-files-and-references-excluding-infrastructure');
  assert.deepEqual(json.targetOnlyGuard.excludedDirectories, ['node_modules']);
});
```

- [ ] **Step 2: Run the persistence test**

Run: `node --test test/snapshot-guard.test.js`
Expected: PASS (it exercises the existing `formatFixGuardReport`, confirming the new fields are not dropped on persistence).

- [ ] **Step 3: Update the guard-mode wording**

In each file, find the sentence describing `guard=snapshot` proving target-only writes "across the project tree" and replace it with scoped wording, e.g.:

> `guard=snapshot` monitors the target, explicit `ref=` documents, ordinary project files, and unrelated file symlinks as opaque entries. Well-known infrastructure directories (`.git`, `node_modules`, `.pnpm-store`, `.yarn`, `.cache`, `dist`, `build`, `coverage`) are excluded from monitoring unless the target or a reference lives inside one; when any directory is excluded the guard reports `monitorScope: project-tree-files-and-references-excluding-infrastructure`. Directory symlinks are not supported and block the guard.

Also disclose the residual risk explicitly:

> Opaque file-symlink entries are checked by symlink metadata and `readlink` target text, but they do not detect writes made through the symlink to its resolved target; directory symlinks remain unsupported for that reason.

Keep `README.md` and `README.zh-CN.md` structurally aligned (same section, translated prose).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot-guard.js test/snapshot-guard.test.js README.md README.zh-CN.md shared/core.md
git commit -m "feat: scope snapshot guard with infrastructure exclusion and opaque symlinks"
```

---

## Phase 4 — P1b: Codex directory tree verification (manifest schema v2)

**Heaviest phase. Do P1a first.** Strategy: bump `schemaVersion` 1→2, store per-directory `childFiles` + `treeChecksum`, verify them on uninstall, and keep a conservative path for old v1 manifests.

**Schema v2 grammar decision (fits the existing line parser):** directory `generated` rows gain two optional scalar fields serialized as nested `    key: value` lines — `treeChecksum` (sha256 hex) and `childFiles` (a JSON-quoted, comma-joined list of POSIX-relative file paths, ownership marker excluded). No nested-list construct is added to the parser.

### Task 4.1: Accept schemaVersion 2 and the new optional directory fields

**Files:**
- Modify: `lib/manifest.js` (`SCHEMA_VERSION`, `validateSchema`, `SECTION_FIELDS.generated`, `validateGeneratedEntry`, serializer)
- Test: `test/manifest-schema-v2.test.js` (new)

- [ ] **Step 1: Write the failing round-trip test**

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { serializeManifest, parseManifestText } = require('../lib/manifest');

function baseManifest(generated) {
  return {
    schemaVersion: 2,
    packageName: '@xenonbyte/drfx',
    packageVersion: '0.2.1',
    platform: 'codex',
    installedAt: '2026-05-31T00:00:00.000Z',
    updatedAt: '2026-05-31T00:00:00.000Z',
    installRoot: '/abs/.codex',
    allowedRoots: ['/abs/.codex'],
    sharedAssets: { path: '~/.drfx/shared', checksum: 'none' },
    capabilityDescriptor: { path: '~/.drfx/capabilities/codex.json', mutable: true },
    generated,
    backups: []
  };
}

test('schema v2 directory entry round-trips childFiles and treeChecksum', () => {
  const manifest = baseManifest([
    {
      path: '/abs/.codex/skills/review-fix-spec',
      kind: 'directory',
      action: 'created',
      checksum: 'none',
      treeChecksum: 'a'.repeat(64),
      childFiles: 'SKILL.md,review/reviewer.md'
    }
  ]);
  const parsed = parseManifestText(serializeManifest(manifest));
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.generated[0].treeChecksum, 'a'.repeat(64));
  assert.equal(parsed.generated[0].childFiles, 'SKILL.md,review/reviewer.md');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/manifest-schema-v2.test.js`
Expected: FAIL — `ERR_SCHEMA_VERSION` (only 1 allowed) and the parser rejects `treeChecksum`/`childFiles` as unsupported generated fields.

- [ ] **Step 3: Accept v1 and v2 in `validateSchema`**

Change line 327 from:

```js
  if (manifest.schemaVersion !== SCHEMA_VERSION) fail('ERR_SCHEMA_VERSION', 'manifest schemaVersion must be 1');
```

to:

```js
  if (![1, 2].includes(manifest.schemaVersion)) fail('ERR_SCHEMA_VERSION', 'manifest schemaVersion must be 1 or 2');
```

And change the write-time constant at line 8:

```js
const SCHEMA_VERSION = 2;
```

- [ ] **Step 4: Allow the new optional fields in the grammar + validator**

Change `SECTION_FIELDS.generated` (line 26) to:

```js
  generated: new Set(['path', 'kind', 'action', 'checksum', 'treeChecksum', 'childFiles']),
```

In `validateGeneratedEntry` (line 381), change the `validateExactKeys` call to allow the new keys:

```js
  validateExactKeys(`generated entry ${index}`, entry, ['path', 'kind', 'action', 'checksum', 'treeChecksum', 'childFiles']);
```

and add, before the closing brace of `validateGeneratedEntry`:

```js
  if (entry.kind === 'directory') {
    if (entry.treeChecksum !== undefined && (typeof entry.treeChecksum !== 'string' || entry.treeChecksum.length === 0)) {
      fail('ERR_GENERATED_TREE_CHECKSUM', `generated entry ${index} treeChecksum must be a non-empty string`);
    }
    if (entry.childFiles !== undefined && typeof entry.childFiles !== 'string') {
      fail('ERR_GENERATED_CHILD_FILES', `generated entry ${index} childFiles must be a string`);
    }
  } else if (entry.treeChecksum !== undefined || entry.childFiles !== undefined) {
    fail('ERR_GENERATED_FILE_FIELDS', `generated entry ${index} file rows must not carry treeChecksum/childFiles`);
  }
```

- [ ] **Step 5: Serialize the optional fields when present**

Replace the generated serialization (line 125):

```js
  serializeList(lines, 'generated', manifest.generated, ['path', 'kind', 'action', 'checksum']);
```

with a row-aware serializer. Add this helper next to `serializeList` (after line 87):

```js
function serializeGenerated(lines, rows) {
  lines.push('generated:');
  for (const row of rows) {
    lines.push(`  - ${serializeKeyValue('path', row.path)}`);
    lines.push(`    ${serializeKeyValue('kind', row.kind)}`);
    lines.push(`    ${serializeKeyValue('action', row.action)}`);
    lines.push(`    ${serializeKeyValue('checksum', row.checksum)}`);
    if (row.treeChecksum !== undefined) lines.push(`    ${serializeKeyValue('treeChecksum', row.treeChecksum)}`);
    if (row.childFiles !== undefined) lines.push(`    ${serializeKeyValue('childFiles', row.childFiles)}`);
  }
}
```

and call it instead:

```js
  serializeGenerated(lines, manifest.generated);
```

Also extend `normalizeManifestShape` generated mapping is not needed (it passes the array through), but ensure parsed rows keep the new fields — they already flow through `parseManifestText` → `manifest[section].push(currentRow)`.

- [ ] **Step 6: Run the round-trip test**

Run: `node --test test/manifest-schema-v2.test.js`
Expected: PASS.

### Task 4.2: Record directory metadata at install time

**Files:**
- Modify: `lib/install.js` (`installPlatform` generated push; add a tree-metadata helper)
- Test: `test/manifest-schema-v2.test.js`

- [ ] **Step 1: Write the failing test**

```js
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { installPlatform } = require('../lib/install');
const { readInstallManifest } = require('../lib/manifest');

test('codex install records childFiles and treeChecksum for skill directories', async (t) => {
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-p1b-home-')));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const platformRoots = {
    codex: path.join(homeDir, '.codex'),
    codexSkills: path.join(homeDir, '.codex', 'skills'),
    codexPrompts: path.join(homeDir, '.codex', 'prompts')
  };
  fs.mkdirSync(path.join(homeDir, '.drfx', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.drfx', 'capabilities'), { recursive: true });

  await installPlatform('codex', { homeDir, platformRoots });
  const { manifest } = readInstallManifest('codex', { homeDir });
  const dirEntry = manifest.generated.find((g) => g.kind === 'directory');

  assert.equal(manifest.schemaVersion, 2);
  assert.ok(dirEntry.treeChecksum && dirEntry.treeChecksum.length === 64);
  assert.ok(dirEntry.childFiles.includes('SKILL.md'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/manifest-schema-v2.test.js`
Expected: FAIL — directory entries currently carry only `checksum: 'none'`.

- [ ] **Step 3: Define `directoryTreeMetadata` once in `lib/manifest.js` and export it**

Install (this task) and uninstall (Task 4.3) must compute byte-identical checksums, so the helper lives in one place. In `lib/manifest.js`, after `sha256File` (added in Task 2.1), add:

```js
function directoryTreeMetadata(directoryPath) {
  const root = path.resolve(directoryPath);
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === OWNERSHIP_MARKER) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) { files.push('__symlink__'); continue; }
      if (entry.isDirectory()) { walk(entryPath); continue; }
      if (!entry.isFile()) continue;
      files.push(path.relative(root, entryPath).split(path.sep).join('/'));
    }
  }
  walk(root);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    hash.update(relative);
    hash.update('\0');
    if (relative !== '__symlink__') {
      hash.update(fs.readFileSync(path.join(root, relative)));
      hash.update('\0');
    }
  }
  return { childFiles: files.join(','), treeChecksum: hash.digest('hex') };
}
```

Add `directoryTreeMetadata` to `module.exports` in `lib/manifest.js`. Then in `lib/install.js`, add it to the existing `require('./manifest')` destructuring block (lines 13-18):

```js
const {
  manifestPathForPlatform,
  readInstallManifest,
  validateGeneratedRemoval,
  writeInstallManifest,
  directoryTreeMetadata
} = require('./manifest');
```

- [ ] **Step 4: Use it when building directory generated entries**

In `installPlatform`, replace the `generated.push({...})` block (lines 329-334):

```js
      generated.push({
        path: item.targetPath,
        kind: item.kind,
        action,
        checksum: item.kind === 'directory' ? 'none' : checksumContent(item.content)
      });
```

with:

```js
      if (item.kind === 'directory') {
        const tree = directoryTreeMetadata(item.targetPath);
        generated.push({
          path: item.targetPath,
          kind: 'directory',
          action,
          checksum: 'none',
          treeChecksum: tree.treeChecksum,
          childFiles: tree.childFiles
        });
      } else {
        generated.push({
          path: item.targetPath,
          kind: 'file',
          action,
          checksum: checksumContent(item.content)
        });
      }
```

Set the manifest `schemaVersion` to 2 at line 340:

```js
      schemaVersion: 2,
```

- [ ] **Step 5: Run the test**

Run: `node --test test/manifest-schema-v2.test.js`
Expected: PASS.

### Task 4.3: Verify directory trees on uninstall (v2) + conservative path (v1)

**Files:**
- Modify: `lib/manifest.js` (`validateGeneratedRemoval` directory branch)
- Test: `test/manifest-schema-v2.test.js`

- [ ] **Step 1: Write failing tests**

```js
const { uninstallPlatform } = require('../lib/install');
const { writeInstallManifest } = require('../lib/manifest');

async function installCodex(t) {
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-p1b-uninstall-')));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const platformRoots = {
    codex: path.join(homeDir, '.codex'),
    codexSkills: path.join(homeDir, '.codex', 'skills'),
    codexPrompts: path.join(homeDir, '.codex', 'prompts')
  };
  fs.mkdirSync(path.join(homeDir, '.drfx', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.drfx', 'capabilities'), { recursive: true });
  await installPlatform('codex', { homeDir, platformRoots });
  return { homeDir, platformRoots };
}

test('uninstall skips a codex skill directory that gained a user file', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  fs.writeFileSync(path.join(skillDir, 'USER-NOTES.md'), 'mine\n');

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.path === skillDir && s.reason === 'modified'));
  assert.equal(fs.existsSync(skillDir), true);
});

test('uninstall removes an unchanged codex skill directory', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const result = await uninstallPlatform('codex', { homeDir, platformRoots });
  assert.notEqual(result.partial, true);
  assert.equal(fs.existsSync(skillDir), false);
});

test('schema v1 uninstall skips a codex skill directory whose tree is not fully recognized', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const { manifest } = readInstallManifest('codex', { homeDir });
  writeInstallManifest({
    ...manifest,
    schemaVersion: 1,
    generated: manifest.generated.map((entry) => entry.path === skillDir
      ? { path: entry.path, kind: 'directory', action: entry.action, checksum: 'none' }
      : entry)
  }, { homeDir });
  fs.writeFileSync(path.join(skillDir, 'USER-NOTES.md'), 'mine\n');

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.path === skillDir && s.reason === 'modified'));
  assert.equal(fs.existsSync(skillDir), true);
  const retained = readInstallManifest('codex', { homeDir }).manifest.generated.map((entry) => entry.path);
  assert.ok(retained.includes(skillDir));
});

test('schema v1 uninstall removes an unchanged codex skill directory via the recognized set', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const { manifest } = readInstallManifest('codex', { homeDir });
  writeInstallManifest({
    ...manifest,
    schemaVersion: 1,
    generated: manifest.generated.map((entry) => entry.kind === 'directory'
      ? { path: entry.path, kind: 'directory', action: entry.action, checksum: 'none' }
      : entry)
  }, { homeDir });

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.notEqual(result.partial, true);
  assert.equal(fs.existsSync(skillDir), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/manifest-schema-v2.test.js`
Expected: FAIL — the directory with the extra user file is currently removed (no tree check).

- [ ] **Step 3: Add the directory-removability helper to `lib/manifest.js`**

`directoryTreeMetadata` already exists in `lib/manifest.js` from Task 4.2 Step 3. Add only `directoryIsRemovable` next to it:

```js
function directoryIsRemovable(entry, generatePlatformFiles) {
  const current = directoryTreeMetadata(entry.path);
  if (entry.treeChecksum !== undefined && entry.childFiles !== undefined) {
    return current.treeChecksum === entry.treeChecksum && current.childFiles === entry.childFiles;
  }
  // schemaVersion 1 manifest: conservative path — every current file must be a recognized generated name.
  // generateCodexSkill returns { relativePath: 'skills/<name>', files: [{ relativePath }, ...] };
  // the ownership marker is excluded just like directoryTreeMetadata excludes it.
  const skillName = path.basename(entry.path);
  const recognized = new Set();
  for (const skill of generatePlatformFiles('codex')) {
    if (path.basename(skill.relativePath || '') !== skillName) continue;
    for (const file of skill.files || []) {
      if (file.relativePath === OWNERSHIP_MARKER) continue;
      recognized.add(file.relativePath.split(path.sep).join('/'));
    }
  }
  if (recognized.size === 0) return false; // unknown skill name → conservative skip
  return current.childFiles.split(',').every((name) => name === '' || recognized.has(name));
}
```

> The v1 extraction is grounded in the real `generateCodexSkill` shape (`relativePath: 'skills/<name>'`, `files: [{ relativePath }]`, ownership marker excluded). `OWNERSHIP_MARKER` is already defined in `lib/manifest.js` (line 10). Task 4.3 Step 1 includes both a negative test (extra user file → skip) and a positive test (clean v1 tree → still removed), so a wrong extraction fails loudly instead of silently degrading to "never remove v1 directories".

- [ ] **Step 4: Wire the directory branch in `validateGeneratedRemoval`**

Import the generator at the top of `lib/manifest.js`:

```js
const { generatePlatformFiles } = require('./generator');
```

In the directory branch (lines 484-488), after the ownership checks and before the final `removable.push`, add a skip on tree mismatch. Replace:

```js
    if (entry.kind === 'directory') {
      if (!lstat.isDirectory()) fail('ERR_DIRECTORY_KIND', `generated path is not a directory: ${entry.path}`);
      if (!ownershipMarked) {
        fail('ERR_DIRECTORY_OWNERSHIP', `directory removal requires ownership marker; refusing non-owned directory: ${entry.path}`);
      }
    } else if (!lstat.isFile()) {
```

with:

```js
    if (entry.kind === 'directory') {
      if (!lstat.isDirectory()) fail('ERR_DIRECTORY_KIND', `generated path is not a directory: ${entry.path}`);
      if (!ownershipMarked) {
        fail('ERR_DIRECTORY_OWNERSHIP', `directory removal requires ownership marker; refusing non-owned directory: ${entry.path}`);
      }
      if (!directoryIsRemovable(entry, generatePlatformFiles)) {
        skipped.push({ path: entry.path, kind: 'directory', removable: false, reason: 'modified' });
        continue;
      }
    } else if (!lstat.isFile()) {
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/manifest-schema-v2.test.js test/capability-check.test.js`
Expected: PASS. If the v1 `recognized` extraction is wrong, the "removes an unchanged codex skill directory" test fails on a freshly installed v2 manifest only if the v2 branch is wrong — verify the v2 path first (it does not touch the generator).

- [ ] **Step 6: Full suite + commit**

Run: `npm test`
Expected: PASS.

```bash
git add lib/manifest.js lib/install.js test/manifest-schema-v2.test.js
git commit -m "feat: verify codex skill directory trees on uninstall (manifest schema v2)"
```

---

## Self-Review

**Spec coverage (against `docs/AUDIT-2026-05-31-code-and-process-review.md`):**
- P1a file checksum skip → Tasks 2.1–2.2. CLI partial status → Task 2.3. ✓
- P1b childFiles + treeChecksum, schemaVersion bump, conservative v1 path → Tasks 4.1–4.3. ✓
- P1 capability-descriptor-kept-while-artifacts-remain → Task 2.2 (descriptor removed only when `!partial`). ✓
- P2 infrastructure exclusion (primary) → Task 3.1; opaque file symlinks + directory-symlink rejection + retarget detection → Task 3.2; target/ref precedence → Tasks 3.1+3.3; docs → Task 3.4. ✓
- P3 remove test/, update existing expectation, whitelist pack check incl. `package.json` → Tasks 1.1–1.2. ✓

**Residual-risk coverage (was a soft spot, now resolved):** the v1-conservative `recognized` extraction is grounded in the real `generateCodexSkill` shape (`relativePath: 'skills/<name>'`, `files: [{ relativePath }]`, ownership marker excluded). Task 4.3 Step 1 carries both a negative test (extra user file → skip) and a positive test (clean v1 tree → still removed), so a wrong extraction fails loudly. The persisted-guard-report metadata (`monitorScope`, `excludedDirectories`) is locked by the Task 3.4 `formatFixGuardReport` round-trip test.

**Type consistency:** `partial` and `skipped[].reason === 'modified'` are produced in `validateGeneratedRemoval` (manifest.js) and consumed in `uninstallPlatform` (install.js) and `bin/drfx.js`. `monitorScope`/`excludedDirectories`/`role: 'opaque-symlink'`/`linkTargetSha256`/`mode` are produced in `collectMonitorRecords`/`symlinkOpaqueRecord` and consumed in `checkSnapshotTargetOnly`/`monitorEntryChanged`. `directoryTreeMetadata` is defined once in `lib/manifest.js` (Task 4.2 Step 3) and imported by `lib/install.js`, so install and uninstall compute byte-identical `childFiles`/`treeChecksum` values — no divergent second copy.

---

## Verification Plan

Targeted, per phase:

```bash
node --test test/pack-contents.test.js test/shared-assets.test.js
node --test test/capability-check.test.js
node --test test/snapshot-guard.test.js
node --test test/manifest-schema-v2.test.js
```

Full check after each phase:

```bash
npm test
node bin/drfx.js check --json
git status --short
```
