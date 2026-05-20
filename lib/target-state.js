'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_STATUSES = Object.freeze([
  'review',
  'triage',
  'fix',
  'diff-review',
  'full-re-review',
  'pass',
  'stopped-with-deferrals',
  'read-only-findings',
  'blocked',
  'unsupported',
  'externally-changed',
  'possible-target-replacement',
  'checkpoint'
]);

const RESERVED_BASENAMES = new Set(['MANIFEST.md', 'CONTINUITY.md', 'SUMMARY.md']);
const RESERVED_DIRECTORIES = new Set(['LOCK', 'stale-locks', 'rounds']);

const MANIFEST_FIELDS = [
  ['target', 'Target'],
  ['normalizedTarget', 'Normalized target'],
  ['documentType', 'Document type'],
  ['strictness', 'Strictness'],
  ['mode', 'Mode'],
  ['targetKey', 'Target key'],
  ['ledgerPath', 'Ledger path'],
  ['status', 'Status'],
  ['currentRound', 'Current round'],
  ['initialContentSha256', 'Initial content sha256'],
  ['lastKnownContentSha256', 'Last known content sha256'],
  ['lastReviewedContentSha256', 'Last reviewed content sha256'],
  ['lastPassedContentSha256', 'Last passed content sha256'],
  ['lastModifiedAt', 'Last modified at'],
  ['fileSize', 'File size']
];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function realExistingFile(filePath, label) {
  const absolute = path.resolve(filePath);
  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    fail('ERR_FILE_MISSING', `${label} file must exist: ${filePath}`);
  }
  if (!stats.isFile()) fail('ERR_FILE_MISSING', `${label} file must exist: ${filePath}`);
  return fs.realpathSync.native(absolute);
}

function realExistingDirectory(directoryPath, label) {
  const absolute = path.resolve(directoryPath);
  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    fail('ERR_DIRECTORY_MISSING', `${label} directory must exist: ${directoryPath}`);
  }
  if (!stats.isDirectory()) fail('ERR_DIRECTORY_MISSING', `${label} directory must exist: ${directoryPath}`);
  return fs.realpathSync.native(absolute);
}

function isInsideOrEqual(childRealPath, parentRealPath) {
  const relative = path.relative(parentRealPath, childRealPath);
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertTargetInsideRoot(rootRealPath, targetRealPath) {
  if (!isInsideOrEqual(targetRealPath, rootRealPath)) {
    fail('ERR_TARGET_OUTSIDE_ROOT', 'Project root must contain target');
  }
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function findAncestor(startPath, predicate) {
  let current = startPath;
  while (true) {
    if (predicate(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findGitRoot(startPath) {
  return findAncestor(startPath, (candidate) => pathExists(path.join(candidate, '.git')));
}

function findStateRoot(startPath) {
  return findAncestor(startPath, (candidate) => {
    const stateDir = path.join(candidate, '.docs-review-fix');
    return fs.existsSync(path.join(stateDir, 'RULE.md')) || fs.existsSync(path.join(stateDir, 'targets'));
  });
}

function nearestExistingParent(filePath) {
  let current = path.resolve(filePath);
  while (!pathExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function canonicalizePossiblyMissing(filePath) {
  const absolute = path.resolve(filePath);
  const existingParent = nearestExistingParent(absolute);
  const parentRealPath = fs.realpathSync.native(existingParent);
  const missingRelative = path.relative(existingParent, absolute);
  return missingRelative ? path.join(parentRealPath, missingRelative) : parentRealPath;
}

function assertNoSymlinkInExistingPath(filePath, stopAt) {
  const absolute = path.resolve(filePath);
  const stop = path.resolve(stopAt);
  const relative = path.relative(stop, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return;

  let current = stop;
  const parts = relative.split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    if (!pathExists(current)) return;
    if (fs.lstatSync(current).isSymbolicLink()) {
      fail('ERR_LEDGER_SYMLINK', 'ledger path must not be a symlink or pass through one');
    }
  }
}

function toPosixRelative(rootRealPath, fileRealPath) {
  const relative = path.relative(rootRealPath, fileRealPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('ERR_TARGET_OUTSIDE_ROOT', 'Project root must contain target');
  }
  return relative.split(path.sep).join('/');
}

function slugifyTarget(normalizedTarget) {
  const basename = path.posix.basename(normalizedTarget);
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return slug || 'target';
}

function computeFingerprint(filePath) {
  const absolute = path.resolve(filePath);
  const stats = fs.statSync(absolute);
  if (!stats.isFile()) fail('ERR_FILE_MISSING', `target file must exist: ${filePath}`);
  const content = fs.readFileSync(absolute);
  return {
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    size: stats.size,
    mtimeMs: stats.mtimeMs
  };
}

function deriveTargetKey(projectRoot, targetPath) {
  const rootRealPath = realExistingDirectory(projectRoot, 'project root');
  const targetRealPath = realExistingFile(targetPath, 'target');
  assertTargetInsideRoot(rootRealPath, targetRealPath);
  const normalizedTarget = toPosixRelative(rootRealPath, targetRealPath);
  const slug = slugifyTarget(normalizedTarget);
  const hash12 = crypto.createHash('sha256').update(normalizedTarget).digest('hex').slice(0, 12);
  return {
    normalizedTarget,
    slug,
    hash12,
    targetKey: `${slug}-${hash12}`
  };
}

function resolveProjectRoot({ explicitRoot, targetPath, cwd = process.cwd(), persistentStateRequired = false }) {
  const targetRealPath = realExistingFile(targetPath, 'target');
  if (explicitRoot) {
    const rootRealPath = realExistingDirectory(explicitRoot, 'project root');
    assertTargetInsideRoot(rootRealPath, targetRealPath);
    return rootRealPath;
  }

  const targetDirectory = path.dirname(targetRealPath);
  const cwdRealPath = realExistingDirectory(cwd, 'current working');
  const gitRootFromTarget = findGitRoot(targetDirectory);
  if (gitRootFromTarget) {
    const rootRealPath = fs.realpathSync.native(gitRootFromTarget);
    assertTargetInsideRoot(rootRealPath, targetRealPath);
    return rootRealPath;
  }

  const gitRootFromCwd = findGitRoot(cwdRealPath);
  if (gitRootFromCwd) {
    const rootRealPath = fs.realpathSync.native(gitRootFromCwd);
    if (isInsideOrEqual(targetRealPath, rootRealPath)) return rootRealPath;
  }

  const stateRoot = findStateRoot(targetDirectory);
  if (stateRoot) {
    const rootRealPath = fs.realpathSync.native(stateRoot);
    assertTargetInsideRoot(rootRealPath, targetRealPath);
    return rootRealPath;
  }

  if (isInsideOrEqual(targetRealPath, cwdRealPath)) return cwdRealPath;
  if (persistentStateRequired) {
    fail('ERR_EXPLICIT_ROOT_REQUIRED', 'Unable to resolve project root for persistent state; pass explicit root=');
  }
  return null;
}

function normalizeReferences({ projectRoot, references = [], targetPath = null }) {
  const rootRealPath = realExistingDirectory(projectRoot, 'project root');
  const targetRealPath = targetPath ? realExistingFile(targetPath, 'target') : null;
  return references.map((referencePath) => {
    const absolutePath = path.resolve(referencePath);
    const realPath = realExistingFile(referencePath, 'reference');
    if (targetRealPath && realPath === targetRealPath) {
      fail('ERR_REF_EQUALS_TARGET', 'reference path resolves to target path');
    }
    return {
      path: absolutePath,
      realPath,
      external: !isInsideOrEqual(realPath, rootRealPath),
      readOnly: true
    };
  });
}

function targetStateDir(projectRootRealPath, targetKey) {
  return path.join(projectRootRealPath, '.docs-review-fix', 'targets', targetKey);
}

function isReservedLedgerRelativePath(relativePath) {
  const parts = relativePath.split(path.sep).filter(Boolean);
  if (parts.length === 0) return true;
  if (RESERVED_DIRECTORIES.has(parts[0])) return true;
  return parts.some((part) => RESERVED_BASENAMES.has(part));
}

function validateLedgerPath({ projectRoot, targetKey, ledgerPath }) {
  const rootRealPath = realExistingDirectory(projectRoot, 'project root');
  const targetDirPath = targetStateDir(rootRealPath, targetKey);
  const requestedLedgerPath = path.isAbsolute(ledgerPath) ? ledgerPath : path.resolve(rootRealPath, ledgerPath);
  const ledgerAbsolutePath = canonicalizePossiblyMissing(requestedLedgerPath);
  const lexicalRelative = path.relative(targetDirPath, ledgerAbsolutePath);

  if (lexicalRelative === '' || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    fail('ERR_LEDGER_OUTSIDE_TARGET_STATE', 'ledger path is outside target state directory');
  }
  if (isReservedLedgerRelativePath(lexicalRelative)) {
    fail('ERR_LEDGER_RESERVED_PATH', 'ledger path must not use reserved target-state paths');
  }

  const targetDirRealPath = pathExists(targetDirPath) ? fs.realpathSync.native(targetDirPath) : targetDirPath;
  assertNoSymlinkInExistingPath(ledgerAbsolutePath, rootRealPath);

  const existingParent = nearestExistingParent(ledgerAbsolutePath);
  const parentRealPath = fs.realpathSync.native(existingParent);
  if (pathExists(targetDirPath) && !isInsideOrEqual(parentRealPath, targetDirRealPath)) {
    fail('ERR_LEDGER_OUTSIDE_TARGET_STATE', 'ledger path resolves outside target state directory');
  }

  if (pathExists(ledgerAbsolutePath)) {
    const ledgerStats = fs.statSync(ledgerAbsolutePath);
    if (ledgerStats.isDirectory()) {
      fail('ERR_LEDGER_DIRECTORY', 'ledger path must be a file path, not a directory');
    }
    const ledgerRealPath = fs.realpathSync.native(ledgerAbsolutePath);
    if (!isInsideOrEqual(ledgerRealPath, targetDirRealPath)) {
      fail('ERR_LEDGER_OUTSIDE_TARGET_STATE', 'ledger path resolves outside target state directory');
    }
    const realRelative = path.relative(targetDirRealPath, ledgerRealPath);
    if (isReservedLedgerRelativePath(realRelative)) {
      fail('ERR_LEDGER_RESERVED_PATH', 'ledger path resolves to reserved target-state paths');
    }
  }

  return path.resolve(requestedLedgerPath);
}

function shouldCreatePersistentState({ mode, ledger, resume, round, auditTrail, checkpointReason }) {
  return !(mode === 'read-only' &&
    !ledger &&
    !resume &&
    Number(round || 1) <= 1 &&
    !auditTrail &&
    !checkpointReason);
}

function assertAllowedStatus(status) {
  if (!ALLOWED_STATUSES.includes(status)) {
    fail('ERR_UNKNOWN_MANIFEST_STATUS', `Unknown status in manifest: ${status}`);
  }
}

function requireManifestValue(manifest, key) {
  if (manifest[key] === undefined || manifest[key] === null || manifest[key] === '') {
    fail('ERR_INVALID_MANIFEST', `Manifest missing field: ${key}`);
  }
  return manifest[key];
}

function formatManifest(manifest) {
  assertAllowedStatus(manifest.status);
  const lines = ['# Review Target Manifest', ''];
  for (const [key, label] of MANIFEST_FIELDS) {
    lines.push(`${label}: ${requireManifestValue(manifest, key)}`);
  }
  lines.push('References:');
  for (const reference of manifest.references || []) {
    lines.push(`- ${reference}`);
  }
  lines.push(`Created at: ${requireManifestValue(manifest, 'createdAt')}`);
  lines.push(`Updated at: ${requireManifestValue(manifest, 'updatedAt')}`);
  return `${lines.join('\n')}\n`;
}

function parseManifest(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '# Review Target Manifest') {
    fail('ERR_INVALID_MANIFEST', 'Manifest must start with review target heading');
  }

  const result = {};
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line === '') continue;
    if (line === 'References:') {
      result.references = [];
      while (index < lines.length && lines[index].startsWith('- ')) {
        result.references.push(lines[index].slice(2));
        index += 1;
      }
      index -= 1;
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const label = line.slice(0, separator);
    const value = line.slice(separator + 1).trimStart();
    const field = MANIFEST_FIELDS.find(([, expectedLabel]) => expectedLabel === label);
    if (field) {
      result[field[0]] = value;
    } else if (label === 'Created at') {
      result.createdAt = value;
    } else if (label === 'Updated at') {
      result.updatedAt = value;
    }
  }

  if (!result.references) result.references = [];
  assertAllowedStatus(result.status);
  for (const [key] of MANIFEST_FIELDS) requireManifestValue(result, key);
  requireManifestValue(result, 'createdAt');
  requireManifestValue(result, 'updatedAt');
  return result;
}

function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, formatManifest(manifest));
}

function readManifest(manifestPath) {
  return parseManifest(fs.readFileSync(manifestPath, 'utf8'));
}

function compareManifestTarget({ manifest, requestedTargetPath, projectRoot = null }) {
  const requestedRealPath = realExistingFile(requestedTargetPath, 'requested target');
  if (path.isAbsolute(manifest.target) && pathExists(manifest.target)) {
    const manifestRealPath = realExistingFile(manifest.target, 'manifest target');
    if (manifestRealPath !== requestedRealPath) {
      fail('ERR_RESUME_TARGET_PATH_CONFLICT', 'resume target path conflict');
    }
  }

  const relativeFields = [];
  if (manifest.target && !path.isAbsolute(manifest.target)) {
    relativeFields.push(['target', manifest.target]);
  }
  if (manifest.normalizedTarget) {
    if (path.isAbsolute(manifest.normalizedTarget)) {
      fail('ERR_RESUME_TARGET_PATH_CONFLICT', 'resume target path conflict');
    }
    relativeFields.push(['normalizedTarget', manifest.normalizedTarget]);
  }

  if (relativeFields.length > 0) {
    if (!projectRoot) {
      fail('ERR_PROJECT_ROOT_REQUIRED', 'projectRoot is required to verify resume target state safely');
    }
    const rootRealPath = realExistingDirectory(projectRoot, 'project root');
    assertTargetInsideRoot(rootRealPath, requestedRealPath);
    const requestedRelativeTarget = toPosixRelative(rootRealPath, requestedRealPath);
    for (const [, manifestRelativeTarget] of relativeFields) {
      if (requestedRelativeTarget !== manifestRelativeTarget.split(path.sep).join('/')) {
        fail('ERR_RESUME_TARGET_PATH_CONFLICT', 'resume target path conflict');
      }
    }
  } else if (manifest.target && !pathExists(manifest.target)) {
    if (!projectRoot) {
      fail('ERR_PROJECT_ROOT_REQUIRED', 'projectRoot is required to verify resume target state safely');
    }
    const rootRealPath = realExistingDirectory(projectRoot, 'project root');
    assertTargetInsideRoot(rootRealPath, requestedRealPath);
    const manifestTargetPath = path.resolve(rootRealPath, manifest.target);
    if (!pathExists(manifestTargetPath) || fs.realpathSync.native(manifestTargetPath) !== requestedRealPath) {
      fail('ERR_RESUME_TARGET_PATH_CONFLICT', 'resume target path conflict');
    }
  }
  return requestedRealPath;
}

function evaluateResumeState({
  manifest,
  requestedTargetPath,
  requestedStrictness = null,
  requestedMode = null,
  currentFingerprint,
  replacementDetected = false,
  projectRoot = null
}) {
  compareManifestTarget({ manifest, requestedTargetPath, projectRoot });

  if (requestedStrictness && requestedStrictness !== manifest.strictness) {
    return {
      ...manifest,
      conflict: { field: 'strictness', manifest: manifest.strictness, requested: requestedStrictness }
    };
  }
  if (requestedMode && requestedMode !== manifest.mode) {
    return {
      ...manifest,
      conflict: { field: 'mode', manifest: manifest.mode, requested: requestedMode }
    };
  }
  if (replacementDetected) {
    return {
      ...manifest,
      status: 'possible-target-replacement',
      requiresUserDecision: true
    };
  }

  const currentSha256 = currentFingerprint && currentFingerprint.sha256;
  if (currentSha256 && manifest.status === 'pass' && currentSha256 !== manifest.lastPassedContentSha256) {
    return {
      ...manifest,
      status: 'review',
      stalePass: true,
      requiresFullReview: true,
      lastPassedContentSha256: 'none'
    };
  }
  if (currentSha256 && manifest.status !== 'pass' && currentSha256 !== manifest.lastKnownContentSha256) {
    return {
      ...manifest,
      status: 'externally-changed',
      requiresFullReview: true
    };
  }
  return {
    ...manifest,
    strictness: manifest.strictness,
    mode: manifest.mode,
    ledgerPath: manifest.ledgerPath
  };
}

module.exports = {
  ALLOWED_STATUSES,
  computeFingerprint,
  deriveTargetKey,
  resolveProjectRoot,
  validateLedgerPath,
  normalizeReferences,
  shouldCreatePersistentState,
  formatManifest,
  parseManifest,
  writeManifest,
  readManifest,
  evaluateResumeState
};
