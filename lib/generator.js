'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_NAME = '@xenonbyte/document-review-fix';
const ROOT = path.join(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'templates');
const SHARED_DIR = path.join(ROOT, 'shared');

const ROUTES = Object.freeze({
  'review-fix-spec': Object.freeze({ routeName: 'review-fix-spec', documentType: 'SPEC', rubric: 'spec' }),
  'review-fix-plan': Object.freeze({ routeName: 'review-fix-plan', documentType: 'PLAN', rubric: 'plan' }),
  'review-fix-design': Object.freeze({ routeName: 'review-fix-design', documentType: 'DESIGN', rubric: 'design' }),
  'review-fix-doc': Object.freeze({ routeName: 'review-fix-doc', documentType: 'COMMON', rubric: null })
});

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
  const route = ROUTES[routeName];
  if (!route) fail('ERR_ROUTE', `unsupported route: ${routeName}`);
  return route;
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return packageJson.version;
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function sharedRelativePaths(documentType) {
  const route = Object.values(ROUTES).find((candidate) => candidate.documentType === documentType);
  if (!route) fail('ERR_DOCUMENT_TYPE', `unsupported document type: ${documentType}`);

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

function allSharedRelativePaths() {
  const paths = new Set();
  for (const route of Object.values(ROUTES)) {
    for (const relativePath of sharedRelativePaths(route.documentType)) paths.add(relativePath);
  }
  return [...paths].sort();
}

function embeddedSharedContent(route) {
  return sharedRelativePaths(route.documentType)
    .map((relativePath) => {
      const content = readText(relativePath).trimEnd();
      return `<!-- ${relativePath} -->\n\n${content}`;
    })
    .join('\n\n---\n\n');
}

function platformInvocationText(platform, route) {
  if (platform === 'claude') {
    return [
      'Use this Claude command with `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'required `read-only` or `review-and-fix` to start workflow, optional `assurance=practical|strict-verified|advisory`,',
      'optional `resume`, optional `ledger=<target-local path>`, and optional `root=<project-root>`.',
      'Without an explicit mode token, explain usage only and do not read files or run workflow commands.'
    ].join('\n');
  }
  if (platform === 'codex') {
    return [
      'Use this Codex skill with `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'required `read-only` or `review-and-fix` to start workflow, optional `assurance=practical|strict-verified|advisory`,',
      'optional `resume`, optional `ledger=<target-local path>`, and optional `root=<project-root>`.',
      'Without an explicit mode token, explain usage only and do not read files or run workflow commands.',
      'Read copied shared files from this skill directory when useful; the embedded contract below is authoritative for this generated route.'
    ].join('\n');
  }
  if (platform === 'gemini') {
    return [
      'Use this Gemini command with `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'explicit `read-only` to start advisory review, optional `assurance=advisory`, and optional `root=<project-root>`.',
      'Without an explicit mode token, explain usage only and do not read files or run workflow commands.',
      'Gemini v1 must stay advisory-only: produce read-only findings, do not edit files, and do not claim workflow PASS.'
    ].join('\n');
  }
  fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
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
  return renderTemplate(template, {
    ROUTE_NAME: route.routeName,
    DOCUMENT_TYPE: route.documentType,
    PACKAGE_VERSION: packageVersion,
    EMBEDDED_SHARED_CONTENT: embeddedSharedContent(route),
    PLATFORM_INVOCATION_TEXT: platformInvocationText(normalizedPlatform, route)
  });
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
      ...sharedRelativePaths(route.documentType).map((relativePath) =>
        generatedFile(relativePath, readText(relativePath), { sourcePath: relativePath })
      )
    ]
  };
}

function generatePlatformFiles(platform, options = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const packageVersion = options.packageVersion || readPackageVersion();
  const routes = Object.values(ROUTES);

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
