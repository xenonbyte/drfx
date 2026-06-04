'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PACKAGE_NAME = '@xenonbyte/drfx';
const SCHEMA_VERSION = 1;
const ADAPTER_VERSION = 'v1';
const PLATFORMS = new Set(['claude', 'codex', 'gemini']);
const CAPABILITY_NAMES = [
  'can_spawn_isolated_reviewer',
  'reviewer_write_blocked',
  'fingerprint_guard_available'
];
const STATUSES = new Set(['verified', 'unverified', 'unsupported']);
const PROOFS = new Set(['adapter-descriptor', 'local-probe', 'node-crypto-stat-probe', 'none']);
const ADAPTER_PROOFS = new Set(['adapter-descriptor', 'local-probe', 'none']);
const FINGERPRINT_PROOFS = new Set(['node-crypto-stat-probe', 'none']);
const PROVENANCE_SOURCES = new Set(['drfx-check-probe', 'runtime-capability-api', 'installer-default']);

function createRunId() {
  return crypto.randomUUID();
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isInsideOrEqual(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function realDirectory(directoryPath, label) {
  const realPath = fs.realpathSync.native(directoryPath);
  if (!fs.statSync(realPath).isDirectory()) fail('ERR_NOT_DIRECTORY', `${label} must be a directory`);
  return realPath;
}

function containsProjectStateSegment(filePath) {
  return path.resolve(filePath).split(path.sep).includes('.docs-review-fix');
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
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

function canonicalizeProbeTmpDir(directoryPath) {
  if (containsProjectStateSegment(directoryPath)) {
    fail(
      'ERR_PROBE_TMP_PROJECT_STATE',
      'fingerprint guard probe temp directory must not be inside project .docs-review-fix state'
    );
  }

  const absolute = path.resolve(directoryPath);
  const existingParent = nearestExistingParent(absolute);
  const existingParentReal = realDirectory(existingParent, 'probe temp directory parent');
  const missingRelative = path.relative(existingParent, absolute);
  const canonical = missingRelative ? path.join(existingParentReal, missingRelative) : existingParentReal;

  if (containsProjectStateSegment(canonical)) {
    fail(
      'ERR_PROBE_TMP_PROJECT_STATE',
      'fingerprint guard probe temp directory must not be inside project .docs-review-fix state'
    );
  }

  return canonical;
}

function computeFixtureFingerprint(filePath) {
  const stats = fs.statSync(filePath);
  return {
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    size: stats.size,
    mtimeMs: stats.mtimeMs
  };
}

function fingerprintChanged(before, after) {
  return before.sha256 !== after.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function runFingerprintGuardProbe({ tmpDir = os.tmpdir(), runId = createRunId() } = {}) {
  const osTmp = realDirectory(os.tmpdir(), 'OS temp directory');
  const requestedTmp = canonicalizeProbeTmpDir(tmpDir);
  if (!isInsideOrEqual(requestedTmp, osTmp)) {
    fail('ERR_PROBE_TMP_OUTSIDE_OS_TEMP', 'fingerprint guard probe temp directory must be under the OS temp directory');
  }

  fs.mkdirSync(requestedTmp, { recursive: true });

  let fixtureDir;
  try {
    fixtureDir = fs.mkdtempSync(path.join(requestedTmp, 'drfx-fingerprint-'));
    const targetFixture = path.join(fixtureDir, 'target.md');
    const referenceFixture = path.join(fixtureDir, 'reference.md');
    fs.writeFileSync(targetFixture, '# Target fixture\n');
    fs.writeFileSync(referenceFixture, '# Reference fixture\n');

    const before = {
      target: computeFixtureFingerprint(targetFixture),
      reference: computeFixtureFingerprint(referenceFixture)
    };

    fs.appendFileSync(targetFixture, '\nmutated by fingerprint probe\n');

    const after = {
      target: computeFixtureFingerprint(targetFixture),
      reference: computeFixtureFingerprint(referenceFixture)
    };
    const mutationDetected =
      fingerprintChanged(before.target, after.target) || fingerprintChanged(before.reference, after.reference);

    return {
      capability: {
        status: mutationDetected ? 'verified' : 'unverified',
        proof: mutationDetected ? 'node-crypto-stat-probe' : 'none',
        proofRunId: mutationDetected ? runId : 'none',
        detail: mutationDetected
          ? 'Mutation detection was verified against OS temp fixture files.'
          : 'Mutation detection could not be verified against OS temp fixture files.'
      },
      mutationDetected,
      fixtureDir,
      files: [targetFixture, referenceFixture],
      before,
      after
    };
  } finally {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function normalizeCapability(name, capability) {
  if (!capability || typeof capability !== 'object') {
    fail('ERR_CAPABILITY_MISSING', `missing capability: ${name}`);
  }
  const normalized = {
    status: capability.status,
    proof: capability.proof,
    proofRunId: capability.proofRunId,
    detail: capability.detail
  };
  if (!STATUSES.has(normalized.status)) fail('ERR_CAPABILITY_STATUS', `invalid capability status: ${name}`);
  if (!PROOFS.has(normalized.proof)) fail('ERR_CAPABILITY_PROOF', `invalid capability proof: ${name}`);
  const allowedProofs = name === 'fingerprint_guard_available' ? FINGERPRINT_PROOFS : ADAPTER_PROOFS;
  if (!allowedProofs.has(normalized.proof)) fail('ERR_CAPABILITY_PROOF', `invalid capability proof: ${name}`);
  if (typeof normalized.proofRunId !== 'string' || normalized.proofRunId.length === 0) {
    fail('ERR_CAPABILITY_PROOF_RUN_ID', `invalid capability proofRunId: ${name}`);
  }
  if (typeof normalized.detail !== 'string' || normalized.detail.length === 0) {
    fail('ERR_CAPABILITY_DETAIL', `invalid capability detail: ${name}`);
  }
  if (normalized.status === 'verified' && normalized.proofRunId === 'none') {
    fail('ERR_VERIFIED_CAPABILITY_PROOF_RUN_ID', `verified capability requires proofRunId: ${name}`);
  }
  if (normalized.status === 'verified' && normalized.proof === 'none') {
    fail('ERR_VERIFIED_CAPABILITY_PROOF', `verified capability requires proof: ${name}`);
  }
  if (normalized.status !== 'verified' && normalized.proofRunId !== 'none') {
    fail('ERR_UNVERIFIED_CAPABILITY_PROOF_RUN_ID', `non-verified capability proofRunId must be none: ${name}`);
  }
  if (normalized.status !== 'verified' && normalized.proof !== 'none') {
    fail('ERR_UNVERIFIED_CAPABILITY_PROOF', `non-verified capability proof must be none: ${name}`);
  }
  return normalized;
}

function advisoryReasonFor(capabilities) {
  const missing = CAPABILITY_NAMES.filter((name) => capabilities[name].status !== 'verified');
  if (missing.length === 0) return '';
  return `Advisory-only: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not verified for this run.`;
}

function buildDescriptor({
  platform,
  packageVersion,
  runId = createRunId(),
  adapterCapabilities,
  fingerprintGuard,
  adapterVersion = ADAPTER_VERSION,
  checkedAt = new Date().toISOString(),
  provenanceSource = 'drfx-check-probe',
  generatedBy = 'drfx check'
}) {
  if (!PLATFORMS.has(platform)) fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
  if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
    fail('ERR_PACKAGE_VERSION', 'packageVersion is required');
  }
  if (typeof runId !== 'string' || runId.length === 0) fail('ERR_RUN_ID', 'runId is required');
  if (!PROVENANCE_SOURCES.has(provenanceSource)) fail('ERR_PROVENANCE_SOURCE', 'invalid provenance source');

  const capabilities = {
    can_spawn_isolated_reviewer: normalizeCapability(
      'can_spawn_isolated_reviewer',
      adapterCapabilities && adapterCapabilities.can_spawn_isolated_reviewer
    ),
    reviewer_write_blocked: normalizeCapability(
      'reviewer_write_blocked',
      adapterCapabilities && adapterCapabilities.reviewer_write_blocked
    ),
    fingerprint_guard_available: normalizeCapability('fingerprint_guard_available', fingerprintGuard)
  };

  if (provenanceSource === 'installer-default') {
    for (const name of CAPABILITY_NAMES) {
      if (capabilities[name].status === 'verified') {
        fail('ERR_INSTALLER_DEFAULT_VERIFIED', 'installer-default descriptors must not contain verified capabilities');
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    packageName: PACKAGE_NAME,
    packageVersion,
    platform,
    adapterVersion,
    checkedAt,
    provenance: {
      source: provenanceSource,
      runId: provenanceSource === 'installer-default' ? 'none' : runId,
      generatedBy,
      packageVersion
    },
    capabilities,
    advisoryReason: advisoryReasonFor(capabilities)
  };
}

function validateCapabilitySchema(name, capability, errors) {
  if (!capability || typeof capability !== 'object') {
    errors.push(`${name} capability is missing`);
    return;
  }
  if (!STATUSES.has(capability.status)) errors.push(`${name} has invalid status`);
  if (!PROOFS.has(capability.proof)) errors.push(`${name} has invalid proof`);
  const allowedProofs = name === 'fingerprint_guard_available' ? FINGERPRINT_PROOFS : ADAPTER_PROOFS;
  if (!allowedProofs.has(capability.proof)) errors.push(`${name} has invalid proof for capability type`);
  if (typeof capability.proofRunId !== 'string' || capability.proofRunId.length === 0) {
    errors.push(`${name} has invalid proofRunId`);
  }
  if (typeof capability.detail !== 'string' || capability.detail.length === 0) {
    errors.push(`${name} has invalid detail`);
  }
  if (capability.status === 'verified' && capability.proofRunId === 'none') {
    errors.push(`${name} is verified but proofRunId is none`);
  }
  if (capability.status === 'verified' && capability.proof === 'none') {
    errors.push(`${name} is verified but proof is none`);
  }
  if (capability.status !== 'verified' && capability.proofRunId !== 'none') {
    errors.push(`${name} is not verified but proofRunId is not none`);
  }
  if (capability.status !== 'verified' && capability.proof !== 'none') {
    errors.push(`${name} is not verified but proof is not none`);
  }
}

function validateCurrentDescriptor(
  descriptor,
  { packageVersion, platform, runId, requireVerified = false } = {}
) {
  const errors = [];

  if (!descriptor || typeof descriptor !== 'object') {
    return {
      valid: false,
      trusted: false,
      passCapable: false,
      errors: ['descriptor is missing or malformed'],
      advisoryReason: 'Descriptor is missing or malformed.'
    };
  }

  if (descriptor.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion must be 1');
  if (descriptor.packageName !== PACKAGE_NAME) errors.push(`packageName must be ${PACKAGE_NAME}`);
  if (typeof runId !== 'string' || runId.length === 0) errors.push('current runId is required');
  if (typeof descriptor.packageVersion !== 'string' || descriptor.packageVersion.length === 0) {
    errors.push('packageVersion is required');
  } else if (packageVersion && descriptor.packageVersion !== packageVersion) {
    errors.push('descriptor packageVersion is stale');
  }
  if (platform && descriptor.platform !== platform) errors.push('descriptor platform mismatch');
  if (!PLATFORMS.has(descriptor.platform)) errors.push('descriptor platform is unsupported');
  if (typeof descriptor.adapterVersion !== 'string' || descriptor.adapterVersion.length === 0) {
    errors.push('adapterVersion is required');
  }
  if (typeof descriptor.checkedAt !== 'string' || Number.isNaN(Date.parse(descriptor.checkedAt))) {
    errors.push('checkedAt must be an ISO-8601 string');
  }

  const provenance = descriptor.provenance;
  if (!provenance || typeof provenance !== 'object') {
    errors.push('provenance is required');
  } else {
    if (!PROVENANCE_SOURCES.has(provenance.source)) errors.push('provenance.source is invalid');
    if (typeof provenance.runId !== 'string' || provenance.runId.length === 0) errors.push('provenance.runId is required');
    if (!['drfx check', 'drfx install'].includes(provenance.generatedBy)) {
      errors.push('provenance.generatedBy is invalid');
    }
    if (typeof provenance.packageVersion !== 'string' || provenance.packageVersion.length === 0) {
      errors.push('provenance.packageVersion is required');
    } else if (packageVersion && provenance.packageVersion !== packageVersion) {
      errors.push('provenance packageVersion is stale');
    }
  }

  const capabilities = descriptor.capabilities;
  if (!capabilities || typeof capabilities !== 'object') {
    errors.push('capabilities are required');
  } else {
    for (const name of CAPABILITY_NAMES) validateCapabilitySchema(name, capabilities[name], errors);
  }

  if (typeof descriptor.advisoryReason !== 'string') errors.push('advisoryReason is required');

  const verifiedNames = capabilities
    ? CAPABILITY_NAMES.filter((name) => capabilities[name] && capabilities[name].status === 'verified')
    : [];
  const allVerified = verifiedNames.length === CAPABILITY_NAMES.length;

  if (allVerified && descriptor.advisoryReason) {
    errors.push('advisoryReason must be empty when all required capabilities are verified');
  }
  if (!allVerified && !descriptor.advisoryReason) {
    errors.push('advisoryReason is required unless all capabilities are verified');
  }

  if (provenance && provenance.source === 'installer-default') {
    if (verifiedNames.length > 0) errors.push('installer-default descriptor must not contain verified capabilities');
    if (requireVerified) errors.push('installer-default descriptor is not verified proof for the current run');
  }

  if (runId && provenance && provenance.source !== 'installer-default' && provenance.runId !== runId) {
    errors.push('descriptor provenance.runId does not match current run');
  }

  if (capabilities && runId) {
    for (const name of CAPABILITY_NAMES) {
      const capability = capabilities[name];
      if (capability && capability.status === 'verified' && capability.proofRunId !== runId) {
        errors.push(`${name} proofRunId does not match current run`);
      }
    }
  }

  if (requireVerified && capabilities) {
    for (const name of CAPABILITY_NAMES) {
      const capability = capabilities[name];
      if (!capability || capability.status !== 'verified') {
        errors.push(`${name} is not verified for the current run`);
      }
    }
  }

  const schemaValid = errors.length === 0 || errors.every((error) => error.includes('not verified'));
  const trusted = errors.length === 0 && allVerified && provenance && provenance.source !== 'installer-default';
  const passCapable = trusted;

  return {
    valid: schemaValid,
    trusted,
    passCapable,
    errors,
    advisoryReason: descriptor.advisoryReason || errors.join('; ')
  };
}

function loadAdapter(platform) {
  if (!PLATFORMS.has(platform)) fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
  return require(`./adapters/${platform}`);
}

async function checkPlatformCapabilities({
  platform,
  packageVersion,
  tmpDir = os.tmpdir(),
  timeoutMs = 5000,
  runId = createRunId()
}) {
  const adapter = loadAdapter(platform);
  const adapterCapabilities = await adapter.checkCapabilities({ packageVersion, tmpDir, timeoutMs, runId });
  const fingerprintGuard = runFingerprintGuardProbe({ tmpDir, runId }).capability;
  return buildDescriptor({
    platform,
    packageVersion,
    runId,
    adapterCapabilities,
    fingerprintGuard
  });
}

async function checkPlatforms({
  platforms = ['claude', 'codex', 'gemini'],
  packageVersion,
  tmpDir = os.tmpdir(),
  timeoutMs = 5000,
  runId = createRunId()
}) {
  const descriptors = {};
  for (const platform of platforms) {
    descriptors[platform] = await checkPlatformCapabilities({ platform, packageVersion, tmpDir, timeoutMs, runId });
  }
  return descriptors;
}

module.exports = {
  createRunId,
  runFingerprintGuardProbe,
  buildDescriptor,
  validateCurrentDescriptor,
  checkPlatformCapabilities,
  checkPlatforms
};
