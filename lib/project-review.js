'use strict';

// lib/project-review.js — PLAN-TASK-001: deterministic project-review core.
//
// Pure, side-effect-free functions for partitioned project review.
// No I/O, no filesystem access, no CLI wiring. Data in, data out.
//
// Design decisions (documented per task brief):
//
//   member_digest: sha256 over the unit's member contentIds in file order,
//   joined with '\0'. This gives a stable digest: same file set in same order
//   => identical digest; any addition/removal/reorder changes it.
//
//   partitionInventory return shape: array of unit objects matching SPEC-DATA-001
//   units[] field shapes:
//     { unit_id, member_count, member_bytes, member_digest,
//       files: [{path, size, ext, contentId, unit_id}],
//       suggestedRefs: [],          // populated by caller after suggestRefsFor()
//       oversize_file?: true }
//   NOTE: suggestedRefs is initialised to [] here; the caller (task 002/003)
//   will run suggestRefsFor() and fill it in before writing units.json.
//
//   aggregate coverage proof object fields match SPEC-BEHAVIOR-005 prose:
//     { discovered, bodyReviewed, extraRead, skipped,
//       highRiskUnitsFullyReviewed, residualRisk }
//   where residualRisk is 'none' | 'present'.
//
//   aggregate verdict: 'PASS' | 'stopped-with-deferrals'
//
//   findings in aggregate output carry an extra boolean `forceReread` flag:
//   true for high/P0/P1 severity findings; the model does the actual re-read.

const crypto = require('node:crypto');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Binding constants (SPEC-CONFIG-001)
// ---------------------------------------------------------------------------

const MAX_UNIT_BYTES = 1_000_000;
const CONTRACT_READ_BUDGET = 500_000;

// Normative fixed backstop list (SPEC-BEHAVIOR-005, inlined from DESIGN §5).
const CROSSCUTTING_BACKSTOPS = [
  'security-redaction',
  'state-machine-invariant',
  'install-uninstall-fs-safety',
  'cli-parser-template-consistency',
  'cross-platform-symlink',
  'tests-fixtures',
  'public-contract-backcompat',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 over a string, returning lowercase hex.
 * @param {string} text
 * @returns {string}
 */
function sha256hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Format a 1-based index as a zero-padded unit-id string of at least 3 digits.
 * e.g. 1 => 'unit-001', 12 => 'unit-012', 1000 => 'unit-1000'
 * @param {number} n
 * @returns {string}
 */
function formatUnitId(n) {
  return 'unit-' + String(n).padStart(3, '0');
}

/**
 * Directory-natural order comparator: sort by directory path first, then by
 * basename. Both components are compared lexicographically, which matches
 * the "ls" natural order within a directory tree.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function dirNaturalOrder(a, b) {
  // Simple lexicographic sort on the full posix path is equivalent to
  // directory-natural order (siblings in the same dir compare by name;
  // dirs sort before their children when no trailing slash, and before
  // peers with a deeper nesting that starts after their segment).
  // This gives deterministic, byte-identical output for identical inputs.
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Compute member_digest: sha256 over the unit's member contentIds in file
 * order, joined with NUL bytes for clear field separation.
 * @param {Array<{contentId: string}>} files
 * @returns {string} lowercase hex sha256
 */
function computeMemberDigest(files) {
  const input = files.map(f => f.contentId).join('\0');
  return sha256hex(input);
}

// ---------------------------------------------------------------------------
// partitionInventory (SPEC-BEHAVIOR-002)
// ---------------------------------------------------------------------------

/**
 * Bin-pack inventory files into review units in directory-natural order.
 * Never splits a file. Files larger than unitByteBudget become their own
 * single-member unit with oversize_file:true.
 *
 * @param {Array<{path: string, size: number, ext: string, contentId: string}>} inventory
 * @param {{ unitByteBudget?: number }} [options]
 * @returns {Array<{
 *   unit_id: string,
 *   member_count: number,
 *   member_bytes: number,
 *   member_digest: string,
 *   files: Array<{path:string, size:number, ext:string, contentId:string, unit_id:string}>,
 *   suggestedRefs: Array<{path:string, contentId:string}>,
 *   oversize_file?: true
 * }>}
 */
function partitionInventory(inventory, { unitByteBudget = MAX_UNIT_BYTES } = {}) {
  if (inventory.length === 0) return [];

  // Step 1: sort into directory-natural order for determinism.
  const sorted = inventory.slice().sort((a, b) => dirNaturalOrder(a.path, b.path));

  // Step 2: bin-pack with a greedy first-fit pass.
  // Oversize files (size > budget) get their own unit immediately.
  const bins = []; // each bin: { files: [...], bytes: number }

  for (const file of sorted) {
    if (file.size > unitByteBudget) {
      // Oversize: own bin, flagged separately
      bins.push({ files: [file], bytes: file.size, oversize: true });
      continue;
    }
    // Try to fit into the current last bin (greedy)
    let placed = false;
    if (bins.length > 0) {
      const last = bins[bins.length - 1];
      if (!last.oversize && last.bytes + file.size <= unitByteBudget) {
        last.files.push(file);
        last.bytes += file.size;
        placed = true;
      }
    }
    if (!placed) {
      bins.push({ files: [file], bytes: file.size, oversize: false });
    }
  }

  // Step 3: convert bins to unit objects.
  return bins.map((bin, idx) => {
    const unit_id = formatUnitId(idx + 1);
    const filesWithId = bin.files.map(f => ({
      path: f.path,
      size: f.size,
      ext: f.ext,
      contentId: f.contentId,
      unit_id,
    }));
    const unit = {
      unit_id,
      member_count: filesWithId.length,
      member_bytes: bin.bytes,
      member_digest: computeMemberDigest(filesWithId),
      files: filesWithId,
      suggestedRefs: [],
    };
    if (bin.oversize) {
      unit.oversize_file = true;
    }
    return unit;
  });
}

// ---------------------------------------------------------------------------
// suggestRefsFor (deterministic regex-only import resolution)
// ---------------------------------------------------------------------------

// Patterns to extract specifiers from CommonJS require() and ESM import.
// Single-quoted, double-quoted, and backtick-quoted variants are captured.
// Backtick (template literal) specifiers are excluded — they are never plain
// static specifiers and must not be followed up.
const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const IMPORT_FROM_RE = /\bimport\s+(?:[^'"]+\s+from\s+)?(['"])([^'"]+)\1/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

// JS/TS file extensions that may contain require/import statements.
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

function resolveInRootImport(resolved, inRootSet) {
  let contentId = inRootSet.get(resolved);
  if (contentId !== undefined) return { path: resolved, contentId };
  for (const ext of JS_EXTENSIONS) {
    const candidate = resolved + ext;
    contentId = inRootSet.get(candidate);
    if (contentId !== undefined) return { path: candidate, contentId };
  }
  for (const ext of JS_EXTENSIONS) {
    const candidate = `${resolved}/index${ext}`;
    contentId = inRootSet.get(candidate);
    if (contentId !== undefined) return { path: candidate, contentId };
  }
  return null;
}

function findingDedupKey(finding) {
  if (!finding || typeof finding !== 'object') return JSON.stringify(finding);
  return JSON.stringify(
    Object.keys(finding)
      .filter((key) => key !== 'forceReread')
      .sort()
      .map((key) => [key, finding[key]])
  );
}

/**
 * Extract in-root import/require specifiers from a set of unit files.
 * Returns [{path, contentId}] sorted by path for cache-key stability.
 *
 * @param {Array<{path: string, contentId: string, text: string, ext?: string}>} unitFiles
 *   Each entry must have `text` (the file's source content) so this function
 *   stays pure (no I/O). In practice the caller reads the file before calling.
 * @param {Map<string, string>} inRootSet
 *   Map of root-relative posix path => contentId for all inventory files.
 * @returns {Array<{path: string, contentId: string}>}
 */
function suggestRefsFor(unitFiles, inRootSet) {
  const seen = new Map(); // path => contentId, deduped

  for (const file of unitFiles) {
    // Determine extension: prefer file.ext, fall back to path parse.
    const ext = file.ext || path.extname(file.path);
    if (!JS_EXTENSIONS.has(ext)) continue;

    const text = file.text || '';
    const fileDir = path.posix.dirname(file.path);

    // Collect all static specifiers from the three syntactic forms.
    const specifiers = [];

    let m;
    const rr = new RegExp(REQUIRE_RE.source, 'g');
    while ((m = rr.exec(text)) !== null) {
      specifiers.push(m[2]);
    }

    const ir = new RegExp(IMPORT_FROM_RE.source, 'g');
    while ((m = ir.exec(text)) !== null) {
      specifiers.push(m[2]);
    }

    const dr = new RegExp(DYNAMIC_IMPORT_RE.source, 'g');
    while ((m = dr.exec(text)) !== null) {
      specifiers.push(m[2]);
    }

    for (const spec of specifiers) {
      // Only relative specifiers (leading ./ or ../ or /) are potentially in-root.
      // Bare package specifiers (e.g. 'crypto', 'path', 'express') are dropped.
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;

      // Resolve relative to the file's directory.
      let resolved = path.posix.normalize(path.posix.join(fileDir, spec));

      const matched = resolveInRootImport(resolved, inRootSet);
      if (!matched) continue; // not in root
      resolved = matched.path;
      const contentId = matched.contentId;

      if (!seen.has(resolved)) {
        seen.set(resolved, contentId);
      }
    }
  }

  // Sort by path for deterministic cache-key stability.
  return Array.from(seen.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, cid]) => ({ path: p, contentId: cid }));
}

// ---------------------------------------------------------------------------
// reviewCacheKey (SPEC-BEHAVIOR-004)
// ---------------------------------------------------------------------------

/**
 * Compute the review cache key for a unit.
 * sha256(memberDigest NUL mergedRulesFingerprint NUL JSON(suggestedRefs) NUL JSON(extraReads))
 *
 * The mergedRulesFingerprint is supplied by the caller (computed in
 * lib/context-pack.js, task 002); this function just combines the four parts.
 *
 * @param {{ memberDigest: string, mergedRulesFingerprint: string,
 *            suggestedRefs: Array<{path:string,contentId:string}>,
 *            extraReads: Array<{path:string,contentId:string}> }} params
 * @returns {string} 64-char lowercase hex sha256
 */
function reviewCacheKey({ memberDigest, mergedRulesFingerprint, suggestedRefs, extraReads }) {
  const parts = [memberDigest, mergedRulesFingerprint,
    JSON.stringify(suggestedRefs), JSON.stringify(extraReads)];
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}

// ---------------------------------------------------------------------------
// aggregate (SPEC-BEHAVIOR-005)
// ---------------------------------------------------------------------------

/**
 * Aggregate unit summaries and findings into a coverage proof and verdict.
 *
 * Enforces only the STRUCTURAL preconditions for earned PASS:
 *   - every unit summary has coverage_risk === 'none'
 *   - every unit summary has reviewed === true
 *   - no open high/medium finding remains
 *   - every high-risk unit was body-reviewed (reviewed:true)
 *
 * The "emergent-property derivability" judgment is the model's at runtime;
 * this function does NOT try to decide semantic derivability.
 *
 * @param {Array<{
 *   unit_id: string,
 *   reviewed: boolean,
 *   skipped: Array<{path:string, reason:string}>,
 *   extraReads: Array<{path:string, contentId:string}>,
 *   coverage_risk: 'none' | 'high',
 *   reviewCacheKey: string,
 *   contractsTouched: string[]
 * }>} summaries - one per unit, including the crosscutting backstop
 * @param {Array<{location:string, category:string, severity:string, description:string}>} findings
 * @returns {{
 *   verdict: 'PASS' | 'stopped-with-deferrals',
 *   findings: Array<{location:string, category:string, severity:string, description:string, forceReread:boolean}>,
 *   coverageProof: {
 *     discovered: number,
 *     bodyReviewed: number,
 *     extraRead: number,
 *     skipped: number,
 *     highRiskUnitsFullyReviewed: number,
 *     residualRisk: 'none' | 'present'
 *   },
 *   crosscuttingBackstops: string[]
 * }}
 */
function aggregate(summaries, findings) {
  // --- Dedup identical findings using first-occurrence wins ---
  const dedupedFindings = [];
  const findingKeys = new Set();
  for (const f of findings) {
    const key = findingDedupKey(f);
    if (!findingKeys.has(key)) {
      findingKeys.add(key);
      const severity = f.severity || 'low';
      // Flag high-severity findings (P0/P1/high) for forced re-read by the model.
      const forceReread = severity === 'high' || severity === 'P0' || severity === 'P1';
      dedupedFindings.push({ ...f, severity, forceReread });
    }
  }

  // --- Coverage proof computation ---
  const discovered = summaries.length;

  let bodyReviewed = 0;
  let extraReadCount = 0;
  let skippedCount = 0;
  let highRiskUnitsFullyReviewed = 0;

  for (const s of summaries) {
    if (s.reviewed) bodyReviewed++;
    if (Array.isArray(s.extraReads)) extraReadCount += s.extraReads.length;
    if (Array.isArray(s.skipped)) skippedCount += s.skipped.length;
    if (s.coverage_risk === 'high' && s.reviewed) highRiskUnitsFullyReviewed++;
  }

  // --- Earned-PASS gate (structural preconditions only) ---
  const allNoneCoverage = summaries.every(s => s.coverage_risk === 'none');
  const allReviewed = summaries.every(s => s.reviewed === true);
  const noOpenHighMedium = dedupedFindings.every(
    f => f.severity !== 'high' && f.severity !== 'medium' &&
         f.severity !== 'P0' && f.severity !== 'P1'
  );

  const pass = allNoneCoverage && allReviewed && noOpenHighMedium;

  const residualRisk = pass ? 'none' : 'present';
  const verdict = pass ? 'PASS' : 'stopped-with-deferrals';

  return {
    verdict,
    findings: dedupedFindings,
    coverageProof: {
      discovered,
      bodyReviewed,
      extraRead: extraReadCount,
      skipped: skippedCount,
      highRiskUnitsFullyReviewed,
      residualRisk,
    },
    crosscuttingBackstops: CROSSCUTTING_BACKSTOPS,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  partitionInventory,
  suggestRefsFor,
  reviewCacheKey,
  aggregate,
  CROSSCUTTING_BACKSTOPS,
  MAX_UNIT_BYTES,
  CONTRACT_READ_BUDGET,
};
