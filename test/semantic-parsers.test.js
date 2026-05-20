'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  parseTriageResult,
  parseFixReport,
  parseDiffReview,
  parseFinalResponseBlock,
  readSemanticPayload
} = require('../lib/semantic-parsers');

test('parses triage exact item schema', () => {
  const text = [
    'Triage:',
    '- reviewer_id: R001',
    '  issue_id: ISSUE-001',
    '  decision: accepted',
    '  severity: high',
    '  original_severity: none',
    '  rationale: Confirmed workflow state gap.',
    '  merged_into: none',
    '  deferred_owner: none',
    '  deferred_next_action: none',
    '  non_blocking: false'
  ].join('\n');
  const parsed = parseTriageResult(text);
  assert.equal(parsed.decisions[0].reviewer_id, 'R001');
  assert.equal(parsed.decisions[0].decision, 'accepted');
  assert.deepEqual(parsed.warnings, []);
});

test('triage rejects unknown decision and malformed item indentation', () => {
  assert.throws(
    () => parseTriageResult([
      'Triage:',
      '- reviewer_id: R001',
      '  issue_id: ISSUE-001',
      '  decision: ignored',
      '  severity: high',
      '  original_severity: none',
      '  rationale: Confirmed workflow state gap.',
      '  merged_into: none',
      '  deferred_owner: none',
      '  deferred_next_action: none',
      '  non_blocking: false'
    ].join('\n')),
    /decision/i
  );

  assert.throws(
    () => parseTriageResult([
      'Triage:',
      '- reviewer_id: R001',
      ' issue_id: ISSUE-001',
      '  decision: accepted',
      '  severity: high',
      '  original_severity: none',
      '  rationale: Confirmed workflow state gap.',
      '  merged_into: none',
      '  deferred_owner: none',
      '  deferred_next_action: none',
      '  non_blocking: false'
    ].join('\n')),
    /indentation/i
  );
});

test('fix report requires not fixed and residual risk sections', () => {
  const text = [
    'Fixed:',
    '- ISSUE-001: Added schema validation.',
    '',
    'Files changed:',
    '- docs/target.md',
    '',
    'Not fixed:',
    '- none',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const parsed = parseFixReport(text);
  assert.deepEqual(parsed.fixed, [{ issue_id: 'ISSUE-001', summary: 'Added schema validation.' }]);
  assert.deepEqual(parsed.filesChanged, ['docs/target.md']);
  assert.deepEqual(parsed.notFixed, []);
  assert.deepEqual(parsed.residualRisk, []);
});

test('fix report rejects missing section and unknown section', () => {
  assert.throws(
    () => parseFixReport([
      'Fixed:',
      '- ISSUE-001: Added schema validation.',
      '',
      'Files changed:',
      '- docs/target.md',
      '',
      'Residual risk:',
      '- none identified'
    ].join('\n')),
    /Not fixed/i
  );

  assert.throws(
    () => parseFixReport([
      'Fixed:',
      '- ISSUE-001: Added schema validation.',
      '',
      'Files changed:',
      '- docs/target.md',
      '',
      'Not fixed:',
      '- none',
      '',
      'Notes:',
      '- extra',
      '',
      'Residual risk:',
      '- none identified'
    ].join('\n')),
    /unknown section Notes/i
  );
});

test('fix report rejects sections out of schema order', () => {
  assert.throws(
    () => parseFixReport([
      'Fixed:',
      '- ISSUE-001: Added schema validation.',
      '',
      'Not fixed:',
      '- none',
      '',
      'Files changed:',
      '- docs/target.md',
      '',
      'Residual risk:',
      '- none identified'
    ].join('\n')),
    /section order/i
  );
});

test('parses diff review exact forms', () => {
  const ok = parseDiffReview('DIFF-OK\nSummary: Target-only fix matches accepted issue.\n');
  assert.equal(ok.result, 'DIFF-OK');
  const fail = parseDiffReview([
    'DIFF-FAIL',
    'Findings:',
    '- issue_id: ISSUE-001',
    '  problem: Fix changed unrelated scope.',
    '  required_action: Revert unrelated edit.'
  ].join('\n'));
  assert.equal(fail.result, 'DIFF-FAIL');
  assert.equal(fail.findings[0].issue_id, 'ISSUE-001');
});

test('diff review rejects unknown status and unknown finding field', () => {
  assert.throws(() => parseDiffReview('PASS\nSummary: none\n'), /DIFF-OK|DIFF-FAIL/i);
  assert.throws(
    () => parseDiffReview([
      'DIFF-FAIL',
      'Findings:',
      '- issue_id: ISSUE-001',
      '  problem: Fix changed unrelated scope.',
      '  evidence: extra',
      '  required_action: Revert unrelated edit.'
    ].join('\n')),
    /unknown field evidence/i
  );
});

test('parses final response exact machine block once', () => {
  const block = [
    'Final status: pass',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/spec.md',
    'Files changed: docs/spec.md',
    'Fixed issue IDs: ISSUE-001',
    'Verification performed: npm test',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: none identified',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: approved after full re-review'
  ].join('\n');
  const parsed = parseFinalResponseBlock(`Summary before.\n\n${block}\n\nSummary after.`);
  assert.equal(parsed.finalStatus, 'pass');
  assert.equal(parsed.assurance, 'practical');
});

test('rejects duplicate final response machine blocks', () => {
  const block = 'Final status: blocked\nAssurance: advisory\nRuntime platform: manual\nMode: read-only\nTarget: docs/spec.md\nFiles changed: none\nFixed issue IDs: none\nVerification performed: none\nDeferrals or blockers: blocked\nBlocking reason: state-validation-failed\nStatus reason: none\nResidual risk: none\nRedaction statement: none\nCoordinator agreement: none';
  assert.throws(() => parseFinalResponseBlock(`${block}\n\n${block}`), /exactly once/i);
});

test('final response rejects invalid enum and missing coordinator agreement on pass', () => {
  const invalidStatus = [
    'Final status: done',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/spec.md',
    'Files changed: docs/spec.md',
    'Fixed issue IDs: ISSUE-001',
    'Verification performed: npm test',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: none identified',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: approved'
  ].join('\n');
  assert.throws(() => parseFinalResponseBlock(invalidStatus), /Final status/i);

  const missingAgreement = invalidStatus
    .replace('Final status: done', 'Final status: pass')
    .replace('Coordinator agreement: approved', 'Coordinator agreement: none');
  assert.throws(() => parseFinalResponseBlock(missingAgreement), /Coordinator agreement/i);
});

test('readSemanticPayload reads safe OS temp file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-payload-'));
  const filePath = path.join(tempDir, 'payload.md');
  fs.writeFileSync(filePath, 'PASS\nSummary: none\n');

  assert.equal(readSemanticPayload({ filePath, projectRoot: process.cwd() }), 'PASS\nSummary: none\n');
});

test('rejects semantic payload files under project root', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-payload-root-'));
  const projectFile = path.join(projectRoot, 'payload.md');
  fs.writeFileSync(projectFile, 'PASS\nSummary: none\n');
  assert.throws(
    () => readSemanticPayload({ filePath: projectFile, projectRoot }),
    /unsafe-handoff-file|project-local/i
  );
});
