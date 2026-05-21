'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

function assertInsideProject(projectRoot, filePath, label) {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw guardError('rollback-unavailable', `${label} must be inside project root`);
  }
  return toPosix(relative);
}

function assertTargetIdentity({ projectRoot, targetPath, expectedNormalizedTarget, blockingReason }) {
  const root = path.resolve(projectRoot);
  const absoluteTarget = path.resolve(targetPath);
  let linkStats;
  try {
    linkStats = fs.lstatSync(absoluteTarget);
  } catch (error) {
    throw guardError(blockingReason, 'target is missing or unreadable', { cause: error });
  }
  if (linkStats.isSymbolicLink()) {
    throw guardError(blockingReason, 'target must not be a symlink');
  }
  if (!linkStats.isFile()) {
    throw guardError(blockingReason, 'target must be a regular file');
  }

  const normalizedTarget = assertInsideProject(root, absoluteTarget, 'target');
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
  const realNormalizedTarget = toPosix(realRelative);
  const expected = expectedNormalizedTarget ? toPosix(expectedNormalizedTarget) : normalizedTarget;
  if (realNormalizedTarget !== expected || normalizedTarget !== expected) {
    throw guardError(blockingReason, 'target identity does not match manifest target');
  }

  return normalizedTarget;
}

function runGit(projectRoot, args, blockingReason) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    throw guardError(blockingReason, `git ${args.join(' ')} failed`, { cause: error });
  }
}

function parseGitPath(rawPath) {
  const text = String(rawPath || '');
  if (!text) throw new Error('empty path');
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`unparseable quoted path: ${rawPath}`);
    }
  }
  if (path.isAbsolute(text) || text.split('/').includes('..') || text.includes('\0')) {
    throw new Error(`unsafe path: ${rawPath}`);
  }
  return text;
}

function entryKind(statusCode) {
  if (statusCode === '??') return 'untracked';
  if (statusCode.includes('R')) return 'renamed';
  if (statusCode.includes('C')) return 'copied';
  if (statusCode.includes('D')) return 'deleted';
  if (statusCode[0] && statusCode[0] !== ' ') return 'staged';
  if (statusCode[1] && statusCode[1] !== ' ') return 'dirty';
  return 'modified';
}

function parsePorcelainStatus(output) {
  const text = String(output || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => {
    if (line.length < 4 || line[2] !== ' ') {
      throw new Error(`unparseable git status line: ${line}`);
    }
    const statusCode = line.slice(0, 2);
    const rest = line.slice(3);
    let paths;
    if (statusCode.includes('R') || statusCode.includes('C')) {
      const marker = ' -> ';
      const markerIndex = rest.indexOf(marker);
      if (markerIndex === -1) throw new Error(`unparseable rename/copy status line: ${line}`);
      paths = [
        parseGitPath(rest.slice(0, markerIndex)),
        parseGitPath(rest.slice(markerIndex + marker.length))
      ];
    } else {
      paths = [parseGitPath(rest)];
    }
    return {
      statusCode,
      kind: entryKind(statusCode),
      paths
    };
  });
}

function readPorcelainStatus(projectRoot) {
  const output = runGit(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'target-only-guard-unavailable');
  try {
    return parsePorcelainStatus(output);
  } catch (error) {
    throw guardError('target-only-guard-unavailable', error.message, { cause: error });
  }
}

function pathSha256(relativePath) {
  return crypto.createHash('sha256').update(relativePath).digest('hex');
}

function redactEntry(entry, relativePath) {
  return {
    pathSha256: pathSha256(relativePath),
    statusCode: entry.statusCode,
    kind: entry.kind
  };
}

function isInsideOrEqual(relativePath, parentRelativePath) {
  return relativePath === parentRelativePath || relativePath.startsWith(`${parentRelativePath}/`);
}

function inspectStatusEntries({
  projectRoot,
  targetPath,
  allowedStateDir,
  allowTarget,
  expectedNormalizedTarget,
  targetIdentityBlockingReason = 'target-only-guard-unavailable'
}) {
  const root = path.resolve(projectRoot);
  const normalizedTarget = assertTargetIdentity({
    projectRoot: root,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: targetIdentityBlockingReason
  });
  const stateRelative = allowedStateDir
    ? toPosix(path.relative(root, path.resolve(allowedStateDir)))
    : null;
  if (stateRelative && (stateRelative.startsWith('..') || path.isAbsolute(stateRelative))) {
    throw guardError('target-only-guard-unavailable', 'allowed state directory must be inside project root');
  }

  const entries = readPorcelainStatus(root);
  const nonTargetEntries = [];
  const changedTargets = new Set();
  let allowedStateEntryCount = 0;

  for (const entry of entries) {
    let entryTouchesTarget = false;
    let entryIsAllowedState = false;
    for (const rawPath of entry.paths) {
      const relativePath = rawPath.split(path.sep).join('/');
      if (relativePath === normalizedTarget) {
        entryTouchesTarget = true;
      } else if (stateRelative && isInsideOrEqual(relativePath, stateRelative)) {
        entryIsAllowedState = true;
      } else {
        nonTargetEntries.push(redactEntry(entry, relativePath));
      }
    }

    if (entryTouchesTarget) {
      changedTargets.add(normalizedTarget);
      if (!allowTarget) {
        nonTargetEntries.push(redactEntry(entry, normalizedTarget));
      }
    } else if (entryIsAllowedState) {
      allowedStateEntryCount += 1;
    }
  }

  if (nonTargetEntries.length > 0) {
    return {
      status: 'blocked',
      blockingReason: 'unexpected-worktree-change',
      entries: nonTargetEntries
    };
  }

  return {
    status: 'passed',
    changedFiles: [...changedTargets].sort(),
    allowedStateEntryCount
  };
}

function checkGitRollbackAnchor({ projectRoot, targetPath, expectedNormalizedTarget = null }) {
  const root = path.resolve(projectRoot);
  runGit(root, ['rev-parse', '--is-inside-work-tree'], 'rollback-unavailable');
  const head = runGit(root, ['rev-parse', '--verify', 'HEAD'], 'rollback-unavailable').trim();
  const normalizedTarget = assertTargetIdentity({
    projectRoot: root,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: 'rollback-unavailable'
  });
  runGit(root, ['ls-files', '--error-unmatch', '--', normalizedTarget], 'rollback-unavailable');

  let entries;
  try {
    entries = parsePorcelainStatus(runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'], 'rollback-unavailable'));
  } catch (error) {
    if (error && error.blockingReason) throw error;
    throw guardError('rollback-unavailable', error.message, { cause: error });
  }

  const targetEntries = entries.filter((entry) => entry.paths.includes(normalizedTarget));
  if (targetEntries.length > 0) {
    throw guardError('rollback-unavailable', 'target must be tracked, index-clean, and worktree-clean', {
      entries: targetEntries.map((entry) => ({
        statusCode: entry.statusCode,
        kind: entry.kind
      }))
    });
  }

  return {
    status: 'passed',
    head,
    normalizedTarget
  };
}

function blockedGuardResult(blockingReason, error) {
  return {
    status: 'blocked',
    blockingReason,
    entries: [],
    message: error && error.message ? error.message : String(error)
  };
}

function checkTargetOnlyWorktree({ projectRoot, targetPath, allowedStateDir, expectedNormalizedTarget = null }) {
  try {
    return inspectStatusEntries({
      projectRoot,
      targetPath,
      allowedStateDir,
      allowTarget: false,
      expectedNormalizedTarget
    });
  } catch (error) {
    if (error && error.blockingReason === 'rollback-unavailable') throw error;
    if (error && error.blockingReason === 'target-only-guard-unavailable') throw error;
    return blockedGuardResult('target-only-guard-unavailable', error);
  }
}

function inspectActualChangedFiles({ projectRoot, targetPath, allowedStateDir, expectedNormalizedTarget = null }) {
  try {
    return inspectStatusEntries({
      projectRoot,
      targetPath,
      allowedStateDir,
      allowTarget: true,
      expectedNormalizedTarget,
      targetIdentityBlockingReason: 'unexpected-worktree-change'
    });
  } catch (error) {
    if (error && error.blockingReason === 'unexpected-worktree-change') {
      return blockedGuardResult('unexpected-worktree-change', error);
    }
    return blockedGuardResult('target-only-guard-unavailable', error);
  }
}

function formatFixGuardReport({
  round,
  normalizedTarget,
  targetFingerprint,
  referenceFingerprints,
  rollbackAnchor,
  targetOnlyGuard,
  lock,
  status = 'passed',
  blockingReason = 'none'
}) {
  const report = {
    round,
    normalizedTarget,
    targetFingerprint,
    referenceFingerprints: referenceFingerprints || [],
    rollbackAnchor,
    targetOnlyGuard,
    lock,
    status,
    blockingReason
  };
  return [
    '# Fix Guard Report',
    '',
    `Round: ${round}`,
    `Status: ${status}`,
    `Blocking reason: ${blockingReason}`,
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    ''
  ].join('\n');
}

module.exports = {
  checkGitRollbackAnchor,
  checkTargetOnlyWorktree,
  inspectActualChangedFiles,
  formatFixGuardReport,
  parsePorcelainStatus
};
