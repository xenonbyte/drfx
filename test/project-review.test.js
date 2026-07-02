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
const os = require('node:os');
const fs = require('node:fs');
const pathMod = require('node:path');

const {
  partitionInventory,
  suggestRefsFor,
  reviewCacheKey,
  aggregate,
  dedupChunkFindings,
  refreshPartitionPlanContent,
  computeOversizeChunks,
  CROSSCUTTING_BACKSTOPS,
  MAX_UNIT_BYTES,
  CONTRACT_READ_BUDGET,
} = require('../lib/project-review');

const { assemblePartitionPlan, splitOversizeFile } = require('../lib/workflow/file-set-context');

const {
  invalidateUnitReviews,
  invalidateAllBackstopReviews,
  CROSSCUTTING_BACKSTOPS: BACKSTOPS_FOR_TEST,
} = require('../lib/workflow/file-set-unit-review');

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

test('computeOversizeChunks splits by line window with overlap, deterministically', () => {
  const text = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const chunks = computeOversizeChunks({ text, chunkLines: 400, overlapLines: 20, chunkByteBudget: 1_000_000 });
  assert.ok(Array.isArray(chunks) && chunks.length >= 2);
  assert.deepEqual(chunks[0].primaryLineRange, [1, 400]);
  // bidirectional overlap: chunk 1's context extends 20 lines after its primary;
  // chunk 2's context starts 20 lines before its primary start.
  assert.equal(chunks[0].contextLineRange[1], 420);
  assert.equal(chunks[1].primaryLineRange[0], 401);
  assert.equal(chunks[1].contextLineRange[0], 381);
  // every chunk's context slice is within budget.
  for (const c of chunks) assert.ok(c.byteLength <= 1_000_000);
  // determinism.
  const again = computeOversizeChunks({ text, chunkLines: 400, overlapLines: 20, chunkByteBudget: 1_000_000 });
  assert.deepEqual(again.map((c) => c.primaryLineRange), chunks.map((c) => c.primaryLineRange));
});

test('computeOversizeChunks shrinks context overlap to honor the byte budget', () => {
  // Build text whose 400-line primary is ~960KB and whose full bidirectional
  // 40-line overlap would push the context slice over 1MB unless overlap shrinks.
  const big = 'x'.repeat(2400);
  const text = Array.from({ length: 800 }, () => big).join('\n') + '\n';
  const chunks = computeOversizeChunks({ text, chunkLines: 400, overlapLines: 40, chunkByteBudget: 1_000_000 });
  assert.ok(chunks.every((c) => c.byteLength <= 1_000_000));
});

test('computeOversizeChunks ignores the synthetic split entry from a terminal newline', () => {
  const text = Array.from({ length: 1600 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const chunks = computeOversizeChunks({ text, chunkLines: 800, overlapLines: 0, chunkByteBudget: 1_000_000 });

  assert.deepEqual(chunks.map((chunk) => chunk.primaryLineRange), [
    [1, 800],
    [801, 1600],
  ]);
  assert.equal(chunks.at(-1).sliceText.endsWith('\n'), true, 'final chunk still preserves the terminal newline');
});

test('computeOversizeChunks does not charge a newline to the final unterminated line', () => {
  const finalLine = 'x'.repeat(10);
  const chunks = computeOversizeChunks({ text: `a\n${finalLine}`, chunkLines: 1, overlapLines: 0, chunkByteBudget: 10 });

  assert.notEqual(chunks, null);
  assert.deepEqual(chunks.map((chunk) => chunk.primaryLineRange), [
    [1, 1],
    [2, 2],
  ]);
  assert.equal(chunks[1].byteLength, 10);
  assert.equal(chunks[1].sliceText, finalLine);
});

test('computeOversizeChunks returns null when a single line exceeds the byte budget', () => {
  const text = 'a'.repeat(2_000_000) + '\nshort\n';
  assert.equal(computeOversizeChunks({ text, chunkLines: 400, overlapLines: 40, chunkByteBudget: 1_000_000 }), null);
});

test('computeOversizeChunks returns null as soon as the chunk count cap is exceeded', () => {
  const text = Array.from({ length: 81 }, () => 'x').join('\n') + '\n';

  assert.equal(
    computeOversizeChunks({
      text,
      chunkLines: 10,
      overlapLines: 0,
      chunkByteBudget: 1_000_000,
      maxChunks: 8,
    }),
    null
  );
});

test('splitOversizeFile: files beyond the chunkable byte cap stay legacy oversize blockers', () => {
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-chunk-cap-'));
  try {
    const fileName = 'huge.js';
    const line = 'x'.repeat(80);
    const text = Array.from({ length: 120 }, () => line).join('\n') + '\n';
    fs.writeFileSync(pathMod.join(root, fileName), text);

    const chunks = splitOversizeFile({
      projectRoot: root,
      file: {
        path: fileName,
        size: Buffer.byteLength(text, 'utf8'),
        contentId: 'huge-content',
      },
      chunkLines: 20,
      overlapLines: 2,
      chunkByteBudget: 1_000,
    });

    assert.equal(chunks, null, 'oversize text above the chunkable cap must not be fully materialized');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('splitOversizeFile: files requiring too many chunks stay legacy oversize blockers', () => {
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-chunk-count-cap-'));
  try {
    const fileName = 'tiny-lines.js';
    const text = Array.from({ length: 81 }, () => 'x').join('\n') + '\n';
    fs.writeFileSync(pathMod.join(root, fileName), text);

    const chunks = splitOversizeFile({
      projectRoot: root,
      file: {
        path: fileName,
        size: Buffer.byteLength(text, 'utf8'),
        contentId: 'tiny-lines-content',
      },
      chunkLines: 10,
      overlapLines: 0,
      chunkByteBudget: 100,
    });

    assert.equal(chunks, null, 'oversize text requiring a ninth chunk must not expand into unbounded units');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
// dedupChunkFindings (Task 16): chunk-aware overlap dedup for the partitioned
// aggregate path. Two adjacent chunks share a bidirectional overlap region, so
// the same defect can be reported twice (once by each chunk). The owner is the
// chunk whose primaryLineRange CONTAINS the reported line; an overlap report from
// either adjacent chunk canonicalizes to that owner's primary range in the key.
// LOAD-BEARING SAFETY: a finding with a missing/unparsable location is NEVER
// dropped — it is kept under the reporting chunk's own primary range.
// ---------------------------------------------------------------------------

// Two chunks of one oversize file, modeling bidirectional overlap:
//   chunk 1: primary [1,10],  context [1,13]  (forward overlap covers lines 11-13)
//   chunk 2: primary [11,20], context [8,20]  (backward overlap covers lines 8-10)
// Owner of line 11 is chunk 2 (its primary contains 11). A finding reported by
// chunk 1 against line 11 (its forward overlap) and one reported by chunk 2 against
// line 11 (its primary) both canonicalize to chunk 2's owner primary range.
function chunkPlanUnits() {
  return [
    {
      unit_id: 'unit-001',
      oversize_chunk: true,
      sourcePath: 'big.js',
      sourceContentId: 'srcCID',
      chunkIndex: 0,
      chunkCount: 2,
      files: [{ path: 'big.js', primaryLineRange: [1, 10], contextLineRange: [1, 13], size: 100, contentId: 'c0', unit_id: 'unit-001' }],
    },
    {
      unit_id: 'unit-002',
      oversize_chunk: true,
      sourcePath: 'big.js',
      sourceContentId: 'srcCID',
      chunkIndex: 1,
      chunkCount: 2,
      files: [{ path: 'big.js', primaryLineRange: [11, 20], contextLineRange: [8, 20], size: 100, contentId: 'c1', unit_id: 'unit-002' }],
    },
  ];
}

test('dedupChunkFindings: collapses an overlap duplicate reported by both adjacent chunks', () => {
  const units = chunkPlanUnits();
  // Both findings describe the SAME defect at line 11: chunk 1 reports it against its
  // forward overlap (line 11 sits in chunk 1's context), chunk 2 reports it against its
  // own primary (line 11 is in chunk 2's primary). Same path + severity + normalized text.
  const findings = [
    makeFinding('big.js:11', 'bug', 'high', { issue: 'Null   pointer DEREFERENCE here.' }),
    makeFinding('big.js:L11', 'bug', 'high', { issue: 'null pointer dereference here.' }),
  ];
  const deduped = dedupChunkFindings(findings, units);
  assert.equal(deduped.length, 1, 'overlap duplicate must collapse to ONE finding');
});

test('dedupChunkFindings: keeps genuinely different findings distinct', () => {
  const units = chunkPlanUnits();
  // Same owner line, but different normalized issue text => two distinct defects.
  const findings = [
    makeFinding('big.js:11', 'bug', 'high', { issue: 'Null pointer dereference.' }),
    makeFinding('big.js:11', 'bug', 'high', { issue: 'Off-by-one loop bound.' }),
  ];
  const deduped = dedupChunkFindings(findings, units);
  assert.equal(deduped.length, 2, 'different defects at the same line must NOT collapse');
});

test('dedupChunkFindings: keeps same-class findings on different lines in one chunk distinct', () => {
  const units = chunkPlanUnits();
  const findings = [
    makeFinding('big.js:12', 'bug', 'high', { issue: 'Repeated defect.', suggested_fix: 'Fix the repeated defect.' }),
    makeFinding('big.js:13', 'bug', 'high', { issue: 'Repeated defect.', suggested_fix: 'Fix the repeated defect.' }),
  ];
  const deduped = dedupChunkFindings(findings, units);
  assert.equal(deduped.length, 2, 'same issue class at different lines must remain two findings');
});

test('dedupChunkFindings: NEVER drops a finding with an unparsable location', () => {
  const units = chunkPlanUnits();
  const findings = [
    makeFinding('big.js:11', 'bug', 'high', { issue: 'Real overlap defect.', id: 'R001' }),
    // Garbage / missing line anchor: cannot be parsed into <path>:<line>. The unparsed
    // overlap heuristic MUST NOT erase it — keeping it ensures PASS is never earned by
    // silently discarding a real finding.
    makeFinding('not-a-real-location', 'bug', 'high', { issue: 'Real overlap defect.', id: 'R002' }),
    makeFinding('', 'security', 'high', { issue: 'Hardcoded secret somewhere.', id: 'R003' }),
  ];
  const deduped = dedupChunkFindings(findings, units);
  const ids = deduped.map((f) => f.id).sort();
  assert.ok(ids.includes('R002'), 'a finding with a garbage location must be RETAINED, never dropped');
  assert.ok(ids.includes('R003'), 'a finding with a missing location must be RETAINED, never dropped');
  assert.equal(deduped.length, 3, 'no parseable-line match means no collapse; every finding survives');
});

test('dedupChunkFindings: non-chunk units leave findings byte-unchanged (identity passthrough)', () => {
  // Guard: when no unit is an oversize_chunk, the function must return the findings
  // untouched so non-chunk aggregation stays exactly as today.
  const nonChunkUnits = [
    { unit_id: 'unit-001', files: [{ path: 'a.js', size: 10, ext: '.js', contentId: 'ca' }] },
  ];
  const findings = [
    makeFinding('a.js:10', 'bug', 'low', { issue: 'one' }),
    makeFinding('a.js:10', 'bug', 'low', { issue: 'one' }),
  ];
  const deduped = dedupChunkFindings(findings, nonChunkUnits);
  assert.strictEqual(deduped, findings, 'no chunk units => exact same array reference, no normalization');
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

// ---------------------------------------------------------------------------
// refreshPartitionPlanContent — oversize_chunk unit (Task 17)
// ---------------------------------------------------------------------------

// Plan with one oversize_chunk unit (big.js) + one normal unit (a.js).
// Chunk unit shape mirrors what splitOversizeFile/assemblePartitionPlan produce.
function chunkBasePlan() {
  return {
    reviewMode: 'partitioned',
    unitByteBudget: 1_000_000,
    units: [
      {
        unit_id: 'unit-001',
        oversize_chunk: true,
        sourcePath: 'big.js',
        sourceContentId: 'B0',
        chunkIndex: 0,
        chunkCount: 1,
        files: [{ path: 'big.js', primaryLineRange: [1, 800], contextLineRange: [1, 820], size: 123, contentId: 'CHUNK_CID_0' }],
        member_count: 1,
        member_bytes: 123,
        member_digest: 'MD0',
        suggestedRefs: [],
      },
      {
        unit_id: 'unit-002',
        member_count: 1,
        member_bytes: 10,
        member_digest: 'OLD',
        files: [{ path: 'a.js', size: 10, ext: '.js', contentId: 'ca0', unit_id: 'unit-002' }],
        suggestedRefs: [],
      },
    ],
    crosscuttingBackstops: ['security-redaction'],
    projectReviewFingerprint: 'FP0',
    userExcludes: [],
    inventoryRows: [],
  };
}

test('refreshPartitionPlanContent keeps chunk units intact when the parent content is unchanged', () => {
  // a.js edited; big.js content UNCHANGED (sourceContentId still 'B0').
  const newInventory = [
    { path: 'a.js', size: 11, ext: '.js', contentId: 'ca1' },
    { path: 'big.js', size: 123, ext: '.js', contentId: 'B0' },
  ];
  // Chunk unit (unit-001) must NOT appear in nextSuggestedRefsByUnit — it is
  // skipped before the refs-contract check. Supply refs only for the normal unit.
  const { refreshedPlan } = refreshPartitionPlanContent(chunkBasePlan(), newInventory, {
    nextSuggestedRefsByUnit: { 'unit-002': [] },
    projectReviewFingerprint: 'FP1',
  });

  const chunkUnit = refreshedPlan.units.find((u) => u.unit_id === 'unit-001');
  // Chunk contentId must be preserved (not overwritten by the file-level 'B0').
  assert.strictEqual(chunkUnit.files[0].contentId, 'CHUNK_CID_0', 'chunk files[0].contentId must be preserved');
  // member_digest must be preserved.
  assert.strictEqual(chunkUnit.member_digest, 'MD0', 'chunk member_digest must be preserved');

  // inventoryRows: big.js appears exactly once and maps to the chunk unit_id.
  const bigJsRows = refreshedPlan.inventoryRows.filter((r) => r.path === 'big.js');
  assert.strictEqual(bigJsRows.length, 1, 'big.js must appear exactly once in inventoryRows');
  assert.strictEqual(bigJsRows[0].unit_id, 'unit-001', 'inventoryRows big.js must map to chunk unit_id');
  // The file-level contentId from inventory is preserved in inventoryRows.
  assert.strictEqual(bigJsRows[0].contentId, 'B0', 'inventoryRows big.js contentId must be the file-level one');
});

test('refreshPartitionPlanContent refreshes oversize chunks when the parent content changed', () => {
  // big.js content changed from 'B0' to 'B1'. The workflow layer has already
  // re-split the file and passes those new chunk units into this pure refresh.
  const newInventory = [
    { path: 'a.js', size: 10, ext: '.js', contentId: 'ca0' },
    { path: 'big.js', size: 200, ext: '.js', contentId: 'B1' },
  ];
  const nextChunks = [
    {
      oversize_chunk: true,
      sourcePath: 'big.js',
      sourceContentId: 'B1',
      chunkIndex: 0,
      chunkCount: 2,
      files: [{ path: 'big.js', primaryLineRange: [1, 100], contextLineRange: [1, 110], size: 100, contentId: 'CHUNK_CID_1A' }],
      member_count: 1,
      member_bytes: 100,
      member_digest: 'NEXT0',
      suggestedRefs: [],
    },
    {
      oversize_chunk: true,
      sourcePath: 'big.js',
      sourceContentId: 'B1',
      chunkIndex: 1,
      chunkCount: 2,
      files: [{ path: 'big.js', primaryLineRange: [101, 200], contextLineRange: [91, 200], size: 100, contentId: 'CHUNK_CID_1B' }],
      member_count: 1,
      member_bytes: 100,
      member_digest: 'NEXT1',
      suggestedRefs: [],
    },
  ];

  const { refreshedPlan } = refreshPartitionPlanContent(chunkBasePlan(), newInventory, {
    nextSuggestedRefsByUnit: { 'unit-002': [] },
    nextOversizeChunksByPath: new Map([['big.js', nextChunks]]),
    projectReviewFingerprint: 'FP1',
  });

  const chunkUnits = refreshedPlan.units.filter((unit) => unit.oversize_chunk === true);
  assert.deepEqual(chunkUnits.map((unit) => unit.unit_id), ['unit-001', 'unit-003']);
  assert.deepEqual(chunkUnits.map((unit) => unit.sourceContentId), ['B1', 'B1']);
  assert.deepEqual(chunkUnits.map((unit) => unit.chunkCount), [2, 2]);
  assert.equal(chunkUnits[0].files[0].unit_id, 'unit-001');
  assert.equal(chunkUnits[1].files[0].unit_id, 'unit-003');
  assert.equal(refreshedPlan.units.find((unit) => unit.files.some((file) => file.path === 'a.js')).unit_id, 'unit-002');

  const bigJsRows = refreshedPlan.inventoryRows.filter((row) => row.path === 'big.js');
  assert.equal(bigJsRows.length, 1);
  assert.equal(bigJsRows[0].contentId, 'B1');
  assert.equal(bigJsRows[0].unit_id, 'unit-001');
});

test('refreshPartitionPlanContent converts a changed legacy oversize blocker into chunk units when re-split succeeds', () => {
  const oldPlan = {
    reviewMode: 'partitioned',
    unitByteBudget: 1_000_000,
    units: [
      {
        unit_id: 'unit-001',
        oversize_file: true,
        member_count: 1,
        member_bytes: 1_500_000,
        member_digest: 'OLD_BIG',
        files: [{ path: 'big.js', size: 1_500_000, ext: '.js', contentId: 'B0', unit_id: 'unit-001' }],
        suggestedRefs: [],
      },
      {
        unit_id: 'unit-002',
        member_count: 1,
        member_bytes: 10,
        member_digest: 'OLD_A',
        files: [{ path: 'a.js', size: 10, ext: '.js', contentId: 'ca0', unit_id: 'unit-002' }],
        suggestedRefs: [],
      },
    ],
    crosscuttingBackstops: ['security-redaction'],
    projectReviewFingerprint: 'FP0',
    userExcludes: [],
    inventoryRows: [],
  };
  const newInventory = [
    { path: 'a.js', size: 10, ext: '.js', contentId: 'ca0' },
    { path: 'big.js', size: 1_600_000, ext: '.js', contentId: 'B1' },
  ];
  const nextChunks = [
    {
      oversize_chunk: true,
      sourcePath: 'big.js',
      sourceContentId: 'B1',
      chunkIndex: 0,
      chunkCount: 2,
      files: [{ path: 'big.js', primaryLineRange: [1, 800], contextLineRange: [1, 820], size: 900_000, contentId: 'CHUNK_CID_1A' }],
      member_count: 1,
      member_bytes: 900_000,
      member_digest: 'NEXT0',
      suggestedRefs: [],
    },
    {
      oversize_chunk: true,
      sourcePath: 'big.js',
      sourceContentId: 'B1',
      chunkIndex: 1,
      chunkCount: 2,
      files: [{ path: 'big.js', primaryLineRange: [801, 1600], contextLineRange: [781, 1600], size: 700_000, contentId: 'CHUNK_CID_1B' }],
      member_count: 1,
      member_bytes: 700_000,
      member_digest: 'NEXT1',
      suggestedRefs: [],
    },
  ];

  const { refreshedPlan } = refreshPartitionPlanContent(oldPlan, newInventory, {
    nextSuggestedRefsByUnit: { 'unit-002': [] },
    nextOversizeChunksByPath: new Map([['big.js', nextChunks]]),
    projectReviewFingerprint: 'FP1',
  });

  assert.equal(refreshedPlan.units.some((unit) => unit.oversize_file === true), false);
  const chunkUnits = refreshedPlan.units.filter((unit) => unit.oversize_chunk === true);
  assert.deepEqual(chunkUnits.map((unit) => unit.unit_id), ['unit-001', 'unit-003']);
  assert.deepEqual(chunkUnits.map((unit) => unit.sourceContentId), ['B1', 'B1']);
  assert.deepEqual(chunkUnits.map((unit) => unit.chunkCount), [2, 2]);
  assert.equal(chunkUnits[0].files[0].unit_id, 'unit-001');
  assert.equal(chunkUnits[1].files[0].unit_id, 'unit-003');
  assert.equal(refreshedPlan.units.find((unit) => unit.files.some((file) => file.path === 'a.js')).unit_id, 'unit-002');

  const bigJsRows = refreshedPlan.inventoryRows.filter((row) => row.path === 'big.js');
  assert.equal(bigJsRows.length, 1);
  assert.equal(bigJsRows[0].contentId, 'B1');
  assert.equal(bigJsRows[0].unit_id, 'unit-001');
});

// ---------------------------------------------------------------------------
// invalidateUnitReviews / invalidateAllBackstopReviews
// ---------------------------------------------------------------------------

function tmpTargetWithReviews(t) {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-inval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pr = pathMod.join(dir, 'project-review');
  fs.mkdirSync(pathMod.join(pr, 'summaries'), { recursive: true });
  fs.mkdirSync(pathMod.join(pr, 'findings'), { recursive: true });
  for (const id of ['unit-001', 'unit-002', 'backstop-security-redaction']) {
    fs.writeFileSync(pathMod.join(pr, 'summaries', `${id}.json`), '{}\n');
    fs.writeFileSync(pathMod.join(pr, 'findings', `${id}.json`), '{}\n');
  }
  return dir;
}

test('invalidateUnitReviews removes summary+findings for the named units only', (t) => {
  const dir = tmpTargetWithReviews(t);
  const removed = invalidateUnitReviews(dir, ['unit-001']);
  assert.deepEqual(removed, ['unit-001']);
  assert.ok(!fs.existsSync(pathMod.join(dir, 'project-review', 'summaries', 'unit-001.json')));
  assert.ok(!fs.existsSync(pathMod.join(dir, 'project-review', 'findings', 'unit-001.json')));
  assert.ok(fs.existsSync(pathMod.join(dir, 'project-review', 'summaries', 'unit-002.json')));
});

test('invalidateAllBackstopReviews clears every backstop summary+findings', (t) => {
  // Build a tmp dir with fixtures for EVERY backstop in CROSSCUTTING_BACKSTOPS.
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-inval-all-backstops-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pr = pathMod.join(dir, 'project-review');
  fs.mkdirSync(pathMod.join(pr, 'summaries'), { recursive: true });
  fs.mkdirSync(pathMod.join(pr, 'findings'), { recursive: true });
  for (const backstop of BACKSTOPS_FOR_TEST) {
    const backstopId = `backstop-${backstop}`;
    fs.writeFileSync(pathMod.join(pr, 'summaries', `${backstopId}.json`), '{}\n');
    fs.writeFileSync(pathMod.join(pr, 'findings', `${backstopId}.json`), '{}\n');
  }
  const cleared = invalidateAllBackstopReviews(dir);
  // Assert: returned list is sorted and matches every backstop.
  assert.deepEqual(cleared, [...BACKSTOPS_FOR_TEST].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  // Assert: for every backstop, both summary and findings files are gone.
  for (const backstop of BACKSTOPS_FOR_TEST) {
    const backstopId = `backstop-${backstop}`;
    assert.ok(
      !fs.existsSync(pathMod.join(dir, 'project-review', 'summaries', `${backstopId}.json`)),
      `summary file for ${backstopId} should not exist`
    );
    assert.ok(
      !fs.existsSync(pathMod.join(dir, 'project-review', 'findings', `${backstopId}.json`)),
      `findings file for ${backstopId} should not exist`
    );
  }
});

test('invalidateUnitReviews fails loudly when a review artifact cannot be removed', (t) => {
  const dir = tmpTargetWithReviews(t);
  const badPath = pathMod.join(dir, 'project-review', 'summaries', 'unit-001.json');
  fs.rmSync(badPath);
  fs.mkdirSync(badPath);
  fs.writeFileSync(pathMod.join(badPath, 'nested'), '{}\n');
  assert.throws(() => invalidateUnitReviews(dir, ['unit-001']));
});

// --- splitOversizeFile ---

test('splitOversizeFile expands a text oversize file into chunk-units with stable contentIds', () => {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-split-'));
  const body = Array.from({ length: 1200 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(pathMod.join(dir, 'big.js'), body);
  const file = { path: 'big.js', size: Buffer.byteLength(body), ext: '.js', contentId: 'srcCID' };
  const chunks = splitOversizeFile({ projectRoot: dir, file, chunkLines: 500, overlapLines: 20, chunkByteBudget: 1_000_000 });
  assert.ok(Array.isArray(chunks) && chunks.length >= 2);
  assert.ok(chunks.every((c) => c.oversize_chunk === true && c.sourcePath === 'big.js' && c.sourceContentId === 'srcCID'));
  assert.equal(chunks[0].files[0].path, 'big.js');
  assert.equal(chunks[0].chunkCount, chunks.length);
  // member_digest = sha256(chunkContentId); distinct per chunk.
  assert.notEqual(chunks[0].member_digest, chunks[1].member_digest);
});

test('splitOversizeFile returns null for an unsplittable (single huge line) file', () => {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-split2-'));
  fs.writeFileSync(pathMod.join(dir, 'min.js'), 'a'.repeat(2_000_000) + '\n');
  const file = { path: 'min.js', size: 2_000_001, ext: '.js', contentId: 'cid' };
  assert.equal(splitOversizeFile({ projectRoot: dir, file, chunkByteBudget: 1_000_000 }), null);
});

// --- assemblePartitionPlan (Task 13) ---

test('assemblePartitionPlan expands a splittable oversize file into chunk units, inventoryRows stay file-level', () => {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'drfx-assemble-'));
  const big = Array.from({ length: 1500 }, (_, i) => `let v${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(pathMod.join(dir, 'big.js'), big);
  fs.writeFileSync(pathMod.join(dir, 'small.js'), 'module.exports = 1;\n');
  const inventory = [
    { path: 'big.js', size: 1_200_000, ext: '.js', contentId: 'bigCID' }, // > MAX_UNIT_BYTES
    { path: 'small.js', size: 20, ext: '.js', contentId: 'smallCID' },
  ];
  const plan = assemblePartitionPlan({ inventory, projectReviewFingerprint: 'FP', projectRoot: dir });
  const chunkUnits = plan.units.filter((u) => u.oversize_chunk === true);
  assert.ok(chunkUnits.length >= 2, 'big.js expanded into chunks');
  assert.ok(!plan.units.some((u) => u.oversize_file === true), 'no legacy oversize unit remains');
  // unit_ids are contiguous unit-NNN.
  assert.ok(plan.units.every((u) => /^unit-\d{3,}$/.test(u.unit_id)));
  // inventoryRows: big.js appears EXACTLY once (file-level), not once per chunk.
  const bigRows = plan.inventoryRows.filter((r) => r.path === 'big.js');
  assert.equal(bigRows.length, 1);
  assert.equal(bigRows[0].contentId, 'bigCID'); // file-level contentId preserved
});
