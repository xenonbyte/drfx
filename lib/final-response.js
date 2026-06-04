'use strict';

const { BLOCKING_REASONS, STATUS_REASONS } = require('./workflow-state');

const PASS_ASSURANCES = new Set(['practical', 'strict-verified']);
const NO_STATE_FINAL_STATUSES = new Set(['read-only-clean', 'read-only-findings', 'unsupported', 'blocked']);
const READ_ONLY_FINAL_STATUSES = new Set(['read-only-clean', 'read-only-findings']);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizeIssueIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
  const text = String(value || 'none').trim();
  if (text === 'none') return [];
  return [...new Set(text.split(',').map((item) => item.trim()).filter(Boolean))].sort();
}

function sameStringSet(left, right) {
  const a = normalizeIssueIds(left);
  const b = normalizeIssueIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isNone(value) {
  return value === undefined || value === null || String(value).trim() === '' || value === 'none';
}

function assertAllowedPairing(finalResponse) {
  const status = finalResponse.finalStatus;
  const blockingReason = finalResponse.blockingReason || 'none';
  const statusReason = finalResponse.statusReason || 'none';
  if (!BLOCKING_REASONS.includes(blockingReason)) {
    fail('ERR_FINAL_BLOCKING_REASON', `invalid Blocking reason: ${blockingReason}`);
  }
  if (!STATUS_REASONS.includes(statusReason)) {
    fail('ERR_FINAL_STATUS_REASON', `invalid Status reason: ${statusReason}`);
  }

  if (status === 'blocked') {
    if (blockingReason === 'none') {
      fail('ERR_FINAL_BLOCKER_PAIRING', 'blocked final response requires non-none Blocking reason');
    }
    if (statusReason !== 'none') {
      fail('ERR_FINAL_BLOCKER_PAIRING', 'blocked final response requires Status reason: none');
    }
    return;
  }

  if (blockingReason !== 'none') {
    fail('ERR_FINAL_BLOCKER_PAIRING', 'non-blocked final response requires Blocking reason: none');
  }
}

function assertMatchesState(finalResponse, state) {
  if (!state) return;
  if (state.target && finalResponse.target && finalResponse.target !== state.target) {
    fail('ERR_FINAL_TARGET_MISMATCH', 'final response target does not match workflow state');
  }
  if (state.assurance && finalResponse.assurance && finalResponse.assurance !== state.assurance) {
    fail('ERR_FINAL_ASSURANCE_MISMATCH', 'final response assurance does not match workflow state');
  }
  if (state.runtimePlatform && finalResponse.runtimePlatform && finalResponse.runtimePlatform !== state.runtimePlatform) {
    fail('ERR_FINAL_RUNTIME_MISMATCH', 'final response runtime platform does not match workflow state');
  }
  if (state.mode && finalResponse.mode && finalResponse.mode !== state.mode) {
    fail('ERR_FINAL_MODE_MISMATCH', 'final response mode does not match workflow state');
  }
  if (Object.hasOwn(state, 'fixedIssueIds') && !sameStringSet(finalResponse.fixedIssueIds, state.fixedIssueIds)) {
    fail('ERR_FINAL_FIXED_IDS_MISMATCH', 'final response fixed issue IDs do not match workflow state');
  }
  if (state.filesChanged && finalResponse.filesChanged && finalResponse.filesChanged !== state.filesChanged) {
    fail('ERR_FINAL_FILES_CHANGED_MISMATCH', 'final response files changed do not match workflow state');
  }
}

function validatePass(finalResponse, state) {
  if (!state || !state.persistent || state.noState) {
    fail('ERR_FINAL_PASS_STATE', 'persistent state is required for pass');
  }
  if (finalResponse.mode === 'read-only' || state.mode === 'read-only') {
    fail('ERR_FINAL_READ_ONLY_PASS', 'read-only finalization cannot pass');
  }
  if (finalResponse.assurance === 'advisory' || state.assurance === 'advisory') {
    fail('ERR_FINAL_ADVISORY_PASS', 'advisory assurance cannot pass');
  }
  if (finalResponse.mode !== 'review-and-fix' || state.mode !== 'review-and-fix') {
    fail('ERR_FINAL_PASS_MODE', 'pass requires review-and-fix mode');
  }
  if (!PASS_ASSURANCES.has(finalResponse.assurance) || !PASS_ASSURANCES.has(state.assurance)) {
    fail('ERR_FINAL_PASS_ASSURANCE', 'pass requires practical or strict-verified assurance');
  }
  if (state.requiredDiffReviewComplete !== true) {
    fail('ERR_FINAL_DIFF_REVIEW_REQUIRED', 'pass requires required diff review after fix');
  }
  if (state.requiredFullReReviewComplete !== true) {
    fail('ERR_FINAL_FULL_REVIEW_REQUIRED', 'pass requires required full re-review after fix');
  }
  const unresolved = Array.isArray(state.unresolvedBlockingIssues) ? state.unresolvedBlockingIssues : [];
  if (unresolved.length > 0) {
    fail('ERR_FINAL_UNRESOLVED_BLOCKING', `pass rejects unresolved accepted high/medium issues: ${unresolved.join(', ')}`);
  }
  const deferred = normalizeIssueIds(state.deferredBlockingIssueIds || []);
  if (deferred.length > 0) {
    fail('ERR_FINAL_DEFERRED_BLOCKING', `pass rejects deferred high/medium findings: ${deferred.join(', ')}`);
  }
  const acceptedLowIds = normalizeIssueIds(state.acceptedNonBlockingLowIssueIds || []);
  if (
    state.strictness === 'strict' &&
    acceptedLowIds.length > 0 &&
    state.strictAcceptedLowIncludedInLatestFullReview !== true
  ) {
    fail(
      'ERR_FINAL_STRICT_LOW_CONTEXT',
      'strict accepted non-blocking low issue IDs require latest full re-review context inclusion'
    );
  }
  if (isNone(finalResponse.coordinatorAgreement)) {
    fail('ERR_FINAL_COORDINATOR_AGREEMENT', 'pass requires coordinator agreement');
  }
}

function validateReadOnly(finalResponse, state) {
  if (finalResponse.finalStatus === 'pass') return;
  const stateMode = state && state.mode;
  if (stateMode === 'read-only' || READ_ONLY_FINAL_STATUSES.has(finalResponse.finalStatus)) {
    if (finalResponse.filesChanged !== 'none') {
      fail('ERR_FINAL_READ_ONLY_CHANGED_FILES', 'read-only finalization requires Files changed: none');
    }
  }
  if (state && state.persistent && READ_ONLY_FINAL_STATUSES.has(finalResponse.finalStatus)) {
    const blockingIssueIds = normalizeIssueIds([
      ...(Array.isArray(state.readOnlyBlockingIssueIds) ? state.readOnlyBlockingIssueIds : []),
      ...(Array.isArray(state.unresolvedBlockingIssues) ? state.unresolvedBlockingIssues : [])
    ]);
    const findingsIssueIds = Object.hasOwn(state, 'readOnlyFindingsIssueIds')
      ? normalizeIssueIds(state.readOnlyFindingsIssueIds)
      : blockingIssueIds;
    const deferredIssueIds = normalizeIssueIds(state.deferredBlockingIssueIds || []);
    if (finalResponse.finalStatus === 'read-only-clean' && blockingIssueIds.length > 0) {
      fail(
        'ERR_FINAL_READ_ONLY_CLEAN_BLOCKING',
        `read-only-clean rejects blocking findings or issues: ${blockingIssueIds.join(', ')}`
      );
    }
    if (finalResponse.finalStatus === 'read-only-findings' && deferredIssueIds.length > 0) {
      fail(
        'ERR_FINAL_READ_ONLY_FINDINGS_DEFERRED',
        `read-only-findings rejects deferred high/medium findings; use stopped-with-deferrals: ${deferredIssueIds.join(', ')}`
      );
    }
    if (finalResponse.finalStatus === 'read-only-findings' && findingsIssueIds.length === 0) {
      fail(
        'ERR_FINAL_READ_ONLY_FINDINGS_EMPTY',
        'read-only-findings requires accepted, reopened, or downgraded high/medium findings'
      );
    }
  }
  if (state && state.persistent && finalResponse.finalStatus === 'stopped-with-deferrals') {
    const deferredIssueIds = normalizeIssueIds(state.deferredBlockingIssueIds || []);
    if ((finalResponse.blockingReason || 'none') !== 'none') {
      fail('ERR_FINAL_DEFERRED_BLOCKING_REASON', 'stopped-with-deferrals requires Blocking reason: none');
    }
    // A round-limit stop (PLAN-TASK-005) is a deferral driven by the rounds=<n>
    // maximum rather than an explicit per-finding deferral, so it carries its own
    // durable status reason. Both reasons still require genuinely deferred findings.
    if (!['deferred-findings', 'round-limit'].includes(finalResponse.statusReason)) {
      fail(
        'ERR_FINAL_DEFERRED_STATUS_REASON',
        'stopped-with-deferrals requires Status reason: deferred-findings or round-limit'
      );
    }
    if (deferredIssueIds.length === 0) {
      fail('ERR_FINAL_DEFERRED_FINDINGS_EMPTY', 'stopped-with-deferrals requires deferred high/medium findings');
    }
  }
  if (state && state.persistent && finalResponse.finalStatus === 'stopped-no-progress') {
    const unresolvedIssueIds = normalizeIssueIds(state.unresolvedBlockingIssues || []);
    const deferredIssueIds = normalizeIssueIds(state.deferredBlockingIssueIds || []);
    if (state.mode !== 'review-and-fix' || finalResponse.mode !== 'review-and-fix') {
      fail(
        'ERR_FINAL_NO_PROGRESS_MODE',
        'stopped-no-progress requires review-and-fix mode; use read-only-findings for read-only blocking findings'
      );
    }
    if ((finalResponse.blockingReason || 'none') !== 'none') {
      fail('ERR_FINAL_NO_PROGRESS_BLOCKING_REASON', 'stopped-no-progress requires Blocking reason: none');
    }
    if (finalResponse.statusReason !== 'no-progress-detected') {
      fail('ERR_FINAL_NO_PROGRESS_STATUS_REASON', 'stopped-no-progress requires Status reason: no-progress-detected');
    }
    if (unresolvedIssueIds.length === 0 && deferredIssueIds.length > 0) {
      fail(
        'ERR_FINAL_NO_PROGRESS_DEFERRED_ONLY',
        `stopped-no-progress rejects deferred-only high/medium findings; use stopped-with-deferrals: ${deferredIssueIds.join(', ')}`
      );
    }
    if (unresolvedIssueIds.length === 0) {
      fail('ERR_FINAL_NO_PROGRESS_FINDINGS_EMPTY', 'stopped-no-progress requires unresolved high/medium findings');
    }
  }
}

function validateFinalResponse({ finalResponse, state = null } = {}) {
  if (!finalResponse || typeof finalResponse !== 'object') {
    fail('ERR_FINAL_RESPONSE', 'final response is required');
  }
  assertAllowedPairing(finalResponse);

  if (state && state.noState) {
    if (!NO_STATE_FINAL_STATUSES.has(finalResponse.finalStatus)) {
      fail('ERR_FINAL_NO_STATE_STATUS', `no-state finalization rejects ${finalResponse.finalStatus}`);
    }
    if (finalResponse.finalStatus === 'pass') {
      fail('ERR_FINAL_NO_STATE_PASS', 'no-state finalization cannot pass');
    }
  }

  if (finalResponse.finalStatus === 'pass') {
    validatePass(finalResponse, state);
  } else if (!isNone(finalResponse.coordinatorAgreement)) {
    fail('ERR_FINAL_COORDINATOR_AGREEMENT', 'coordinator agreement must be none unless Final status is pass');
  }

  validateReadOnly(finalResponse, state);
  assertMatchesState(finalResponse, state);

  return {
    status: finalResponse.finalStatus,
    fixedIssueIds: normalizeIssueIds(finalResponse.fixedIssueIds),
    finalResponse
  };
}

function validateResumeState({
  manifest,
  currentFingerprint,
  requestedStrictness = null,
  requestedMode = null,
  currentProof = null
} = {}) {
  if (!manifest || typeof manifest !== 'object') {
    fail('ERR_RESUME_STATE', 'manifest is required for resume');
  }
  if (requestedStrictness && requestedStrictness !== manifest.strictness) {
    return {
      ...manifest,
      status: 'checkpoint',
      currentPhase: manifest.currentPhase || 'final',
      conflict: { field: 'strictness', manifest: manifest.strictness, requested: requestedStrictness },
      statusReason: 'checkpoint-requested',
      blockingReason: 'none',
      requiresUserDecision: true
    };
  }
  if (requestedMode && requestedMode !== manifest.mode) {
    return {
      ...manifest,
      status: 'checkpoint',
      currentPhase: manifest.currentPhase || 'final',
      conflict: { field: 'mode', manifest: manifest.mode, requested: requestedMode },
      statusReason: 'checkpoint-requested',
      blockingReason: 'none',
      requiresUserDecision: true
    };
  }

  if (manifest.assurance === 'strict-verified' && currentProof !== manifest.assuranceProof) {
    return {
      ...manifest,
      status: 'unsupported',
      currentPhase: 'final',
      mode: 'read-only',
      assurance: 'advisory',
      descriptorPlatform: 'none',
      assuranceProof: 'none',
      runtimeSubagentProbe: 'not-required',
      runtimeSubagentProbeEvidence: 'none',
      runtimeStdinHandoff: 'not-required',
      runtimeStdinHandoffEvidence: 'none',
      runtimeDowngradeReason: 'none',
      blockingReason: 'none',
      statusReason: 'strict-proof-validation-failed',
      strictProofError: 'current strict proof is missing or stale'
    };
  }

  const currentSha256 = currentFingerprint && currentFingerprint.sha256;
  const currentSize = currentFingerprint && Number(currentFingerprint.size);
  if (manifest.status !== 'pass' && currentSha256 && currentSha256 !== manifest.lastKnownContentSha256) {
    if (currentSize && Number(manifest.fileSize) === currentSize) {
      return {
        ...manifest,
        status: 'possible-target-replacement',
        currentPhase: 'final',
        blockingReason: 'none',
        statusReason: 'same-path-replacement-suspected',
        requiresUserDecision: true
      };
    }
    return {
      ...manifest,
      status: 'externally-changed',
      currentPhase: 'final',
      blockingReason: 'none',
      statusReason: 'stale-fingerprint-mismatch',
      requiresFullReview: true
    };
  }

  return {
    ...manifest,
    blockingReason: manifest.blockingReason || 'none',
    statusReason: manifest.statusReason || 'none'
  };
}

function buildFinalResponseChecklist() {
  return [
    'Final response machine block checklist:',
    '- Include exactly one 14-line machine block.',
    '- Use pass only for persistent review-and-fix with practical or strict-verified assurance.',
    '- Do not use pass for advisory, read-only, or no-state finalization.',
    '- After any fix, complete diff review and full re-review before pass.',
    '- Resolve accepted high/medium issues before pass.',
    '- For blocked, use a non-none Blocking reason and Status reason: none.',
    '- For non-blocked statuses, use Blocking reason: none.',
    '- For stopped-no-progress, use Status reason: no-progress-detected and summarize unresolved high/medium findings.',
    '- `rollback-unavailable`: say the target lacks a clean rollback anchor; next action is to commit or restore the target, switch to read-only, or use `guard=snapshot` when appropriate.',
    '- `target-only-guard-unavailable`: say the target-only guard is unavailable or unparseable; next action is to restore guard inputs or rerun after guard data can be read.',
    '- `unexpected-worktree-change`: say non-target worktree changes make automatic fixing unsafe; next action is to commit, stash, or restore unrelated worktree changes before retrying.'
  ].join('\n');
}

module.exports = {
  buildFinalResponseChecklist,
  validateFinalResponse,
  validateResumeState
};
