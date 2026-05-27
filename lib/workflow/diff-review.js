'use strict';

const {
  assertDiffReviewEligible,
  parseDiffReview,
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

module.exports = {
  runRecordDiffReview
};
