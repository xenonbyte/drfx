'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseRunMdGate,
  activeArtifactsSection,
  isArchivedRequirementDir,
  isRequirementDirShape,
  resolveR2pWorkIdTarget,
  computeFileSetFingerprint
} = require('../lib/target-context');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A run.md where the plan stage is complete (status = closed_at_plan_checkpoint)
const planApprovedRunMd = `# Requirement Run

## Status
closed_at_plan_checkpoint

## Active Artifacts
- plan: approved
`;

// A run.md where the plan is shown as active in Active Artifacts (not closed)
const planActiveRunMd = `# Requirement Run

## Status
active_at_design_stage

## Active Artifacts
- plan: active
`;

// A run.md where plan is not yet generated
const planIncompleteRunMd = `# Requirement Run

## Status
active_at_spec_stage

## Active Artifacts
- spec: active
`;

// A run.md that has a Status section but plan is NOT present/approved
const planNotApprovedRunMd = `# Requirement Run

## Status
active_at_spec_stage

## Active Artifacts
- requirement: active
`;

// An unrecognized run.md (no Status section)
const garbageRunMd = 'garbage with no Status section';

// ---------------------------------------------------------------------------
// Helper: build a WF-* fixture directory under a per-test tmpdir sandbox
// ---------------------------------------------------------------------------

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const R2P_EDITABLE_DOCS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

function makeWfDir(root, name, opts = {}) {
  const {
    runMdContent = planApprovedRunMd,
    skipRunMd = false,
    runMdIsDirectory = false,
    runMdIsSymlink = false,
    docs = R2P_EDITABLE_DOCS,
    skipDoc = null,
    renameDoc = null, // { from, to }
    underArchive = false
  } = opts;

  const reqToPlanDir = path.join(root, '.req-to-plan');
  const parentDir = underArchive
    ? path.join(reqToPlanDir, 'archive')
    : reqToPlanDir;
  fs.mkdirSync(parentDir, { recursive: true });

  const wfDir = path.join(parentDir, name);
  fs.mkdirSync(wfDir, { recursive: true });

  // create run.md
  if (!skipRunMd) {
    const runMdPath = path.join(wfDir, 'run.md');
    if (runMdIsDirectory) {
      fs.mkdirSync(runMdPath);
    } else if (runMdIsSymlink) {
      const target = path.join(wfDir, '_run-md-target.md');
      fs.writeFileSync(target, runMdContent);
      fs.symlinkSync(target, runMdPath);
    } else {
      fs.writeFileSync(runMdPath, runMdContent);
    }
  }

  // create owner docs
  for (const doc of docs) {
    if (doc === skipDoc) continue;
    const docName = renameDoc && renameDoc.from === doc ? renameDoc.to : doc;
    fs.writeFileSync(path.join(wfDir, docName), `# ${doc}\nContent of ${doc}\n`);
  }

  return wfDir;
}

// ---------------------------------------------------------------------------
// Tests: parseRunMdGate
// ---------------------------------------------------------------------------

test('parseRunMdGate: closed_at_plan_checkpoint => planApproved=true', () => {
  const result = parseRunMdGate(planApprovedRunMd);
  assert.deepEqual(result, { planApproved: true, status: 'closed_at_plan_checkpoint' });
});

test('parseRunMdGate: plan active in Active Artifacts => planApproved=true', () => {
  const result = parseRunMdGate(planActiveRunMd);
  assert.equal(result.planApproved, true);
  assert.equal(result.status, 'active_at_design_stage');
});

test('parseRunMdGate: garbage input throws ERR_R2P_RUNMD_UNRECOGNIZED', () => {
  assert.throws(
    () => parseRunMdGate(garbageRunMd),
    (error) => error.code === 'ERR_R2P_RUNMD_UNRECOGNIZED'
  );
});

test('parseRunMdGate: plan not generated returns planApproved=false', () => {
  const result = parseRunMdGate(planNotApprovedRunMd);
  assert.equal(result.planApproved, false);
});

// Regression: the parser must accept the REAL r2p serializer shape — status
// token `closed_at_plan_checkpoint` plus a markdown-table "## Active Artifacts"
// — not just drfx's own simplified bullet fixtures.
const realR2pRunMd = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'r2p', 'real-r2p-run.md'),
  'utf8'
);

test('parseRunMdGate: real r2p run.md (closed_at_plan_checkpoint) => planApproved=true', () => {
  const result = parseRunMdGate(realR2pRunMd);
  assert.deepEqual(result, { planApproved: true, status: 'closed_at_plan_checkpoint' });
});

test('parseRunMdGate: real r2p markdown-table Active Artifacts satisfies the plan-approved fallback', () => {
  // Force the status off the closed token so the gate must rely on the
  // "## Active Artifacts" fallback. The plan row `| plan | 07-plan.md | N |
  // approved |` lives below the table header, so this only passes once
  // activeArtifactsSection captures the whole section (not just the header row).
  const openTable = realR2pRunMd.replace('closed_at_plan_checkpoint', 'active_at_plan_stage');
  const result = parseRunMdGate(openTable);
  assert.equal(result.status, 'active_at_plan_stage');
  assert.equal(result.planApproved, true);
});

test('parseRunMdGate: malformed status containing closed token is not approved', () => {
  const malformedStatusRunMd = planNotApprovedRunMd.replace(
    'active_at_spec_stage',
    'not_closed_at_plan_checkpoint'
  );

  const result = parseRunMdGate(malformedStatusRunMd);

  assert.equal(result.status, 'not_closed_at_plan_checkpoint');
  assert.equal(result.planApproved, false);
});

test('parseRunMdGate: Active Artifacts plan state must be an exact approved token', () => {
  const malformedPlanStateRunMd = `# Requirement Run

## Status
active_at_plan_stage

## Active Artifacts
| kind | path | revision | state |
| --- | --- | --- | --- |
| plan | 07-plan.md | 1 | not approved |
`;

  const result = parseRunMdGate(malformedPlanStateRunMd);

  assert.equal(result.status, 'active_at_plan_stage');
  assert.equal(result.planApproved, false);
});

test('activeArtifactsSection: captures full markdown table and stops at the next heading', () => {
  const section = activeArtifactsSection(realR2pRunMd);
  assert.match(section, /\|\s*plan\s*\|\s*07-plan\.md\s*\|\s*\d+\s*\|\s*approved\s*\|/);
  // Sibling sections must never bleed into the captured Active Artifacts body.
  assert.doesNotMatch(section, /Stale|Superseded|Open Routes/);
});

// ---------------------------------------------------------------------------
// Tests: activeArtifactsSection
// ---------------------------------------------------------------------------

test('activeArtifactsSection: extracts section content', () => {
  const text = `## Status\nactive\n\n## Active Artifacts\n- plan: active\n\n## Next\nfoo\n`;
  const section = activeArtifactsSection(text);
  assert.match(section, /plan: active/);
});

test('activeArtifactsSection: returns empty string when section absent', () => {
  assert.equal(activeArtifactsSection('no sections here'), '');
});

// ---------------------------------------------------------------------------
// Tests: isArchivedRequirementDir
// ---------------------------------------------------------------------------

test('isArchivedRequirementDir: archived path returns true', () => {
  assert.equal(isArchivedRequirementDir('/p/.req-to-plan/archive/WF-x'), true);
});

test('isArchivedRequirementDir: active path returns false', () => {
  assert.equal(isArchivedRequirementDir('/p/.req-to-plan/WF-x'), false);
});

test('isArchivedRequirementDir: no .req-to-plan segment returns false', () => {
  assert.equal(isArchivedRequirementDir('/p/WF-x'), false);
});

// ---------------------------------------------------------------------------
// Tests: isRequirementDirShape
// ---------------------------------------------------------------------------

test('isRequirementDirShape: valid WF-* under .req-to-plan returns true', () => {
  assert.equal(isRequirementDirShape('/p/.req-to-plan/WF-20260101-abc-demo'), true);
});

test('isRequirementDirShape: non-WF dir returns false', () => {
  assert.equal(isRequirementDirShape('/p/.req-to-plan/run-1'), false);
});

test('isRequirementDirShape: no .req-to-plan returns false', () => {
  assert.equal(isRequirementDirShape('/p/WF-foo'), false);
});

// ---------------------------------------------------------------------------
// Tests: resolveR2pWorkIdTarget
// ---------------------------------------------------------------------------

test('resolveR2pWorkIdTarget: happy path returns correct shape', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-aaa-demo';
  const wfDir = makeWfDir(root, workId);

  const ctx = resolveR2pWorkIdTarget({ projectRoot: root, workId });

  assert.equal(ctx.routeKind, 'r2p');
  assert.equal(ctx.targetContextKind, 'r2p');
  assert.equal(ctx.workId, workId);
  assert.equal(ctx.projectRoot, fs.realpathSync.native(root));
  assert.equal(ctx.runDir, fs.realpathSync.native(wfDir));
  assert.equal(ctx.runLocation, `.req-to-plan/${workId}`);
  assert.deepEqual(ctx.reviewFiles, R2P_EDITABLE_DOCS);
  assert.deepEqual(ctx.protectedDependencies, ['run.md']);
  assert.deepEqual(ctx.editableFiles, []);
  assert.equal(ctx.directArtifactWrites, 'forbidden');
  assert.match(ctx.fileSetFingerprint, /^[a-f0-9]{64}$/);
  assert.match(ctx.runMdSha256, /^[a-f0-9]{64}$/);
});

test('resolveR2pWorkIdTarget: review file entries have required fields', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-bbb-demo';
  makeWfDir(root, workId);

  const ctx = resolveR2pWorkIdTarget({ projectRoot: root, workId });

  for (const f of ctx.reviewFileEntries) {
    assert.equal(typeof f.path, 'string');
    assert.equal(typeof f.requirementRelativePath, 'string');
    assert.equal(typeof f.absolutePath, 'string');
    assert.equal(f.status, 'modified');
    assert.equal(f.contentId, f.sha256);
    assert.match(f.sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof f.size, 'number');
  }
});

test('resolveR2pWorkIdTarget: symlinked WF dir throws ERR_R2P_RUN_DIR_UNSAFE', (t) => {
  const root = makeSandbox(t);
  const realWfDir = makeWfDir(root, 'WF-20260101-real');
  const symlinkedWfDir = path.join(root, '.req-to-plan', 'WF-20260101-sym');
  fs.symlinkSync(realWfDir, symlinkedWfDir);

  assert.throws(
    () => resolveR2pWorkIdTarget({ projectRoot: root, workId: 'WF-20260101-sym' }),
    (error) => error.code === 'ERR_R2P_RUN_DIR_UNSAFE'
  );
});

test('resolveR2pWorkIdTarget rejects archive-prefixed workId outside the active direct-child slot', (t) => {
  const root = makeSandbox(t);
  makeWfDir(root, 'WF-20260101-archived', { underArchive: true });

  assert.throws(
    () => resolveR2pWorkIdTarget({ projectRoot: root, workId: 'archive/WF-20260101-archived' }),
    (error) => error.code === 'ERR_R2P_WORK_ID_SHAPE'
  );
});

test('resolveR2pWorkIdTarget: missing run.md throws ERR_R2P_ARTIFACT_MISSING', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-no-runmd';
  makeWfDir(root, workId, {
    skipRunMd: true
  });

  assert.throws(
    () => resolveR2pWorkIdTarget({ projectRoot: root, workId }),
    (error) => error.code === 'ERR_R2P_ARTIFACT_MISSING'
  );
});

test('resolveR2pWorkIdTarget: run.md is a directory throws ERR_R2P_ARTIFACT_UNSAFE', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-dir-runmd';
  makeWfDir(root, workId, {
    runMdIsDirectory: true
  });

  assert.throws(
    () => resolveR2pWorkIdTarget({ projectRoot: root, workId }),
    (error) => error.code === 'ERR_R2P_ARTIFACT_UNSAFE'
  );
});

test('resolveR2pWorkIdTarget: run.md is a symlink throws ERR_R2P_ARTIFACT_UNSAFE', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-sym-runmd';
  makeWfDir(root, workId, {
    runMdIsSymlink: true
  });

  assert.throws(
    () => resolveR2pWorkIdTarget({ projectRoot: root, workId }),
    (error) => error.code === 'ERR_R2P_ARTIFACT_UNSAFE'
  );
});

// ---------------------------------------------------------------------------
// Tests: resolveR2pWorkIdTarget — owner doc chain errors
// ---------------------------------------------------------------------------

test('resolveR2pWorkIdTarget: missing owner doc throws ERR_R2P_ARTIFACT_MISSING', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-no-spec';
  makeWfDir(root, workId, {
    skipDoc: '06-spec.md'
  });

  assert.throws(
    () => resolveR2pWorkIdTarget({ projectRoot: root, workId }),
    (error) => error.code === 'ERR_R2P_ARTIFACT_MISSING'
  );
});

test('resolveR2pWorkIdTarget: renamed owner doc throws ERR_R2P_ARTIFACT_MISSING', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-renamed-plan';
  makeWfDir(root, workId, {
    renameDoc: { from: '07-plan.md', to: '07-plan-draft.md' }
  });

  assert.throws(
    () => resolveR2pWorkIdTarget({ projectRoot: root, workId }),
    (error) => error.code === 'ERR_R2P_ARTIFACT_MISSING'
  );
});

// ---------------------------------------------------------------------------
// Tests: resolveR2pWorkIdTarget — fingerprint stability and content-sensitivity
// ---------------------------------------------------------------------------

test('resolveR2pWorkIdTarget: fingerprint is order-stable (reverse matches forward)', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-fp-stable';
  const wfDir = makeWfDir(root, workId);

  const ctx = resolveR2pWorkIdTarget({ projectRoot: root, workId });
  const before = ctx.fileSetFingerprint;

  // Recompute manually with reversed order — must still match (computeFileSetFingerprint sorts)
  const reversed = computeFileSetFingerprint(
    ctx.reviewFileEntries
      .map((f) => ({ path: f.requirementRelativePath, status: 'modified', contentId: f.sha256 }))
      .reverse()
  );
  assert.equal(reversed, before);
});

test('resolveR2pWorkIdTarget: fingerprint changes when a file content changes', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-fp-change';
  const wfDir = makeWfDir(root, workId);

  const ctx = resolveR2pWorkIdTarget({ projectRoot: root, workId });
  const before = ctx.fileSetFingerprint;

  // Mutate spec
  fs.writeFileSync(path.join(wfDir, '06-spec.md'), 'changed\n');
  const after = resolveR2pWorkIdTarget({ projectRoot: root, workId }).fileSetFingerprint;

  assert.notEqual(after, before);
});

// ---------------------------------------------------------------------------
// Tests: resolveR2pWorkIdTarget — gate errors
// ---------------------------------------------------------------------------

test('resolveR2pWorkIdTarget: plan not generated still resolves the review set', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-incomplete-plan';
  makeWfDir(root, workId, {
    runMdContent: planIncompleteRunMd
  });

  assert.doesNotThrow(() => resolveR2pWorkIdTarget({ projectRoot: root, workId }));
});

test('resolveR2pWorkIdTarget: archived dir throws ERR_R2P_WORK_ID_ARCHIVED', (t) => {
  const root = makeSandbox(t);
  const workId = 'WF-20260101-archived';
  makeWfDir(root, workId, {
    underArchive: true
  });

  assert.throws(
    () => resolveR2pWorkIdTarget({ projectRoot: root, workId }),
    (error) => error.code === 'ERR_R2P_WORK_ID_ARCHIVED'
  );
});
