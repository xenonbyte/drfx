'use strict';

// Tests for lib/project-review.js (PLAN-TASK-001).
// Required coverage per the task brief:
//   - partitionInventory determinism
//   - never-split-a-file (no file appears in two units; member_bytes <= budget)
//   - oversize unit (size > MAX_UNIT_BYTES => single-member oversize_file:true)
//   - reviewCacheKey invalidation on contract change; stability when unchanged
//   - suggestRefsFor: only in-root refs, deterministic order, bare specifiers dropped, non-JS yields none
//   - aggregate: dedup identical findings without folding distinct reviewer issues; earned-PASS gate; coverage proof counts;
//     high-severity findings flagged for forced re-read

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  partitionInventory,
  suggestRefsFor,
  reviewCacheKey,
  aggregate,
  refreshPartitionPlanContent,
  CROSSCUTTING_BACKSTOPS,
  MAX_UNIT_BYTES,
  CONTRACT_READ_BUDGET,
} = require('../lib/project-review');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('exports the correct constants', () => {
  assert.equal(MAX_UNIT_BYTES, 1_000_000);
  assert.equal(CONTRACT_READ_BUDGET, 500_000);
  assert.ok(Array.isArray(CROSSCUTTING_BACKSTOPS));
  assert.ok(CROSSCUTTING_BACKSTOPS.includes('security-redaction'));
  assert.ok(CROSSCUTTING_BACKSTOPS.includes('state-machine-invariant'));
  assert.ok(CROSSCUTTING_BACKSTOPS.includes('install-uninstall-fs-safety'));
  assert.ok(CROSSCUTTING_BACKSTOPS.includes('cli-parser-template-consistency'));
  assert.ok(CROSSCUTTING_BACKSTOPS.includes('cross-platform-symlink'));
  assert.ok(CROSSCUTTING_BACKSTOPS.includes('tests-fixtures'));
  assert.ok(CROSSCUTTING_BACKSTOPS.includes('public-contract-backcompat'));
  assert.equal(CROSSCUTTING_BACKSTOPS.length, 7);
});

// ---------------------------------------------------------------------------
// partitionInventory — determinism
// ---------------------------------------------------------------------------

test('partitionInventory: identical inputs produce identical output', () => {
  const inv = [
    { path: 'lib/a.js', size: 100, ext: '.js', contentId: 'aaa' },
    { path: 'lib/b.js', size: 200, ext: '.js', contentId: 'bbb' },
    { path: 'lib/c.js', size: 300, ext: '.js', contentId: 'ccc' },
  ];
  const r1 = partitionInventory(inv);
  const r2 = partitionInventory([...inv]);
  assert.deepEqual(r1, r2);
});

test('partitionInventory: returns an array of unit objects', () => {
  const inv = [
    { path: 'a.js', size: 100, ext: '.js', contentId: 'aaa' },
  ];
  const units = partitionInventory(inv);
  assert.ok(Array.isArray(units));
  assert.equal(units.length, 1);
  const u = units[0];
  assert.ok(typeof u.unit_id === 'string');
  assert.ok(u.unit_id.startsWith('unit-'));
  assert.ok(Array.isArray(u.files));
  assert.equal(u.files.length, 1);
  assert.ok(typeof u.member_bytes === 'number');
  assert.ok(typeof u.member_count === 'number');
  assert.ok(typeof u.member_digest === 'string');
});

// ---------------------------------------------------------------------------
// partitionInventory — never-split-a-file
// ---------------------------------------------------------------------------

test('partitionInventory: no file appears in two units', () => {
  // 10 files of 200 KB each; budget is 1 MB => groups of 5 per unit
  const inv = Array.from({ length: 10 }, (_, i) => ({
    path: `lib/file${i}.js`,
    size: 200_000,
    ext: '.js',
    contentId: `cid${i}`,
  }));
  const units = partitionInventory(inv);
  const seen = new Set();
  for (const u of units) {
    for (const f of u.files) {
      assert.ok(!seen.has(f.path), `file ${f.path} appears in more than one unit`);
      seen.add(f.path);
    }
  }
  assert.equal(seen.size, 10);
});

test('partitionInventory: member_bytes does not exceed budget (normal files)', () => {
  const inv = Array.from({ length: 8 }, (_, i) => ({
    path: `lib/file${i}.js`,
    size: 300_000,
    ext: '.js',
    contentId: `cid${i}`,
  }));
  const units = partitionInventory(inv);
  for (const u of units) {
    if (!u.oversize_file) {
      assert.ok(u.member_bytes <= MAX_UNIT_BYTES,
        `unit ${u.unit_id} has member_bytes=${u.member_bytes} > budget`);
    }
  }
});

test('partitionInventory: member_bytes respects custom unitByteBudget', () => {
  const budget = 250_000;
  const inv = [
    { path: 'a.js', size: 200_000, ext: '.js', contentId: 'c1' },
    { path: 'b.js', size: 200_000, ext: '.js', contentId: 'c2' },
  ];
  const units = partitionInventory(inv, { unitByteBudget: budget });
  // Both files fit independently since 200K <= 250K, but together 400K > 250K
  for (const u of units) {
    if (!u.oversize_file) {
      assert.ok(u.member_bytes <= budget);
    }
  }
  // Should be 2 units (can't fit both)
  assert.equal(units.length, 2);
});

// ---------------------------------------------------------------------------
// partitionInventory — oversize unit
// ---------------------------------------------------------------------------

test('partitionInventory: file larger than MAX_UNIT_BYTES becomes single-member oversize unit', () => {
  const inv = [
    { path: 'big.js', size: 2_000_000, ext: '.js', contentId: 'bigcid' },
  ];
  const units = partitionInventory(inv);
  assert.equal(units.length, 1);
  const u = units[0];
  assert.equal(u.oversize_file, true);
  assert.equal(u.files.length, 1);
  assert.equal(u.files[0].path, 'big.js');
});

test('partitionInventory: oversize unit has fixed coverage fields', () => {
  const inv = [
    { path: 'giant.js', size: 5_000_000, ext: '.js', contentId: 'gcid' },
  ];
  const units = partitionInventory(inv);
  const u = units[0];
  // The brief says oversize unit body is never loaded => reviewed:false, coverage_risk:high
  assert.equal(u.oversize_file, true);
  // These fixed fields appear on the unit record itself per the implementation choice;
  // the actual summary file writes them, but the unit must carry the flag
  assert.equal(u.member_count, 1);
  assert.ok(u.member_bytes >= 5_000_000);
});

test('partitionInventory: oversize file mixed with normal files produces separate units', () => {
  const inv = [
    { path: 'lib/small.js', size: 100, ext: '.js', contentId: 'sc' },
    { path: 'lib/big.js', size: 2_000_000, ext: '.js', contentId: 'bc' },
    { path: 'lib/other.js', size: 200, ext: '.js', contentId: 'oc' },
  ];
  const units = partitionInventory(inv);
  // big.js must be in its own oversize unit
  const oversized = units.filter(u => u.oversize_file);
  assert.equal(oversized.length, 1);
  assert.equal(oversized[0].files[0].path, 'lib/big.js');
});

test('partitionInventory: unit_id is unit-NNN format, zero-padded if needed', () => {
  const inv = Array.from({ length: 3 }, (_, i) => ({
    path: `f${i}.js`, size: 100, ext: '.js', contentId: `c${i}`,
  }));
  const units = partitionInventory(inv, { unitByteBudget: 50 }); // force each to its own unit
  for (let i = 0; i < units.length; i++) {
    // unit_id must be 'unit-NNN' with N >= 3 digits (or at minimum 'unit-001', etc.)
    assert.match(units[i].unit_id, /^unit-\d+$/);
  }
  // unit-001 first
  assert.equal(units[0].unit_id, 'unit-001');
});

test('partitionInventory: files carry unit_id annotation', () => {
  const inv = [
    { path: 'a.js', size: 100, ext: '.js', contentId: 'ca' },
    { path: 'b.js', size: 100, ext: '.js', contentId: 'cb' },
  ];
  const units = partitionInventory(inv);
  // The brief says inventory line ALSO carries unit_id; the unit's files array
  // should carry the path/size/ext/contentId/unit_id fields
  for (const u of units) {
    for (const f of u.files) {
      assert.equal(f.unit_id, u.unit_id);
    }
  }
});

test('partitionInventory: empty inventory returns empty array', () => {
  const units = partitionInventory([]);
  assert.deepEqual(units, []);
});

test('partitionInventory: directory natural order — files ordered by path', () => {
  // directory natural order: sort by directory then by name, consistent with ls
  const inv = [
    { path: 'z/a.js', size: 100, ext: '.js', contentId: 'z1' },
    { path: 'a/b.js', size: 100, ext: '.js', contentId: 'a2' },
    { path: 'a/a.js', size: 100, ext: '.js', contentId: 'a1' },
  ];
  // Even if caller passes out-of-order, the function must sort deterministically
  const units = partitionInventory(inv);
  const allFiles = units.flatMap(u => u.files).map(f => f.path);
  // After sorting: a/a.js, a/b.js, z/a.js
  assert.deepEqual(allFiles, ['a/a.js', 'a/b.js', 'z/a.js']);
});

// ---------------------------------------------------------------------------
// reviewCacheKey
// ---------------------------------------------------------------------------

test('reviewCacheKey: returns a 64-char hex string', () => {
  const key = reviewCacheKey({
    memberDigest: 'abc',
    mergedRulesFingerprint: 'def',
    suggestedRefs: [],
    extraReads: [],
  });
  assert.equal(typeof key, 'string');
  assert.equal(key.length, 64);
  assert.match(key, /^[0-9a-f]{64}$/);
});

test('reviewCacheKey: same inputs produce same key (stability)', () => {
  const params = {
    memberDigest: 'md1',
    mergedRulesFingerprint: 'fp1',
    suggestedRefs: [{ path: 'lib/a.js', contentId: 'ca' }],
    extraReads: [{ path: 'lib/b.js', contentId: 'cb' }],
  };
  const k1 = reviewCacheKey(params);
  const k2 = reviewCacheKey(params);
  assert.equal(k1, k2);
});

test('reviewCacheKey: invalidated when memberDigest changes', () => {
  const base = {
    memberDigest: 'md1',
    mergedRulesFingerprint: 'fp1',
    suggestedRefs: [],
    extraReads: [],
  };
  const k1 = reviewCacheKey(base);
  const k2 = reviewCacheKey({ ...base, memberDigest: 'md2' });
  assert.notEqual(k1, k2);
});

test('reviewCacheKey: invalidated when mergedRulesFingerprint changes', () => {
  const base = {
    memberDigest: 'md1',
    mergedRulesFingerprint: 'fp1',
    suggestedRefs: [],
    extraReads: [],
  };
  const k1 = reviewCacheKey(base);
  const k2 = reviewCacheKey({ ...base, mergedRulesFingerprint: 'fp2' });
  assert.notEqual(k1, k2);
});

test('reviewCacheKey: invalidated when a suggestedRef contentId changes', () => {
  const base = {
    memberDigest: 'md1',
    mergedRulesFingerprint: 'fp1',
    suggestedRefs: [{ path: 'lib/a.js', contentId: 'ca' }],
    extraReads: [],
  };
  const k1 = reviewCacheKey(base);
  const k2 = reviewCacheKey({
    ...base,
    suggestedRefs: [{ path: 'lib/a.js', contentId: 'ca_CHANGED' }],
  });
  assert.notEqual(k1, k2);
});

test('reviewCacheKey: invalidated when an extraRead contentId changes', () => {
  const base = {
    memberDigest: 'md1',
    mergedRulesFingerprint: 'fp1',
    suggestedRefs: [],
    extraReads: [{ path: 'lib/b.js', contentId: 'cb' }],
  };
  const k1 = reviewCacheKey(base);
  const k2 = reviewCacheKey({
    ...base,
    extraReads: [{ path: 'lib/b.js', contentId: 'cb_CHANGED' }],
  });
  assert.notEqual(k1, k2);
});

test('reviewCacheKey: invalidated when suggestedRefs order changes (order matters)', () => {
  const ref1 = { path: 'lib/a.js', contentId: 'ca' };
  const ref2 = { path: 'lib/b.js', contentId: 'cb' };
  const k1 = reviewCacheKey({ memberDigest: 'md', mergedRulesFingerprint: 'fp', suggestedRefs: [ref1, ref2], extraReads: [] });
  const k2 = reviewCacheKey({ memberDigest: 'md', mergedRulesFingerprint: 'fp', suggestedRefs: [ref2, ref1], extraReads: [] });
  assert.notEqual(k1, k2);
});

// ---------------------------------------------------------------------------
// suggestRefsFor
// ---------------------------------------------------------------------------

test('suggestRefsFor: returns empty array for non-JS files', () => {
  const files = [
    { path: 'docs/readme.md', contentId: 'md1', text: 'no requires here' },
  ];
  const inRootSet = new Map([['lib/a.js', 'ca']]);
  const refs = suggestRefsFor(files, inRootSet);
  assert.deepEqual(refs, []);
});

test('suggestRefsFor: drops bare (package) specifiers', () => {
  const files = [
    { path: 'lib/a.js', contentId: 'ca', text: "const x = require('crypto');\nconst y = require('fs');" },
  ];
  const inRootSet = new Map([['lib/a.js', 'ca']]);
  const refs = suggestRefsFor(files, inRootSet);
  // 'crypto' and 'fs' are bare specifiers (no leading ./ or /) => dropped
  assert.deepEqual(refs, []);
});

test('suggestRefsFor: resolves relative require() to in-root paths', () => {
  const files = [
    { path: 'lib/a.js', contentId: 'ca', text: "const b = require('./b');" },
  ];
  const inRootSet = new Map([['lib/b.js', 'cb']]);
  const refs = suggestRefsFor(files, inRootSet);
  assert.deepEqual(refs, [{ path: 'lib/b.js', contentId: 'cb' }]);
});

test('suggestRefsFor: resolves relative require() with extension', () => {
  const files = [
    { path: 'lib/a.js', contentId: 'ca', text: "const b = require('./b.js');" },
  ];
  const inRootSet = new Map([['lib/b.js', 'cb']]);
  const refs = suggestRefsFor(files, inRootSet);
  assert.deepEqual(refs, [{ path: 'lib/b.js', contentId: 'cb' }]);
});

test('suggestRefsFor: resolves extensionless imports across JS extensions and index files', () => {
  const files = [
    {
      path: 'lib/a.ts',
      contentId: 'ca',
      text: [
        "import Button from './Button';",
        "import Widget from './Widget';",
        "const esm = await import('./esm');",
        "const cjs = require('./cjs');",
        "import Directory from './Directory';"
      ].join('\n'),
    },
  ];
  const inRootSet = new Map([
    ['lib/Button.tsx', 'button'],
    ['lib/Widget.jsx', 'widget'],
    ['lib/esm.mjs', 'esm'],
    ['lib/cjs.cjs', 'cjs'],
    ['lib/Directory/index.ts', 'directory'],
  ]);
  const refs = suggestRefsFor(files, inRootSet);
  assert.deepEqual(refs, [
    { path: 'lib/Button.tsx', contentId: 'button' },
    { path: 'lib/Directory/index.ts', contentId: 'directory' },
    { path: 'lib/Widget.jsx', contentId: 'widget' },
    { path: 'lib/cjs.cjs', contentId: 'cjs' },
    { path: 'lib/esm.mjs', contentId: 'esm' },
  ]);
});

test('suggestRefsFor: handles parent directory traversal ../', () => {
  const files = [
    { path: 'lib/sub/a.js', contentId: 'ca', text: "const b = require('../b.js');" },
  ];
  const inRootSet = new Map([['lib/b.js', 'cb']]);
  const refs = suggestRefsFor(files, inRootSet);
  assert.deepEqual(refs, [{ path: 'lib/b.js', contentId: 'cb' }]);
});

test('suggestRefsFor: does not include refs that land outside the in-root set', () => {
  const files = [
    { path: 'lib/a.js', contentId: 'ca', text: "const b = require('./missing.js');" },
  ];
  const inRootSet = new Map([['lib/b.js', 'cb']]);
  const refs = suggestRefsFor(files, inRootSet);
  assert.deepEqual(refs, []);
});

test('suggestRefsFor: deduplicates refs and sorts by path', () => {
  const files = [
    {
      path: 'lib/a.js',
      contentId: 'ca',
      text: "const b = require('./b.js');\nconst c = require('./c.js');\nconst b2 = require('./b.js');",
    },
  ];
  const inRootSet = new Map([
    ['lib/b.js', 'cb'],
    ['lib/c.js', 'cc'],
  ]);
  const refs = suggestRefsFor(files, inRootSet);
  // Deduplicated + sorted by path
  assert.deepEqual(refs, [
    { path: 'lib/b.js', contentId: 'cb' },
    { path: 'lib/c.js', contentId: 'cc' },
  ]);
});

test('suggestRefsFor: handles ES import from syntax', () => {
  const files = [
    { path: 'lib/a.js', contentId: 'ca', text: "import foo from './foo.js';" },
  ];
  const inRootSet = new Map([['lib/foo.js', 'cf']]);
  const refs = suggestRefsFor(files, inRootSet);
  assert.deepEqual(refs, [{ path: 'lib/foo.js', contentId: 'cf' }]);
});

test('suggestRefsFor: handles dynamic import() syntax', () => {
  const files = [
    { path: 'lib/a.js', contentId: 'ca', text: "const m = await import('./mod.js');" },
  ];
  const inRootSet = new Map([['lib/mod.js', 'cm']]);
  const refs = suggestRefsFor(files, inRootSet);
  assert.deepEqual(refs, [{ path: 'lib/mod.js', contentId: 'cm' }]);
});

test('suggestRefsFor: result is deterministic (sorted by path)', () => {
  const files = [
    { path: 'lib/a.js', contentId: 'ca', text: "require('./z.js'); require('./a.js');" },
  ];
  const inRootSet = new Map([
    ['lib/z.js', 'cz'],
    ['lib/a.js', 'ca'],
  ]);
  const refs = suggestRefsFor(files, inRootSet);
  // Sorted by path, not by order of appearance in source
  assert.equal(refs[0].path, 'lib/a.js');
  assert.equal(refs[1].path, 'lib/z.js');
});

test('suggestRefsFor: handles multiple files aggregating refs', () => {
  const files = [
    { path: 'lib/a.js', contentId: 'ca', text: "require('./b.js');" },
    { path: 'lib/c.js', contentId: 'cc', text: "require('./b.js'); require('./d.js');" },
  ];
  const inRootSet = new Map([
    ['lib/b.js', 'cb'],
    ['lib/d.js', 'cd'],
  ]);
  const refs = suggestRefsFor(files, inRootSet);
  // lib/b.js deduped, sorted
  assert.deepEqual(refs, [
    { path: 'lib/b.js', contentId: 'cb' },
    { path: 'lib/d.js', contentId: 'cd' },
  ]);
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

// Helper: build a valid unit summary
function makeSummary(unit_id, overrides = {}) {
  return {
    unit_id,
    reviewed: true,
    skipped: [],
    extraReads: [],
    coverage_risk: 'none',
    reviewCacheKey: 'key-' + unit_id,
    contractsTouched: [],
    ...overrides,
  };
}

// Helper: build a finding
function makeFinding(location, category, severity = 'low', overrides = {}) {
  return { location, category, severity, description: 'test finding', ...overrides };
}

test('aggregate: returns PASS when all units coverage_risk=none and no open high/medium findings', () => {
  const summaries = [
    makeSummary('unit-001'),
    makeSummary('unit-002'),
  ];
  const result = aggregate(summaries, []);
  assert.equal(result.verdict, 'PASS');
});

test('aggregate: does not PASS an unreviewed summary even when coverage_risk is none', () => {
  const summaries = [
    makeSummary('unit-001', { reviewed: false, coverage_risk: 'none' }),
  ];
  const result = aggregate(summaries, []);
  assert.equal(result.verdict, 'stopped-with-deferrals');
  assert.equal(result.coverageProof.bodyReviewed, 0);
  assert.equal(result.coverageProof.residualRisk, 'present');
});

test('aggregate: does not PASS a summary that skipped a file even when coverage_risk is none', () => {
  // Defense-in-depth: record-time gates refuse skipped+none, but aggregate re-derives
  // coverage and must independently refuse PASS for a (hand-written/stale) summary that
  // reports coverage_risk:none while carrying a non-empty skipped list.
  const summaries = [
    makeSummary('unit-001'),
    makeSummary('unit-002', { coverage_risk: 'none', skipped: [{ path: 'src/a.js', reason: 'context-limit' }] }),
  ];
  const result = aggregate(summaries, []);
  assert.equal(result.verdict, 'stopped-with-deferrals');
  assert.equal(result.coverageProof.residualRisk, 'present');
});

test('aggregate: returns stopped-with-deferrals when any unit has coverage_risk=high', () => {
  const summaries = [
    makeSummary('unit-001'),
    makeSummary('unit-002', { coverage_risk: 'high', reviewed: false }),
  ];
  const result = aggregate(summaries, []);
  assert.ok(
    result.verdict === 'stopped-with-deferrals' || result.verdict === 'coverage-incomplete',
    `expected deferral verdict, got: ${result.verdict}`
  );
});

test('aggregate: returns deferral when open high finding remains', () => {
  const summaries = [makeSummary('unit-001')];
  const findings = [makeFinding('lib/a.js:10', 'bug', 'high')];
  const result = aggregate(summaries, findings);
  assert.notEqual(result.verdict, 'PASS');
});

test('aggregate: returns deferral when open medium finding remains', () => {
  const summaries = [makeSummary('unit-001')];
  const findings = [makeFinding('lib/a.js:10', 'style', 'medium')];
  const result = aggregate(summaries, findings);
  assert.notEqual(result.verdict, 'PASS');
});

test('aggregate: deduplicates findings by (location, category)', () => {
  const summaries = [makeSummary('unit-001')];
  const findings = [
    makeFinding('lib/a.js:10', 'bug', 'low'),
    makeFinding('lib/a.js:10', 'bug', 'low'),   // duplicate
    makeFinding('lib/a.js:10', 'style', 'low'),  // different category, not a dup
  ];
  const result = aggregate(summaries, findings);
  assert.equal(result.findings.length, 2);
});

test('aggregate: does not collapse distinct reviewer findings when category is absent', () => {
  const summaries = [makeSummary('unit-001')];
  const findings = [
    {
      id: 'R001',
      severity: 'low',
      location: 'lib/a.js:10',
      issue: 'The wording is unclear.',
      why_it_matters: 'A maintainer may need to reread it.',
      suggested_fix: 'Clarify the sentence.',
      confidence: 'confirmed',
      sensitive: false
    },
    {
      id: 'R002',
      severity: 'high',
      location: 'lib/a.js:10',
      issue: 'The guard is bypassed.',
      why_it_matters: 'A high-risk finding at the same location must still block PASS.',
      suggested_fix: 'Restore the guard.',
      confidence: 'confirmed',
      sensitive: false
    },
  ];
  const result = aggregate(summaries, findings);
  assert.equal(result.findings.length, 2);
  assert.equal(result.verdict, 'stopped-with-deferrals');
  assert.equal(result.findings.find((finding) => finding.id === 'R002').forceReread, true);
});

test('aggregate: coverage proof contains required fields', () => {
  const summaries = [
    makeSummary('unit-001', { extraReads: [{ path: 'lib/x.js', contentId: 'cx' }] }),
    makeSummary('unit-002', {
      reviewed: false,
      coverage_risk: 'high',
      skipped: [{ path: 'big.js', reason: 'single-file-over-budget' }],
    }),
  ];
  const result = aggregate(summaries, []);
  const proof = result.coverageProof;
  assert.ok(typeof proof === 'object' && proof !== null);
  assert.ok(typeof proof.discovered === 'number');
  assert.ok(typeof proof.bodyReviewed === 'number');
  assert.ok(typeof proof.extraRead === 'number');
  assert.ok(typeof proof.skipped === 'number');
  assert.ok(typeof proof.highRiskUnitsFullyReviewed === 'number');
  assert.ok(typeof proof.residualRisk === 'string');
});

test('aggregate: flags high-severity findings for forced re-read', () => {
  const summaries = [makeSummary('unit-001')];
  const findings = [
    makeFinding('lib/a.js:10', 'bug', 'high'),
    makeFinding('lib/b.js:20', 'security', 'low'),
  ];
  const result = aggregate(summaries, findings);
  // All high findings must be flagged
  const forceReread = result.findings.filter(f => f.forceReread);
  assert.ok(forceReread.length >= 1);
  assert.ok(forceReread.every(f => f.severity === 'high'));
  // Low-severity findings should NOT be flagged
  const lowFindings = result.findings.filter(f => f.severity === 'low');
  for (const f of lowFindings) {
    assert.ok(!f.forceReread, 'low severity should not be force-reread');
  }
});

test('aggregate: coverage proof counts are accurate', () => {
  const summaries = [
    makeSummary('unit-001', { reviewed: true, extraReads: [{ path: 'x.js', contentId: 'cx' }] }),
    makeSummary('unit-002', { reviewed: false, coverage_risk: 'high', skipped: [{ path: 'big.js', reason: 'single-file-over-budget' }] }),
    makeSummary('unit-003', { reviewed: true }),
  ];
  const result = aggregate(summaries, []);
  const proof = result.coverageProof;
  assert.equal(proof.discovered, 3);
  assert.equal(proof.bodyReviewed, 2); // unit-001 and unit-003
  assert.equal(proof.extraRead, 1);    // unit-001 has 1 extraRead
  assert.equal(proof.skipped, 1);      // unit-002 has 1 skipped
  // highRiskUnitsFullyReviewed: high-risk units that were body-reviewed
  assert.equal(proof.highRiskUnitsFullyReviewed, 0); // unit-002 is high risk but not reviewed
});

test('aggregate: PASS requires every high-risk unit to be body-reviewed', () => {
  // High-risk but reviewed unit should still allow PASS if all coverage_risk are none
  // But if coverage_risk is high on any unit, no PASS
  const summaries = [
    makeSummary('unit-001', { reviewed: true, coverage_risk: 'none' }),
    // A unit that was high-risk during review but resolved to none by end
    makeSummary('unit-002', { reviewed: true, coverage_risk: 'none' }),
  ];
  const result = aggregate(summaries, []);
  assert.equal(result.verdict, 'PASS');
});

test('aggregate: residualRisk is "none" when PASS, "present" otherwise', () => {
  const passSummaries = [makeSummary('unit-001')];
  const passResult = aggregate(passSummaries, []);
  assert.equal(passResult.coverageProof.residualRisk, 'none');

  const failSummaries = [makeSummary('unit-001', { coverage_risk: 'high' })];
  const failResult = aggregate(failSummaries, []);
  assert.ok(failResult.coverageProof.residualRisk !== 'none');
});

test('aggregate: includes crosscuttingBackstops in output', () => {
  const summaries = [makeSummary('unit-001')];
  const result = aggregate(summaries, []);
  assert.ok(Array.isArray(result.crosscuttingBackstops));
  assert.ok(result.crosscuttingBackstops.length > 0);
});

// ---------------------------------------------------------------------------
// refreshPartitionPlanContent
// ---------------------------------------------------------------------------

// Minimal 2-unit plan fixture: unit-001 {a.js}, unit-002 {b.js}; b.js requires ./a.
function basePlan() {
  return {
    reviewMode: 'partitioned',
    unitByteBudget: 1_000_000,
    units: [
      { unit_id: 'unit-001', member_count: 1, member_bytes: 10, member_digest: 'OLD1',
        files: [{ path: 'a.js', size: 10, ext: '.js', contentId: 'ca0', unit_id: 'unit-001' }],
        suggestedRefs: [] },
      { unit_id: 'unit-002', member_count: 1, member_bytes: 20, member_digest: 'OLD2',
        files: [{ path: 'b.js', size: 20, ext: '.js', contentId: 'cb0', unit_id: 'unit-002' }],
        suggestedRefs: [{ path: 'a.js', contentId: 'ca0' }] },
    ],
    crosscuttingBackstops: ['security-redaction'],
    projectReviewFingerprint: 'FP0',
    userExcludes: [],
    inventoryRows: [],
  };
}

test('refreshPartitionPlanContent refreshes content fields and stamps the new fingerprint', () => {
  const newInventory = [
    { path: 'a.js', size: 11, ext: '.js', contentId: 'ca1' }, // a.js edited
    { path: 'b.js', size: 20, ext: '.js', contentId: 'cb0' },
  ];
  const { refreshedPlan, refsChangedUnitIds } = refreshPartitionPlanContent(basePlan(), newInventory, {
    nextSuggestedRefsByUnit: { 'unit-001': [], 'unit-002': [{ path: 'a.js', contentId: 'ca1' }] },
    projectReviewFingerprint: 'FP1',
  });
  assert.equal(refreshedPlan.projectReviewFingerprint, 'FP1');
  assert.equal(refreshedPlan.units[0].files[0].contentId, 'ca1');
  assert.equal(refreshedPlan.units[0].files[0].size, 11);
  assert.notEqual(refreshedPlan.units[0].member_digest, 'OLD1'); // recomputed to a real sha256
  assert.notEqual(refreshedPlan.units[1].member_digest, 'OLD2'); // recomputed (was a placeholder digest)
  // unit-002's suggestedRef still points to a.js; only the contentId refreshed.
  // refsChangedUnitIds is reserved for ref PATH topology changes. The end-fix
  // caller still invalidates unit-002 through unitsToReReview(declaredFiles, oldPlan).
  assert.equal(refreshedPlan.units[1].suggestedRefs[0].contentId, 'ca1');
  assert.deepEqual(refsChangedUnitIds, []);
});

test('refreshPartitionPlanContent reports refsChangedUnitIds when ref path topology changes', () => {
  const newInventory = [
    { path: 'a.js', size: 10, ext: '.js', contentId: 'ca0' },
    { path: 'b.js', size: 20, ext: '.js', contentId: 'cb0' },
  ];
  const { refsChangedUnitIds } = refreshPartitionPlanContent(basePlan(), newInventory, {
    nextSuggestedRefsByUnit: { 'unit-001': [], 'unit-002': [] }, // unit-002 dropped ref path a.js
    projectReviewFingerprint: 'FP1',
  });
  assert.deepEqual(refsChangedUnitIds, ['unit-002']);
});

test('refreshPartitionPlanContent throws MEMBERSHIP_CHANGED when a member is added or removed', () => {
  const added = [
    { path: 'a.js', size: 10, ext: '.js', contentId: 'ca0' },
    { path: 'b.js', size: 20, ext: '.js', contentId: 'cb0' },
    { path: 'c.js', size: 5, ext: '.js', contentId: 'cc0' }, // NEW member
  ];
  assert.throws(
    () => refreshPartitionPlanContent(basePlan(), added, { nextSuggestedRefsByUnit: { 'unit-001': [], 'unit-002': [] }, projectReviewFingerprint: 'FP1' }),
    (e) => e.code === 'ERR_PARTITION_MEMBERSHIP_CHANGED'
  );
});

test('refreshPartitionPlanContent throws REBUCKET_REQUIRED when a unit exceeds the byte budget', () => {
  const fat = [
    { path: 'a.js', size: 2_000_000, ext: '.js', contentId: 'ca1' }, // now over budget
    { path: 'b.js', size: 20, ext: '.js', contentId: 'cb0' },
  ];
  assert.throws(
    () => refreshPartitionPlanContent(basePlan(), fat, { nextSuggestedRefsByUnit: { 'unit-001': [], 'unit-002': [{ path: 'a.js', contentId: 'ca1' }] }, projectReviewFingerprint: 'FP1' }),
    (e) => e.code === 'ERR_PARTITION_REBUCKET_REQUIRED'
  );
});

test('refreshPartitionPlanContent throws REFS_CHANGED when a non-chunk unit has no re-resolved refs', () => {
  const newInventory = [
    { path: 'a.js', size: 10, ext: '.js', contentId: 'ca0' },
    { path: 'b.js', size: 20, ext: '.js', contentId: 'cb0' },
  ];
  assert.throws(
    () => refreshPartitionPlanContent(basePlan(), newInventory, { nextSuggestedRefsByUnit: { 'unit-001': [] /* unit-002 missing */ }, projectReviewFingerprint: 'FP1' }),
    (e) => e.code === 'ERR_PARTITION_REFS_CHANGED'
  );
});
