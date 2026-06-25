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
  resolveR2pTarget,
  buildR2pIdentity,
  formatR2pIdentityFields,
  parseR2pIdentityFields,
  compareR2pIdentity,
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
// Tests: resolveR2pTarget — happy path
// ---------------------------------------------------------------------------

test('resolveR2pTarget: happy path returns correct shape', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-aaa-demo');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });

  assert.equal(ctx.routeKind, 'r2p');
  assert.equal(ctx.targetContextKind, 'r2p');
  assert.equal(typeof ctx.requirementDir, 'string');
  assert.equal(typeof ctx.projectRoot, 'string');
  assert.deepEqual(
    ctx.editableFiles.map((f) => f.relativePath),
    R2P_EDITABLE_DOCS
  );
  assert.match(ctx.fileSetFingerprint, /^[a-f0-9]{64}$/);
  assert.match(ctx.runMdSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(ctx.gate, { planApproved: true, status: 'closed_at_plan_checkpoint' });
});

test('resolveR2pTarget: editable file entries have required fields', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-bbb-demo');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });

  for (const f of ctx.editableFiles) {
    assert.equal(typeof f.relativePath, 'string');
    assert.equal(typeof f.absolutePath, 'string');
    assert.match(f.sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof f.size, 'number');
  }
});

// ---------------------------------------------------------------------------
// Tests: resolveR2pTarget — shape/containment errors
// ---------------------------------------------------------------------------

test('resolveR2pTarget: outside .req-to-plan throws ERR_R2P_TARGET_SHAPE', (t) => {
  const root = makeSandbox(t);
  // A WF-* dir but NOT under .req-to-plan
  const outsideReqToPlanDir = path.join(root, 'WF-20260101-outside');
  fs.mkdirSync(outsideReqToPlanDir);

  assert.throws(
    () => resolveR2pTarget({ cwd: root, target: outsideReqToPlanDir }),
    (error) => error.code === 'ERR_R2P_TARGET_SHAPE'
  );
});

test('resolveR2pTarget: non-WF-* name throws ERR_R2P_TARGET_SHAPE', (t) => {
  const root = makeSandbox(t);
  const reqDir = path.join(root, '.req-to-plan', 'run-1');
  fs.mkdirSync(reqDir, { recursive: true });

  assert.throws(
    () => resolveR2pTarget({ cwd: root, target: reqDir }),
    (error) => error.code === 'ERR_R2P_TARGET_SHAPE'
  );
});

test('resolveR2pTarget: symlinked WF dir throws ERR_R2P_TARGET_SYMLINK', (t) => {
  const root = makeSandbox(t);
  // Create a real WF dir somewhere else
  const realWfDir = makeWfDir(root, 'WF-20260101-real');
  // Create the symlink under .req-to-plan
  const reqToPlanDir = path.join(root, '.req-to-plan');
  // symlinkedWfDir: a symlink at .req-to-plan/WF-20260101-sym pointing to realWfDir
  const symlinkedWfDir = path.join(reqToPlanDir, 'WF-20260101-sym');
  fs.symlinkSync(realWfDir, symlinkedWfDir);

  assert.throws(
    () => resolveR2pTarget({ cwd: root, target: symlinkedWfDir }),
    (error) => error.code === 'ERR_R2P_TARGET_SYMLINK'
  );
});

// Darwin /var -> /private/var alias: resolveR2pTarget must not reject a valid
// path that contains a well-known OS-level path alias (non-symlink segment rename).
// os.tmpdir() on macOS returns /var/folders/... which is aliased to /private/var/...,
// so any temp dir created there exercises the alias path.
test('resolveR2pTarget: darwin /var alias does not cause false rejection', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('darwin-only alias test');
    return;
  }
  let varReal;
  try {
    varReal = fs.realpathSync.native('/var');
  } catch {
    t.skip('cannot resolve /var');
    return;
  }
  if (varReal !== '/private/var') {
    t.skip('/var is not aliased to /private/var on this system');
    return;
  }
  // os.tmpdir() on macOS is /var/folders/.../<user>/T which exercises the alias
  const varBase = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-alias-'));
  t.after(() => fs.rmSync(varBase, { recursive: true, force: true }));

  const privateVarAliasWfDir = makeWfDir(varBase, 'WF-20260101-alias');

  assert.doesNotThrow(() =>
    resolveR2pTarget({ cwd: varBase, target: privateVarAliasWfDir })
  );
});

// ---------------------------------------------------------------------------
// Tests: resolveR2pTarget — run.md errors
// ---------------------------------------------------------------------------

test('resolveR2pTarget: missing run.md throws ERR_R2P_RUNMD_MISSING', (t) => {
  const root = makeSandbox(t);
  const missingRunMdWfDir = makeWfDir(root, 'WF-20260101-no-runmd', {
    skipRunMd: true
  });

  assert.throws(
    () => resolveR2pTarget({ cwd: root, target: missingRunMdWfDir }),
    (error) => error.code === 'ERR_R2P_RUNMD_MISSING'
  );
});

test('resolveR2pTarget: run.md is a directory throws ERR_R2P_RUNMD_MISSING', (t) => {
  const root = makeSandbox(t);
  const directoryRunMdWfDir = makeWfDir(root, 'WF-20260101-dir-runmd', {
    runMdIsDirectory: true
  });

  assert.throws(
    () => resolveR2pTarget({ cwd: root, target: directoryRunMdWfDir }),
    (error) => error.code === 'ERR_R2P_RUNMD_MISSING'
  );
});

test('resolveR2pTarget: run.md is a symlink throws ERR_R2P_RUNMD_SYMLINK', (t) => {
  const root = makeSandbox(t);
  const symlinkRunMdWfDir = makeWfDir(root, 'WF-20260101-sym-runmd', {
    runMdIsSymlink: true
  });

  assert.throws(
    () => resolveR2pTarget({ cwd: root, target: symlinkRunMdWfDir }),
    (error) => error.code === 'ERR_R2P_RUNMD_SYMLINK'
  );
});

// ---------------------------------------------------------------------------
// Tests: resolveR2pTarget — owner doc chain errors
// ---------------------------------------------------------------------------

test('resolveR2pTarget: missing owner doc throws ERR_R2P_DOC_CHAIN_INCOMPLETE', (t) => {
  const root = makeSandbox(t);
  const missingSpecWfDir = makeWfDir(root, 'WF-20260101-no-spec', {
    skipDoc: '06-spec.md'
  });

  assert.throws(
    () => resolveR2pTarget({ cwd: root, target: missingSpecWfDir }),
    (error) => error.code === 'ERR_R2P_DOC_CHAIN_INCOMPLETE'
  );
});

test('resolveR2pTarget: renamed owner doc throws ERR_R2P_DOC_CHAIN_INCOMPLETE', (t) => {
  const root = makeSandbox(t);
  const renamedPlanWfDir = makeWfDir(root, 'WF-20260101-renamed-plan', {
    renameDoc: { from: '07-plan.md', to: '07-plan-draft.md' }
  });

  assert.throws(
    () => resolveR2pTarget({ cwd: root, target: renamedPlanWfDir }),
    (error) => error.code === 'ERR_R2P_DOC_CHAIN_INCOMPLETE'
  );
});

// ---------------------------------------------------------------------------
// Tests: resolveR2pTarget — fingerprint stability and content-sensitivity
// ---------------------------------------------------------------------------

test('resolveR2pTarget: fingerprint is order-stable (reverse matches forward)', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-fp-stable');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });
  const before = ctx.fileSetFingerprint;

  // Recompute manually with reversed order — must still match (computeFileSetFingerprint sorts)
  const reversed = computeFileSetFingerprint(
    ctx.editableFiles
      .map((f) => ({ path: f.relativePath, status: 'modified', contentId: f.sha256 }))
      .reverse()
  );
  assert.equal(reversed, before);
});

test('resolveR2pTarget: fingerprint changes when a file content changes', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-fp-change');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });
  const before = ctx.fileSetFingerprint;

  // Mutate spec
  fs.writeFileSync(path.join(wfDir, '06-spec.md'), 'changed\n');
  const after = resolveR2pTarget({ cwd: root, target: wfDir }).fileSetFingerprint;

  assert.notEqual(after, before);
});

// ---------------------------------------------------------------------------
// Tests: resolveR2pTarget — gate errors
// ---------------------------------------------------------------------------

test('resolveR2pTarget: plan not generated throws ERR_R2P_GATE_PLAN_INCOMPLETE', (t) => {
  const root = makeSandbox(t);
  const incompletePlanWfDir = makeWfDir(root, 'WF-20260101-incomplete-plan', {
    runMdContent: planIncompleteRunMd
  });

  assert.throws(
    () => resolveR2pTarget({ cwd: root, target: incompletePlanWfDir }),
    (error) => error.code === 'ERR_R2P_GATE_PLAN_INCOMPLETE'
  );
});

test('resolveR2pTarget: archived dir throws ERR_R2P_GATE_ARCHIVED', (t) => {
  const root = makeSandbox(t);
  const archivedWfDir = makeWfDir(root, 'WF-20260101-archived', {
    underArchive: true
  });

  assert.throws(
    () => resolveR2pTarget({ cwd: root, target: archivedWfDir }),
    (error) => error.code === 'ERR_R2P_GATE_ARCHIVED'
  );
});

// ---------------------------------------------------------------------------
// Tests: r2p identity family
// ---------------------------------------------------------------------------

test('buildR2pIdentity: builds identity with correct scalar fields', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-identity');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });
  const identity = buildR2pIdentity({ context: ctx, guardMode: 'git', roundLimit: 3 });

  assert.equal(identity.targetContextKind, 'r2p');
  assert.equal(identity.guardMode, 'git');
  assert.equal(identity.roundLimit, '3');
  assert.equal(typeof identity.requirementDir, 'string');
  assert.match(identity.runMdSha256, /^[a-f0-9]{64}$/);
  assert.match(identity.fileSetFingerprint, /^[a-f0-9]{64}$/);
});

test('buildR2pIdentity: roundLimit null serializes as "none"', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-identity-no-limit');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });
  const identity = buildR2pIdentity({ context: ctx, guardMode: 'snapshot', roundLimit: null });

  assert.equal(identity.roundLimit, 'none');
});

test('buildR2pIdentity: throws on wrong routeKind', () => {
  assert.throws(
    () => buildR2pIdentity({ context: { routeKind: 'code' }, guardMode: 'git' }),
    (error) => error.code === 'ERR_R2P_IDENTITY'
  );
});

test('formatR2pIdentityFields / parseR2pIdentityFields: round-trips all scalar fields', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-identity-roundtrip');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });
  const identity = buildR2pIdentity({ context: ctx, guardMode: 'git', roundLimit: 2 });

  const fields = formatR2pIdentityFields(identity);
  const parsed = parseR2pIdentityFields(fields);

  assert.deepEqual(parsed, identity);
});

test('compareR2pIdentity: identical identities match', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-cmp-match');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });
  const identity = buildR2pIdentity({ context: ctx, guardMode: 'git', roundLimit: 1 });

  const result = compareR2pIdentity({ stored: identity, requested: identity });
  assert.equal(result.match, true);
  assert.deepEqual(result.mismatches, []);
});

test('compareR2pIdentity: runMdSha256 drift causes mismatch', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-cmp-runmd-drift');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });
  const identity = buildR2pIdentity({ context: ctx, guardMode: 'git', roundLimit: 1 });
  const stale = { ...identity, runMdSha256: 'a'.repeat(64) };

  const result = compareR2pIdentity({ stored: stale, requested: identity });
  assert.equal(result.match, false);
  assert.ok(result.mismatches.includes('runMdSha256'));
});

test('compareR2pIdentity: fileSetFingerprint drift causes mismatch', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-cmp-fp-drift');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });
  const identity = buildR2pIdentity({ context: ctx, guardMode: 'git', roundLimit: 1 });
  const stale = { ...identity, fileSetFingerprint: 'b'.repeat(64) };

  const result = compareR2pIdentity({ stored: stale, requested: identity });
  assert.equal(result.match, false);
  assert.ok(result.mismatches.includes('fileSetFingerprint'));
});

test('compareR2pIdentity: guardMode drift causes mismatch', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-cmp-guard-drift');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });
  const stored = buildR2pIdentity({ context: ctx, guardMode: 'git', roundLimit: 1 });
  const requested = buildR2pIdentity({ context: ctx, guardMode: 'snapshot', roundLimit: 1 });

  const result = compareR2pIdentity({ stored, requested });
  assert.equal(result.match, false);
  assert.ok(result.mismatches.includes('guardMode'));
});

test('compareR2pIdentity: requirementDir drift causes mismatch', (t) => {
  const root = makeSandbox(t);
  const wfDir = makeWfDir(root, 'WF-20260101-cmp-dir-drift');

  const ctx = resolveR2pTarget({ cwd: root, target: wfDir });
  const identity = buildR2pIdentity({ context: ctx, guardMode: 'git', roundLimit: 1 });
  const stale = { ...identity, requirementDir: 'some/other/path' };

  const result = compareR2pIdentity({ stored: stale, requested: identity });
  assert.equal(result.match, false);
  assert.ok(result.mismatches.includes('requirementDir'));
});
