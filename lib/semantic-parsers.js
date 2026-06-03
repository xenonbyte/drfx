'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { redactSensitiveWithMeta } = require('./redaction');

const SEVERITIES = new Set(['high', 'medium', 'low']);
const TRIAGE_DECISIONS = new Set(['accepted', 'reopened', 'merged', 'downgraded', 'rejected', 'deferred']);
const BOOLEAN_VALUES = new Set(['true', 'false']);
const FINAL_STATUSES = new Set([
  'pass',
  'read-only-clean',
  'read-only-findings',
  'stopped-with-deferrals',
  'stopped-no-progress',
  'blocked',
  'unsupported',
  'externally-changed',
  'possible-target-replacement',
  'checkpoint'
]);
const ASSURANCES = new Set(['practical', 'strict-verified', 'advisory']);
const RUNTIME_PLATFORMS = new Set(['codex', 'claude-code', 'gemini', 'manual']);
const MODES = new Set(['review-and-fix', 'read-only']);
const BLOCKING_REASONS = new Set([
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
const STATUS_REASONS = new Set([
  'none',
  'strict-proof-validation-failed',
  'target-fingerprint-mismatch',
  'manifest-fingerprint-mismatch',
  'stale-fingerprint-mismatch',
  'same-path-replacement-suspected',
  'read-only-blocking-findings',
  'deferred-findings',
  'round-limit',
  'no-progress-detected',
  'unsupported-runtime-capability',
  'advisory-review-and-fix-unsupported',
  'checkpoint-requested'
]);

const TRIAGE_FIELDS = Object.freeze([
  'reviewer_id',
  'issue_id',
  'decision',
  'severity',
  'original_severity',
  'rationale',
  'merged_into',
  'deferred_owner',
  'deferred_next_action',
  'non_blocking'
]);
const DIFF_FAIL_FIELDS = Object.freeze(['issue_id', 'problem', 'required_action']);
const FINAL_FIELDS = Object.freeze([
  ['finalStatus', 'Final status'],
  ['assurance', 'Assurance'],
  ['runtimePlatform', 'Runtime platform'],
  ['mode', 'Mode'],
  ['target', 'Target'],
  ['filesChanged', 'Files changed'],
  ['fixedIssueIds', 'Fixed issue IDs'],
  ['verificationPerformed', 'Verification performed'],
  ['deferralsOrBlockers', 'Deferrals or blockers'],
  ['blockingReason', 'Blocking reason'],
  ['statusReason', 'Status reason'],
  ['residualRisk', 'Residual risk'],
  ['redactionStatement', 'Redaction statement'],
  ['coordinatorAgreement', 'Coordinator agreement']
]);
const SECTION_HEADINGS = new Set(['Fixed:', 'Files changed:', 'Not fixed:', 'Residual risk:']);
// PLAN-TASK-009 (Phase C2): per-round verification is an OPTIONAL fix-report section used
// by the file-set fix lifecycle to record the verification command/inspection method + its
// result (or an honest "none could run" note). It is positioned between Not fixed and
// Residual risk. Document fix reports never request it, so their strict 4-section contract
// is byte-for-byte unchanged.
const VERIFICATION_SECTION = 'Verification:';

function fail(message, code = 'ERR_SEMANTIC_PAYLOAD_PARSE') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizePayload(text) {
  if (typeof text !== 'string') fail('semantic payload must be a string');
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '').split('\n');
}

function redactText(value) {
  const result = redactSensitiveWithMeta(value);
  if (typeof result.value === 'string' && result.value.trim() === '') fail('field value must not be empty');
  return result.value;
}

function splitFieldBody(body, lineNumber) {
  const separator = body.indexOf(': ');
  if (separator === -1) fail(`malformed field separator at line ${lineNumber}`);
  const name = body.slice(0, separator);
  const value = body.slice(separator + 2);
  if (name === '' || value === '') fail(`missing field value at line ${lineNumber}`);
  if (value.startsWith('```') || /^<[^>]+>/.test(value)) fail(`unsupported block value at line ${lineNumber}`);
  return { name, value };
}

function splitField(line, expectedIndent, lineNumber) {
  const prefix = expectedIndent === 0 ? '' : ' '.repeat(expectedIndent);
  if (!line.startsWith(prefix)) fail(`malformed indentation at line ${lineNumber}`);
  const body = line.slice(expectedIndent);
  if (expectedIndent !== 0 && body.startsWith('- ')) fail(`malformed nested list at line ${lineNumber}`);
  return splitFieldBody(body, lineNumber);
}

function parseBoolean(value, field) {
  if (!BOOLEAN_VALUES.has(value)) fail(`invalid ${field}: ${value}`);
  return value === 'true';
}

function requirePattern(value, pattern, label) {
  if (!pattern.test(value)) fail(`invalid ${label}: ${value}`);
  return value;
}

function requireOneOf(value, allowed, label) {
  if (!allowed.has(value)) fail(`invalid ${label}: ${value}`);
  return value;
}

function parseOrderedListItems(lines, startIndex, fields, options = {}) {
  const allowedFields = options.allowedFields || new Set(fields);
  const items = [];
  let index = startIndex;
  while (index < lines.length) {
    if (lines[index] === '') fail(`blank line inside list at line ${index + 1}`);
    if (!lines[index].startsWith('- ')) {
      if (lines[index].startsWith('  ')) {
        const field = splitField(lines[index], 2, index + 1);
        if (!allowedFields.has(field.name)) fail(`unknown field ${field.name}`);
      }
      fail(`expected list item at line ${index + 1}`);
    }
    const item = {};
    const first = splitFieldBody(lines[index].slice(2), index + 1);
    if (first.name !== fields[0]) fail(`field order error: expected ${fields[0]} at line ${index + 1}`);
    item[first.name] = first.value;
    index += 1;

    for (let fieldIndex = 1; fieldIndex < fields.length; fieldIndex += 1) {
      if (index >= lines.length) fail(`missing required field ${fields[fieldIndex]}`);
      if (lines[index].startsWith('- ')) fail(`missing required field ${fields[fieldIndex]}`);
      if (lines[index] === '') fail(`blank line inside list at line ${index + 1}`);
      const field = splitField(lines[index], 2, index + 1);
      if (field.name !== fields[fieldIndex]) {
        if (!allowedFields.has(field.name)) fail(`unknown field ${field.name}`);
        fail(`field order error: expected ${fields[fieldIndex]} at line ${index + 1}`);
      }
      if (Object.hasOwn(item, field.name)) fail(`duplicate field ${field.name}`);
      item[field.name] = field.value;
      index += 1;
    }

    items.push(item);
  }
  return items;
}

function parseTriageResult(text) {
  const lines = normalizePayload(text);
  if (lines[0] !== 'Triage:') fail('expected Triage section');
  if (lines.length === 1) fail('Triage requires at least one item');
  const rawDecisions = parseOrderedListItems(lines, 1, TRIAGE_FIELDS);
  const decisions = rawDecisions.map((decision) => {
    const normalized = {
      reviewer_id: requirePattern(decision.reviewer_id, /^R\d{3,}$/, 'reviewer_id'),
      issue_id: requirePattern(decision.issue_id, /^ISSUE-\d{3,}$/, 'issue_id'),
      decision: requireOneOf(decision.decision, TRIAGE_DECISIONS, 'decision'),
      severity: requireOneOf(decision.severity, SEVERITIES, 'severity'),
      original_severity: decision.original_severity === 'none'
        ? 'none'
        : requireOneOf(decision.original_severity, SEVERITIES, 'original_severity'),
      rationale: redactText(decision.rationale),
      merged_into: decision.merged_into === 'none'
        ? 'none'
        : requirePattern(decision.merged_into, /^ISSUE-\d{3,}$/, 'merged_into'),
      deferred_owner: redactText(decision.deferred_owner),
      deferred_next_action: redactText(decision.deferred_next_action),
      non_blocking: parseBoolean(decision.non_blocking, 'non_blocking')
    };
    if (
      normalized.rationale === 'none' &&
      !(normalized.decision === 'accepted' && normalized.non_blocking === false)
    ) {
      fail('rationale is required for this triage decision');
    }
    return normalized;
  });
  return { decisions, warnings: [] };
}

function collectSections(lines, { allowVerification = false } = {}) {
  const sections = new Map();
  let current = null;
  // When verification is allowed (file-set fix path) it sits between Not fixed and Residual
  // risk; it is OPTIONAL, so the order matcher skips it if absent.
  const expectedOrder = allowVerification
    ? ['Fixed:', 'Files changed:', 'Not fixed:', VERIFICATION_SECTION, 'Residual risk:']
    : ['Fixed:', 'Files changed:', 'Not fixed:', 'Residual risk:'];
  const knownHeadings = allowVerification
    ? new Set([...SECTION_HEADINGS, VERIFICATION_SECTION])
    : SECTION_HEADINGS;
  let nextSectionIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '') {
      current = null;
      continue;
    }
    if (line.endsWith(':') && !line.startsWith('- ') && !line.startsWith(' ')) {
      if (!knownHeadings.has(line)) fail(`unknown section ${line.slice(0, -1)}`);
      if (sections.has(line)) fail(`duplicate section ${line.slice(0, -1)}`);
      // Advance past any optional sections that were skipped (e.g. Verification when absent).
      while (nextSectionIndex < expectedOrder.length && line !== expectedOrder[nextSectionIndex]) {
        if (expectedOrder[nextSectionIndex] !== VERIFICATION_SECTION) {
          fail(`section order error: expected ${expectedOrder[nextSectionIndex].slice(0, -1)}`);
        }
        nextSectionIndex += 1;
      }
      if (line !== expectedOrder[nextSectionIndex]) {
        const expected = expectedOrder[Math.min(nextSectionIndex, expectedOrder.length - 1)];
        fail(`section order error: expected ${expected.slice(0, -1)}`);
      }
      nextSectionIndex += 1;
      current = line;
      sections.set(current, []);
      continue;
    }
    if (!current) fail(`unknown top-level content at line ${index + 1}`);
    sections.get(current).push({ line, lineNumber: index + 1 });
  }
  for (const heading of SECTION_HEADINGS) {
    if (!sections.has(heading)) fail(`missing required section ${heading.slice(0, -1)}`);
  }
  return sections;
}

function requireListLines(entries, section) {
  if (entries.length === 0) fail(`${section} requires at least one list item`);
  return entries.map((entry) => {
    if (!entry.line.startsWith('- ')) fail(`malformed list item in ${section} at line ${entry.lineNumber}`);
    if (entry.line.slice(2).trim() === '') fail(`empty list item in ${section} at line ${entry.lineNumber}`);
    return { value: entry.line.slice(2), lineNumber: entry.lineNumber };
  });
}

function parseIssueSummaryList(entries, section, noneLiteral = null) {
  const items = requireListLines(entries, section);
  if (noneLiteral && items.length === 1 && items[0].value === noneLiteral) return [];
  return items.map((item) => {
    const field = splitFieldBody(item.value, item.lineNumber);
    return {
      issue_id: requirePattern(field.name, /^ISSUE-\d{3,}$/, `${section} issue id`),
      summary: redactText(field.value)
    };
  });
}

function parseFixReport(text, { allowVerification = false } = {}) {
  const lines = normalizePayload(text);
  const sections = collectSections(lines, { allowVerification });
  const fixed = parseIssueSummaryList(sections.get('Fixed:'), 'Fixed');
  const filesChanged = requireListLines(sections.get('Files changed:'), 'Files changed').map((item) => redactText(item.value));
  const notFixed = parseIssueSummaryList(sections.get('Not fixed:'), 'Not fixed', 'none');
  const residualRiskItems = requireListLines(sections.get('Residual risk:'), 'Residual risk');
  const residualRisk = residualRiskItems.length === 1 && residualRiskItems[0].value === 'none identified'
    ? []
    : residualRiskItems.map((item) => redactText(item.value));
  // Per-round verification (file-set fix path): a real verification method + result, or an
  // honest "none could run" residual-risk note. Required to be non-empty when the section is
  // present so a round can never silently skip recording its verification.
  let verification = null;
  if (allowVerification && sections.has(VERIFICATION_SECTION)) {
    const verificationItems = requireListLines(sections.get(VERIFICATION_SECTION), 'Verification');
    verification = verificationItems.map((item) => redactText(item.value));
  }
  return {
    fixed,
    filesChanged,
    notFixed,
    residualRisk,
    verification,
    warnings: []
  };
}

function parseSummary(lines, status) {
  if (lines.length !== 2) fail(`${status} must contain exactly Summary`);
  const field = splitField(lines[1], 0, 2);
  if (field.name !== 'Summary') fail(`expected Summary field, got ${field.name}`);
  return redactText(field.value);
}

function parseDiffReview(text) {
  const lines = normalizePayload(text);
  if (lines[0] === 'DIFF-OK') {
    return {
      result: 'DIFF-OK',
      summary: parseSummary(lines, 'DIFF-OK'),
      findings: [],
      warnings: []
    };
  }
  if (lines[0] !== 'DIFF-FAIL') fail('diff review must start with DIFF-OK or DIFF-FAIL');
  if (lines[1] !== 'Findings:') fail('DIFF-FAIL requires Findings section');
  if (lines.length < 3) fail('DIFF-FAIL requires at least one finding');
  const rawFindings = parseOrderedListItems(lines, 2, DIFF_FAIL_FIELDS, {
    allowedFields: new Set(DIFF_FAIL_FIELDS)
  });
  const findings = rawFindings.map((finding) => ({
    issue_id: requirePattern(finding.issue_id, /^ISSUE-\d{3,}$/, 'issue_id'),
    problem: redactText(finding.problem),
    required_action: redactText(finding.required_action)
  }));
  return {
    result: 'DIFF-FAIL',
    summary: null,
    findings,
    warnings: []
  };
}

function findFinalBlock(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('Final status: ')) starts.push(index);
  }
  if (starts.length !== 1) fail('final response machine block must appear exactly once');
  const start = starts[0];
  if (start + FINAL_FIELDS.length > lines.length) fail('final response machine block must contain exactly 14 lines');
  const block = lines.slice(start, start + FINAL_FIELDS.length);
  for (let offset = 0; offset < block.length; offset += 1) {
    if (block[offset] === '') fail('final response machine block must not contain blank lines');
  }
  return block;
}

function parseFinalResponseBlock(text, { allowFileSet = false } = {}) {
  const lines = normalizePayload(text);
  const block = findFinalBlock(lines);
  const parsed = {};
  for (let index = 0; index < FINAL_FIELDS.length; index += 1) {
    const [key, label] = FINAL_FIELDS[index];
    const field = splitField(block[index], 0, index + 1);
    if (field.name !== label) fail(`field order error: expected ${label}`);
    parsed[key] = redactText(field.value);
  }

  parsed.finalStatus = requireOneOf(parsed.finalStatus, FINAL_STATUSES, 'Final status');
  parsed.assurance = requireOneOf(parsed.assurance, ASSURANCES, 'Assurance');
  parsed.runtimePlatform = requireOneOf(parsed.runtimePlatform, RUNTIME_PLATFORMS, 'Runtime platform');
  parsed.mode = requireOneOf(parsed.mode, MODES, 'Mode');
  // PLAN-TASK-009 (Phase C2): file-set finalize has no single Target (Target: none); the
  // changed-file set is a comma-separated list of safe in-set relative paths. Document
  // finalize keeps its strict single-target equality (allowFileSet defaults false).
  if (allowFileSet && parsed.target === 'none') {
    if (parsed.filesChanged !== 'none') {
      for (const file of parsed.filesChanged.split(',').map((item) => item.trim())) {
        if (file === '' || file.includes('\0') || path.isAbsolute(file) || file.split('/').includes('..')) {
          fail('Files changed must be none or a list of safe in-set relative paths');
        }
      }
    }
  } else if (parsed.filesChanged !== 'none' && parsed.filesChanged !== parsed.target) {
    fail('Files changed must be none or the exact target path');
  }
  if (parsed.fixedIssueIds !== 'none') {
    for (const issueId of parsed.fixedIssueIds.split(',').map((item) => item.trim())) {
      requirePattern(issueId, /^ISSUE-\d{3,}$/, 'Fixed issue IDs');
    }
  }
  parsed.blockingReason = requireOneOf(parsed.blockingReason, BLOCKING_REASONS, 'Blocking reason');
  parsed.statusReason = requireOneOf(parsed.statusReason, STATUS_REASONS, 'Status reason');
  if (parsed.finalStatus === 'pass') {
    if (parsed.coordinatorAgreement === 'none') fail('Coordinator agreement is required when Final status is pass');
  } else if (parsed.coordinatorAgreement !== 'none') {
    fail('Coordinator agreement must be none unless Final status is pass');
  }
  return parsed;
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasPathPart(filePath, part) {
  return filePath.split(path.sep).includes(part);
}

function handoffFail(message, code = 'ERR_UNSAFE_HANDOFF_FILE') {
  fail(message, code);
}

function readSemanticPayload({ filePath, projectRoot, content } = {}) {
  if (content !== undefined && content !== null) return String(content);
  if (!filePath) handoffFail('unsafe-handoff-file: semantic payload file is required');

  const absolute = path.resolve(filePath);
  const rootAbsolute = path.resolve(projectRoot || process.cwd());
  const rootReal = fs.realpathSync.native(rootAbsolute);
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch {
    handoffFail(`unsafe-handoff-file: semantic payload file must exist: ${filePath}`);
  }
  if (stats.isSymbolicLink()) handoffFail('unsafe-handoff-file: semantic payload file must not be a symlink');
  if (!stats.isFile()) handoffFail('unsafe-handoff-file: semantic payload file must be a regular file');

  const fileReal = fs.realpathSync.native(absolute);
  const tempReal = fs.realpathSync.native(os.tmpdir());
  if (!isInsideOrEqual(fileReal, tempReal)) {
    handoffFail('unsafe-handoff-file: semantic payload file must be under OS temp directory');
  }
  if (hasPathPart(absolute, '.docs-review-fix') || hasPathPart(fileReal, '.docs-review-fix')) {
    handoffFail('unsafe-handoff-file: semantic payload file must not be under .docs-review-fix');
  }
  if (
    isInsideOrEqual(absolute, rootAbsolute) ||
    isInsideOrEqual(absolute, rootReal) ||
    isInsideOrEqual(fileReal, rootAbsolute) ||
    isInsideOrEqual(fileReal, rootReal)
  ) {
    handoffFail('project-local: semantic payload file must not be under project root', 'ERR_PROJECT_LOCAL_HANDOFF');
  }

  return fs.readFileSync(fileReal, 'utf8');
}

module.exports = {
  parseTriageResult,
  parseFixReport,
  parseDiffReview,
  parseFinalResponseBlock,
  readSemanticPayload
};
