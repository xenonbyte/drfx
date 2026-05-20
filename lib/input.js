'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DOCUMENT_TYPES = Object.freeze({
  'review-fix-spec': 'SPEC',
  'review-fix-plan': 'PLAN',
  'review-fix-design': 'DESIGN',
  'review-fix-doc': 'COMMON'
});

const STRICTNESS_FLAGS = new Set(['strict', 'normal']);
const MODE_FLAGS = new Set(['read-only', 'review-and-fix']);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseKeyValue(token) {
  const index = token.indexOf('=');
  if (index === -1) return null;
  return [token.slice(0, index), token.slice(index + 1)];
}

function unique(values) {
  return Array.from(new Set(values));
}

function documentTypeFor(entrySkill) {
  const documentType = DOCUMENT_TYPES[entrySkill];
  if (!documentType) fail('ERR_UNKNOWN_ENTRY_SKILL', `Unknown entry skill: ${entrySkill}`);
  return documentType;
}

function parseInvocation(entrySkill, tokens) {
  const documentType = documentTypeFor(entrySkill);
  const result = {
    entrySkill,
    documentType,
    target: null,
    refs: [],
    strictness: 'normal',
    mode: 'review-and-fix',
    resume: false,
    ledger: null,
    root: null
  };
  let sawTarget = false;
  let sawBareTarget = false;
  let sawRoot = false;
  let sawStrictness = false;
  let sawMode = false;

  for (const token of tokens) {
    const pair = parseKeyValue(token);
    if (pair) {
      const [key, value] = pair;
      if (key === 'target') {
        if (sawTarget || sawBareTarget) fail('ERR_DUPLICATE_TARGET', 'Duplicate target document');
        sawTarget = true;
        result.target = value;
        continue;
      }
      if (key === 'ref') {
        result.refs.push(value);
        continue;
      }
      if (key === 'ledger') {
        result.ledger = value;
        continue;
      }
      if (key === 'root') {
        if (sawRoot) fail('ERR_DUPLICATE_ROOT', 'Duplicate root path');
        sawRoot = true;
        result.root = value;
        continue;
      }
      if (key === 'type') {
        fail('ERR_TYPE_OVERRIDE', 'Document type is fixed by entry skill and must not be supplied');
      }
      fail('ERR_UNKNOWN_TOKEN', `Unknown token: ${token}`);
    }

    if (STRICTNESS_FLAGS.has(token)) {
      if (sawStrictness && result.strictness !== token) {
        fail('ERR_CONFLICTING_STRICTNESS', 'strict and normal are mutually exclusive');
      }
      sawStrictness = true;
      result.strictness = token;
      continue;
    }

    if (MODE_FLAGS.has(token)) {
      if (sawMode && result.mode !== token) {
        fail('ERR_CONFLICTING_MODE', 'read-only and review-and-fix are mutually exclusive');
      }
      sawMode = true;
      result.mode = token;
      continue;
    }

    if (token === 'resume') {
      result.resume = true;
      continue;
    }

    if (token.startsWith('-')) fail('ERR_UNKNOWN_TOKEN', `Unknown token: ${token}`);
    if (sawTarget) fail('ERR_UNLABELED_PATH', `Unlabeled path is invalid when target= is present: ${token}`);
    if (sawBareTarget) fail('ERR_UNLABELED_PATH', `Multiple unlabeled paths are ambiguous: ${token}`);
    sawBareTarget = true;
    result.target = token;
  }

  result.refs = unique(result.refs);
  if (!result.target) fail('ERR_MISSING_TARGET', 'Missing target document');
  return result;
}

function parseNaturalLanguageInvocation(entrySkill, text) {
  const documentType = documentTypeFor(entrySkill);
  const pathPattern = /[A-Za-z0-9_./-]+\.md/g;
  const paths = text.match(pathPattern) || [];
  const editMatch = text.match(/(?:修改|修复|fix|review and fix)\s+([A-Za-z0-9_./-]+\.md)/i);
  const refs = Array.from(text.matchAll(/(?:参考|对照|reference|ref)\s+([A-Za-z0-9_./-]+\.md)/gi), (match) => match[1]);

  if (!editMatch || paths.length !== 1 + refs.length) {
    fail('ERR_AMBIGUOUS_NATURAL_LANGUAGE', 'Ambiguous natural-language input; use target= and ref=');
  }

  return {
    entrySkill,
    documentType,
    target: editMatch[1],
    refs: unique(refs),
    strictness: /\bstrict\b/.test(text) ? 'strict' : 'normal',
    mode: /\bread-only\b/.test(text) ? 'read-only' : 'review-and-fix',
    resume: /\bresume\b/.test(text),
    ledger: null,
    root: null
  };
}

function realExistingFile(filePath, label) {
  const absolute = path.resolve(filePath);
  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    const code = label === 'target' ? 'ERR_TARGET_MISSING' : 'ERR_REFERENCE_MISSING';
    fail(code, `${label} document must exist: ${filePath}`);
  }
  if (!stats.isFile()) {
    const code = label === 'target' ? 'ERR_TARGET_MISSING' : 'ERR_REFERENCE_MISSING';
    fail(code, `${label} document must exist: ${filePath}`);
  }
  return fs.realpathSync.native(absolute);
}

function realExistingDirectory(directoryPath, label) {
  const absolute = path.resolve(directoryPath);
  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    fail('ERR_ROOT_MISSING', `${label} path must exist: ${directoryPath}`);
  }
  if (!stats.isDirectory()) fail('ERR_ROOT_MISSING', `${label} path must exist: ${directoryPath}`);
  return fs.realpathSync.native(absolute);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateEntryPaths({ target, refs = [], root }) {
  if (!target) fail('ERR_MISSING_TARGET', 'Missing target document');

  const targetPath = realExistingFile(target, 'target');
  const projectRoot = root ? realExistingDirectory(root, 'root') : null;

  if (projectRoot && !isInside(targetPath, projectRoot)) {
    fail('ERR_ROOT_CONTAINMENT', `root must contain target: ${root}`);
  }

  const references = refs.map((ref) => {
    const refPath = realExistingFile(ref, 'reference');
    if (refPath === targetPath) fail('ERR_REF_EQUALS_TARGET', 'reference path resolves to target path');
    return {
      path: refPath,
      readOnly: true,
      external: projectRoot ? !isInside(refPath, projectRoot) : null
    };
  });

  return {
    targetPath,
    projectRoot,
    references
  };
}

module.exports = {
  DOCUMENT_TYPES,
  parseInvocation,
  parseNaturalLanguageInvocation,
  validateEntryPaths
};
