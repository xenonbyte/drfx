'use strict';

const { redactSensitiveWithMeta } = require('./redaction');

const SEVERITIES = new Set(['high', 'medium', 'low']);
const CONFIDENCES = new Set(['confirmed', 'unconfirmed']);
const BOOLEAN_VALUES = new Set(['true', 'false']);
const REQUIRED_FIELDS = Object.freeze([
  'id',
  'severity',
  'location',
  'issue',
  'why_it_matters',
  'suggested_fix',
  'confidence'
]);
const FIELD_ORDER = Object.freeze([...REQUIRED_FIELDS, 'sensitive']);
const ALIASES = Object.freeze({
  impact: 'why_it_matters',
  recommendation: 'suggested_fix',
  suggestedFix: 'suggested_fix'
});
const ALLOWED_FIELDS = new Set([...FIELD_ORDER, ...Object.keys(ALIASES)]);

function fail(message, code = 'ERR_REVIEWER_REPORT_PARSE') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizePayload(text) {
  if (typeof text !== 'string') fail('reviewer result must be a string');
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '').split('\n');
}

function splitField(line, expectedIndent, lineNumber) {
  const prefix = expectedIndent === 0 ? '' : ' '.repeat(expectedIndent);
  if (!line.startsWith(prefix)) fail(`malformed indentation at line ${lineNumber}`);
  const body = line.slice(expectedIndent);
  if (body.startsWith('- ') && expectedIndent !== 0) fail(`malformed nested list at line ${lineNumber}`);
  const separator = body.indexOf(': ');
  if (separator === -1) fail(`malformed field separator at line ${lineNumber}`);
  const name = body.slice(0, separator);
  const value = body.slice(separator + 2);
  if (name === '' || value === '') fail(`missing field value at line ${lineNumber}`);
  if (value.startsWith('```') || /^<[^>]+>/.test(value)) fail(`unsupported block value at line ${lineNumber}`);
  return { name, value };
}

function redactText(value) {
  const result = redactSensitiveWithMeta(value);
  if (typeof result.value === 'string' && result.value.trim() === '') fail('field value must not be empty');
  return result;
}

function parseSummary(line) {
  const { name, value } = splitField(line, 0, 2);
  if (name !== 'Summary') fail(`expected Summary field, got ${name}`);
  const redacted = redactText(value);
  return redacted.value;
}

function normalizeFieldName(rawName, warnings, findingId) {
  if (!ALLOWED_FIELDS.has(rawName)) fail(`unknown field ${rawName}`);
  const normalized = ALIASES[rawName] || rawName;
  if (normalized !== rawName) {
    warnings.push({
      code: 'alias-field',
      field: rawName,
      normalizedTo: normalized,
      id: findingId || null
    });
  }
  return normalized;
}

function parseBoolean(value, field) {
  if (!BOOLEAN_VALUES.has(value)) fail(`invalid ${field}: ${value}`);
  return value === 'true';
}

function validateFinding(finding, seenIds) {
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(finding, field)) fail(`missing required field ${field}`);
  }
  if (!/^R\d{3,}$/.test(finding.id)) fail(`invalid id: ${finding.id}`);
  if (seenIds.has(finding.id)) fail(`duplicate id: ${finding.id}`);
  seenIds.add(finding.id);
  if (!SEVERITIES.has(finding.severity)) fail(`invalid severity: ${finding.severity}`);
  if (!CONFIDENCES.has(finding.confidence)) fail(`invalid confidence: ${finding.confidence}`);
}

function parseFinding(lines, startIndex, warnings, seenIds) {
  const first = lines[startIndex];
  if (!first.startsWith('- ')) fail(`expected finding item at line ${startIndex + 1}`);
  const firstField = splitField(first.slice(2), 0, startIndex + 1);
  if (firstField.name !== 'id') fail(`field order error: expected id at line ${startIndex + 1}`);

  const rawFields = [{ name: 'id', value: firstField.value, lineNumber: startIndex + 1 }];
  let index = startIndex + 1;
  while (index < lines.length && !lines[index].startsWith('- ')) {
    if (lines[index] === '') fail(`blank line inside Findings at line ${index + 1}`);
    if (!lines[index].startsWith('  ')) fail(`malformed indentation at line ${index + 1}`);
    const field = splitField(lines[index], 2, index + 1);
    rawFields.push({ ...field, lineNumber: index + 1 });
    index += 1;
  }

  const finding = {};
  let sensitiveMissing = true;
  let redacted = false;
  let expectedPosition = 0;
  for (let rawIndex = 0; rawIndex < rawFields.length; rawIndex += 1) {
    const raw = rawFields[rawIndex];
    const normalized = normalizeFieldName(raw.name, warnings, finding.id);
    const expected = FIELD_ORDER[expectedPosition];
    if (normalized !== expected) {
      const remainingFields = rawFields.slice(rawIndex).map((field) => ALIASES[field.name] || field.name);
      if (!remainingFields.includes(expected)) fail(`missing required field ${expected}`);
      if (expected === 'sensitive' && normalized !== 'sensitive') {
        fail(`field order error: expected sensitive at line ${raw.lineNumber}`);
      }
      fail(`field order error: expected ${expected} at line ${raw.lineNumber}`);
    }
    if (Object.hasOwn(finding, normalized)) fail(`duplicate field ${normalized}`);
    const value = ['id', 'severity', 'confidence', 'sensitive'].includes(normalized)
      ? raw.value
      : redactText(raw.value).value;
    if (!['id', 'severity', 'confidence', 'sensitive'].includes(normalized)) {
      redacted = redacted || value !== raw.value;
    }
    finding[normalized] = normalized === 'sensitive' ? parseBoolean(value, normalized) : value;
    if (normalized === 'sensitive') sensitiveMissing = false;
    expectedPosition += 1;
  }

  if (sensitiveMissing) {
    finding.sensitive = false;
    warnings.push({
      code: 'missing-sensitive',
      field: 'sensitive',
      defaultedTo: false,
      id: finding.id || null
    });
  }

  validateFinding(finding, seenIds);
  if (redacted) {
    finding.sensitive = true;
    if (finding.confidence === 'confirmed') finding.confidence = 'unconfirmed';
  }
  return { finding, nextIndex: index };
}

function parseFail(lines) {
  if (lines.length < 3) fail('FAIL report requires Findings list');
  if (lines[1] !== 'Findings:') fail(`expected Findings section, got ${lines[1] || 'end of input'}`);

  const warnings = [];
  const seenIds = new Set();
  const findings = [];
  let index = 2;
  while (index < lines.length) {
    const parsed = parseFinding(lines, index, warnings, seenIds);
    findings.push(parsed.finding);
    index = parsed.nextIndex;
  }
  if (findings.length === 0) fail('FAIL report requires at least one finding');
  return {
    result: 'FAIL',
    summary: null,
    findings,
    warnings
  };
}

function parseReviewerResult(text) {
  const lines = normalizePayload(text);
  if (lines[0] === 'PASS') {
    if (lines.length !== 2) fail('PASS report must contain exactly Summary');
    return {
      result: 'PASS',
      summary: parseSummary(lines[1]),
      findings: [],
      warnings: []
    };
  }
  if (lines[0] === 'FAIL') return parseFail(lines);
  fail('reviewer result must start with PASS or FAIL');
}

module.exports = {
  parseReviewerResult
};
