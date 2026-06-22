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
const CHUNK_LINES = 800;
const CHUNK_OVERLAP_LINES = 40;

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
// refreshPartitionPlanContent (Plan B) — PURE. Re-stamp an existing partition
// plan with refreshed file content after a route-owned, in-set fix, WITHOUT
// re-bucketing. The caller (end-fix increment) supplies the freshly resolved
// inventory, the live projectReviewFingerprint (F1), and the re-resolved
// suggestedRefs per non-chunk unit (refs reading needs file bodies = caller IO).
// This function only validates membership/bucket stability and replaces
// content-derived fields. Membership/bucket/refs drift throws — never a silent
// reuse of stale unit content.
// ---------------------------------------------------------------------------

const ERR_PARTITION_MEMBERSHIP_CHANGED = 'ERR_PARTITION_MEMBERSHIP_CHANGED';
const ERR_PARTITION_REBUCKET_REQUIRED = 'ERR_PARTITION_REBUCKET_REQUIRED';
const ERR_PARTITION_REFS_CHANGED = 'ERR_PARTITION_REFS_CHANGED';

function partitionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function pathSet(entries, key = 'path') {
  return new Set((Array.isArray(entries) ? entries : []).map((entry) => entry[key]));
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

// The file-level path set a plan covers: normal units contribute files[].path;
// oversize_chunk units (Part 2) contribute their single sourcePath once.
function planFilePathSet(plan) {
  const paths = new Set();
  for (const unit of plan.units) {
    if (unit.oversize_chunk === true) {
      paths.add(unit.sourcePath);
    } else {
      for (const file of unit.files) paths.add(file.path);
    }
  }
  return paths;
}

function refreshPartitionPlanContent(oldPlan, newInventory, { nextSuggestedRefsByUnit = {}, projectReviewFingerprint } = {}) {
  const inventory = Array.isArray(newInventory) ? newInventory : [];
  const byPath = new Map(inventory.map((row) => [row.path, row]));
  const unitByteBudget = Number(oldPlan.unitByteBudget) || MAX_UNIT_BYTES;

  // (1) File-level membership must be byte-identical (no add/remove). A changed
  // member SET is out of scope: the caller blocks + resets to a full re-partition.
  if (!sameSet(planFilePathSet(oldPlan), new Set(byPath.keys()))) {
    throw partitionError(ERR_PARTITION_MEMBERSHIP_CHANGED, 'partition plan members changed since the plan was written');
  }

  const refsChangedUnitIds = [];
  const units = oldPlan.units.map((unit) => {
    // Part 2 chunk units: handled by the chunk-aware path (Task 17). In Part 1 no
    // chunk units exist; if one appears with a moved parent content, demand a reset.
    if (unit.oversize_chunk === true) {
      const source = byPath.get(unit.sourcePath);
      if (!source || String(source.contentId) !== String(unit.sourceContentId)) {
        throw partitionError(ERR_PARTITION_MEMBERSHIP_CHANGED, `oversize chunk source changed; re-split required: ${unit.sourcePath}`);
      }
      return { ...unit };
    }
    if (unit.oversize_file === true) {
      // Legacy oversize blocker unit: single member, refresh its content row only.
      const row = byPath.get(unit.files[0].path);
      if (Number(row.size) <= unitByteBudget) {
        throw partitionError(ERR_PARTITION_REBUCKET_REQUIRED, `oversize unit ${unit.unit_id} is no longer oversize; re-partition required`);
      }
      const files = [{ ...unit.files[0], size: row.size, ext: row.ext, contentId: row.contentId }];
      return { ...unit, files, member_bytes: row.size, member_digest: computeMemberDigest(files) };
    }

    // (2) Normal unit: refresh each member's content row in place (paths unchanged).
    const files = unit.files.map((file) => {
      const row = byPath.get(file.path);
      if (Number(row.size) > unitByteBudget) {
        throw partitionError(ERR_PARTITION_REBUCKET_REQUIRED, `member ${file.path} flipped oversize; re-partition required`);
      }
      return { ...file, size: row.size, ext: row.ext, contentId: row.contentId };
    });
    const member_bytes = files.reduce((sum, file) => sum + Number(file.size), 0);
    if (member_bytes > unitByteBudget) {
      throw partitionError(ERR_PARTITION_REBUCKET_REQUIRED, `unit ${unit.unit_id} exceeds the byte budget after fix; re-partition required`);
    }

    // (3) Refs topology: the caller MUST supply re-resolved refs for every normal
    // unit (refs reading needs file bodies). A missing entry is a contract breach,
    // not "no refs" — fail loud rather than silently reuse stale refs.
    if (!Object.prototype.hasOwnProperty.call(nextSuggestedRefsByUnit, unit.unit_id)) {
      throw partitionError(ERR_PARTITION_REFS_CHANGED, `refs were not re-resolved for ${unit.unit_id}`);
    }
    const nextRefs = Array.isArray(nextSuggestedRefsByUnit[unit.unit_id]) ? nextSuggestedRefsByUnit[unit.unit_id] : [];
    if (!sameSet(pathSet(unit.suggestedRefs), pathSet(nextRefs))) {
      refsChangedUnitIds.push(unit.unit_id);
    }
    return { ...unit, files, member_bytes, member_digest: computeMemberDigest(files), suggestedRefs: nextRefs };
  });

  // (4) Rebuild file-level inventoryRows (one row per source path) so the written
  // inventory.jsonl stays file-level. unit_id is looked up from refreshed units.
  const pathToUnit = new Map();
  for (const unit of units) {
    if (unit.oversize_chunk === true) {
      if (!pathToUnit.has(unit.sourcePath)) pathToUnit.set(unit.sourcePath, unit.unit_id);
      continue;
    }
    for (const file of unit.files) pathToUnit.set(file.path, unit.unit_id);
  }
  const inventoryRows = inventory
    .map((row) => ({ path: row.path, size: row.size, ext: row.ext, contentId: row.contentId, unit_id: pathToUnit.get(row.path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const refreshedPlan = {
    ...oldPlan,
    units,
    projectReviewFingerprint: String(projectReviewFingerprint),
    inventoryRows,
  };
  return { refreshedPlan, refsChangedUnitIds: refsChangedUnitIds.sort() };
}

// ---------------------------------------------------------------------------
// computeOversizeChunks (deterministic line-window chunking with byte budget)
// ---------------------------------------------------------------------------

// Deterministic line-window chunking for an oversize TEXT file. Primary windows of
// chunkLines get up to overlapLines of context before AND after the primary. The HARD
// constraint is the UTF-8 byte length of the contextLineRange slice (<= chunkByteBudget):
// overlap is shrunk (never the primary) to fit; a primary window is also byte-capped by
// ending it early when the next line would cross the budget. If any single line alone
// exceeds the budget the file is unsplittable -> null (caller keeps the legacy oversize blocker).
function computeOversizeChunks({ text, chunkLines = CHUNK_LINES, overlapLines = CHUNK_OVERLAP_LINES, chunkByteBudget = MAX_UNIT_BYTES }) {
  const sourceText = String(text);
  const hasTerminalNewline = sourceText.endsWith('\n');
  const lines = sourceText.split('\n');
  if (hasTerminalNewline) lines.pop();
  const lineHasNewline = (oneBasedIndex) => oneBasedIndex < lines.length || hasTerminalNewline;
  const lineByte = (oneBasedIndex) =>
    Buffer.byteLength(lines[oneBasedIndex - 1] + (lineHasNewline(oneBasedIndex) ? '\n' : ''), 'utf8');
  const total = lines.length;
  for (let i = 1; i <= total; i += 1) {
    if (lineByte(i) > chunkByteBudget) return null; // a single line cannot fit
  }
  const sliceText = (s, e) => lines.slice(s - 1, e).join('\n') + (e < total || hasTerminalNewline ? '\n' : '');
  const sliceBytes = (s, e) => Buffer.byteLength(sliceText(s, e), 'utf8');

  const chunks = [];
  let primaryStart = 1;
  while (primaryStart <= total) {
    // Grow the primary window up to chunkLines OR until the next line would cross budget.
    let primaryEnd = primaryStart;
    while (
      primaryEnd < total &&
      (primaryEnd - primaryStart + 1) < chunkLines &&
      sliceBytes(primaryStart, primaryEnd + 1) <= chunkByteBudget
    ) {
      primaryEnd += 1;
    }
    // Add bidirectional overlap around the primary, shrinking only overlap until
    // the context slice fits. Prefer dropping forward context first so each
    // chunk still retains preceding context when budget pressure is tight.
    let contextStart = Math.max(1, primaryStart - overlapLines);
    let contextEnd = Math.min(total, primaryEnd + overlapLines);
    while (sliceBytes(contextStart, contextEnd) > chunkByteBudget) {
      if (contextEnd > primaryEnd) {
        contextEnd -= 1;
      } else if (contextStart < primaryStart) {
        contextStart += 1;
      } else {
        break;
      }
    }
    chunks.push({
      primaryLineRange: [primaryStart, primaryEnd],
      contextLineRange: [contextStart, contextEnd],
      sliceText: sliceText(contextStart, contextEnd),
      byteLength: sliceBytes(contextStart, contextEnd),
    });
    if (primaryEnd >= total) break;
    primaryStart = primaryEnd + 1;
  }
  return chunks;
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

// ---------------------------------------------------------------------------
// dedupChunkFindings (chunk-aware overlap dedup for the partitioned aggregate)
// ---------------------------------------------------------------------------
//
// Adjacent oversize-file chunks share a bidirectional overlap region, so the SAME
// defect can be reported twice — once by each chunk that sees the line. This step
// collapses those genuine overlap duplicates BEFORE the pure aggregate() dedup,
// using the plan's chunk units' primaryLineRange to find each line's owner.
//
// LOAD-BEARING SAFETY INVARIANT: never drop a finding. If a finding's location is
// missing/unparsable, OR no chunk owns the parsed line, the finding is KEPT under a
// per-finding-unique key (its reporting chunk's primary range when known, else its
// raw location/identity) so an unparsed overlap heuristic can never erase a real
// defect and fake a PASS.

// Grammar: <path>:<line> OR <path>:L<line> (case-insensitive L), line is 1-based.
const FINDING_LOCATION_RE = /^(.*):L?(\d+)$/i;

function parseFindingLocation(location) {
  if (typeof location !== 'string') return null;
  const match = FINDING_LOCATION_RE.exec(location.trim());
  if (!match) return null;
  const path = match[1];
  const line = Number(match[2]);
  if (!path || !Number.isInteger(line) || line < 1) return null;
  return { path, line };
}

// Normalize free-text for the "issue class" so trivially-different wording for the
// same defect collapses: trim + collapse internal whitespace + lowercase.
function normalizeIssueText(text) {
  return String(text == null ? '' : text).trim().replace(/\s+/g, ' ').toLowerCase();
}

// The issue class is derived INTERNALLY from existing reviewer fields only (no new
// schema field): normalized issue + suggested_fix text, hashed together with severity.
function issueClassHash(finding) {
  const issue = normalizeIssueText(finding && finding.issue);
  const fix = normalizeIssueText(finding && finding.suggested_fix);
  const severity = String((finding && finding.severity) || '');
  return sha256hex([issue, fix, severity].join('\0'));
}

// Build path -> [{ primaryLineRange:[s,e], unitId }] from the plan's chunk units.
function chunkOwnerIndex(units) {
  const byPath = new Map();
  for (const unit of Array.isArray(units) ? units : []) {
    if (!unit || unit.oversize_chunk !== true) continue;
    const sourcePath = unit.sourcePath;
    const member = Array.isArray(unit.files) ? unit.files[0] : undefined;
    const range = member && Array.isArray(member.primaryLineRange) ? member.primaryLineRange : null;
    if (!sourcePath || !range || range.length !== 2) continue;
    if (!byPath.has(sourcePath)) byPath.set(sourcePath, []);
    byPath.get(sourcePath).push({ primaryLineRange: [Number(range[0]), Number(range[1])], unitId: unit.unit_id });
  }
  return byPath;
}

/**
 * Collapse overlap-duplicate findings across an oversize file's chunks.
 *
 * Applies ONLY when at least one unit is an oversize_chunk; otherwise the findings
 * array is returned UNCHANGED (same reference) so non-chunk aggregation is byte-for-
 * byte identical to today. First-occurrence wins for collapsed duplicates. A finding
 * is NEVER dropped: unparsable locations and lines with no owning chunk fall through
 * to a per-finding-unique key.
 *
 * @param {Array<object>} findings
 * @param {Array<object>} units - plan.units
 * @returns {Array<object>}
 */
function dedupChunkFindings(findings, units) {
  const list = Array.isArray(findings) ? findings : [];
  const ownerIndex = chunkOwnerIndex(units);
  if (ownerIndex.size === 0) return findings; // not the partitioned-chunk path: unchanged.

  const seen = new Set();
  const out = [];
  let fallbackCounter = 0;
  for (const finding of list) {
    let key;
    const parsed = parseFindingLocation(finding && finding.location);
    const owners = parsed ? ownerIndex.get(parsed.path) : undefined;
    let owner = null;
    if (parsed && owners) {
      owner = owners.find(
        (candidate) => parsed.line >= candidate.primaryLineRange[0] && parsed.line <= candidate.primaryLineRange[1]
      ) || null;
    }
    if (owner) {
      // Canonicalize an overlap report from either adjacent chunk to the OWNER's
      // primary range and line so same-line duplicates collapse, while distinct
      // lines in the same chunk remain separate findings.
      const canonicalRange = `${owner.primaryLineRange[0]}-${owner.primaryLineRange[1]}`;
      key = `chunk\0${parsed.path}\0${canonicalRange}\0${parsed.line}\0${issueClassHash(finding)}`;
    } else {
      // NEVER drop: unparsable location or no owning chunk. Key on the reporting
      // chunk's own primary range when known, else the raw identity — but always
      // unique-per-finding so two distinct kept findings never merge.
      const raw = typeof (finding && finding.location) === 'string' ? finding.location : JSON.stringify(finding && finding.location);
      key = `keep\0${fallbackCounter}\0${raw}`;
      fallbackCounter += 1;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
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
 *   - no unit summary carries a non-empty skipped list (a skipped member file is
 *     residual coverage risk; record-time gates already refuse skipped+none, this is
 *     the authoritative defense-in-depth backstop at aggregation)
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
  // A skipped member file is residual coverage risk even when the summary claims
  // coverage_risk:none. record-time gates refuse skipped+none, but aggregate re-derives
  // coverage rather than trusting record-time writes, so this backstop is authoritative.
  const noSkippedCoverage = summaries.every(
    s => !(Array.isArray(s.skipped) && s.skipped.length > 0)
  );
  const noOpenHighMedium = dedupedFindings.every(
    f => f.severity !== 'high' && f.severity !== 'medium' &&
         f.severity !== 'P0' && f.severity !== 'P1'
  );

  const pass = allNoneCoverage && allReviewed && noSkippedCoverage && noOpenHighMedium;

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
  dedupChunkFindings,
  refreshPartitionPlanContent,
  computeOversizeChunks,
  formatUnitId,
  ERR_PARTITION_MEMBERSHIP_CHANGED,
  ERR_PARTITION_REBUCKET_REQUIRED,
  ERR_PARTITION_REFS_CHANGED,
  CROSSCUTTING_BACKSTOPS,
  MAX_UNIT_BYTES,
  CONTRACT_READ_BUDGET,
  CHUNK_LINES,
  CHUNK_OVERLAP_LINES,
};
