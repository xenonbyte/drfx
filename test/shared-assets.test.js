'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { renderPlatformRoute } = require('../lib/generator');

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

test('package file list excludes README-zh, project-local state, and local design drafts', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.deepEqual(packageJson.files, ['bin/', 'lib/', 'skills/', 'shared/', 'templates/', 'test/', 'README.md']);
  assert.equal(packageJson.files.includes('README-zh.md'), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'README-zh.md')), false);
  assert.equal(packageJson.files.some((entry) => entry.includes('.docs-review-fix')), false);
  assert.equal(packageJson.files.some((entry) => entry === 'design/' || entry.startsWith('design/')), false);
});

test('manual v2 smoke docs record runtime limitations without placeholders', () => {
  const readme = read('README.md');
  const receipt = read('docs/manual-smoke-v2.md');

  assert.match(readme, /## Manual V2 Smoke/);
  assert.match(receipt, /## Codex Practical/);
  assert.match(receipt, /## Claude Code/);
  assert.match(receipt, /installed: codex/);
  assert.match(receipt, /installed: claude/);
  assert.match(receipt, /ACCEPTED-FAIL-CLOSED-LIMITED/);
  assert.doesNotMatch(receipt, /\bobserved\s+\S+/i);
  assert.doesNotMatch(receipt, /\bTODO\b|TBD|<[^>]+>/i);
  assert.doesNotMatch(receipt, /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/i);
  assert.doesNotMatch(receipt, /\bBearer\s+[A-Za-z0-9._-]+/i);
  assert.doesNotMatch(receipt, /\bCookie:/i);
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
    assert.match(template, /materialize effective `<selectedMode>` and `<selectedAssurance>`/i);
    assert.match(template, /never pass omitted mode or assurance through to `drfx workflow`/i);
    assert.match(template, /compute `<selectedMode>` from explicit mode, defaults, and advisory override/i);
    assert.match(template, /compute `<selectedAssurance>` from explicit assurance or platform default/i);
    assert.doesNotMatch(template, /Let `<selectedMode>` be the user's explicit mode/i);
    assert.doesNotMatch(template, /pass the user's raw invocation to `drfx workflow`/i);
  }

  for (const rendered of [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ]) {
    assert.match(rendered, /generated route must materialize effective mode and assurance before workflow calls/i);
    assert.match(rendered, /never pass omitted values through to `drfx workflow`/i);
  }
});

test('generated route text separates advisory no-state read-only commands', () => {
  const cases = [
    [read('templates/codex-skill.md.tmpl'), 'codex'],
    [read('templates/claude-command.md.tmpl'), 'claude-code']
  ];

  for (const [template, platform] of cases) {
    assert.match(template, /Advisory read-only no-state path/i);
    assert.match(template, /Do not use the practical\/strict-verified ready-probe commands for advisory read-only/i);
    assert.match(
      template,
      new RegExp(`drfx workflow context --no-state \\{\\{ROUTE_NAME\\}\\} target=<path> read-only --assurance advisory --runtime-platform ${platform} --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --json`)
    );
    assert.match(
      template,
      new RegExp(`drfx workflow record-review --no-state \\{\\{ROUTE_NAME\\}\\} target=<path> read-only --assurance advisory --runtime-platform ${platform} --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none`)
    );
    assert.match(template, /Practical read-only no-state path/i);
    assert.match(
      template,
      new RegExp(`--assurance <selectedAssurance> --runtime-platform ${platform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none`)
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
  assert.doesNotMatch(renderedRoutes, /Without an explicit mode token, explain usage only/i);
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
});

test('rendered gemini route keeps advisory next actions reachable', () => {
  const geminiRoute = renderPlatformRoute('gemini', 'review-fix-spec', { packageVersion: '0.0.0-test' });

  assert.match(geminiRoute, /apply fixes manually/i);
  assert.match(geminiRoute, /Codex\/Claude Code review-and-fix route/i);
  assert.match(geminiRoute, /review-and-fix or strict-verified is unavailable on Gemini/i);
  assert.doesNotMatch(geminiRoute, /Next: rerun with review-and-fix to apply fixes/i);
});

test('codex and claude routes run write eligibility preflight before semantic review', () => {
  const codexTemplate = read('templates/codex-skill.md.tmpl');
  const claudeTemplate = read('templates/claude-command.md.tmpl');

  for (const template of [codexTemplate, claudeTemplate]) {
    assert.match(template, /Review-And-Fix Write Eligibility Preflight/i);
    assert.match(template, /drfx workflow preflight/i);
    assert.match(template, /before runtime readiness probe, semantic reviewer dispatch, semantic document review, and target-local workflow state creation/i);
    assert.match(template, /cannot be auto-fixed because it is not a clean tracked Git target/i);
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
