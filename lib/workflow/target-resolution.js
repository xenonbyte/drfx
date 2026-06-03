'use strict';

// PLAN-TASK-009 (Phase A): route-kind-aware target resolution.
//
// Document routes resolve a SINGLE-FILE target identity (deriveTargetKey over the
// normalized target path) exactly as before — unchanged behavior. PR/CODE routes
// resolve a FILE-SET target identity instead: the parser exposes `invocation.base`
// (PR) or `invocation.scopes` (CODE), NOT `invocation.target`, so calling
// deriveTargetKey/computeFingerprint on the undefined single-file target would crash
// or misbehave. This module is the single source of truth both `index.js` and
// `helpers.js` consume so neither dispatcher path reaches a single-file resolver
// with `target: undefined`.
//
// The file-set TARGET KEY derived here is intentionally cheap and synchronous: it
// hashes the route kind plus the stable base/scope identity (NOT the live git diff
// or working-tree file set). The live file set + its fingerprint are resolved and
// persisted only in start.js (Phase B), through the PLAN-TASK-003/004 helpers. This
// keeps workflowBase() synchronous so every existing document-route call path stays
// byte-for-byte unchanged.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  deriveTargetKey,
  resolveProjectRoot
} = require('../target-state');
const { normalizeCodeScopesForIdentity } = require('../target-context');
const { stableJson } = require('./serialization');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function routeKindFor(parsed) {
  return (parsed && parsed.invocation && parsed.invocation.routeKind) || 'document';
}

function isFileSetRoute(parsed) {
  const kind = routeKindFor(parsed);
  return kind === 'pr' || kind === 'code';
}

// Resolve the project root for a file-set (PR/CODE) route. Unlike document routes,
// there is no single target file to anchor on, so the root is the explicit root= when
// given, otherwise the working directory. The directory must exist; we never invent a
// missing root. realpath keeps it stable across symlinked temp dirs (matching how the
// document path canonicalizes through resolveProjectRoot).
function resolveFileSetProjectRoot(parsed, options = {}) {
  const cwd = options.cwd || process.cwd();
  const explicitRoot = parsed.invocation.root;
  const candidate = explicitRoot ? path.resolve(explicitRoot) : path.resolve(cwd);
  let stats;
  try {
    stats = fs.statSync(candidate);
  } catch {
    fail('ERR_FILE_SET_ROOT_MISSING', `project root must exist: ${candidate}`);
  }
  if (!stats.isDirectory()) {
    fail('ERR_FILE_SET_ROOT_MISSING', `project root must be a directory: ${candidate}`);
  }
  return fs.realpathSync.native(candidate);
}

// Stable, order-independent identity string for a file-set route. PR identity is the
// base ref; CODE identity is the sorted scope list (empty ⇒ whole-root). This is the
// stable seed for the target key (which is content-independent on purpose — the same
// base/scope selection always maps to the same target-state directory, and a changed
// base/scope is a different review target). Live content drift is detected separately
// via the file-set fingerprint stored in the manifest.
function fileSetIdentitySeed(parsed, options = {}) {
  const kind = routeKindFor(parsed);
  if (kind === 'pr') {
    const base = String(parsed.invocation.base || '');
    return stableJson({ kind, base });
  }
  if (kind === 'code') {
    const scopes = Array.isArray(options.normalizedScopes)
      ? options.normalizedScopes.map((scope) => String(scope)).sort()
      : (Array.isArray(parsed.invocation.scopes)
        ? parsed.invocation.scopes.map((scope) => String(scope)).sort()
        : []);
    return stableJson({ kind, scopes });
  }
  fail('ERR_FILE_SET_ROUTE', `fileSetIdentitySeed requires a pr or code route, got: ${kind}`);
}

// Derive a deterministic file-set target key: `${routeKind}-${hash12}`. Mirrors the
// document slug-hash shape (`<slug>-<hash12>`) so the target-state directory layout
// stays uniform across kinds and the manifest Target key invariant holds.
function deriveFileSetTargetKey(parsed, options = {}) {
  const seed = fileSetIdentitySeed(parsed, options);
  const hash12 = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return `${routeKindFor(parsed)}-${hash12}`;
}

// Route-kind-aware target metadata. Document ⇒ the single-file metadata
// (normalizedTarget/targetKey/slug/hash12) exactly as deriveTargetKey returns it.
// PR/CODE ⇒ file-set metadata: a route-kind target key, the resolved project root,
// and the route kind. There is NO normalizedTarget for file-set routes (the unit of
// review is a set, not one path), and NO single-file fingerprint.
function resolveRouteTargetMetadata(parsed, options = {}) {
  if (!isFileSetRoute(parsed)) {
    const projectRoot = resolveProjectRoot({
      explicitRoot: parsed.invocation.root,
      targetPath: parsed.invocation.target,
      cwd: options.cwd || process.cwd(),
      persistentStateRequired: true
    });
    return {
      routeKind: 'document',
      projectRoot,
      ...deriveTargetKey(projectRoot, parsed.invocation.target)
    };
  }
  const projectRoot = resolveFileSetProjectRoot(parsed, options);
  const normalizedScopes = routeKindFor(parsed) === 'code'
    ? normalizeCodeScopesForIdentity({ cwd: projectRoot, scopes: parsed.invocation.scopes || [] })
    : null;
  return {
    routeKind: routeKindFor(parsed),
    projectRoot,
    targetKey: deriveFileSetTargetKey(parsed, normalizedScopes ? { normalizedScopes } : {}),
    normalizedTarget: null,
    base: parsed.invocation.base || null,
    scopes: normalizedScopes || (Array.isArray(parsed.invocation.scopes) ? parsed.invocation.scopes.slice() : null)
  };
}

module.exports = {
  routeKindFor,
  isFileSetRoute,
  resolveFileSetProjectRoot,
  fileSetIdentitySeed,
  deriveFileSetTargetKey,
  resolveRouteTargetMetadata
};
