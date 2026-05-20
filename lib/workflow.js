'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { validateCurrentDescriptor } = require('./capability');
const { buildContextPack, writeContextManifest } = require('./context-pack');
const {
  checkGitRollbackAnchor,
  checkTargetOnlyWorktree,
  inspectActualChangedFiles,
  formatFixGuardReport
} = require('./fix-guard');
const {
  validateFinalResponse,
  validateResumeState
} = require('./final-response');
const { parseInvocation } = require('./input');
const {
  applyTriageDecisions,
  formatLedger,
  parseLedger
} = require('./ledger');
const {
  acquireLock,
  refreshLock,
  assertPreFixFingerprint,
  releaseLock,
  readLease,
  readPersistedLeaseForTarget
} = require('./lock');
const { writeRoundReceipt } = require('./receipts');
const { mergeRules, parseRulebook } = require('./rulebook');
const {
  computeFingerprint,
  deriveTargetKey,
  normalizeReferences,
  readManifestAny,
  resolveProjectRoot,
  validateLedgerPath,
  validateTargetStateOwnedPath
} = require('./target-state');
const {
  createPreflightToken,
  createReviewGuard,
  nextStateToken,
  validateReviewGuard,
  validateStateToken
} = require('./no-state');
const { parseReviewerResult } = require('./reviewer-report');
const {
  parseDiffReview,
  parseFixReport,
  parseFinalResponseBlock,
  parseTriageResult,
  readSemanticPayload
} = require('./semantic-parsers');
const {
  atomicWriteFile,
  BLOCKING_REASONS,
  STATUS_REASONS,
  formatSummary,
  formatManifestV2,
  workflowJson
} = require('./workflow-state');

const WORKFLOW_SUBCOMMANDS = new Set([
  'start',
  'preflight',
  'context',
  'record-review',
  'record-triage',
  'begin-fix',
  'refresh-lock',
  'end-fix',
  'abort-fix',
  'record-diff-review',
  'finalize'
]);
const ASSURANCE_VALUES = new Set(['advisory', 'practical', 'strict-verified']);
const RUNTIME_PLATFORMS = new Set(['codex', 'claude-code', 'gemini', 'manual']);
const SUBAGENT_PROBES = new Set(['ready', 'unavailable', 'failed', 'not-required']);
const STDIN_HANDOFFS = new Set(['ready', 'unavailable', 'not-required']);
const NO_STATE_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NO_STATE_SUBCOMMANDS = new Set(['preflight', 'context', 'record-review', 'record-triage', 'finalize']);
const REVIEW_BACKED_NO_STATE_SUBCOMMANDS = new Set(['context', 'record-review', 'record-triage', 'finalize']);
const TARGET_STATE_SUBCOMMANDS = new Set(['begin-fix', 'refresh-lock', 'end-fix', 'abort-fix']);
const TARGET_STATE_DIR_SUBCOMMANDS = new Set([
  ...TARGET_STATE_SUBCOMMANDS,
  'record-diff-review'
]);
const PREFLIGHT_FORBIDDEN_FLAGS = Object.freeze([
  'stateToken',
  'reviewGuard',
  'result',
  'resultStdin',
  'triage',
  'triageStdin',
  'fixReport',
  'fixReportStdin',
  'finalResponse',
  'finalResponseStdin',
  'diffReview',
  'diffReviewStdin',
  'payload',
  'payloadFile',
  'payloadStdin'
]);
const DOWNGRADE_REASONS = new Set([
  'none',
  'subagent-delegation-unavailable',
  'reviewer-dispatch-failed',
  'reviewer-probe-invalid'
]);
const VALUE_FLAGS = new Set([
  'assurance',
  'runtime-platform',
  'runtime-subagent-probe',
  'runtime-stdin-handoff',
  'runtime-downgrade-reason',
  'capability-descriptor',
  'descriptor-directory',
  'proof-run-id',
  'terminal-status',
  'status',
  'reason',
  'next-action',
  'status-reason',
  'blocking-reason',
  'phase',
  'state-token',
  'review-guard',
  'result',
  'triage',
  'final-response',
  'fix-report',
  'diff-review',
  'payload',
  'payload-file'
]);
const BOOLEAN_FLAGS = new Set([
  'json',
  'no-state',
  'result-stdin',
  'triage-stdin',
  'final-response-stdin',
  'fix-report-stdin',
  'diff-review-stdin',
  'payload-stdin'
]);
const RESERVED_STATE_PATH_BASENAMES = new Set(['MANIFEST.md', 'CONTINUITY.md', 'SUMMARY.md']);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function failStateValidation(message) {
  fail('ERR_STATE_VALIDATION_FAILED', `state-validation-failed: ${message}`);
}

function camelCase(flag) {
  return flag.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function descriptorPlatformFor(runtimePlatform) {
  if (runtimePlatform === 'claude-code') return 'claude';
  return runtimePlatform;
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return packageJson.version;
}

function parseFlagToken(token) {
  const flag = token.slice(2);
  const index = flag.indexOf('=');
  if (index === -1) return [flag, null];
  return [flag.slice(0, index), flag.slice(index + 1)];
}

function parseWorkflowArgs(subcommand, args) {
  if (!WORKFLOW_SUBCOMMANDS.has(subcommand)) fail('ERR_WORKFLOW_COMMAND', `Unknown workflow command: ${subcommand}`);

  const flags = {};
  const tokens = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      tokens.push(arg);
      continue;
    }

    const [flag, inlineValue] = parseFlagToken(arg);
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== null) fail('ERR_WORKFLOW_FLAG', `--${flag} does not accept a value`);
      flags[camelCase(flag)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) fail('ERR_WORKFLOW_FLAG', `Unknown workflow option: --${flag}`);

    let value = inlineValue;
    if (value === null) {
      index += 1;
      if (index >= args.length) fail('ERR_WORKFLOW_FLAG_VALUE', `--${flag} requires a value`);
      value = args[index];
    }
    flags[camelCase(flag)] = value;
  }

  const persistentFinalize = subcommand === 'finalize' && !flags.noState && tokens.length === 1;
  if (TARGET_STATE_DIR_SUBCOMMANDS.has(subcommand) || persistentFinalize) {
    if (flags.noState) fail('ERR_NO_STATE_COMMAND', `no-state workflow does not support ${subcommand}`);
    if (tokens.length !== 1) {
      fail('ERR_TARGET_STATE_DIR', `${subcommand} requires exactly one target-state directory`);
    }
    return {
      subcommand,
      json: Boolean(flags.json),
      noState: false,
      targetStateDir: path.resolve(tokens[0]),
      payloadFlags: flags
    };
  }

  if (tokens.length === 0) fail('ERR_WORKFLOW_ENTRY_SKILL', 'workflow command requires an entry skill');
  const [entrySkill, ...invocationTokens] = tokens;
  const flagAssurance = flags.assurance || null;
  if (flagAssurance && !ASSURANCE_VALUES.has(flagAssurance)) fail('ERR_ASSURANCE', `Invalid assurance: ${flagAssurance}`);
  const invocation = parseInvocation(entrySkill, invocationTokens, {
    defaultMode: 'read-only',
    defaultAssurance: flagAssurance,
    includeMetadata: true
  });
  if (
    flagAssurance &&
    invocation.assuranceSource === 'explicit' &&
    invocation.requestedAssurance !== flagAssurance
  ) {
    fail('ERR_CONFLICTING_ASSURANCE', 'assurance= token and --assurance must match');
  }

  const assurance = flagAssurance || invocation.requestedAssurance || 'advisory';
  if (!ASSURANCE_VALUES.has(assurance)) fail('ERR_ASSURANCE', `Invalid assurance: ${assurance}`);
  if (flags.runtimePlatform && !RUNTIME_PLATFORMS.has(flags.runtimePlatform)) {
    fail('ERR_RUNTIME_PLATFORM', `Invalid runtime platform: ${flags.runtimePlatform}`);
  }
  if (flags.runtimeSubagentProbe && !SUBAGENT_PROBES.has(flags.runtimeSubagentProbe)) {
    fail('ERR_RUNTIME_SUBAGENT_PROBE', `Invalid runtime subagent probe: ${flags.runtimeSubagentProbe}`);
  }
  if (flags.runtimeStdinHandoff && !STDIN_HANDOFFS.has(flags.runtimeStdinHandoff)) {
    fail('ERR_RUNTIME_STDIN_HANDOFF', `Invalid runtime stdin handoff: ${flags.runtimeStdinHandoff}`);
  }
  if (flags.runtimeDowngradeReason && !DOWNGRADE_REASONS.has(flags.runtimeDowngradeReason)) {
    fail('ERR_RUNTIME_DOWNGRADE_REASON', `Invalid runtime downgrade reason: ${flags.runtimeDowngradeReason}`);
  }

  const runtimeCheck = {
    platform: flags.runtimePlatform || null,
    subagentProbe: {
      status: flags.runtimeSubagentProbe || null,
      evidence: flags.runtimeSubagentProbe === 'ready' ? 'route-asserted-ready' : 'none'
    },
    stdinHandoff: {
      status: flags.runtimeStdinHandoff || null,
      evidence: flags.runtimeStdinHandoff === 'ready' ? 'route-asserted-ready' : 'none'
    },
    downgradeReason: flags.runtimeDowngradeReason || 'none'
  };

  validateRuntimeArgs({ subcommand, flags, assurance, runtimeCheck });
  validateNoStateArgs({ subcommand, flags, invocation, assurance });

  return {
    subcommand,
    json: Boolean(flags.json),
    noState: Boolean(flags.noState),
    entrySkill,
    invocation,
    strictnessExplicit: invocationTokens.some((token) => token === 'strict' || token === 'normal'),
    assurance,
    runtimePlatform: flags.runtimePlatform || null,
    runtimeCheck,
    capabilityDescriptor: flags.capabilityDescriptor || null,
    descriptorDirectory: flags.descriptorDirectory || null,
    proofRunId: flags.proofRunId || null,
    terminalStatus: flags.terminalStatus || null,
    statusReason: flags.statusReason || null,
    blockingReason: flags.blockingReason || null,
    phase: flags.phase || null,
    stateToken: flags.stateToken || null,
    reviewGuard: flags.reviewGuard || null,
    payloadFlags: flags
  };
}

function validateRuntimeArgs({ subcommand, flags, assurance, runtimeCheck }) {
  if (assurance === 'practical') {
    if (
      !['codex', 'claude-code'].includes(flags.runtimePlatform) ||
      flags.runtimeSubagentProbe !== 'ready' ||
      flags.runtimeStdinHandoff !== 'ready'
    ) {
      fail(
        'ERR_PRACTICAL_RUNTIME',
        'practical assurance requires runtime platform codex or claude-code with ready subagent and stdin handoff'
      );
    }
  }

  if (
    assurance === 'advisory' &&
    ['unavailable', 'failed'].includes(runtimeCheck.subagentProbe.status) &&
    !DOWNGRADE_REASONS.has(runtimeCheck.downgradeReason)
  ) {
    fail('ERR_RUNTIME_DOWNGRADE_REASON', 'advisory subagent downgrade requires an allowed downgrade reason');
  }
  if (
    assurance === 'advisory' &&
    ['unavailable', 'failed'].includes(runtimeCheck.subagentProbe.status) &&
    runtimeCheck.downgradeReason === 'none'
  ) {
    fail('ERR_RUNTIME_DOWNGRADE_REASON', 'advisory subagent downgrade requires a downgrade reason');
  }

  if (assurance === 'strict-verified') {
    if (subcommand !== 'start' || flags.noState) fail('ERR_STRICT_WORKFLOW', 'strict-verified assurance requires workflow start with state');
    if (flags.runtimePlatform === 'gemini') {
      if (flags.runtimeSubagentProbe !== 'not-required' || flags.runtimeStdinHandoff !== 'not-required') {
        fail('ERR_STRICT_GEMINI_RUNTIME', 'Gemini strict-verified unsupported path requires not-required runtime checks');
      }
      return;
    }
    if (!['codex', 'claude-code'].includes(flags.runtimePlatform)) {
      fail('ERR_STRICT_RUNTIME_PLATFORM', 'strict-verified assurance requires runtime platform codex or claude-code');
    }
    if (flags.runtimeSubagentProbe !== 'ready' || flags.runtimeStdinHandoff !== 'ready') {
      fail('ERR_STRICT_RUNTIME_READY', 'strict-verified assurance requires ready subagent and stdin handoff');
    }
    if (!flags.capabilityDescriptor || !flags.proofRunId) {
      fail('ERR_STRICT_PROOF', 'strict-verified assurance requires capability descriptor and proof run id');
    }
  }
}

function validateNoStateArgs({ subcommand, flags, invocation, assurance }) {
  if (!flags.noState) return;
  if (!NO_STATE_SUBCOMMANDS.has(subcommand)) {
    fail('ERR_NO_STATE_COMMAND', `no-state workflow does not support ${subcommand}`);
  }
  if (assurance === 'strict-verified') {
    fail('ERR_NO_STATE_STRICT_VERIFIED', 'no-state workflow rejects strict-verified assurance');
  }
  if (!flags.runtimePlatform || !flags.runtimeSubagentProbe || !flags.runtimeStdinHandoff) {
    fail('ERR_NO_STATE_RUNTIME', 'no-state workflow requires runtime platform, subagent probe, and stdin handoff flags');
  }

  if (subcommand === 'preflight') {
    for (const flag of PREFLIGHT_FORBIDDEN_FLAGS) {
      if (Object.hasOwn(flags, flag)) {
        fail('ERR_NO_STATE_PREFLIGHT_SEMANTIC_INPUT', `no-state preflight rejects semantic or state input: ${flag}`);
      }
    }
    validatePreflightTerminalFlags(flags);
    return;
  }

  if (REVIEW_BACKED_NO_STATE_SUBCOMMANDS.has(subcommand)) {
    if (invocation.resume) fail('ERR_NO_STATE_RESUME', 'no-state review-backed commands reject resume');
    if (invocation.ledger) fail('ERR_NO_STATE_LEDGER', 'no-state review-backed commands reject ledger=');
    if (invocation.mode !== 'read-only') {
      fail('ERR_NO_STATE_MODE', 'no-state review-backed commands require read-only mode');
    }
    const phase = flags.phase || 'initial-review';
    if (phase === 'full-re-review' || phase === 'fix') {
      fail('ERR_NO_STATE_PHASE', `no-state review-backed commands reject ${phase}`);
    }
    if (phase !== 'initial-review') {
      fail('ERR_NO_STATE_PHASE', 'no-state review-backed commands support only initial-review phase');
    }
    if (subcommand === 'context' && flags.runtimeStdinHandoff !== 'ready') {
      fail('ERR_NO_STATE_STDIN_HANDOFF', 'no-state context requires ready stdin handoff');
    }
  }
}

function validatePreflightTerminalFlags(flags) {
  if (!flags.terminalStatus) fail('ERR_NO_STATE_PREFLIGHT_STATUS', 'no-state preflight requires terminal status');
  if (!flags.blockingReason) fail('ERR_NO_STATE_PREFLIGHT_BLOCKER', 'no-state preflight requires blocking reason');
  if (!flags.statusReason) fail('ERR_NO_STATE_PREFLIGHT_REASON', 'no-state preflight requires status reason');
  if (flags.terminalStatus === 'unsupported') {
    if (flags.blockingReason !== 'none' || flags.statusReason !== 'unsupported-runtime-capability') {
      fail(
        'ERR_NO_STATE_PREFLIGHT_PAIRING',
        'unsupported no-state preflight requires blocking-reason none and status-reason unsupported-runtime-capability'
      );
    }
    return;
  }
  if (flags.terminalStatus === 'blocked') {
    if (
      flags.blockingReason === 'none' ||
      !BLOCKING_REASONS.includes(flags.blockingReason) ||
      flags.statusReason !== 'none'
    ) {
      fail('ERR_NO_STATE_PREFLIGHT_PAIRING', 'blocked no-state preflight requires allowed blocker and status-reason none');
    }
    return;
  }
  fail('ERR_NO_STATE_PREFLIGHT_STATUS', `unsupported no-state preflight terminal status: ${flags.terminalStatus}`);
}

function resolveTargetMetadata(parsed, options) {
  const projectRoot = resolveProjectRoot({
    explicitRoot: parsed.invocation.root,
    targetPath: parsed.invocation.target,
    cwd: options.cwd || process.cwd(),
    persistentStateRequired: true
  });
  return deriveTargetKey(projectRoot, parsed.invocation.target);
}

function resolveNoStateMetadata(parsed, options) {
  const projectRoot = resolveProjectRoot({
    explicitRoot: parsed.invocation.root,
    targetPath: parsed.invocation.target,
    cwd: options.cwd || process.cwd(),
    persistentStateRequired: false
  });
  if (!projectRoot) fail('ERR_EXPLICIT_ROOT_REQUIRED', 'Unable to resolve project root for no-state workflow');
  const targetMetadata = deriveTargetKey(projectRoot, parsed.invocation.target);
  const referenceRecords = normalizeReferences({
    projectRoot,
    references: parsed.invocation.refs,
    targetPath: parsed.invocation.target
  });
  const references = referenceRecords.map((reference) => {
    if (reference.external) return reference.realPath;
    return path.relative(projectRoot, reference.realPath).split(path.sep).join('/');
  });
  const referenceFingerprints = referenceRecords.map((reference, index) => canonicalFingerprint(
    computeFingerprint(reference.realPath),
    references[index]
  ));
  return {
    projectRoot,
    targetKey: targetMetadata.targetKey,
    normalizedTarget: targetMetadata.normalizedTarget,
    references,
    targetFingerprint: canonicalFingerprint(computeFingerprint(parsed.invocation.target)),
    referenceFingerprints
  };
}

function canonicalFingerprint(fingerprint, normalizedPath = null) {
  const canonical = {
    sha256: fingerprint.sha256,
    size: Number(fingerprint.size),
    mtimeMs: Math.trunc(Number(fingerprint.mtimeMs))
  };
  if (normalizedPath) canonical.normalizedPath = normalizedPath;
  return canonical;
}

function workflowBase(parsed, options = {}) {
  const targetMetadata = resolveTargetMetadata(parsed, options);
  const descriptorPlatform = parsed.assurance === 'strict-verified' && parsed.proofRunId
    ? descriptorPlatformFor(parsed.runtimePlatform)
    : 'none';
  const assuranceProof = descriptorPlatform === 'none'
    ? 'none'
    : `capability-descriptor:${descriptorPlatform}:${parsed.proofRunId}`;
  return {
    ok: true,
    status: 'started',
    entrySkill: parsed.entrySkill,
    documentType: parsed.invocation.documentType,
    target: parsed.invocation.target,
    targetKey: targetMetadata.targetKey,
    requestedMode: parsed.invocation.requestedMode,
    mode: parsed.invocation.mode,
    modeSource: parsed.invocation.modeSource,
    modeNormalizedFrom: parsed.invocation.modeNormalizedFrom,
    strictness: parsed.invocation.strictness,
    requestedAssurance: parsed.invocation.requestedAssurance || parsed.assurance,
    assurance: parsed.assurance,
    assuranceSource: parsed.payloadFlags.assurance ? 'explicit' : (parsed.invocation.assuranceSource || 'default'),
    assuranceNormalizedFrom: null,
    descriptorPlatform,
    assuranceProof,
    runtimePlatform: parsed.runtimePlatform,
    runtimeCheck: parsed.runtimeCheck,
    blockingReason: parsed.blockingReason || 'none',
    statusReason: parsed.statusReason || 'none'
  };
}

function withReadOnlyMode(result) {
  if (result.mode === 'read-only') return result;
  return {
    ...result,
    mode: 'read-only',
    modeNormalizedFrom: result.mode
  };
}

function isRuntimeDowngrade(parsed) {
  return (
    parsed.assurance === 'advisory' &&
    ['unavailable', 'failed'].includes(parsed.runtimeCheck.subagentProbe.status) &&
    parsed.runtimeCheck.downgradeReason !== 'none'
  );
}

function unsupportedFrom(parsed, statusReason, strictProofError = null, options = {}) {
  return withReadOnlyMode({
    ...workflowBase(parsed, options),
    ok: false,
    status: 'unsupported',
    assurance: 'advisory',
    assuranceNormalizedFrom: parsed.assurance,
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    statusReason,
    blockingReason: 'none',
    strictProofError,
    nextAction: statusReason === 'strict-proof-validation-failed'
      ? 'rerun with practical or provide current verified descriptor'
      : null
  });
}

function blockedFrom(parsed, blockingReason, options = {}) {
  return {
    ...workflowBase(parsed, options),
    ok: false,
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    nextAction: null
  };
}

function noStateBase(parsed, metadata, overrides = {}) {
  const mode = overrides.mode || parsed.invocation.mode;
  return {
    ok: true,
    status: overrides.status || 'started',
    entrySkill: parsed.entrySkill,
    documentType: parsed.invocation.documentType,
    target: parsed.invocation.target,
    targetKey: metadata.targetKey,
    targetStateDir: null,
    manifestPath: null,
    ledgerPath: null,
    contextManifestPath: null,
    round: overrides.round || 1,
    requestedMode: parsed.invocation.requestedMode,
    mode,
    modeSource: parsed.invocation.modeSource,
    modeNormalizedFrom: mode === parsed.invocation.mode ? parsed.invocation.modeNormalizedFrom : parsed.invocation.mode,
    strictness: parsed.invocation.strictness,
    requestedAssurance: parsed.invocation.requestedAssurance || parsed.assurance,
    assurance: parsed.assurance,
    assuranceSource: parsed.payloadFlags.assurance ? 'explicit' : (parsed.invocation.assuranceSource || 'default'),
    assuranceNormalizedFrom: null,
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    runtimePlatform: parsed.runtimePlatform,
    runtimeCheck: overrides.runtimeCheck || parsed.runtimeCheck,
    blockingReason: overrides.blockingReason || parsed.blockingReason || 'none',
    statusReason: overrides.statusReason || parsed.statusReason || 'none',
    nextAction: Object.hasOwn(overrides, 'nextAction') ? overrides.nextAction : null
  };
}

function noStateValidationFailure(parsed, metadata, {
  errorCode = 'final-validation-failed',
  message,
  blockingReason = 'final-validation-failed',
  statusReason = 'none',
  nextAction = null
} = {}) {
  return {
    ...noStateBase(parsed, metadata, {
      status: 'blocked',
      blockingReason,
      statusReason,
      nextAction
    }),
    ok: false,
    errorCode,
    message
  };
}

function noStateTokenTooLarge(parsed, metadata, error) {
  return noStateValidationFailure(parsed, metadata, {
    errorCode: 'state-token-too-large',
    message: error && error.message ? error.message : 'state-token-too-large',
    blockingReason: 'state-token-too-large',
    statusReason: 'none',
    nextAction: 'rerun with ledger= or review-and-fix persistent state'
  });
}

function noStateOutputOrTooLarge(parsed, metadata, createOutput) {
  try {
    return createOutput();
  } catch (error) {
    if (error && error.code === 'ERR_STATE_TOKEN_TOO_LARGE') {
      return noStateTokenTooLarge(parsed, metadata, error);
    }
    throw error;
  }
}

function readWorkflowPayload({ parsed, metadata, valueFlag, stdinFlag, label, options }) {
  const fromStdin = Boolean(parsed.payloadFlags[stdinFlag]);
  const fromFile = parsed.payloadFlags[valueFlag] || null;
  if (fromStdin === Boolean(fromFile)) {
    fail('ERR_SEMANTIC_HANDOFF', `exactly one ${label} stdin or safe file input is required`);
  }
  if (fromStdin) {
    if (parsed.runtimeCheck.stdinHandoff.status !== 'ready') {
      fail('ERR_SEMANTIC_HANDOFF', `${label} stdin handoff requires ready runtime stdin`);
    }
    return readSemanticPayload({ content: options.stdin || '' });
  }
  return readSemanticPayload({ filePath: fromFile, projectRoot: metadata.projectRoot });
}

function metadataExpectedGuard(parsed, metadata) {
  return {
    phase: parsed.phase || 'initial-review',
    round: 1,
    normalizedTarget: metadata.normalizedTarget,
    references: metadata.references,
    targetFingerprint: metadata.targetFingerprint,
    referenceFingerprints: metadata.referenceFingerprints,
    strictness: parsed.invocation.strictness,
    mode: parsed.invocation.mode,
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform
  };
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function readRulebookIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return parseRulebook(fs.readFileSync(filePath, 'utf8'));
}

function loadMergedRules({ projectRoot, documentType, homeDir = null } = {}) {
  const userHome = homeDir || process.env.HOME || null;
  const user = userHome
    ? readRulebookIfPresent(path.join(userHome, '.docs-review-fix', 'RULE.md'))
    : {};
  const project = projectRoot
    ? readRulebookIfPresent(path.join(projectRoot, '.docs-review-fix', 'RULE.md'))
    : {};
  return mergeRules({ documentType, user, project });
}

function targetStateDirectory(projectRoot, targetKey) {
  return path.join(projectRoot, '.docs-review-fix', 'targets', targetKey);
}

function resolvePersistentMetadata(parsed, options) {
  const projectRoot = resolveProjectRoot({
    explicitRoot: parsed.invocation.root,
    targetPath: parsed.invocation.target,
    cwd: options.cwd || process.cwd(),
    persistentStateRequired: true
  });
  const targetMetadata = deriveTargetKey(projectRoot, parsed.invocation.target);
  const targetStateDir = targetStateDirectory(projectRoot, targetMetadata.targetKey);
  const manifestPath = path.join(targetStateDir, 'MANIFEST.md');
  const manifest = readManifestAny(manifestPath);
  return {
    projectRoot,
    targetKey: targetMetadata.targetKey,
    normalizedTarget: targetMetadata.normalizedTarget,
    targetPath: path.resolve(projectRoot, targetMetadata.normalizedTarget),
    targetStateDir,
    manifestPath,
    manifest
  };
}

function manifestReferenceInput(parsed, manifest, projectRoot) {
  const references = parsed.invocation.refs.length > 0 ? parsed.invocation.refs : (manifest.references || []);
  return references.map((reference) => (
    path.isAbsolute(reference) ? reference : path.resolve(projectRoot, reference)
  ));
}

function referenceRecordsFor(parsed, metadata) {
  return normalizeReferences({
    projectRoot: metadata.projectRoot,
    references: manifestReferenceInput(parsed, metadata.manifest, metadata.projectRoot),
    targetPath: parsed.invocation.target
  });
}

function normalizedReferencePath(reference, projectRoot) {
  if (reference.external) return reference.realPath;
  return path.relative(projectRoot, reference.realPath).split(path.sep).join('/');
}

function guardBaselineFor(parsed, metadata) {
  const referenceRecords = referenceRecordsFor(parsed, metadata);
  const references = referenceRecords.map((reference) => normalizedReferencePath(reference, metadata.projectRoot));
  const referenceFingerprints = referenceRecords.map((reference, index) => canonicalFingerprint(
    computeFingerprint(reference.realPath),
    references[index]
  ));
  return {
    references: references.map((referencePath) => ({ path: referencePath, readOnly: true })),
    reviewerGuardBaseline: {
      target: canonicalFingerprint(computeFingerprint(parsed.invocation.target)),
      references: referenceFingerprints
    }
  };
}

function stateRelativePath(targetStateDir, filePath) {
  return path.relative(targetStateDir, filePath).split(path.sep).join('/');
}

function manifestPathParts(storedPath, label) {
  const text = String(storedPath || '');
  if (!text) failStateValidation(`${label} is missing`);
  if (text.includes('\0')) failStateValidation(`${label} must not contain null bytes`);
  if (path.isAbsolute(text) || path.win32.isAbsolute(text)) {
    failStateValidation(`${label} must be a relative target-state path`);
  }
  const parts = text.split(/[\\/]+/);
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    failStateValidation(`${label} must not contain empty, current, or parent path segments`);
  }
  if (parts.some((part) => RESERVED_STATE_PATH_BASENAMES.has(part))) {
    failStateValidation(`${label} must not target reserved state files`);
  }
  return parts;
}

function statePathFromManifest(projectRoot, targetStateDir, targetKey, storedPath, fallbackName) {
  const ledgerPath = (!storedPath || storedPath === 'none')
    ? path.join(targetStateDir, fallbackName)
    : path.resolve(projectRoot, ...manifestPathParts(storedPath, 'Ledger path'));
  try {
    return validateLedgerPath({ projectRoot, targetKey, ledgerPath });
  } catch (error) {
    failStateValidation(`Ledger path: ${error && error.message ? error.message : String(error)}`);
  }
}

function targetStatePathFromManifest(targetStateDir, storedPath, fallbackName, options = {}) {
  const relativePath = (!storedPath || storedPath === 'none') ? fallbackName : storedPath;
  return validateTargetStateOwnedPath({
    targetStateDir,
    relativePath,
    allowedDirectories: options.allowedDirectories || ['reports', 'context', 'rounds'],
    label: options.label || 'Manifest path'
  });
}

function readLedgerIfPresent(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return { issues: [] };
  return parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
}

function acceptedNonBlockingLowIssueIdsFromLedger(ledger) {
  return (ledger.issues || [])
    .filter((issue) => (
      issue.status === 'accepted' &&
      issue.severity === 'low' &&
      /Accepted as non-blocking low/i.test(issue.resolution || '')
    ))
    .map((issue) => issue.id)
    .sort();
}

function fixableIssuesFromLedger(ledger) {
  return (ledger.issues || [])
    .filter((issue) => ['accepted', 'reopened'].includes(issue.status));
}

function activeLockContext(projectRoot, targetKey) {
  const lease = readLease({ projectRoot, targetKey });
  if (!lease) return { status: 'none' };
  return {
    status: 'active',
    ownerId: lease.ownerId,
    leaseId: lease.leaseId || 'none',
    expiresAt: lease.expiresAt,
    updatedAt: lease.updatedAt,
    mode: lease.mode,
    strictness: lease.strictness
  };
}

function latestFixGuardReportPath(targetStateDir, round) {
  const reportsDir = path.join(targetStateDir, 'reports');
  if (!fs.existsSync(reportsDir)) return 'none';
  const roundPrefix = `fix-guard-round-${padRound(round)}`;
  const matches = fs.readdirSync(reportsDir)
    .filter((name) => name.startsWith(roundPrefix) && name.endsWith('.md'))
    .sort();
  if (matches.length === 0) return 'none';
  return path.posix.join('reports', matches[matches.length - 1]);
}

function buildFixerGuard({ projectRoot, metadata, ledger, round }) {
  const fixableIssues = fixableIssuesFromLedger(ledger);
  if (fixableIssues.length === 0) {
    fail('ERR_FIX_CONTEXT_NO_ACCEPTED_ISSUES', 'fix context requires accepted or reopened issue IDs');
  }
  return {
    activeLock: activeLockContext(projectRoot, metadata.targetKey),
    expectedChangedFileSet: [metadata.normalizedTarget],
    issueIds: fixableIssues.map((issue) => issue.id),
    latestFixGuardReportPath: latestFixGuardReportPath(metadata.targetStateDir, round),
    referenceReadOnlyRule: 'Reference documents are read-only.',
    safeLocationAnchors: fixableIssues.map((issue) => issue.location).filter(Boolean),
    targetOnlyWriteRule: `Write target only: ${metadata.normalizedTarget}`
  };
}

function contextPhase(parsed, manifest) {
  if (parsed.phase) return parsed.phase;
  if (manifest.status === 'full-re-review') return 'full-re-review';
  if (manifest.status === 'fix') return 'fix';
  return 'initial-review';
}

function requiredSchemaForPhase(phase) {
  if (phase === 'fix') return 'fix-report';
  return 'reviewer-pass-fail';
}

function readContextManifest(contextManifestPath) {
  const text = fs.readFileSync(contextManifestPath, 'utf8');
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) fail('ERR_CONTEXT_MANIFEST', 'context manifest missing json block');
  return JSON.parse(match[1]);
}

function contextManifestPathFor(targetStateDir, phase) {
  const fileName = phase === 'fix'
    ? 'current-fixer-context-manifest.md'
    : 'current-reviewer-context-manifest.md';
  return targetStatePathFromManifest(targetStateDir, path.posix.join('context', fileName), null, {
    allowedDirectories: ['context'],
    label: 'Context manifest path'
  });
}

function updatePersistentManifest(metadata, updates) {
  const next = {
    ...metadata.manifest,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  atomicWriteFile(metadata.manifestPath, formatManifestV2(next));
  metadata.manifest = next;
  return next;
}

function padRound(round) {
  return String(Number(round || 1)).padStart(3, '0');
}

function nextReportPath(targetStateDir, baseName) {
  const relativeBasePath = path.posix.join('reports', `${baseName}.md`);
  const basePath = validateTargetStateOwnedPath({
    targetStateDir,
    relativePath: relativeBasePath,
    allowedDirectories: ['reports'],
    label: 'Report path'
  });
  if (!fs.existsSync(basePath)) return basePath;
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const attemptPath = validateTargetStateOwnedPath({
      targetStateDir,
      relativePath: path.posix.join('reports', `${baseName}-attempt-${padRound(attempt)}.md`),
      allowedDirectories: ['reports'],
      label: 'Report path'
    });
    if (!fs.existsSync(attemptPath)) return attemptPath;
  }
  fail('ERR_REPORT_ATTEMPTS_EXHAUSTED', `too many report attempts for ${baseName}`);
}

function reportJsonBlock(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeReviewerReport({ reportPath, phase, round, producer, reviewerResult }) {
  const report = {
    normalized: reviewerResult,
    phase,
    producer,
    round
  };
  const lines = [
    '# Reviewer Report',
    '',
    `Round: ${round}`,
    `Phase: ${phase}`,
    `Producer: ${producer}`,
    `Result: ${reviewerResult.result}`,
    '',
    '```json',
    reportJsonBlock(report).trimEnd(),
    '```',
    ''
  ];
  atomicWriteFile(reportPath, lines.join('\n'));
  return report;
}

function readReviewerReport(reportPath) {
  const text = fs.readFileSync(reportPath, 'utf8');
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) fail('ERR_REVIEWER_REPORT', 'reviewer report missing normalized json block');
  return JSON.parse(match[1]);
}

function writeTriageReport({ reportPath, phase, round, triage, ledger }) {
  const report = {
    ledgerIssueIds: (ledger.issues || []).map((issue) => issue.id),
    normalized: triage,
    phase,
    round
  };
  const lines = [
    '# Triage Report',
    '',
    `Round: ${round}`,
    `Phase: ${phase}`,
    '',
    '```json',
    reportJsonBlock(report).trimEnd(),
    '```',
    ''
  ];
  atomicWriteFile(reportPath, lines.join('\n'));
  return report;
}

function producerForAssurance(assurance) {
  return assurance === 'advisory' ? 'coordinator-advisory' : 'reviewer-subagent';
}

function compareGuardBaseline(contextPack, actualBaseline) {
  const expected = contextPack.reviewerGuardBaseline || {};
  if (stableJson(expected.target) !== stableJson(actualBaseline.reviewerGuardBaseline.target)) {
    return 'reviewer-mutated-file';
  }
  if (stableJson(expected.references || []) !== stableJson(actualBaseline.reviewerGuardBaseline.references)) {
    return 'reference-mutated-file';
  }
  return null;
}

function reviewerFindingsById(reviewerReport) {
  const findings = reviewerReport && reviewerReport.normalized && Array.isArray(reviewerReport.normalized.findings)
    ? reviewerReport.normalized.findings
    : [];
  return new Map(findings.map((finding) => [finding.id, finding]));
}

function validateTriageReviewerIds(triage, reviewerReport) {
  const findings = reviewerFindingsById(reviewerReport);
  for (const decision of triage.decisions || []) {
    if (!findings.has(decision.reviewer_id)) {
      fail('ERR_TRIAGE_REVIEWER_ID', `triage reviewer_id not found in reviewer report: ${decision.reviewer_id}`);
    }
  }
}

function enrichTriageDecisions(triage, reviewerReport) {
  validateTriageReviewerIds(triage, reviewerReport);
  const findings = reviewerFindingsById(reviewerReport);
  return triage.decisions.map((decision) => {
    const finding = findings.get(decision.reviewer_id);
    return {
      ...decision,
      location: finding.location,
      summary: finding.issue,
      suggested_fix: finding.suggested_fix
    };
  });
}

function triageOutcome({ decisions, mode, strictness }) {
  const highMediumDeferred = decisions.some((decision) => (
    decision.decision === 'deferred' && ['high', 'medium'].includes(decision.severity)
  ));
  if (highMediumDeferred) {
    return {
      status: 'stopped-with-deferrals',
      currentPhase: 'final',
      statusReason: 'deferred-findings'
    };
  }

  const blocking = decisions.filter((decision) => (
    decision.non_blocking !== true &&
    ['accepted', 'reopened', 'downgraded'].includes(decision.decision) &&
    ['high', 'medium'].includes(decision.severity)
  ));
  if (mode === 'read-only') {
    return blocking.length > 0
      ? { status: 'read-only-findings', currentPhase: 'final', statusReason: 'read-only-blocking-findings' }
      : { status: 'read-only-clean', currentPhase: 'final', statusReason: 'none' };
  }
  if (blocking.length > 0) {
    return { status: 'fix', currentPhase: 'fix', statusReason: 'none' };
  }
  if (
    strictness === 'strict' &&
    decisions.some((decision) => decision.non_blocking === true && decision.severity === 'low')
  ) {
    return { status: 'full-re-review', currentPhase: 'full-re-review', statusReason: 'none' };
  }
  return { status: 'full-re-review', currentPhase: 'full-re-review', statusReason: 'none' };
}

function noStateStaleTokenFailure(parsed, metadata, blockingReason) {
  return noStateValidationFailure(parsed, metadata, {
    errorCode: blockingReason,
    message: `${blockingReason}: state token fingerprint mismatch`,
    blockingReason
  });
}

function validateNoStateTokenFingerprints(parsed, metadata, token) {
  if (token.tokenKind === 'preflight-terminal') return null;
  if (stableJson(token.targetFingerprint) !== stableJson(metadata.targetFingerprint)) {
    return noStateStaleTokenFailure(parsed, metadata, 'reviewer-mutated-file');
  }
  if (stableJson(token.referenceFingerprints) !== stableJson(metadata.referenceFingerprints)) {
    return noStateStaleTokenFailure(parsed, metadata, 'reference-mutated-file');
  }
  return null;
}

function runNoStatePreflight(parsed, options) {
  const metadata = resolveNoStateMetadata(parsed, options);
  const runtimeCheck = {
    ...parsed.runtimeCheck,
    fingerprintGuard: { status: 'not-run' }
  };
  return noStateOutputOrTooLarge(parsed, metadata, () => {
    const stateToken = createPreflightToken({
      targetKey: metadata.targetKey,
      normalizedTarget: metadata.normalizedTarget,
      references: metadata.references,
      strictness: parsed.invocation.strictness,
      requestedMode: parsed.invocation.requestedMode,
      mode: 'read-only',
      assurance: parsed.assurance,
      runtimePlatform: parsed.runtimePlatform,
      runtimeDowngradeReason: parsed.runtimeCheck.downgradeReason,
      runtimeCheck,
      terminalStatus: parsed.terminalStatus,
      blockingReason: parsed.blockingReason,
      statusReason: parsed.statusReason
    });
    return {
      ...noStateBase(parsed, metadata, {
        status: parsed.terminalStatus,
        mode: 'read-only',
        runtimeCheck,
        blockingReason: parsed.blockingReason,
        statusReason: parsed.statusReason
      }),
      stateToken
    };
  });
}

function runNoStateContext(parsed, options) {
  const metadata = resolveNoStateMetadata(parsed, options);
  const runtimeCheck = {
    ...parsed.runtimeCheck,
    fingerprintGuard: { status: 'passed' }
  };
  return noStateOutputOrTooLarge(parsed, metadata, () => {
    const phase = parsed.phase || 'initial-review';
    const mergedRules = loadMergedRules({
      projectRoot: metadata.projectRoot,
      documentType: parsed.invocation.documentType,
      homeDir: options.homeDir || null
    });
    const contextPackSkeleton = buildContextPack({
      target: metadata.normalizedTarget,
      references: metadata.references.map((reference) => ({ path: reference, readOnly: true })),
      documentType: parsed.invocation.documentType,
      strictness: parsed.invocation.strictness,
      mode: parsed.invocation.mode,
      assurance: parsed.assurance,
      runtimePlatform: parsed.runtimePlatform,
      phase,
      round: 1,
      mergedRules,
      acceptedNonBlockingLowIssueIds: [],
      requiredOutputSchema: 'reviewer-pass-fail',
      reviewerGuardBaseline: {
        target: metadata.targetFingerprint,
        references: metadata.referenceFingerprints
      },
      projectRoot: metadata.projectRoot
    });
    const reviewGuard = createReviewGuard({
      phase,
      round: 1,
      normalizedTarget: metadata.normalizedTarget,
      references: metadata.references,
      targetFingerprint: metadata.targetFingerprint,
      referenceFingerprints: metadata.referenceFingerprints,
      strictness: parsed.invocation.strictness,
      mode: parsed.invocation.mode,
      assurance: parsed.assurance,
      runtimePlatform: parsed.runtimePlatform
    });
    return {
      ...noStateBase(parsed, metadata, {
        status: 'context',
        runtimeCheck
      }),
      contextPackSkeleton: {
        ...contextPackSkeleton,
        targetFingerprint: metadata.targetFingerprint,
        referenceFingerprints: metadata.referenceFingerprints
      },
      reviewGuard
    };
  });
}

function blockingFindingsFromReviewerResult(result) {
  if (result.result !== 'FAIL') return [];
  return result.findings.filter((finding) => ['high', 'medium'].includes(finding.severity));
}

function runNoStateRecordReview(parsed, options) {
  const metadata = resolveNoStateMetadata(parsed, options);
  let guard;
  try {
    guard = validateReviewGuard(parsed.reviewGuard, metadataExpectedGuard(parsed, metadata));
  } catch (error) {
    if (error.code === 'ERR_REVIEWER_MUTATED_FILE') {
      return noStateValidationFailure(parsed, metadata, {
        errorCode: 'reviewer-mutated-file',
        message: error.message,
        blockingReason: 'reviewer-mutated-file'
      });
    }
    throw error;
  }
  const payload = readWorkflowPayload({
    parsed,
    metadata,
    valueFlag: 'result',
    stdinFlag: 'resultStdin',
    label: 'review result',
    options
  });
  const reviewerResult = parseReviewerResult(payload);
  const blockingFindings = blockingFindingsFromReviewerResult(reviewerResult);
  return noStateOutputOrTooLarge(parsed, metadata, () => {
    const stateToken = nextStateToken({
      previousToken: null,
      tokenKind: 'review-result',
      targetKey: metadata.targetKey,
      normalizedTarget: metadata.normalizedTarget,
      references: metadata.references,
      phase: parsed.phase || 'initial-review',
      round: 1,
      strictness: parsed.invocation.strictness,
      mode: parsed.invocation.mode,
      assurance: parsed.assurance,
      runtimePlatform: parsed.runtimePlatform,
      runtimeDowngradeReason: parsed.runtimeCheck.downgradeReason,
      guardId: guard.guardId,
      eligibleTerminalStatuses: reviewerResult.result === 'PASS' ? ['read-only-clean'] : [],
      normalized: {
        result: reviewerResult.result,
        summary: reviewerResult.summary,
        findings: reviewerResult.findings,
        warnings: reviewerResult.warnings,
        blockingFindings
      },
      targetFingerprint: metadata.targetFingerprint,
      referenceFingerprints: metadata.referenceFingerprints
    });
    return {
      ...noStateBase(parsed, metadata, { status: 'recorded-review' }),
      normalized: reviewerResult,
      stateToken
    };
  });
}

function blockingFindingsFromTriage(decisions) {
  return decisions.filter((decision) => (
    decision.non_blocking === false &&
    ['accepted', 'reopened', 'merged', 'downgraded', 'deferred'].includes(decision.decision)
  ));
}

function runNoStateRecordTriage(parsed, options) {
  const metadata = resolveNoStateMetadata(parsed, options);
  const previous = validateStateToken(parsed.stateToken, {
    allowedKinds: ['review-result'],
    targetKey: metadata.targetKey,
    normalizedTarget: metadata.normalizedTarget,
    references: metadata.references,
    phase: parsed.phase || 'initial-review',
    round: 1,
    strictness: parsed.invocation.strictness,
    mode: parsed.invocation.mode,
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform,
    maxAgeMs: options.maxAgeMs || NO_STATE_TOKEN_MAX_AGE_MS,
    now: options.now
  });
  const stale = validateNoStateTokenFingerprints(parsed, metadata, previous);
  if (stale) return stale;
  const payload = readWorkflowPayload({
    parsed,
    metadata,
    valueFlag: 'triage',
    stdinFlag: 'triageStdin',
    label: 'triage result',
    options
  });
  const triage = parseTriageResult(payload);
  validateTriageReviewerIds(triage, { normalized: previous.normalized });
  const blockingFindings = blockingFindingsFromTriage(triage.decisions);
  return noStateOutputOrTooLarge(parsed, metadata, () => {
    const stateToken = nextStateToken({
      previousToken: parsed.stateToken,
      tokenKind: 'triage-result',
      targetKey: metadata.targetKey,
      normalizedTarget: metadata.normalizedTarget,
      references: metadata.references,
      phase: previous.phase,
      round: previous.round,
      strictness: previous.strictness,
      mode: previous.mode,
      assurance: previous.assurance,
      runtimePlatform: previous.runtimePlatform,
      runtimeDowngradeReason: previous.runtimeDowngradeReason,
      guardId: previous.guardId,
      eligibleTerminalStatuses: blockingFindings.length > 0 ? ['read-only-findings'] : ['read-only-clean'],
      normalized: {
        reviewerSummary: previous.normalized || {},
        decisions: triage.decisions,
        warnings: triage.warnings,
        blockingFindings
      },
      targetFingerprint: metadata.targetFingerprint,
      referenceFingerprints: metadata.referenceFingerprints
    });
    return {
      ...noStateBase(parsed, metadata, { status: 'recorded-triage' }),
      normalized: triage,
      stateToken
    };
  });
}

function tokenHasBlockingFindings(token) {
  const normalized = token.normalized || {};
  if (Array.isArray(normalized.blockingFindings)) return normalized.blockingFindings.length > 0;
  if (Array.isArray(normalized.decisions)) return blockingFindingsFromTriage(normalized.decisions).length > 0;
  if (Array.isArray(normalized.findings)) {
    return normalized.findings.some((finding) => ['high', 'medium'].includes(finding.severity));
  }
  return (
    token.eligibleTerminalStatuses.includes('read-only-findings') &&
    !token.eligibleTerminalStatuses.includes('read-only-clean')
  );
}

function runNoStateFinalize(parsed, options) {
  const metadata = resolveNoStateMetadata(parsed, options);
  const tokenValidationBase = {
    allowedKinds: ['preflight-terminal', 'review-result', 'triage-result'],
    targetKey: metadata.targetKey,
    normalizedTarget: metadata.normalizedTarget,
    references: metadata.references,
    strictness: parsed.invocation.strictness,
    mode: parsed.invocation.mode,
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform,
    maxAgeMs: options.maxAgeMs || NO_STATE_TOKEN_MAX_AGE_MS,
    now: options.now
  };
  const token = validateStateToken(parsed.stateToken, tokenValidationBase);
  if (token.tokenKind !== 'preflight-terminal') {
    validateStateToken(parsed.stateToken, {
      ...tokenValidationBase,
      phase: parsed.phase || 'initial-review',
      round: 1
    });
  }
  const stale = validateNoStateTokenFingerprints(parsed, metadata, token);
  if (stale) return stale;
  const payload = readWorkflowPayload({
    parsed,
    metadata,
    valueFlag: 'finalResponse',
    stdinFlag: 'finalResponseStdin',
    label: 'final response',
    options
  });
  let finalResponse;
  try {
    finalResponse = parseFinalResponseBlock(payload);
    validateFinalResponse({
      finalResponse,
      state: {
        noState: true,
        target: token.normalizedTarget,
        assurance: token.assurance,
        runtimePlatform: token.runtimePlatform,
        mode: token.mode
      }
    });
  } catch (error) {
    return noStateValidationFailure(parsed, metadata, {
      errorCode: 'final-validation-failed',
      message: error && error.message ? error.message : String(error)
    });
  }
  if (finalResponse.finalStatus === 'pass') {
    return noStateValidationFailure(parsed, metadata, {
      errorCode: 'no-state-pass-unsupported',
      message: 'no-state finalizer rejects pass'
    });
  }
  if (!['read-only-clean', 'read-only-findings', 'unsupported', 'blocked'].includes(finalResponse.finalStatus)) {
    return noStateValidationFailure(parsed, metadata, {
      message: `no-state finalizer rejects ${finalResponse.finalStatus}`
    });
  }
  if (
    finalResponse.target !== token.normalizedTarget ||
    finalResponse.assurance !== token.assurance ||
    finalResponse.runtimePlatform !== token.runtimePlatform ||
    finalResponse.mode !== token.mode
  ) {
    return noStateValidationFailure(parsed, metadata, {
      message: 'final response does not match no-state token'
    });
  }
  if (!token.eligibleTerminalStatuses.includes(finalResponse.finalStatus)) {
    return noStateValidationFailure(parsed, metadata, {
      message: `state token does not allow ${finalResponse.finalStatus}`
    });
  }

  const hasBlockingFindings = tokenHasBlockingFindings(token);
  if (finalResponse.finalStatus === 'read-only-clean' && hasBlockingFindings) {
    return noStateValidationFailure(parsed, metadata, {
      message: 'read-only-clean is invalid when no-state token contains blocking findings'
    });
  }
  if (finalResponse.finalStatus === 'read-only-findings' && !hasBlockingFindings) {
    return noStateValidationFailure(parsed, metadata, {
      message: 'read-only-findings is invalid when no-state token contains no blocking findings'
    });
  }

  return {
    ...noStateBase(parsed, metadata, {
      status: finalResponse.finalStatus,
      blockingReason: finalResponse.blockingReason,
      statusReason: finalResponse.statusReason
    }),
    finalResponse
  };
}

async function runNoStateWorkflowCommand(parsed, options) {
  if (parsed.subcommand === 'preflight') return runNoStatePreflight(parsed, options);
  if (parsed.subcommand === 'context') return runNoStateContext(parsed, options);
  if (parsed.subcommand === 'record-review') return runNoStateRecordReview(parsed, options);
  if (parsed.subcommand === 'record-triage') return runNoStateRecordTriage(parsed, options);
  if (parsed.subcommand === 'finalize') return runNoStateFinalize(parsed, options);
  fail('ERR_NO_STATE_COMMAND', `no-state workflow does not support ${parsed.subcommand}`);
}

function persistentBase(parsed, metadata, overrides = {}) {
  const ledgerPath = Object.hasOwn(overrides, 'ledgerPath')
    ? overrides.ledgerPath
    : statePathFromManifest(
      metadata.projectRoot,
      metadata.targetStateDir,
      metadata.targetKey,
      metadata.manifest.ledgerPath,
      'ISSUES.md'
    );
  return {
    ...workflowBase(parsed, { cwd: metadata.projectRoot }),
    targetStateDir: metadata.targetStateDir,
    manifestPath: metadata.manifestPath,
    ledgerPath,
    round: Number(metadata.manifest.currentRound || 1),
    ...overrides
  };
}

function runPersistentContext(parsed, options) {
  const metadata = resolvePersistentMetadata(parsed, options);
  try {
    const phase = contextPhase(parsed, metadata.manifest);
    const round = Number(metadata.manifest.currentRound || 1);
    const guard = guardBaselineFor(parsed, metadata);
    const ledgerPath = statePathFromManifest(
      metadata.projectRoot,
      metadata.targetStateDir,
      metadata.targetKey,
      metadata.manifest.ledgerPath,
      'ISSUES.md'
    );
    const ledger = readLedgerIfPresent(ledgerPath);
    const mergedRules = loadMergedRules({
      projectRoot: metadata.projectRoot,
      documentType: metadata.manifest.documentType,
      homeDir: options.homeDir || null
    });
    const fixerGuard = phase === 'fix'
      ? buildFixerGuard({
        projectRoot: metadata.projectRoot,
        metadata,
        ledger,
        round
      })
      : null;
    const contextPack = buildContextPack({
      target: metadata.normalizedTarget,
      references: guard.references,
      documentType: metadata.manifest.documentType,
      strictness: metadata.manifest.strictness,
      mode: metadata.manifest.mode,
      assurance: metadata.manifest.assurance,
      runtimePlatform: metadata.manifest.runtimePlatform,
      phase,
      round,
      mergedRules,
      acceptedNonBlockingLowIssueIds: acceptedNonBlockingLowIssueIdsFromLedger(ledger),
      requiredOutputSchema: requiredSchemaForPhase(phase),
      reviewerGuardBaseline: phase === 'fix' ? null : guard.reviewerGuardBaseline,
      fixerGuard,
      projectRoot: metadata.projectRoot
    });
    const contextManifestPath = writeContextManifest({
      targetStateDir: metadata.targetStateDir,
      phase,
      contextPack
    });
    return persistentBase(parsed, metadata, {
      ok: true,
      status: 'context',
      contextManifestPath,
      contextPackSkeleton: contextPack,
      runtimeCheck: {
        ...parsed.runtimeCheck,
        fingerprintGuard: { status: 'passed' }
      }
    });
  } catch (error) {
    if (isStateValidationError(error)) return blockPersistentStateValidation(parsed, metadata, error);
    throw error;
  }
}

function blockPersistentReviewerMutation(parsed, metadata, blockingReason) {
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    runtimeFingerprintGuard: 'passed'
  });
  return persistentBase(parsed, metadata, {
    ok: false,
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    nextAction: 'rerun context after restoring target and references'
  });
}

function blockPersistentStateValidation(parsed, metadata, error) {
  return {
    ...workflowBase(parsed, { cwd: metadata.projectRoot }),
    targetStateDir: metadata.targetStateDir,
    manifestPath: metadata.manifestPath,
    ledgerPath: null,
    round: Number(metadata.manifest.currentRound || 1),
    ok: false,
    status: 'blocked',
    errorCode: error && error.code ? error.code : 'ERR_STATE_VALIDATION_FAILED',
    message: error && error.message ? error.message : String(error),
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    nextAction: 'repair manifest paths under the target state directory'
  };
}

function isStateValidationError(error) {
  return error && error.code === 'ERR_STATE_VALIDATION_FAILED';
}

function runPersistentRecordReview(parsed, options) {
  const metadata = resolvePersistentMetadata(parsed, options);
  try {
    const phase = contextPhase(parsed, metadata.manifest);
    const contextManifestPath = contextManifestPathFor(metadata.targetStateDir, phase);
    const contextPack = readContextManifest(contextManifestPath);
    const actualBaseline = guardBaselineFor(parsed, metadata);
    const mutation = compareGuardBaseline(contextPack, actualBaseline);
    if (mutation) return blockPersistentReviewerMutation(parsed, metadata, mutation);

    const payload = readWorkflowPayload({
      parsed,
      metadata,
      valueFlag: 'result',
      stdinFlag: 'resultStdin',
      label: 'review result',
      options
    });
    const reviewerResult = parseReviewerResult(payload);
    const round = Number(metadata.manifest.currentRound || 1);
    const baseName = phase === 'full-re-review'
      ? `full-review-round-${padRound(round)}`
      : `reviewer-round-${padRound(round)}`;
    const reportPath = nextReportPath(metadata.targetStateDir, baseName);
    const producer = producerForAssurance(metadata.manifest.assurance);
    writeReviewerReport({
      reportPath,
      phase,
      round,
      producer,
      reviewerResult
    });
    const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
    const targetFingerprint = computeFingerprint(parsed.invocation.target);
    const passStatus = metadata.manifest.mode === 'read-only' ? 'read-only-clean' : 'full-re-review';
    updatePersistentManifest(metadata, {
      status: reviewerResult.result === 'FAIL' ? 'triage' : passStatus,
      currentPhase: reviewerResult.result === 'FAIL'
        ? 'triage'
        : (passStatus === 'read-only-clean' ? 'final' : 'full-re-review'),
      blockingReason: 'none',
      statusReason: 'none',
      currentReportPath: relativeReportPath,
      lastReviewerReportPath: relativeReportPath,
      lastKnownContentSha256: targetFingerprint.sha256,
      lastReviewedContentSha256: targetFingerprint.sha256,
      runtimeFingerprintGuard: 'passed'
    });
    return persistentBase(parsed, metadata, {
      ok: true,
      status: 'recorded-review',
      contextManifestPath,
      reviewerReportPath: reportPath,
      normalized: reviewerResult
    });
  } catch (error) {
    if (isStateValidationError(error)) return blockPersistentStateValidation(parsed, metadata, error);
    throw error;
  }
}

function runPersistentRecordTriage(parsed, options) {
  const metadata = resolvePersistentMetadata(parsed, options);
  const phase = parsed.phase || 'initial-review';
  const round = Number(metadata.manifest.currentRound || 1);
  let reviewerReportPath;
  let ledgerPath;
  try {
    const contextManifestPath = contextManifestPathFor(metadata.targetStateDir, phase);
    const contextPack = readContextManifest(contextManifestPath);
    const actualBaseline = guardBaselineFor(parsed, metadata);
    const mutation = compareGuardBaseline(contextPack, actualBaseline);
    if (mutation) return blockPersistentReviewerMutation(parsed, metadata, mutation);
    reviewerReportPath = targetStatePathFromManifest(
      metadata.targetStateDir,
      metadata.manifest.lastReviewerReportPath,
      path.posix.join('reports', `reviewer-round-${padRound(round)}.md`),
      { allowedDirectories: ['reports'], label: 'Last reviewer report path' }
    );
    ledgerPath = statePathFromManifest(
      metadata.projectRoot,
      metadata.targetStateDir,
      metadata.targetKey,
      metadata.manifest.ledgerPath,
      'ISSUES.md'
    );
  } catch (error) {
    if (isStateValidationError(error)) return blockPersistentStateValidation(parsed, metadata, error);
    throw error;
  }
  const reviewerReport = readReviewerReport(reviewerReportPath);
  const payload = readWorkflowPayload({
    parsed,
    metadata,
    valueFlag: 'triage',
    stdinFlag: 'triageStdin',
    label: 'triage result',
    options
  });
  const triage = parseTriageResult(payload);
  const enrichedDecisions = enrichTriageDecisions(triage, reviewerReport);
  const ledger = applyTriageDecisions(readLedgerIfPresent(ledgerPath), enrichedDecisions);
  atomicWriteFile(ledgerPath, formatLedger(ledger));

  const baseName = `triage-round-${padRound(round)}`;
  const reportPath = nextReportPath(metadata.targetStateDir, baseName);
  writeTriageReport({
    reportPath,
    phase,
    round,
    triage: { decisions: enrichedDecisions, warnings: triage.warnings },
    ledger
  });
  const outcome = triageOutcome({
    decisions: enrichedDecisions,
    mode: metadata.manifest.mode,
    strictness: metadata.manifest.strictness
  });
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
  updatePersistentManifest(metadata, {
    status: outcome.status,
    currentPhase: outcome.currentPhase,
    blockingReason: 'none',
    statusReason: outcome.statusReason,
    currentReportPath: relativeReportPath,
    lastTriageReportPath: relativeReportPath
  });

  return persistentBase(parsed, metadata, {
    ok: true,
    status: 'recorded-triage',
    ledgerPath,
    triageReportPath: reportPath,
    normalized: { decisions: enrichedDecisions, warnings: triage.warnings }
  });
}

function projectRootFromTargetStateDir(targetStateDir) {
  const absolute = path.resolve(targetStateDir);
  return path.dirname(path.dirname(path.dirname(absolute)));
}

function resolveTargetFromStateManifest(projectRoot, manifest) {
  if (manifest.target && path.isAbsolute(manifest.target)) return manifest.target;
  if (manifest.normalizedTarget && manifest.normalizedTarget !== 'none') {
    return path.resolve(projectRoot, manifest.normalizedTarget);
  }
  return path.resolve(projectRoot, manifest.target);
}

function resolveStateCommandMetadata(targetStateDir) {
  const absoluteTargetStateDir = path.resolve(targetStateDir);
  const projectRoot = projectRootFromTargetStateDir(absoluteTargetStateDir);
  const manifestPath = path.join(absoluteTargetStateDir, 'MANIFEST.md');
  let manifest;
  try {
    manifest = readManifestAny(manifestPath);
  } catch (error) {
    const wrapped = new Error(`state-validation-failed: unable to read target state manifest: ${error.message}`);
    wrapped.code = 'ERR_STATE_VALIDATION_FAILED';
    throw wrapped;
  }
  const targetKey = manifest.targetKey || path.basename(absoluteTargetStateDir);
  if (targetKey !== path.basename(absoluteTargetStateDir)) {
    failStateValidation('target state directory does not match manifest Target key');
  }
  const targetPath = resolveTargetFromStateManifest(projectRoot, manifest);
  const ledgerPath = statePathFromManifest(
    projectRoot,
    absoluteTargetStateDir,
    targetKey,
    manifest.ledgerPath,
    'ISSUES.md'
  );
  return {
    projectRoot,
    targetKey,
    normalizedTarget: manifest.normalizedTarget,
    targetPath,
    targetStateDir: absoluteTargetStateDir,
    manifestPath,
    ledgerPath,
    manifest
  };
}

function stateCommandBase(metadata, overrides = {}) {
  return {
    ok: true,
    status: overrides.status || metadata.manifest.status,
    target: metadata.targetPath,
    targetStateDir: metadata.targetStateDir,
    targetKey: metadata.targetKey,
    manifestPath: metadata.manifestPath,
    ledgerPath: metadata.ledgerPath,
    round: Number(metadata.manifest.currentRound || 1),
    currentPhase: overrides.currentPhase || metadata.manifest.currentPhase,
    documentType: metadata.manifest.documentType,
    strictness: metadata.manifest.strictness,
    requestedMode: metadata.manifest.mode,
    mode: metadata.manifest.mode,
    modeSource: 'manifest',
    modeNormalizedFrom: null,
    requestedAssurance: metadata.manifest.assurance,
    assuranceSource: 'manifest',
    assuranceNormalizedFrom: null,
    assurance: metadata.manifest.assurance,
    runtimePlatform: metadata.manifest.runtimePlatform,
    descriptorPlatform: metadata.manifest.descriptorPlatform,
    assuranceProof: metadata.manifest.assuranceProof,
    runtimeCheck: {
      platform: metadata.manifest.runtimePlatform,
      subagentProbe: {
        status: metadata.manifest.runtimeSubagentProbe,
        evidence: metadata.manifest.runtimeSubagentProbeEvidence
      },
      stdinHandoff: {
        status: metadata.manifest.runtimeStdinHandoff,
        evidence: metadata.manifest.runtimeStdinHandoffEvidence
      },
      fingerprintGuard: { status: metadata.manifest.runtimeFingerprintGuard },
      downgradeReason: metadata.manifest.runtimeDowngradeReason
    },
    blockingReason: overrides.blockingReason || metadata.manifest.blockingReason || 'none',
    statusReason: overrides.statusReason || metadata.manifest.statusReason || 'none',
    nextAction: Object.hasOwn(overrides, 'nextAction') ? overrides.nextAction : null,
    ...overrides
  };
}

function stateValidationResult(targetStateDir, error) {
  const manifestPath = path.join(path.resolve(targetStateDir), 'MANIFEST.md');
  return {
    ok: false,
    status: 'blocked',
    targetStateDir: path.resolve(targetStateDir),
    manifestPath,
    ledgerPath: null,
    round: null,
    documentType: 'none',
    strictness: 'none',
    requestedMode: null,
    mode: null,
    modeSource: null,
    modeNormalizedFrom: null,
    requestedAssurance: null,
    assuranceSource: null,
    assuranceNormalizedFrom: null,
    assurance: null,
    runtimePlatform: null,
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    errorCode: error && error.code ? error.code : 'ERR_STATE_VALIDATION_FAILED',
    message: error && error.message ? error.message : String(error),
    nextAction: 'repair target state before continuing fix'
  };
}

function assertFixEligible(metadata) {
  if (metadata.manifest.mode !== 'review-and-fix') {
    failStateValidation('begin-fix requires Mode: review-and-fix');
  }
  if (metadata.manifest.assurance === 'advisory') {
    failStateValidation('begin-fix rejects Assurance: advisory');
  }
  if (metadata.manifest.status !== 'fix' || metadata.manifest.currentPhase !== 'fix') {
    failStateValidation('begin-fix requires Status: fix and Current phase: fix');
  }
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const fixableIssues = fixableIssuesFromLedger(ledger);
  if (fixableIssues.length === 0) {
    failStateValidation('begin-fix requires accepted or reopened issue IDs');
  }
  return { ledger, fixableIssues };
}

function referenceFingerprintsForManifest(metadata) {
  return (metadata.manifest.references || []).map((referencePath) => {
    const absolute = path.isAbsolute(referencePath)
      ? referencePath
      : path.resolve(metadata.projectRoot, referencePath);
    return canonicalFingerprint(computeFingerprint(absolute), toPosixPath(referencePath));
  });
}

function toPosixPath(filePath) {
  return String(filePath).split(path.sep).join('/');
}

function readJsonReportBlock(reportPath, label) {
  const text = fs.readFileSync(reportPath, 'utf8');
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) failStateValidation(`${label} missing normalized json block`);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    failStateValidation(`${label} contains invalid json`);
  }
}

function latestReportPathByPrefix(targetStateDir, prefix) {
  const reportsDir = path.join(targetStateDir, 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const matches = fs.readdirSync(reportsDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.md'))
    .sort();
  if (matches.length === 0) return null;
  return path.join(reportsDir, matches[matches.length - 1]);
}

function readLatestFixGuardReport(metadata) {
  const round = Number(metadata.manifest.currentRound || 1);
  let reportPath = null;
  if (metadata.manifest.currentReportPath && metadata.manifest.currentReportPath !== 'none') {
    reportPath = targetStatePathFromManifest(metadata.targetStateDir, metadata.manifest.currentReportPath, null, {
      allowedDirectories: ['reports'],
      label: 'Current report path'
    });
  }
  if (!reportPath || !fs.existsSync(reportPath)) {
    reportPath = latestReportPathByPrefix(metadata.targetStateDir, `fix-guard-round-${padRound(round)}`);
  }
  if (!reportPath) failStateValidation('fix guard report is missing');
  return { reportPath, report: readJsonReportBlock(reportPath, 'Fix guard report') };
}

function readLatestFixGuardBaseline(metadata) {
  try {
    const baseline = readLatestFixGuardReport(metadata);
    const report = baseline.report || {};
    if (report.status !== 'passed') failStateValidation('fix guard baseline must be passed');
    if (report.blockingReason !== 'none') failStateValidation('fix guard baseline must have Blocking reason: none');
    if (!report.rollbackAnchor || report.rollbackAnchor.status !== 'passed') {
      failStateValidation('fix guard baseline missing passed rollback anchor');
    }
    if (!report.targetOnlyGuard || report.targetOnlyGuard.status !== 'passed') {
      failStateValidation('fix guard baseline missing passed target-only guard');
    }
    if (report.normalizedTarget !== metadata.normalizedTarget) {
      failStateValidation('fix guard baseline target mismatch');
    }
    return { ok: true, ...baseline };
  } catch (error) {
    return { ok: false, error };
  }
}

function assertReferencesUnchanged(metadata, guardReport) {
  const expected = guardReport.referenceFingerprints || [];
  let actual;
  try {
    actual = referenceFingerprintsForManifest(metadata);
  } catch {
    return 'reference-mutated-file';
  }
  if (stableJson(expected) !== stableJson(actual)) {
    return 'reference-mutated-file';
  }
  return null;
}

function safeTargetFingerprint(metadata) {
  try {
    return canonicalFingerprint(computeFingerprint(metadata.targetPath));
  } catch {
    return null;
  }
}

function safeReferenceFingerprints(metadata) {
  try {
    return referenceFingerprintsForManifest(metadata);
  } catch {
    return [];
  }
}

function writeBeginFixGuardReport(metadata, {
  lease,
  rollbackAnchor,
  targetOnlyGuard,
  status,
  blockingReason
}) {
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `fix-guard-round-${padRound(round)}`);
  atomicWriteFile(reportPath, formatFixGuardReport({
    round,
    normalizedTarget: metadata.normalizedTarget,
    targetFingerprint: safeTargetFingerprint(metadata),
    referenceFingerprints: safeReferenceFingerprints(metadata),
    rollbackAnchor,
    targetOnlyGuard,
    lock: lease ? {
      ownerId: lease.ownerId,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt
    } : null,
    status,
    blockingReason
  }));
  return reportPath;
}

function readFixReportPayload(parsed, metadata, options) {
  const fromStdin = Boolean(parsed.payloadFlags.fixReportStdin);
  const fromFile = parsed.payloadFlags.fixReport || null;
  if (fromStdin === Boolean(fromFile)) {
    fail('ERR_SEMANTIC_HANDOFF', 'exactly one fix report stdin or safe file input is required');
  }
  if (fromStdin) return readSemanticPayload({ content: options.stdin || '' });
  return readSemanticPayload({ filePath: fromFile, projectRoot: metadata.projectRoot });
}

function validateFixedIssueIds(fixReport, ledger) {
  const issues = new Map((ledger.issues || []).map((issue) => [issue.id, issue]));
  for (const fixed of fixReport.fixed || []) {
    const issue = issues.get(fixed.issue_id);
    if (!issue) failStateValidation(`fixed issue id does not exist: ${fixed.issue_id}`);
    if (!['accepted', 'reopened'].includes(issue.status)) {
      failStateValidation(`fixed issue must be accepted or reopened: ${fixed.issue_id}`);
    }
  }
}

function validateDeclaredFilesChanged(fixReport, normalizedTarget) {
  if (
    !Array.isArray(fixReport.filesChanged) ||
    fixReport.filesChanged.length !== 1 ||
    fixReport.filesChanged[0] !== normalizedTarget
  ) {
    return 'fix-report-mismatch';
  }
  return null;
}

function updateFixedIssues(ledger, fixReport) {
  const summaries = new Map((fixReport.fixed || []).map((fixed) => [fixed.issue_id, fixed.summary]));
  return {
    issues: (ledger.issues || []).map((issue) => {
      if (!summaries.has(issue.id)) return issue;
      return {
        ...issue,
        status: 'fixed',
        resolution: `Fixed: ${summaries.get(issue.id)}`
      };
    })
  };
}

function writeNormalizedFixReport({ metadata, fixReport }) {
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `fix-round-${padRound(round)}`);
  const report = {
    round,
    normalized: fixReport
  };
  const lines = [
    '# Fix Report',
    '',
    `Round: ${round}`,
    '',
    '```json',
    reportJsonBlock(report).trimEnd(),
    '```',
    ''
  ];
  atomicWriteFile(reportPath, lines.join('\n'));
  return reportPath;
}

function writeFixReceipt(metadata, {
  kind = 'fix-blocked',
  status,
  issueIds = [],
  filesChanged = 'none',
  verification = 'none',
  blockingReason = 'none',
  statusReason = 'none',
  summary = 'none',
  nextAction = 'none'
}) {
  return writeRoundReceipt({
    projectRoot: metadata.projectRoot,
    targetKey: metadata.targetKey,
    round: Number(metadata.manifest.currentRound || 1),
    kind,
    status,
    target: metadata.normalizedTarget,
    issueIds,
    filesChanged,
    verification,
    blockingReason,
    statusReason,
    summary,
    nextAction
  });
}

function readStateCommandPayload({ metadata, parsed, valueFlag, stdinFlag, label, options }) {
  const fromStdin = Boolean(parsed.payloadFlags[stdinFlag]);
  const fromFile = parsed.payloadFlags[valueFlag] || null;
  if (fromStdin === Boolean(fromFile)) {
    fail('ERR_SEMANTIC_HANDOFF', `exactly one ${label} stdin or safe file input is required`);
  }
  if (fromStdin) return readSemanticPayload({ content: options.stdin || '' });
  return readSemanticPayload({ filePath: fromFile, projectRoot: metadata.projectRoot });
}

function writeWorkflowSummary(metadata, nextAction = 'none') {
  const ledgerPath = metadata.ledgerPath || statePathFromManifest(
    metadata.projectRoot,
    metadata.targetStateDir,
    metadata.targetKey,
    metadata.manifest.ledgerPath,
    'ISSUES.md'
  );
  const ledger = readLedgerIfPresent(ledgerPath);
  const roundsDir = path.join(metadata.targetStateDir, 'rounds');
  const receipts = fs.existsSync(roundsDir)
    ? fs.readdirSync(roundsDir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => path.posix.join('rounds', name))
    : [];
  atomicWriteFile(path.join(metadata.targetStateDir, 'SUMMARY.md'), formatSummary({
    manifest: metadata.manifest,
    ledger,
    receipts,
    nextAction
  }));
}

function writeFinalReceipt(metadata, finalResponse, {
  kind = null,
  nextAction = 'none'
} = {}) {
  return writeRoundReceipt({
    projectRoot: metadata.projectRoot,
    targetKey: metadata.targetKey,
    round: Number(metadata.manifest.currentRound || 1),
    kind: kind || `final-${finalResponse.finalStatus}`,
    status: finalResponse.finalStatus,
    target: metadata.normalizedTarget,
    issueIds: finalResponse.fixedIssueIds === 'none'
      ? []
      : String(finalResponse.fixedIssueIds).split(',').map((item) => item.trim()),
    filesChanged: finalResponse.filesChanged || 'none',
    verification: finalResponse.verificationPerformed || 'none',
    blockingReason: finalResponse.blockingReason || 'none',
    statusReason: finalResponse.statusReason || 'none',
    summary: finalResponse.deferralsOrBlockers || 'none',
    nextAction
  });
}

function finalizationRequiresReceipt(status) {
  return [
    'blocked',
    'checkpoint',
    'stopped-with-deferrals',
    'read-only-findings',
    'read-only-clean',
    'unsupported',
    'externally-changed',
    'possible-target-replacement'
  ].includes(status);
}

function readManifestReport(metadata, storedPath, label) {
  if (!storedPath || storedPath === 'none') return null;
  const reportPath = targetStatePathFromManifest(metadata.targetStateDir, storedPath, null, {
    allowedDirectories: ['reports'],
    label
  });
  if (!fs.existsSync(reportPath)) failStateValidation(`${label} is missing`);
  return { reportPath, report: readJsonReportBlock(reportPath, label) };
}

function readRequiredResumeLedger(metadata) {
  const ledgerPath = metadata.ledgerPath || statePathFromManifest(
    metadata.projectRoot,
    metadata.targetStateDir,
    metadata.targetKey,
    metadata.manifest.ledgerPath,
    'ISSUES.md'
  );
  metadata.ledgerPath = ledgerPath;
  if (!fs.existsSync(ledgerPath)) {
    failStateValidation('resume requires ISSUES.md ledger');
  }
  try {
    return parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (error) {
    failStateValidation(`resume ledger is invalid: ${error && error.message ? error.message : String(error)}`);
  }
}

function readResumeReferencedReports(metadata) {
  const reportFields = [
    ['currentReportPath', 'Current report path'],
    ['lastReviewerReportPath', 'Last reviewer report path'],
    ['lastTriageReportPath', 'Last triage report path'],
    ['lastFixReportPath', 'Last fix report path'],
    ['lastDiffReviewReportPath', 'Last diff review report path']
  ];
  const reports = {};
  for (const [field, label] of reportFields) {
    if (!metadata.manifest[field] || metadata.manifest[field] === 'none') continue;
    reports[field] = readManifestReport(metadata, metadata.manifest[field], label);
  }
  return reports;
}

function readResumeReceiptsIfNeeded(metadata) {
  if (!resumeRequiresReceipt(metadata.manifest.status)) return [];
  const roundsDir = path.join(metadata.targetStateDir, 'rounds');
  if (!fs.existsSync(roundsDir)) return [];
  return fs.readdirSync(roundsDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const receiptPath = targetStatePathFromManifest(
        metadata.targetStateDir,
        path.posix.join('rounds', name),
        null,
        { allowedDirectories: ['rounds'], label: 'Round receipt path' }
      );
      const text = fs.readFileSync(receiptPath, 'utf8');
      if (text.includes('\0')) failStateValidation('round receipt contains invalid null bytes');
      return { receiptPath, text };
    });
}

function readResumeDeterministicInputs(metadata) {
  return {
    ledger: readRequiredResumeLedger(metadata),
    reports: readResumeReferencedReports(metadata),
    receipts: readResumeReceiptsIfNeeded(metadata)
  };
}

function reportResult(report) {
  return report && report.normalized && report.normalized.result;
}

function reportIssueIds(report) {
  const normalized = report && report.normalized ? report.normalized : {};
  if (Array.isArray(normalized.fixed)) return normalized.fixed.map((item) => item.issue_id).sort();
  return [];
}

function unresolvedBlockingIssues(ledger) {
  return (ledger.issues || [])
    .filter((issue) => (
      ['accepted', 'reopened'].includes(issue.status) &&
      ['high', 'medium'].includes(issue.severity)
    ))
    .map((issue) => issue.id)
    .sort();
}

function includedLowIdsFromCurrentContext(metadata) {
  const contextPath = path.join(metadata.targetStateDir, 'context', 'current-reviewer-context-manifest.md');
  if (!fs.existsSync(contextPath)) return [];
  try {
    const context = readContextManifest(contextPath);
    const ids = context.acceptedNonBlockingLowIssueIds;
    if (ids === 'none') return [];
    return Array.isArray(ids) ? ids.slice().sort() : [];
  } catch {
    return [];
  }
}

function allIncluded(needles, haystack) {
  const values = new Set(haystack || []);
  return (needles || []).every((needle) => values.has(needle));
}

function latestFullReviewComplete({ latestReviewer, hasFixRound, round }) {
  if (!latestReviewer) return false;
  const report = latestReviewer.report || {};
  if (Number(report.round || 1) !== Number(round || 1)) return false;
  if (hasFixRound && report.phase !== 'full-re-review') return false;
  const normalized = report.normalized || {};
  if (normalized.result === 'PASS') return true;
  if (normalized.result !== 'FAIL') return false;
  return Array.isArray(normalized.findings) &&
    normalized.findings.every((finding) => finding.severity === 'low');
}

function reviewerBlockingIssueIds(latestReviewer) {
  const report = latestReviewer && latestReviewer.report ? latestReviewer.report : {};
  const normalized = report.normalized || {};
  if (normalized.result !== 'FAIL' || !Array.isArray(normalized.findings)) return [];
  return normalized.findings
    .filter((finding) => ['high', 'medium'].includes(finding.severity))
    .map((finding) => finding.id || finding.issue_id)
    .filter(Boolean)
    .sort();
}

function hasTriageLedgerOutcome(metadata, ledger) {
  if (metadata.manifest.lastTriageReportPath && metadata.manifest.lastTriageReportPath !== 'none') return true;
  return Array.isArray(ledger.issues) && ledger.issues.length > 0;
}

function buildFinalValidationState(metadata) {
  const round = Number(metadata.manifest.currentRound || 1);
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const fixReport = readManifestReport(metadata, metadata.manifest.lastFixReportPath, 'Last fix report path');
  const diffReport = readManifestReport(metadata, metadata.manifest.lastDiffReviewReportPath, 'Last diff review report path');
  const latestReviewer = readManifestReport(metadata, metadata.manifest.lastReviewerReportPath, 'Last reviewer report path');
  const hasFixRound = Boolean(fixReport);
  const fixRoundCurrent = !hasFixRound || Number(fixReport.report.round || 1) === round;
  const acceptedLowIds = acceptedNonBlockingLowIssueIdsFromLedger(ledger);
  const includedLowIds = includedLowIdsFromCurrentContext(metadata);
  const changedFiles = hasFixRound ? metadata.normalizedTarget : 'none';
  const unresolvedIds = unresolvedBlockingIssues(ledger);
  const readOnlyBlockingIds = [...new Set([
    ...unresolvedIds,
    ...(hasTriageLedgerOutcome(metadata, ledger) ? [] : reviewerBlockingIssueIds(latestReviewer))
  ])].sort();
  return {
    persistent: true,
    target: metadata.normalizedTarget,
    mode: metadata.manifest.mode,
    assurance: metadata.manifest.assurance,
    runtimePlatform: metadata.manifest.runtimePlatform,
    strictness: metadata.manifest.strictness,
    filesChanged: changedFiles,
    fixedIssueIds: hasFixRound ? reportIssueIds(fixReport.report) : [],
    unresolvedBlockingIssues: unresolvedIds,
    readOnlyBlockingIssueIds: readOnlyBlockingIds,
    acceptedNonBlockingLowIssueIds: acceptedLowIds,
    requiredDiffReviewComplete: !hasFixRound ? true : Boolean(
      fixRoundCurrent &&
      diffReport &&
      Number(diffReport.report.round || 1) === round &&
      reportResult(diffReport.report) === 'DIFF-OK'
    ),
    requiredFullReReviewComplete: Boolean(
      fixRoundCurrent && latestFullReviewComplete({ latestReviewer, hasFixRound, round })
    ),
    strictAcceptedLowIncludedInLatestFullReview: allIncluded(acceptedLowIds, includedLowIds)
  };
}

function receiptFailureResult(metadata, error) {
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason: 'state-validation-failed',
    statusReason: 'none'
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    errorCode: error && error.code ? error.code : 'ERR_RECEIPT_WRITE_FAILED',
    message: error && error.message ? error.message : String(error),
    nextAction: 'repair target state receipt directory'
  });
}

function activeLeaseOrBlock(metadata) {
  return readPersistedLeaseForTarget({
    projectRoot: metadata.projectRoot,
    targetKey: metadata.targetKey,
    targetPath: metadata.targetPath
  });
}

function releasePersistedLease(metadata) {
  const lease = activeLeaseOrBlock(metadata);
  return releaseLock({
    projectRoot: metadata.projectRoot,
    targetKey: metadata.targetKey,
    ownerId: lease.ownerId
  });
}

function lockReleaseFailureResult(metadata, error, originalBlockingReason) {
  try {
    writeFixReceipt(metadata, {
      kind: 'lock-release-failed',
      status: 'blocked',
      blockingReason: 'lock-release-failed',
      summary: `Original blocking reason: ${originalBlockingReason || 'none'}`,
      nextAction: 'release or repair the target lock before continuing'
    });
  } catch (receiptError) {
    return receiptFailureResult(metadata, receiptError);
  }
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason: 'lock-release-failed',
    statusReason: 'none'
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason: 'lock-release-failed',
    statusReason: 'none',
    errorCode: error && error.code ? error.code : 'ERR_LOCK_RELEASE_FAILED',
    message: error && error.message ? error.message : String(error),
    originalBlockingReason: originalBlockingReason || 'none',
    nextAction: 'release or repair the target lock before continuing'
  });
}

function endFixBlocked(metadata, blockingReason, {
  issueIds = [],
  filesChanged = 'none',
  summary = 'none',
  nextAction = 'repair fix output and rerun end-fix'
} = {}) {
  try {
    writeFixReceipt(metadata, {
      status: 'blocked',
      issueIds,
      filesChanged,
      blockingReason,
      summary,
      nextAction
    });
  } catch (error) {
    return receiptFailureResult(metadata, error);
  }
  try {
    releasePersistedLease(metadata);
  } catch (error) {
    return lockReleaseFailureResult(metadata, error, blockingReason);
  }
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason,
    statusReason: 'none'
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    nextAction
  });
}

function beginFixBlocked(metadata, lease, {
  blockingReason,
  rollbackAnchor,
  targetOnlyGuard,
  summary,
  nextAction,
  errorCode = null,
  message = null
}) {
  let reportPath = null;
  try {
    reportPath = writeBeginFixGuardReport(metadata, {
      lease,
      rollbackAnchor,
      targetOnlyGuard,
      status: 'blocked',
      blockingReason
    });
  } catch (error) {
    if (lease) {
      try {
        releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
      } catch {
        // Preserve the report write failure as the blocker because no valid guard report was persisted.
      }
    }
    return receiptFailureResult(metadata, error);
  }

  try {
    writeFixReceipt(metadata, {
      status: 'blocked',
      blockingReason,
      summary,
      nextAction
    });
  } catch (error) {
    return receiptFailureResult(metadata, error);
  }

  if (lease) {
    try {
      releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
    } catch (error) {
      return lockReleaseFailureResult(metadata, error, blockingReason);
    }
  }

  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    currentReportPath: relativeReportPath
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    errorCode,
    message,
    fixGuardReportPath: reportPath,
    nextAction
  });
}

function runBeginFix(parsed, options) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
    assertFixEligible(metadata);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  const ownerId = `drfx-${crypto.randomUUID()}`;
  let lease;
  try {
    lease = acquireLock({
      projectRoot: metadata.projectRoot,
      targetKey: metadata.targetKey,
      targetPath: metadata.targetPath,
      ownerId,
      mode: metadata.manifest.mode,
      strictness: metadata.manifest.strictness,
      now: options.now || new Date(),
      lastKnownContentSha256: metadata.manifest.lastKnownContentSha256,
      manifest: metadata.manifest
    });
    assertPreFixFingerprint({
      targetPath: metadata.targetPath,
      lease,
      manifest: metadata.manifest
    });
    const rollbackAnchor = checkGitRollbackAnchor({
      projectRoot: metadata.projectRoot,
      targetPath: metadata.targetPath,
      expectedNormalizedTarget: metadata.normalizedTarget
    });
    const targetOnlyGuard = checkTargetOnlyWorktree({
      projectRoot: metadata.projectRoot,
      targetPath: metadata.targetPath,
      allowedStateDir: metadata.targetStateDir,
      expectedNormalizedTarget: metadata.normalizedTarget
    });
    if (targetOnlyGuard.status === 'blocked') {
      return beginFixBlocked(metadata, lease, {
        blockingReason: targetOnlyGuard.blockingReason,
        rollbackAnchor,
        targetOnlyGuard,
        summary: 'pre-fix target-only guard blocked automatic target writes',
        nextAction: 'restore non-target worktree changes before retrying begin-fix'
      });
    }
    const reportPath = writeBeginFixGuardReport(metadata, {
      lease,
      rollbackAnchor,
      targetOnlyGuard,
      status: 'passed',
      blockingReason: 'none'
    });
    const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
    updatePersistentManifest(metadata, {
      status: 'fix',
      currentPhase: 'fix',
      blockingReason: 'none',
      statusReason: 'none',
      currentReportPath: relativeReportPath,
      runtimeFingerprintGuard: 'passed'
    });
    return stateCommandBase(metadata, {
      ok: true,
      status: 'begin-fix',
      lockOwnerId: lease.ownerId,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.expiresAt,
      refreshAfterSeconds: 60,
      fixGuardReportPath: reportPath
    });
  } catch (error) {
    const blockingReason = error && (error.blockingReason || error.reason);
    const mappedReason = blockingReason === 'rollback-unavailable' ||
      ['target-fingerprint-mismatch', 'manifest-fingerprint-mismatch'].includes(blockingReason) ||
      ['ENOENT', 'EACCES', 'ERR_FILE_MISSING'].includes(error && error.code)
      ? 'rollback-unavailable'
      : (blockingReason === 'target-only-guard-unavailable' ? 'target-only-guard-unavailable' : 'state-validation-failed');
    if (['rollback-unavailable', 'target-only-guard-unavailable'].includes(mappedReason)) {
      return beginFixBlocked(metadata, lease, {
        blockingReason: mappedReason,
        rollbackAnchor: mappedReason === 'rollback-unavailable'
          ? {
            status: 'blocked',
            blockingReason: mappedReason,
            entries: Array.isArray(error && error.entries) ? error.entries : []
          }
          : { status: 'not-run' },
        targetOnlyGuard: mappedReason === 'target-only-guard-unavailable'
          ? { status: 'blocked', blockingReason: mappedReason, entries: [] }
          : { status: 'not-run' },
        summary: `${mappedReason} blocked automatic target writes before fix`,
        nextAction: mappedReason === 'rollback-unavailable'
          ? 'restore a clean tracked target with git HEAD before retrying begin-fix'
          : 'restore target state and retry begin-fix',
        errorCode: error && error.code ? error.code : 'ERR_FIX_GUARD',
        message: error && error.message ? error.message : String(error)
      });
    }
    if (lease) {
      try {
        releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
      } catch {
        // The original pre-write guard failure is more useful here; a later end/abort can repair stale locks.
      }
    }
    updatePersistentManifest(metadata, {
      status: 'blocked',
      blockingReason: mappedReason,
      statusReason: 'none'
    });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      blockingReason: mappedReason,
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FIX_GUARD',
      message: error && error.message ? error.message : String(error),
      nextAction: mappedReason === 'rollback-unavailable'
        ? 'restore a clean tracked target with git HEAD before retrying begin-fix'
        : 'restore target state and retry begin-fix'
    });
  }
}

function runRefreshLock(parsed, options) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
    const lease = activeLeaseOrBlock(metadata);
    if (Date.parse(lease.expiresAt) <= (options.now || new Date()).getTime()) {
      const error = new Error('corrupt-lock: active lease is stale');
      error.code = 'ERR_CORRUPT_LOCK';
      error.status = 'blocked';
      error.reason = 'corrupt-lock';
      throw error;
    }
    const refreshed = refreshLock({
      projectRoot: metadata.projectRoot,
      targetKey: metadata.targetKey,
      ownerId: lease.ownerId,
      now: options.now || new Date()
    });
    return stateCommandBase(metadata, {
      ok: true,
      status: 'refresh-lock',
      lockOwnerId: refreshed.ownerId,
      leaseId: refreshed.leaseId,
      leaseExpiresAt: refreshed.expiresAt,
      refreshAfterSeconds: 60
    });
  } catch (error) {
    if (!metadata) return stateValidationResult(parsed.targetStateDir, error);
    const blockingReason = error && error.reason ? error.reason : 'corrupt-lock';
    updatePersistentManifest(metadata, {
      status: 'blocked',
      blockingReason,
      statusReason: 'none'
    });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      blockingReason,
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_LOCK_REFRESH_FAILED',
      message: error && error.message ? error.message : String(error),
      nextAction: 'restart fix after repairing the target lock'
    });
  }
}

function runEndFix(parsed, options) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
    if (metadata.manifest.status !== 'fix' || metadata.manifest.currentPhase !== 'fix') {
      failStateValidation('end-fix requires Status: fix and Current phase: fix');
    }
    activeLeaseOrBlock(metadata);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  const guardBaseline = readLatestFixGuardBaseline(metadata);
  if (!guardBaseline.ok) {
    return endFixBlocked(metadata, 'target-only-guard-unavailable', {
      summary: 'persisted fix guard baseline is unavailable or unparseable',
      nextAction: 'rerun begin-fix before submitting end-fix'
    });
  }

  let fixReport;
  try {
    const payload = readFixReportPayload(parsed, metadata, options);
    fixReport = parseFixReport(payload);
  } catch (error) {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      summary: 'fix report was unparseable',
      nextAction: 'submit a valid normalized fix report'
    });
  }

  let ledger;
  try {
    ledger = readLedgerIfPresent(metadata.ledgerPath);
    validateFixedIssueIds(fixReport, ledger);
  } catch (error) {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      issueIds: (fixReport.fixed || []).map((fixed) => fixed.issue_id),
      filesChanged: Array.isArray(fixReport.filesChanged) ? fixReport.filesChanged.join(', ') : 'none',
      summary: 'fix report issue IDs do not match accepted or reopened ledger issues',
      nextAction: 'submit a fix report containing only accepted or reopened issue IDs'
    });
  }

  const declaredMismatch = validateDeclaredFilesChanged(fixReport, metadata.normalizedTarget);
  if (declaredMismatch) {
    return endFixBlocked(metadata, declaredMismatch, {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: fixReport.filesChanged.join(', '),
      summary: 'fix report declared files changed outside the target'
    });
  }

  const actual = inspectActualChangedFiles({
    projectRoot: metadata.projectRoot,
    targetPath: metadata.targetPath,
    allowedStateDir: metadata.targetStateDir,
    expectedNormalizedTarget: metadata.normalizedTarget
  });
  if (actual.status === 'blocked') {
    return endFixBlocked(metadata, actual.blockingReason, {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: fixReport.filesChanged.join(', '),
      summary: 'actual changed-file inspection blocked end-fix'
    });
  }
  if (stableJson(actual.changedFiles) !== stableJson([metadata.normalizedTarget])) {
    return endFixBlocked(metadata, 'fix-report-mismatch', {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: actual.changedFiles.join(', ') || 'none',
      summary: 'actual changed files differ from fix report'
    });
  }

  const guardReport = guardBaseline.report;
  const referenceMutation = assertReferencesUnchanged(metadata, guardReport);
  if (referenceMutation) {
    return endFixBlocked(metadata, referenceMutation, {
      issueIds: fixReport.fixed.map((fixed) => fixed.issue_id),
      filesChanged: fixReport.filesChanged.join(', '),
      summary: 'reference fingerprints changed during fix'
    });
  }

  const reportPath = writeNormalizedFixReport({ metadata, fixReport });
  const nextLedger = updateFixedIssues(ledger, fixReport);
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
  const targetFingerprint = computeFingerprint(metadata.targetPath);
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
  updatePersistentManifest(metadata, {
    status: 'diff-review',
    currentPhase: 'diff-review',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: relativeReportPath,
    lastFixReportPath: relativeReportPath,
    lastKnownContentSha256: targetFingerprint.sha256,
    fileSize: targetFingerprint.size,
    lastModifiedAt: new Date().toISOString()
  });
  try {
    releasePersistedLease(metadata);
  } catch (error) {
    return lockReleaseFailureResult(metadata, error, 'none');
  }
  return stateCommandBase(metadata, {
    ok: true,
    status: 'end-fix',
    fixReportPath: reportPath,
    fixedIssueIds: fixReport.fixed.map((fixed) => fixed.issue_id)
  });
}

function runAbortFix(parsed) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }
  const status = parsed.payloadFlags.status;
  const reason = parsed.payloadFlags.reason;
  const nextAction = parsed.payloadFlags.nextAction || 'none';
  if (!['blocked', 'checkpoint'].includes(status)) {
    return stateValidationResult(parsed.targetStateDir, new Error('abort-fix requires --status blocked|checkpoint'));
  }
  if (status === 'blocked' && (!reason || reason === 'none' || !BLOCKING_REASONS.includes(reason))) {
    return stateValidationResult(parsed.targetStateDir, new Error('abort-fix blocked status requires an allowed blocking reason'));
  }
  if (status === 'checkpoint' && (!reason || !STATUS_REASONS.includes(reason) || reason === 'none')) {
    return stateValidationResult(parsed.targetStateDir, new Error('abort-fix checkpoint status requires an allowed status reason'));
  }

  try {
    writeFixReceipt(metadata, {
      kind: 'abort',
      status,
      blockingReason: status === 'blocked' ? reason : 'none',
      statusReason: status === 'checkpoint' ? reason : 'none',
      summary: 'fix aborted by coordinator',
      nextAction
    });
  } catch (error) {
    return receiptFailureResult(metadata, error);
  }
  updatePersistentManifest(metadata, {
    status,
    blockingReason: status === 'blocked' ? reason : 'none',
    statusReason: status === 'checkpoint' ? reason : 'none'
  });
  try {
    releasePersistedLease(metadata);
  } catch (error) {
    return lockReleaseFailureResult(metadata, error, reason || 'none');
  }
  return stateCommandBase(metadata, {
    ok: true,
    status,
    blockingReason: status === 'blocked' ? reason : 'none',
    statusReason: status === 'checkpoint' ? reason : 'none',
    nextAction,
    receiptKind: 'abort'
  });
}

function writeDiffReviewReport({ metadata, diffReview }) {
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `diff-review-round-${padRound(round)}`);
  const report = {
    round,
    normalized: diffReview
  };
  const lines = [
    '# Diff Review Report',
    '',
    `Round: ${round}`,
    `Result: ${diffReview.result}`,
    '',
    '```json',
    reportJsonBlock(report).trimEnd(),
    '```',
    ''
  ];
  atomicWriteFile(reportPath, lines.join('\n'));
  return reportPath;
}

function assertDiffReviewEligible(metadata) {
  if (metadata.manifest.status !== 'diff-review' || metadata.manifest.currentPhase !== 'diff-review') {
    failStateValidation('record-diff-review requires Status: diff-review and Current phase: diff-review');
  }
  if (!metadata.manifest.lastFixReportPath || metadata.manifest.lastFixReportPath === 'none') {
    failStateValidation('record-diff-review requires latest fix report');
  }
  const latestFix = readManifestReport(metadata, metadata.manifest.lastFixReportPath, 'Last fix report path');
  if (Number(latestFix.report.round) !== Number(metadata.manifest.currentRound || 1)) {
    failStateValidation('record-diff-review requires latest fix report for current round');
  }
  return latestFix;
}

function runRecordDiffReview(parsed, options) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
    assertDiffReviewEligible(metadata);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  let diffReview;
  try {
    const payload = readStateCommandPayload({
      metadata,
      parsed,
      valueFlag: 'diffReview',
      stdinFlag: 'diffReviewStdin',
      label: 'diff review',
      options
    });
    diffReview = parseDiffReview(payload);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  let reportPath;
  try {
    reportPath = writeDiffReviewReport({ metadata, diffReview });
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);

  if (diffReview.result === 'DIFF-FAIL') {
    const shouldBlock = parsed.payloadFlags.status === 'blocked' ||
      parsed.payloadFlags.blockingReason === 'diff-review-failed';
    if (shouldBlock) {
      const finalResponse = {
        finalStatus: 'blocked',
        fixedIssueIds: diffReview.findings.map((finding) => finding.issue_id).join(', ') || 'none',
        filesChanged: metadata.normalizedTarget,
        verificationPerformed: 'diff review',
        deferralsOrBlockers: 'diff review failed',
        blockingReason: 'diff-review-failed',
        statusReason: 'none'
      };
      try {
        writeFinalReceipt(metadata, finalResponse, {
          kind: 'diff-review-failed',
          nextAction: 'repair fix and rerun diff review'
        });
      } catch (error) {
        return receiptFailureResult(metadata, error);
      }
      updatePersistentManifest(metadata, {
        status: 'blocked',
        currentPhase: 'diff-review',
        blockingReason: 'diff-review-failed',
        statusReason: 'none',
        currentReportPath: relativeReportPath,
        lastDiffReviewReportPath: relativeReportPath
      });
      return stateCommandBase(metadata, {
        ok: false,
        status: 'blocked',
        currentPhase: 'diff-review',
        blockingReason: 'diff-review-failed',
        statusReason: 'none',
        diffReviewReportPath: reportPath,
        normalized: diffReview,
        nextAction: 'repair fix and rerun diff review'
      });
    }

    updatePersistentManifest(metadata, {
      status: 'fix',
      currentPhase: 'fix',
      blockingReason: 'none',
      statusReason: 'none',
      currentReportPath: relativeReportPath,
      lastDiffReviewReportPath: relativeReportPath
    });
    return stateCommandBase(metadata, {
      ok: true,
      status: 'recorded-diff-review',
      currentPhase: 'fix',
      diffReviewReportPath: reportPath,
      normalized: diffReview,
      nextAction: 'repair fix and rerun end-fix'
    });
  }

  updatePersistentManifest(metadata, {
    status: 'full-re-review',
    currentPhase: 'full-re-review',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: relativeReportPath,
    lastDiffReviewReportPath: relativeReportPath
  });
  return stateCommandBase(metadata, {
    ok: true,
    status: 'recorded-diff-review',
    currentPhase: 'full-re-review',
    diffReviewReportPath: reportPath,
    normalized: diffReview,
    nextAction: 'run full re-review'
  });
}

function runPersistentFinalize(parsed, options) {
  let metadata;
  try {
    metadata = resolveStateCommandMetadata(parsed.targetStateDir);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  let finalResponse;
  let validation;
  try {
    const payload = readStateCommandPayload({
      metadata,
      parsed,
      valueFlag: 'finalResponse',
      stdinFlag: 'finalResponseStdin',
      label: 'final response',
      options
    });
    finalResponse = parseFinalResponseBlock(payload);
    validation = validateFinalResponse({
      finalResponse,
      state: buildFinalValidationState(metadata)
    });
  } catch (error) {
    try {
      writeFinalReceipt(metadata, {
        finalStatus: 'blocked',
        fixedIssueIds: 'none',
        filesChanged: 'none',
        verificationPerformed: 'final response validation',
        deferralsOrBlockers: 'final validation failed',
        blockingReason: 'final-validation-failed',
        statusReason: 'none'
      }, {
        kind: 'final-validation-failed',
        nextAction: 'repair final response or workflow state before retrying finalize'
      });
    } catch (receiptError) {
      return receiptFailureResult(metadata, receiptError);
    }
    updatePersistentManifest(metadata, {
      status: 'blocked',
      currentPhase: 'final',
      blockingReason: 'final-validation-failed',
      statusReason: 'none'
    });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      currentPhase: 'final',
      blockingReason: 'final-validation-failed',
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FINAL_VALIDATION_FAILED',
      message: error && error.message ? error.message : String(error),
      nextAction: 'repair final response or workflow state before retrying finalize'
    });
  }

  const nextAction = finalResponse.finalStatus === 'pass' ? 'none' : (finalResponse.deferralsOrBlockers || 'none');
  if (finalizationRequiresReceipt(finalResponse.finalStatus)) {
    try {
      writeFinalReceipt(metadata, finalResponse, { nextAction });
    } catch (error) {
      return receiptFailureResult(metadata, error);
    }
  }

  const updates = {
    status: finalResponse.finalStatus,
    currentPhase: 'final',
    blockingReason: finalResponse.blockingReason,
    statusReason: finalResponse.statusReason
  };
  if (finalResponse.finalStatus === 'pass') {
    const targetFingerprint = computeFingerprint(metadata.targetPath);
    updates.lastKnownContentSha256 = targetFingerprint.sha256;
    updates.lastReviewedContentSha256 = targetFingerprint.sha256;
    updates.lastPassedContentSha256 = targetFingerprint.sha256;
    updates.fileSize = targetFingerprint.size;
    updates.lastModifiedAt = new Date().toISOString();
  }
  updatePersistentManifest(metadata, updates);
  try {
    writeWorkflowSummary(metadata, nextAction);
  } catch {
    // SUMMARY.md is command-owned and optional; final status has already been validated and persisted.
  }
  return stateCommandBase(metadata, {
    ok: true,
    status: validation.status,
    currentPhase: 'final',
    finalResponse,
    fixedIssueIds: validation.fixedIssueIds,
    nextAction
  });
}

function runFixLifecycleCommand(parsed, options) {
  if (parsed.subcommand === 'begin-fix') return runBeginFix(parsed, options);
  if (parsed.subcommand === 'refresh-lock') return runRefreshLock(parsed, options);
  if (parsed.subcommand === 'end-fix') return runEndFix(parsed, options);
  if (parsed.subcommand === 'abort-fix') return runAbortFix(parsed, options);
  fail('ERR_WORKFLOW_COMMAND', `unsupported fix lifecycle command: ${parsed.subcommand}`);
}

function resumeStateValidationFailure(parsed, options, error) {
  let base;
  try {
    base = workflowBase(parsed, options);
  } catch {
    base = {
      targetStateDir: null,
      targetKey: null,
      manifestPath: null,
      ledgerPath: null,
      round: null,
      documentType: 'none',
      strictness: 'none',
      requestedMode: null,
      mode: null,
      modeSource: null,
      modeNormalizedFrom: null,
      requestedAssurance: null,
      assuranceSource: null,
      assuranceNormalizedFrom: null,
      assurance: null,
      runtimePlatform: null
    };
  }
  let targetStateDir = null;
  if (base.targetKey) {
    try {
      targetStateDir = targetStateDirectory(resolveProjectRoot({
        explicitRoot: parsed.invocation.root,
        targetPath: parsed.invocation.target,
        cwd: options.cwd || process.cwd(),
        persistentStateRequired: true
      }), base.targetKey);
    } catch {
      targetStateDir = null;
    }
  }
  return {
    ...base,
    ok: false,
    status: 'blocked',
    targetStateDir,
    manifestPath: targetStateDir ? path.join(targetStateDir, 'MANIFEST.md') : null,
    ledgerPath: null,
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    errorCode: error && error.code ? error.code : 'ERR_STATE_VALIDATION_FAILED',
    message: error && error.message ? error.message : String(error),
    nextAction: 'repair target state before resuming'
  };
}

function readOptionalContinuity(targetStateDir) {
  const continuityPath = path.join(targetStateDir, 'CONTINUITY.md');
  if (!fs.existsSync(continuityPath)) return null;
  try {
    const text = fs.readFileSync(continuityPath, 'utf8');
    if (text.includes('\0')) return 'malformed-continuity-ignored';
  } catch {
    return 'malformed-continuity-ignored';
  }
  return null;
}

function currentProofForResume(parsed) {
  if (parsed.assurance !== 'strict-verified' || !parsed.proofRunId) return null;
  return `capability-descriptor:${descriptorPlatformFor(parsed.runtimePlatform)}:${parsed.proofRunId}`;
}

function resumeRequiresReceipt(status) {
  return [
    'blocked',
    'checkpoint',
    'unsupported',
    'externally-changed',
    'possible-target-replacement',
    'read-only-findings',
    'stopped-with-deferrals'
  ].includes(status);
}

function writeResumeReceipt(metadata, resumeState, nextAction) {
  return writeRoundReceipt({
    projectRoot: metadata.projectRoot,
    targetKey: metadata.targetKey,
    round: Number(metadata.manifest.currentRound || 1),
    kind: `resume-${resumeState.status}`,
    status: resumeState.status,
    target: metadata.normalizedTarget,
    issueIds: [],
    filesChanged: 'none',
    verification: 'resume state validation',
    blockingReason: resumeState.blockingReason || 'none',
    statusReason: resumeState.statusReason || 'none',
    summary: resumeState.conflict
      ? `${resumeState.conflict.field} conflict`
      : (resumeState.strictProofError || 'resume state selected deterministic phase'),
    nextAction
  });
}

function runPersistentResume(parsed, options) {
  let metadata;
  try {
    metadata = resolvePersistentMetadata(parsed, options);
  } catch (error) {
    return resumeStateValidationFailure(parsed, options, error);
  }

  const continuityWarning = readOptionalContinuity(metadata.targetStateDir);
  try {
    readResumeDeterministicInputs(metadata);
  } catch (error) {
    return stateValidationResult(metadata.targetStateDir, error);
  }
  let resumeState;
  try {
    resumeState = validateResumeState({
      manifest: metadata.manifest,
      currentFingerprint: computeFingerprint(parsed.invocation.target),
      requestedStrictness: parsed.strictnessExplicit ? parsed.invocation.strictness : null,
      requestedMode: parsed.invocation.modeSource === 'explicit' ? parsed.invocation.mode : null,
      currentProof: currentProofForResume(parsed)
    });
  } catch (error) {
    return stateValidationResult(metadata.targetStateDir, error);
  }

  const nextAction = resumeState.status === 'review'
    ? 'run workflow context for review'
    : (resumeState.status === 'externally-changed'
      ? 'confirm external edits before restarting review'
      : (resumeState.status === 'possible-target-replacement'
        ? 'confirm same-path target replacement before continuing'
        : (resumeState.status === 'unsupported'
          ? 'rerun with practical assurance or provide current strict proof'
          : 'continue from manifest current phase')));

  if (
    resumeState.status !== metadata.manifest.status ||
    resumeState.currentPhase !== metadata.manifest.currentPhase ||
    resumeState.assurance !== metadata.manifest.assurance ||
    resumeState.mode !== metadata.manifest.mode ||
    resumeState.statusReason !== metadata.manifest.statusReason ||
    resumeState.blockingReason !== metadata.manifest.blockingReason ||
    resumeState.lastPassedContentSha256 !== metadata.manifest.lastPassedContentSha256
  ) {
    if (resumeRequiresReceipt(resumeState.status)) {
      try {
        writeResumeReceipt(metadata, resumeState, nextAction);
      } catch (error) {
        return receiptFailureResult(metadata, error);
      }
    }
    updatePersistentManifest(metadata, {
      status: resumeState.status,
      currentPhase: resumeState.currentPhase,
      mode: resumeState.mode,
      assurance: resumeState.assurance,
      descriptorPlatform: resumeState.descriptorPlatform,
      assuranceProof: resumeState.assuranceProof,
      runtimeSubagentProbe: resumeState.runtimeSubagentProbe,
      runtimeSubagentProbeEvidence: resumeState.runtimeSubagentProbeEvidence,
      runtimeStdinHandoff: resumeState.runtimeStdinHandoff,
      runtimeStdinHandoffEvidence: resumeState.runtimeStdinHandoffEvidence,
      runtimeDowngradeReason: resumeState.runtimeDowngradeReason,
      blockingReason: resumeState.blockingReason || 'none',
      statusReason: resumeState.statusReason || 'none',
      lastKnownContentSha256: resumeState.lastKnownContentSha256 || metadata.manifest.lastKnownContentSha256,
      lastPassedContentSha256: resumeState.lastPassedContentSha256 || metadata.manifest.lastPassedContentSha256,
      fileSize: resumeState.fileSize || metadata.manifest.fileSize
    });
  }
  try {
    writeWorkflowSummary(metadata, nextAction);
  } catch {
    // Optional derived summary must not influence deterministic resume phase selection.
  }

  const ok = !['blocked', 'unsupported', 'externally-changed', 'possible-target-replacement', 'checkpoint'].includes(
    resumeState.status
  );
  return stateCommandBase(metadata, {
    ok,
    status: resumeState.status,
    currentPhase: resumeState.currentPhase,
    blockingReason: resumeState.blockingReason || 'none',
    statusReason: resumeState.statusReason || 'none',
    strictProofError: resumeState.strictProofError || null,
    stalePass: Boolean(resumeState.stalePass),
    requiresFullReview: Boolean(resumeState.requiresFullReview),
    requiresUserDecision: Boolean(resumeState.requiresUserDecision),
    conflict: resumeState.conflict || null,
    continuityWarning,
    nextAction
  });
}

function validateStrictProof(parsed, options) {
  const expectedPlatform = descriptorPlatformFor(parsed.runtimePlatform);
  const descriptorPath = parsed.capabilityDescriptor;
  const proofRunId = parsed.proofRunId;
  const descriptorDirectory = options.descriptorDirectory || parsed.descriptorDirectory;

  if (!descriptorDirectory) return { ok: false, reason: 'descriptorDirectory binding is required' };
  if (!path.isAbsolute(descriptorPath)) return { ok: false, reason: 'descriptor path must be absolute' };
  if (!path.isAbsolute(descriptorDirectory)) return { ok: false, reason: 'descriptorDirectory must be absolute' };
  if (path.basename(descriptorPath) !== `${expectedPlatform}.json`) {
    return { ok: false, reason: `descriptor basename must be ${expectedPlatform}.json` };
  }
  try {
    const descriptorReal = fs.realpathSync.native(descriptorPath);
    const directoryReal = fs.realpathSync.native(descriptorDirectory);
    const relative = path.relative(directoryReal, descriptorReal);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, reason: 'descriptor must be inside descriptorDirectory' };
    }
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  let descriptor;
  try {
    descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const validation = validateCurrentDescriptor(descriptor, {
    packageVersion: options.packageVersion || readPackageVersion(),
    platform: expectedPlatform,
    runId: proofRunId,
    requireVerified: true
  });
  if (
    validation.valid !== true ||
    validation.trusted !== true ||
    validation.passCapable !== true ||
    validation.errors.length !== 0
  ) {
    return { ok: false, reason: validation.errors.join('; ') || validation.advisoryReason, validation };
  }

  return { ok: true, validation };
}

async function runWorkflowCommand(subcommand, args, options = {}) {
  const parsed = parseWorkflowArgs(subcommand, args);

  if (TARGET_STATE_SUBCOMMANDS.has(parsed.subcommand)) {
    return runFixLifecycleCommand(parsed, options);
  }
  if (parsed.subcommand === 'record-diff-review') return runRecordDiffReview(parsed, options);
  if (parsed.subcommand === 'finalize' && !parsed.noState && parsed.targetStateDir) {
    return runPersistentFinalize(parsed, options);
  }

  if (parsed.noState) {
    return runNoStateWorkflowCommand(parsed, options);
  }

  if (parsed.runtimeCheck.stdinHandoff.status === 'unavailable') {
    return blockedFrom(parsed, 'unsafe-handoff-file', options);
  }

  if (parsed.assurance === 'strict-verified' && parsed.runtimePlatform === 'gemini') {
    return unsupportedFrom(parsed, 'unsupported-runtime-capability', null, options);
  }

  if (parsed.assurance === 'strict-verified') {
    const proof = validateStrictProof(parsed, options);
    if (!proof.ok) {
      return unsupportedFrom(parsed, 'strict-proof-validation-failed', {
        reason: proof.reason,
        validation: proof.validation || null
      }, options);
    }
  }

  if (parsed.assurance === 'advisory' && parsed.invocation.mode === 'review-and-fix') {
    if (isRuntimeDowngrade(parsed)) return withReadOnlyMode(workflowBase(parsed, options));
    return unsupportedFrom(parsed, 'advisory-review-and-fix-unsupported', null, options);
  }

  if (parsed.subcommand === 'start' && parsed.invocation.resume) return runPersistentResume(parsed, options);
  if (parsed.subcommand === 'context') return runPersistentContext(parsed, options);
  if (parsed.subcommand === 'record-review') return runPersistentRecordReview(parsed, options);
  if (parsed.subcommand === 'record-triage') return runPersistentRecordTriage(parsed, options);

  return workflowBase(parsed, options);
}

function formatWorkflowJson(result) {
  const base = workflowJson(result);
  const extra = {};
  for (const key of [
    'lockOwnerId',
    'leaseId',
    'leaseExpiresAt',
    'refreshAfterSeconds',
    'fixGuardReportPath',
    'fixReportPath',
    'fixedIssueIds',
    'currentPhase',
    'diffReviewReportPath',
    'finalResponse',
    'stalePass',
    'requiresFullReview',
    'requiresUserDecision',
    'conflict',
    'continuityWarning',
    'receiptPath',
    'originalBlockingReason'
  ]) {
    if (Object.hasOwn(result || {}, key)) extra[key] = result[key];
  }
  return `${JSON.stringify({ ...base, ...extra })}\n`;
}

function formatWorkflowError({
  error,
  targetKey = null,
  targetStateDir = null,
  manifestPath = null,
  runtimeCheck = null,
  blockingReason = null,
  statusReason = null,
  status = 'blocked',
  nextAction = null
} = {}) {
  const message = error && error.message ? error.message : String(error);
  return {
    ok: false,
    status,
    errorCode: error && error.code ? error.code : 'ERR_WORKFLOW',
    message,
    targetKey,
    targetStateDir,
    manifestPath,
    runtimeCheck,
    blockingReason: blockingReason || (status === 'blocked' ? 'state-validation-failed' : 'none'),
    statusReason: statusReason || 'none',
    nextAction
  };
}

module.exports = {
  runWorkflowCommand,
  parseWorkflowArgs,
  formatWorkflowJson,
  formatWorkflowError
};
