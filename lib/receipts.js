'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redactSensitive } = require('./redaction');

const RECEIPT_STOP_REASONS = Object.freeze([
  'interruption',
  'context-pressure',
  'blocked',
  'unsupported',
  'externally-changed',
  'possible-target-replacement',
  'read-only-findings',
  'stopped-with-deferrals'
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
  const auditTrail = Boolean(options && options.auditTrail);
  const round = Number(options && options.round);
  const stopReason = options && options.stopReason;

  return auditTrail || round >= 2 || RECEIPT_STOP_REASONS.includes(stopReason);
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

function roundReceiptPath(options) {
  const projectRoot = options && options.projectRoot;
  const targetKey = assertPathSegment(options && options.targetKey, 'target key');
  const round = options && options.round;
  const kind = assertPathSegment(redactReceiptText(options && options.kind), 'kind');

  return path.join(
    projectRoot,
    '.docs-review-fix',
    'targets',
    targetKey,
    'rounds',
    `${paddedRound(round)}-${kind}.md`
  );
}

function titleCase(value) {
  const text = redactReceiptText(value || '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : '';
}

function formatIssueIds(issueIds) {
  if (!Array.isArray(issueIds) || issueIds.length === 0) return '(none)';
  return issueIds.map((issueId) => redactReceiptText(issueId)).join(', ');
}

function formatRoundReceipt(options) {
  const round = options && options.round;
  const kind = redactReceiptText(options && options.kind);
  const status = redactReceiptText(options && options.status);
  const target = redactReceiptText(options && options.target);
  const issueIds = formatIssueIds(options && options.issueIds);
  const summary = redactReceiptText(options && options.summary);
  const nextAction = redactReceiptText(options && options.nextAction);

  return [
    `# Round ${paddedRound(round)} ${titleCase(kind)} Receipt`,
    '',
    `- Round: ${redactReceiptText(round)}`,
    `- Kind: ${kind}`,
    `- Status: ${status}`,
    `- Target: ${target}`,
    `- Issue IDs: ${issueIds}`,
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
  const receiptPath = roundReceiptPath(options);
  const text = redactReceiptText(formatRoundReceipt(options));

  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, text, 'utf8');
  return receiptPath;
}

module.exports = {
  shouldWriteRoundReceipt,
  roundReceiptPath,
  formatRoundReceipt,
  writeRoundReceipt
};
