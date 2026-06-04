'use strict';

const {
  assertDiffReviewEligible,
  atomicWriteFile,
  formatLedger,
  parseDiffReview,
  readLedgerIfPresent,
  readStateCommandPayload,
  receiptFailureResult,
  resolveStateCommandMetadata,
  stateCommandBase,
  stateRelativePath,
  stateValidationResult,
  updatePersistentManifest,
  writeDiffReviewReport,
  writeFinalReceipt
} = require('./helpers');

function reopenDiffFailedIssues(metadata, diffReview) {
  const failedIds = new Set((diffReview.findings || []).map((finding) => finding.issue_id));
  if (failedIds.size === 0) return;
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const nextLedger = {
    issues: (ledger.issues || []).map((issue) => {
      if (!failedIds.has(issue.id) || issue.status !== 'fixed') return issue;
      const finding = (diffReview.findings || []).find((item) => item.issue_id === issue.id);
      return {
        ...issue,
        status: 'reopened',
        resolution: `Reopened by diff review: ${finding ? finding.problem : 'diff review failed'}`
      };
    })
  };
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
}

function roundLimitReached(metadata) {
  const rawLimit = metadata.manifest.roundLimit || 'none';
  if (rawLimit === 'none') return false;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return false;
  return Number(metadata.manifest.fixAttemptCount || 0) >= limit;
}

function deferRoundLimitedFindings(metadata) {
  const roundLimit = Number(metadata.manifest.roundLimit);
  const reason = `Round limit reached (rounds=${roundLimit}); deferred for manual follow-up`;
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const nextLedger = {
    issues: (ledger.issues || []).map((issue) => {
      const blocking = ['accepted', 'reopened'].includes(issue.status) &&
        ['high', 'medium'].includes(issue.severity);
      if (!blocking) return issue;
      return { ...issue, status: 'deferred', resolution: `Deferred: ${reason}; owner: none` };
    })
  };
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
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
      valueFlag: 'result',
      stdinFlag: 'resultStdin',
      label: 'diff review',
      aliasValueFlag: 'diffReview',
      aliasStdinFlag: 'diffReviewStdin',
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
    try {
      reopenDiffFailedIssues(metadata, diffReview);
    } catch (error) {
      return receiptFailureResult(metadata, error);
    }
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

    if (roundLimitReached(metadata)) {
      try {
        deferRoundLimitedFindings(metadata);
      } catch (error) {
        return receiptFailureResult(metadata, error);
      }
      updatePersistentManifest(metadata, {
        status: 'stopped-with-deferrals',
        currentPhase: 'final',
        blockingReason: 'none',
        statusReason: 'round-limit',
        currentReportPath: relativeReportPath,
        lastDiffReviewReportPath: relativeReportPath
      });
      return stateCommandBase(metadata, {
        ok: true,
        status: 'recorded-diff-review',
        currentPhase: 'final',
        diffReviewReportPath: reportPath,
        normalized: diffReview,
        stopReason: 'round-limit',
        roundLimit: Number(metadata.manifest.roundLimit),
        nextAction: 'round limit reached; review deferred findings manually'
      });
    }

    updatePersistentManifest(metadata, {
      status: 'fix',
      currentPhase: 'fix',
      currentRound: Number(metadata.manifest.currentRound || 1) + 1,
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

module.exports = {
  runRecordDiffReview
};
