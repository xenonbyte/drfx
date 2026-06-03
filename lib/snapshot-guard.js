'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  computeFingerprint,
  validateTargetStateOwnedPath
} = require('./target-state');

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

function guardError(blockingReason, message, metadata = {}) {
  const error = new Error(`${blockingReason}: ${message}`);
  error.code = blockingReason === 'rollback-unavailable'
    ? 'ERR_ROLLBACK_UNAVAILABLE'
    : 'ERR_TARGET_ONLY_GUARD_UNAVAILABLE';
  error.status = 'blocked';
  error.reason = blockingReason;
  error.blockingReason = blockingReason;
  Object.assign(error, metadata);
  return error;
}

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativeToProject(projectRoot, filePath) {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return toPosix(relative);
}

function pathSha256(filePath) {
  return crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex');
}

function atomicCopyFile(sourcePath, destinationPath) {
  const absoluteSource = path.resolve(sourcePath);
  const absoluteDestination = path.resolve(destinationPath);
  const directory = path.dirname(absoluteDestination);
  const basename = path.basename(absoluteDestination);
  const tempPath = path.join(
    directory,
    `.${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.copyFileSync(absoluteSource, tempPath, fs.constants.COPYFILE_EXCL);
    fs.renameSync(tempPath, absoluteDestination);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
    throw error;
  }
}

function redactedEntry(filePath, kind) {
  return {
    pathSha256: pathSha256(filePath),
    statusCode: 'snapshot',
    kind
  };
}

function assertInsideProject(projectRoot, filePath, label, blockingReason) {
  const relative = relativeToProject(projectRoot, filePath);
  if (!relative) throw guardError(blockingReason, `${label} must be inside project root`);
  return relative;
}

function assertMissingTargetParentChain({ projectRoot, targetPath, blockingReason }) {
  const root = path.resolve(projectRoot);
  const absoluteTarget = path.resolve(targetPath);
  const normalizedTarget = assertInsideProject(root, absoluteTarget, 'target', blockingReason);
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(root);
  } catch (error) {
    throw guardError(blockingReason, 'project root identity is unavailable', { cause: error });
  }

  const relativeParts = path.relative(root, absoluteTarget).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of relativeParts.slice(0, -1)) {
    current = path.join(current, part);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw guardError(blockingReason, 'target parent is unavailable', { cause: error });
    }
    if (stats.isSymbolicLink()) throw guardError(blockingReason, 'target parent must not be a symlink');
    if (!stats.isDirectory()) throw guardError(blockingReason, 'target parent must be a directory');
    let parentRealPath;
    try {
      parentRealPath = fs.realpathSync.native(current);
    } catch (error) {
      throw guardError(blockingReason, 'target parent identity is unavailable', { cause: error });
    }
    const realRelative = path.relative(rootRealPath, parentRealPath);
    if (realRelative !== '' && (realRelative.startsWith('..') || path.isAbsolute(realRelative))) {
      throw guardError(blockingReason, 'target parent realpath must stay inside project root');
    }
  }
  return normalizedTarget;
}

function assertTargetIdentity({ projectRoot, targetPath, expectedNormalizedTarget, blockingReason, allowMissing = false }) {
  const root = path.resolve(projectRoot);
  const absoluteTarget = path.resolve(targetPath);
  const normalizedTarget = assertInsideProject(root, absoluteTarget, 'target', blockingReason);
  const expected = expectedNormalizedTarget ? toPosix(expectedNormalizedTarget) : normalizedTarget;
  if (normalizedTarget !== expected) {
    throw guardError(blockingReason, 'target identity does not match manifest target');
  }

  let linkStats;
  try {
    linkStats = fs.lstatSync(absoluteTarget);
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') {
      return assertMissingTargetParentChain({ projectRoot: root, targetPath: absoluteTarget, blockingReason });
    }
    throw guardError(blockingReason, 'target is missing or unreadable', { cause: error });
  }
  if (linkStats.isSymbolicLink()) throw guardError(blockingReason, 'target must not be a symlink');
  if (!linkStats.isFile()) throw guardError(blockingReason, 'target must be a regular file');

  let rootRealPath;
  let targetRealPath;
  try {
    rootRealPath = fs.realpathSync.native(root);
    targetRealPath = fs.realpathSync.native(absoluteTarget);
  } catch (error) {
    throw guardError(blockingReason, 'target identity is unavailable', { cause: error });
  }
  const realRelative = path.relative(rootRealPath, targetRealPath);
  if (realRelative === '' || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw guardError(blockingReason, 'target realpath must stay inside project root');
  }
  if (toPosix(realRelative) !== expected) {
    throw guardError(blockingReason, 'target identity does not match manifest target');
  }
  return normalizedTarget;
}

function assertRegularNonSymlink(filePath, label, blockingReason) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    throw guardError(blockingReason, `${label} is missing or unreadable`, { cause: error });
  }
  if (stats.isSymbolicLink()) throw guardError(blockingReason, `${label} must not be a symlink`);
  if (!stats.isFile()) throw guardError(blockingReason, `${label} must be a regular file`);
}

function snapshotRelativePath(round) {
  return path.posix.join('snapshots', `round-${String(Number(round || 1)).padStart(3, '0')}`, 'target.body');
}

function snapshotPathFromAnchor(targetStateDir, round, rollbackAnchor = {}) {
  const relativePath = rollbackAnchor.snapshotPath || snapshotRelativePath(round);
  let absolutePath;
  try {
    absolutePath = validateTargetStateOwnedPath({
      targetStateDir,
      relativePath,
      allowedDirectories: ['snapshots'],
      label: 'snapshot path'
    });
  } catch (error) {
    throw guardError(
      'rollback-unavailable',
      error && error.message ? error.message : 'snapshot path is invalid',
      { cause: error }
    );
  }
  return {
    relativePath: toPosix(path.relative(path.resolve(targetStateDir), absolutePath)),
    absolutePath
  };
}

function checkSnapshotRollbackAnchor({ projectRoot, targetPath, expectedNormalizedTarget = null }) {
  const normalizedTarget = assertTargetIdentity({
    projectRoot,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: 'rollback-unavailable'
  });
  return {
    status: 'passed',
    guardMode: 'snapshot',
    normalizedTarget
  };
}

function captureSnapshot({
  projectRoot,
  targetPath,
  targetStateDir,
  round = 1,
  expectedNormalizedTarget = null
}) {
  const anchor = checkSnapshotRollbackAnchor({ projectRoot, targetPath, expectedNormalizedTarget });
  const { relativePath, absolutePath } = snapshotPathFromAnchor(targetStateDir, round);
  atomicCopyFile(targetPath, absolutePath);
  const fingerprint = computeFingerprint(targetPath);
  return {
    ...anchor,
    snapshotPath: relativePath,
    targetFingerprint: {
      sha256: fingerprint.sha256,
      size: fingerprint.size
    }
  };
}

function monitorRoleLabel(role) {
  if (role === 'target') return 'target';
  if (role === 'reference') return 'reference';
  return 'monitored file';
}

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

function monitorPathRecord({ projectRoot, filePath, normalizedTarget, role }) {
  const label = monitorRoleLabel(role);
  assertRegularNonSymlink(filePath, label, 'target-only-guard-unavailable');
  const projectRelative = relativeToProject(projectRoot, filePath);
  if (!projectRelative) {
    throw guardError('target-only-guard-unavailable', `${label} must be inside project root`);
  }
  const fingerprint = computeFingerprint(filePath);
  return {
    path: projectRelative,
    pathSha256: pathSha256(filePath),
    role: projectRelative === normalizedTarget ? 'target' : role,
    sha256: fingerprint.sha256,
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs
  };
}

function uniqueByPath(records) {
  const byPath = new Map();
  // opaque-symlink is a forward-looking slot; symlink references are rejected earlier by
  // assertRegularNonSymlink, so an opaque entry never collides with a reference/target at
  // the same path today.
  const priority = { neighbor: 0, 'opaque-symlink': 1, reference: 2, target: 3 };
  for (const record of records) {
    const previous = byPath.get(record.path);
    if (!previous || (priority[record.role] || 0) >= (priority[previous.role] || 0)) { // last writer wins for equal-priority duplicate paths
      byPath.set(record.path, record);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function collectMonitorRecords({
  projectRoot,
  targetPath,
  allowedStateDir,
  expectedNormalizedTarget = null,
  referencePaths = []
}) {
  const normalizedTarget = assertTargetIdentity({
    projectRoot,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: 'target-only-guard-unavailable'
  });
  const records = [];
  const excludedDirectories = [];
  const monitorRoot = path.resolve(projectRoot);
  const stateDir = allowedStateDir ? path.resolve(allowedStateDir) : null;

  const monitoredPaths = [path.resolve(targetPath), ...(referencePaths || []).map((referencePath) =>
    path.isAbsolute(referencePath) ? referencePath : path.resolve(projectRoot, referencePath))];
  // target already validated above by assertTargetIdentity; only references need checking here
  for (const monitoredPath of monitoredPaths.slice(1)) {
    let lstat;
    try {
      lstat = fs.lstatSync(monitoredPath);
    } catch (error) {
      throw guardError('target-only-guard-unavailable', 'reference is unreadable', { cause: error });
    }
    if (lstat.isSymbolicLink()) {
      throw guardError('target-only-guard-unavailable', 'reference must not be a symlink');
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
          // Deliberate: a broken symlink can't be classified as dir-vs-file, so it is treated
          // leniently as an opaque monitored entry (it will still block via
          // unexpected-worktree-change if its readlink text or mode changes).
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

  for (const referencePath of referencePaths || []) {
    const absoluteReference = path.isAbsolute(referencePath)
      ? referencePath
      : path.resolve(projectRoot, referencePath);
    records.push(monitorPathRecord({
      projectRoot,
      filePath: absoluteReference,
      normalizedTarget,
      role: 'reference'
    }));
  }
  return { normalizedTarget, records: uniqueByPath(records), excludedDirectories: excludedDirectories.sort() };
}

function checkSnapshotTargetOnly({
  projectRoot,
  targetPath,
  allowedStateDir,
  expectedNormalizedTarget = null,
  referencePaths = []
}) {
  try {
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
  } catch (error) {
    if (error && error.blockingReason) throw error;
    return {
      status: 'blocked',
      blockingReason: 'target-only-guard-unavailable',
      entries: [],
      message: error && error.message ? error.message : String(error)
    };
  }
}

function fingerprintChanged(left, right) {
  return !left || !right ||
    left.sha256 !== right.sha256 ||
    left.size !== right.size;
}

function monitorEntryChanged(previous, current) {
  if (!previous || !current) return true;
  if (current.role === 'opaque-symlink' || previous.role === 'opaque-symlink') {
    return previous.role !== current.role ||
      previous.linkTargetSha256 !== current.linkTargetSha256 ||
      previous.mode !== current.mode;
  }
  return fingerprintChanged(previous, current);
}

function stringSetChanged(left = [], right = []) {
  if (left.length !== right.length) return true;
  const values = new Set(left);
  return right.some((value) => !values.has(value));
}

function changedStringSetMember(left = [], right = []) {
  const leftValues = new Set(left);
  const rightValues = new Set(right);
  return right.find((value) => !leftValues.has(value)) ||
    left.find((value) => !rightValues.has(value)) ||
    'infrastructure';
}

function inspectActualChangedFilesSnapshot({
  projectRoot,
  targetPath,
  allowedStateDir,
  expectedNormalizedTarget = null,
  targetOnlyGuard
}) {
  try {
    if (!targetOnlyGuard || targetOnlyGuard.status !== 'passed' || !Array.isArray(targetOnlyGuard.entries)) {
      return { status: 'blocked', blockingReason: 'target-only-guard-unavailable', entries: [] };
    }
    const referencePaths = targetOnlyGuard.entries
      .filter((entry) => entry.role === 'reference')
      .map((entry) => entry.path);
    const { normalizedTarget, records, excludedDirectories } = collectMonitorRecords({
      projectRoot,
      targetPath,
      allowedStateDir,
      expectedNormalizedTarget,
      referencePaths
    });
    const previousExcludedDirectories = Array.isArray(targetOnlyGuard.excludedDirectories)
      ? targetOnlyGuard.excludedDirectories
      : [];
    if (stringSetChanged(previousExcludedDirectories, excludedDirectories)) {
      return {
        status: 'blocked',
        blockingReason: 'unexpected-worktree-change',
        entries: [
          redactedEntry(
            path.join(projectRoot, changedStringSetMember(previousExcludedDirectories, excludedDirectories)),
            'monitor-scope-changed'
          )
        ]
      };
    }
    const before = new Map(targetOnlyGuard.entries.map((entry) => [entry.path, entry]));
    const after = new Map(records.map((entry) => [entry.path, entry]));
    const blockedEntries = [];
    let targetChanged = false;

    for (const [entryPath, current] of after) {
      const previous = before.get(entryPath);
      if (current.path === normalizedTarget) {
        targetChanged = fingerprintChanged(previous, current);
        continue;
      }
      if (!previous) blockedEntries.push(redactedEntry(entryPath, 'created'));
      else if (monitorEntryChanged(previous, current)) blockedEntries.push(redactedEntry(entryPath, 'modified'));
    }
    for (const [entryPath, previous] of before) {
      if (previous.path === normalizedTarget) continue;
      if (!after.has(entryPath)) blockedEntries.push(redactedEntry(entryPath, 'deleted'));
    }
    if (!after.has(normalizedTarget)) blockedEntries.push(redactedEntry(normalizedTarget, 'deleted'));

    if (blockedEntries.length > 0) {
      return {
        status: 'blocked',
        blockingReason: 'unexpected-worktree-change',
        entries: blockedEntries
      };
    }
    return {
      status: 'passed',
      changedFiles: targetChanged ? [normalizedTarget] : [],
      allowedStateEntryCount: 0
    };
  } catch (error) {
    if (error && error.blockingReason === 'target-only-guard-unavailable') {
      return {
        status: 'blocked',
        blockingReason: 'target-only-guard-unavailable',
        entries: [],
        message: error.message
      };
    }
    return {
      status: 'blocked',
      blockingReason: 'unexpected-worktree-change',
      entries: [],
      message: error && error.message ? error.message : String(error)
    };
  }
}

function restoreSnapshot({
  projectRoot,
  targetPath,
  targetStateDir,
  round = 1,
  expectedNormalizedTarget = null,
  rollbackAnchor = {}
}) {
  const normalizedTarget = assertTargetIdentity({
    projectRoot,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: 'rollback-unavailable',
    allowMissing: true
  });
  const { relativePath, absolutePath } = snapshotPathFromAnchor(targetStateDir, round, rollbackAnchor);
  if (!fs.existsSync(absolutePath)) {
    return {
      status: 'missing',
      guardMode: 'snapshot',
      normalizedTarget,
      snapshotPath: relativePath
    };
  }
  assertRegularNonSymlink(absolutePath, 'snapshot', 'rollback-unavailable');
  const absoluteTarget = path.resolve(targetPath);
  atomicCopyFile(absolutePath, absoluteTarget);
  fs.rmSync(absolutePath, { force: true });
  return {
    status: 'passed',
    guardMode: 'snapshot',
    normalizedTarget,
    snapshotPath: relativePath
  };
}

// --- File-set snapshot guard primitives (PLAN-TASK-006) ---
//
// These capture/validate/restore fingerprint baselines for an EXPLICIT SET of monitored
// files (the primary target PLUS recorded necessary dependency files), rather than a single
// target. They are ADDITIVE: captureSnapshot/restoreSnapshot/checkSnapshotTargetOnly/
// inspectActualChangedFilesSnapshot above are unchanged. PLAN-TASK-009 wires these into the
// live fixer boundary; TASK-006 only provides + unit-tests the primitives in isolation.
//
// Unlike the single-target snapshot which copies the target body into a
// snapshots/round-NNN/target.body file, these baselines carry an in-memory restorable body
// per entry so a SET of files can be captured/restored without minting per-file on-disk
// snapshot slots. Restore writes ONLY to monitored files and never touches unmonitored
// paths.

// Accepts plain string paths or { path, reason, issueId } dependency records; returns the
// absolute path + the raw entry. Path/symlink/outside-root safety is enforced per file by
// fileSetEntryRecord.
function monitoredFileSpec(entry) {
  const raw = typeof entry === 'string' ? entry : (entry && entry.path);
  if (typeof raw !== 'string' || raw === '') {
    throw guardError('target-only-guard-unavailable', 'monitored file entry must be a non-empty path');
  }
  return raw;
}

// Fingerprints one monitored file with full path safety (reuses assertRegularNonSymlink +
// relativeToProject). Captures the body so restore can roll it back. Throws
// target-only-guard-unavailable on any unsafe/missing/symlink/outside-root file.
function fileSetEntryRecord({ projectRoot, rawPath, withBody }) {
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
  const projectRelative = relativeToProject(root, absolute);
  if (!projectRelative) {
    throw guardError('target-only-guard-unavailable', 'monitored file must be inside project root');
  }
  assertRegularNonSymlink(absolute, 'monitored file', 'target-only-guard-unavailable');
  const fingerprint = computeFingerprint(absolute);
  const record = {
    path: projectRelative,
    pathSha256: pathSha256(absolute),
    sha256: fingerprint.sha256,
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs
  };
  if (withBody) {
    try {
      record.body = fs.readFileSync(absolute);
    } catch (error) {
      throw guardError('target-only-guard-unavailable', 'monitored file body is unreadable', { cause: error });
    }
  }
  return record;
}

function blockedSnapshotResult(blockingReason, error) {
  return {
    status: 'blocked',
    blockingReason,
    entries: [],
    message: error && error.message ? error.message : String(error)
  };
}

// Capture a fingerprint + restorable body baseline for a SET of monitored files. Missing /
// symlink / outside-root files block (never a silent pass).
function captureFileSetBaseline({ projectRoot, monitoredFiles = [] }) {
  try {
    const entries = [];
    const seen = new Set();
    for (const entry of monitoredFiles) {
      const rawPath = monitoredFileSpec(entry);
      const record = fileSetEntryRecord({ projectRoot, rawPath, withBody: true });
      if (seen.has(record.path)) continue;
      seen.add(record.path);
      entries.push(record);
    }
    return {
      status: 'passed',
      guardMode: 'snapshot',
      entries: entries.sort((left, right) => left.path.localeCompare(right.path))
    };
  } catch (error) {
    if (error && error.blockingReason) return blockedSnapshotResult(error.blockingReason, error);
    return blockedSnapshotResult('target-only-guard-unavailable', error);
  }
}

// Validate the current state of the monitored set against a captured baseline. Returns the
// monitored files whose content fingerprint changed (mtime-only touches are ignored, same
// as the single-target guard). A monitored file that went missing or became a symlink
// blocks as unexpected-worktree-change (never a silent pass).
function validateFileSetBaseline({ projectRoot, monitoredFiles = [], baseline }) {
  if (!baseline || baseline.status !== 'passed' || !Array.isArray(baseline.entries)) {
    return { status: 'blocked', blockingReason: 'target-only-guard-unavailable', entries: [] };
  }
  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const changedFiles = [];
  const blockedEntries = [];
  try {
    for (const entry of monitoredFiles) {
      const rawPath = monitoredFileSpec(entry);
      let current;
      try {
        current = fileSetEntryRecord({ projectRoot, rawPath, withBody: false });
      } catch (error) {
        if (error && error.blockingReason === 'target-only-guard-unavailable') {
          // A monitored file we expected is now missing / symlinked / unreadable.
          blockedEntries.push(redactedEntry(path.resolve(projectRoot, rawPath), 'missing'));
          continue;
        }
        throw error;
      }
      const previous = before.get(current.path);
      if (!previous) {
        // Newly monitored file with no recorded baseline must be established first.
        blockedEntries.push(redactedEntry(path.resolve(projectRoot, current.path), 'unbaselined'));
        continue;
      }
      if (fingerprintChanged(previous, current)) changedFiles.push(current.path);
    }
  } catch (error) {
    return blockedSnapshotResult('target-only-guard-unavailable', error);
  }
  if (blockedEntries.length > 0) {
    return { status: 'blocked', blockingReason: 'unexpected-worktree-change', entries: blockedEntries };
  }
  return { status: 'passed', changedFiles: changedFiles.sort() };
}

// Restore the captured baseline body for the monitored set. Writes ONLY to monitored files;
// unmonitored paths are never touched. A monitored entry without a restorable body (or an
// unsafe/symlinked path) blocks as rollback-unavailable (never a silent partial restore).
function restoreFileSetBaseline({ projectRoot, monitoredFiles = [], baseline }) {
  if (!baseline || baseline.status !== 'passed' || !Array.isArray(baseline.entries)) {
    return { status: 'blocked', blockingReason: 'rollback-unavailable', entries: [] };
  }
  const root = path.resolve(projectRoot);
  const byPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const targets = [];
  try {
    for (const entry of monitoredFiles) {
      const rawPath = monitoredFileSpec(entry);
      const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
      const projectRelative = relativeToProject(root, absolute);
      if (!projectRelative) {
        throw guardError('rollback-unavailable', 'monitored file must be inside project root');
      }
      const record = byPath.get(projectRelative);
      if (!record || !record.body) {
        throw guardError('rollback-unavailable', 'monitored file baseline body is unavailable');
      }
      // Reject restoring through a symlink: the destination must be a regular file (or
      // absent), never a symlink that could redirect the write outside the project.
      let stats;
      try {
        stats = fs.lstatSync(absolute);
      } catch (error) {
        if (!(error && error.code === 'ENOENT')) {
          throw guardError('rollback-unavailable', 'monitored file is unreadable', { cause: error });
        }
        stats = null;
      }
      if (stats && stats.isSymbolicLink()) {
        throw guardError('rollback-unavailable', 'monitored file must not be a symlink');
      }
      if (stats && !stats.isFile()) {
        throw guardError('rollback-unavailable', 'monitored file must be a regular file');
      }
      targets.push({ absolute, projectRelative, body: record.body });
    }
  } catch (error) {
    if (error && error.blockingReason) return blockedSnapshotResult(error.blockingReason, error);
    return blockedSnapshotResult('rollback-unavailable', error);
  }

  const restoredFiles = [];
  try {
    for (const { absolute, projectRelative, body } of targets) {
      atomicWriteBuffer(absolute, body);
      restoredFiles.push(projectRelative);
    }
  } catch (error) {
    // A write/rename failure (disk full, vanished parent dir, etc.) must surface as a
    // blocked rollback, never an uncaught throw that bypasses the guard contract.
    return blockedSnapshotResult('rollback-unavailable', error);
  }
  return {
    status: 'passed',
    guardMode: 'snapshot',
    restoredFiles: restoredFiles.sort()
  };
}

function atomicWriteBuffer(destinationPath, buffer) {
  const absoluteDestination = path.resolve(destinationPath);
  const directory = path.dirname(absoluteDestination);
  const basename = path.basename(absoluteDestination);
  const tempPath = path.join(
    directory,
    `.${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  // Recreate the parent dir if a fixer deleted it alongside the monitored file, mirroring
  // atomicCopyFile; otherwise the temp write would ENOENT.
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, absoluteDestination);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
    throw error;
  }
}

// Establish a baseline for a newly recorded necessary dependency file BEFORE its first
// write. If the dependency is already in the baseline, VALIDATE it has not drifted (block if
// it already differs unexpectedly — do not take a late baseline after mutation). If it is
// new, CAPTURE its body baseline now (before any write). Missing/symlink/outside-root
// dependency files block.
function ensureDependencyBaseline({ projectRoot, baseline, dependency }) {
  if (!baseline || baseline.status !== 'passed' || !Array.isArray(baseline.entries)) {
    return { status: 'blocked', blockingReason: 'target-only-guard-unavailable', entries: [] };
  }
  let rawPath;
  try {
    rawPath = monitoredFileSpec(dependency);
  } catch (error) {
    return blockedSnapshotResult('target-only-guard-unavailable', error);
  }

  let current;
  try {
    current = fileSetEntryRecord({ projectRoot, rawPath, withBody: true });
  } catch (error) {
    if (error && error.blockingReason) return blockedSnapshotResult(error.blockingReason, error);
    return blockedSnapshotResult('target-only-guard-unavailable', error);
  }

  const existing = baseline.entries.find((entry) => entry.path === current.path);
  if (existing) {
    // Already recorded: must match the recorded baseline. Drift before the write is an
    // unexpected mutation — block instead of silently re-baselining a changed file.
    if (fingerprintChanged(existing, current)) {
      return {
        status: 'blocked',
        blockingReason: 'unexpected-worktree-change',
        entries: [redactedEntry(path.resolve(projectRoot, current.path), 'modified')]
      };
    }
    return { status: 'passed', baseline, alreadyBaselined: true };
  }

  const nextEntries = [...baseline.entries, current]
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    status: 'passed',
    baseline: { ...baseline, entries: nextEntries },
    alreadyBaselined: false
  };
}

module.exports = {
  checkSnapshotRollbackAnchor,
  captureSnapshot,
  restoreSnapshot,
  checkSnapshotTargetOnly,
  inspectActualChangedFilesSnapshot,
  captureFileSetBaseline,
  validateFileSetBaseline,
  restoreFileSetBaseline,
  ensureDependencyBaseline
};
