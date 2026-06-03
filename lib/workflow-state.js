'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { redactSensitive } = require('./redaction');

const STATUS_VALUES = Object.freeze([
  'review',
  'triage',
  'fix',
  'diff-review',
  'full-re-review',
  'pass',
  'read-only-clean',
  'stopped-with-deferrals',
  'stopped-no-progress',
  'read-only-findings',
  'blocked',
  'unsupported',
  'externally-changed',
  'possible-target-replacement',
  'checkpoint'
]);
const ACTIVE_STATUS_PHASES = Object.freeze({
  review: 'review',
  triage: 'triage',
  fix: 'fix',
  'diff-review': 'diff-review',
  'full-re-review': 'full-re-review'
});
const PHASE_VALUES = Object.freeze([
  'review',
  'triage',
  'fix',
  'diff-review',
  'full-re-review',
  'final'
]);
const BLOCKING_REASONS = Object.freeze([
  'none',
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
const STATUS_REASONS = Object.freeze([
  'none',
  'strict-proof-validation-failed',
  'target-fingerprint-mismatch',
  'manifest-fingerprint-mismatch',
  'stale-fingerprint-mismatch',
  'same-path-replacement-suspected',
  'read-only-blocking-findings',
  'deferred-findings',
  'no-progress-detected',
  'unsupported-runtime-capability',
  'advisory-review-and-fix-unsupported',
  'git-guard-unavailable',
  'checkpoint-requested'
]);

const DOCUMENT_TYPES = Object.freeze(['SPEC', 'PLAN', 'DESIGN', 'COMMON']);
const STRICTNESS_VALUES = Object.freeze(['strict', 'normal']);
const MODE_VALUES = Object.freeze(['read-only', 'review-and-fix']);
const GUARD_MODE_VALUES = Object.freeze(['git', 'snapshot']);
const ASSURANCE_VALUES = Object.freeze(['practical', 'strict-verified', 'advisory']);
const RUNTIME_PLATFORMS = Object.freeze(['codex', 'claude-code', 'gemini', 'manual']);
const DESCRIPTOR_PLATFORMS = Object.freeze(['none', 'codex', 'claude', 'gemini']);
const SUBAGENT_PROBES = Object.freeze(['ready', 'unavailable', 'failed', 'not-required']);
const SUBAGENT_PROBE_EVIDENCE = Object.freeze(['route-asserted-ready', 'none']);
const FINGERPRINT_GUARDS = Object.freeze(['passed', 'unavailable', 'output-invalid', 'not-run']);
const STDIN_HANDOFFS = Object.freeze(['ready', 'unavailable', 'not-required']);
const STDIN_HANDOFF_EVIDENCE = Object.freeze(['route-asserted-ready', 'none']);
const DOWNGRADE_REASONS = Object.freeze([
  'none',
  'subagent-delegation-unavailable',
  'reviewer-dispatch-failed',
  'reviewer-probe-invalid'
]);

const TARGET_CONTEXT_KINDS = Object.freeze(['document', 'pr', 'code']);

// Fields shared by every target-context kind. Written in this order at the head
// of every manifest. The kind-specific block (document single-file identity vs
// file-set identity) is appended right before the report-path fields.
const MANIFEST_V2_COMMON_HEAD_FIELDS = Object.freeze([
  ['manifestSchema', 'Manifest schema'],
  ['target', 'Target'],
  ['normalizedTarget', 'Normalized target'],
  ['documentType', 'Document type'],
  ['strictness', 'Strictness'],
  ['mode', 'Mode'],
  ['guardMode', 'Guard mode'],
  ['targetKey', 'Target key'],
  ['ledgerPath', 'Ledger path'],
  ['status', 'Status'],
  ['currentPhase', 'Current phase'],
  ['currentRound', 'Current round'],
  ['fixAttemptCount', 'Fix attempt count'],
  ['assurance', 'Assurance'],
  ['runtimePlatform', 'Runtime platform'],
  ['descriptorPlatform', 'Descriptor platform'],
  ['assuranceProof', 'Assurance proof'],
  ['runtimeSubagentProbe', 'Runtime subagent probe'],
  ['runtimeSubagentProbeEvidence', 'Runtime subagent probe evidence'],
  ['runtimeFingerprintGuard', 'Runtime fingerprint guard'],
  ['runtimeStdinHandoff', 'Runtime stdin handoff'],
  ['runtimeStdinHandoffEvidence', 'Runtime stdin handoff evidence'],
  ['runtimeDowngradeReason', 'Runtime downgrade reason'],
  ['blockingReason', 'Blocking reason'],
  ['statusReason', 'Status reason'],
  ['currentReportPath', 'Current report path'],
  ['lastReviewerReportPath', 'Last reviewer report path'],
  ['lastTriageReportPath', 'Last triage report path'],
  ['lastFixReportPath', 'Last fix report path'],
  ['lastDiffReviewReportPath', 'Last diff review report path']
]);

// Single-document identity block — emitted only for the (default) document kind.
const MANIFEST_V2_DOCUMENT_FIELDS = Object.freeze([
  ['initialContentSha256', 'Initial content sha256'],
  ['lastKnownContentSha256', 'Last known content sha256'],
  ['lastReviewedContentSha256', 'Last reviewed content sha256'],
  ['lastPassedContentSha256', 'Last passed content sha256'],
  ['lastModifiedAt', 'Last modified at'],
  ['fileSize', 'File size']
]);

// PR file-set identity block — emitted only for the pr kind. PR diffs carry git
// base/merge-base/head identity in addition to the shared file-set fields.
const MANIFEST_V2_PR_FILESET_FIELDS = Object.freeze([
  ['base', 'Base'],
  ['baseRevision', 'Base revision'],
  ['mergeBase', 'Merge base'],
  ['head', 'Head'],
  ['fileSetFingerprint', 'File set fingerprint'],
  ['roundLimit', 'Round limit'],
  ['lastModifiedAt', 'Last modified at']
]);

// CODE file-set identity block (PLAN-TASK-004) — emitted only for the code
// kind. CODE has NO base/merge-base/head; instead it stores normalized scopes
// and exclusions as LIST fields (emitted by formatManifestV2 separately, after
// the References block) plus the shared file-set scalar fields.
const MANIFEST_V2_CODE_FILESET_FIELDS = Object.freeze([
  ['fileSetFingerprint', 'File set fingerprint'],
  ['roundLimit', 'Round limit'],
  ['lastModifiedAt', 'Last modified at']
]);

// CODE list fields: ordered (key, label) for the scope/exclusion list blocks.
// These are emitted as `Label:` followed by `- item` lines, like References.
const MANIFEST_V2_CODE_LIST_FIELDS = Object.freeze([
  ['normalizedScopes', 'Normalized scopes'],
  ['exclusions', 'Exclusions']
]);

// `targetContextKind` is an OPTIONAL discriminator: absent ⇒ 'document'. It is
// emitted only for non-document kinds, so existing document manifests stay
// byte-identical. The line, when present, sorts right after the schema line.
const TARGET_CONTEXT_KIND_LABEL = 'Target context kind';

// Label → key lookup spanning both identity blocks. 'Last modified at' appears
// in both the document and file-set blocks; the collision is benign because both
// map to the same key (`lastModifiedAt`). Keep that invariant: any label shared
// across blocks must map to one key.
const MANIFEST_V2_LABELS = new Map(
  [
    ...MANIFEST_V2_COMMON_HEAD_FIELDS,
    ...MANIFEST_V2_DOCUMENT_FIELDS,
    ...MANIFEST_V2_PR_FILESET_FIELDS,
    ...MANIFEST_V2_CODE_FILESET_FIELDS,
    ['targetContextKind', TARGET_CONTEXT_KIND_LABEL]
  ].map(([key, label]) => [label, key])
);

// Label → key map for CODE list-field blocks (kept out of the scalar label map
// because list blocks are parsed as multi-line `- item` sections, not scalars).
const MANIFEST_V2_CODE_LIST_LABELS = new Map(
  MANIFEST_V2_CODE_LIST_FIELDS.map(([key, label]) => [label, key])
);

function manifestV2FieldsForKind(kind) {
  if (kind === 'document') return [...MANIFEST_V2_COMMON_HEAD_FIELDS, ...MANIFEST_V2_DOCUMENT_FIELDS];
  if (kind === 'code') return [...MANIFEST_V2_COMMON_HEAD_FIELDS, ...MANIFEST_V2_CODE_FILESET_FIELDS];
  return [...MANIFEST_V2_COMMON_HEAD_FIELDS, ...MANIFEST_V2_PR_FILESET_FIELDS];
}

function requiredManifestV2Keys(kind) {
  return [...manifestV2FieldsForKind(kind).map(([key]) => key), 'createdAt', 'updatedAt'];
}
const HASH64_PATTERN = /^[a-f0-9]{64}$/;
const HASH40_PATTERN = /^[a-f0-9]{40}$/;
const PROOF_PATTERN = /^capability-descriptor:(codex|claude|gemini):[A-Za-z0-9._-]+$/;

function failState(message) {
  const error = new Error(`state-validation-failed: ${message}`);
  error.code = 'ERR_STATE_VALIDATION_FAILED';
  throw error;
}

function normalizeText(value, label) {
  if (value === undefined || value === null) failState(`missing field ${label}`);
  const text = redactSensitive(String(value)).trim();
  if (text === '') failState(`missing field ${label}`);
  return text;
}

function normalizeOptionalPath(value, label) {
  const text = normalizeText(value, label);
  return text === 'none' ? 'none' : text;
}

function normalizeInteger(value, label) {
  const text = normalizeText(value, label);
  if (!/^[0-9]+$/.test(text)) failState(`${label} must be an integer`);
  return Number(text);
}

function requireOneOf(value, allowed, label) {
  if (!allowed.includes(value)) failState(`unknown enum for ${label}: ${value}`);
  return value;
}

function requireHashOrNone(value, label, allowNone) {
  if (value === 'none' && allowNone) return value;
  if (!HASH64_PATTERN.test(value)) failState(`${label} must be a sha256 hex value`);
  return value;
}

// Git commit identity is a 40-hex object name, or 'none' when genuinely
// unresolved (e.g. a base ref that could not be pinned to a local commit).
function requireHashOrNone40(value, label) {
  if (value === 'none') return value;
  if (!HASH40_PATTERN.test(value)) failState(`${label} must be a 40-hex git object name or none`);
  return value;
}

// roundLimit is an optional shared field: 'none' (unset) or a positive integer.
function normalizeRoundLimit(value, label) {
  if (value === 'none') return value;
  if (!/^[1-9][0-9]*$/.test(value)) failState(`${label} must be a positive integer or none`);
  return value;
}

// Normalize a CODE list field (scopes / exclusions): each entry is a
// root-relative posix path. Absolute paths and `..`-escaping entries are
// rejected. The list is sorted for byte-stable output; duplicates within an
// already-validated array collapse (textual duplicate `- item` lines are
// rejected earlier at parse time via the `seen` set).
function normalizeManifestPathList(value, label) {
  const entries = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const text = normalizeText(entry, label);
    if (text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text)) {
      failState(`${label} entry must be a relative path: ${text}`);
    }
    const segments = text.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      failState(`${label} entry must be a normalized relative path: ${text}`);
    }
    if (!seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result.sort();
}

function validateAssuranceProof(manifest) {
  if (manifest.assurance === 'strict-verified') {
    if (manifest.descriptorPlatform === 'none') {
      failState('strict-verified assurance requires Descriptor platform: codex, claude, or gemini');
    }
    if (!PROOF_PATTERN.test(manifest.assuranceProof)) {
      failState('strict-verified assurance requires matching Assurance proof');
    }
    const [, descriptorPlatform] = manifest.assuranceProof.match(PROOF_PATTERN);
    if (manifest.descriptorPlatform !== descriptorPlatform) {
      failState('Assurance proof descriptor platform must match Descriptor platform');
    }
    return;
  }

  if (manifest.descriptorPlatform !== 'none') {
    failState(`${manifest.assurance} assurance requires Descriptor platform: none`);
  }
  if (manifest.assuranceProof !== 'none') {
    failState(`${manifest.assurance} assurance requires Assurance proof: none`);
  }
}

function validateModeAssurancePairing(manifest) {
  if (manifest.status === 'pass') {
    if (manifest.mode !== 'review-and-fix') failState('pass status requires Mode: review-and-fix');
    if (!['practical', 'strict-verified'].includes(manifest.assurance)) {
      failState('pass status requires Assurance: practical or strict-verified');
    }
  }
  if (manifest.assurance === 'advisory' && manifest.mode === 'review-and-fix') {
    failState('advisory assurance must not persist Mode: review-and-fix');
  }
}

function validateStatusReasonPairing(manifest) {
  if (manifest.status === 'blocked') {
    if (manifest.blockingReason === 'none') failState('blocked status requires non-none Blocking reason');
    if (manifest.statusReason !== 'none') failState('blocked status requires Status reason: none');
    return;
  }
  if (manifest.blockingReason !== 'none') failState('non-blocked status requires Blocking reason: none');
}

function validateStatusPhasePairing(manifest) {
  const activePhase = ACTIVE_STATUS_PHASES[manifest.status];
  if (activePhase && manifest.currentPhase !== activePhase) {
    failState(`active status ${manifest.status} requires Current phase: ${activePhase}`);
  }
  if (manifest.status === 'pass' && manifest.currentPhase !== 'final') {
    failState('pass status requires Current phase: final');
  }
}

function resolveTargetContextKind(manifest) {
  // OPTIONAL discriminator: absent ⇒ 'document'. This default is what keeps
  // every existing document manifest parsing and formatting byte-identically.
  if (!Object.hasOwn(manifest, 'targetContextKind') || manifest.targetContextKind === undefined) {
    return 'document';
  }
  const value = normalizeText(manifest.targetContextKind, TARGET_CONTEXT_KIND_LABEL);
  return requireOneOf(value, TARGET_CONTEXT_KINDS, TARGET_CONTEXT_KIND_LABEL);
}

function normalizeManifestV2(manifest) {
  const targetContextKind = resolveTargetContextKind(manifest);
  const fields = manifestV2FieldsForKind(targetContextKind);
  const normalized = { targetContextKind };
  for (const [key, label] of fields) {
    if (key === 'guardMode' && !Object.hasOwn(manifest, key)) {
      normalized[key] = 'git';
    } else if (key === 'fixAttemptCount' && !Object.hasOwn(manifest, key)) {
      normalized[key] = '0';
    } else if (key === 'roundLimit' && !Object.hasOwn(manifest, key)) {
      normalized[key] = 'none';
    } else {
      normalized[key] = normalizeText(manifest[key], label);
    }
  }
  normalized.manifestSchema = normalizeInteger(normalized.manifestSchema, 'Manifest schema');
  if (normalized.manifestSchema !== 2) failState(`Manifest schema must be 2, got ${normalized.manifestSchema}`);
  if (targetContextKind === 'document') {
    normalized.documentType = requireOneOf(normalized.documentType, DOCUMENT_TYPES, 'Document type');
  } else {
    // documentType is not applicable to file-set kinds; it is pinned to 'none'.
    if (normalized.documentType !== 'none') {
      failState(`${targetContextKind} target context requires Document type: none`);
    }
  }
  normalized.strictness = requireOneOf(normalized.strictness, STRICTNESS_VALUES, 'Strictness');
  normalized.mode = requireOneOf(normalized.mode, MODE_VALUES, 'Mode');
  normalized.guardMode = requireOneOf(normalized.guardMode, GUARD_MODE_VALUES, 'Guard mode');
  normalized.status = requireOneOf(normalized.status, STATUS_VALUES, 'Status');
  normalized.currentPhase = requireOneOf(normalized.currentPhase, PHASE_VALUES, 'Current phase');
  normalized.currentRound = normalizeInteger(normalized.currentRound, 'Current round');
  if (normalized.currentRound < 1) failState('Current round must be a positive integer');
  normalized.fixAttemptCount = normalizeInteger(normalized.fixAttemptCount, 'Fix attempt count');
  if (normalized.fixAttemptCount < 0) failState('Fix attempt count must be zero or a positive integer');
  normalized.assurance = requireOneOf(normalized.assurance, ASSURANCE_VALUES, 'Assurance');
  normalized.runtimePlatform = requireOneOf(normalized.runtimePlatform, RUNTIME_PLATFORMS, 'Runtime platform');
  normalized.descriptorPlatform = requireOneOf(normalized.descriptorPlatform, DESCRIPTOR_PLATFORMS, 'Descriptor platform');
  normalized.runtimeSubagentProbe = requireOneOf(normalized.runtimeSubagentProbe, SUBAGENT_PROBES, 'Runtime subagent probe');
  normalized.runtimeSubagentProbeEvidence = requireOneOf(
    normalized.runtimeSubagentProbeEvidence,
    SUBAGENT_PROBE_EVIDENCE,
    'Runtime subagent probe evidence'
  );
  normalized.runtimeFingerprintGuard = requireOneOf(
    normalized.runtimeFingerprintGuard,
    FINGERPRINT_GUARDS,
    'Runtime fingerprint guard'
  );
  normalized.runtimeStdinHandoff = requireOneOf(normalized.runtimeStdinHandoff, STDIN_HANDOFFS, 'Runtime stdin handoff');
  normalized.runtimeStdinHandoffEvidence = requireOneOf(
    normalized.runtimeStdinHandoffEvidence,
    STDIN_HANDOFF_EVIDENCE,
    'Runtime stdin handoff evidence'
  );
  normalized.runtimeDowngradeReason = requireOneOf(
    normalized.runtimeDowngradeReason,
    DOWNGRADE_REASONS,
    'Runtime downgrade reason'
  );
  normalized.blockingReason = requireOneOf(normalized.blockingReason, BLOCKING_REASONS, 'Blocking reason');
  normalized.statusReason = requireOneOf(normalized.statusReason, STATUS_REASONS, 'Status reason');
  normalized.currentReportPath = normalizeOptionalPath(normalized.currentReportPath, 'Current report path');
  normalized.lastReviewerReportPath = normalizeOptionalPath(normalized.lastReviewerReportPath, 'Last reviewer report path');
  normalized.lastTriageReportPath = normalizeOptionalPath(normalized.lastTriageReportPath, 'Last triage report path');
  normalized.lastFixReportPath = normalizeOptionalPath(normalized.lastFixReportPath, 'Last fix report path');
  normalized.lastDiffReviewReportPath = normalizeOptionalPath(
    normalized.lastDiffReviewReportPath,
    'Last diff review report path'
  );
  if (targetContextKind === 'document') {
    normalized.initialContentSha256 = requireHashOrNone(normalized.initialContentSha256, 'Initial content sha256', false);
    normalized.lastKnownContentSha256 = requireHashOrNone(normalized.lastKnownContentSha256, 'Last known content sha256', false);
    normalized.lastReviewedContentSha256 = requireHashOrNone(
      normalized.lastReviewedContentSha256,
      'Last reviewed content sha256',
      true
    );
    normalized.lastPassedContentSha256 = requireHashOrNone(
      normalized.lastPassedContentSha256,
      'Last passed content sha256',
      true
    );
    normalized.fileSize = normalizeInteger(normalized.fileSize, 'File size');
  } else if (targetContextKind === 'code') {
    // CODE file-set identity: normalized scopes + exclusions (LIST fields,
    // root-relative posix paths) plus a deterministic file-set fingerprint.
    // CODE has NO base/merge-base/head. roundLimit is an integer string or 'none'.
    normalized.fileSetFingerprint = requireHashOrNone(normalized.fileSetFingerprint, 'File set fingerprint', false);
    normalized.roundLimit = normalizeRoundLimit(normalized.roundLimit, 'Round limit');
    normalized.normalizedScopes = normalizeManifestPathList(manifest.normalizedScopes, 'Normalized scopes');
    normalized.exclusions = normalizeManifestPathList(manifest.exclusions, 'Exclusions');
  } else {
    // PR file-set identity: a base ref string, resolved base/merge-base/HEAD
    // commit shas (or 'none' where genuinely unresolved), and a deterministic
    // file-set fingerprint. roundLimit is an optional integer string or 'none'.
    normalized.base = normalizeText(normalized.base, 'Base');
    normalized.baseRevision = requireHashOrNone40(normalized.baseRevision, 'Base revision');
    normalized.mergeBase = requireHashOrNone40(normalized.mergeBase, 'Merge base');
    normalized.head = requireHashOrNone40(normalized.head, 'Head');
    normalized.fileSetFingerprint = requireHashOrNone(normalized.fileSetFingerprint, 'File set fingerprint', false);
    normalized.roundLimit = normalizeRoundLimit(normalized.roundLimit, 'Round limit');
  }
  normalized.references = Array.isArray(manifest.references)
    ? manifest.references.map((reference) => normalizeText(reference, 'References'))
    : [];
  normalized.createdAt = normalizeText(manifest.createdAt, 'Created at');
  normalized.updatedAt = normalizeText(manifest.updatedAt, 'Updated at');

  validateModeAssurancePairing(normalized);
  validateAssuranceProof(normalized);
  validateStatusReasonPairing(normalized);
  validateStatusPhasePairing(normalized);
  return normalized;
}

function formatManifestV2(manifest) {
  const normalized = normalizeManifestV2(manifest);
  const lines = ['# Review Target Manifest', ''];
  const fields = manifestV2FieldsForKind(normalized.targetContextKind);
  for (const [key, label] of fields) {
    lines.push(`${label}: ${normalized[key]}`);
    // Emit the discriminator only for non-document kinds, immediately after the
    // schema line, so existing document manifests remain byte-identical.
    if (key === 'manifestSchema' && normalized.targetContextKind !== 'document') {
      lines.push(`${TARGET_CONTEXT_KIND_LABEL}: ${normalized.targetContextKind}`);
    }
  }
  lines.push('References:');
  for (const reference of normalized.references) {
    lines.push(`- ${reference}`);
  }
  // CODE list blocks (scopes/exclusions) follow References, before timestamps.
  // Emitted only for the code kind so document/PR manifests stay byte-stable.
  if (normalized.targetContextKind === 'code') {
    for (const [key, label] of MANIFEST_V2_CODE_LIST_FIELDS) {
      lines.push(`${label}:`);
      for (const item of normalized[key]) {
        lines.push(`- ${item}`);
      }
    }
  }
  lines.push(`Created at: ${normalized.createdAt}`);
  lines.push(`Updated at: ${normalized.updatedAt}`);
  return `${lines.join('\n')}\n`;
}

function parseManifestV2(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '# Review Target Manifest') failState('Manifest must start with review target heading');

  const result = {};
  const seen = new Set();
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line === '') continue;
    if (line === 'References:') {
      if (seen.has('References')) failState('duplicate field References');
      seen.add('References');
      result.references = [];
      while (index < lines.length && lines[index].startsWith('- ')) {
        result.references.push(lines[index].slice(2));
        index += 1;
      }
      continue;
    }
    // CODE list blocks: a `Label:` line followed by `- item` lines. Duplicate
    // block labels and duplicate items within a block are both rejected.
    if (MANIFEST_V2_CODE_LIST_LABELS.has(line.slice(0, -1)) && line.endsWith(':')) {
      const label = line.slice(0, -1);
      const key = MANIFEST_V2_CODE_LIST_LABELS.get(label);
      if (seen.has(label)) failState(`duplicate field ${label}`);
      seen.add(label);
      const items = [];
      const itemSeen = new Set();
      while (index < lines.length && lines[index].startsWith('- ')) {
        const item = lines[index].slice(2);
        if (itemSeen.has(item)) failState(`duplicate ${label} entry: ${item}`);
        itemSeen.add(item);
        items.push(item);
        index += 1;
      }
      result[key] = items;
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) failState(`unknown v2 field label: ${line}`);
    const label = line.slice(0, separator);
    const value = line.slice(separator + 1).trimStart();
    let key = MANIFEST_V2_LABELS.get(label);
    if (!key && label === 'Created at') key = 'createdAt';
    if (!key && label === 'Updated at') key = 'updatedAt';
    if (!key) failState(`unknown v2 field label: ${label}`);
    if (seen.has(label)) failState(`duplicate field ${label}`);
    seen.add(label);
    result[key] = value;
  }
  if (!result.references) result.references = [];
  if (!Object.hasOwn(result, 'guardMode')) result.guardMode = 'git';
  if (!Object.hasOwn(result, 'fixAttemptCount')) result.fixAttemptCount = 0;
  // targetContextKind is optional: absent ⇒ 'document'. Resolve it before the
  // required-key check so the file-set branch validates against its own keys.
  const targetContextKind = Object.hasOwn(result, 'targetContextKind')
    ? requireOneOf(result.targetContextKind, TARGET_CONTEXT_KINDS, TARGET_CONTEXT_KIND_LABEL)
    : 'document';
  if (targetContextKind !== 'document' && !Object.hasOwn(result, 'roundLimit')) result.roundLimit = 'none';
  if (targetContextKind === 'code') {
    // CODE list blocks default to empty when their label is absent.
    for (const [key] of MANIFEST_V2_CODE_LIST_FIELDS) {
      if (!Object.hasOwn(result, key)) result[key] = [];
    }
  }
  for (const key of requiredManifestV2Keys(targetContextKind)) {
    if (!Object.hasOwn(result, key)) failState(`missing field ${key}`);
  }
  return normalizeManifestV2(result);
}

function normalizeWriteContent(content) {
  return redactSensitive(String(content)).replace(/\r\n/g, '\n');
}

function atomicWriteFile(filePath, content, options = {}) {
  const targetPath = path.resolve(filePath);
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  const tempPath = path.join(
    directory,
    `.${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(tempPath, normalizeWriteContent(content), { encoding: 'utf8', flag: 'wx' });
    if (options.failBeforeRename) failState('forced atomic write failure before rename');
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup; the reported failure remains the original write failure.
    }
    throw error;
  }
}

function workflowJson(result = {}) {
  return {
    ok: Boolean(result.ok),
    status: result.status || 'validation-error',
    errorCode: result.errorCode || null,
    message: result.message || null,
    targetStateDir: result.targetStateDir || null,
    targetKey: result.targetKey || null,
    manifestPath: result.manifestPath || null,
    ledgerPath: result.ledgerPath || null,
    round: result.round || null,
    documentType: result.documentType || 'none',
    strictness: result.strictness || 'none',
    requestedMode: result.requestedMode || null,
    mode: result.mode || null,
    guardMode: result.guardMode || 'git',
    modeSource: result.modeSource || null,
    modeNormalizedFrom: result.modeNormalizedFrom || null,
    requestedAssurance: result.requestedAssurance || null,
    assuranceSource: result.assuranceSource || null,
    assuranceNormalizedFrom: result.assuranceNormalizedFrom || null,
    assurance: result.assurance || null,
    runtimePlatform: result.runtimePlatform || null,
    descriptorPlatform: result.descriptorPlatform || 'none',
    assuranceProof: result.assuranceProof || 'none',
    strictProofError: result.strictProofError || null,
    runtimeCheck: result.runtimeCheck || null,
    contextManifestPath: result.contextManifestPath || null,
    contextPackSkeleton: result.contextPackSkeleton || null,
    reviewGuard: result.reviewGuard || null,
    stateToken: result.stateToken || null,
    nextAction: Object.hasOwn(result, 'nextAction') ? result.nextAction : 'none',
    blockingReason: result.blockingReason || 'none',
    statusReason: result.statusReason || 'none',
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

function issueCounts(ledger) {
  const counts = {};
  for (const issue of Array.isArray(ledger && ledger.issues) ? ledger.issues : []) {
    const key = `${issue.status || 'unknown'}:${issue.severity || 'unknown'}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.keys(counts).sort().map((key) => `${key}=${counts[key]}`).join(', ') || 'none';
}

function fixedIssueIds(ledger) {
  const ids = (Array.isArray(ledger && ledger.issues) ? ledger.issues : [])
    .filter((issue) => issue.status === 'fixed')
    .map((issue) => issue.id)
    .sort();
  return ids.length > 0 ? ids.join(', ') : 'none';
}

function formatSummary({ manifest, ledger = { issues: [] }, receipts = [], nextAction = 'none' } = {}) {
  const latestReports = [
    ['Current report path', manifest && manifest.currentReportPath],
    ['Last reviewer report path', manifest && manifest.lastReviewerReportPath],
    ['Last triage report path', manifest && manifest.lastTriageReportPath],
    ['Last fix report path', manifest && manifest.lastFixReportPath],
    ['Last diff review report path', manifest && manifest.lastDiffReviewReportPath]
  ];
  const lines = [
    '# Workflow Summary',
    '',
    `Target key: ${manifest && manifest.targetKey ? manifest.targetKey : 'none'}`,
    `Status: ${manifest && manifest.status ? manifest.status : 'none'}`,
    `Current phase: ${manifest && manifest.currentPhase ? manifest.currentPhase : 'none'}`,
    `Round: ${manifest && manifest.currentRound ? manifest.currentRound : 'none'}`,
    `Assurance: ${manifest && manifest.assurance ? manifest.assurance : 'none'}`,
    `Mode: ${manifest && manifest.mode ? manifest.mode : 'none'}`,
    `Guard mode: ${manifest && manifest.guardMode ? manifest.guardMode : 'git'}`,
    `Issue counts: ${issueCounts(ledger)}`,
    `Fixed issue IDs: ${fixedIssueIds(ledger)}`,
    `Blocking reason: ${manifest && manifest.blockingReason ? manifest.blockingReason : 'none'}`,
    `Status reason: ${manifest && manifest.statusReason ? manifest.statusReason : 'none'}`,
    `Next action: ${nextAction || 'none'}`,
    '',
    '## Latest Reports'
  ];
  for (const [label, value] of latestReports) {
    lines.push(`- ${label}: ${value || 'none'}`);
  }
  lines.push('', '## Receipts');
  if (Array.isArray(receipts) && receipts.length > 0) {
    for (const receipt of receipts.slice().sort()) lines.push(`- ${receipt}`);
  } else {
    lines.push('- none');
  }
  lines.push('');
  return `${lines.join('\n')}`;
}

function writeReceiptOrBlock({ writeReceipt, result = {} } = {}) {
  try {
    const receiptPath = writeReceipt();
    return {
      ...workflowJson(result),
      receiptPath: receiptPath || result.receiptPath || null
    };
  } catch (error) {
    return {
      ...workflowJson({
        ...result,
        ok: false,
        status: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'none',
        nextAction: 'inspect receipt write failure'
      }),
      receiptError: redactSensitive(error && error.message ? error.message : String(error))
    };
  }
}

module.exports = {
  STATUS_VALUES,
  BLOCKING_REASONS,
  STATUS_REASONS,
  formatManifestV2,
  parseManifestV2,
  atomicWriteFile,
  formatSummary,
  workflowJson,
  writeReceiptOrBlock
};
