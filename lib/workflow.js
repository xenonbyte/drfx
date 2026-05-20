'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { validateCurrentDescriptor } = require('./capability');
const { buildContextPack, writeContextManifest } = require('./context-pack');
const { parseInvocation } = require('./input');
const {
  applyTriageDecisions,
  formatLedger,
  parseLedger
} = require('./ledger');
const { mergeRules, parseRulebook } = require('./rulebook');
const {
  computeFingerprint,
  deriveTargetKey,
  normalizeReferences,
  readManifestAny,
  resolveProjectRoot
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
  parseFinalResponseBlock,
  parseTriageResult,
  readSemanticPayload
} = require('./semantic-parsers');
const {
  atomicWriteFile,
  BLOCKING_REASONS,
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

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
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

function statePathFromManifest(projectRoot, targetStateDir, storedPath, fallbackName) {
  if (!storedPath || storedPath === 'none') return path.join(targetStateDir, fallbackName);
  return path.isAbsolute(storedPath) ? storedPath : path.resolve(projectRoot, storedPath);
}

function targetStatePathFromManifest(targetStateDir, storedPath, fallbackName) {
  if (!storedPath || storedPath === 'none') return path.join(targetStateDir, fallbackName);
  return path.isAbsolute(storedPath) ? storedPath : path.join(targetStateDir, storedPath);
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
  return path.join(targetStateDir, 'context', fileName);
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
  const reportsDir = path.join(targetStateDir, 'reports');
  const basePath = path.join(reportsDir, `${baseName}.md`);
  if (!fs.existsSync(basePath)) return basePath;
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const attemptPath = path.join(reportsDir, `${baseName}-attempt-${padRound(attempt)}.md`);
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
    return 'reviewer-mutated-file';
  }
  return null;
}

function reviewerFindingsById(reviewerReport) {
  const findings = reviewerReport && reviewerReport.normalized && Array.isArray(reviewerReport.normalized.findings)
    ? reviewerReport.normalized.findings
    : [];
  return new Map(findings.map((finding) => [finding.id, finding]));
}

function enrichTriageDecisions(triage, reviewerReport) {
  const findings = reviewerFindingsById(reviewerReport);
  return triage.decisions.map((decision) => {
    const finding = findings.get(decision.reviewer_id);
    if (!finding) fail('ERR_TRIAGE_REVIEWER_ID', `triage reviewer_id not found in reviewer report: ${decision.reviewer_id}`);
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
  return { status: 'read-only-clean', currentPhase: 'final', statusReason: 'none' };
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
  const finalResponse = parseFinalResponseBlock(payload);
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
  return {
    ...workflowBase(parsed, { cwd: metadata.projectRoot }),
    targetStateDir: metadata.targetStateDir,
    manifestPath: metadata.manifestPath,
    ledgerPath: statePathFromManifest(
      metadata.projectRoot,
      metadata.targetStateDir,
      metadata.manifest.ledgerPath,
      'ISSUES.md'
    ),
    round: Number(metadata.manifest.currentRound || 1),
    ...overrides
  };
}

function runPersistentContext(parsed, options) {
  const metadata = resolvePersistentMetadata(parsed, options);
  const phase = contextPhase(parsed, metadata.manifest);
  const round = Number(metadata.manifest.currentRound || 1);
  const guard = guardBaselineFor(parsed, metadata);
  const ledgerPath = statePathFromManifest(
    metadata.projectRoot,
    metadata.targetStateDir,
    metadata.manifest.ledgerPath,
    'ISSUES.md'
  );
  const mergedRules = loadMergedRules({
    projectRoot: metadata.projectRoot,
    documentType: metadata.manifest.documentType,
    homeDir: options.homeDir || null
  });
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
    acceptedNonBlockingLowIssueIds: acceptedNonBlockingLowIssueIdsFromLedger(readLedgerIfPresent(ledgerPath)),
    requiredOutputSchema: requiredSchemaForPhase(phase),
    reviewerGuardBaseline: guard.reviewerGuardBaseline,
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

function runPersistentRecordReview(parsed, options) {
  const metadata = resolvePersistentMetadata(parsed, options);
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
}

function runPersistentRecordTriage(parsed, options) {
  const metadata = resolvePersistentMetadata(parsed, options);
  const phase = parsed.phase || 'initial-review';
  const round = Number(metadata.manifest.currentRound || 1);
  const reviewerReportPath = targetStatePathFromManifest(
    metadata.targetStateDir,
    metadata.manifest.lastReviewerReportPath,
    path.join('reports', `reviewer-round-${padRound(round)}.md`)
  );
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
  const ledgerPath = statePathFromManifest(
    metadata.projectRoot,
    metadata.targetStateDir,
    metadata.manifest.ledgerPath,
    'ISSUES.md'
  );
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

  if (parsed.subcommand === 'context') return runPersistentContext(parsed, options);
  if (parsed.subcommand === 'record-review') return runPersistentRecordReview(parsed, options);
  if (parsed.subcommand === 'record-triage') return runPersistentRecordTriage(parsed, options);

  return workflowBase(parsed, options);
}

function formatWorkflowJson(result) {
  return `${JSON.stringify(workflowJson(result))}\n`;
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
