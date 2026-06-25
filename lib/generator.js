'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getRouteDescriptor, listDocumentRoutes, listRoutes } = require('./routes');

const PACKAGE_NAME = '@xenonbyte/drfx';
const ROOT = path.join(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'templates');
const FRAGMENT_DIR = path.join(TEMPLATE_DIR, 'fragments');
const SHARED_DIR = path.join(ROOT, 'shared');
const CODEX_SHARED_OWNERSHIP_MARKER = path.join('shared', '.drfx-owned');

// ROUTES is kept as a backwards-compatible export derived from the shared registry.
// It contains only the four document routes so existing consumers are unaffected.
const ROUTES = Object.freeze(
  Object.fromEntries(
    listDocumentRoutes().map((route) =>
      [route.routeName, Object.freeze({ routeName: route.routeName, documentType: route.documentType, rubric: route.rubric })]
    )
  )
);

const PLATFORM_TEMPLATES = Object.freeze({
  claude: 'claude-command.md.tmpl',
  codex: 'codex-skill.md.tmpl',
  gemini: 'gemini-command.toml.tmpl',
  opencode: 'opencode-command.md.tmpl'
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizePlatform(platform) {
  if (!Object.hasOwn(PLATFORM_TEMPLATES, platform)) fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
  return platform;
}

function routeFor(routeName) {
  // Delegate to the shared registry. All seven route kinds (document/pr/code/r2p) are
  // generatable; getRouteDescriptor throws ERR_ROUTE for completely unknown names.
  return getRouteDescriptor(routeName);
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return packageJson.version;
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// Resolve the embedded/copied shared asset paths for a route descriptor.
// Document routes layer COMMON before their specific rubric. PR/CODE rubrics
// are self-contained route-kind rubrics and intentionally have no COMMON layer.
function sharedRelativePathsForRoute(route) {
  const paths = [
    path.join('shared', 'core.md'),
    path.join('shared', 'long-task.md')
  ];
  if (route.routeKind === 'document' || route.routeKind === 'r2p') paths.push(path.join('shared', 'rubrics', 'common.md'));
  if (route.rubric) paths.push(path.join('shared', 'rubrics', `${route.rubric}.md`));
  paths.push(
    path.join('shared', 'prompts', 'reviewer.md'),
    path.join('shared', 'prompts', 'fixer.md'),
    path.join('shared', 'prompts', 'coordinator.md')
  );
  return paths;
}

// Back-compat overload used by copySharedAssets({ documentType }): resolve by
// document type, then delegate to the descriptor-keyed resolver.
function sharedRelativePaths(documentType) {
  const route = listDocumentRoutes().find((candidate) => candidate.documentType === documentType);
  if (!route) fail('ERR_DOCUMENT_TYPE', `unsupported document type: ${documentType}`);
  return sharedRelativePathsForRoute(route);
}

function allSharedRelativePaths() {
  const paths = new Set();
  for (const route of listRoutes()) {
    for (const relativePath of sharedRelativePathsForRoute(route)) paths.add(relativePath);
  }
  return [...paths].sort();
}

function embeddedSharedContent(route) {
  return sharedRelativePathsForRoute(route)
    .map((relativePath) => {
      const content = readText(relativePath).trimEnd();
      return `<!-- ${relativePath} -->\n\n${content}`;
    })
    .join('\n\n---\n\n');
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function codexCopiedSharedContent(route) {
  const requiredPaths = sharedRelativePathsForRoute(route).map(toPosix);
  return [
    'Codex copied shared source mode is active. The full shared prompt, rubric, and workflow text is intentionally not embedded inline in this `SKILL.md`.',
    '',
    'Before reading target/reference bodies, running probes, or invoking any `drfx workflow` command, resolve this skill directory offline and verify both ownership markers are present and readable:',
    '',
    '- `.drfx-owned`',
    '- `shared/.drfx-owned`',
    '',
    'Then read these required copied shared source files from this skill directory, in this order:',
    '',
    ...requiredPaths.map((relativePath) => `- \`${relativePath}\``),
    '',
    'If any ownership marker or required copied shared source file is missing, unreadable, outside this skill directory, or not a regular file, fail closed with a concise `Blocked:` result before workflow invocation.',
    '',
    'Do not silently fall back to package source files, `~/.drfx/shared`, runtime memory, chat history, network fetches, or stale copies. Debug output may include the verified copied-source artifact paths, but it must not print raw shared source bodies unless explicitly requested for diagnosis.'
  ].join('\n');
}

function embeddedSharedContentForPlatform(platform, route, options) {
  if (platform === 'codex' && options.codexSharedMode !== 'embedded') {
    return codexCopiedSharedContent(route);
  }
  return embeddedSharedContent(route);
}

function runtimePlatformFor(platform) {
  if (platform === 'claude') return 'claude-code';
  return platform;
}

// ---------------------------------------------------------------------------
// Route-varying placeholder content (PLAN-TASK-008)
//
// These helpers fill the generator placeholders that differ by route kind.
// For DOCUMENT routes they render the EXACT pre-parameterization text so the
// golden shell snapshot stays byte-identical except the additive rounds=<n>
// token. For PR/CODE routes they render route-kind-appropriate text.
// ---------------------------------------------------------------------------

// The leading target token used by every `drfx workflow` command and the
// usage prose. Document routes use `target=<path>`; PR/CODE override in Phase 3.
function targetTokenFor(route) {
  if (route.routeKind === 'pr') return 'base=<branch>';
  if (route.routeKind === 'code') return '<scopeTokens>';
  if (route.routeKind === 'r2p') return 'target=<requirement-dir>';
  return 'target=<path>';
}

function readFragment(name) {
  return fs.readFileSync(path.join(FRAGMENT_DIR, name), 'utf8').replace(/\n$/, '');
}

// The Route Contract bullet body. Stored as verbatim fragment files keyed by
// route kind + platform so document output is byte-identical and code-route
// contract text lives in reviewable files rather than JS string literals.
function routeContractFor(platform, route) {
  const fragment = readFragment(`route-contract.${route.routeKind}.${platform}.md`);
  return renderTemplate(fragment, {
    ROUTE_NAME: route.routeName,
    DOCUMENT_TYPE: route.documentType,
    TARGET_TOKEN: targetTokenFor(route)
  });
}

function runtimeFlagsContent(platform, route) {
  const template = readText(path.join('shared', route.routeKind === 'r2p' ? 'runtime-flags.r2p.md' : 'runtime-flags.md'));
  return renderTemplate(template, {
    ROUTE_NAME: route.routeName,
    RUNTIME_PLATFORM: runtimePlatformFor(platform),
    TARGET_TOKEN: targetTokenFor(route)
  });
}

function preflightAssuranceTextFor(route) {
  if (route.routeKind === 'r2p') {
    return 'For r2p, this internal preflight command accepts materialized `--assurance practical` and `--assurance strict-verified` workflow values before runtime probes and strict proof because it does not create target state. The route must not accept or forward a user `assurance=` token; the Invocation Gate rejects it.';
  }
  return 'This command accepts `assurance=practical` and `assurance=strict-verified` before runtime probes and strict proof because it does not create target state. It returns `unsupported` for explicit `review-and-fix assurance=advisory`.';
}

function runtimeProbeAssuranceTextFor(platform, route) {
  const probeKind = platform === 'codex' ? 'live reviewer subagent probe' : 'live reviewer subagent or Task-style reviewer probe';
  if (route.routeKind === 'r2p') {
    return `For materialized \`practical\` and \`strict-verified\` assurance, run a ${probeKind} before workflow start. The probe prompt must not read target/reference files and must not write files. It must require exactly this single output line:`;
  }
  return `For \`assurance=practical\` and \`assurance=strict-verified\`, run a ${probeKind} before workflow start. The probe prompt must not read target/reference files and must not write files. It must require exactly this single output line:`;
}

function advisoryProbeSkipTextFor(route) {
  if (route.routeKind === 'r2p') {
    return 'r2p exposes no advisory assurance token. A materialized read-only r2p flow uses the practical no-state path unless an internal strict-verified state-backed path is selected.';
  }
  return 'Explicit `assurance=advisory read-only` skips the subagent probe and passes `--runtime-subagent-probe not-required --runtime-downgrade-reason none`.';
}

function strictVerifiedIntroTextFor(route) {
  if (route.routeKind === 'r2p') {
    return 'Only the internal same-flow strict proof branch may use `strict-verified` for r2p. Do not accept a user `assurance=` token to request it. In that branch, run:';
  }
  return 'Only explicit `assurance=strict-verified` requests strict verified mode. In the same-flow route invocation, run:';
}

function strictVerifiedSelectedModeTextFor(platform, route) {
  const descriptorPath = `platforms.${platform}.descriptorPath`;
  if (route.routeKind === 'r2p') {
    return `Read the JSON object, then extract \`runId\`, \`descriptorDirectory\`, and \`${descriptorPath}\`. Let \`<selectedMode>\` be the effective mode from the Invocation Gate. In this strict verified branch, \`<selectedAssurance>\` is \`strict-verified\`. Materialize \`<stateControlToken>\` as \`reset\` only when the current invocation includes \`reset\`; otherwise omit it. Pass those current-run values to workflow start:`;
  }
  return `Read the JSON object, then extract \`runId\`, \`descriptorDirectory\`, and \`${descriptorPath}\`. Let \`<selectedMode>\` be the effective mode from the Invocation Gate, including defaults and advisory override. In this strict verified branch, \`<selectedAssurance>\` is \`strict-verified\`. Materialize \`<stateControlToken>\` as \`reset\` only when the current invocation includes \`reset\`; otherwise omit it. Pass those current-run values to workflow start:`;
}

function strictVerifiedReviewAndFixTextFor(route) {
  if (route.routeKind === 'r2p') {
    return 'For an internal strict-verified `review-and-fix` r2p start, `<selectedMode>` must be `review-and-fix`; do not silently substitute `read-only`. After strict verified start succeeds, continue the persistent review-and-fix loop from the returned `targetStateDir`; the manifest carries the effective strict verified assurance.';
  }
  return 'For `review-and-fix assurance=strict-verified`, `<selectedMode>` must be `review-and-fix`; do not silently substitute `read-only`. After strict verified start succeeds, continue the persistent review-and-fix loop from the returned `targetStateDir`; the manifest carries the effective strict verified assurance.';
}

function persistentPracticalIntroTextFor(route) {
  if (route.routeKind === 'r2p') {
    return 'For the materialized practical path, after successful probes, start persistent state:';
  }
  return 'For `assurance=practical`, after successful probes, start persistent state:';
}

function persistentPracticalSummaryTextFor(route, defaultGuard) {
  if (route.routeKind === 'r2p') {
    return `This persistent practical command is the materialized default path: \`<selectedMode>\` is \`review-and-fix\`, \`<selectedAssurance>\` is \`practical\`, \`<selectedGuard>\` is explicit guard or default \`${defaultGuard}\`, and \`<stateControlToken>\` is \`reset\` only for explicit reset starts. If the internal strict-verified branch is selected, use the strict verified start command above with effective \`<selectedMode>\` set to \`review-and-fix\`.`;
  }
  return `This persistent practical command is the materialized default path: \`<selectedMode>\` is \`review-and-fix\`, \`<selectedAssurance>\` is \`practical\`, \`<selectedGuard>\` is explicit guard or default \`${defaultGuard}\`, and \`<stateControlToken>\` is \`reset\` only for explicit reset starts. For \`assurance=strict-verified\`, use the strict verified start command above with effective \`<selectedMode>\` set to \`review-and-fix\`.`;
}

function roundsTokenFor(platform) {
  return platform === 'gemini' ? '' : ' rounds=<roundLimit>';
}

function stateControlTokenFor(platform) {
  return platform === 'gemini' ? '' : ' <stateControlToken>';
}

// The single-line invocation grammar shown in the Invocation Gate / Invocation
// section. Document routes keep their full token set and gain the additive
// `[rounds=<n>]` option (the one allowed additive change). PR/CODE override in
// Phase 3 with their reduced grammar.
function invocationGrammarFor(platform, route) {
  const name = route.routeName;
  if (route.routeKind === 'pr') {
    // Gemini PR routes are advisory read-only: their grammar must not advertise
    // review-and-fix, resume, or rounds (which the gate body / contract prohibit).
    if (platform === 'gemini') {
      return `${name} base=<branch> [read-only] [guard=git|snapshot] [root=<project-root>] [debug]`;
    }
    return `${name} base=<branch> [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`;
  }
  if (route.routeKind === 'code') {
    if (platform === 'gemini') {
      return `${name} [scope=<path>...] [read-only] [guard=git|snapshot] [root=<project-root>] [debug]`;
    }
    return `${name} [scope=<path>...] [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`;
  }
  if (route.routeKind === 'r2p') {
    // r2p reviews an r2p requirement directory (07-plan.md anchor) and has a fixed
    // PLAN rubric: no ref=, strict/normal, assurance=, or ledger= surface. Gemini is
    // advisory read-only and does not advertise review-and-fix/rounds/resume.
    if (platform === 'gemini') {
      return `${name} target=<requirement-dir> [read-only] [guard=git|snapshot] [root=<project-root>] [debug]`;
    }
    return `${name} target=<requirement-dir> [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`;
  }
  if (platform === 'gemini') {
    // Gemini is advisory read-only; rounds=<n> loop semantics are unsupported in
    // read-only mode, so its grammar does not advertise the rounds token.
    return `${name} <path> [ref=<path>...] [read-only] [strict|normal] [assurance=advisory] [guard=git|snapshot] [root=<project-root>] [debug]`;
  }
  return `${name} <path> [ref=<path>...] [read-only|review-and-fix] [strict|normal] [assurance=practical|strict-verified|advisory] [guard=git|snapshot] [resume|reset] [rounds=<n>] [ledger=<target-local path>] [root=<project-root>] [debug]`;
}

// The Invocation Gate prose paragraphs after the grammar line. Document routes
// render their verbatim fragment (mode/assurance/strict semantics); PR/CODE
// render a reduced gate body in Phase 3.
function invocationGateBodyFor(platform, route) {
  const fragment = readFragment(`invocation-gate.${route.routeKind}.${platform}.md`);
  return renderTemplate(fragment, {
    ROUTE_NAME: route.routeName,
    DOCUMENT_TYPE: route.documentType,
    TARGET_TOKEN: targetTokenFor(route)
  });
}

// Short human summary used in Gemini's description line. Document routes
// describe the document type; PR/CODE describe the review target.
function routeSummaryFor(route) {
  if (route.routeKind === 'pr') return 'PR diffs';
  if (route.routeKind === 'code') return 'source scopes';
  if (route.routeKind === 'r2p') return 'r2p requirement plans (07-plan.md)';
  return `${route.documentType} documents`;
}

// The Gemini [metadata] type line. Document routes keep `document_type`;
// PR/CODE record their review target kind instead.
function metadataTypeFor(route) {
  if (route.routeKind === 'pr') return 'review_target = "pr-diff"';
  if (route.routeKind === 'code') return 'review_target = "source-scope"';
  if (route.routeKind === 'r2p') return 'review_target = "r2p-requirement"';
  return `document_type = "${route.documentType}"`;
}

// PLAN-TASK-009 (Phase C3): route-aware wording for the few review-unit nouns that would
// otherwise leak a document-only frame ("full-document", "document review", "document
// bodies") into PR/CODE output. Document routes return the EXACT prior text so their golden
// shell snapshot stays byte-identical; PR/CODE get file-set wording.
function reviewUnitVerificationFor(route) {
  if (route.routeKind === 'pr') return 'Verification: full file-set read-only review completed.';
  if (route.routeKind === 'code') return 'Verification: full file-set read-only review completed.';
  return 'Verification: full-document read-only review completed.';
}

function reviewSemanticNounFor(route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') return 'semantic file-set review';
  return 'semantic document review';
}

function reviewBodyNounFor(route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') return 'file body text';
  return 'document bodies';
}

// The fix-loop write-boundary sentence in the persistent flow. Document routes keep
// the EXACT prior target-only wording; PR/CODE bound writes to the resolved file set
// so the route prose matches the fixer guard (resolved-set-only, no scope expansion).
function fixWriteBoundaryFor(route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') {
    return 'Edit only files inside the resolved target file set directly by default; never expand the write scope beyond it.';
  }
  if (route.routeKind === 'r2p') {
    return 'Edit only 07-plan.md and the owning upstream doc (03–06) inside the resolved requirement directory; never edit run.md or any file outside 03–07.';
  }
  return 'Edit only the target directly by default.';
}

// The automatic-write guard requirement paragraph. Document routes keep the EXACT
// prior single-target guard wording; PR/CODE describe the file-set guard (clean
// whole-worktree git status before the first fix, or snapshot rollback anchor).
function guardWriteRequirementFor(route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') {
    return 'Automatic file-set writes require `review-and-fix` and a selected guard mode: use `guard=git` with a clean worktree before the first fix and route-owned changes that stay inside the resolved file set afterward, or `guard=snapshot` with a valid snapshot rollback anchor. The file-set guard must remain available and parseable before and after writes.';
  }
  if (route.routeKind === 'r2p') {
    return 'Automatic requirement-directory writes require `review-and-fix` and a selected guard mode (default `snapshot`): use `guard=git` with a clean worktree before the first fix and route-owned changes that stay inside the resolved 03–07 file set afterward, or `guard=snapshot` with a valid snapshot rollback anchor. `run.md` is a protected read-only dependency that must remain unchanged. The file-set guard must remain available and parseable before and after writes.';
  }
  return 'Automatic target writes require `review-and-fix` and a selected guard mode: use `guard=git` with a tracked, clean, HEAD-backed git target, or `guard=snapshot` with a valid snapshot rollback anchor. The target-only guard must remain available and parseable before and after writes.';
}

function defaultGuardFor(route) {
  return route.routeKind === 'r2p' ? 'snapshot' : 'git';
}

// The header identity lines under the title. Document routes show the fixed
// `Document type:`; PR/CODE replace it with a route-kind line and no type.
function routeHeaderFor(route) {
  if (route.routeKind === 'pr') {
    return `Route name: ${route.routeName}\nReview target: PR diff (base..HEAD file set)`;
  }
  if (route.routeKind === 'code') {
    return `Route name: ${route.routeName}\nReview target: source scope file set`;
  }
  if (route.routeKind === 'r2p') {
    return `Route name: ${route.routeName}\nReview target: r2p requirement directory (07-plan.md, fixes backward into 03–06)`;
  }
  return `Route name: ${route.routeName}\nDocument type: ${route.documentType}`;
}

function platformInvocationText(platform, route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') {
    return codeRouteInvocationText(platform, route);
  }
  if (route.routeKind === 'r2p') {
    return r2pInvocationText(platform, route);
  }
  if (platform === 'claude') {
    return [
      'Use this Claude Code command with a bare `<path>` target as the recommended form, or full `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'optional `read-only` or `review-and-fix`, optional `assurance=practical|strict-verified|advisory`,',
      'optional `guard=git|snapshot`, optional `resume` or `reset`, optional `ledger=<target-local path>`, optional `root=<project-root>`, and optional `debug`.',
      'When a valid target is present and mode plus assurance are omitted, Claude Code selects `review-and-fix` and `practical`.',
      'Explicit `assurance=advisory` without mode selects `read-only`; advisory assurance cannot write targets.',
      'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
      'Advisory read-only skips the subagent probe but still proves stdin handoff before semantic payload commands.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].join('\n');
  }
  if (platform === 'codex') {
    return [
      'Use this Codex skill with a bare `<path>` target as the recommended form, or full `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'optional `read-only` or `review-and-fix`, optional `assurance=practical|strict-verified|advisory`,',
      'optional `guard=git|snapshot`, optional `resume` or `reset`, optional `ledger=<target-local path>`, optional `root=<project-root>`, and optional `debug`.',
      'When a valid target is present and mode plus assurance are omitted, Codex selects `review-and-fix` and `practical`.',
      'Explicit `assurance=advisory` without mode selects `read-only`; advisory assurance cannot write targets.',
      'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
      'Advisory read-only skips the subagent probe but still proves stdin handoff before semantic payload commands.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.',
      'Before any target read or workflow command, read the copied shared source files from this skill directory offline; if the skill or shared source ownership markers are missing, fail closed instead of falling back.'
    ].join('\n');
  }
  if (platform === 'gemini') {
    return [
      'Use this Gemini command with a bare `<path>` target as the recommended form, or full `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'optional `read-only`, optional `assurance=advisory`, optional `guard=git|snapshot`, optional `root=<project-root>`, and optional `debug`.',
      'When a valid target is present and mode is omitted, Gemini selects `read-only`; when assurance is omitted, Gemini selects `advisory`.',
      'Gemini remains advisory-only: `review-and-fix` is unsupported, workflow PASS is unavailable, and Gemini must not edit target files.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].join('\n');
  }
  if (platform === 'opencode') {
    return [
      'Use this opencode command with a bare `<path>` target as the recommended form, or full `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'optional `read-only` or `review-and-fix`, optional `assurance=practical|strict-verified|advisory`,',
      'optional `guard=git|snapshot`, optional `resume` or `reset`, optional `ledger=<target-local path>`, optional `root=<project-root>`, and optional `debug`.',
      'When a valid target is present and mode plus assurance are omitted, opencode selects `review-and-fix` and `practical`.',
      'Explicit `assurance=advisory` without mode selects `read-only`; advisory assurance cannot write targets.',
      'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
      'Advisory read-only skips the subagent probe but still proves stdin handoff before semantic payload commands.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].join('\n');
  }
  fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
}

// Top-of-route usage prose for the code routes (review-fix-pr / review-fix-code).
// Reduced grammar: no ref=, strict/normal, assurance=, or ledger=. Claude/Codex
// default omitted mode to review-and-fix and materialize practical internally;
// Gemini is advisory-only.
function codeRouteInvocationText(platform, route) {
  const token = route.routeKind === 'pr' ? 'base=<branch>' : 'scope=<path>';
  const tokenRequirement = route.routeKind === 'pr'
    ? `required \`${token}\``
    : 'optional `scope=<path>` tokens (repeat `scope=<path>` for multiple roots; omit scope to review the project root)';
  const wholeRootCapText = route.routeKind === 'code'
    ? 'A whole-root CODE review within the single-pass budget of 300 files or 1,500,000 bytes (counted after all exclusions) runs in one pass; a larger whole-root file set is reviewed as a partitioned project review (a deterministic, multi-phase, unit-by-unit review) instead of blocking — narrow with `scope=<path>` or ignore rules to keep it a single pass. Version-control-ignored files are excluded automatically via local read-only git queries (tracked files are never ignored; non-git roots skip this source). A project-root `.drfxignore` file adds user exclusions with `.gitignore` syntax (globs, `!` negation, `/` anchoring, trailing-`/` directory-only patterns). An explicit `scope=` always wins: a scoped directory or file is reviewed even when an ignore source covers it.'
    : null;
  if (platform === 'gemini') {
    return [
      `Use this Gemini command with ${tokenRequirement}, optional \`read-only\`, optional \`guard=git|snapshot\`, optional \`root=<project-root>\`, and optional \`debug\`.`,
      wholeRootCapText,
      'This is a code route and is advisory-only on Gemini: `review-and-fix` is unsupported, workflow PASS is unavailable, Gemini must not edit files, and it must not claim workflow PASS.',
      'It does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, or `rounds=`.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].filter(Boolean).join('\n');
  }
  const surface = platform === 'codex'
    ? 'Codex skill'
    : platform === 'opencode'
      ? 'opencode command'
      : 'Claude Code command';
  const subject = platform === 'codex' ? 'Codex' : platform === 'opencode' ? 'opencode' : 'Claude Code';
  return [
    `Use this ${surface} with ${tokenRequirement}, optional \`read-only\` or \`review-and-fix\`, optional \`guard=git|snapshot\`, optional \`resume\` or \`reset\`, optional \`rounds=<n>\`, optional \`root=<project-root>\`, and optional \`debug\`.`,
    wholeRootCapText,
    route.routeKind === 'pr'
      ? `When a valid ${token} is present and mode is omitted, ${subject} selects \`review-and-fix\`.`
      : `When mode is omitted, ${subject} selects \`review-and-fix\`.`,
    'This code route exposes no `assurance=` token; for `review-and-fix` it internally materializes `practical` assurance, so auto-fix is not rejected as `advisory-review-and-fix-unsupported`.',
    'It does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, or `ledger=`.',
    'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
    'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
  ].filter(Boolean).join('\n');
}

// Top-of-route usage prose for review-fix-r2p. r2p reviews an r2p requirement
// directory (the 07-plan.md anchor) and fixes backward into the owning upstream
// docs (03–06); run.md is a read-only gate. Fixed PLAN rubric: no ref=, strict/
// normal, assurance=, or ledger= surface. Default guard is snapshot. Gemini is
// advisory-only.
function r2pInvocationText(platform, route) {
  const name = route.routeName;
  if (platform === 'gemini') {
    return [
      `Use this Gemini command with \`target=<requirement-dir>\` naming an r2p requirement directory (\`<project>/.req-to-plan/WF-*\`), optional \`read-only\`, optional \`guard=git|snapshot\`, optional \`root=<project-root>\`, and optional \`debug\`.`,
      'This route reviews the requirement plan (`07-plan.md`) and is advisory-only on Gemini: `review-and-fix` is unsupported, workflow PASS is unavailable, Gemini must not edit files, and it must not claim workflow PASS.',
      'It does not accept `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, `scope=`, `base=`, or `rounds=`. `run.md` is a read-only gate that is never written.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].join('\n');
  }
  const surface = platform === 'codex'
    ? 'Codex skill'
    : platform === 'opencode'
      ? 'opencode command'
      : 'Claude Code command';
  const subject = platform === 'codex' ? 'Codex' : platform === 'opencode' ? 'opencode' : 'Claude Code';
  return [
    `Use this ${surface} with \`target=<requirement-dir>\` naming an r2p requirement directory (\`<project>/.req-to-plan/WF-*\`), optional \`read-only\` or \`review-and-fix\`, optional \`guard=git|snapshot\` (default \`snapshot\`), optional \`resume\` or \`reset\`, optional \`rounds=<n>\`, optional \`root=<project-root>\`, and optional \`debug\`.`,
    `When a valid \`target=<requirement-dir>\` is present and mode is omitted, ${subject} selects \`review-and-fix\`.`,
    'This route reviews the requirement plan (`07-plan.md`) and fixes backward into the owning upstream docs (`03–06`); it never edits `run.md` or any file outside `03–07`. `run.md` is a read-only gate.',
    'This route has a fixed PLAN rubric and exposes no `assurance=` token; for `review-and-fix` it internally materializes `practical` assurance, so auto-fix is not rejected as `advisory-review-and-fix-unsupported`.',
    'It does not accept `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, `scope=`, or `base=`.',
    'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
    'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
  ].join('\n');
}

function partitionedReviewFlowFor(platform, route) {
  if (route.routeKind !== 'code' || platform === 'gemini') return '';

  const runtimePlatform = runtimePlatformFor(platform);
  const routeName = route.routeName;
  const targetToken = targetTokenFor(route);

  return [
    '',
    '### Partitioned CODE Review Flow',
    '',
    'For `review-fix-code`, when workflow start or context reports `reviewMode: partitioned`, run this partitioned loop before the generic non-partitioned loop. Do not run `--phase initial-review` to claim a project PASS for a partitioned project review.',
    '',
    `1. Request the next bounded unit with \`drfx workflow context ${routeName} ${targetToken} review-and-fix guard=<selectedGuard> --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase unit-review --json=compact\`. Omit \`--unit\` for the resume cursor; add \`--unit <unitId>\` only when retrying a named unit.`,
    `2. For a normal unit, spawn a read-only reviewer over only that unit context and record both semantic payloads with \`drfx workflow record-review ${routeName} ${targetToken} review-and-fix guard=<selectedGuard> --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase unit-review --unit <unitId> --result-stdin --payload-file <safe-coverage-receipt-file> --json=compact\`. The reviewer findings and coverage receipt are both required; if the runtime cannot safely deliver the two payloads, fail closed before recording.`,
    '3. When a unit context carries a `chunk` block on a member, read exactly that member\'s `chunk.contextLineRange` slice from disk into the reviewer prompt in memory; never ask the reviewer to read the whole file and never persist the slice. Treat lines outside `chunk.primaryLineRange` as overlap context only, and report line-specific findings at `<path>:<line>`.',
    '4. If a unit context returns `oversize: true`, do not read the oversize file body and do not mark it clean. Record a FAIL reviewer result plus a coverage receipt with `Reviewed: false`, `Coverage risk: high`, and the skipped path/reason so aggregation remains coverage-incomplete.',
    `5. Repeat \`--phase unit-review\` until context returns \`status: all-units-reviewed\`, then request each required backstop with \`drfx workflow context ${routeName} ${targetToken} review-and-fix guard=<selectedGuard> --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase crosscutting --backstop <backstopId> --json=compact\`.`,
    `6. Record each backstop with \`drfx workflow record-review ${routeName} ${targetToken} review-and-fix guard=<selectedGuard> --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase crosscutting --backstop <backstopId> --result-stdin --payload-file <safe-coverage-receipt-file> --json=compact\`. Omit \`--unit\` so the workflow spans every planned unit; a partial span must stay \`coverage_risk: high\`.`,
    '7. After all units and backstops are recorded, run `drfx workflow aggregate-review <targetStateDir> --json=compact`. Treat the aggregate verdict as authoritative: only `verdict: PASS` may proceed to clean finalization. If `reason: coverage-incomplete`, review the uncovered units/backstops and do not run `record-triage` or `begin-fix` for that aggregate-only deferral. If active mode is `read-only` and aggregate returns `stopped-with-deferrals` with a `reviewerReportPath`, run `record-triage` for the accepted findings so ledger issue ids exist, then finalize the read-only findings; do not run `begin-fix`. If active mode is `review-and-fix` and aggregate returns `stopped-with-deferrals` with a reviewer report path, record-triage the accepted findings and run `begin-fix`; after partitioned `end-fix` returns `reviewMode: partitioned`, do not run the generic `record-diff-review` step. Instead, return to step 1 so only the affected units and backstops are re-reviewed before re-aggregating.',
    ''
  ].join('\n');
}

function renderTemplate(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!Object.hasOwn(values, key)) fail('ERR_TEMPLATE_PLACEHOLDER', `unknown template placeholder: ${key}`);
    return values[key];
  });
}

function renderPlatformRoute(platform, routeName, options = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const route = routeFor(routeName);
  const packageVersion = options.packageVersion || readPackageVersion();
  const template = fs.readFileSync(path.join(TEMPLATE_DIR, PLATFORM_TEMPLATES[normalizedPlatform]), 'utf8');
  const values = {
    ROUTE_NAME: route.routeName,
    PACKAGE_VERSION: packageVersion,
    ROUTE_HEADER: routeHeaderFor(route),
    TARGET_TOKEN: targetTokenFor(route),
    INVOCATION_GRAMMAR: invocationGrammarFor(normalizedPlatform, route),
    ROUTE_CONTRACT: routeContractFor(normalizedPlatform, route),
    INVOCATION_GATE_BODY: invocationGateBodyFor(normalizedPlatform, route),
    ROUTE_SUMMARY: routeSummaryFor(route),
    METADATA_TYPE: metadataTypeFor(route),
    ROUNDS_TOKEN: roundsTokenFor(normalizedPlatform),
    STATE_CONTROL_TOKEN: stateControlTokenFor(normalizedPlatform),
    EMBEDDED_SHARED_CONTENT: embeddedSharedContentForPlatform(normalizedPlatform, route, options),
    PLATFORM_INVOCATION_TEXT: platformInvocationText(normalizedPlatform, route),
    RUNTIME_FLAGS: runtimeFlagsContent(normalizedPlatform, route),
    PREFLIGHT_ASSURANCE_TEXT: preflightAssuranceTextFor(route),
    RUNTIME_PROBE_ASSURANCE_TEXT: runtimeProbeAssuranceTextFor(normalizedPlatform, route),
    ADVISORY_PROBE_SKIP_TEXT: advisoryProbeSkipTextFor(route),
    STRICT_VERIFIED_INTRO_TEXT: strictVerifiedIntroTextFor(route),
    STRICT_VERIFIED_SELECTED_MODE_TEXT: strictVerifiedSelectedModeTextFor(normalizedPlatform, route),
    STRICT_VERIFIED_REVIEW_AND_FIX_TEXT: strictVerifiedReviewAndFixTextFor(route),
    PERSISTENT_PRACTICAL_INTRO_TEXT: persistentPracticalIntroTextFor(route),
    PERSISTENT_PRACTICAL_SUMMARY_TEXT: persistentPracticalSummaryTextFor(route, defaultGuardFor(route)),
    REVIEW_UNIT_VERIFICATION: reviewUnitVerificationFor(route),
    REVIEW_SEMANTIC_NOUN: reviewSemanticNounFor(route),
    REVIEW_BODY_NOUN: reviewBodyNounFor(route),
    FIX_WRITE_BOUNDARY: fixWriteBoundaryFor(route),
    GUARD_WRITE_REQUIREMENT: guardWriteRequirementFor(route),
    DEFAULT_GUARD: defaultGuardFor(route),
    PARTITIONED_REVIEW_FLOW: partitionedReviewFlowFor(normalizedPlatform, route)
  };
  return renderTemplate(template, values);
}

function generatedFile(relativePath, content, extra = {}) {
  return { kind: 'file', relativePath, content, ...extra };
}

function generateCodexSkill(route, packageVersion, options = {}) {
  const skillText = renderPlatformRoute('codex', route.routeName, {
    packageVersion,
    codexSharedMode: options.codexSharedMode
  });
  return {
    kind: 'directory',
    platform: 'codex',
    routeName: route.routeName,
    documentType: route.documentType,
    relativePath: path.join('skills', route.routeName),
    requiresOwnedSharedSource: options.codexSharedMode !== 'embedded',
    files: [
      generatedFile('SKILL.md', skillText),
      generatedFile('.drfx-owned', `${PACKAGE_NAME}\n`),
      generatedFile(CODEX_SHARED_OWNERSHIP_MARKER, `${PACKAGE_NAME}\n`),
      ...sharedRelativePathsForRoute(route).map((relativePath) =>
        generatedFile(relativePath, readText(relativePath), { sourcePath: relativePath })
      )
    ]
  };
}

function generatePlatformFiles(platform, options = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const packageVersion = options.packageVersion || readPackageVersion();
  // Emit all seven routes (four document routes, then pr, then code, then r2p).
  const routes = listRoutes();

  if (normalizedPlatform === 'codex') {
    return routes.map((route) => generateCodexSkill(route, packageVersion, options));
  }

  const extension = normalizedPlatform === 'gemini' ? 'toml' : 'md';
  return routes.map((route) =>
    generatedFile(
      path.join('commands', `${route.routeName}.${extension}`),
      renderPlatformRoute(normalizedPlatform, route.routeName, { packageVersion }),
      {
        platform: normalizedPlatform,
        routeName: route.routeName,
        documentType: route.documentType
      }
    )
  );
}

function copySharedAssets(destinationDir, options = {}) {
  const documentType = options.documentType || 'COMMON';
  const destinationRoot = path.resolve(destinationDir);
  const copied = [];

  const relativePaths = options.all ? allSharedRelativePaths() : sharedRelativePaths(documentType);
  for (const relativePath of relativePaths) {
    const sourcePath = path.join(ROOT, relativePath);
    const destinationPath = path.join(destinationRoot, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    copied.push({
      relativePath,
      sourcePath,
      path: destinationPath
    });
  }

  return copied;
}

module.exports = {
  ROUTES,
  renderPlatformRoute,
  generatePlatformFiles,
  allSharedRelativePaths,
  copySharedAssets
};
