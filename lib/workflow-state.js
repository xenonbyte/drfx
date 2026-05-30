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

const MANIFEST_V2_FIELDS = Object.freeze([
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
  ['lastDiffReviewReportPath', 'Last diff review report path'],
  ['initialContentSha256', 'Initial content sha256'],
  ['lastKnownContentSha256', 'Last known content sha256'],
  ['lastReviewedContentSha256', 'Last reviewed content sha256'],
  ['lastPassedContentSha256', 'Last passed content sha256'],
  ['lastModifiedAt', 'Last modified at'],
  ['fileSize', 'File size']
]);
const MANIFEST_V2_LABELS = new Map(MANIFEST_V2_FIELDS.map(([key, label]) => [label, key]));
const REQUIRED_MANIFEST_V2_KEYS = Object.freeze([
  ...MANIFEST_V2_FIELDS.map(([key]) => key),
  'createdAt',
  'updatedAt'
]);
const HASH64_PATTERN = /^[a-f0-9]{64}$/;
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

function normalizeManifestV2(manifest) {
  const normalized = {};
  for (const [key, label] of MANIFEST_V2_FIELDS) {
    if (key === 'guardMode' && !Object.hasOwn(manifest, key)) {
      normalized[key] = 'git';
    } else if (key === 'fixAttemptCount' && !Object.hasOwn(manifest, key)) {
      normalized[key] = '0';
    } else {
      normalized[key] = normalizeText(manifest[key], label);
    }
  }
  normalized.manifestSchema = normalizeInteger(normalized.manifestSchema, 'Manifest schema');
  if (normalized.manifestSchema !== 2) failState(`Manifest schema must be 2, got ${normalized.manifestSchema}`);
  normalized.documentType = requireOneOf(normalized.documentType, DOCUMENT_TYPES, 'Document type');
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
  for (const [key, label] of MANIFEST_V2_FIELDS) {
    lines.push(`${label}: ${normalized[key]}`);
  }
  lines.push('References:');
  for (const reference of normalized.references) {
    lines.push(`- ${reference}`);
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
  for (const key of REQUIRED_MANIFEST_V2_KEYS) {
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
