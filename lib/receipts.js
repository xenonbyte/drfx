'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redactSensitive } = require('./redaction');
const { validateTargetStateOwnedPath } = require('./target-state');

const RECEIPT_STOP_REASONS = Object.freeze([
  'interruption',
  'context-pressure',
  'blocked',
  'unsupported',
  'externally-changed',
  'possible-target-replacement',
  'read-only-findings',
  'stopped-with-deferrals',
  'stopped-no-progress',
  'checkpoint'
]);
const API_DERIVED_FRAGMENT_PATTERN = /(\b(?:secret|token|api[ _-]?key)\s+(?:prefix|suffix|hash|checksum):?\s+)[^\s|;,]+/gi;
const CREDENTIAL_DERIVED_FRAGMENT_PATTERN = /(\bcredential\s+(?:prefix|suffix|hash|checksum):?\s+)[^\s|;,]+/gi;

function redactReceiptText(value) {
  if (value === null || value === undefined) return value;
  return redactSensitive(value)
    .replace(API_DERIVED_FRAGMENT_PATTERN, '$1[REDACTED:api-token]')
    .replace(CREDENTIAL_DERIVED_FRAGMENT_PATTERN, '$1[REDACTED:credential]');
}

function shouldWriteRoundReceipt(options) {
  const auditTrail = Boolean(options && options.auditTrail) || hasOriginalLedgerToken(options);
  const round = Number(options && options.round);
  const stopReason = options && options.stopReason;

  return auditTrail || round >= 2 || RECEIPT_STOP_REASONS.includes(stopReason);
}

function hasOriginalLedgerToken(options) {
  if (!options) return false;
  if (typeof options.originalLedgerToken === 'string') return options.originalLedgerToken.startsWith('ledger=');
  if (Array.isArray(options.originalTokens)) {
    return options.originalTokens.some((token) => typeof token === 'string' && token.startsWith('ledger='));
  }
  return false;
}

function paddedRound(round) {
  return String(Number(round)).padStart(3, '0');
}

function assertPathSegment(value, label) {
  const text = String(value || '');
  if (!text || text === '.' || text === '..' || /[\\/]/.test(text)) {
    throw new Error(`invalid ${label}: must be a single path segment`);
  }
  return text;
}

function receiptTargetStateDir(options) {
  const projectRoot = options && options.projectRoot;
  const targetKey = assertPathSegment(options && options.targetKey, 'target key');
  return path.join(projectRoot, '.docs-review-fix', 'targets', targetKey);
}

function receiptFileName(options) {
  const round = options && options.round;
  const kind = assertPathSegment(redactReceiptText(options && options.kind), 'kind');
  return `${paddedRound(round)}-${kind}.md`;
}

function roundReceiptPath(options) {
  return path.join(
    receiptTargetStateDir(options),
    'rounds',
    receiptFileName(options)
  );
}

function attemptReceiptPath(basePath, attempt) {
  const extension = path.extname(basePath);
  const withoutExtension = basePath.slice(0, basePath.length - extension.length);
  return `${withoutExtension}-attempt-${String(attempt).padStart(3, '0')}${extension}`;
}

function validateReceiptPath(options, receiptPath) {
  const targetStateDir = receiptTargetStateDir(options);
  const relativePath = path.relative(targetStateDir, receiptPath).split(path.sep).join('/');
  return validateTargetStateOwnedPath({
    targetStateDir,
    relativePath,
    allowedDirectories: ['rounds'],
    label: 'Round receipt path'
  });
}

function titleCase(value) {
  const text = redactReceiptText(value || '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : '';
}

function formatIssueIds(issueIds) {
  if (!Array.isArray(issueIds) || issueIds.length === 0) return 'none';
  return issueIds.map((issueId) => redactReceiptText(issueId)).join(', ');
}

function receiptValue(value) {
  const text = redactReceiptText(value);
  if (text === null || text === undefined || String(text).trim() === '') return 'none';
  return String(text);
}

function formatRoundReceipt(options) {
  const round = options && options.round;
  const kind = redactReceiptText(options && options.kind);
  const status = receiptValue(options && options.status);
  const target = receiptValue(options && options.target);
  const issueIds = formatIssueIds(options && options.issueIds);
  const filesChanged = receiptValue(options && options.filesChanged);
  const verification = receiptValue(options && options.verification);
  const blockingReason = receiptValue(options && options.blockingReason);
  const statusReason = receiptValue(options && options.statusReason);
  const summary = receiptValue(options && options.summary);
  const nextAction = receiptValue(options && options.nextAction);

  return [
    `# Round ${paddedRound(round)} ${titleCase(kind)} Receipt`,
    '',
    `- Round: ${redactReceiptText(round)}`,
    `- Kind: ${kind}`,
    `- Status: ${status}`,
    `- Target: ${target}`,
    `- Issue IDs: ${issueIds}`,
    `- Files changed: ${filesChanged}`,
    `- Verification: ${verification}`,
    `- Blocking reason: ${blockingReason}`,
    `- Status reason: ${statusReason}`,
    '',
    '## Summary',
    summary,
    '',
    '## Next Action',
    nextAction,
    ''
  ].join('\n');
}

function writeRoundReceipt(options) {
  const text = redactReceiptText(formatRoundReceipt(options));
  const basePath = roundReceiptPath(options);
  validateReceiptPath(options, basePath);
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const receiptPath = attempt === 0 ? basePath : attemptReceiptPath(basePath, attempt);
    const safeReceiptPath = validateReceiptPath(options, receiptPath);
    try {
      fs.writeFileSync(safeReceiptPath, text, { encoding: 'utf8', flag: 'wx' });
      return safeReceiptPath;
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('unable to allocate receipt attempt path');
}

module.exports = {
  shouldWriteRoundReceipt,
  roundReceiptPath,
  formatRoundReceipt,
  writeRoundReceipt
};
