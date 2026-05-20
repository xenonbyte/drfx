'use strict';

const CANONICAL_SECTIONS = Object.freeze(['COMMON', 'SPEC', 'PLAN', 'DESIGN']);
const SECTION_SET = new Set(CANONICAL_SECTIONS);
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

function addLayer(layers, source, text, { custom = false } = {}) {
  if (text === undefined || text === null || text === '') return;
  if (custom) assertNoHardConstraintConflict(text);
  layers.push({ source, text });
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
  addLayer(layers, 'user-COMMON', userSelected.COMMON, { custom: true });
  if (documentType !== 'COMMON') addLayer(layers, `user-${documentType}`, userSelected[documentType], { custom: true });
  addLayer(layers, 'project-COMMON', projectSelected.COMMON, { custom: true });
  if (documentType !== 'COMMON') addLayer(layers, `project-${documentType}`, projectSelected[documentType], { custom: true });

  return {
    text: layers.map((layer) => `### ${layer.source}\n${layer.text}`).join('\n\n'),
    sources: layers.map((layer) => layer.source),
    layers
  };
}

module.exports = {
  CANONICAL_SECTIONS,
  parseRulebook,
  selectRuleSections,
  mergeRules,
  assertNoHardConstraintConflict
};
