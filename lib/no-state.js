'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_TOKEN_BYTES = 32768;
const TOKEN_VERSION = 1;
const CONTENT_POLICY_REVIEW = 'read-in-memory-only';
const CONTENT_POLICY_STATE = 'redacted-normalized-state-only';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HASH64_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TARGET_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*-[a-f0-9]{12}$/;
const TOKEN_ID_PATTERN = /^state-[A-Za-z0-9._:-]+$/;
const GUARD_ID_PATTERN = /^guard-[A-Za-z0-9._:-]+$/;
const REVIEW_GUARD_FIELDS = Object.freeze([
  'guardId',
  'phase',
  'round',
  'normalizedTarget',
  'references',
  'targetFingerprint',
  'referenceFingerprints',
  'strictness',
  'mode',
  'assurance',
  'runtimePlatform',
  'contentPolicy'
]);
const STATE_TOKEN_FIELDS = Object.freeze([
  'tokenVersion',
  'tokenKind',
  'tokenId',
  'previousTokenSha256',
  'createdAt',
  'targetKey',
  'normalizedTarget',
  'references',
  'phase',
  'round',
  'strictness',
  'requestedMode',
  'mode',
  'assurance',
  'runtimePlatform',
  'runtimeDowngradeReason',
  'runtimeCheck',
  'guardId',
  'fingerprintSummary',
  'targetFingerprint',
  'referenceFingerprints',
  'eligibleTerminalStatuses',
  'blockingReason',
  'statusReason',
  'normalized',
  'contentPolicy'
]);
const PREFLIGHT_TOKEN_FIELDS = Object.freeze([
  'tokenVersion',
  'tokenKind',
  'tokenId',
  'createdAt',
  'targetKey',
  'normalizedTarget',
  'references',
  'strictness',
  'requestedMode',
  'mode',
  'assurance',
  'runtimePlatform',
  'runtimeDowngradeReason',
  'runtimeCheck',
  'eligibleTerminalStatuses',
  'blockingReason',
  'statusReason',
  'contentPolicy'
]);
const REVIEW_TOKEN_FIELDS = Object.freeze([
  'tokenVersion',
  'tokenKind',
  'tokenId',
  'previousTokenSha256',
  'createdAt',
  'targetKey',
  'normalizedTarget',
  'references',
  'phase',
  'round',
  'strictness',
  'mode',
  'assurance',
  'runtimePlatform',
  'runtimeDowngradeReason',
  'guardId',
  'targetFingerprint',
  'referenceFingerprints',
  'eligibleTerminalStatuses',
  'normalized',
  'contentPolicy'
]);
const TRIAGE_TOKEN_FIELDS = Object.freeze([
  'tokenVersion',
  'tokenKind',
  'tokenId',
  'previousTokenSha256',
  'createdAt',
  'targetKey',
  'normalizedTarget',
  'references',
  'phase',
  'round',
  'strictness',
  'mode',
  'assurance',
  'runtimePlatform',
  'runtimeDowngradeReason',
  'guardId',
  'targetFingerprint',
  'referenceFingerprints',
  'eligibleTerminalStatuses',
  'normalized',
  'contentPolicy'
]);
const TOKEN_KIND_FIELDS = Object.freeze({
  'preflight-terminal': PREFLIGHT_TOKEN_FIELDS,
  'review-result': REVIEW_TOKEN_FIELDS,
  'triage-result': TRIAGE_TOKEN_FIELDS
});
const STRICTNESS_VALUES = new Set(['strict', 'normal']);
const MODE_VALUES = new Set(['read-only', 'review-and-fix']);
const NO_STATE_MODES = new Set(['read-only']);
const ASSURANCE_VALUES = new Set(['advisory', 'practical']);
const RUNTIME_PLATFORMS = new Set(['codex', 'claude-code', 'gemini', 'manual']);
const REVIEW_PHASES = new Set(['initial-review']);
const TERMINAL_STATUSES = new Set(['read-only-clean', 'read-only-findings', 'unsupported', 'blocked']);
const REVIEW_RESULTS = new Set(['PASS', 'FAIL']);
const BLOCKING_REASONS = new Set([
  'reviewer-mutated-file',
  'lock-held',
  'corrupt-lock',
  'lock-release-failed',
  'reviewer-output-unparseable',
  'fingerprint-guard-unavailable',
  'fingerprint-guard-output-invalid',
  'state-validation-failed',
  'state-token-too-large',
  'final-validation-failed',
  'target-only-guard-unavailable',
  'unexpected-worktree-change',
  'reference-mutated-file',
  'fix-report-mismatch',
  'diff-review-failed',
  'rollback-unavailable',
  'unsafe-handoff-file'
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function assertSize(text, label) {
  if (byteLength(text) > MAX_TOKEN_BYTES) {
    fail('ERR_STATE_TOKEN_TOO_LARGE', `${label} exceeds ${MAX_TOKEN_BYTES} bytes: state-token-too-large`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('ERR_CANONICAL_NUMBER', 'canonical JSON only permits non-negative safe integers');
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    fail('ERR_CANONICAL_VALUE', 'canonical JSON only permits plain JSON values');
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => {
    const item = value[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      fail('ERR_CANONICAL_VALUE', `unsupported canonical JSON value for ${key}`);
    }
    return `${JSON.stringify(key)}:${canonicalStringify(item)}`;
  }).join(',')}}`;
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function encodeCanonical(value) {
  const canonical = canonicalStringify(value);
  assertSize(canonical, 'canonical JSON');
  const encoded = toBase64Url(Buffer.from(canonical, 'utf8'));
  assertSize(encoded, 'encoded token');
  return encoded;
}

function decodeCanonicalBytes(token) {
  if (typeof token !== 'string' || token === '') {
    fail('ERR_CANONICAL_TOKEN', 'canonical token must be a non-empty string');
  }
  assertSize(token, 'encoded token input');
  if (token.includes('=')) fail('ERR_CANONICAL_PADDING', 'canonical base64url token must be unpadded');
  if (/[+/]/.test(token)) fail('ERR_CANONICAL_BASE64URL', 'canonical token must use base64url, not standard base64 characters');
  if (/\s/.test(token)) fail('ERR_CANONICAL_WHITESPACE', 'canonical token must not contain whitespace');
  if (!BASE64URL_PATTERN.test(token)) fail('ERR_CANONICAL_BASE64URL', 'canonical token contains invalid base64url characters');
  if (token.length % 4 === 1) fail('ERR_CANONICAL_MALFORMED', 'malformed canonical base64url token');

  let bytes;
  try {
    bytes = Buffer.from(token, 'base64url');
  } catch (error) {
    fail('ERR_CANONICAL_MALFORMED', `malformed canonical base64url token: ${error.message}`);
  }
  if (bytes.length > MAX_TOKEN_BYTES) {
    fail('ERR_STATE_TOKEN_TOO_LARGE', `decoded canonical JSON exceeds ${MAX_TOKEN_BYTES} bytes: state-token-too-large`);
  }
  return bytes;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    fail('ERR_CANONICAL_UTF8', `canonical token is not valid UTF-8: ${error.message}`);
  }
}

function rejectUnknownFields(value, allowedFields) {
  if (!allowedFields) return;
  if (!isPlainObject(value)) fail('ERR_CANONICAL_OBJECT', 'allowed fields validation requires an object token');
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail('ERR_CANONICAL_UNKNOWN_FIELD', `unknown field: ${field}`);
  }
}

function rejectDisallowedKindFields(value, allowedFields) {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail('ERR_STATE_TOKEN_SCHEMA', `state token field not allowed for kind: ${field}`);
  }
}

function requireField(value, field) {
  if (!Object.hasOwn(value, field)) fail('ERR_STATE_TOKEN_SCHEMA', `state token missing required field: ${field}`);
  return value[field];
}

function requireString(value, field, pattern = null) {
  if (typeof value !== 'string' || value === '') fail('ERR_STATE_TOKEN_SCHEMA', `state token invalid ${field}`);
  if (pattern && !pattern.test(value)) fail('ERR_STATE_TOKEN_SCHEMA', `state token invalid ${field}`);
  return value;
}

function requireOneOf(value, allowed, field) {
  requireString(value, field);
  if (!allowed.has(value)) fail('ERR_STATE_TOKEN_SCHEMA', `state token invalid ${field}: ${value}`);
  return value;
}

function requireSafeInteger(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail('ERR_STATE_TOKEN_SCHEMA', `state token invalid ${field}`);
  }
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) fail('ERR_STATE_TOKEN_SCHEMA', `state token invalid ${field}`);
  return value;
}

function requireStringArray(value, field) {
  return requireArray(value, field).map((item) => requireString(item, field));
}

function requireObject(value, field) {
  if (!isPlainObject(value)) fail('ERR_STATE_TOKEN_SCHEMA', `state token invalid ${field}`);
  return value;
}

function requireTimestamp(value, field) {
  requireString(value, field, ISO_TIMESTAMP_PATTERN);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('ERR_STATE_TOKEN_SCHEMA', `state token invalid ${field}`);
  }
  return value;
}

function requireSha256(value, field, allowNone = false) {
  if (allowNone && value === 'none') return value;
  requireString(value, field, HASH64_PATTERN);
  return value;
}

function validateFingerprint(value, field) {
  const fingerprint = requireObject(value, field);
  rejectUnknownFields(fingerprint, ['normalizedPath', 'sha256', 'size', 'mtimeMs']);
  if (Object.hasOwn(fingerprint, 'normalizedPath')) requireString(fingerprint.normalizedPath, `${field}.normalizedPath`);
  requireSha256(requireField(fingerprint, 'sha256'), `${field}.sha256`);
  requireSafeInteger(requireField(fingerprint, 'size'), `${field}.size`);
  requireSafeInteger(requireField(fingerprint, 'mtimeMs'), `${field}.mtimeMs`);
}

function validateReferenceFingerprints(value) {
  const fingerprints = requireArray(value, 'referenceFingerprints');
  for (const fingerprint of fingerprints) validateFingerprint(fingerprint, 'referenceFingerprints[]');
}

function validateEligibleTerminalStatuses(value, tokenKind) {
  const statuses = requireArray(value, 'eligibleTerminalStatuses');
  for (const status of statuses) requireOneOf(status, TERMINAL_STATUSES, 'eligibleTerminalStatuses[]');
  if (tokenKind === 'preflight-terminal' && statuses.length !== 1) {
    fail('ERR_STATE_TOKEN_SCHEMA', 'preflight token requires exactly one eligible terminal status');
  }
  if (tokenKind === 'triage-result' && statuses.length === 0) {
    fail('ERR_STATE_TOKEN_SCHEMA', 'triage token requires an eligible terminal status');
  }
}

function validateCommonTokenSchema(decoded) {
  requireSafeInteger(requireField(decoded, 'tokenVersion'), 'tokenVersion');
  if (decoded.tokenVersion !== TOKEN_VERSION) fail('ERR_STATE_TOKEN_VERSION', 'state token version mismatch');
  requireOneOf(requireField(decoded, 'tokenKind'), new Set(Object.keys(TOKEN_KIND_FIELDS)), 'tokenKind');
  rejectDisallowedKindFields(decoded, TOKEN_KIND_FIELDS[decoded.tokenKind]);
  requireString(requireField(decoded, 'tokenId'), 'tokenId', TOKEN_ID_PATTERN);
  requireTimestamp(requireField(decoded, 'createdAt'), 'createdAt');
  requireString(requireField(decoded, 'targetKey'), 'targetKey', TARGET_KEY_PATTERN);
  requireString(requireField(decoded, 'normalizedTarget'), 'normalizedTarget');
  requireStringArray(requireField(decoded, 'references'), 'references');
  requireOneOf(requireField(decoded, 'strictness'), STRICTNESS_VALUES, 'strictness');
  requireOneOf(requireField(decoded, 'mode'), NO_STATE_MODES, 'mode');
  requireOneOf(requireField(decoded, 'assurance'), ASSURANCE_VALUES, 'assurance');
  requireOneOf(requireField(decoded, 'runtimePlatform'), RUNTIME_PLATFORMS, 'runtimePlatform');
  requireString(requireField(decoded, 'runtimeDowngradeReason'), 'runtimeDowngradeReason');
  validateEligibleTerminalStatuses(requireField(decoded, 'eligibleTerminalStatuses'), decoded.tokenKind);
}

function validatePreflightSchema(decoded) {
  validateCommonTokenSchema(decoded);
  requireOneOf(requireField(decoded, 'requestedMode'), MODE_VALUES, 'requestedMode');
  const terminalStatus = decoded.eligibleTerminalStatuses[0];
  assertTerminalPairing({
    terminalStatus,
    blockingReason: requireField(decoded, 'blockingReason'),
    statusReason: requireField(decoded, 'statusReason')
  });
}

function validateReviewBackedCommonSchema(decoded) {
  validateCommonTokenSchema(decoded);
  requireOneOf(requireField(decoded, 'phase'), REVIEW_PHASES, 'phase');
  requireSafeInteger(requireField(decoded, 'round'), 'round', 1);
  requireString(requireField(decoded, 'guardId'), 'guardId', GUARD_ID_PATTERN);
  validateFingerprint(requireField(decoded, 'targetFingerprint'), 'targetFingerprint');
  validateReferenceFingerprints(requireField(decoded, 'referenceFingerprints'));
  requireObject(requireField(decoded, 'normalized'), 'normalized');
}

function validateReviewResultSchema(decoded) {
  validateReviewBackedCommonSchema(decoded);
  if (requireField(decoded, 'previousTokenSha256') !== 'none') {
    fail('ERR_STATE_TOKEN_SCHEMA', 'review-result token requires previousTokenSha256: none');
  }
  requireOneOf(requireField(decoded.normalized, 'result'), REVIEW_RESULTS, 'normalized.result');
  requireArray(requireField(decoded.normalized, 'blockingFindings'), 'normalized.blockingFindings');
}

function validateTriageResultSchema(decoded) {
  validateReviewBackedCommonSchema(decoded);
  requireSha256(requireField(decoded, 'previousTokenSha256'), 'previousTokenSha256');
  requireArray(requireField(decoded.normalized, 'decisions'), 'normalized.decisions');
  requireArray(requireField(decoded.normalized, 'blockingFindings'), 'normalized.blockingFindings');
}

function validateStrictTokenSchema(decoded) {
  if (decoded.contentPolicy !== CONTENT_POLICY_STATE) {
    fail('ERR_STATE_TOKEN_POLICY', 'state token contentPolicy must be redacted-normalized-state-only');
  }
  if (decoded.tokenKind === 'preflight-terminal') {
    validatePreflightSchema(decoded);
    return;
  }
  if (decoded.tokenKind === 'review-result') {
    validateReviewResultSchema(decoded);
    return;
  }
  if (decoded.tokenKind === 'triage-result') {
    validateTriageResultSchema(decoded);
    return;
  }
  fail('ERR_STATE_TOKEN_KIND', `wrong state token kind: ${decoded.tokenKind}`);
}

function decodeCanonical(token, options = {}) {
  const bytes = decodeCanonicalBytes(token);
  const text = decodeUtf8(bytes);
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    fail('ERR_CANONICAL_JSON', `malformed canonical JSON: ${error.message}`);
  }

  const canonical = canonicalStringify(decoded);
  const canonicalBytes = Buffer.from(canonical, 'utf8');
  if (!canonicalBytes.equals(bytes) || encodeCanonical(decoded) !== token) {
    fail('ERR_CANONICAL_REENCODE', 'token is not canonical JSON/base64url encoding');
  }
  rejectUnknownFields(decoded, options.allowedFields);
  return decoded;
}

function canonicalSha256(token) {
  const decoded = decodeCanonical(token);
  const bytes = Buffer.from(canonicalStringify(decoded), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function nowIso(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function newTokenId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function compareCanonical(actual, expected) {
  return canonicalStringify(actual) === canonicalStringify(expected);
}

function assertEqualField(decoded, expected, field, label = field) {
  if (!Object.hasOwn(expected, field)) return;
  if (!compareCanonical(decoded[field], expected[field])) {
    fail('ERR_REVIEW_GUARD_MISMATCH', `${label} mismatch`);
  }
}

function assertFingerprintEqual(decodedValue, expectedValue) {
  if (!compareCanonical(decodedValue, expectedValue)) {
    fail(
      'ERR_REVIEWER_MUTATED_FILE',
      'reviewer-mutated-file: fingerprint mismatch'
    );
  }
}

function createReviewGuard({
  guardId = newTokenId('guard'),
  phase,
  round,
  normalizedTarget,
  references = [],
  targetFingerprint,
  referenceFingerprints = [],
  strictness,
  mode,
  assurance,
  runtimePlatform
}) {
  return encodeCanonical({
    assurance,
    contentPolicy: CONTENT_POLICY_REVIEW,
    guardId,
    mode,
    normalizedTarget,
    phase,
    referenceFingerprints,
    references,
    round,
    runtimePlatform,
    strictness,
    targetFingerprint
  });
}

function validateReviewGuard(token, expected = {}) {
  const decoded = decodeCanonical(token, { allowedFields: REVIEW_GUARD_FIELDS });
  if (decoded.contentPolicy !== CONTENT_POLICY_REVIEW) {
    fail('ERR_REVIEW_GUARD_POLICY', 'review guard contentPolicy must be read-in-memory-only');
  }
  if (!decoded.guardId) fail('ERR_REVIEW_GUARD_ID', 'review guard missing guardId');
  assertEqualField(decoded, expected, 'phase');
  assertEqualField(decoded, expected, 'round');
  assertEqualField(decoded, expected, 'normalizedTarget', 'target');
  assertEqualField(decoded, expected, 'references');
  assertEqualField(decoded, expected, 'strictness');
  assertEqualField(decoded, expected, 'mode');
  assertEqualField(decoded, expected, 'assurance');
  assertEqualField(decoded, expected, 'runtimePlatform');
  if (Object.hasOwn(expected, 'targetFingerprint')) {
    assertFingerprintEqual(decoded.targetFingerprint, expected.targetFingerprint);
  }
  if (Object.hasOwn(expected, 'referenceFingerprints')) {
    assertFingerprintEqual(decoded.referenceFingerprints, expected.referenceFingerprints);
  }
  return decoded;
}

function assertTerminalPairing({ terminalStatus, blockingReason, statusReason }) {
  if (terminalStatus === 'unsupported') {
    if (blockingReason !== 'none' || statusReason !== 'unsupported-runtime-capability') {
      fail(
        'ERR_PREFLIGHT_TERMINAL_PAIRING',
        'unsupported preflight requires blockingReason none and statusReason unsupported-runtime-capability'
      );
    }
    return;
  }
  if (terminalStatus === 'blocked') {
    if (!BLOCKING_REASONS.has(blockingReason) || statusReason !== 'none') {
      fail('ERR_PREFLIGHT_TERMINAL_PAIRING', 'blocked preflight requires allowed blocker and statusReason none');
    }
    return;
  }
  fail('ERR_PREFLIGHT_TERMINAL_STATUS', `unsupported no-state preflight terminal status: ${terminalStatus}`);
}

function createPreflightToken({
  targetKey,
  normalizedTarget,
  references = [],
  strictness,
  requestedMode,
  mode,
  assurance,
  runtimePlatform,
  runtimeDowngradeReason = 'none',
  runtimeCheck = null,
  terminalStatus,
  blockingReason,
  statusReason,
  now = new Date()
}) {
  assertTerminalPairing({ terminalStatus, blockingReason, statusReason });
  const token = {
    assurance,
    blockingReason,
    contentPolicy: CONTENT_POLICY_STATE,
    createdAt: nowIso(now),
    eligibleTerminalStatuses: [terminalStatus],
    mode,
    normalizedTarget,
    references,
    requestedMode,
    runtimeDowngradeReason,
    runtimePlatform,
    statusReason,
    strictness,
    targetKey,
    tokenId: newTokenId('state'),
    tokenKind: 'preflight-terminal',
    tokenVersion: TOKEN_VERSION
  };
  if (runtimeCheck) token.runtimeCheck = runtimeCheck;
  return encodeCanonical(token);
}

function nextStateToken({
  previousToken = null,
  tokenKind,
  targetKey,
  normalizedTarget,
  references = [],
  phase,
  round,
  strictness,
  mode,
  assurance,
  runtimePlatform,
  runtimeDowngradeReason = 'none',
  guardId,
  eligibleTerminalStatuses = [],
  normalized = {},
  targetFingerprint = null,
  referenceFingerprints = null,
  fingerprintSummary = null,
  now = new Date()
}) {
  const token = {
    assurance,
    contentPolicy: CONTENT_POLICY_STATE,
    createdAt: nowIso(now),
    eligibleTerminalStatuses,
    guardId,
    mode,
    normalized,
    normalizedTarget,
    phase,
    previousTokenSha256: previousToken ? canonicalSha256(previousToken) : 'none',
    references,
    round,
    runtimeDowngradeReason,
    runtimePlatform,
    strictness,
    targetKey,
    tokenId: newTokenId('state'),
    tokenKind,
    tokenVersion: TOKEN_VERSION
  };
  if (targetFingerprint) token.targetFingerprint = targetFingerprint;
  if (referenceFingerprints) token.referenceFingerprints = referenceFingerprints;
  if (fingerprintSummary) token.fingerprintSummary = fingerprintSummary;
  return encodeCanonical(token);
}

function assertStateField(decoded, options, field, label = field) {
  if (!Object.hasOwn(options, field)) return;
  if (!compareCanonical(decoded[field], options[field])) {
    fail('ERR_STATE_TOKEN_MISMATCH', `state token ${label} mismatch`);
  }
}

function validateStateToken(token, options = {}) {
  const decoded = decodeCanonical(token, { allowedFields: STATE_TOKEN_FIELDS });
  validateStrictTokenSchema(decoded);
  if (options.allowedKinds && !options.allowedKinds.includes(decoded.tokenKind)) {
    fail('ERR_STATE_TOKEN_KIND', `wrong state token kind: ${decoded.tokenKind}`);
  }
  if (options.previousToken !== undefined) {
    const expected = options.previousToken ? canonicalSha256(options.previousToken) : 'none';
    if (decoded.previousTokenSha256 !== expected) {
      fail('ERR_STATE_TOKEN_LINEAGE', 'state token lineage mismatch');
    }
  }
  if (options.maxAgeMs !== undefined) {
    const now = options.now instanceof Date ? options.now : new Date();
    const created = new Date(decoded.createdAt);
    if (!Number.isFinite(created.getTime())) fail('ERR_STATE_TOKEN_STALE', 'state token createdAt is invalid');
    if (now.getTime() - created.getTime() > options.maxAgeMs) {
      fail('ERR_STATE_TOKEN_STALE', 'state token is stale');
    }
  }
  assertStateField(decoded, options, 'targetKey', 'target');
  assertStateField(decoded, options, 'normalizedTarget', 'target');
  assertStateField(decoded, options, 'references');
  assertStateField(decoded, options, 'phase');
  assertStateField(decoded, options, 'round');
  assertStateField(decoded, options, 'strictness');
  assertStateField(decoded, options, 'mode');
  assertStateField(decoded, options, 'assurance');
  assertStateField(decoded, options, 'runtimePlatform');
  assertStateField(decoded, options, 'guardId');
  if (options.requiredTerminalStatus && !decoded.eligibleTerminalStatuses.includes(options.requiredTerminalStatus)) {
    fail('ERR_STATE_TOKEN_TERMINAL', `state token does not allow ${options.requiredTerminalStatus}`);
  }
  return decoded;
}

module.exports = {
  encodeCanonical,
  decodeCanonical,
  createReviewGuard,
  validateReviewGuard,
  createPreflightToken,
  validateStateToken,
  nextStateToken
};
