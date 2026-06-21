'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { redactSensitive } = require('./redaction');
const { ruleSourceCategory } = require('./rulebook');
const { validateTargetStateOwnedPath } = require('./target-state');
const { atomicWriteFile } = require('./workflow-state');

const REVIEWER_CONTEXT_MANIFEST = path.join('context', 'current-reviewer-context-manifest.md');
const FIXER_CONTEXT_MANIFEST = path.join('context', 'current-fixer-context-manifest.md');
const CONTENT_POLICY = 'read-in-memory-only';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) result[key] = stableValue(item);
  }
  return result;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value), null, 2);
}

function isInsideOrEqual(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function redactIdentifier(identifier, projectRoot = null) {
  let value = redactSensitive(String(identifier || 'unknown')).trim();
  if (!value) value = 'unknown';
  if (path.isAbsolute(value)) {
    if (!projectRoot) return path.join('[absolute-path]', path.basename(value));
    const root = path.resolve(projectRoot);
    const absolute = path.resolve(value);
    if (!isInsideOrEqual(absolute, root)) return path.join('[external-path]', path.basename(value));
    return path.relative(root, absolute).split(path.sep).join('/');
  }
  return value.split(path.sep).join('/');
}

function rulesSourceListFromMerge(mergedRules = {}, options = {}) {
  const layers = Array.isArray(mergedRules.layers) ? mergedRules.layers : [];
  const sourceList = Array.isArray(mergedRules.sourceList) ? mergedRules.sourceList : [];
  const sources = Array.isArray(mergedRules.sources)
    ? mergedRules.sources
    : layers.map((layer) => layer.source);

  return sources.map((source, index) => {
    const fromSourceList = sourceList[index] || {};
    const fromLayer = layers[index] || {};
    const category = fromSourceList.category || ruleSourceCategory(source);
    return {
      category,
      identifier: redactIdentifier(
        fromSourceList.identifier || fromLayer.identifier || fromLayer.sourceIdentifier || source,
        options.projectRoot || null
      )
    };
  });
}

function normalizeReferences(references = []) {
  return references.map((reference) => {
    if (typeof reference === 'string') {
      return { path: redactSensitive(reference), readOnly: true };
    }
    return {
      path: redactSensitive(String(reference.path || reference.normalizedPath || 'unknown')),
      readOnly: reference.readOnly !== false
    };
  });
}

function normalizeAcceptedNonBlocking(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 'none';
  return [...new Set(ids.map((id) => String(id)).filter(Boolean))].sort();
}

// PLAN-TASK-005: Hash the RAW merged-rules text (before redaction). Output is a
// one-way 64-char hex digest — safe to persist as a cache key; no rule content
// can be recovered from it. Used by Task 6's reviewCacheKey.
function mergedRulesFingerprint(mergedRules) {
  return crypto.createHash('sha256').update(String((mergedRules && mergedRules.text) || '')).digest('hex');
}

function defaultConstraints() {
  return [
    'Target and reference body text may be read in memory only.',
    'Reference documents are read-only.',
    'Do not persist raw prompts, raw subagent output, target/reference body text, or secrets.'
  ];
}

function buildContextPack({
  target,
  references = [],
  documentType,
  strictness,
  mode,
  assurance,
  runtimePlatform,
  phase,
  round,
  mergedRules = { text: '', sources: [] },
  acceptedNonBlockingLowIssueIds = [],
  changedSinceLastReview = null,
  constraints = defaultConstraints(),
  requiredOutputSchema = null,
  reviewerGuardBaseline = null,
  fixerGuard = null,
  projectRoot = null
} = {}) {
  return {
    acceptedNonBlockingLowIssueIds: normalizeAcceptedNonBlocking(acceptedNonBlockingLowIssueIds),
    changedSinceLastReview: changedSinceLastReview || null,
    assurance,
    constraints: Array.isArray(constraints) ? constraints.map((item) => redactSensitive(String(item))) : [],
    contentPolicy: CONTENT_POLICY,
    documentType,
    mergedRuleSet: redactSensitive(String(mergedRules && mergedRules.text ? mergedRules.text : '')),
    mode,
    phase,
    references: normalizeReferences(references),
    requiredOutputSchema,
    reviewerGuardBaseline,
    round: Number(round || 1),
    rulesSourceList: rulesSourceListFromMerge(mergedRules, { projectRoot }),
    runtimePlatform,
    strictness,
    target: redactSensitive(String(target || 'unknown')),
    ...(fixerGuard ? { fixerGuard } : {})
  };
}

// PLAN-TASK-009 (Phase C): file-set (PR/CODE) context pack. The unit of review is a SET
// of files, not one document body, so this emits a `fileSet` descriptor (route kind +
// base/scope identity + redacted per-file path/status list) in place of the single
// `target` field. It reuses the same redaction, rules-source, and constraint logic as the
// document pack so no raw body text or secret leaks. ADDITIVE: buildContextPack is
// unchanged for document routes.
function defaultFileSetConstraints() {
  return [
    'File-set member body text may be read in memory only.',
    'Review the whole file set as one unit; do not assume any file is read-only.',
    'Do not persist raw prompts, raw subagent output, file body text, or secrets.'
  ];
}

// PLAN-TASK-014: partitioned chunk RANGE METADATA (never body text). When a member
// carries a contextLineRange (set by Task 12/13 chunk expansion and copied with the
// unit-level chunkIndex/chunkCount by unitContext), emit a `chunk` block describing
// ONLY the ranges + a concrete instruction label. The reviewer reads the actual
// contextLineRange slice into its prompt IN MEMORY at dispatch; the slice text is
// NEVER persisted. Members without contextLineRange return the EXACT pre-change shape
// so non-chunk packs stay byte-identical (the byte-for-byte snapshot gates this).
function chunkInstruction(memberPath, member) {
  const oneBasedIndex = Number(member.chunkIndex) + 1;
  const count = Number(member.chunkCount);
  const [primaryStart, primaryEnd] = member.primaryLineRange;
  const [contextStart, contextEnd] = member.contextLineRange;
  return `${memberPath} chunk ${oneBasedIndex}/${count}, primary lines [${primaryStart},${primaryEnd}], `
    + `context lines [${contextStart},${contextEnd}]; use location ${memberPath}:<line> for line-specific findings; `
    + 'overlap before/after the primary is context only — do not raise duplicate findings for overlap lines.';
}

function normalizeFileSetMembers(files = [], projectRoot = null) {
  return (Array.isArray(files) ? files : []).map((entry) => {
    if (typeof entry === 'string') {
      return { path: redactIdentifier(entry, projectRoot), status: 'present' };
    }
    const memberPath = redactIdentifier(entry && (entry.path || entry.normalizedPath) || 'unknown', projectRoot);
    if (entry && entry.contextLineRange) {
      return {
        path: memberPath,
        status: 'present',
        chunk: {
          index: Number(entry.chunkIndex),
          count: Number(entry.chunkCount),
          primaryLineRange: entry.primaryLineRange,
          contextLineRange: entry.contextLineRange,
          instruction: chunkInstruction(memberPath, entry)
        }
      };
    }
    return {
      path: memberPath,
      status: redactSensitive(String((entry && entry.status) || 'present'))
    };
  });
}

function buildFileSetContextPack({
  routeKind,
  fileSet = {},
  strictness,
  mode,
  assurance,
  runtimePlatform,
  phase,
  round,
  mergedRules = { text: '', sources: [] },
  acceptedNonBlockingLowIssueIds = [],
  changedSinceLastReview = null,
  constraints = defaultFileSetConstraints(),
  requiredOutputSchema = null,
  reviewerGuardBaseline = null,
  fixerGuard = null,
  projectRoot = null,
  // PLAN-TASK-005: Partitioned unit-subset mode. When reviewMode === 'partitioned',
  // the pack contains ONLY the unit's files (passed as fileSet.files by the caller)
  // + the merged rules + suggestedRefs injected as read-only references, and carries
  // reviewMode + unit_id. All three params are optional; absence preserves the
  // existing non-partitioned behavior byte-for-byte.
  reviewMode = undefined,
  unitId = undefined,
  suggestedRefs = undefined
} = {}) {
  const members = normalizeFileSetMembers(fileSet.files, projectRoot);
  const descriptor = {
    routeKind,
    fileCount: members.length,
    files: members
  };
  if (routeKind === 'pr') {
    descriptor.base = redactSensitive(String(fileSet.base || 'unknown'));
    descriptor.diffRange = `${redactSensitive(String(fileSet.mergeBase || 'merge-base'))}..${redactSensitive(String(fileSet.head || 'HEAD'))}`;
  } else {
    descriptor.scopes = (Array.isArray(fileSet.normalizedScopes) && fileSet.normalizedScopes.length > 0)
      ? fileSet.normalizedScopes.map((scope) => redactIdentifier(scope, projectRoot))
      : ['(whole project root)'];
    // .drfxignore patterns shape the reviewed set, so the reviewer must see
    // them; scopes an ignore source would have covered (but scope= wins) are
    // surfaced so the re-inclusion is never silent. The version-ignore source
    // states whether git-ignored files were excluded ('git') or no git
    // worktree was available ('none').
    const displayUserExcludes = Array.isArray(fileSet.userExcludePatterns)
      ? fileSet.userExcludePatterns
      : fileSet.userExcludes;
    if (Array.isArray(displayUserExcludes) && displayUserExcludes.length > 0) {
      descriptor.userExcludes = displayUserExcludes.map((entry) => redactSensitive(String(entry)));
    }
    if (Array.isArray(fileSet.scopeIgnoreOverrides) && fileSet.scopeIgnoreOverrides.length > 0) {
      descriptor.scopeIgnoreOverrides = fileSet.scopeIgnoreOverrides.map(
        (entry) => redactIdentifier(entry, projectRoot)
      );
    }
    if (fileSet.versionIgnoreSource) {
      descriptor.versionIgnoreSource = String(fileSet.versionIgnoreSource);
    }
  }
  // PLAN-TASK-005: Partitioned mode — inject suggestedRefs as read-only references
  // and tag the pack with reviewMode/unit_id. The caller is responsible for passing
  // ONLY the unit's files as fileSet.files; this function faithfully reflects whatever
  // it receives (no additional files pulled from disk). Non-partitioned path leaves
  // references: [] and emits no reviewMode/unit_id, preserving byte-identity.
  // We use redactIdentifier (same as normalizeFileSetMembers) so absolute paths are
  // relativized against projectRoot — consistent with file path redaction.
  const isPartitioned = reviewMode === 'partitioned';
  const normalizedRefs = isPartitioned
    ? (Array.isArray(suggestedRefs) ? suggestedRefs : []).map((r) => ({
        path: redactIdentifier(String(r.path || r.normalizedPath || 'unknown'), projectRoot),
        readOnly: true
      }))
    : [];

  // In partitioned mode, add a discipline constraint so reviewers understand the
  // bounded context. Matches SPEC-BEHAVIOR-003 language.
  const effectiveConstraints = Array.isArray(constraints) ? constraints.map((item) => redactSensitive(String(item))) : [];
  if (isPartitioned) {
    effectiveConstraints.push(
      'Partitioned unit review: read only this unit\'s files plus its suggested references; record coverage_risk:high for anything you cannot positively confirm.'
    );
  }

  return {
    acceptedNonBlockingLowIssueIds: normalizeAcceptedNonBlocking(acceptedNonBlockingLowIssueIds),
    changedSinceLastReview: changedSinceLastReview || null,
    assurance,
    constraints: effectiveConstraints,
    contentPolicy: CONTENT_POLICY,
    documentType: 'none',
    fileSet: descriptor,
    mergedRuleSet: redactSensitive(String(mergedRules && mergedRules.text ? mergedRules.text : '')),
    mode,
    phase,
    references: normalizedRefs,
    requiredOutputSchema,
    reviewerGuardBaseline,
    round: Number(round || 1),
    routeKind,
    rulesSourceList: rulesSourceListFromMerge(mergedRules, { projectRoot }),
    runtimePlatform,
    strictness,
    target: 'none',
    ...(fixerGuard ? { fixerGuard } : {}),
    ...(isPartitioned ? { reviewMode: 'partitioned', unit_id: unitId } : {})
  };
}

function contextManifestRelativePath(phase) {
  return phase === 'fix' ? FIXER_CONTEXT_MANIFEST : REVIEWER_CONTEXT_MANIFEST;
}

function formatContextManifest(pack) {
  return [
    '# Document Review Context Manifest',
    '',
    '```json',
    stableJson(pack),
    '```',
    ''
  ].join('\n');
}

function writeContextManifest({ targetStateDir, phase, contextPack }) {
  const relativePath = contextManifestRelativePath(phase || (contextPack && contextPack.phase));
  const manifestPath = validateTargetStateOwnedPath({
    targetStateDir,
    relativePath,
    allowedDirectories: ['context'],
    label: 'Context manifest path'
  });
  atomicWriteFile(manifestPath, formatContextManifest(contextPack));
  return manifestPath;
}

module.exports = {
  buildContextPack,
  buildFileSetContextPack,
  mergedRulesFingerprint,
  writeContextManifest,
  rulesSourceListFromMerge
};
