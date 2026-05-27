'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CANONICAL_SECTIONS = Object.freeze(['COMMON', 'SPEC', 'PLAN', 'DESIGN']);
const ALLOWED_RULE_FILENAMES = Object.freeze(CANONICAL_SECTIONS.map((section) => `${section}.md`));
const ALLOWED_RULE_FILE_SET = new Set(ALLOWED_RULE_FILENAMES);
const SECTION_SET = new Set(CANONICAL_SECTIONS);
const STRICTNESS_SET = new Set(['normal', 'strict']);
const HARD_CONSTRAINTS = [
  'Workflow hard constraints:',
  '- Isolated reviewers are required before initial review and full re-review.',
  '- Reviewers must not write to target or reference documents.',
  '- Fixes require diff review followed by full re-review before PASS.',
  '- Reference documents are read-only.',
  '- Reports, ledgers, receipts, and final responses must redact sensitive values.',
  '- PASS criteria cannot be bypassed.',
  '- Persistent workflow state must be target-local.',
  '- Fixers for the same target must run serially.'
].join('\n');

const WEAKENING_PATTERNS = Object.freeze([
  /(?:skip|disable|bypass|avoid|omit).{0,80}reviewer isolation/i,
  /(?:allow|permit).{0,80}reviewers?.{0,40}(?:write|edit|modify).{0,40}(?:targets?|references?|documents?)/i,
  /reviewers?\s+(?:may|can|should|must)?\s*(?:write|edit|modify).{0,40}(?:targets?|references?|documents?)/i,
  /reviewers?.{0,40}(?:allowed|permitted).{0,40}(?:write|edit|modify).{0,40}(?:targets?|references?|documents?)/i,
  /(?:skip|disable|bypass|avoid|omit).{0,80}full re-?review/i,
  /references?\s+(?:may|can|should|must)?\s*(?:be\s+)?(?:write|edit|modify|modified|writable)/i,
  /reference documents?.{0,40}(?:writable|writeable)/i,
  /(?:allow|permit).{0,80}reference.{0,40}(?:write|edit|modify)/i,
  /(?:disable|skip|bypass|avoid|omit).{0,80}redaction/i,
  /(?:bypass|skip|disable|ignore|relax).{0,80}PASS criteria/i,
  /(?:disable|skip|bypass|avoid|omit).{0,80}target-local state/i,
  /(?:disable|skip|bypass|avoid|omit).{0,80}target-local state isolation/i,
  /(?:parallel|concurrent).{0,40}fixers?.{0,80}(?:same|one).{0,20}target/i,
  /fixers?.{0,80}(?:parallel|concurrent|concurrently).{0,80}(?:same|one).{0,20}target/i,
  /(?:same|one).{0,20}target.{0,80}(?:parallel|concurrent|concurrently).{0,40}fixers?/i
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateDocumentType(documentType) {
  if (!SECTION_SET.has(documentType)) {
    fail('ERR_UNKNOWN_DOCUMENT_TYPE', `Unknown document type: ${documentType}`);
  }
}

function validateStrictness(strictness) {
  if (!STRICTNESS_SET.has(strictness)) {
    fail('ERR_UNKNOWN_STRICTNESS', `Unknown strictness: ${strictness}`);
  }
}

function parseRulebook(text) {
  const sections = {};
  let current = null;
  const lines = String(text || '').split(/\r?\n/);

  for (const line of lines) {
    const heading = line.match(/^(#{2,})\s+(.+?)\s*$/);
    if (heading && heading[1] === '##') {
      const name = heading[2].trim();
      if (!SECTION_SET.has(name)) {
        fail('ERR_UNKNOWN_RULEBOOK_HEADING', `Unknown heading in rulebook: ${name}`);
      }
      current = name;
      if (!Object.hasOwn(sections, current)) sections[current] = '';
      continue;
    }

    if (current) {
      sections[current] += `${line}\n`;
    }
  }

  for (const section of Object.keys(sections)) {
    sections[section] = sections[section].trim();
  }

  return sections;
}

function selectRuleSections(rulebook, documentType) {
  validateDocumentType(documentType);
  const selected = {};
  if (rulebook && Object.hasOwn(rulebook, 'COMMON')) selected.COMMON = rulebook.COMMON;
  if (documentType !== 'COMMON' && rulebook && Object.hasOwn(rulebook, documentType)) {
    selected[documentType] = rulebook[documentType];
  }
  return selected;
}

function assertNoHardConstraintConflict(text) {
  const value = String(text || '');
  const matched = WEAKENING_PATTERNS.find((pattern) => pattern.test(value));
  if (matched) {
    fail('ERR_HARD_CONSTRAINT_CONFLICT', 'Custom rule conflicts with workflow hard constraints');
  }
}

function ruleFileForDocumentType(documentType) {
  validateDocumentType(documentType);
  return `${documentType}.md`;
}

function sourcePrefixForRoot(rootKind) {
  if (rootKind === 'user') return 'user-global';
  if (rootKind === 'project') return 'project-local';
  fail('ERR_UNKNOWN_RULE_ROOT', `Unknown rule root: ${rootKind}`);
}

function customRuleSource(rootKind, documentType) {
  return `${sourcePrefixForRoot(rootKind)}:rules/${ruleFileForDocumentType(documentType)}`;
}

function statIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function readRuleFileIfPresent(filePath) {
  const stat = statIfExists(filePath);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    fail('ERR_SYMLINK_CUSTOM_RULE_FILE', `Custom rule file must not be a symlink: ${filePath}`);
  }
  if (!stat.isFile()) {
    fail('ERR_INVALID_CUSTOM_RULE_FILE', `Custom rule path is not a file: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content ? content : null;
}

function unknownRuleWarning(filePath) {
  return {
    code: 'WARN_UNKNOWN_CUSTOM_RULE_FILE',
    message: `Unknown custom rule file: ${filePath}`,
    filePath
  };
}

function validateRulesDirectory(rulesDir, { strictness = 'strict', warnings = [] } = {}) {
  validateStrictness(strictness);
  const stat = statIfExists(rulesDir);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    fail('ERR_SYMLINK_RULES_DIRECTORY', `Custom rules directory must not be a symlink: ${rulesDir}`);
  }
  if (!stat.isDirectory()) {
    fail('ERR_INVALID_RULES_DIRECTORY', `Custom rules path is not a directory: ${rulesDir}`);
  }

  for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.md')) continue;
    const filePath = path.join(rulesDir, entry.name);
    if (!ALLOWED_RULE_FILE_SET.has(entry.name)) {
      if (strictness === 'normal') {
        warnings.push(unknownRuleWarning(filePath));
        continue;
      }
      fail('ERR_UNKNOWN_CUSTOM_RULE_FILE', `Unknown custom rule file: ${filePath}`);
    }
    const fileStat = statIfExists(filePath);
    if (!fileStat) continue;
    if (fileStat.isSymbolicLink()) {
      fail('ERR_SYMLINK_CUSTOM_RULE_FILE', `Custom rule file must not be a symlink: ${filePath}`);
    }
    if (!fileStat.isFile()) {
      fail('ERR_INVALID_CUSTOM_RULE_FILE', `Custom rule path is not a file: ${filePath}`);
    }
  }
  return true;
}

function loadRuleRoot({ root, rootKind, documentType, strictness, warnings }) {
  const loaded = {};
  const contentPaths = [];
  if (!root) return { rules: loaded, contentPaths };

  const rulesDir = path.join(root, '.docs-review-fix', 'rules');
  if (!validateRulesDirectory(rulesDir, { strictness, warnings })) return { rules: loaded, contentPaths };

  const sections = documentType === 'COMMON' ? ['COMMON'] : ['COMMON', documentType];
  for (const section of sections) {
    const fileName = ruleFileForDocumentType(section);
    const filePath = path.join(rulesDir, fileName);
    const content = readRuleFileIfPresent(filePath);
    if (!content) continue;

    const source = customRuleSource(rootKind, section);
    loaded[section] = content;
    contentPaths.push({
      category: ruleSourceCategory(source),
      filePath,
      identifier: source,
      source
    });
  }

  return { rules: loaded, contentPaths };
}

function assertNoLegacyRulebook(root, rootKind) {
  if (!root) return;
  const legacyPath = path.join(root, '.docs-review-fix', 'RULE.md');
  if (statIfExists(legacyPath)) {
    fail(
      'ERR_LEGACY_RULEBOOK_FILE',
      `Legacy RULE.md is not supported for ${sourcePrefixForRoot(rootKind)} rules: ${legacyPath}`
    );
  }
}

function loadCustomRuleFiles({ projectRoot = null, documentType, homeDir = null, strictness = 'strict' } = {}) {
  validateDocumentType(documentType);
  validateStrictness(strictness);
  const userHome = homeDir || process.env.HOME || null;
  const warnings = [];

  assertNoLegacyRulebook(userHome, 'user');
  assertNoLegacyRulebook(projectRoot, 'project');

  const userLoaded = loadRuleRoot({ root: userHome, rootKind: 'user', documentType, strictness, warnings });
  const projectLoaded = loadRuleRoot({ root: projectRoot, rootKind: 'project', documentType, strictness, warnings });

  return {
    user: userLoaded.rules,
    project: projectLoaded.rules,
    contentPaths: [...userLoaded.contentPaths, ...projectLoaded.contentPaths],
    warnings
  };
}

function collectUnknownRuleFileWarnings({ projectRoot = null, homeDir = null } = {}) {
  const warnings = [];
  for (const root of [homeDir || process.env.HOME || null, projectRoot]) {
    if (!root) continue;
    const rulesDir = path.join(root, '.docs-review-fix', 'rules');
    const stat = statIfExists(rulesDir);
    if (!stat || !stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
      if (!entry.name.endsWith('.md') || ALLOWED_RULE_FILE_SET.has(entry.name)) continue;
      warnings.push(unknownRuleWarning(path.join(rulesDir, entry.name)));
    }
  }
  return warnings;
}

function addLayer(layers, source, text, { custom = false } = {}) {
  if (text === undefined || text === null || text === '') return;
  if (custom) assertNoHardConstraintConflict(text);
  layers.push({ source, text });
}

function ruleSourceCategory(source) {
  const value = String(source || '');
  if (value.startsWith('user-global:')) return 'user-global';
  if (value.startsWith('project-local:')) return 'project-local';
  if (value.startsWith('user-')) return 'user-global';
  if (value.startsWith('project-')) return 'project-local';
  return 'package built-in';
}

function ruleSourceEntry(source) {
  return {
    source,
    category: ruleSourceCategory(source),
    identifier: source
  };
}

function mergeRules({ documentType, builtIn = {}, user = {}, project = {} }) {
  validateDocumentType(documentType);
  const layers = [{ source: 'hard', text: HARD_CONSTRAINTS }];

  addLayer(layers, 'built-in-common', builtIn.common ?? builtIn.COMMON);
  if (documentType !== 'COMMON') {
    addLayer(layers, `built-in-${documentType}`, builtIn.type ?? builtIn[documentType]);
  }

  const userSelected = selectRuleSections(user, documentType);
  const projectSelected = selectRuleSections(project, documentType);
  addLayer(layers, customRuleSource('user', 'COMMON'), userSelected.COMMON, { custom: true });
  if (documentType !== 'COMMON') addLayer(layers, customRuleSource('user', documentType), userSelected[documentType], { custom: true });
  addLayer(layers, customRuleSource('project', 'COMMON'), projectSelected.COMMON, { custom: true });
  if (documentType !== 'COMMON') addLayer(layers, customRuleSource('project', documentType), projectSelected[documentType], { custom: true });

  return {
    text: layers.map((layer) => `### ${layer.source}\n${layer.text}`).join('\n\n'),
    sources: layers.map((layer) => layer.source),
    layers,
    sourceList: layers.map((layer) => ruleSourceEntry(layer.source))
  };
}

module.exports = {
  ALLOWED_RULE_FILENAMES,
  CANONICAL_SECTIONS,
  parseRulebook,
  selectRuleSections,
  mergeRules,
  loadCustomRuleFiles,
  collectUnknownRuleFileWarnings,
  assertNoHardConstraintConflict,
  ruleSourceCategory,
  ruleSourceEntry
};
