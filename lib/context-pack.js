'use strict';

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
  writeContextManifest,
  rulesSourceListFromMerge
};
