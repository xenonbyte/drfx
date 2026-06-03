'use strict';

// PLAN-TASK-009 (Phase C): file-set (PR/CODE) resume + finalize.
//
// Resume requires the EXPLICIT `resume` token (enforced by the dispatcher) and REFUSES a
// stale identity: the stored manifest identity is compared STRICTLY (every field incl
// roundLimit, and for CODE the scope/exclusion lists) against the live re-resolved identity
// via comparePrIdentity / compareCodeIdentity. ANY drift ⇒ stale ⇒ refuse (never silent
// reuse). The resolvers are read-only (no git fetch/push/ref mutation).

const {
  buildPrIdentity,
  buildCodeIdentity,
  comparePrIdentity,
  compareCodeIdentity,
  fail,
  path,
  resolveCodeTarget,
  resolveFileSetPersistentMetadata,
  resolveTargetContext,
  stateValidationResult,
  withReadOnlyMode,
  workflowBase
} = require('./helpers');

function fileSetBase(parsed, metadata, overrides = {}) {
  return {
    ...workflowBase(parsed, { cwd: metadata.projectRoot }),
    targetStateDir: metadata.targetStateDir,
    manifestPath: metadata.manifestPath,
    targetKey: metadata.targetKey,
    routeKind: metadata.routeKind,
    round: Number(metadata.manifest.currentRound || 1),
    ...overrides
  };
}

async function liveIdentityFor(metadata, options) {
  const guardMode = metadata.manifest.guardMode || 'git';
  const roundLimit = metadata.manifest.roundLimit === 'none' || metadata.manifest.roundLimit === undefined
    ? null
    : metadata.manifest.roundLimit;
  if (metadata.routeKind === 'pr') {
    const context = await resolveTargetContext({
      routeName: 'review-fix-pr',
      base: metadata.manifest.base,
      cwd: metadata.projectRoot,
      commandLog: options.commandLog
    });
    return buildPrIdentity({ context, guardMode, roundLimit });
  }
  const context = await resolveCodeTarget({
    cwd: metadata.projectRoot,
    scopes: metadata.manifest.normalizedScopes || []
  });
  if (context && context.status === 'blocked') {
    fail('ERR_FILE_SET_RESOLVE', `excluded-scope: ${context.scope}`);
  }
  return buildCodeIdentity({ context, guardMode, roundLimit });
}

// Build the stored identity from the durable manifest, in the same shape buildPrIdentity /
// buildCodeIdentity produce, so the strict compare is field-for-field.
function storedIdentityFor(metadata) {
  const roundLimit = metadata.manifest.roundLimit === undefined ? 'none' : String(metadata.manifest.roundLimit);
  const guardMode = String(metadata.manifest.guardMode || 'git');
  if (metadata.routeKind === 'pr') {
    return {
      targetContextKind: 'pr',
      base: String(metadata.manifest.base),
      baseRevision: String(metadata.manifest.baseRevision),
      mergeBase: String(metadata.manifest.mergeBase),
      head: String(metadata.manifest.head),
      guardMode,
      roundLimit,
      fileSetFingerprint: String(metadata.manifest.fileSetFingerprint)
    };
  }
  return {
    targetContextKind: 'code',
    normalizedScopes: Array.isArray(metadata.manifest.normalizedScopes) ? metadata.manifest.normalizedScopes : [],
    exclusions: Array.isArray(metadata.manifest.exclusions) ? metadata.manifest.exclusions : [],
    guardMode,
    roundLimit,
    fileSetFingerprint: String(metadata.manifest.fileSetFingerprint)
  };
}

async function runFileSetResume(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetPersistentMetadata(parsed, options);
  } catch (error) {
    return stateValidationResult(
      path.join(error && error.targetStateDir ? error.targetStateDir : process.cwd(), '.docs-review-fix'),
      error
    );
  }

  let liveIdentity;
  try {
    liveIdentity = await liveIdentityFor(metadata, options);
  } catch (error) {
    return {
      ...fileSetBase(parsed, metadata, {
        ok: false,
        status: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'none',
        errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
        message: error && error.message ? error.message : String(error),
        nextAction: 'resolve a valid base/scope file set before resuming'
      })
    };
  }

  const stored = storedIdentityFor(metadata);
  const comparison = metadata.routeKind === 'pr'
    ? comparePrIdentity({ stored, requested: liveIdentity })
    : compareCodeIdentity({ stored, requested: liveIdentity });

  if (!comparison.match) {
    // Stale identity: the live file set / base / scope / round limit drifted from the
    // recorded state. Refuse resume (never silent reuse, never PASS) and report the drift.
    return withReadOnlyMode({
      ...fileSetBase(parsed, metadata, {
        ok: false,
        status: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'none',
        errorCode: 'ERR_FILE_SET_STALE_IDENTITY',
        message: `stale file-set identity; mismatched fields: ${comparison.mismatches.join(', ')}`,
        staleIdentityFields: comparison.mismatches,
        nextAction: 'start a fresh review for the changed file set'
      })
    });
  }

  // Identity matches: resume to the manifest's current phase. The deterministic phase is the
  // persisted status/currentPhase; no single-file fingerprint replay is needed because the
  // file-set fingerprint already matched.
  const nextAction = manifestResumeNextAction(metadata.manifest);
  const ok = !['blocked', 'unsupported', 'externally-changed', 'possible-target-replacement', 'checkpoint'].includes(
    metadata.manifest.status
  );
  return fileSetBase(parsed, metadata, {
    ok,
    status: metadata.manifest.status,
    currentPhase: metadata.manifest.currentPhase,
    mode: metadata.manifest.mode,
    assurance: metadata.manifest.assurance,
    blockingReason: metadata.manifest.blockingReason || 'none',
    statusReason: metadata.manifest.statusReason || 'none',
    fileSetFingerprint: metadata.manifest.fileSetFingerprint,
    nextAction
  });
}

function manifestResumeNextAction(manifest) {
  if (manifest.status === 'review') return 'run workflow context for review';
  if (manifest.status === 'fix') return 'run begin-fix to continue the fix loop';
  if (manifest.status === 'diff-review') return 'run record-diff-review';
  if (manifest.status === 'full-re-review') return 'run full re-review';
  return 'continue from manifest current phase';
}

module.exports = {
  runFileSetResume,
  storedIdentityFor,
  liveIdentityFor
};
