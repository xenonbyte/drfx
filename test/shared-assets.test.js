'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
  assert.match(core, /stopped-with-deferrals[^\n]*issue IDs[^\n]*reasons?[^\n]*owners?[^\n]*next action/i);
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

test('package file list excludes README-zh and project-local state', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.deepEqual(packageJson.files, ['bin/', 'lib/', 'skills/', 'shared/', 'templates/', 'test/', 'README.md', 'design/']);
  assert.equal(packageJson.files.includes('README-zh.md'), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'README-zh.md')), false);
  assert.equal(packageJson.files.some((entry) => entry.includes('.docs-review-fix')), false);
});
