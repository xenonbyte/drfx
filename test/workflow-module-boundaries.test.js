'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WORKFLOW_DIR = path.join(__dirname, '..', 'lib', 'workflow');

const MODULE_RULES = {
  'no-state.js': new Set([
    'runNoStatePreflight',
    'runWriteEligibilityPreflight',
    'runNoStateContext',
    'runNoStateRecordReview',
    'runNoStateRecordTriage',
    'runNoStateFinalize',
    'runNoStateWorkflowCommand'
  ]),
  'persistent-context.js': new Set([
    'runPersistentContext',
    'runPersistentRecordReview',
    'runPersistentRecordTriage'
  ]),
  'fix-lifecycle.js': new Set([
    'runBeginFix',
    'runRefreshLock',
    'runEndFix',
    'runAbortFix',
    'runFixLifecycleCommand'
  ]),
  'diff-review.js': new Set(['runRecordDiffReview']),
  'finalize.js': new Set(['runPersistentFinalize', 'runPersistentResume']),
  'start.js': new Set(['runPersistentStart']),
  // PLAN-TASK-009 (Phase C): file-set (PR/CODE) persistent lifecycle submodules.
  'file-set-context.js': new Set([
    'runFileSetContext',
    'runFileSetRecordReview',
    'runFileSetRecordTriage'
  ]),
  'file-set-finalize.js': new Set([
    'runFileSetResume',
    'runFileSetRecordDiffReview',
    'runFileSetFinalize'
  ]),
  // PLAN-TASK-010/011: r2p gate-freshness revalidation + identity helpers. Carries no
  // task-boundary run* entrypoints (its exports are revalidateR2pGate and shaping helpers).
  'file-set-r2p-gate.js': new Set([]),
  'file-set-fix.js': new Set([
    'runBeginFix',
    'runRefreshLock',
    'runEndFix',
    'runAbortFix',
    'runFileSetFixLifecycleCommand'
  ]),
  'file-set-no-state.js': new Set([
    'runFileSetNoStateContext',
    'runFileSetNoStatePreflight',
    'runFileSetWriteEligibilityPreflight',
    'runFileSetNoStateRecordReview',
    'runFileSetNoStateRecordTriage',
    'runFileSetNoStateFinalize',
    'runFileSetNoStateWorkflowCommand'
  ])
};

const FORBIDDEN_ENTRYPOINTS = [
  'parseWorkflowArgs',
  'runWorkflowCommand'
];

function readModule(fileName) {
  return fs.readFileSync(path.join(WORKFLOW_DIR, fileName), 'utf8');
}

function topLevelRunFunctions(source) {
  return [...source.matchAll(/^function (run[A-Z][A-Za-z0-9_]*)\(/gm)].map((match) => match[1]);
}

function helperImportsFrom(fileName) {
  const source = readModule(fileName);
  const match = source.match(/const\s*\{([\s\S]*?)\}\s*=\s*require\('\.\/helpers'\);/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

test('workflow submodules keep only task-boundary run functions', () => {
  for (const [fileName, allowed] of Object.entries(MODULE_RULES)) {
    const source = readModule(fileName);
    const unexpected = topLevelRunFunctions(source).filter((name) => !allowed.has(name));

    assert.deepEqual(unexpected, [], fileName);
  }
});

test('workflow submodules do not redeclare public parser or dispatcher entrypoints', () => {
  for (const fileName of Object.keys(MODULE_RULES)) {
    const source = readModule(fileName);
    for (const functionName of FORBIDDEN_ENTRYPOINTS) {
      assert.doesNotMatch(source, new RegExp(`^function ${functionName}\\(`, 'm'), `${fileName}:${functionName}`);
    }
  }
});

test('workflow submodules stay below the task split size ceiling', () => {
  for (const fileName of Object.keys(MODULE_RULES)) {
    const lineCount = readModule(fileName).split('\n').length;

    assert.ok(lineCount < 1000, `${fileName} has ${lineCount} lines`);
  }
});

test('workflow helpers exports match only what submodules import', () => {
  const expected = new Set();
  for (const fileName of Object.keys(MODULE_RULES)) {
    for (const name of helperImportsFrom(fileName)) expected.add(name);
  }
  const actual = Object.keys(require('../lib/workflow/helpers'));

  assert.deepEqual(actual.sort(), [...expected].sort());
});

test('workflow helpers stays below boundary ceiling', () => {
  const lineCount = readModule('helpers.js').split('\n').length;

  assert.ok(lineCount < 2500, `helpers.js has ${lineCount} lines`);
});
