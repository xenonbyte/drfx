'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  shouldWriteRoundReceipt,
  roundReceiptPath,
  formatRoundReceipt,
  writeRoundReceipt,
  readRoundReceiptArtifacts
} = require('../lib/receipts');

test('decides when round receipts are required', () => {
  assert.equal(shouldWriteRoundReceipt({ auditTrail: true, round: 1, stopReason: null }), true);
  assert.equal(shouldWriteRoundReceipt({ originalLedgerToken: 'ledger=custom/ISSUES.md', round: 1, stopReason: null }), true);
  assert.equal(shouldWriteRoundReceipt({ ledgerPath: 'ISSUES.md', round: 1, stopReason: null }), false);
  assert.equal(shouldWriteRoundReceipt({ auditTrail: false, round: 2, stopReason: null }), true);
  assert.equal(shouldWriteRoundReceipt({ auditTrail: false, round: 1, stopReason: 'interruption' }), true);
  assert.equal(shouldWriteRoundReceipt({ auditTrail: false, round: 1, stopReason: 'context-pressure' }), true);
  for (const stopReason of ['blocked', 'unsupported', 'externally-changed', 'possible-target-replacement', 'read-only-findings', 'stopped-with-deferrals']) {
    assert.equal(shouldWriteRoundReceipt({ auditTrail: false, round: 1, stopReason }), true, stopReason);
  }
  assert.equal(shouldWriteRoundReceipt({ auditTrail: false, round: 1, stopReason: null }), false);
});

test('builds target-local receipt paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-receipts-'));
  const receiptPath = roundReceiptPath({ projectRoot: root, targetKey: 'spec-md-123456789abc', round: 2, kind: 'review' });

  assert.equal(receiptPath, path.join(root, '.drfx', 'targets', 'spec-md-123456789abc', 'rounds', '002-review.md'));
});

test('receipt round directory naming derives ONLY from the round counter, not any rounds=<n> limit', () => {
  // SPEC-STATE-002 / PLAN-TASK-005: the reserved `rounds/` receipt directory is
  // numbered by the current ROUND counter (padded), and is wholly unrelated to the
  // `rounds=<n>` loop limit. The receipt API takes no roundLimit input, so the
  // limit can never leak into receipt path names. The padded segment tracks the
  // round number even when it exceeds a (hypothetical) round limit of 1.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-receipts-limit-sep-'));
  const round3Path = roundReceiptPath({ projectRoot: root, targetKey: 'spec-md-123456789abc', round: 3, kind: 'fix' });
  assert.equal(path.basename(round3Path), '003-fix.md');
  // The same round number yields the same path regardless of caller intent; there
  // is no roundLimit parameter and the segment is purely the padded round counter.
  const round3Again = roundReceiptPath({ projectRoot: root, targetKey: 'spec-md-123456789abc', round: 3, kind: 'fix' });
  assert.equal(round3Again, round3Path);
});

test('rejects receipt path segments that would escape target-local state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-receipts-escape-'));

  assert.throws(
    () => roundReceiptPath({ projectRoot: root, targetKey: '../outside', round: 2, kind: 'review' }),
    /target key/i
  );
  assert.throws(
    () => roundReceiptPath({ projectRoot: root, targetKey: 'spec-md-123456789abc', round: 2, kind: '../review' }),
    /kind/i
  );
});

test('formats receipts with required fields, issue ids, and redacts raw secrets', () => {
  const text = formatRoundReceipt({
    round: 2,
    kind: 'fix',
    status: 'blocked',
    target: 'docs/spec.md',
    issueIds: ['ISSUE-001', 'ISSUE-002'],
    summary: 'Removed leaked token sk-live-1234567890abcdef',
    nextAction: 'Run full re-review'
  });

  assert.match(text, /^# Round 002 Fix Receipt/m);
  assert.match(text, /- Round: 2/);
  assert.match(text, /- Kind: fix/);
  assert.match(text, /- Status: blocked/);
  assert.match(text, /- Target: docs\/spec\.md/);
  assert.match(text, /- Issue IDs: ISSUE-001, ISSUE-002/);
  assert.match(text, /## Summary\nRemoved leaked token \[REDACTED:api-token\]/);
  assert.match(text, /## Next Action\nRun full re-review/);
  assert.doesNotMatch(text, /sk-live-1234567890abcdef/);
});

test('writes receipts under rounds directory with redacted content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-receipts-write-'));
  const written = writeRoundReceipt({
    projectRoot: root,
    targetKey: 'spec-md-123456789abc',
    round: 1,
    kind: 'review',
    status: 'fail',
    target: 'docs/spec.md',
    issueIds: ['ISSUE-001'],
    summary: 'Found missing rollback with password=hunter2',
    nextAction: 'Triage findings'
  });

  assert.equal(written, path.join(root, '.drfx', 'targets', 'spec-md-123456789abc', 'rounds', '001-review.md'));
  const text = fs.readFileSync(written, 'utf8');
  assert.match(text, /ISSUE-001/);
  assert.match(text, /\[REDACTED:credential\]/);
  assert.doesNotMatch(text, /hunter2/);
});

test('writeRoundReceipt rejects symlinked rounds directory without writing outside target state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-receipts-symlink-'));
  const targetDir = path.join(root, '.drfx', 'targets', 'spec-md-123456789abc');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-receipts-outside-'));
  fs.mkdirSync(targetDir, { recursive: true });
  fs.symlinkSync(outside, path.join(targetDir, 'rounds'), 'dir');

  assert.throws(
    () => writeRoundReceipt({
      projectRoot: root,
      targetKey: 'spec-md-123456789abc',
      round: 1,
      kind: 'review',
      status: 'fail',
      target: 'docs/spec.md',
      issueIds: ['ISSUE-001'],
      summary: 'Found issue',
      nextAction: 'Triage findings'
    }),
    /round receipt|symlink|target state/i
  );
  assert.equal(fs.existsSync(path.join(outside, '001-review.md')), false);
});

test('readRoundReceiptArtifacts skips symlinked round receipts and keeps regular files only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-read-receipts-'));
  const targetDir = path.join(root, '.drfx', 'targets', 'spec-md-123456789abc');
  const roundsDir = path.join(targetDir, 'rounds');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-read-receipts-outside-'));
  fs.mkdirSync(roundsDir, { recursive: true });
  fs.writeFileSync(path.join(roundsDir, '001-review.md'), 'safe receipt\n');
  fs.writeFileSync(path.join(outside, 'evil.md'), 'unsafe receipt\n');
  fs.symlinkSync(path.join(outside, 'evil.md'), path.join(roundsDir, '001-evil.md'));

  const receipts = readRoundReceiptArtifacts(targetDir, { fileNamePrefix: '001-' });
  assert.deepEqual(receipts.map((entry) => path.basename(entry.receiptPath)), ['001-review.md']);
  assert.deepEqual(receipts.map((entry) => entry.text), ['safe receipt\n']);
});

test('redacts sensitive values from all formatted receipt fields', () => {
  const text = formatRoundReceipt({
    round: 3,
    kind: 'review',
    status: 'blocked',
    target: 'docs/spec.md?access_token=secret-token-value',
    issueIds: ['ISSUE-003', 'token=secret-token-value'],
    summary: 'Cookie: sessionid=secret-session',
    nextAction: 'Remove Bearer abcdefghijklmnop'
  });

  assert.match(text, /ISSUE-003/);
  assert.match(text, /\[REDACTED:api-token\]/);
  assert.match(text, /\[REDACTED:cookie\]/);
  assert.doesNotMatch(text, /secret-token-value|secret-session|abcdefghijklmnop/);
});

test('redacts secret-derived fragments in formatted receipts without removing ordinary anchors', () => {
  const text = formatRoundReceipt({
    round: 4,
    kind: 'review',
    status: 'blocked',
    target: 'docs/spec.md',
    issueIds: ['ISSUE-004', 'ISSUE-005'],
    summary: 'Found secret prefix: abcd and token hash: deadbeef near auth setup',
    nextAction: 'Remove credential checksum: cafe1234 but keep build anchor deadbeef'
  });

  assert.match(text, /ISSUE-004/);
  assert.match(text, /ISSUE-005/);
  assert.match(text, /\[REDACTED:api-token\]/);
  assert.match(text, /\[REDACTED:credential\]/);
  assert.match(text, /keep build anchor deadbeef/);
  assert.doesNotMatch(text, /secret prefix: abcd|token hash: deadbeef|credential checksum: cafe1234/);
});

test('redacts secret-derived fragments in written receipts and preserves issue ids', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-receipts-derived-'));
  const written = writeRoundReceipt({
    projectRoot: root,
    targetKey: 'spec-md-123456789abc',
    round: 5,
    kind: 'fix',
    status: 'blocked',
    target: 'docs/spec.md',
    issueIds: ['ISSUE-006'],
    summary: 'Removed token suffix: abc123 from prose',
    nextAction: 'Audit secret hash: feedface before re-review'
  });
  const text = fs.readFileSync(written, 'utf8');

  assert.match(text, /ISSUE-006/);
  assert.match(text, /\[REDACTED:api-token\]/);
  assert.doesNotMatch(text, /token suffix: abc123|secret hash: feedface/);
});

test('v2 receipts include fixed fields and attempt suffixes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-receipt-v2-'));
  const first = writeRoundReceipt({
    projectRoot: root,
    targetKey: 'spec-md-aaaaaaaaaaaa',
    round: 2,
    kind: 'review',
    status: 'review',
    target: 'docs/spec.md',
    issueIds: [],
    filesChanged: 'none',
    verification: 'node --test test/workflow-state-v2.test.js',
    summary: 'review completed',
    nextAction: 'triage',
    blockingReason: 'none',
    statusReason: 'none'
  });
  const second = writeRoundReceipt({
    projectRoot: root,
    targetKey: 'spec-md-aaaaaaaaaaaa',
    round: 2,
    kind: 'review',
    status: 'review',
    target: 'docs/spec.md',
    issueIds: [],
    filesChanged: 'none',
    verification: 'node --test test/workflow-state-v2.test.js',
    summary: 'review completed again',
    nextAction: 'triage',
    blockingReason: 'none',
    statusReason: 'none'
  });

  assert.notEqual(first, second);
  assert.equal(path.basename(first), '002-review.md');
  assert.equal(path.basename(second), '002-review-attempt-001.md');
  const text = fs.readFileSync(first, 'utf8');
  assert.match(text, /- Receipt ID: receipt:spec-md-aaaaaaaaaaaa:rounds\/002-review\.md/);
  assert.match(text, /- Files changed: none/);
  assert.match(text, /- Verification: node --test test\/workflow-state-v2\.test\.js/);
  assert.match(text, /- Blocking reason: none/);
  assert.match(text, /- Status reason: none/);
  assert.match(text, /- Issue IDs: none/);
});
