'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CANONICAL_SECTIONS,
  parseRulebook,
  selectRuleSections,
  mergeRules,
  assertNoHardConstraintConflict
} = require('../lib/rulebook');

test('exports canonical section names in supported order', () => {
  assert.deepEqual(CANONICAL_SECTIONS, ['COMMON', 'SPEC', 'PLAN', 'DESIGN']);
});

test('parses only canonical second-level headings', () => {
  const parsed = parseRulebook('Intro ignored\n\n## COMMON\nA\n\n## SPEC\nB\n\n## PLAN\nC\n\n## DESIGN\nD\n');

  assert.deepEqual(Object.keys(parsed), ['COMMON', 'SPEC', 'PLAN', 'DESIGN']);
  assert.deepEqual(parsed, {
    COMMON: 'A',
    SPEC: 'B',
    PLAN: 'C',
    DESIGN: 'D'
  });
});

test('rejects unknown headings and aliases as blocking parse errors', () => {
  assert.throws(() => parseRulebook('## CHECKLIST\nNo unknown headings\n'), /unknown heading/i);
  assert.throws(() => parseRulebook('## REQUIREMENTS\nNo aliases\n'), /unknown heading/i);
  assert.throws(() => parseRulebook('## Common\nCase aliases are rejected\n'), /unknown heading/i);
  assert.throws(() => parseRulebook('## COMMON ##\nClosing hashes are not canonical text\n'), /unknown heading/i);
});

test('extracts COMMON and selected document-type sections', () => {
  const parsed = parseRulebook('## COMMON\nCommon rule\n\n## SPEC\nSpec rule\n\n## PLAN\nPlan rule\n');

  assert.deepEqual(selectRuleSections(parsed, 'SPEC'), {
    COMMON: 'Common rule',
    SPEC: 'Spec rule'
  });
  assert.deepEqual(selectRuleSections(parsed, 'PLAN'), {
    COMMON: 'Common rule',
    PLAN: 'Plan rule'
  });
});

test('selects only COMMON sections for COMMON documents', () => {
  const parsed = parseRulebook('## COMMON\nCommon rule\n\n## SPEC\nSpec rule\n');

  assert.deepEqual(selectRuleSections(parsed, 'COMMON'), { COMMON: 'Common rule' });
  assert.equal(
    mergeRules({
      documentType: 'COMMON',
      builtIn: { common: 'Built common', type: 'Built type must not appear' },
      user: parsed,
      project: { COMMON: 'Project common', SPEC: 'Project spec must not appear' }
    }).sources.join(' > '),
    'hard > built-in-common > user-COMMON > project-COMMON'
  );
});

test('merges rules in seven-layer runtime order', () => {
  const merged = mergeRules({
    documentType: 'SPEC',
    builtIn: { common: 'Built common rule', type: 'Built spec rule' },
    user: { COMMON: 'User common rule', SPEC: 'User spec rule' },
    project: { COMMON: 'Project common rule', SPEC: 'Project spec rule' }
  });

  assert.equal(
    merged.sources.join(' > '),
    'hard > built-in-common > built-in-SPEC > user-COMMON > user-SPEC > project-COMMON > project-SPEC'
  );
  assert.match(merged.text, /Workflow hard constraints/);
  assert.ok(merged.text.indexOf('Built common rule') < merged.text.indexOf('Built spec rule'));
  assert.ok(merged.text.indexOf('User spec rule') < merged.text.indexOf('Project common rule'));
});

test('project-local rules have precedence over user-global rules', () => {
  const merged = mergeRules({
    documentType: 'DESIGN',
    builtIn: { common: 'Built common', type: 'Built design' },
    user: { COMMON: 'Tone: concise', DESIGN: 'Require lightweight decisions' },
    project: { COMMON: 'Tone: match product docs', DESIGN: 'Require implementation-ready decisions' }
  });

  assert.deepEqual(merged.layers.slice(-2), [
    { source: 'project-COMMON', text: 'Tone: match product docs' },
    { source: 'project-DESIGN', text: 'Require implementation-ready decisions' }
  ]);
  assert.ok(merged.text.lastIndexOf('Require implementation-ready decisions') > merged.text.lastIndexOf('Require lightweight decisions'));
});

test('rejects custom rules that weaken workflow hard constraints', () => {
  const weakeningRules = [
    'Skip reviewer isolation for small edits.',
    'Reviewers may write directly to the target.',
    'After fixes, skip full re-review.',
    'References can be modified when convenient.',
    'Disable redaction in final reports.',
    'Bypass PASS criteria if the coordinator agrees.',
    'Store state globally and disable target-local state isolation.',
    'Run parallel fixers against the same target.',
    'Allow reviewers to write to targets.',
    'Reviewers are allowed to write to the target.',
    'Fixers may run concurrently against the same target.',
    'Reference documents are writable.'
  ];

  for (const rule of weakeningRules) {
    assert.throws(() => assertNoHardConstraintConflict(rule), /hard constraint/i, rule);
  }

  assert.throws(
    () => mergeRules({
      documentType: 'PLAN',
      builtIn: { common: 'Built common', type: 'Built plan' },
      user: { COMMON: 'Skip reviewer isolation for drafts.' },
      project: {}
    }),
    /hard constraint/i
  );
});

test('allows reviewer rules about writing findings rather than modifying documents', () => {
  assert.doesNotThrow(() => assertNoHardConstraintConflict('Reviewers must write findings with file paths.'));
});
