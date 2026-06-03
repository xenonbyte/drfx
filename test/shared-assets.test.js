'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { renderPlatformRoute, generatePlatformFiles } = require('../lib/generator');
const { buildFinalResponseChecklist } = require('../lib/final-response');
const { listDocumentRoutes } = require('../lib/routes');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('shared core contains canonical loop and no runtime memory dependency', () => {
  const core = read('shared/core.md');

  assert.match(core, /review -> triage -> fix -> diff review -> full re-review/);
  assert.match(core, /runtime objective\/session\/platform memory/i);
  assert.match(core, /must not depend/i);
});

test('shared core specifies reviewer mutation detection without requiring a second reviewer', () => {
  const core = read('shared/core.md');

  assert.match(core, /record SHA-256, file size, and modified timestamp for the target and all reference documents/i);
  assert.match(core, /After the reviewer returns, recompute the same fingerprints/i);
  assert.match(core, /reviewer-mutated-file/i);
  assert.match(core, /Do not fix or claim PASS after a reviewer mutation/i);
  assert.doesNotMatch(core, /\b(second|2nd|two)\s+reviewers?\b/i);
});

test('shared prompts expose reviewer and fixer schemas', () => {
  const reviewer = read('shared/prompts/reviewer.md');
  const fixer = read('shared/prompts/fixer.md');

  assert.match(reviewer, /\bPASS\b/);
  assert.match(reviewer, /\bFAIL\b/);
  assert.match(reviewer, /why_it_matters/);

  for (const heading of ['Fixed:', 'Files changed:', 'Not fixed:', 'Residual risk:']) {
    assert.match(fixer, new RegExp(`^${heading}$`, 'm'));
  }
});

test('fixer prompt has no writable scope escape hatch', () => {
  const fixer = read('shared/prompts/fixer.md');

  assert.doesNotMatch(fixer, /unless explicitly instructed/i);
  assert.match(fixer, /may modify only the target document|modify only the target document/i);
  assert.match(fixer, /references? and other files remain read-only|reference documents.*read-only/i);
});

test('coordinator prompt contains complete reviewer context pack fields', () => {
  const coordinator = read('shared/prompts/coordinator.md');

  for (const matcher of [
    /Target document:\s*<path>/i,
    /Reference documents:\s*<paths, read-only>/i,
    /Document type:\s*<SPEC\|PLAN\|DESIGN\|COMMON>/i,
    /Strictness:\s*<normal\|strict>/i,
    /Mode:\s*<review-and-fix\|read-only>/i,
    /Objective:/i,
    /Merged (review )?rule set:/i,
    /Accepted non-blocking low issues:/i,
    /Constraints:/i,
    /Output schema:/i
  ]) {
    assert.match(coordinator, matcher);
  }
});

test('coordinator prompt locks triage decisions and PASS blocking rules', () => {
  const coordinator = read('shared/prompts/coordinator.md');

  for (const decision of ['accepted', 'merged', 'downgraded', 'rejected', 'deferred']) {
    assert.match(coordinator, new RegExp(`\\b${decision}\\b`, 'i'), decision);
  }
  assert.match(coordinator, /accepted high\/medium findings block PASS|accepted high and medium findings block PASS/i);
  assert.match(coordinator, /deferred high\/medium.*stopped-with-deferrals|deferred high and medium.*stopped-with-deferrals/i);
  assert.match(coordinator, /low findings block only in strict mode unless accepted non-blocking/i);
});

test('coordinator prompt requires diff review checks before full re-review', () => {
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(coordinator, /diff review/i);
  assert.match(coordinator, /issue mapping/i);
  assert.match(coordinator, /unrelated scope/i);
  assert.match(coordinator, /terminology/i);
  assert.match(coordinator, /placeholders/i);
  assert.match(coordinator, /readability/i);
  assert.match(coordinator, /structural coherence/i);
  assert.match(coordinator, /before full re-review/i);
});

test('coordinator prompt includes final response contract text', () => {
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(coordinator, /Final response:/i);
  assert.match(coordinator, /final status/i);
  assert.match(coordinator, /changes made/i);
  assert.match(coordinator, /files changed/i);
  assert.match(coordinator, /verification performed/i);
  assert.match(coordinator, /not fixed|deferrals|blockers|unsupported/i);
  assert.match(coordinator, /residual risk/i);
  assert.match(coordinator, /none identified/i);
  assert.match(coordinator, /deferrals?[^\n]*issue IDs[^\n]*reason[^\n]*owner[^\n]*next action/i);
});

test('reviewer and coordinator distinguish reference conflicts from coverage gaps', () => {
  const reviewer = read('shared/prompts/reviewer.md');
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(reviewer, /ref=.*consistency/i);
  assert.match(reviewer, /Do not fail/i);
  assert.match(reviewer, /Design Coverage Import/i);
  assert.match(reviewer, /SPEC-to-task mapping/i);
  assert.match(reviewer, /complete coverage claim/i);
  assert.match(reviewer, /reference conflict/i);

  assert.match(coordinator, /false blocker/i);
  assert.match(coordinator, /coverage table/i);
  assert.match(coordinator, /upstream mapping/i);
  assert.match(coordinator, /reclassify/i);
  assert.match(coordinator, /do not rewrite/i);
});

test('fixer prompt keeps writes target-only and issue-bounded', () => {
  const fixer = read('shared/prompts/fixer.md');

  assert.match(fixer, /may modify only the target document/i);
  assert.match(fixer, /coordinator-accepted issue IDs/i);
  assert.match(fixer, /Reference documents:\s*<paths, read-only>/i);
  assert.match(fixer, /references and other files remain read-only/i);
  assert.match(fixer, /Do not (?:add|invent) new background, requirements, or external facts/i);
  assert.match(fixer, /Do not (?:perform a )?broad rewrite unless an accepted structural issue/i);
});

test('reviewer prompt states reviewers are read-only and must emit why_it_matters', () => {
  const reviewer = read('shared/prompts/reviewer.md');

  assert.match(reviewer, /Mode: read-only/i);
  assert.match(reviewer, /Do not modify files/i);
  assert.match(reviewer, /why_it_matters/);
});

test('deferred issue metadata and final response next action are both documented', () => {
  const core = read('shared/core.md');
  const longTask = read('shared/long-task.md');
  const readme = read('README.md');

  assert.match(core, /deferred[^\n]*reason and owner/i);
  assert.match(longTask, /deferred[^\n]*reason and owner/i);
  assert.match(core, /stopped-with-deferrals[^\n]*internal workflow payload[^\n]*issue IDs[^\n]*reasons?[^\n]*owners?[^\n]*next action/i);
  assert.match(core, /Default user output[^\n]*Unfixed\/Next[^\n]*without internal issue IDs/i);
  assert.match(readme, /deferrals?[^\n]*reason[^\n]*owner[^\n]*next action/i);
});

test('manifest records reference paths without per-reference read-only flags', () => {
  const longTask = read('shared/long-task.md');

  assert.doesNotMatch(longTask, /Reference documents, marked read-only/i);
  assert.match(longTask, /manifest records reference paths/i);
  assert.match(longTask, /read-only role is preserved in context packs\/normalized references/i);
});

test('type rubrics contain required explicit coverage terms', () => {
  const spec = read('shared/rubrics/spec.md');
  const design = read('shared/rubrics/design.md');

  assert.match(spec, /implementation fit/i);
  assert.match(design, /implementation detail/i);
});

test('stage-aware rubrics use reference conformance without mandatory upstream chains', () => {
  const core = read('shared/core.md');
  const common = read('shared/rubrics/common.md');
  const design = read('shared/rubrics/design.md');
  const spec = read('shared/rubrics/spec.md');
  const plan = read('shared/rubrics/plan.md');
  const sharedText = [core, common, design, spec, plan].join('\n\n');
  const publicAndPromptText = [
    'README.md',
    'shared/prompts/reviewer.md',
    'shared/prompts/coordinator.md',
    'templates/codex-skill.md.tmpl',
    'templates/claude-command.md.tmpl',
    'templates/gemini-command.toml.tmpl',
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md'
  ].map(read).join('\n\n');
  const renderedRoutes = [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-plan', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('gemini', 'review-fix-design', { packageVersion: '0.0.0-test' })
  ].join('\n\n');
  const allReviewText = [sharedText, publicAndPromptText, renderedRoutes].join('\n\n');

  assert.match(core, /Reference Conformance/);
  assert.match(core, /reference documents/i);
  assert.match(core, /consistency sources/i);
  assert.match(core, /not mandatory upstream chains/i);
  assert.match(core, /complete coverage claim/i);
  assert.match(core, /reference conflict/i);
  assert.match(core, /unsupported new requirement/i);

  assert.match(common, /document type fit/i);
  assert.match(common, /Reference Conformance/i);

  assert.match(design, /stage-aware/i);
  assert.match(design, /does not require downstream SPEC or PLAN handoff tables/i);
  assert.match(design, /reference documents/i);

  assert.match(spec, /A SPEC does not require a DESIGN reference/i);
  assert.match(spec, /Design Coverage Import is optional/i);
  assert.match(spec, /reference conflict/i);

  assert.match(plan, /A PLAN does not require a SPEC reference/i);
  assert.match(plan, /SPEC-to-task mapping is optional/i);
  assert.match(plan, /stop condition/i);

  for (const forbidden of [
    /Every PLAN task must reference at least one SPEC/i,
    /PLAN requires a SPEC reference/i,
    /SPEC requires a DESIGN reference/i,
    /SPEC must include Design Coverage Import/i,
    /Design Coverage Import is required/i,
    /SPEC-to-task mapping is required/i,
    /must include `?Design Coverage Import`?/i,
    /must include `?SPEC-to-task mapping`?/i
  ]) {
    assert.doesNotMatch(allReviewText, forbidden);
  }
});

test('all source skills exist with fixed document types', () => {
  const skills = {
    'skills/review-fix-spec/SKILL.md': 'SPEC',
    'skills/review-fix-plan/SKILL.md': 'PLAN',
    'skills/review-fix-design/SKILL.md': 'DESIGN',
    'skills/review-fix-doc/SKILL.md': 'COMMON'
  };

  for (const [relativePath, fixedType] of Object.entries(skills)) {
    const skill = read(relativePath);
    assert.match(skill, new RegExp(`fixed document type: ${fixedType}`, 'i'));
    assert.match(skill, /users must not pass type/i);
    assert.match(skill, /shared\/core\.md/);
    assert.match(skill, /shared\/long-task\.md/);
    assert.match(skill, /shared\/rubrics\/common\.md/);
    assert.match(skill, /shared\/prompts\/reviewer\.md/);
    assert.match(skill, /shared\/prompts\/fixer\.md/);
    assert.match(skill, /shared\/prompts\/coordinator\.md/);
  }
});

test('source skills templates generated routes and README avoid runtime memory continuity dependency', () => {
  const sourceText = [
    'README.md',
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md',
    'templates/claude-command.md.tmpl',
    'templates/codex-skill.md.tmpl',
    'templates/gemini-command.toml.tmpl'
  ].map(read).join('\n\n--- source boundary ---\n\n');

  assert.doesNotMatch(sourceText, /\bresume\s+(?:from|using|via)\s+(?:runtime objective state|session memory|platform memory|chat history)\b/i);
  assert.doesNotMatch(sourceText, /\bcontinuity\s+(?:from|using|via)\s+(?:runtime objective state|session memory|platform memory|chat history)\b/i);
  assert.doesNotMatch(sourceText, /\b(?:runtime objective state|session memory|platform memory|chat history)\s+(?:is|required|needed)\s+for\s+(?:resume|continuity)\b/i);
  assert.doesNotMatch(sourceText, /\bresume from chat history\b/i);
  assert.match(sourceText, /\.docs-review-fix\/targets\/<target-key>\//);
});

test('package file list excludes project-local state and ignored planning directories', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.deepEqual(packageJson.files, [
    'bin/',
    'lib/',
    'skills/',
    'shared/',
    'templates/',
    'README.md',
    'README.zh-CN.md'
  ]);
  assert.equal(packageJson.files.includes('README-zh.md'), false);
  assert.equal(packageJson.files.some((entry) => entry.includes('.docs-review-fix')), false);
  assert.equal(packageJson.files.some((entry) => entry === 'docs/' || entry.startsWith('docs/')), false);
  assert.equal(packageJson.files.some((entry) => entry === 'design/' || entry.startsWith('design/')), false);
  assert.equal(packageJson.files.includes('CONTINUITY.md'), false);
});

test('localized README is root-level without package lifecycle hooks', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.equal(packageJson.scripts.prepack, undefined);
  assert.equal(packageJson.scripts.postpack, undefined);
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'pack-readme-zh.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'README.zh-CN.md')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'docs', 'README.zh-CN.md')), false);
  assert.match(read('README.md'), /\[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(read('README.zh-CN.md'), /\[English\]\(README\.md\)/);
});

test('localized README keeps public section structure aligned', () => {
  function sectionHeadings(filePath) {
    return read(filePath)
      .split(/\n/)
      .filter((line) => /^#{2,3} /.test(line))
      .map((line) => line.trim());
  }

  const zhReadme = read('README.zh-CN.md');
  assert.deepEqual(sectionHeadings('README.zh-CN.md'), sectionHeadings('README.md'));
  assert.match(zhReadme, /## Modes/);
  assert.match(zhReadme, /partially uninstalled: <platform>/);
});

test('usage examples prefer bare target paths while preserving target form and guard tokens', () => {
  const readme = read('README.md');
  const core = read('shared/core.md');
  const coordinator = read('shared/prompts/coordinator.md');
  const templates = [
    read('templates/codex-skill.md.tmpl'),
    read('templates/claude-command.md.tmpl'),
    read('templates/gemini-command.toml.tmpl')
  ].join('\n\n');

  assert.match(readme, /review-fix-spec docs\/spec\.md/);
  assert.match(readme, /bare path is shorthand for `target=<path>`/i);
  assert.match(readme, /`guard=git\|snapshot`/);
  assert.match(templates, /\{\{ROUTE_NAME\}\} <path> \[ref=<path>\.\.\.\]/);
  assert.match(templates, /full form/i);
  assert.match(templates, /target=<path>/);
  assert.match(templates, /guard=git\|snapshot/);
  assert.match(core, /bare path/i);
  assert.match(core, /guard=git\|snapshot/);
  assert.match(coordinator, /bare path/i);
});

test('public docs and route templates distinguish guard blocker wording', () => {
  const sourceText = [
    'README.md',
    'shared/core.md',
    'shared/prompts/coordinator.md',
    'templates/codex-skill.md.tmpl',
    'templates/claude-command.md.tmpl',
    'templates/gemini-command.toml.tmpl'
  ].map(read).join('\n\n');

  assert.match(sourceText, /`rollback-unavailable`[\s\S]{0,160}rollback anchor/i);
  assert.match(sourceText, /`target-only-guard-unavailable`[\s\S]{0,180}target-only guard/i);
  assert.match(sourceText, /`unexpected-worktree-change`[\s\S]{0,180}non-target worktree changes/i);

  const checklist = buildFinalResponseChecklist();
  assert.match(checklist, /`rollback-unavailable`[\s\S]{0,160}rollback anchor/i);
  assert.match(checklist, /`target-only-guard-unavailable`[\s\S]{0,180}target-only guard/i);
  assert.match(checklist, /`unexpected-worktree-change`[\s\S]{0,180}non-target worktree changes/i);
});

test('unknown markdown custom rules are warnings in normal mode docs', () => {
  const readme = read('README.md');
  const sharedText = [read('shared/core.md'), read('shared/prompts/coordinator.md')].join('\n\n');

  assert.match(readme, /Unknown Markdown files under `rules\/`/);
  assert.match(readme, /normal[^\n]*warning/i);
  assert.match(readme, /strict[^\n]*block/i);
  assert.match(sharedText, /unknown Markdown rule files/i);
  assert.match(sharedText, /normal[^\n]*warning/i);
});

test('codex route template uses shared runtime flags placeholder', () => {
  const sharedRuntimeFlags = read('shared/runtime-flags.md');
  const codexTemplate = read('templates/codex-skill.md.tmpl');
  const rendered = renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' });

  assert.match(codexTemplate, /\{\{RUNTIME_FLAGS\}\}/);
  assert.doesNotMatch(codexTemplate, /Use the materialized `<selectedAssurance>` to choose runtime fields/);
  assert.match(sharedRuntimeFlags, /Use the materialized `<selectedAssurance>` to choose runtime fields/);
  assert.match(rendered, /Use the materialized `<selectedAssurance>` to choose runtime fields/);
  assert.doesNotMatch(rendered, /\{\{RUNTIME_FLAGS\}\}/);
  assert.doesNotMatch(rendered, /\{\{RUNTIME_PLATFORM\}\}/);
});

test('README stays usage-focused', () => {
  const readme = read('README.md');

  assert.match(readme, /## Quick Start/);
  assert.match(readme, /## Output/);
  assert.match(readme, /## Troubleshooting/);
  assert.doesNotMatch(readme, /## Manual (?:Route )?Smoke/);
  assert.doesNotMatch(readme, /## Manual V2 Smoke/);
  assert.doesNotMatch(readme, /## Runtime Capability Behavior/);
  assert.doesNotMatch(readme, /Manual smoke expectations/i);
  assert.doesNotMatch(readme, /Final response requirements/i);
});

test('README documents reference conformance and non-mandatory upstream chains', () => {
  const readme = read('README.md');

  assert.match(readme, /Reference Conformance/i);
  assert.match(readme, /ref=.*consistency/i);
  assert.match(readme, /SPEC does not require a DESIGN reference/i);
  assert.match(readme, /PLAN does not require a SPEC reference/i);
  assert.match(readme, /Design Coverage Import/i);
  assert.match(readme, /SPEC-to-task mapping/i);
});

test('generated route text contains v2 operational workflow commands', () => {
  const sourceText = [
    'templates/claude-command.md.tmpl',
    'templates/codex-skill.md.tmpl',
    'templates/gemini-command.toml.tmpl'
  ].map(read).join('\n\n');

  assert.match(sourceText, /DRFX_REVIEWER_READY/);
  assert.match(sourceText, /drfx workflow start/);
  assert.match(sourceText, /--runtime-stdin-handoff ready/);
  assert.match(sourceText, /workflow preflight --no-state/);
  assert.match(sourceText, /do not use shell pipes|must not use shell pipes|never use shell pipes/i);
  assert.match(sourceText, /heredocs?|herestrings?/i);
  assert.match(sourceText, /argv|environment variables|env vars|raw temp files/i);
  assert.doesNotMatch(sourceText, /\|\s*(?:npx\s+)?drfx\s+workflow/i);
  assert.doesNotMatch(sourceText, /<<\s*(?:EOF|['"]?DRFX)/i);
  assert.doesNotMatch(sourceText, /--(?:result|triage|fix-report|final-response)\s+(?!-stdin\b)(?:["'`{]|\S)/);
});

test('route templates bind each runtime platform explicitly', () => {
  const codexText = read('templates/codex-skill.md.tmpl');
  const claudeText = read('templates/claude-command.md.tmpl');
  const geminiText = read('templates/gemini-command.toml.tmpl');

  assert.match(codexText, /--runtime-platform codex\b/);
  assert.match(claudeText, /--runtime-platform claude-code\b/);
  assert.match(geminiText, /--runtime-platform gemini\b/);
  assert.match(geminiText, /workflow preflight --no-state[\s\S]*--status-reason unsupported-runtime-capability/);
  assert.match(geminiText, /advisory-only/i);
  assert.match(geminiText, /must not edit|never edit|do not edit/i);
});

test('strict verified route proof uses same-flow check json only', () => {
  const codexText = read('templates/codex-skill.md.tmpl');
  const claudeText = read('templates/claude-command.md.tmpl');
  const geminiText = read('templates/gemini-command.toml.tmpl');

  for (const [label, text, publicPlatform] of [
    ['codex', codexText, 'codex'],
    ['claude', claudeText, 'claude']
  ]) {
    assert.match(text, /assurance=strict-verified/);
    assert.match(text, new RegExp(`drfx check --platform ${publicPlatform} --json`));
    assert.match(text, /same-flow|same route flow|same invocation/i);
    assert.match(text, /runId/);
    assert.match(text, /descriptorPath/);
    assert.match(text, /descriptorDirectory/);
    assert.match(text, /--capability-descriptor/);
    assert.match(text, /--descriptor-directory/);
    assert.match(text, /--proof-run-id/);
    assert.match(
      text,
      /drfx workflow start[\s\S]{0,220}(?:<selectedMode>|<requestedMode>|read-only\|review-and-fix|review-and-fix)[\s\S]{0,140}--assurance strict-verified/i,
      label
    );
    assert.match(text, /do not scrape|must not scrape|never scrape/i, label);
    assert.match(text, /human-readable.*drfx check|drfx check.*human-readable/i, label);
    assert.match(text, /do not reuse|must not reuse|never reuse/i, label);
    assert.match(text, /cached descriptor|installer-default descriptor/i, label);
  }

  assert.match(geminiText, /advisory-only/i);
  assert.doesNotMatch(geminiText, /--assurance strict-verified[\s\S]{0,160}--runtime-platform gemini|--runtime-platform gemini[\s\S]{0,160}--assurance strict-verified/);
});

test('record-diff-review route handoff uses result stdin flag', () => {
  const sourceText = [
    'templates/claude-command.md.tmpl',
    'templates/codex-skill.md.tmpl'
  ].map(read).join('\n\n');

  assert.match(sourceText, /record-diff-review[\s\S]{0,120}--result-stdin/);
  assert.doesNotMatch(sourceText, /record-diff-review[\s\S]{0,120}--diff-review-stdin/);
});

test('help-style and invalid route path remains explain-only', () => {
  const sourceText = read('templates/codex-skill.md.tmpl');
  assert.match(sourceText, /Help-style or invalid invocations still explain usage only/i);
  assert.match(sourceText, /missing target, unknown usage, or explicit help/i);
  assert.doesNotMatch(sourceText, /Help-style or invalid invocations[\s\S]{0,180}drfx workflow start/i);
});

test('generated route text documents v3 platform defaults and advisory override', () => {
  const codexTemplate = read('templates/codex-skill.md.tmpl');
  const claudeTemplate = read('templates/claude-command.md.tmpl');
  const geminiTemplate = read('templates/gemini-command.toml.tmpl');

  assert.match(codexTemplate, /missing mode selects `review-and-fix`/i);
  assert.match(codexTemplate, /missing assurance selects `practical`/i);
  assert.match(codexTemplate, /explicit `assurance=advisory` without mode selects `read-only`/i);
  assert.match(claudeTemplate, /missing mode selects `review-and-fix`/i);
  assert.match(claudeTemplate, /missing assurance selects `practical`/i);
  assert.match(claudeTemplate, /explicit `assurance=advisory` without mode selects `read-only`/i);
  assert.match(geminiTemplate, /missing mode selects read-only/i);
  assert.match(geminiTemplate, /missing assurance selects advisory/i);

  assert.doesNotMatch(codexTemplate, /without read-only or review-and-fix, explain usage only/i);
  assert.doesNotMatch(claudeTemplate, /without read-only or review-and-fix, explain usage only/i);
});

test('generated routes define concise default output and debug output', () => {
  const sources = [
    read('templates/codex-skill.md.tmpl'),
    read('templates/claude-command.md.tmpl'),
    read('templates/gemini-command.toml.tmpl')
  ];

  for (const source of sources) {
    assert.match(source, /Default output is concise/i);
    assert.match(source, /must not print.*Goal \/ Now \/ Next \/ Open Questions/is);
    assert.match(source, /must not print.*14-line final-response machine block/is);
    assert.match(source, /Issues:/);
    assert.match(source, /Location:/);
    assert.match(source, /Problem:/);
    assert.match(source, /Clean:/);
    assert.match(source, /Unfixed:/);
    assert.match(source, /debug/i);
    assert.match(source, /must not print raw target body/i);
    assert.match(source, /must not print raw prompts/i);
  }

  for (const source of [
    read('templates/codex-skill.md.tmpl'),
    read('templates/claude-command.md.tmpl')
  ]) {
    assert.match(source, /Fixed:/);
    assert.match(source, /Files changed: none/);
  }
});

test('generated routes require coordinator-quality semantic subagents without model pins', () => {
  const sources = [
    read('templates/codex-skill.md.tmpl'),
    read('templates/claude-command.md.tmpl')
  ];

  for (const source of sources) {
    assert.match(source, /readiness probes may use lower reasoning effort/i);
    assert.match(source, /semantic reviewer subagents inherit coordinator model quality/i);
    assert.match(source, /semantic fixer subagents inherit coordinator model quality/i);
    assert.doesNotMatch(source, /gpt-5\.5/i);
    assert.doesNotMatch(source, /gpt-5\.[345]/i);
  }
});

test('gemini route output stays advisory-only concise', () => {
  const geminiTemplate = read('templates/gemini-command.toml.tmpl');

  assert.match(geminiTemplate, /For read-only findings/i);
  assert.match(geminiTemplate, /For clean read-only runs/i);
  assert.match(geminiTemplate, /Unsupported:/);
  assert.match(geminiTemplate, /Blocked:/);
  assert.match(geminiTemplate, /apply fixes manually/i);
  assert.match(geminiTemplate, /Codex\/Claude Code review-and-fix route/i);
  assert.match(geminiTemplate, /review-and-fix or strict-verified is unavailable on Gemini/i);
  assert.doesNotMatch(geminiTemplate, /Next: rerun with review-and-fix to apply fixes/i);
  assert.doesNotMatch(geminiTemplate, /For fixed findings/i);
  assert.doesNotMatch(geminiTemplate, /For successful review-and-fix/i);
  assert.doesNotMatch(geminiTemplate, /^Pass: <target> was updated\./m);
  assert.doesNotMatch(geminiTemplate, /^Fixed:\s*$/m);
  assert.doesNotMatch(geminiTemplate, /^Files changed: none$/m);
});

test('generated route text rejects explicit advisory review-and-fix user requests', () => {
  const codexTemplate = read('templates/codex-skill.md.tmpl');
  const claudeTemplate = read('templates/claude-command.md.tmpl');

  for (const template of [codexTemplate, claudeTemplate]) {
    assert.match(template, /review-and-fix assurance=advisory/i);
    assert.match(template, /unsupported as a user request/i);
    assert.match(template, /modeNormalizedFrom: review-and-fix/i);
  }
});

test('generated route text materializes defaults before workflow commands', () => {
  const codexTemplate = read('templates/codex-skill.md.tmpl');
  const claudeTemplate = read('templates/claude-command.md.tmpl');

  for (const template of [codexTemplate, claudeTemplate]) {
    assert.match(template, /materialize effective `<selectedMode>`, `<selectedAssurance>`, and `<selectedGuard>`/i);
    assert.match(template, /never pass omitted mode, assurance, or guard through to `drfx workflow`/i);
    assert.match(template, /compute `<selectedMode>` from explicit mode, defaults, and advisory override/i);
    assert.match(template, /compute `<selectedAssurance>` from explicit assurance or platform default/i);
    assert.match(template, /compute `<selectedGuard>` from explicit guard or default `git`/i);
    assert.doesNotMatch(template, /Let `<selectedMode>` be the user's explicit mode/i);
    assert.doesNotMatch(template, /pass the user's raw invocation to `drfx workflow`/i);
  }

  for (const rendered of [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ]) {
    assert.match(rendered, /generated route must materialize effective mode, assurance, and guard before workflow calls/i);
    assert.match(rendered, /never pass omitted values through to `drfx workflow`/i);
  }
});

test('source skills and generated routes document reference conformance behavior', () => {
  const sourceSkills = [
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md'
  ];
  const platforms = ['codex', 'claude', 'gemini'];
  const routeNames = ['review-fix-spec', 'review-fix-plan', 'review-fix-design', 'review-fix-doc'];

  for (const sourceSkill of sourceSkills) {
    const sourceSkillText = read(sourceSkill);
    assert.match(sourceSkillText, /Reference Conformance/i, sourceSkill);
    assert.match(sourceSkillText, /ref=.*consistency source/i, sourceSkill);
    assert.match(sourceSkillText, /does not require/i, sourceSkill);
  }

  for (const platform of platforms) {
    for (const routeName of routeNames) {
      const routeText = renderPlatformRoute(platform, routeName, { packageVersion: '0.0.0-test' });
      assert.match(routeText, /Reference Conformance/i, `${platform}:${routeName}`);
      assert.match(routeText, /reference documents are consistency sources/i, `${platform}:${routeName}`);
      assert.match(routeText, /not mandatory upstream chains/i, `${platform}:${routeName}`);
    }
  }
});

test('generated route text separates advisory no-state read-only commands', () => {
  const cases = [
    [renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }), 'codex', 'review-fix-spec'],
    [renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' }), 'claude-code', 'review-fix-spec']
  ];

  for (const [template, platform, routeName] of cases) {
    assert.match(template, /Advisory read-only no-state path/i);
    assert.match(template, /Do not use the practical\/strict-verified ready-probe commands for advisory read-only/i);
    assert.match(
      template,
      new RegExp(`drfx workflow context --no-state ${routeName} target=<path> read-only guard=<selectedGuard> --assurance advisory --runtime-platform ${platform} --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --json`)
    );
    assert.match(
      template,
      new RegExp(`drfx workflow record-review --no-state ${routeName} target=<path> read-only guard=<selectedGuard> --assurance advisory --runtime-platform ${platform} --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none`)
    );
    assert.match(template, /Practical read-only no-state path/i);
    assert.match(
      template,
      new RegExp(`read-only guard=<selectedGuard> --assurance <selectedAssurance> --runtime-platform ${platform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none`)
    );
    assert.match(template, /Strict-verified read-only is state-backed/i);
  }
});

test('rendered route text omits stale missing-mode explain-only contract', () => {
  const renderedRoutes = [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('gemini', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ].join('\n\n--- rendered route boundary ---\n\n');

  assert.doesNotMatch(renderedRoutes, /omits `?read-only`? and `?review-and-fix`?[^.]*explains usage only/i);
  assert.doesNotMatch(renderedRoutes, new RegExp('Without an explicit mode token' + ', explain usage only', 'i'));
  assert.match(renderedRoutes, /Codex and Claude Code routes default a valid target invocation to `review-and-fix assurance=practical`/);
  assert.match(renderedRoutes, /Explicit `assurance=advisory` without mode selects `read-only` on Codex and Claude Code/);
  assert.match(renderedRoutes, /Gemini routes default a valid target invocation to `read-only assurance=advisory`/);
  assert.match(renderedRoutes, /Help-style or invalid invocations explain usage only and must not read target\/reference bodies, run workflow commands, run probes, create state, or declare a review result/);
});

test('rendered routes separate default output from internal final-response payload', () => {
  const renderedRoutes = [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('gemini', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ].join('\n\n--- rendered route boundary ---\n\n');

  assert.match(renderedRoutes, /--final-response-stdin/);
  assert.match(renderedRoutes, /Internal workflow final-response payload/i);
  assert.match(renderedRoutes, /Default user output uses concise Route Output/i);
  assert.match(renderedRoutes, /debug[\s\S]{0,160}redacted final-response machine block|redacted final-response machine block[\s\S]{0,160}debug/i);
  assert.doesNotMatch(renderedRoutes, /Final responses must state:/i);
  assert.doesNotMatch(renderedRoutes, /Report changes made, including issue IDs when available/i);
  assert.doesNotMatch(renderedRoutes, /Report files changed and issue IDs fixed/i);
  assert.doesNotMatch(renderedRoutes, /Include exactly one machine block/i);
  assert.doesNotMatch(renderedRoutes, /Final response checklist: include/i);
  assert.doesNotMatch(renderedRoutes, /final response includes issue IDs/i);
});

test('rendered gemini route keeps advisory next actions reachable', () => {
  const geminiRoute = renderPlatformRoute('gemini', 'review-fix-spec', { packageVersion: '0.0.0-test' });

  assert.match(geminiRoute, /apply fixes manually/i);
  assert.match(geminiRoute, /Codex\/Claude Code review-and-fix route/i);
  assert.match(geminiRoute, /review-and-fix or strict-verified is unavailable on Gemini/i);
  assert.doesNotMatch(geminiRoute, /Next: rerun with review-and-fix to apply fixes/i);
  assert.doesNotMatch(geminiRoute, /rerun in `review-and-fix` mode/i);
});

test('codex and claude routes run write eligibility preflight before semantic review', () => {
  const codexTemplate = read('templates/codex-skill.md.tmpl');
  const claudeTemplate = read('templates/claude-command.md.tmpl');

  for (const template of [codexTemplate, claudeTemplate]) {
    assert.match(template, /Review-And-Fix Write Eligibility Preflight/i);
    assert.match(template, /drfx workflow preflight/i);
    assert.match(template, /before runtime readiness probe, semantic reviewer dispatch, semantic document review, and target-local workflow state creation/i);
    assert.match(template, /cannot be auto-fixed because it lacks a clean rollback anchor/i);
  }
});

test('generated route workflow commands pass the materialized guard token', () => {
  const renderedRoutes = [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('gemini', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ];

  for (const route of renderedRoutes) {
    assert.match(route, /<selectedGuard>/);
    const routedWorkflowCommands = route
      .split('\n')
      .filter((line) => /drfx workflow /.test(line))
      .filter((line) => /review-fix-spec target=<path>/.test(line));
    assert.ok(routedWorkflowCommands.length > 0);
    for (const command of routedWorkflowCommands) {
      assert.match(command, /guard=<selectedGuard>/, command);
    }
  }
});

test('coordinator prompt uses read-only-clean instead of read-only PASS', () => {
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(coordinator, /Terminal and pause states:[\s\S]*read-only-clean[\s\S]*read-only-findings/);
  assert.match(coordinator, /read-only clean status is `read-only-clean`|read-only-clean.*not `?pass`?/i);
  assert.doesNotMatch(coordinator, /mode is read-only[\s\S]{0,180}otherwise report PASS/i);
});

test('shared prompt sources include required v2 machine contracts', () => {
  const sharedText = [
    'shared/core.md',
    'shared/long-task.md',
    'shared/prompts/reviewer.md',
    'shared/prompts/fixer.md',
    'shared/prompts/coordinator.md'
  ].map(read).join('\n\n');

  assert.match(sharedText, /PASS[\s\S]*Summary:/);
  assert.match(sharedText, /FAIL[\s\S]*Findings:[\s\S]*- id: R001/);
  assert.match(sharedText, /Triage:[\s\S]*reviewer_id: R001/);
  assert.match(sharedText, /Fixed:[\s\S]*Files changed:[\s\S]*Not fixed:[\s\S]*Residual risk:/);
  assert.match(sharedText, /DIFF-OK[\s\S]*DIFF-FAIL/);
  assert.match(sharedText, /Final status:/);
  assert.match(sharedText, /redaction/i);
  assert.doesNotMatch(sharedText, /raw test fixture/i);
});

test('public docs no longer teach legacy RULE.md as supported configuration', () => {
  const readme = read('README.md');
  const longTask = read('shared/long-task.md');
  const sourceSkills = [
    read('skills/review-fix-spec/SKILL.md'),
    read('skills/review-fix-plan/SKILL.md'),
    read('skills/review-fix-design/SKILL.md'),
    read('skills/review-fix-doc/SKILL.md')
  ].join('\n');

  assert.doesNotMatch(
    readme,
    new RegExp(('Optional custom rule ' + 'files:') + '\\s*```text\\s*~\\/\\.docs-review-fix\\/RULE\\.md', 'is')
  );
  assert.doesNotMatch(readme, /Example `RULE\.md` shape/i);
  assert.doesNotMatch(longTask, /`?\.docs-review-fix\/RULE\.md`? is shared project configuration/i);
  assert.doesNotMatch(sourceSkills, new RegExp('Without an explicit mode token' + ', explain usage only', 'i'));

  assert.match(readme, /~\/\.docs-review-fix\/rules\/COMMON\.md/);
  assert.match(readme, /\.docs-review-fix\/rules\/SPEC\.md/);
  assert.match(readme, /Legacy `RULE\.md` is stale configuration/i);
  assert.match(sourceSkills, /missing mode selects `review-and-fix`/i);
});

test('README documents v3 invocation defaults and explain-only boundary', () => {
  const readme = read('README.md');

  assert.match(readme, /Codex and Claude Code routes default missing mode to `review-and-fix` and missing assurance to `practical`/);
  assert.match(readme, /Explicit `assurance=advisory` without mode selects `read-only` on Codex and Claude Code/);
  assert.match(readme, /Gemini routes default missing mode to `read-only` and missing assurance to `advisory`/);
  assert.match(readme, /Help-style or invalid invocations[\s\S]*explain usage only[\s\S]*must not read files[\s\S]*run `drfx workflow`[\s\S]*create state[\s\S]*run probes[\s\S]*declare review results/);
});

test('README documents typed scoped custom rule reads', () => {
  const readme = read('README.md');

  assert.match(readme, /loader reads only `COMMON\.md` plus the current document type file/);
  assert.match(readme, /A `SPEC` review does not read `PLAN\.md` or `DESIGN\.md`/);
  assert.match(readme, /a `PLAN` review does not read `SPEC\.md` or `DESIGN\.md`/);
  assert.match(readme, /a `DESIGN` review does not read `SPEC\.md` or `PLAN\.md`/);
  assert.match(readme, /a COMMON document review reads only `COMMON\.md`/);
});

test('README documents unknown markdown rule file strictness behavior', () => {
  const readme = read('README.md');

  assert.match(readme, /Unknown Markdown files under `rules\/`/);
  assert.match(readme, /`SPEC-RULE\.md`/);
  assert.match(readme, /`REQUIREMENTS\.md`/);
  assert.match(readme, /normal[^\n]*warning/i);
  assert.match(readme, /strict[^\n]*block before target state is written/i);
});

test('long-task keeps project-root rules outside target state', () => {
  const longTask = read('shared/long-task.md');

  assert.match(longTask, /Project-root `\.docs-review-fix\/rules\/` is shared project configuration, not target state/);
  assert.match(longTask, /Do not write target review state to project-root[\s\S]*`\.docs-review-fix\/rules\/`/);
});

test('source skills individually document v3 defaults and concise debug output', () => {
  const skills = [
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md'
  ];

  for (const relativePath of skills) {
    const skill = read(relativePath);

    assert.match(skill, /Valid target invocations may omit mode/, relativePath);
    assert.match(skill, /select `review-and-fix assurance=practical` by default when mode and assurance are omitted/, relativePath);
    assert.match(skill, /missing mode selects `review-and-fix` and missing assurance selects `practical`/, relativePath);
    assert.match(skill, /Explicit `assurance=advisory` without mode selects `read-only` on Codex and Claude Code/, relativePath);
    assert.match(skill, /Gemini generated routes select `read-only assurance=advisory` by default/, relativePath);
    assert.match(skill, /Help-style or invalid invocations explain usage only and do not read files, run workflow commands, run probes, create state, or declare review results/, relativePath);
    assert.match(skill, /Pass `debug` to print redacted workflow audit details/, relativePath);
    assert.match(skill, /Default output is concise/, relativePath);
    assert.match(skill, /must not expose raw workflow JSON, prompt text, subagent transcripts, or internal issue IDs/, relativePath);
    assert.match(skill, /`Issues:`, `Fixed:`, or `Unfixed:` lists/, relativePath);
  }
});

test('public docs and source skills omit stale v2 rule and mode wording', () => {
  const publicText = [
    read('README.md'),
    read('shared/long-task.md'),
    read('skills/review-fix-spec/SKILL.md'),
    read('skills/review-fix-plan/SKILL.md'),
    read('skills/review-fix-design/SKILL.md'),
    read('skills/review-fix-doc/SKILL.md')
  ].join('\n\n');

  assert.doesNotMatch(publicText, /Rule heading restrictions are strict/i);
  assert.doesNotMatch(publicText, /`?\.docs-review-fix\/RULE\.md`? is shared project configuration/i);
  assert.doesNotMatch(publicText, /`?RULE\.md`? is shared project configuration/i);
  assert.doesNotMatch(publicText, /No mode token means explain only/i);
  assert.doesNotMatch(publicText, new RegExp('Without an explicit mode token' + ', explain usage only', 'i'));
  assert.doesNotMatch(publicText, /`read-only` or `review-and-fix` is required to start workflow/i);
  assert.doesNotMatch(publicText, /If no mode is provided, explain usage only/i);
});

test('diff review requires fix-effectiveness verification (no new machine fields)', () => {
  const core = read('shared/core.md');
  const coordinator = read('shared/prompts/coordinator.md');
  const fixer = read('shared/prompts/fixer.md');

  // G1: effectiveness is a prompt discipline folded into the existing DIFF-FAIL fields.
  assert.match(core, /resolves the original finding|actually resolve|does not resolve/i);
  assert.match(coordinator, /resolves the original finding|does not resolve/i);
  assert.match(fixer, /how (the|this) (change|fix) resolves|how it resolves the/i);

  // Must NOT introduce a machine field for it.
  assert.doesNotMatch(core, /^\s*resolves:\s*(yes|no|partial)/im);
});

test('common rubric defines severity anchors; reviewer states coverage in Summary (no machine line)', () => {
  const common = read('shared/rubrics/common.md');
  const reviewer = read('shared/prompts/reviewer.md');
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(common, /^## Severity anchors$/m);
  assert.match(common, /high:.*blocks/i);
  assert.match(common, /medium:.*materially/i);
  assert.match(common, /low:.*clarity|low:.*does not block/i);

  // Coverage is stated inside the existing Summary line, NOT a new machine line.
  assert.match(reviewer, /state[^.]*coverage[^.]*Summary|within the Summary/i);
  assert.doesNotMatch(reviewer, /^Coverage:/m);
  // Coverage statement is limited to the PASS Summary; FAIL must not gain a Summary line.
  assert.match(reviewer, /On PASS|PASS Summary/);
  assert.match(reviewer, /FAIL report has no Summary|no Summary.*Findings:|do not add a Summary line/i);
  assert.match(coordinator, /coverage|exercised the required/i);
});

test('reviewer must not narrow the review when given changed-since-last-review', () => {
  const core = read('shared/core.md');
  const reviewer = read('shared/prompts/reviewer.md');
  const coordinator = read('shared/prompts/coordinator.md');
  assert.match(core, /Changed since last review|changed-since-last-review/i);
  assert.match(reviewer, /Changed since last review/i);
  assert.match(coordinator, /Changed since last review/i);
  assert.match(reviewer, /still review the (whole|full) document|do not narrow/i);
  assert.match(coordinator, /still review the (whole|full) document|do not narrow/i);
});

test('routes and prompts list stopped-no-progress as a terminal state', () => {
  const finalStatusLine = read('shared/core.md').match(/^Final status: (.+)$/m);
  assert.ok(finalStatusLine, 'shared/core.md must include the final-response status machine line');
  assert.match(finalStatusLine[1], /stopped-no-progress/);
  assert.match(buildFinalResponseChecklist(), /stopped-no-progress[\s\S]*no-progress-detected/);

  for (const rel of [
    'shared/core.md',
    'shared/prompts/coordinator.md',
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md',
    'templates/claude-command.md.tmpl',
    'templates/codex-skill.md.tmpl',
    'templates/gemini-command.toml.tmpl'
  ]) {
    assert.match(read(rel), /stopped-no-progress/, `${rel} must list stopped-no-progress`);
  }
});

test('coordinator defines a recurrence + fix-attempt-cap convergence rule', () => {
  const coordinator = read('shared/prompts/coordinator.md');
  assert.match(coordinator, /fix-attempt cap|recurr/i);
  assert.match(coordinator, /stopped-no-progress/);
});

// ---------------------------------------------------------------------------
// Compatibility: generatePlatformFiles must still generate only document routes
// ---------------------------------------------------------------------------

test('generatePlatformFiles generates only the four document routes (not PR or code)', () => {
  const documentRouteNames = listDocumentRoutes().map((r) => r.routeName);
  assert.deepEqual(documentRouteNames, [
    'review-fix-spec',
    'review-fix-plan',
    'review-fix-design',
    'review-fix-doc',
  ]);

  for (const platform of ['claude', 'codex', 'gemini']) {
    const files = generatePlatformFiles(platform, { packageVersion: '0.0.0-test' });
    const generatedRouteNames = files.map((f) => f.routeName);
    assert.deepEqual(
      generatedRouteNames,
      documentRouteNames,
      `${platform} must only generate document routes`
    );
  }
});
