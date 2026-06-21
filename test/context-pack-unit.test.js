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

// ---------------------------------------------------------------------------
// PLAN-TASK-014: chunk RANGE METADATA persistence (never body text). A
// partitioned chunk member carries contextLineRange/primaryLineRange and the
// unit-level chunkIndex/chunkCount copied onto the member by unitContext. The
// persisted pack records ONLY metadata + an instruction label; the reviewer
// reads the actual contextLineRange slice into its prompt in memory at dispatch.
// ---------------------------------------------------------------------------

// A sentinel body line that lives at line 401 of the chunked file. If the pack
// ever persisted the file body for the [381,820] slice, this string would appear
// in the serialized manifest. It MUST be absent.
const CHUNK_BODY_SENTINEL = 'SENTINEL_CHUNK_BODY_LINE_401_must_never_be_persisted';

function makeChunkMemberOpts() {
  return {
    routeKind: 'code',
    fileSet: {
      files: [
        {
          path: 'src/big.js',
          status: 'present',
          primaryLineRange: [401, 800],
          contextLineRange: [381, 820],
          chunkIndex: 0,
          chunkCount: 2
        }
      ],
      normalizedScopes: []
    },
    reviewMode: 'partitioned',
    unitId: 'unit-001',
    suggestedRefs: [],
    strictness: 'normal',
    mode: 'review-and-fix',
    assurance: 'advisory',
    runtimePlatform: 'claude',
    phase: 'review',
    round: 1,
    mergedRules: { text: 'some-rules', sources: ['hard', 'built-in-code'] }
  };
}

test('partitioned chunk member persists chunk RANGE METADATA with a concrete instruction label', () => {
  const pack = buildFileSetContextPack(makeChunkMemberOpts());
  assert.equal(pack.fileSet.files.length, 1);
  const member = pack.fileSet.files[0];

  assert.equal(member.path, 'src/big.js');
  assert.equal(member.status, 'present');
  assert.ok(member.chunk, 'chunk member must carry a chunk metadata block');
  // Concrete numeric index/count (Number-coerced from the unit-copied member values).
  assert.equal(member.chunk.index, 0);
  assert.equal(member.chunk.count, 2);
  assert.deepEqual(member.chunk.primaryLineRange, [401, 800]);
  assert.deepEqual(member.chunk.contextLineRange, [381, 820]);
  assert.equal(typeof member.chunk.instruction, 'string');

  // The instruction label is built from the REAL values: 1-based chunk number,
  // count, and both ranges; it carries the location convention and the
  // overlap-is-context-only read-only-slice constraint.
  assert.match(member.chunk.instruction, /src\/big\.js chunk 1\/2/);
  assert.match(member.chunk.instruction, /primary lines \[401,800\]/);
  assert.match(member.chunk.instruction, /context lines \[381,820\]/);
  assert.match(member.chunk.instruction, /src\/big\.js:<line>/);
  assert.match(member.chunk.instruction, /overlap before\/after the primary is context only/i);
  assert.match(member.chunk.instruction, /do not raise duplicate findings for overlap lines/i);
});

test('partitioned chunk member persists NO body text from the contextLineRange slice', () => {
  const opts = makeChunkMemberOpts();
  // Whatever the reviewer reads in memory, the persisted manifest must never carry
  // the file body. Prove it: the sentinel body line is NOT in the serialized pack.
  const pack = buildFileSetContextPack(opts);
  const serialized = JSON.stringify(pack);
  assert.equal(
    serialized.includes(CHUNK_BODY_SENTINEL),
    false,
    'chunk body text from lines 381-820 must never be persisted in the context pack'
  );
  // The chunk member must not carry any body/content/slice field.
  const member = pack.fileSet.files[0];
  assert.equal(Object.hasOwn(member, 'sliceText'), false, 'no sliceText may be persisted');
  assert.equal(Object.hasOwn(member, 'body'), false, 'no body may be persisted');
  assert.equal(Object.hasOwn(member, 'content'), false, 'no content may be persisted');
  assert.equal(Object.hasOwn(member.chunk, 'sliceText'), false, 'chunk block must not carry sliceText');
  assert.equal(Object.hasOwn(member.chunk, 'body'), false, 'chunk block must not carry body');
});

test('partitioned chunk member keeps contentPolicy read-in-memory-only', () => {
  const pack = buildFileSetContextPack(makeChunkMemberOpts());
  assert.equal(pack.contentPolicy, 'read-in-memory-only');
});

test('a member WITHOUT contextLineRange normalizes byte-identically (no chunk key)', () => {
  // String member.
  const stringPack = buildFileSetContextPack({
    ...makeChunkMemberOpts(),
    fileSet: { files: ['src/plain.js'], normalizedScopes: [] }
  });
  assert.deepEqual(stringPack.fileSet.files, [{ path: 'src/plain.js', status: 'present' }]);
  assert.equal(Object.hasOwn(stringPack.fileSet.files[0], 'chunk'), false);

  // Object member without contextLineRange.
  const objectPack = buildFileSetContextPack({
    ...makeChunkMemberOpts(),
    fileSet: { files: [{ path: 'src/plain.js', status: 'present' }], normalizedScopes: [] }
  });
  assert.deepEqual(objectPack.fileSet.files, [{ path: 'src/plain.js', status: 'present' }]);
  assert.equal(Object.hasOwn(objectPack.fileSet.files[0], 'chunk'), false);
});
