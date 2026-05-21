'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ALLOWED_RULE_FILENAMES,
  CANONICAL_SECTIONS,
  parseRulebook,
  selectRuleSections,
  mergeRules,
  loadCustomRuleFiles,
  assertNoHardConstraintConflict
} = require('../lib/rulebook');

test('exports canonical section names in supported order', () => {
  assert.deepEqual(CANONICAL_SECTIONS, ['COMMON', 'SPEC', 'PLAN', 'DESIGN']);
  assert.deepEqual(ALLOWED_RULE_FILENAMES, ['COMMON.md', 'SPEC.md', 'PLAN.md', 'DESIGN.md']);
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
    'hard > built-in-common > user-global:rules/COMMON.md > project-local:rules/COMMON.md'
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
    'hard > built-in-common > built-in-SPEC > user-global:rules/COMMON.md > user-global:rules/SPEC.md > project-local:rules/COMMON.md > project-local:rules/SPEC.md'
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
    { source: 'project-local:rules/COMMON.md', text: 'Tone: match product docs' },
    { source: 'project-local:rules/DESIGN.md', text: 'Require implementation-ready decisions' }
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

function makeRulesFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-v3-rules-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(homeDir, '.docs-review-fix', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.docs-review-fix', 'rules'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, homeDir, projectRoot };
}

test('loads only COMMON and current document type rule files', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.homeDir, '.docs-review-fix', 'rules', 'COMMON.md'), 'User common\n');
  fs.writeFileSync(path.join(fixture.homeDir, '.docs-review-fix', 'rules', 'SPEC.md'), 'User spec\n');
  fs.writeFileSync(path.join(fixture.homeDir, '.docs-review-fix', 'rules', 'PLAN.md'), 'User plan must not load\n');
  fs.writeFileSync(path.join(fixture.homeDir, '.docs-review-fix', 'rules', 'DESIGN.md'), 'User design must not load\n');
  fs.writeFileSync(path.join(fixture.projectRoot, '.docs-review-fix', 'rules', 'COMMON.md'), 'Project common\n');
  fs.writeFileSync(path.join(fixture.projectRoot, '.docs-review-fix', 'rules', 'SPEC.md'), 'Project spec\n');

  const loaded = loadCustomRuleFiles({
    projectRoot: fixture.projectRoot,
    documentType: 'SPEC',
    homeDir: fixture.homeDir
  });

  assert.deepEqual(loaded.user, {
    COMMON: 'User common',
    SPEC: 'User spec'
  });
  assert.deepEqual(loaded.project, {
    COMMON: 'Project common',
    SPEC: 'Project spec'
  });
  assert.deepEqual(loaded.contentPaths.map((item) => item.identifier), [
    'user-global:rules/COMMON.md',
    'user-global:rules/SPEC.md',
    'project-local:rules/COMMON.md',
    'project-local:rules/SPEC.md'
  ]);
});

test('COMMON documents load only COMMON custom rule files', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.homeDir, '.docs-review-fix', 'rules', 'COMMON.md'), 'User common\n');
  fs.writeFileSync(path.join(fixture.homeDir, '.docs-review-fix', 'rules', 'SPEC.md'), 'User spec must not load\n');
  fs.writeFileSync(path.join(fixture.projectRoot, '.docs-review-fix', 'rules', 'COMMON.md'), 'Project common\n');
  fs.writeFileSync(path.join(fixture.projectRoot, '.docs-review-fix', 'rules', 'PLAN.md'), 'Project plan must not load\n');

  const loaded = loadCustomRuleFiles({
    projectRoot: fixture.projectRoot,
    documentType: 'COMMON',
    homeDir: fixture.homeDir
  });

  assert.deepEqual(loaded.user, { COMMON: 'User common' });
  assert.deepEqual(loaded.project, { COMMON: 'Project common' });
  assert.deepEqual(loaded.contentPaths.map((item) => item.identifier), [
    'user-global:rules/COMMON.md',
    'project-local:rules/COMMON.md'
  ]);
});

test('rejects stale legacy RULE.md files', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.homeDir, '.docs-review-fix', 'RULE.md'), '## COMMON\nLegacy\n');

  assert.throws(
    () => loadCustomRuleFiles({
      projectRoot: fixture.projectRoot,
      documentType: 'SPEC',
      homeDir: fixture.homeDir
    }),
    /legacy RULE\.md/i
  );
});

test('rejects unknown markdown files in custom rules directory', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.projectRoot, '.docs-review-fix', 'rules', 'CHECKLIST.md'), 'No aliases\n');

  assert.throws(
    () => loadCustomRuleFiles({
      projectRoot: fixture.projectRoot,
      documentType: 'PLAN',
      homeDir: fixture.homeDir
    }),
    /unknown custom rule file/i
  );
});
