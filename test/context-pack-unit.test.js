'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildFileSetContextPack, mergedRulesFingerprint } = require('../lib/context-pack');

// ---------------------------------------------------------------------------
// mergedRulesFingerprint — pure sha256(mergedRules.text) tests
// ---------------------------------------------------------------------------

test('mergedRulesFingerprint returns stable 64-char hex for same text', () => {
  const rules = { text: 'rule: no empty catch blocks' };
  const fp1 = mergedRulesFingerprint(rules);
  const fp2 = mergedRulesFingerprint(rules);
  assert.equal(typeof fp1, 'string');
  assert.equal(fp1.length, 64);
  assert.equal(fp1, fp2, 'fingerprint must be deterministic for same text');
});

test('mergedRulesFingerprint changes when text changes', () => {
  const fp1 = mergedRulesFingerprint({ text: 'rule-A' });
  const fp2 = mergedRulesFingerprint({ text: 'rule-B' });
  assert.notEqual(fp1, fp2, 'fingerprint must differ when text differs');
});

test('mergedRulesFingerprint handles empty text without throwing', () => {
  const fp = mergedRulesFingerprint({ text: '' });
  assert.equal(typeof fp, 'string');
  assert.equal(fp.length, 64);
});

test('mergedRulesFingerprint handles missing text property without throwing', () => {
  const fp = mergedRulesFingerprint({});
  assert.equal(typeof fp, 'string');
  assert.equal(fp.length, 64);
  // sha256('') is deterministic
  const fpEmpty = mergedRulesFingerprint({ text: '' });
  assert.equal(fp, fpEmpty, 'missing text behaves same as empty string');
});

test('mergedRulesFingerprint hashes raw text (same raw => same hash)', () => {
  const rawText = '### hard\nNo force-push to main.\n\n### built-in-code\nUse strict mode.';
  const fp = mergedRulesFingerprint({ text: rawText });
  // verify independently via node:crypto
  const crypto = require('node:crypto');
  const expected = crypto.createHash('sha256').update(rawText).digest('hex');
  assert.equal(fp, expected, 'fingerprint must equal sha256(raw text)');
});

// ---------------------------------------------------------------------------
// buildFileSetContextPack — NON-PARTITIONED (byte-identical baseline)
// ---------------------------------------------------------------------------

function makeBaseOpts() {
  return {
    routeKind: 'code',
    fileSet: {
      files: ['src/foo.js', 'src/bar.js'],
      normalizedScopes: ['src']
    },
    strictness: 'normal',
    mode: 'review-and-fix',
    assurance: 'advisory',
    runtimePlatform: 'claude',
    phase: 'review',
    round: 1,
    mergedRules: { text: 'some-rules', sources: ['hard', 'built-in-code'] }
  };
}

test('non-partitioned pack has empty references array', () => {
  const pack = buildFileSetContextPack(makeBaseOpts());
  assert.deepEqual(pack.references, [], 'non-partitioned must have references: []');
});

test('non-partitioned pack has no reviewMode or unit_id keys', () => {
  const pack = buildFileSetContextPack(makeBaseOpts());
  assert.equal(Object.hasOwn(pack, 'reviewMode'), false, 'non-partitioned must not have reviewMode');
  assert.equal(Object.hasOwn(pack, 'unit_id'), false, 'non-partitioned must not have unit_id');
});

test('non-partitioned pack is byte-identical when called twice with same args', () => {
  const opts = makeBaseOpts();
  const pack1 = buildFileSetContextPack(opts);
  const pack2 = buildFileSetContextPack(opts);
  assert.deepEqual(pack1, pack2, 'non-partitioned output must be deterministic');
});

// ---------------------------------------------------------------------------
// buildFileSetContextPack — PARTITIONED mode
// ---------------------------------------------------------------------------

const UNIT_FILES = [
  { path: 'src/unit-a/index.js', status: 'present' },
  { path: 'src/unit-a/helper.js', status: 'present' }
];

const SUGGESTED_REFS = [
  { path: 'src/shared/utils.js', contentId: 'abc123' },
  { path: 'src/shared/constants.js', contentId: 'def456' }
];

// A whole-project file that must NOT appear in the partitioned pack
const WHOLE_PROJECT_FILE = 'src/other-unit/excluded.js';

function makePartitionedOpts() {
  return {
    routeKind: 'code',
    fileSet: {
      files: UNIT_FILES,
      normalizedScopes: ['src/unit-a']
    },
    reviewMode: 'partitioned',
    unitId: 'unit-001',
    suggestedRefs: SUGGESTED_REFS,
    strictness: 'normal',
    mode: 'review-and-fix',
    assurance: 'advisory',
    runtimePlatform: 'claude',
    phase: 'review',
    round: 1,
    mergedRules: { text: 'some-rules', sources: ['hard', 'built-in-code'] }
  };
}

test('partitioned pack carries reviewMode: partitioned', () => {
  const pack = buildFileSetContextPack(makePartitionedOpts());
  assert.equal(pack.reviewMode, 'partitioned');
});

test('partitioned pack carries unit_id', () => {
  const pack = buildFileSetContextPack(makePartitionedOpts());
  assert.equal(pack.unit_id, 'unit-001');
});

test('partitioned pack descriptor.files contains exactly the unit files', () => {
  const pack = buildFileSetContextPack(makePartitionedOpts());
  assert.equal(pack.fileSet.fileCount, UNIT_FILES.length, 'fileCount must equal unit file count');
  assert.equal(pack.fileSet.files.length, UNIT_FILES.length, 'files array length must equal unit file count');
  const filePaths = pack.fileSet.files.map((f) => f.path);
  assert.ok(filePaths.some((p) => p.includes('index.js')), 'unit file index.js must be present');
  assert.ok(filePaths.some((p) => p.includes('helper.js')), 'unit file helper.js must be present');
});

test('partitioned pack references contains exactly suggestedRefs (readOnly)', () => {
  const pack = buildFileSetContextPack(makePartitionedOpts());
  assert.equal(pack.references.length, SUGGESTED_REFS.length, 'references must match suggestedRefs count');
  for (const ref of pack.references) {
    assert.equal(ref.readOnly, true, 'all references must be readOnly');
    assert.equal(typeof ref.path, 'string', 'reference path must be a string');
    assert.ok(ref.path.length > 0, 'reference path must be non-empty');
  }
  const refPaths = pack.references.map((r) => r.path);
  assert.ok(refPaths.some((p) => p.includes('utils.js')), 'suggestedRef utils.js must appear');
  assert.ok(refPaths.some((p) => p.includes('constants.js')), 'suggestedRef constants.js must appear');
});

test('partitioned pack contains NO out-of-set files (no whole-project leakage)', () => {
  const pack = buildFileSetContextPack(makePartitionedOpts());
  const allPaths = [
    ...pack.fileSet.files.map((f) => f.path),
    ...pack.references.map((r) => r.path)
  ];
  for (const p of allPaths) {
    assert.equal(
      p.includes('excluded.js'),
      false,
      `whole-project file "${WHOLE_PROJECT_FILE}" must not appear in partitioned pack (found: ${p})`
    );
    assert.equal(
      p.includes('other-unit'),
      false,
      `out-of-set directory "other-unit" must not appear in partitioned pack`
    );
  }
});

test('partitioned pack paths are redacted (no raw absolute paths)', () => {
  const absRoot = '/Users/testuser/my-project';
  const opts = makePartitionedOpts();
  opts.projectRoot = absRoot;
  opts.fileSet.files = [
    { path: `${absRoot}/src/unit-a/index.js`, status: 'present' }
  ];
  opts.suggestedRefs = [
    { path: `${absRoot}/src/shared/utils.js`, contentId: 'abc123' }
  ];
  const pack = buildFileSetContextPack(opts);
  for (const f of pack.fileSet.files) {
    assert.equal(
      f.path.includes(absRoot),
      false,
      `absolute root path must be redacted from file path: ${f.path}`
    );
  }
  for (const r of pack.references) {
    assert.equal(
      r.path.includes(absRoot),
      false,
      `absolute root path must be redacted from reference path: ${r.path}`
    );
  }
});

test('partitioned pack has contentPolicy: read-in-memory-only', () => {
  const pack = buildFileSetContextPack(makePartitionedOpts());
  assert.equal(pack.contentPolicy, 'read-in-memory-only');
});

test('partitioned pack does not include file bodies (no body property in files)', () => {
  const pack = buildFileSetContextPack(makePartitionedOpts());
  for (const f of pack.fileSet.files) {
    assert.equal(Object.hasOwn(f, 'body'), false, 'files must not contain body text');
    assert.equal(Object.hasOwn(f, 'content'), false, 'files must not contain content');
  }
});

// ---------------------------------------------------------------------------
// Non-partitioned stays byte-identical when partitioned opts are absent
// ---------------------------------------------------------------------------

test('non-partitioned output is unaffected by the new optional params being absent', () => {
  const base = makeBaseOpts();
  const pack = buildFileSetContextPack(base);
  // Must not have partitioned fields
  assert.deepEqual(pack.references, []);
  assert.equal(Object.hasOwn(pack, 'reviewMode'), false);
  assert.equal(Object.hasOwn(pack, 'unit_id'), false);
  // Core fields intact
  assert.equal(pack.contentPolicy, 'read-in-memory-only');
  assert.equal(pack.documentType, 'none');
  assert.equal(pack.routeKind, 'code');
  assert.equal(pack.target, 'none');
});
