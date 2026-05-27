'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { validateCurrentDescriptor } = require('../capability');
const { parseInvocation } = require('../input');
const {
  deriveTargetKey,
  resolveProjectRoot
} = require('../target-state');
const {
  BLOCKING_REASONS,
  workflowJson
} = require('../workflow-state');
const { runFixLifecycleCommand } = require('./fix-lifecycle');
const { runRecordDiffReview } = require('./diff-review');
const {
  runPersistentFinalize,
  runPersistentResume
} = require('./finalize');
const { runNoStateWorkflowCommand, runWriteEligibilityPreflight } = require('./no-state');
const {
  runPersistentContext,
  runPersistentRecordReview,
  runPersistentRecordTriage
} = require('./persistent-context');
const { runPersistentStart } = require('./start');

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
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
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
  if (subcommand === 'preflight' && !flags.noState) {
    if (
      !['codex', 'claude-code'].includes(flags.runtimePlatform) ||
      flags.runtimeSubagentProbe !== 'not-required' ||
      flags.runtimeStdinHandoff !== 'not-required'
    ) {
      fail(
        'ERR_PREFLIGHT_RUNTIME',
        'write eligibility preflight requires codex or claude-code with not-required runtime checks'
      );
    }
    return;
  }

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

  if (parsed.subcommand === 'preflight' && !parsed.noState) {
    return runWriteEligibilityPreflight(parsed, options);
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
  if (parsed.subcommand === 'start' && parsed.invocation.mode === 'review-and-fix') {
    return runPersistentStart(parsed, options);
  }
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
