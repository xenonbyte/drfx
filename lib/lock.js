'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeFingerprint, readManifest } = require('./target-state');

const SCHEMA_VERSION = 1;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const REQUIRED_LEASE_FIELDS = [
  'schemaVersion',
  'targetKey',
  'targetPath',
  'ownerId',
  'processId',
  'hostname',
  'startedAt',
  'updatedAt',
  'expiresAt',
  'mode',
  'strictness',
  'targetFingerprintAtAcquire'
];

function lockPaths(projectRoot, targetKey) {
  const targetDir = path.join(path.resolve(projectRoot), '.drfx', 'targets', targetKey);
  const lockDir = path.join(targetDir, 'LOCK');
  const staleDir = path.join(targetDir, 'stale-locks');
  return {
    targetDir,
    lockDir,
    leasePath: path.join(lockDir, 'lease.json'),
    staleDir,
    mutationDir: path.join(staleDir, '.mutation')
  };
}

function makeError(code, status, reason, message, metadata = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.reason = reason;
  Object.assign(error, metadata);
  return error;
}

function corruptLock(lockDir, cause = null) {
  return makeError(
    'ERR_CORRUPT_LOCK',
    'blocked',
    'corrupt-lock',
    `lock lease is missing or invalid: ${lockDir}`,
    { lockDir, cause }
  );
}

function lockHeld(lockDir, lease) {
  return makeError(
    'ERR_LOCK_HELD',
    'blocked',
    'lock-held',
    `target lock is held by another owner: ${lockDir}`,
    { lockDir, lease }
  );
}

function mutationLockHeld(lockDir, mutationDir) {
  return makeError(
    'ERR_LOCK_HELD',
    'blocked',
    'lock-held',
    `target lock mutation is already in progress: ${mutationDir}`,
    { lockDir, mutationDir }
  );
}

function externallyChanged(reason, metadata) {
  return makeError(
    'ERR_EXTERNALLY_CHANGED',
    'externally-changed',
    reason,
    `target fingerprint changed before lock operation: ${reason}`,
    metadata
  );
}

function releaseFailed(lockDir, lease, cause) {
  return makeError(
    'ERR_LOCK_RELEASE_FAILED',
    'blocked',
    'lock-release-failed',
    `failed to release target lock after owner verification: ${lockDir}`,
    { lockDir, lease, cause }
  );
}

function parseDateMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function assertFingerprintShape(fingerprint) {
  return fingerprint
    && typeof fingerprint.sha256 === 'string'
    && typeof fingerprint.size === 'number'
    && typeof fingerprint.mtimeMs === 'number';
}

function validateLease(lease, lockDir) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) throw corruptLock(lockDir);
  for (const field of REQUIRED_LEASE_FIELDS) {
    if (!(field in lease)) throw corruptLock(lockDir);
  }
  if (lease.schemaVersion !== SCHEMA_VERSION) throw corruptLock(lockDir);
  if ('leaseId' in lease && typeof lease.leaseId !== 'string') throw corruptLock(lockDir);
  if (!assertFingerprintShape(lease.targetFingerprintAtAcquire)) throw corruptLock(lockDir);
  if (parseDateMs(lease.startedAt) === null || parseDateMs(lease.updatedAt) === null || parseDateMs(lease.expiresAt) === null) {
    throw corruptLock(lockDir);
  }
  return lease;
}

function readLease({ projectRoot, targetKey }) {
  const { lockDir, leasePath } = lockPaths(projectRoot, targetKey);
  if (!fs.existsSync(lockDir)) return null;
  let text;
  try {
    text = fs.readFileSync(leasePath, 'utf8');
  } catch (error) {
    throw corruptLock(lockDir, error);
  }
  try {
    return validateLease(JSON.parse(text), lockDir);
  } catch (error) {
    if (error && error.reason === 'corrupt-lock') throw error;
    throw corruptLock(lockDir, error);
  }
}

function readPersistedLeaseForTarget({ projectRoot, targetKey, targetPath = null }) {
  const { lockDir } = lockPaths(projectRoot, targetKey);
  const lease = readLease({ projectRoot, targetKey });
  if (!lease) throw corruptLock(lockDir);
  if (lease.targetKey !== targetKey) throw corruptLock(lockDir);
  if (targetPath && path.resolve(lease.targetPath) !== path.resolve(targetPath)) {
    throw corruptLock(lockDir);
  }
  return lease;
}

function writeLease(leasePath, lease) {
  fs.writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
}

function createLease({ targetKey, targetPath, ownerId, mode, strictness, now, leaseMs }) {
  const startedAt = now.toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    leaseId: crypto.randomUUID(),
    targetKey,
    targetPath: path.resolve(targetPath),
    ownerId,
    processId: process.pid,
    hostname: os.hostname(),
    startedAt,
    updatedAt: startedAt,
    expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    mode,
    strictness,
    targetFingerprintAtAcquire: computeFingerprint(targetPath)
  };
}

function timestampForPath(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function trustedBaselineSha({ lastKnownContentSha256, manifest }) {
  if (lastKnownContentSha256) return lastKnownContentSha256;
  if (manifest && manifest.lastKnownContentSha256) return manifest.lastKnownContentSha256;
  return null;
}

function withTargetMutationLock({ projectRoot, targetKey }, operation) {
  const { lockDir, staleDir, mutationDir } = lockPaths(projectRoot, targetKey);
  fs.mkdirSync(staleDir, { recursive: true });
  try {
    fs.mkdirSync(mutationDir);
  } catch (error) {
    if (error && error.code === 'EEXIST') throw mutationLockHeld(lockDir, mutationDir);
    throw error;
  }

  try {
    return operation();
  } finally {
    fs.rmdirSync(mutationDir);
  }
}

function archiveStaleLease({ projectRoot, targetKey, staleLease, now }) {
  const { leasePath, lockDir, staleDir } = lockPaths(projectRoot, targetKey);
  fs.mkdirSync(staleDir, { recursive: true });
  const archivePath = path.join(staleDir, `${timestampForPath(now)}.json`);
  fs.writeFileSync(archivePath, `${JSON.stringify(staleLease, null, 2)}\n`, { flag: 'wx' });
  fs.unlinkSync(leasePath);
  fs.rmdirSync(lockDir);
  return archivePath;
}

function acquireLock({
  projectRoot,
  targetKey,
  targetPath,
  ownerId,
  mode = 'review-and-fix',
  strictness = 'normal',
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  lastKnownContentSha256 = null,
  manifest = null,
  _onAfterValidateBeforeArchive = null
}) {
  const { targetDir, lockDir, leasePath } = lockPaths(projectRoot, targetKey);
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    return withTargetMutationLock({ projectRoot, targetKey }, () => {
      const existingLease = readLease({ projectRoot, targetKey });
      if (!existingLease) throw corruptLock(lockDir);
      const expiresAtMs = parseDateMs(existingLease.expiresAt);
      if (expiresAtMs === null) throw corruptLock(lockDir);
      if (expiresAtMs > now.getTime()) throw lockHeld(lockDir, existingLease);

      const currentFingerprint = computeFingerprint(targetPath);
      const baselineSha = trustedBaselineSha({ lastKnownContentSha256, manifest });
      if (!baselineSha || currentFingerprint.sha256 !== baselineSha) {
        throw externallyChanged('stale-fingerprint-mismatch', {
          lockDir,
          lease: existingLease,
          currentFingerprint,
          baselineSha
        });
      }
      if (_onAfterValidateBeforeArchive) _onAfterValidateBeforeArchive(existingLease);
      archiveStaleLease({ projectRoot, targetKey, staleLease: existingLease, now });
      fs.mkdirSync(lockDir);
      const takeoverLease = createLease({ targetKey, targetPath, ownerId, mode, strictness, now, leaseMs });
      writeLease(leasePath, takeoverLease);
      return takeoverLease;
    });
  }

  try {
    const lease = createLease({ targetKey, targetPath, ownerId, mode, strictness, now, leaseMs });
    writeLease(leasePath, lease);
    return lease;
  } catch (error) {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Leave the original acquire failure intact; non-empty lock cleanup is handled by normal lock validation.
    }
    throw error;
  }
}

function refreshLock({
  projectRoot,
  targetKey,
  ownerId,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  _onAfterValidateBeforeWrite = null
}) {
  const { lockDir, leasePath } = lockPaths(projectRoot, targetKey);
  return withTargetMutationLock({ projectRoot, targetKey }, () => {
    const lease = readLease({ projectRoot, targetKey });
    if (!lease) throw corruptLock(lockDir);
    if (lease.ownerId !== ownerId) throw lockHeld(lockDir, lease);

    const refreshed = {
      ...lease,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString()
    };
    if (_onAfterValidateBeforeWrite) _onAfterValidateBeforeWrite(lease);
    writeLease(leasePath, refreshed);
    return refreshed;
  });
}

function fingerprintsMatch(current, baseline) {
  return current.sha256 === baseline.sha256
    && current.size === baseline.size
    && current.mtimeMs === baseline.mtimeMs;
}

function manifestLastKnownSha({ manifest, manifestPath, projectRoot, targetKey }) {
  if (manifest && manifest.lastKnownContentSha256) return manifest.lastKnownContentSha256;
  if (manifestPath) return readManifest(manifestPath).lastKnownContentSha256;
  if (projectRoot && targetKey) {
    const defaultPath = path.join(path.resolve(projectRoot), '.drfx', 'targets', targetKey, 'MANIFEST.md');
    if (fs.existsSync(defaultPath)) return readManifest(defaultPath).lastKnownContentSha256;
  }
  return null;
}

function assertPreFixFingerprint({
  targetPath,
  lease,
  projectRoot = null,
  targetKey = null,
  manifest = null,
  manifestPath = null
}) {
  const activeLease = lease || readLease({ projectRoot, targetKey });
  if (!activeLease) throw corruptLock(lockPaths(projectRoot, targetKey).lockDir);
  const currentFingerprint = computeFingerprint(targetPath);

  if (!fingerprintsMatch(currentFingerprint, activeLease.targetFingerprintAtAcquire)) {
    throw externallyChanged('target-fingerprint-mismatch', {
      lease: activeLease,
      currentFingerprint,
      baselineFingerprint: activeLease.targetFingerprintAtAcquire
    });
  }

  const lastKnownContentSha256 = manifestLastKnownSha({ manifest, manifestPath, projectRoot, targetKey });
  if (lastKnownContentSha256 && currentFingerprint.sha256 !== lastKnownContentSha256) {
    throw externallyChanged('manifest-fingerprint-mismatch', {
      lease: activeLease,
      currentFingerprint,
      lastKnownContentSha256
    });
  }
  return currentFingerprint;
}

function releaseLock({ projectRoot, targetKey, ownerId, _onAfterValidateBeforeDelete = null }) {
  const { lockDir, leasePath } = lockPaths(projectRoot, targetKey);
  return withTargetMutationLock({ projectRoot, targetKey }, () => {
    const lease = readLease({ projectRoot, targetKey });
    if (!lease) return { released: false };
    if (lease.ownerId !== ownerId) throw lockHeld(lockDir, lease);

    if (_onAfterValidateBeforeDelete) _onAfterValidateBeforeDelete(lease);
    try {
      fs.unlinkSync(leasePath);
      fs.rmdirSync(lockDir);
    } catch (error) {
      throw releaseFailed(lockDir, lease, error);
    }
    return { released: true };
  });
}

module.exports = {
  acquireLock,
  refreshLock,
  assertPreFixFingerprint,
  releaseLock,
  readLease,
  readPersistedLeaseForTarget
};
