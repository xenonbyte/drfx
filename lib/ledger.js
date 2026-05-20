'use strict';

const { redactSensitive } = require('./redaction');

const ALLOWED_ISSUE_STATUSES = Object.freeze(['accepted', 'fixed', 'merged', 'rejected', 'deferred', 'reopened']);
const TABLE_HEADER = '| ID | Severity | Status | Location | Summary | Resolution |';
const TABLE_SEPARATOR = '| --- | --- | --- | --- | --- | --- |';
const ISSUE_ID_PATTERN = /^ISSUE-(\d{3,})$/;
const API_DERIVED_FRAGMENT_PATTERN = /(\b(?:secret|token|api[ _-]?key)\s+(?:prefix|suffix|hash|checksum):?\s+)[^\s|;,]+/gi;
const CREDENTIAL_DERIVED_FRAGMENT_PATTERN = /(\bcredential\s+(?:prefix|suffix|hash|checksum):?\s+)[^\s|;,]+/gi;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function redactCell(value) {
  if (value === null || value === undefined) return '';
  return redactSensitive(String(value))
    .replace(API_DERIVED_FRAGMENT_PATTERN, '$1[REDACTED:api-token]')
    .replace(CREDENTIAL_DERIVED_FRAGMENT_PATTERN, '$1[REDACTED:credential]');
}

function escapeCell(value) {
  return redactCell(value)
    .replace(/\\/g, '\\\\')
    .replace(/<br>/g, '\\<br>')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function unescapeCell(value) {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith('\\<br>', index)) {
      decoded += '<br>';
      index += '\\<br>'.length - 1;
      continue;
    }
    if (value.startsWith('<br>', index)) {
      decoded += '\n';
      index += '<br>'.length - 1;
      continue;
    }
    decoded += value[index];
  }
  return decoded
    .replace(/\\\|/g, '|')
    .replace(/\\\\/g, '\\')
    .trim();
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    fail('ERR_LEDGER_ROW', 'ledger table row must start and end with pipes');
  }

  const cells = [];
  let current = '';
  let escaped = false;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      current += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(unescapeCell(current));
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  cells.push(unescapeCell(current));
  return cells.map((cell) => cell.trim());
}

function assertIssueId(id) {
  if (!ISSUE_ID_PATTERN.test(String(id || ''))) {
    fail('ERR_LEDGER_ISSUE_ID', `invalid issue id: ${id}`);
  }
}

function assertStatus(status) {
  if (!ALLOWED_ISSUE_STATUSES.includes(status)) {
    fail('ERR_LEDGER_STATUS', `unknown status: ${status}`);
  }
}

function normalizeIssue(issue) {
  const normalized = {
    id: redactCell(issue.id),
    severity: redactCell(issue.severity),
    status: redactCell(issue.status),
    location: redactCell(issue.location),
    summary: redactCell(issue.summary),
    resolution: redactCell(issue.resolution)
  };
  assertIssueId(normalized.id);
  assertStatus(normalized.status);
  return normalized;
}

function normalizeLedger(ledger) {
  const issues = Array.isArray(ledger && ledger.issues) ? ledger.issues : [];
  return { issues: issues.map((issue) => normalizeIssue(issue)) };
}

function formatLedger(ledger) {
  const normalized = normalizeLedger(ledger);
  const lines = [TABLE_HEADER, TABLE_SEPARATOR];
  for (const issue of normalized.issues) {
    lines.push([
      '',
      escapeCell(issue.id),
      escapeCell(issue.severity),
      escapeCell(issue.status),
      escapeCell(issue.location),
      escapeCell(issue.summary),
      escapeCell(issue.resolution),
      ''
    ].join(' | '));
  }
  return `${lines.join('\n')}\n`;
}

function parseLedger(markdown) {
  const lines = String(markdown || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines[0] !== TABLE_HEADER) {
    fail('ERR_LEDGER_HEADER', `ledger table header must be exactly ${TABLE_HEADER}`);
  }
  if (lines[1] !== TABLE_SEPARATOR) {
    fail('ERR_LEDGER_SEPARATOR', 'ledger table separator is missing or invalid');
  }

  const issues = [];
  for (const line of lines.slice(2)) {
    const cells = splitTableRow(line);
    if (cells.length !== 6) {
      fail('ERR_LEDGER_ROW', 'ledger table rows must contain six cells');
    }
    issues.push(normalizeIssue({
      id: cells[0],
      severity: cells[1],
      status: cells[2],
      location: cells[3],
      summary: cells[4],
      resolution: cells[5]
    }));
  }
  return { issues };
}

function nextIssueId(issues) {
  let highest = 0;
  for (const issue of issues || []) {
    const match = ISSUE_ID_PATTERN.exec(String(issue && issue.id));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `ISSUE-${String(highest + 1).padStart(3, '0')}`;
}

function cloneLedger(ledger) {
  return normalizeLedger(ledger);
}

function requireText(value, label) {
  const text = redactCell(value).trim();
  if (!text) fail(`ERR_LEDGER_${label.toUpperCase()}`, `${label} is required`);
  return text;
}

function updateIssue(ledger, issueId, updater) {
  assertIssueId(issueId);
  let found = false;
  const next = cloneLedger(ledger);
  next.issues = next.issues.map((issue) => {
    if (issue.id !== issueId) return issue;
    found = true;
    return normalizeIssue({ ...issue, ...updater(issue) });
  });
  if (!found) fail('ERR_LEDGER_ISSUE_NOT_FOUND', `issue not found: ${issueId}`);
  return next;
}

function addAcceptedFinding(ledger, finding) {
  const next = cloneLedger(ledger);
  const summary = finding && (finding.issue || finding.summary || finding.finding || finding.title);
  const resolution = finding && (finding.suggested_fix || finding.suggestedFix || finding.resolution || finding.recommendation);
  next.issues.push(normalizeIssue({
    id: nextIssueId(next.issues),
    severity: finding && finding.severity ? finding.severity : 'medium',
    status: 'accepted',
    location: finding && finding.location ? finding.location : '',
    summary: summary || '',
    resolution: resolution || 'Pending fix'
  }));
  return next;
}

function mergeIssue(ledger, issueId, targetIssueId) {
  assertIssueId(targetIssueId);
  return updateIssue(ledger, issueId, () => ({
    status: 'merged',
    resolution: `Merged into ${targetIssueId}`
  }));
}

function rejectIssue(ledger, issueId, reason) {
  return updateIssue(ledger, issueId, () => ({
    status: 'rejected',
    resolution: `Rejected: ${requireText(reason, 'reason')}`
  }));
}

function deferIssue(ledger, issueId, metadata) {
  const reason = requireText(metadata && metadata.reason, 'reason');
  const owner = requireText(metadata && metadata.owner, 'owner');
  return updateIssue(ledger, issueId, () => ({
    status: 'deferred',
    resolution: `Deferred: ${reason}; owner: ${owner}`
  }));
}

function reopenIssue(ledger, issueId, reason) {
  return updateIssue(ledger, issueId, () => ({
    status: 'reopened',
    resolution: `Reopened: ${requireText(reason, 'reason')}`
  }));
}

module.exports = {
  ALLOWED_ISSUE_STATUSES,
  formatLedger,
  parseLedger,
  nextIssueId,
  addAcceptedFinding,
  mergeIssue,
  rejectIssue,
  deferIssue,
  reopenIssue
};
