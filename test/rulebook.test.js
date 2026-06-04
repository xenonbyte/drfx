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
  assertNoHardConstraintConflict,
  loadRouteRuleContext,
  ROUTE_RULE_FILENAMES
} = require('../lib/rulebook');

test('exports canonical section names in supported order', () => {
  assert.deepEqual(CANONICAL_SECTIONS, ['COMMON', 'SPEC', 'PLAN', 'DESIGN']);
  // ALLOWED_RULE_FILENAMES now also includes route-kind files PR.md and CODE.md
  assert.deepEqual(ALLOWED_RULE_FILENAMES, ['COMMON.md', 'SPEC.md', 'PLAN.md', 'DESIGN.md', 'PR.md', 'CODE.md']);
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
  assert.deepEqual(
    merged.sourceList
      .filter((item) => item.identifier.includes(':rules/'))
      .map(({ source, identifier, category }) => ({ source, identifier, category })),
    [
      {
        source: 'user-global:rules/COMMON.md',
        identifier: 'user-global:rules/COMMON.md',
        category: 'user-global'
      },
      {
        source: 'user-global:rules/SPEC.md',
        identifier: 'user-global:rules/SPEC.md',
        category: 'user-global'
      },
      {
        source: 'project-local:rules/COMMON.md',
        identifier: 'project-local:rules/COMMON.md',
        category: 'project-local'
      },
      {
        source: 'project-local:rules/SPEC.md',
        identifier: 'project-local:rules/SPEC.md',
        category: 'project-local'
      }
    ]
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
  fs.mkdirSync(path.join(homeDir, '.drfx', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.drfx', 'rules'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, homeDir, projectRoot };
}

function symlinkOrSkip(t, target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (error && ['EACCES', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test('loads only COMMON and current document type rule files', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.homeDir, '.drfx', 'rules', 'COMMON.md'), 'User common\n');
  fs.writeFileSync(path.join(fixture.homeDir, '.drfx', 'rules', 'SPEC.md'), 'User spec\n');
  fs.writeFileSync(path.join(fixture.homeDir, '.drfx', 'rules', 'PLAN.md'), 'User plan must not load\n');
  fs.writeFileSync(path.join(fixture.homeDir, '.drfx', 'rules', 'DESIGN.md'), 'User design must not load\n');
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'COMMON.md'), 'Project common\n');
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'SPEC.md'), 'Project spec\n');

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
  assert.deepEqual(
    loaded.contentPaths.map(({ source, identifier, category }) => ({ source, identifier, category })),
    [
      {
        source: 'user-global:rules/COMMON.md',
        identifier: 'user-global:rules/COMMON.md',
        category: 'user-global'
      },
      {
        source: 'user-global:rules/SPEC.md',
        identifier: 'user-global:rules/SPEC.md',
        category: 'user-global'
      },
      {
        source: 'project-local:rules/COMMON.md',
        identifier: 'project-local:rules/COMMON.md',
        category: 'project-local'
      },
      {
        source: 'project-local:rules/SPEC.md',
        identifier: 'project-local:rules/SPEC.md',
        category: 'project-local'
      }
    ]
  );
});

test('COMMON documents load only COMMON custom rule files', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.homeDir, '.drfx', 'rules', 'COMMON.md'), 'User common\n');
  fs.writeFileSync(path.join(fixture.homeDir, '.drfx', 'rules', 'SPEC.md'), 'User spec must not load\n');
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'COMMON.md'), 'Project common\n');
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'PLAN.md'), 'Project plan must not load\n');

  const loaded = loadCustomRuleFiles({
    projectRoot: fixture.projectRoot,
    documentType: 'COMMON',
    homeDir: fixture.homeDir
  });

  assert.deepEqual(loaded.user, { COMMON: 'User common' });
  assert.deepEqual(loaded.project, { COMMON: 'Project common' });
  assert.deepEqual(
    loaded.contentPaths.map(({ source, identifier, category }) => ({ source, identifier, category })),
    [
      {
        source: 'user-global:rules/COMMON.md',
        identifier: 'user-global:rules/COMMON.md',
        category: 'user-global'
      },
      {
        source: 'project-local:rules/COMMON.md',
        identifier: 'project-local:rules/COMMON.md',
        category: 'project-local'
      }
    ]
  );
});

test('missing rules directories and files return empty custom rule sets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-v3-rules-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(
    loadCustomRuleFiles({
      projectRoot,
      documentType: 'SPEC',
      homeDir
    }),
    {
      user: {},
      project: {},
      contentPaths: [],
      warnings: []
    }
  );

  fs.mkdirSync(path.join(homeDir, '.drfx', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.drfx', 'rules'), { recursive: true });

  assert.deepEqual(
    loadCustomRuleFiles({
      projectRoot,
      documentType: 'SPEC',
      homeDir
    }),
    {
      user: {},
      project: {},
      contentPaths: [],
      warnings: []
    }
  );
});

test('empty custom rule files are absent and do not add content paths', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.homeDir, '.drfx', 'rules', 'COMMON.md'), '\n');
  fs.writeFileSync(path.join(fixture.homeDir, '.drfx', 'rules', 'PLAN.md'), '');
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'COMMON.md'), '   \n\t\n');
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'PLAN.md'), '\n\n');

  const loaded = loadCustomRuleFiles({
    projectRoot: fixture.projectRoot,
    documentType: 'PLAN',
    homeDir: fixture.homeDir
  });

  assert.deepEqual(loaded.user, {});
  assert.deepEqual(loaded.project, {});
  assert.deepEqual(loaded.contentPaths, []);
});

test('rejects symlinked custom rules directories', (t) => {
  const fixture = makeRulesFixture(t);
  const externalRules = path.join(fixture.root, 'external-rules');
  const rulesDir = path.join(fixture.projectRoot, '.drfx', 'rules');
  fs.mkdirSync(externalRules);
  fs.writeFileSync(path.join(externalRules, 'COMMON.md'), 'External common must not load\n');
  fs.rmSync(rulesDir, { recursive: true, force: true });
  if (!symlinkOrSkip(t, externalRules, rulesDir, 'dir')) return;

  assert.throws(
    () => loadCustomRuleFiles({
      projectRoot: fixture.projectRoot,
      documentType: 'SPEC',
      homeDir: fixture.homeDir
    }),
    /symlink/i
  );
});

test('rejects symlinked custom rule files before reading target content', (t) => {
  for (const fileName of ['COMMON.md', 'SPEC.md']) {
    const fixture = makeRulesFixture(t);
    const linkPath = path.join(fixture.projectRoot, '.drfx', 'rules', fileName);
    const targetPath = path.join(fixture.root, 'outside-rules', fileName);
    if (!symlinkOrSkip(t, targetPath, linkPath, 'file')) return;

    assert.throws(
      () => loadCustomRuleFiles({
        projectRoot: fixture.projectRoot,
        documentType: 'SPEC',
        homeDir: fixture.homeDir
      }),
      /symlink/i
    );
  }
});

test('rejects symlinked allowed rule files that are not selected for reading', (t) => {
  const fixture = makeRulesFixture(t);
  const linkPath = path.join(fixture.projectRoot, '.drfx', 'rules', 'PLAN.md');
  const targetPath = path.join(fixture.root, 'outside-rules', 'PLAN.md');
  if (!symlinkOrSkip(t, targetPath, linkPath, 'file')) return;

  assert.throws(
    () => loadCustomRuleFiles({
      projectRoot: fixture.projectRoot,
      documentType: 'SPEC',
      homeDir: fixture.homeDir
    }),
    /symlink/i
  );
});

test('rejects stale legacy RULE.md files', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.homeDir, '.drfx', 'RULE.md'), '## COMMON\nLegacy\n');

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
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'CHECKLIST.md'), 'No aliases\n');

  assert.throws(
    () => loadCustomRuleFiles({
      projectRoot: fixture.projectRoot,
      documentType: 'PLAN',
      homeDir: fixture.homeDir
    }),
    /unknown custom rule file/i
  );
});

test('warns for unknown markdown rule files under normal strictness', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'CHECKLIST.md'), 'No aliases\n');

  const loaded = loadCustomRuleFiles({
    projectRoot: fixture.projectRoot,
    documentType: 'PLAN',
    homeDir: fixture.homeDir,
    strictness: 'normal'
  });

  assert.deepEqual(loaded.user, {});
  assert.deepEqual(loaded.project, {});
  assert.deepEqual(loaded.contentPaths, []);
  assert.equal(loaded.warnings.length, 1);
  assert.equal(loaded.warnings[0].code, 'WARN_UNKNOWN_CUSTOM_RULE_FILE');
  assert.match(loaded.warnings[0].message, /Unknown custom rule file/i);
  assert.match(loaded.warnings[0].filePath, /CHECKLIST\.md$/);
});

test('rejects unknown markdown rule files under strict strictness', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'CHECKLIST.md'), 'No aliases\n');

  assert.throws(
    () => loadCustomRuleFiles({
      projectRoot: fixture.projectRoot,
      documentType: 'PLAN',
      homeDir: fixture.homeDir,
      strictness: 'strict'
    }),
    /unknown custom rule file/i
  );
});

// ---------------------------------------------------------------------------
// Route-kind rule loading: PR and CODE
// ---------------------------------------------------------------------------

test('ROUTE_RULE_FILENAMES exports PR.md and CODE.md', () => {
  assert.ok(Array.isArray(ROUTE_RULE_FILENAMES), 'ROUTE_RULE_FILENAMES must be an array');
  assert.ok(ROUTE_RULE_FILENAMES.includes('PR.md'), 'ROUTE_RULE_FILENAMES must include PR.md');
  assert.ok(ROUTE_RULE_FILENAMES.includes('CODE.md'), 'ROUTE_RULE_FILENAMES must include CODE.md');
});

test('ALLOWED_RULE_FILENAMES includes PR.md and CODE.md in addition to document types', () => {
  assert.ok(ALLOWED_RULE_FILENAMES.includes('COMMON.md'));
  assert.ok(ALLOWED_RULE_FILENAMES.includes('SPEC.md'));
  assert.ok(ALLOWED_RULE_FILENAMES.includes('PLAN.md'));
  assert.ok(ALLOWED_RULE_FILENAMES.includes('DESIGN.md'));
  assert.ok(ALLOWED_RULE_FILENAMES.includes('PR.md'), 'ALLOWED_RULE_FILENAMES must include PR.md');
  assert.ok(ALLOWED_RULE_FILENAMES.includes('CODE.md'), 'ALLOWED_RULE_FILENAMES must include CODE.md');
});

test('CANONICAL_SECTIONS remains document-only (COMMON/SPEC/PLAN/DESIGN) — PR/CODE not added', () => {
  assert.deepEqual(CANONICAL_SECTIONS, ['COMMON', 'SPEC', 'PLAN', 'DESIGN']);
  assert.ok(!CANONICAL_SECTIONS.includes('PR'), 'PR must not be a canonical document section');
  assert.ok(!CANONICAL_SECTIONS.includes('CODE'), 'CODE must not be a canonical document section');
});

test('PR rules load in four-layer order with no COMMON layer', () => {
  const context = loadRouteRuleContext({
    routeKind: 'pr',
    builtInRubric: 'Built-in PR rubric content',
    userRules: 'User PR rules',
    projectRules: 'Project PR rules'
  });

  assert.deepEqual(
    context.layers.map((layer) => layer.name),
    ['workflow-hard-constraints', 'built-in-pr-rubric', 'user-global-pr-rules', 'project-local-pr-rules']
  );
});

test('CODE rules load in four-layer order with no COMMON layer', () => {
  const context = loadRouteRuleContext({
    routeKind: 'code',
    builtInRubric: 'Built-in CODE rubric content',
    userRules: 'User CODE rules',
    projectRules: 'Project CODE rules'
  });

  assert.deepEqual(
    context.layers.map((layer) => layer.name),
    ['workflow-hard-constraints', 'built-in-code-rubric', 'user-global-code-rules', 'project-local-code-rules']
  );
});

test('PR/CODE rule loading does NOT include a COMMON layer', () => {
  const prContext = loadRouteRuleContext({
    routeKind: 'pr',
    builtInRubric: 'PR rubric',
    userRules: 'User PR rules',
    projectRules: 'Project PR rules'
  });

  const codeContext = loadRouteRuleContext({
    routeKind: 'code',
    builtInRubric: 'CODE rubric',
    userRules: 'User CODE rules',
    projectRules: 'Project CODE rules'
  });

  for (const ctx of [prContext, codeContext]) {
    for (const layer of ctx.layers) {
      assert.ok(!layer.name.includes('common'), `Layer "${layer.name}" must not include COMMON`);
    }
  }
});

test('project-local PR rules load after user-global PR rules', () => {
  const context = loadRouteRuleContext({
    routeKind: 'pr',
    builtInRubric: 'PR rubric',
    userRules: 'User PR rules',
    projectRules: 'Project PR rules'
  });

  const names = context.layers.map((layer) => layer.name);
  const userIdx = names.indexOf('user-global-pr-rules');
  const projectIdx = names.indexOf('project-local-pr-rules');
  assert.ok(userIdx < projectIdx, 'project-local must come after user-global');

  assert.equal(context.layers[userIdx].text, 'User PR rules');
  assert.equal(context.layers[projectIdx].text, 'Project PR rules');
});

test('project-local CODE rules load after user-global CODE rules', () => {
  const context = loadRouteRuleContext({
    routeKind: 'code',
    builtInRubric: 'CODE rubric',
    userRules: 'User CODE rules',
    projectRules: 'Project CODE rules'
  });

  const names = context.layers.map((layer) => layer.name);
  const userIdx = names.indexOf('user-global-code-rules');
  const projectIdx = names.indexOf('project-local-code-rules');
  assert.ok(userIdx < projectIdx, 'project-local must come after user-global');
});

test('loadRouteRuleContext skips absent/empty user and project rules', () => {
  const context = loadRouteRuleContext({
    routeKind: 'pr',
    builtInRubric: 'PR rubric',
    userRules: null,
    projectRules: ''
  });

  // Only hard-constraints and built-in layers should be present (absent/empty are skipped)
  const names = context.layers.map((layer) => layer.name);
  assert.ok(names.includes('workflow-hard-constraints'));
  assert.ok(names.includes('built-in-pr-rubric'));
  assert.ok(!names.includes('user-global-pr-rules'), 'null user rules must not produce a layer');
  assert.ok(!names.includes('project-local-pr-rules'), 'empty project rules must not produce a layer');
});

test('loadRouteRuleContext rejects custom PR rules that weaken hard constraints', () => {
  assert.throws(
    () => loadRouteRuleContext({
      routeKind: 'pr',
      builtInRubric: 'PR rubric',
      userRules: 'Skip reviewer isolation for small PRs.',
      projectRules: null
    }),
    /hard constraint/i
  );

  assert.throws(
    () => loadRouteRuleContext({
      routeKind: 'code',
      builtInRubric: 'CODE rubric',
      userRules: null,
      projectRules: 'Bypass PASS criteria for trivial changes.'
    }),
    /hard constraint/i
  );
});

test('loadRouteRuleContext hard constraints appear in layer text', () => {
  const context = loadRouteRuleContext({
    routeKind: 'pr',
    builtInRubric: 'PR rubric',
    userRules: null,
    projectRules: null
  });

  const hardLayer = context.layers.find((layer) => layer.name === 'workflow-hard-constraints');
  assert.ok(hardLayer, 'workflow-hard-constraints layer must be present');
  assert.match(hardLayer.text, /Workflow hard constraints/);
  assert.match(hardLayer.text, /Isolated reviewers are required/);
});

test('loadRouteRuleContext rejects invalid routeKind', () => {
  assert.throws(
    () => loadRouteRuleContext({ routeKind: 'spec', builtInRubric: '', userRules: null, projectRules: null }),
    /unknown route kind/i
  );
  assert.throws(
    () => loadRouteRuleContext({ routeKind: 'COMMON', builtInRubric: '', userRules: null, projectRules: null }),
    /unknown route kind/i
  );
});

test('PR.md and CODE.md are recognized (not warned/skipped) in rules directories under normal strictness', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'PR.md'), 'PR custom rules\n');
  fs.writeFileSync(path.join(fixture.projectRoot, '.drfx', 'rules', 'CODE.md'), 'CODE custom rules\n');

  // Should NOT throw or warn under either strictness level — they are recognized
  const strictLoaded = loadCustomRuleFiles({
    projectRoot: fixture.projectRoot,
    documentType: 'PLAN',
    homeDir: fixture.homeDir,
    strictness: 'strict'
  });
  assert.deepEqual(strictLoaded.warnings, []);

  const normalLoaded = loadCustomRuleFiles({
    projectRoot: fixture.projectRoot,
    documentType: 'PLAN',
    homeDir: fixture.homeDir,
    strictness: 'normal'
  });
  assert.deepEqual(normalLoaded.warnings, []);
});

test('PR.md in user-global rules directory is recognized (not warned) under strict strictness', (t) => {
  const fixture = makeRulesFixture(t);
  fs.writeFileSync(path.join(fixture.homeDir, '.drfx', 'rules', 'PR.md'), 'User PR rules\n');

  const loaded = loadCustomRuleFiles({
    projectRoot: fixture.projectRoot,
    documentType: 'SPEC',
    homeDir: fixture.homeDir,
    strictness: 'strict'
  });
  assert.deepEqual(loaded.warnings, []);
});

test('loadRouteRuleContext reads PR.md from filesystem paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-route-rules-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(homeDir, '.drfx', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.drfx', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.drfx', 'rules', 'PR.md'), 'User PR custom rules\n');
  fs.writeFileSync(path.join(projectRoot, '.drfx', 'rules', 'PR.md'), 'Project PR custom rules\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const context = loadRouteRuleContext({
    routeKind: 'pr',
    builtInRubric: 'PR rubric',
    homeDir,
    projectRoot
  });

  const names = context.layers.map((layer) => layer.name);
  assert.ok(names.includes('user-global-pr-rules'), 'user-global layer must be present when PR.md exists');
  assert.ok(names.includes('project-local-pr-rules'), 'project-local layer must be present when PR.md exists');

  const userLayer = context.layers.find((l) => l.name === 'user-global-pr-rules');
  const projectLayer = context.layers.find((l) => l.name === 'project-local-pr-rules');
  assert.equal(userLayer.text, 'User PR custom rules');
  assert.equal(projectLayer.text, 'Project PR custom rules');
});

test('loadRouteRuleContext reads CODE.md from filesystem paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-route-rules-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(homeDir, '.drfx', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.drfx', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.drfx', 'rules', 'CODE.md'), 'User CODE rules\n');
  fs.writeFileSync(path.join(projectRoot, '.drfx', 'rules', 'CODE.md'), 'Project CODE rules\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const context = loadRouteRuleContext({
    routeKind: 'code',
    builtInRubric: 'CODE rubric',
    homeDir,
    projectRoot
  });

  const userLayer = context.layers.find((l) => l.name === 'user-global-code-rules');
  const projectLayer = context.layers.find((l) => l.name === 'project-local-code-rules');
  assert.ok(userLayer, 'user-global-code-rules layer must be present');
  assert.ok(projectLayer, 'project-local-code-rules layer must be present');
  assert.equal(userLayer.text, 'User CODE rules');
  assert.equal(projectLayer.text, 'Project CODE rules');
});

test('loadRouteRuleContext defaults user route rules to process.env.HOME when homeDir is omitted', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-route-rules-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(homeDir, '.drfx', 'rules'), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.drfx', 'rules', 'CODE.md'), 'User CODE rules from env HOME\n');
  const oldHome = process.env.HOME;
  process.env.HOME = homeDir;
  t.after(() => {
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const context = loadRouteRuleContext({
    routeKind: 'code',
    builtInRubric: 'CODE rubric',
    projectRoot
  });

  const userLayer = context.layers.find((l) => l.name === 'user-global-code-rules');
  assert.ok(userLayer, 'user-global-code-rules layer must be present from process.env.HOME');
  assert.equal(userLayer.text, 'User CODE rules from env HOME');
});

test('loadRouteRuleContext rejects symlinked PR.md rule file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-route-rules-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(homeDir, '.drfx', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.drfx', 'rules'), { recursive: true });
  const linkPath = path.join(projectRoot, '.drfx', 'rules', 'PR.md');
  const targetPath = path.join(root, 'outside', 'PR.md');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  try {
    fs.symlinkSync(targetPath, linkPath, 'file');
  } catch (error) {
    if (error && ['EACCES', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.throws(
    () => loadRouteRuleContext({ routeKind: 'pr', builtInRubric: 'PR rubric', homeDir, projectRoot }),
    /symlink/i
  );
});

test('loadRouteRuleContext rejects symlinked route rules directory before reading PR.md', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-route-rules-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const externalRules = path.join(root, 'external-rules');
  fs.mkdirSync(path.join(projectRoot, '.drfx'), { recursive: true });
  fs.mkdirSync(externalRules, { recursive: true });
  fs.writeFileSync(path.join(externalRules, 'PR.md'), 'External PR rules must not load\n');
  const rulesDir = path.join(projectRoot, '.drfx', 'rules');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  if (!symlinkOrSkip(t, externalRules, rulesDir, 'dir')) return;

  assert.throws(
    () => loadRouteRuleContext({ routeKind: 'pr', builtInRubric: 'PR rubric', homeDir, projectRoot }),
    /symlink/i
  );
});

test('loadRouteRuleContext absent PR.md files yield empty layers and no error', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-route-rules-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  // No rules directories at all
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const context = loadRouteRuleContext({
    routeKind: 'pr',
    builtInRubric: 'PR rubric',
    homeDir,
    projectRoot
  });

  const names = context.layers.map((l) => l.name);
  assert.ok(!names.includes('user-global-pr-rules'));
  assert.ok(!names.includes('project-local-pr-rules'));
});

test('loadRouteRuleContext with empty PR.md files skips those layers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-route-rules-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(homeDir, '.drfx', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.drfx', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.drfx', 'rules', 'PR.md'), '\n\n');
  fs.writeFileSync(path.join(projectRoot, '.drfx', 'rules', 'PR.md'), '   \n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const context = loadRouteRuleContext({
    routeKind: 'pr',
    builtInRubric: 'PR rubric',
    homeDir,
    projectRoot
  });

  const names = context.layers.map((l) => l.name);
  assert.ok(!names.includes('user-global-pr-rules'), 'empty user PR.md must not produce a layer');
  assert.ok(!names.includes('project-local-pr-rules'), 'empty project PR.md must not produce a layer');
});
