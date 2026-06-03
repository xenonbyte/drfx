'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getRouteDescriptor, listDocumentRoutes, listRoutes } = require('./routes');

const PACKAGE_NAME = '@xenonbyte/document-review-fix';
const ROOT = path.join(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'templates');
const FRAGMENT_DIR = path.join(TEMPLATE_DIR, 'fragments');
const SHARED_DIR = path.join(ROOT, 'shared');

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
  gemini: 'gemini-command.toml.tmpl'
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
  // Delegate to the shared registry. All six route kinds (document/pr/code) are
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
// Keyed on the route's `rubric` (null for review-fix-doc), so it works for
// document routes AND the pr/code routes whose rubric is 'pr'/'code'.
function sharedRelativePathsForRoute(route) {
  const paths = [
    path.join('shared', 'core.md'),
    path.join('shared', 'long-task.md'),
    path.join('shared', 'rubrics', 'common.md'),
    path.join('shared', 'prompts', 'reviewer.md'),
    path.join('shared', 'prompts', 'fixer.md'),
    path.join('shared', 'prompts', 'coordinator.md')
  ];
  if (route.rubric) paths.splice(3, 0, path.join('shared', 'rubrics', `${route.rubric}.md`));
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
  if (route.routeKind === 'code') return 'scope=<path>';
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
  const template = readText(path.join('shared', 'runtime-flags.md'));
  return renderTemplate(template, {
    ROUTE_NAME: route.routeName,
    RUNTIME_PLATFORM: runtimePlatformFor(platform),
    TARGET_TOKEN: targetTokenFor(route)
  });
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
    return `${name} base=<branch> [read-only|review-and-fix] [guard=git|snapshot] [resume] [rounds=<n>] [root=<project-root>] [debug]`;
  }
  if (route.routeKind === 'code') {
    if (platform === 'gemini') {
      return `${name} scope=<path> [scope=<path>...] [read-only] [guard=git|snapshot] [root=<project-root>] [debug]`;
    }
    return `${name} scope=<path> [scope=<path>...] [read-only|review-and-fix] [guard=git|snapshot] [resume] [rounds=<n>] [root=<project-root>] [debug]`;
  }
  if (platform === 'gemini') {
    // Gemini is advisory read-only; rounds=<n> loop semantics are unsupported in
    // read-only mode, so its grammar does not advertise the rounds token.
    return `${name} <path> [ref=<path>...] [read-only] [strict|normal] [assurance=advisory] [guard=git|snapshot] [root=<project-root>] [debug]`;
  }
  return `${name} <path> [ref=<path>...] [read-only|review-and-fix] [strict|normal] [assurance=practical|strict-verified|advisory] [guard=git|snapshot] [resume] [rounds=<n>] [ledger=<target-local path>] [root=<project-root>] [debug]`;
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
  return `${route.documentType} documents`;
}

// The Gemini [metadata] type line. Document routes keep `document_type`;
// PR/CODE record their review target kind instead.
function metadataTypeFor(route) {
  if (route.routeKind === 'pr') return 'review_target = "pr-diff"';
  if (route.routeKind === 'code') return 'review_target = "source-scope"';
  return `document_type = "${route.documentType}"`;
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
  return `Route name: ${route.routeName}\nDocument type: ${route.documentType}`;
}

function platformInvocationText(platform, route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') {
    return codeRouteInvocationText(platform, route);
  }
  if (platform === 'claude') {
    return [
      'Use this Claude Code command with a bare `<path>` target as the recommended form, or full `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'optional `read-only` or `review-and-fix`, optional `assurance=practical|strict-verified|advisory`,',
      'optional `guard=git|snapshot`, optional `resume`, optional `ledger=<target-local path>`, optional `root=<project-root>`, and optional `debug`.',
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
      'optional `guard=git|snapshot`, optional `resume`, optional `ledger=<target-local path>`, optional `root=<project-root>`, and optional `debug`.',
      'When a valid target is present and mode plus assurance are omitted, Codex selects `review-and-fix` and `practical`.',
      'Explicit `assurance=advisory` without mode selects `read-only`; advisory assurance cannot write targets.',
      'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
      'Advisory read-only skips the subagent probe but still proves stdin handoff before semantic payload commands.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.',
      'Read copied shared files from this skill directory when useful; the embedded contract below is authoritative for this generated route.'
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
  fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
}

// Top-of-route usage prose for the code routes (review-fix-pr / review-fix-code).
// Reduced grammar: no ref=, strict/normal, assurance=, or ledger=. Claude/Codex
// default omitted mode to review-and-fix and materialize practical internally;
// Gemini is advisory-only.
function codeRouteInvocationText(platform, route) {
  const token = targetTokenFor(route);
  const required = route.routeKind === 'pr' ? 'base=<branch>' : 'scope=<path>';
  const repeatable = route.routeKind === 'code' ? ' (repeat `scope=<path>` for multiple roots)' : '';
  if (platform === 'gemini') {
    return [
      `Use this Gemini command with required \`${token}\`${repeatable}, optional \`read-only\`, optional \`guard=git|snapshot\`, optional \`root=<project-root>\`, and optional \`debug\`.`,
      'This is a code route and is advisory-only on Gemini: `review-and-fix` is unsupported, workflow PASS is unavailable, Gemini must not edit files, and it must not claim workflow PASS.',
      'It does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, or `rounds=`.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].join('\n');
  }
  const surface = platform === 'codex' ? 'Codex skill' : 'Claude Code command';
  return [
    `Use this ${surface} with required \`${token}\`${repeatable}, optional \`read-only\` or \`review-and-fix\`, optional \`guard=git|snapshot\`, optional \`resume\`, optional \`rounds=<n>\`, optional \`root=<project-root>\`, and optional \`debug\`.`,
    `When a valid ${required} is present and mode is omitted, ${platform === 'codex' ? 'Codex' : 'Claude Code'} selects \`review-and-fix\`.`,
    'This code route exposes no `assurance=` token; for `review-and-fix` it internally materializes `practical` assurance, so auto-fix is not rejected as `advisory-review-and-fix-unsupported`.',
    'It does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, or `ledger=`.',
    'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
    'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
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
    ROUNDS_TOKEN: ' rounds=<roundLimit>',
    EMBEDDED_SHARED_CONTENT: embeddedSharedContent(route),
    PLATFORM_INVOCATION_TEXT: platformInvocationText(normalizedPlatform, route),
    RUNTIME_FLAGS: runtimeFlagsContent(normalizedPlatform, route)
  };
  return renderTemplate(template, values);
}

function generatedFile(relativePath, content, extra = {}) {
  return { kind: 'file', relativePath, content, ...extra };
}

function generateCodexSkill(route, packageVersion) {
  const skillText = renderPlatformRoute('codex', route.routeName, { packageVersion });
  return {
    kind: 'directory',
    platform: 'codex',
    routeName: route.routeName,
    documentType: route.documentType,
    relativePath: path.join('skills', route.routeName),
    files: [
      generatedFile('SKILL.md', skillText),
      generatedFile('.document-review-loop-owned', `${PACKAGE_NAME}\n`),
      ...sharedRelativePathsForRoute(route).map((relativePath) =>
        generatedFile(relativePath, readText(relativePath), { sourcePath: relativePath })
      )
    ]
  };
}

function generatePlatformFiles(platform, options = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const packageVersion = options.packageVersion || readPackageVersion();
  // Emit all six routes (four document routes, then pr, then code).
  const routes = listRoutes();

  if (normalizedPlatform === 'codex') {
    return routes.map((route) => generateCodexSkill(route, packageVersion));
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
