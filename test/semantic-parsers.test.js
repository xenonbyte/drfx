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
  parseUnitReviewReport,
  readSemanticPayload
} = require('../lib/semantic-parsers');

const ROOT = path.join(__dirname, '..');

function readShared(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function validFixReportLines() {
  return [
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
  ];
}

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

test('document and file-set fix reports share optional Verification schema', () => {
  const withoutVerification = parseFixReport(validFixReportLines().join('\n'), {
    allowVerification: true
  });
  assert.equal(withoutVerification.verification, null);

  const withVerification = parseFixReport([
    ...validFixReportLines().slice(0, 9),
    'Verification:',
    '- npm test passes',
    '',
    ...validFixReportLines().slice(9)
  ].join('\n'), { allowVerification: true });
  assert.deepEqual(withVerification.verification, ['npm test passes']);

  assert.throws(
    () => parseFixReport([
      ...validFixReportLines().slice(0, 9),
      'Verification:',
      '',
      ...validFixReportLines().slice(9)
    ].join('\n'), { allowVerification: true }),
    /Verification/i
  );
});

test('fix report Verification schema rejects wrong order and unknown sections', () => {
  assert.throws(
    () => parseFixReport([
      ...validFixReportLines(),
      '',
      'Verification:',
      '- npm test passes'
    ].join('\n'), { allowVerification: true }),
    /section order/i
  );

  assert.throws(
    () => parseFixReport([
      ...validFixReportLines().slice(0, 9),
      'Notes:',
      '- extra',
      '',
      ...validFixReportLines().slice(9)
    ].join('\n'), { allowVerification: true }),
    /unknown section Notes/i
  );
});

test('fix report prompt/schema contracts cover reviewer triage fix diff review and final response payload sections', () => {
  const reviewer = readShared('shared/prompts/reviewer.md');
  const fixer = readShared('shared/prompts/fixer.md');
  const coordinator = readShared('shared/prompts/coordinator.md');

  assert.match(reviewer, /Output schema:[\s\S]*PASS[\s\S]*Summary:/);
  assert.match(reviewer, /FAIL[\s\S]*Findings:[\s\S]*- id: R001/);
  for (const field of ['severity:', 'location:', 'issue:', 'why_it_matters:', 'suggested_fix:', 'confidence:', 'sensitive:']) {
    assert.match(reviewer, new RegExp(field));
  }

  assert.match(coordinator, /Triage report:[\s\S]*Triage:[\s\S]*- reviewer_id: R001/);
  for (const field of [
    'issue_id:',
    'decision:',
    'severity:',
    'original_severity:',
    'rationale:',
    'merged_into:',
    'deferred_owner:',
    'deferred_next_action:',
    'non_blocking:'
  ]) {
    assert.match(coordinator, new RegExp(field));
  }

  assert.match(
    fixer,
    /Output:[\s\S]*Fixed:[\s\S]*Files changed:[\s\S]*Not fixed:[\s\S]*Verification:[\s\S]*Residual risk:/
  );
  assert.match(fixer, /Verification:[\s\S]*omit this section/i);

  assert.match(coordinator, /Diff review:[\s\S]*DIFF-OK[\s\S]*DIFF-FAIL/);
  for (const field of ['issue_id', 'problem', 'required_action']) {
    assert.match(coordinator, new RegExp(field));
  }

  assert.match(
    coordinator,
    /Internal workflow final-response payload machine block fields are `Final status:`, `Assurance:`, `Runtime platform:`, `Mode:`, `Target:`, `Files changed:`, `Fixed issue IDs:`, `Verification performed:`, `Deferrals or blockers:`, `Blocking reason:`, `Status reason:`, `Residual risk:`, `Redaction statement:`, and `Coordinator agreement:`\./
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

test('rejects semantic payload through .drfx symlink to OS temp', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-payload-root-'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-payload-target-'));
  const handoffDir = path.join(projectRoot, '.drfx');
  const filePath = path.join(handoffDir, 'payload.md');
  fs.writeFileSync(path.join(tempDir, 'payload.md'), 'PASS\nSummary: none\n');
  fs.symlinkSync(tempDir, handoffDir, 'dir');

  assert.throws(
    () => readSemanticPayload({ filePath, projectRoot }),
    /unsafe-handoff-file|project-local|\.drfx/i
  );
});

test('rejects semantic payload through project-root symlink to OS temp', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-payload-root-'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-payload-target-'));
  const handoffDir = path.join(projectRoot, 'handoff');
  const filePath = path.join(handoffDir, 'payload.md');
  fs.writeFileSync(path.join(tempDir, 'payload.md'), 'PASS\nSummary: none\n');
  fs.symlinkSync(tempDir, handoffDir, 'dir');

  assert.throws(
    () => readSemanticPayload({ filePath, projectRoot }),
    /unsafe-handoff-file|project-local/i
  );
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

test('final response accepts stopped-no-progress with no-progress-detected', () => {
  const block = [
    'Final status: stopped-no-progress',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/spec.md',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: full re-review',
    'Deferrals or blockers: ISSUE-001 unresolved after fix-attempt cap',
    'Blocking reason: none',
    'Status reason: no-progress-detected',
    'Residual risk: ISSUE-001 remains unresolved',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');
  const parsed = parseFinalResponseBlock(block);
  assert.equal(parsed.finalStatus, 'stopped-no-progress');
  assert.equal(parsed.statusReason, 'no-progress-detected');
});

// ---------------------------------------------------------------------------
// parseUnitReviewReport tests (PLAN-TASK-008)
// ---------------------------------------------------------------------------

function makeUnitReviewReport(overrides = {}) {
  const defaults = {
    unit: 'unit-001',
    reviewed: 'true',
    coverageRisk: 'none',
    skippedLines: ['- none'],
    extraReadsLines: ['- none'],
    contractsLines: ['- none']
  };
  const o = Object.assign({}, defaults, overrides);
  return [
    `Unit: ${o.unit}`,
    `Reviewed: ${o.reviewed}`,
    `Coverage risk: ${o.coverageRisk}`,
    'Skipped:',
    ...o.skippedLines,
    '',
    'Extra reads:',
    ...o.extraReadsLines,
    '',
    'Contracts touched:',
    ...o.contractsLines
  ].join('\n');
}

test('parseUnitReviewReport: valid receipt with coverage_risk none and empty lists', () => {
  const parsed = parseUnitReviewReport(makeUnitReviewReport());
  assert.equal(parsed.unitId, 'unit-001');
  assert.equal(parsed.reviewed, true);
  assert.equal(parsed.coverageRisk, 'none');
  assert.deepEqual(parsed.skipped, []);
  assert.deepEqual(parsed.extraReads, []);
  assert.deepEqual(parsed.contractsTouched, []);
  assert.deepEqual(parsed.warnings, []);
});

test('parseUnitReviewReport: valid receipt with coverage_risk high and reviewed false', () => {
  const parsed = parseUnitReviewReport(makeUnitReviewReport({
    coverageRisk: 'high',
    reviewed: 'false'
  }));
  assert.equal(parsed.coverageRisk, 'high');
  assert.equal(parsed.reviewed, false);
});

test('parseUnitReviewReport: valid receipt with populated skipped, extraReads, contractsTouched', () => {
  const contentId = 'b'.repeat(64);
  const parsed = parseUnitReviewReport(makeUnitReviewReport({
    skippedLines: ['- path: src/foo.js  reason: out-of-scope'],
    extraReadsLines: [`- path: src/bar.js  contentId: ${contentId}`],
    contractsLines: ['- ContractA', '- ContractB']
  }));
  assert.equal(parsed.skipped.length, 1);
  assert.equal(parsed.skipped[0].path, 'src/foo.js');
  assert.equal(parsed.skipped[0].reason, 'out-of-scope');
  assert.equal(parsed.extraReads.length, 1);
  assert.equal(parsed.extraReads[0].path, 'src/bar.js');
  assert.equal(parsed.extraReads[0].contentId, contentId);
  assert.equal(parsed.contractsTouched.length, 2);
  assert.equal(parsed.contractsTouched[0], 'ContractA');
  assert.equal(parsed.contractsTouched[1], 'ContractB');
});

test('parseUnitReviewReport: rejects invalid coverage_risk values (not none or high)', () => {
  for (const bad of ['medium', 'low', 'unknown', '', 'NONE', 'HIGH', 'partial']) {
    assert.throws(
      () => parseUnitReviewReport(makeUnitReviewReport({ coverageRisk: bad || 'empty' })),
      /Coverage risk|coverage risk|empty scalar/i,
      `expected throw for coverage_risk="${bad}"`
    );
  }
});

test('parseUnitReviewReport: rejects invalid coverage_risk "medium" specifically', () => {
  assert.throws(
    () => parseUnitReviewReport(makeUnitReviewReport({ coverageRisk: 'medium' })),
    /Coverage risk/i
  );
});

test('parseUnitReviewReport: rejects malformed unit_id', () => {
  // Too few digits
  assert.throws(() => parseUnitReviewReport(makeUnitReviewReport({ unit: 'unit-01' })), /Unit/i);
  // Wrong prefix
  assert.throws(() => parseUnitReviewReport(makeUnitReviewReport({ unit: 'u-001' })), /Unit/i);
  // Uppercase
  assert.throws(() => parseUnitReviewReport(makeUnitReviewReport({ unit: 'UNIT-001' })), /Unit/i);
});

test('parseUnitReviewReport: "Review cache key" is no longer part of the wire format', () => {
  // The field was mandatory-but-unused (never compared to the computed key). It was
  // removed from the wire format; a receipt that still carries it now fails as an
  // unknown scalar under the strict parser.
  const withCacheKey = [
    'Unit: unit-001',
    'Reviewed: true',
    'Coverage risk: none',
    `Review cache key: ${'a'.repeat(64)}`,
    'Skipped:',
    '- none',
    '',
    'Extra reads:',
    '- none',
    '',
    'Contracts touched:',
    '- none'
  ].join('\n');
  assert.throws(() => parseUnitReviewReport(withCacheKey), /unknown scalar field: Review cache key/);
  // A receipt WITHOUT the field parses cleanly and never surfaces a reviewCacheKey.
  const parsed = parseUnitReviewReport(makeUnitReviewReport());
  assert.equal(Object.hasOwn(parsed, 'reviewCacheKey'), false);
});

test('parseUnitReviewReport: rejects unsafe extraRead paths and malformed contentIds', () => {
  for (const badPath of ['../secret.txt', '/tmp/secret.txt', 'src/../secret.txt']) {
    assert.throws(
      () => parseUnitReviewReport(makeUnitReviewReport({
        extraReadsLines: [`- path: ${badPath}  contentId: ${'b'.repeat(64)}`]
      })),
      /Extra reads path/i
    );
  }
  assert.throws(
    () => parseUnitReviewReport(makeUnitReviewReport({
      extraReadsLines: ['- path: src/bar.js  contentId: abc123']
    })),
    /Extra reads contentId/i
  );
});

test('parseUnitReviewReport: rejects missing required fields', () => {
  // Missing Unit
  assert.throws(
    () => parseUnitReviewReport([
      'Reviewed: true',
      'Coverage risk: none',
      'Skipped:',
      '- none',
      '',
      'Extra reads:',
      '- none',
      '',
      'Contracts touched:',
      '- none'
    ].join('\n')),
    /Unit/i
  );
  // Missing Coverage risk
  assert.throws(
    () => parseUnitReviewReport([
      'Unit: unit-001',
      'Reviewed: true',
      'Skipped:',
      '- none',
      '',
      'Extra reads:',
      '- none',
      '',
      'Contracts touched:',
      '- none'
    ].join('\n')),
    /Coverage risk/i
  );
});

test('parseUnitReviewReport: rejects unknown scalar field', () => {
  assert.throws(
    () => parseUnitReviewReport([
      'Unit: unit-001',
      'Reviewed: true',
      'Coverage risk: none',
      'Extra flag: unexpected',
      'Skipped:',
      '- none',
      '',
      'Extra reads:',
      '- none',
      '',
      'Contracts touched:',
      '- none'
    ].join('\n')),
    /unknown scalar field/i
  );
});

test('parseUnitReviewReport: rejects unknown section', () => {
  assert.throws(
    () => parseUnitReviewReport([
      'Unit: unit-001',
      'Reviewed: true',
      'Coverage risk: none',
      'Skipped:',
      '- none',
      '',
      'Notes:',
      '- extra',
      '',
      'Extra reads:',
      '- none',
      '',
      'Contracts touched:',
      '- none'
    ].join('\n')),
    /unknown section/i
  );
});

test('parseUnitReviewReport: rejects duplicate section', () => {
  assert.throws(
    () => parseUnitReviewReport([
      'Unit: unit-001',
      'Reviewed: true',
      'Coverage risk: none',
      'Skipped:',
      '- none',
      '',
      'Extra reads:',
      '- none',
      '',
      'Contracts touched:',
      '- none',
      '',
      'Skipped:',
      '- none'
    ].join('\n')),
    /duplicate section/i
  );
});

test('parseUnitReviewReport: rejects blank line inside list', () => {
  assert.throws(
    () => parseUnitReviewReport([
      'Unit: unit-001',
      'Reviewed: true',
      'Coverage risk: none',
      'Skipped:',
      '- path: src/a.js  reason: out-of-scope',
      '',
      '- path: src/b.js  reason: out-of-scope',
      '',
      'Extra reads:',
      '- none',
      '',
      'Contracts touched:',
      '- none'
    ].join('\n')),
    // blank line resets currentSection, so the second "- path:" line at the top level
    // will hit "malformed scalar field" — either message is acceptable
    /.+/
  );
});

test('parseUnitReviewReport: rejects missing required sections', () => {
  assert.throws(
    () => parseUnitReviewReport([
      'Unit: unit-001',
      'Reviewed: true',
      'Coverage risk: none',
      'Skipped:',
      '- none'
    ].join('\n')),
    /Extra reads/i
  );
});

test('parseUnitReviewReport: sanity — parseFinalResponseBlock unchanged after Task 8', () => {
  // Verify parseFinalResponseBlock still parses a standard valid payload correctly.
  const block = [
    'Final status: blocked',
    'Assurance: advisory',
    'Runtime platform: manual',
    'Mode: read-only',
    'Target: docs/spec.md',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: none',
    'Deferrals or blockers: none',
    'Blocking reason: state-validation-failed',
    'Status reason: none',
    'Residual risk: none',
    'Redaction statement: none',
    'Coordinator agreement: none'
  ].join('\n');
  const parsed = parseFinalResponseBlock(block);
  assert.equal(parsed.finalStatus, 'blocked');
  assert.equal(parsed.blockingReason, 'state-validation-failed');
});

test('parseUnitReviewReport: sanity — parseFixReport unchanged after Task 8', () => {
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

test('coverage-incomplete is now an accepted Status reason for parseFinalResponseBlock', () => {
  const block = [
    'Final status: checkpoint',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: docs/spec.md',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: none',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: coverage-incomplete',
    'Residual risk: none',
    'Redaction statement: none',
    'Coordinator agreement: none'
  ].join('\n');
  const parsed = parseFinalResponseBlock(block);
  assert.equal(parsed.statusReason, 'coverage-incomplete');
});
