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
  'start.js': new Set(['runPersistentStart'])
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
