'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { codeExcludedDirectoryEntries, computeFileSetFingerprint, resolveCodeInventory } = require('../target-context');
const { readUnitsPlan } = require('./file-set-unit-review');

function readPartitionedPlanIfPresent(metadata) {
  if (metadata.routeKind !== 'code') return null;
  const planPath = path.join(metadata.targetStateDir, 'project-review', 'units.json');
  if (!fs.existsSync(planPath)) return null;
  return readUnitsPlan(metadata.targetStateDir);
}

function isActivePartitionedPlan(metadata, plan) {
  return String(metadata.manifest.fileSetFingerprint || '') === String(plan.projectReviewFingerprint || '');
}

function readActivePartitionedPlan(metadata) {
  const plan = readPartitionedPlanIfPresent(metadata);
  if (!plan || !isActivePartitionedPlan(metadata, plan)) return null;
  return plan;
}

async function activePartitionedPlanFreshness(metadata, options = {}) {
  const plan = readActivePartitionedPlan(metadata);
  if (!plan) return null;
  const inventoryResult = await resolveCodeInventory({
    cwd: metadata.projectRoot,
    scopes: [],
    commandLog: options.commandLog
  });
  const expected = String(plan.projectReviewFingerprint || '');
  const actual = String(inventoryResult.projectReviewFingerprint || '');
  return { plan, inventoryResult, stale: expected !== actual, expected, actual };
}

async function resolveActivePartitionedLiveFileSet(metadata, options = {}) {
  const freshness = await activePartitionedPlanFreshness(metadata, options);
  if (!freshness) return null;
  return {
    routeKind: 'code',
    normalizedScopes: [],
    exclusions: codeExcludedDirectoryEntries(),
    userExcludes: Array.isArray(freshness.inventoryResult.userExcludes) ? freshness.inventoryResult.userExcludes : [],
    files: freshness.inventoryResult.inventory,
    projectReviewFingerprint: freshness.actual
  };
}

function liveFileSetFingerprint(liveFileSet) {
  if (liveFileSet && liveFileSet.projectReviewFingerprint) {
    return liveFileSet.projectReviewFingerprint;
  }
  // r2q persists its fileSetFingerprint over requirementDir-relative doc names (the
  // 03–07 chain), while the fix-path live set carries project-root-relative member paths
  // for the on-disk guard. Re-key to the requirementDir-relative names here so the live
  // fingerprint matches the persisted r2q identity instead of drifting on path shape.
  if (liveFileSet && liveFileSet.routeKind === 'r2q') {
    const fingerprintFiles = (Array.isArray(liveFileSet.files) ? liveFileSet.files : []).map((file) => ({
      path: file.requirementRelativePath || file.path,
      status: file.status,
      contentId: file.contentId
    }));
    return computeFileSetFingerprint(fingerprintFiles);
  }
  return computeFileSetFingerprint(liveFileSet.files);
}

module.exports = {
  activePartitionedPlanFreshness,
  liveFileSetFingerprint,
  readActivePartitionedPlan,
  resolveActivePartitionedLiveFileSet
};
