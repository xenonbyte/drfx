'use strict';

const {
  parseWorkflowArgs,
  formatWorkflowJson,
  formatWorkflowError,
  blockedFrom,
  unsupportedFrom,
  validateStrictProof,
  isRuntimeDowngrade,
  withReadOnlyMode,
  workflowBase
} = require('./shared');
const {
  runBeginFix,
  runRefreshLock,
  runEndFix,
  runAbortFix,
  runFixLifecycleCommand
} = require('./fix-lifecycle');
const { runRecordDiffReview } = require('./diff-review');
const {
  runPersistentFinalize,
  runPersistentResume
} = require('./finalize');
const {
  runNoStatePreflight,
  runWriteEligibilityPreflight,
  runNoStateContext,
  runNoStateRecordReview,
  runNoStateRecordTriage,
  runNoStateFinalize,
  runNoStateWorkflowCommand
} = require('./no-state');
const {
  runPersistentContext,
  runPersistentRecordReview,
  runPersistentRecordTriage
} = require('./persistent-context');
const { runPersistentStart } = require('./start');

const TARGET_STATE_SUBCOMMANDS = new Set(['begin-fix', 'refresh-lock', 'end-fix', 'abort-fix']);

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

module.exports = {
  formatWorkflowError,
  formatWorkflowJson,
  parseWorkflowArgs,
  runWorkflowCommand
};
