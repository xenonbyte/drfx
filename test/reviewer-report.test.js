'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseReviewerResult } = require('../lib/reviewer-report');

test('parses reviewer PASS', () => {
  const result = parseReviewerResult('PASS\nSummary: No blocking findings.\n');
  assert.equal(result.result, 'PASS');
  assert.equal(result.summary, 'No blocking findings.');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.warnings, []);
});

test('parses reviewer FAIL with required finding fields', () => {
  const text = [
    'FAIL',
    'Findings:',
    '- id: R001',
    '  severity: high',
    '  location: Section 2',
    '  issue: Missing state validation.',
    '  why_it_matters: The workflow could persist invalid state.',
    '  suggested_fix: Validate schema before write.',
    '  confidence: confirmed',
    '  sensitive: false'
  ].join('\n');
  const result = parseReviewerResult(text);
  assert.equal(result.result, 'FAIL');
  assert.equal(result.summary, null);
  assert.equal(result.findings[0].severity, 'high');
  assert.equal(result.findings[0].why_it_matters, 'The workflow could persist invalid state.');
  assert.deepEqual(result.warnings, []);
});

test('rejects reviewer finding missing why_it_matters', () => {
  assert.throws(
    () => parseReviewerResult([
      'FAIL',
      'Findings:',
      '- id: R001',
      '  severity: high',
      '  location: A',
      '  issue: B',
      '  suggested_fix: C',
      '  confidence: confirmed',
      '  sensitive: false'
    ].join('\n')),
    /required field why_it_matters/i
  );
});

test('normalizes allowed aliases and warns', () => {
  const result = parseReviewerResult([
    'FAIL',
    'Findings:',
    '- id: R001',
    '  severity: low',
    '  location: A',
    '  issue: B',
    '  impact: C',
    '  recommendation: D',
    '  confidence: unconfirmed'
  ].join('\n'));

  assert.equal(result.findings[0].why_it_matters, 'C');
  assert.equal(result.findings[0].suggested_fix, 'D');
  assert.equal(result.findings[0].sensitive, false);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['alias-field', 'alias-field', 'missing-sensitive']
  );
});

test('rejects reviewer unknown field and invalid enum', () => {
  assert.throws(
    () => parseReviewerResult([
      'FAIL',
      'Findings:',
      '- id: R001',
      '  severity: blocker',
      '  location: A',
      '  issue: B',
      '  why_it_matters: C',
      '  suggested_fix: D',
      '  confidence: confirmed',
      '  sensitive: false'
    ].join('\n')),
    /severity/i
  );

  assert.throws(
    () => parseReviewerResult([
      'FAIL',
      'Findings:',
      '- id: R001',
      '  severity: low',
      '  location: A',
      '  issue: B',
      '  why_it_matters: C',
      '  suggested_fix: D',
      '  confidence: confirmed',
      '  evidence: E',
      '  sensitive: false'
    ].join('\n')),
    /unknown field evidence/i
  );
});

test('rejects duplicate reviewer IDs and malformed order', () => {
  assert.throws(
    () => parseReviewerResult([
      'FAIL',
      'Findings:',
      '- id: R001',
      '  severity: low',
      '  location: A',
      '  issue: B',
      '  why_it_matters: C',
      '  suggested_fix: D',
      '  confidence: confirmed',
      '  sensitive: false',
      '- id: R001',
      '  severity: low',
      '  location: A',
      '  issue: B',
      '  why_it_matters: C',
      '  suggested_fix: D',
      '  confidence: confirmed',
      '  sensitive: false'
    ].join('\n')),
    /duplicate id/i
  );

  assert.throws(
    () => parseReviewerResult([
      'FAIL',
      'Findings:',
      '- id: R001',
      '  location: A',
      '  severity: low',
      '  issue: B',
      '  why_it_matters: C',
      '  suggested_fix: D',
      '  confidence: confirmed',
      '  sensitive: false'
    ].join('\n')),
    /field order/i
  );
});

test('redacts secret-like values and downgrades confirmed confidence', () => {
  const text = [
    'FAIL',
    'Findings:',
    '- id: R001',
    '  severity: medium',
    '  location: API token prefix sk-live-123',
    '  issue: Secret appears in document.',
    '  why_it_matters: It may expose credentials.',
    '  suggested_fix: Remove the token.',
    '  confidence: confirmed',
    '  sensitive: false'
  ].join('\n');
  const result = parseReviewerResult(text);
  assert.equal(result.findings[0].sensitive, true);
  assert.equal(result.findings[0].confidence, 'unconfirmed');
  assert.doesNotMatch(JSON.stringify(result), /sk-live-123/);
});
