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
    const { normalizedTarget, records } = collectMonitorRecords({
      projectRoot,
      targetPath,
      allowedStateDir,
      expectedNormalizedTarget,
      referencePaths
    });
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

module.exports = {
  checkSnapshotRollbackAnchor,
  captureSnapshot,
  restoreSnapshot,
  checkSnapshotTargetOnly,
  inspectActualChangedFilesSnapshot
};
