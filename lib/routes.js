'use strict';

// Shared route registry — single source of truth for all six route descriptors.
// Generator and input modules consume this; they must not maintain their own route lists.

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// Platform policy: describes per-platform support for review-and-fix vs advisory-only.
// Gemini is advisory-only on all routes. Claude and Codex support review-and-fix on all routes.
// PR/CODE generation support on Codex/Claude is handled in PLAN-TASK-008.
const CLAUDE_CODEX_GEMINI_POLICY = Object.freeze({
  claude: 'review-and-fix',
  codex: 'review-and-fix',
  gemini: 'advisory-only'
});

// Registry: six routes in canonical order (four document routes, then pr, then code).
//
// `routeKind` and `targetContextKind` are deliberately separate axes even though they
// co-vary 1:1 for these six routes today. `routeKind` drives parser/generation/rulebook
// dispatch (PLAN-TASK-002/007/008); `targetContextKind` drives target resolution and
// state identity (single-file document vs git diff file-set vs source-scope file-set —
// PLAN-TASK-003/004/009). Keep them distinct so a future route can mix them (e.g. a new
// document-kind route that resolves a file-set context) without re-deriving one from the other.
const ROUTE_LIST = Object.freeze([
  Object.freeze({
    routeName: 'review-fix-spec',
    routeKind: 'document',
    documentType: 'SPEC',
    rubric: 'spec',
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'document',
    platformPolicy: CLAUDE_CODEX_GEMINI_POLICY
  }),
  Object.freeze({
    routeName: 'review-fix-plan',
    routeKind: 'document',
    documentType: 'PLAN',
    rubric: 'plan',
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'document',
    platformPolicy: CLAUDE_CODEX_GEMINI_POLICY
  }),
  Object.freeze({
    routeName: 'review-fix-design',
    routeKind: 'document',
    documentType: 'DESIGN',
    rubric: 'design',
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'document',
    platformPolicy: CLAUDE_CODEX_GEMINI_POLICY
  }),
  Object.freeze({
    routeName: 'review-fix-doc',
    routeKind: 'document',
    documentType: 'COMMON',
    rubric: null,
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'document',
    platformPolicy: CLAUDE_CODEX_GEMINI_POLICY
  }),
  Object.freeze({
    routeName: 'review-fix-pr',
    routeKind: 'pr',
    documentType: null,
    rubric: 'pr',
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'pr',
    platformPolicy: CLAUDE_CODEX_GEMINI_POLICY
  }),
  Object.freeze({
    routeName: 'review-fix-code',
    routeKind: 'code',
    documentType: null,
    rubric: 'code',
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'code',
    platformPolicy: CLAUDE_CODEX_GEMINI_POLICY
  })
]);

// Build a fast lookup map from routeName → descriptor.
const ROUTE_MAP = Object.freeze(
  Object.fromEntries(ROUTE_LIST.map((route) => [route.routeName, route]))
);

// Pre-computed, frozen slice of document routes so listDocumentRoutes() returns a stable,
// immutable value with the same guarantees as listRoutes() (no fresh mutable array per call).
const DOCUMENT_ROUTE_LIST = Object.freeze(
  ROUTE_LIST.filter((route) => route.routeKind === 'document')
);

/**
 * Return all six route descriptors in canonical order.
 * @returns {readonly object[]}
 */
function listRoutes() {
  return ROUTE_LIST;
}

/**
 * Return only the four document routes (routeKind === 'document').
 * Generator uses this to avoid attempting to render PR/CODE routes with document templates.
 * @returns {readonly object[]}
 */
function listDocumentRoutes() {
  return DOCUMENT_ROUTE_LIST;
}

/**
 * Return the descriptor for a single route by name.
 * Throws ERR_ROUTE for unknown names, matching the fail(code, message) pattern used in this package.
 * @param {string} routeName
 * @returns {object}
 */
function getRouteDescriptor(routeName) {
  const descriptor = ROUTE_MAP[routeName];
  if (!descriptor) fail('ERR_ROUTE', `unsupported route: ${routeName}`);
  return descriptor;
}

module.exports = {
  listRoutes,
  listDocumentRoutes,
  getRouteDescriptor
};
