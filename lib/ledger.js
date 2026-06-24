'use strict';

const { redactSensitive } = require('./redaction');

const ALLOWED_ISSUE_STATUSES = Object.freeze(['accepted', 'fixed', 'merged', 'rejected', 'deferred', 'reopened']);
const TRIAGE_DECISIONS = new Set(['accepted', 'reopened', 'merged', 'downgraded', 'rejected', 'deferred']);
const SEVERITIES = new Set(['high', 'medium', 'low']);
const TABLE_HEADER = '| ID | Severity | Status | Location | Summary | Resolution |';
const TABLE_SEPARATOR = '| --- | --- | --- | --- | --- | --- |';
const ISSUE_ID_PATTERN = /^ISSUE-(\d{3,})$/;
const API_DERIVED_FRAGMENT_PATTERN = /(\b(?:(?:api|auth|jwt|app|session|client)?[_-]?secret|secret[_-]?key|token|api[ _-]?key)\s+(?:prefix|suffix|hash|checksum):?\s+)[^\s|;,]+/gi;
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

function requireTriageText(value, label) {
  const text = requireText(value, label);
  if (text === 'none') fail(`ERR_LEDGER_${label.toUpperCase()}`, `${label} is required`);
  return text;
}

function assertSeverity(severity) {
  if (!SEVERITIES.has(String(severity || ''))) {
    fail('ERR_LEDGER_SEVERITY', `unknown severity: ${severity}`);
  }
}

function assertTriageDecision(decision) {
  if (!TRIAGE_DECISIONS.has(String(decision || ''))) {
    fail('ERR_LEDGER_TRIAGE_DECISION', `unknown triage decision: ${decision}`);
  }
}

function issueById(issues, issueId) {
  return issues.find((issue) => issue.id === issueId) || null;
}

function isNone(value) {
  return value === undefined || value === null || value === '' || value === 'none';
}

function ensureMergedIntoOnlyForMerged(decision) {
  if (decision.decision !== 'merged' && !isNone(decision.merged_into)) {
    fail('ERR_LEDGER_MERGED_INTO', 'merged_into is valid only for merged decisions');
  }
}

function assertNonBlockingAllowed(decision) {
  if (decision.non_blocking !== true) return;
  if (decision.severity !== 'low') {
    fail('ERR_LEDGER_NON_BLOCKING', 'non_blocking true is allowed only for low severity findings');
  }
  if (!['accepted', 'downgraded'].includes(decision.decision)) {
    fail('ERR_LEDGER_NON_BLOCKING', 'non_blocking true is valid only for accepted low findings');
  }
  requireTriageText(decision.rationale, 'rationale');
}

function allocateIssueId(issues, requestedIssueId = null) {
  const expected = nextIssueId(issues);
  if (requestedIssueId && requestedIssueId !== expected) {
    fail('ERR_LEDGER_ISSUE_SEQUENCE', `new issue id must be ${expected}, got ${requestedIssueId}`);
  }
  return expected;
}

function normalizeDecision(decision) {
  const normalized = {
    ...decision,
    reviewer_id: redactCell(decision && decision.reviewer_id),
    issue_id: decision && decision.issue_id ? redactCell(decision.issue_id) : null,
    decision: decision && decision.decision,
    severity: decision && decision.severity,
    original_severity: decision && decision.original_severity ? decision.original_severity : 'none',
    rationale: decision && Object.hasOwn(decision, 'rationale') ? redactCell(decision.rationale) : 'none',
    merged_into: decision && decision.merged_into ? redactCell(decision.merged_into) : 'none',
    deferred_owner: decision && decision.deferred_owner ? redactCell(decision.deferred_owner) : 'none',
    deferred_next_action: decision && decision.deferred_next_action ? redactCell(decision.deferred_next_action) : 'none',
    non_blocking: Boolean(decision && decision.non_blocking)
  };
  assertTriageDecision(normalized.decision);
  assertSeverity(normalized.severity);
  if (normalized.issue_id) assertIssueId(normalized.issue_id);
  if (!isNone(normalized.merged_into)) assertIssueId(normalized.merged_into);
  ensureMergedIntoOnlyForMerged(normalized);
  assertNonBlockingAllowed(normalized);
  return normalized;
}

function issueSummaryFromDecision(decision) {
  return decision.issue || decision.summary || decision.finding || decision.title || `Finding ${decision.reviewer_id}`;
}

function issueResolutionFromDecision(decision) {
  return decision.suggested_fix ||
    decision.suggestedFix ||
    decision.resolution ||
    decision.recommendation ||
    'Pending fix';
}

function nonBlockingResolution(baseResolution, decision) {
  if (decision.non_blocking !== true) return baseResolution;
  return `${baseResolution}; Accepted as non-blocking low: ${requireTriageText(decision.rationale, 'rationale')}`;
}

function addIssue(next, issue) {
  next.issues.push(normalizeIssue(issue));
}

function replaceIssue(next, issueId, updater) {
  let found = false;
  next.issues = next.issues.map((issue) => {
    if (issue.id !== issueId) return issue;
    found = true;
    return normalizeIssue({ ...issue, ...updater(issue) });
  });
  if (!found) fail('ERR_LEDGER_ISSUE_NOT_FOUND', `issue not found: ${issueId}`);
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

function applyAccepted(next, decision) {
  if (decision.issue_id && issueById(next.issues, decision.issue_id)) {
    fail('ERR_LEDGER_ISSUE_SEQUENCE', `accepted new finding must not reuse existing issue id: ${decision.issue_id}`);
  }
  const issueId = allocateIssueId(next.issues, decision.issue_id);
  addIssue(next, {
    id: issueId,
    severity: decision.severity,
    status: 'accepted',
    location: decision.location || '',
    summary: issueSummaryFromDecision(decision),
    resolution: nonBlockingResolution(issueResolutionFromDecision(decision), decision)
  });
  if (decision.non_blocking === true) next.acceptedNonBlockingLowIssueIds.push(issueId);
}

function applyReopened(next, decision) {
  if (!decision.issue_id) fail('ERR_LEDGER_ISSUE_ID', 'reopened requires issue_id');
  if (!issueById(next.issues, decision.issue_id)) {
    fail('ERR_LEDGER_ISSUE_NOT_FOUND', `issue not found: ${decision.issue_id}`);
  }
  replaceIssue(next, decision.issue_id, () => ({
    severity: decision.severity,
    status: 'reopened',
    resolution: `Reopened: ${requireTriageText(decision.rationale, 'rationale')}`
  }));
}

function applyMerged(next, decision) {
  if (!decision.issue_id) fail('ERR_LEDGER_ISSUE_ID', 'merged requires issue_id');
  if (isNone(decision.merged_into)) fail('ERR_LEDGER_MERGED_INTO', 'merged decision requires merged_into');
  if (decision.issue_id === decision.merged_into) {
    fail('ERR_LEDGER_MERGED_INTO', 'merged_into must point to a different issue');
  }
  const survivor = issueById(next.issues, decision.merged_into);
  if (!survivor) fail('ERR_LEDGER_ISSUE_NOT_FOUND', `merged_into issue not found: ${decision.merged_into}`);
  if (['rejected', 'deferred'].includes(survivor.status)) {
    fail('ERR_LEDGER_MERGED_INTO', 'merged_into must not point to a rejected or deferred issue');
  }

  const existing = issueById(next.issues, decision.issue_id);
  if (!existing) {
    const issueId = allocateIssueId(next.issues, decision.issue_id);
    addIssue(next, {
      id: issueId,
      severity: decision.severity,
      status: 'merged',
      location: decision.location || '',
      summary: issueSummaryFromDecision(decision),
      resolution: `Merged into ${decision.merged_into}: ${requireTriageText(decision.rationale, 'rationale')}`
    });
    return;
  }

  replaceIssue(next, decision.issue_id, () => ({
    severity: decision.severity,
    status: 'merged',
    resolution: `Merged into ${decision.merged_into}: ${requireTriageText(decision.rationale, 'rationale')}`
  }));
}

function applyDowngraded(next, decision) {
  const originalSeverity = decision.original_severity && decision.original_severity !== 'none'
    ? decision.original_severity
    : 'unknown';
  const resolution = nonBlockingResolution(
    `Downgraded from ${originalSeverity}: ${requireTriageText(decision.rationale, 'rationale')}`,
    decision
  );
  if (decision.issue_id && issueById(next.issues, decision.issue_id)) {
    replaceIssue(next, decision.issue_id, () => ({
      severity: decision.severity,
      status: 'accepted',
      resolution
    }));
    if (decision.non_blocking === true) next.acceptedNonBlockingLowIssueIds.push(decision.issue_id);
    return;
  }
  const issueId = allocateIssueId(next.issues, decision.issue_id);
  addIssue(next, {
    id: issueId,
    severity: decision.severity,
    status: 'accepted',
    location: decision.location || '',
    summary: issueSummaryFromDecision(decision),
    resolution
  });
  if (decision.non_blocking === true) next.acceptedNonBlockingLowIssueIds.push(issueId);
}

function applyRejected(next, decision) {
  const resolution = `Rejected: ${requireTriageText(decision.rationale, 'rationale')}`;
  if (decision.issue_id && issueById(next.issues, decision.issue_id)) {
    replaceIssue(next, decision.issue_id, () => ({
      severity: decision.severity,
      status: 'rejected',
      resolution
    }));
    return;
  }
  const issueId = allocateIssueId(next.issues, decision.issue_id);
  addIssue(next, {
    id: issueId,
    severity: decision.severity,
    status: 'rejected',
    location: decision.location || '',
    summary: issueSummaryFromDecision(decision),
    resolution
  });
}

function applyDeferred(next, decision) {
  const reason = requireTriageText(decision.rationale, 'rationale');
  const owner = requireTriageText(decision.deferred_owner, 'deferred_owner');
  const nextAction = requireTriageText(decision.deferred_next_action, 'deferred_next_action');
  const resolution = `Deferred: ${reason}; owner: ${owner}; next action: ${nextAction}`;
  if (decision.issue_id && issueById(next.issues, decision.issue_id)) {
    replaceIssue(next, decision.issue_id, () => ({
      severity: decision.severity,
      status: 'deferred',
      resolution
    }));
    return;
  }
  const issueId = allocateIssueId(next.issues, decision.issue_id);
  addIssue(next, {
    id: issueId,
    severity: decision.severity,
    status: 'deferred',
    location: decision.location || '',
    summary: issueSummaryFromDecision(decision),
    resolution
  });
}

function applyTriageDecisions(ledger, decisions) {
  if (!Array.isArray(decisions)) fail('ERR_LEDGER_TRIAGE_DECISIONS', 'triage decisions must be an array');
  const next = cloneLedger(ledger);
  next.acceptedNonBlockingLowIssueIds = [];
  const seenDecisionIssueIds = new Set();

  for (const rawDecision of decisions) {
    const decision = normalizeDecision(rawDecision);
    if (decision.issue_id) {
      if (seenDecisionIssueIds.has(decision.issue_id)) {
        fail('ERR_LEDGER_DUPLICATE_TRIAGE_ISSUE', `duplicate triage issue id: ${decision.issue_id}`);
      }
      seenDecisionIssueIds.add(decision.issue_id);
    }
    if (decision.decision === 'accepted') applyAccepted(next, decision);
    else if (decision.decision === 'reopened') applyReopened(next, decision);
    else if (decision.decision === 'merged') applyMerged(next, decision);
    else if (decision.decision === 'downgraded') applyDowngraded(next, decision);
    else if (decision.decision === 'rejected') applyRejected(next, decision);
    else if (decision.decision === 'deferred') applyDeferred(next, decision);
  }

  next.acceptedNonBlockingLowIssueIds = [...new Set(next.acceptedNonBlockingLowIssueIds)].sort();
  return next;
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
  reopenIssue,
  applyTriageDecisions
};
