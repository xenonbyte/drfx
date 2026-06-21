'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CODE_EXCLUDED_DIRECTORIES, computeFileSetFingerprint, resolveCodeInventory } = require('../target-context');
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
    exclusions: [...CODE_EXCLUDED_DIRECTORIES].sort(),
    userExcludes: Array.isArray(freshness.inventoryResult.userExcludes) ? freshness.inventoryResult.userExcludes : [],
    files: freshness.inventoryResult.inventory,
    projectReviewFingerprint: freshness.actual
  };
}

function liveFileSetFingerprint(liveFileSet) {
  return liveFileSet && liveFileSet.projectReviewFingerprint
    ? liveFileSet.projectReviewFingerprint
    : computeFileSetFingerprint(liveFileSet.files);
}

module.exports = {
  activePartitionedPlanFreshness,
  liveFileSetFingerprint,
  resolveActivePartitionedLiveFileSet
};
