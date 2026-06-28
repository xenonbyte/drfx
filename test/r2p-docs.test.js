'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderPlatformRoute } = require('../lib/generator');

const REPO_ROOT = path.join(__dirname, '..');
const DOC_FILES = [
  'skills/review-fix-r2p/SKILL.md',
  'shared/prompts/coordinator.md',
  'shared/prompts/fixer.md'
];
const SEARCH_DIRS = ['lib', 'test'];
const RETIRED_MODULE_STEM = ['file', 'set', 'r2p', 'gate'].join('-');
const RETIRED_IMPORT_RE = new RegExp(`require\\(['"][^'"]*${RETIRED_MODULE_STEM}['"]\\)`);

function walkJsFiles(rootDir) {
  const pending = [rootDir];
  const files = [];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

test('gate11 r2p docs describe only the new model, no legacy/migration language', () => {
  for (const relativePath of DOC_FILES) {
    const text = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

    assert.match(text, /workId/, relativePath);
    assert.doesNotMatch(text, /target=<requirement-dir>|\br2q\b|migrat|backward compat/i, relativePath);
  }
});

test('generated r2p routes omit legacy rollback guidance', () => {
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    const rendered = renderPlatformRoute(platform, 'review-fix-r2p', { packageVersion: '0.0.0-test' });

    assert.doesNotMatch(
      rendered,
      /rollback-unavailable|target-only-guard-unavailable|clean rollback anchor|target-only guard (?:is unavailable|proof|unparseable)/i,
      platform
    );
    assert.match(rendered, /workId=<WF-\.\.\.>/, platform);
    assert.match(rendered, /r2p-reopen|r2p-gap-open/, platform);
  }
});

test('no source file imports the retired file-set-r2p-gate module', () => {
  const offenders = [];

  for (const relativeDir of SEARCH_DIRS) {
    const rootDir = path.join(REPO_ROOT, relativeDir);
    for (const filePath of walkJsFiles(rootDir)) {
      const source = fs.readFileSync(filePath, 'utf8');
      if (RETIRED_IMPORT_RE.test(source)) {
        offenders.push(path.relative(REPO_ROOT, filePath));
      }
    }
  }

  assert.deepEqual(offenders, []);
});
