'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ALLOWED_STATUSES,
  computeFingerprint,
  deriveTargetKey,
  resolveProjectRoot,
  validateLedgerPath,
  normalizeReferences,
  shouldCreatePersistentState,
  formatManifest,
  parseManifest,
  writeManifest,
  readManifest,
  readManifestAny
} = require('../lib/target-state');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-state-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'My SPEC.md'), '# Spec\n');
  fs.writeFileSync(path.join(root, 'docs', 'ref.md'), '# Ref\n');
  return root;
}

function makeManifest(root, overrides = {}) {
  const target = overrides.target || path.join(root, 'docs', 'My SPEC.md');
  const fingerprint = overrides.fingerprint || computeFingerprint(target);
  return {
    target,
    normalizedTarget: 'docs/My SPEC.md',
    documentType: 'SPEC',
    strictness: 'normal',
    mode: 'review-and-fix',
    targetKey: 'my-spec-md-123456789abc',
    ledgerPath: '.drfx/targets/my-spec-md-123456789abc/ISSUES.md',
    status: 'review',
    currentRound: 1,
    initialContentSha256: fingerprint.sha256,
    lastKnownContentSha256: fingerprint.sha256,
    lastReviewedContentSha256: 'none',
    lastPassedContentSha256: 'none',
    lastModifiedAt: String(fingerprint.mtimeMs),
    fileSize: fingerprint.size,
    references: ['docs/ref.md'],
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    ...overrides
  };
}

test('derives stable target key from normalized relative path without content fingerprint', () => {
  const root = makeWorkspace();
  const target = path.join(root, 'docs', 'My SPEC.md');
  const state = deriveTargetKey(root, target);
  const expectedHash = crypto.createHash('sha256').update('docs/My SPEC.md').digest('hex').slice(0, 12);

  assert.equal(state.normalizedTarget, 'docs/My SPEC.md');
  assert.equal(state.slug, 'my-spec-md');
  assert.equal(state.hash12, expectedHash);
  assert.equal(state.targetKey, `my-spec-md-${expectedHash}`);

  fs.appendFileSync(target, '\nChanged content must not affect key\n');
  assert.deepEqual(deriveTargetKey(root, target), state);
});

test('normalizes slug by basename, fallback, and truncation rules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-slug-'));
  const longName = `${'A'.repeat(60)}.md`;
  const symbolic = '---.md';
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', longName), '# Long\n');
  fs.writeFileSync(path.join(root, 'docs', symbolic), '# Symbolic\n');

  assert.equal(deriveTargetKey(root, path.join(root, 'docs', longName)).slug, `${'a'.repeat(48)}`);
  assert.equal(deriveTargetKey(root, path.join(root, 'docs', symbolic)).slug, 'md');
});

test('resolves explicit, git, drfx, and cwd project roots deterministically', () => {
  const root = makeWorkspace();
  const target = path.join(root, 'docs', 'My SPEC.md');
  assert.equal(resolveProjectRoot({ explicitRoot: root, targetPath: target, cwd: os.tmpdir() }), fs.realpathSync.native(root));
  assert.equal(resolveProjectRoot({ targetPath: target, cwd: root }), fs.realpathSync.native(root));

  const gitRoot = makeWorkspace();
  fs.mkdirSync(path.join(gitRoot, '.git'));
  const gitTarget = path.join(gitRoot, 'docs', 'My SPEC.md');
  assert.equal(resolveProjectRoot({ targetPath: gitTarget, cwd: os.tmpdir() }), fs.realpathSync.native(gitRoot));

  const targetAncestorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-targets-root-'));
  fs.mkdirSync(path.join(targetAncestorRoot, '.drfx', 'targets'), { recursive: true });
  fs.mkdirSync(path.join(targetAncestorRoot, 'nested'), { recursive: true });
  const targetAncestorTarget = path.join(targetAncestorRoot, 'nested', 'design.md');
  fs.writeFileSync(targetAncestorTarget, '# Design\n');
  assert.equal(resolveProjectRoot({ targetPath: targetAncestorTarget, cwd: os.tmpdir() }), fs.realpathSync.native(targetAncestorRoot));

  const ruleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-rule-root-'));
  fs.mkdirSync(path.join(ruleRoot, '.drfx', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(ruleRoot, '.drfx', 'rules', 'COMMON.md'), 'Rule\n');
  fs.mkdirSync(path.join(ruleRoot, 'deep'), { recursive: true });
  const ruleTarget = path.join(ruleRoot, 'deep', 'plan.md');
  fs.writeFileSync(ruleTarget, '# Plan\n');
  assert.equal(resolveProjectRoot({ targetPath: ruleTarget, cwd: os.tmpdir() }), fs.realpathSync.native(ruleRoot));
  assert.equal(
    resolveProjectRoot({ targetPath: ruleTarget, cwd: os.tmpdir(), persistentStateRequired: true }),
    fs.realpathSync.native(ruleRoot)
  );
  assert.equal(fs.existsSync(path.join(ruleRoot, '.drfx', 'targets')), false);

  const staleRuleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-stale-rule-root-'));
  fs.mkdirSync(path.join(staleRuleRoot, '.drfx'), { recursive: true });
  fs.writeFileSync(path.join(staleRuleRoot, '.drfx', 'RULE.md'), '## COMMON\nOld rule\n');
  fs.mkdirSync(path.join(staleRuleRoot, 'deep'), { recursive: true });
  const staleRuleTarget = path.join(staleRuleRoot, 'deep', 'plan.md');
  fs.writeFileSync(staleRuleTarget, '# Plan\n');
  assert.equal(resolveProjectRoot({ targetPath: staleRuleTarget, cwd: os.tmpdir() }), fs.realpathSync.native(staleRuleRoot));
});

test('rejects unresolved persistent root and target escape using realpaths', () => {
  const root = makeWorkspace();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-outside-'));
  const outsideTarget = path.join(outsideRoot, 'outside.md');
  fs.writeFileSync(outsideTarget, '# Outside\n');

  assert.throws(
    () => resolveProjectRoot({ targetPath: outsideTarget, cwd: root, persistentStateRequired: true }),
    /explicit root/i
  );
  assert.throws(() => resolveProjectRoot({ explicitRoot: root, targetPath: outsideTarget, cwd: root }), /contain target/i);

  const escapingLink = path.join(root, 'docs', 'escaping.md');
  fs.symlinkSync(outsideTarget, escapingLink);
  assert.throws(() => resolveProjectRoot({ explicitRoot: root, targetPath: escapingLink, cwd: root }), /contain target/i);
});

test('records external references as read-only and canonicalizes reference paths', () => {
  const root = makeWorkspace();
  const external = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-ext-ref-')), 'external.md');
  fs.writeFileSync(external, '# External\n');

  const refs = normalizeReferences({ projectRoot: root, references: [path.join(root, 'docs', 'ref.md'), external] });
  assert.equal(refs[0].path, path.resolve(root, 'docs', 'ref.md'));
  assert.equal(refs[0].realPath, fs.realpathSync.native(path.join(root, 'docs', 'ref.md')));
  assert.equal(refs[0].external, false);
  assert.equal(refs[0].readOnly, true);
  assert.equal(refs[1].realPath, fs.realpathSync.native(external));
  assert.equal(refs[1].external, true);
  assert.equal(refs[1].readOnly, true);
});

test('computes fingerprints and detects content changes', () => {
  const root = makeWorkspace();
  const target = path.join(root, 'docs', 'My SPEC.md');
  const before = computeFingerprint(target);
  fs.appendFileSync(target, '\nChanged\n');
  const after = computeFingerprint(target);

  assert.match(before.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(after.sha256, before.sha256);
  assert.ok(after.size > before.size);
});

test('validates custom ledger inside target state and rejects outside, reserved, and symlink paths', () => {
  const root = makeWorkspace();
  const targetKey = 'my-spec-md-123456789abc';
  const targetDir = path.join(root, '.drfx', 'targets', targetKey);
  const allowed = path.join(targetDir, 'ledgers', 'ISSUES.md');
  assert.equal(validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: allowed }), allowed);

  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: path.join(root, 'ISSUES.md') }), /outside/i);
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: path.join(targetDir, 'MANIFEST.md') }), /reserved/i);
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: path.join(targetDir, 'nested', 'SUMMARY.md') }), /reserved/i);
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: path.join(targetDir, 'LOCK') }), /reserved/i);
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: path.join(targetDir, 'LOCK', 'lease.json') }), /reserved/i);
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: path.join(targetDir, 'stale-locks', 'old.json') }), /reserved/i);
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: path.join(targetDir, 'rounds', '001-review.md') }), /reserved/i);
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: path.join(targetDir, 'context', 'merged-rules.md') }), /reserved/i);
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: path.join(targetDir, 'reports', 'review.json') }), /reserved/i);

  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-ledger-outside-'));
  const outsideLedger = path.join(outsideRoot, 'ISSUES.md');
  fs.writeFileSync(outsideLedger, 'outside\n');
  fs.mkdirSync(targetDir, { recursive: true });
  const symlinkLedger = path.join(targetDir, 'SYMLINK-ISSUES.md');
  fs.symlinkSync(outsideLedger, symlinkLedger);
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: symlinkLedger }), /symlink|outside/i);

  const lockDir = path.join(targetDir, 'LOCK');
  fs.mkdirSync(lockDir, { recursive: true });
  const reservedLease = path.join(lockDir, 'lease.json');
  fs.writeFileSync(reservedLease, '{}\n');
  const reservedSymlink = path.join(targetDir, 'RESERVED-LINK.md');
  fs.symlinkSync(reservedLease, reservedSymlink);
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: reservedSymlink }), /symlink|reserved/i);

  const directoryLedger = path.join(targetDir, 'ledgers');
  fs.mkdirSync(directoryLedger, { recursive: true });
  assert.throws(() => validateLedgerPath({ projectRoot: root, targetKey, ledgerPath: directoryLedger }), /directory|file/i);
});

test('formats, parses, writes, and reads manifest with exact allowed statuses', () => {
  const root = makeWorkspace();
  const manifest = makeManifest(root, { status: 'review' });
  const expectedStatuses = [
    'review',
    'triage',
    'fix',
    'diff-review',
    'full-re-review',
    'pass',
    'stopped-with-deferrals',
    'stopped-no-progress',
    'read-only-findings',
    'blocked',
    'unsupported',
    'externally-changed',
    'possible-target-replacement',
    'read-only-clean',
    'checkpoint'
  ];

  assert.deepEqual(ALLOWED_STATUSES, expectedStatuses);
  const parsed = parseManifest(formatManifest(manifest));
  assert.deepEqual(parsed, { ...manifest, fileSize: String(manifest.fileSize), currentRound: String(manifest.currentRound) });

  const manifestPath = path.join(root, '.drfx', 'targets', manifest.targetKey, 'MANIFEST.md');
  writeManifest(manifestPath, manifest);
  assert.equal(readManifest(manifestPath).lastKnownContentSha256, manifest.lastKnownContentSha256);
  assert.throws(() => formatManifest({ ...manifest, status: 'unknown' }), /unknown status/i);
  assert.throws(() => parseManifest(formatManifest(manifest).replace('Status: review', 'Status: unknown')), /unknown status/i);
});

test('readManifestAny dispatches v1 and schema-2 manifests without normalizing corrupt schema-2', () => {
  const root = makeWorkspace();
  const manifest = makeManifest(root, { status: 'review' });
  const v1Path = path.join(root, '.drfx', 'targets', manifest.targetKey, 'MANIFEST.md');
  writeManifest(v1Path, manifest);
  assert.equal(readManifestAny(v1Path).manifestSchema, 1);
  assert.equal(readManifestAny(v1Path).assurance, 'advisory');
  assert.equal(readManifestAny(v1Path).runtimePlatform, 'manual');

  const v2Path = path.join(root, '.drfx', 'targets', manifest.targetKey, 'MANIFEST-v2.md');
  fs.writeFileSync(v2Path, [
    '# Review Target Manifest',
    '',
    'Manifest schema: 2',
    'Target: docs/spec.md',
    'Normalized target: docs/spec.md',
    'Document type: SPEC',
    'Strictness: normal',
    'Mode: review-and-fix',
    'Target key: spec-md-aaaaaaaaaaaa',
    'Ledger path: .drfx/targets/spec-md-aaaaaaaaaaaa/ISSUES.md',
    'Status: blocked',
    'Current phase: review',
    'Current round: 1',
    'Assurance: practical',
    'Runtime platform: codex',
    'Descriptor platform: none',
    'Assurance proof: none',
    'Runtime subagent probe: ready',
    'Runtime subagent probe evidence: route-asserted-ready',
    'Runtime fingerprint guard: passed',
    'Runtime stdin handoff: ready',
    'Runtime stdin handoff evidence: route-asserted-ready',
    'Runtime downgrade reason: none',
    'Blocking reason: none',
    'Status reason: none',
    'Current report path: none',
    'Last reviewer report path: none',
    'Last triage report path: none',
    'Last fix report path: none',
    'Last diff review report path: none',
    `Initial content sha256: ${'a'.repeat(64)}`,
    `Last known content sha256: ${'a'.repeat(64)}`,
    'Last reviewed content sha256: none',
    'Last passed content sha256: none',
    'Last modified at: 2026-05-21T00:00:00.000Z',
    'File size: 10',
    'References:',
    'Created at: 2026-05-21T00:00:00.000Z',
    'Updated at: 2026-05-21T00:00:00.000Z',
    ''
  ].join('\n'));

  assert.throws(
    () => readManifestAny(v2Path),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' && /state-validation-failed/.test(error.message)
  );
});

test('readManifestAny parses a schema-2 pr-kind file-set manifest', () => {
  const root = makeWorkspace();
  const { formatManifestV2 } = require('../lib/workflow-state');
  const prText = formatManifestV2({
    manifestSchema: 2,
    targetContextKind: 'pr',
    documentType: 'none',
    target: 'none',
    normalizedTarget: 'none',
    strictness: 'normal',
    mode: 'review-and-fix',
    guardMode: 'git',
    targetKey: 'pr-feature-123456789abc',
    ledgerPath: '.drfx/targets/pr-feature-123456789abc/ISSUES.md',
    status: 'review',
    currentPhase: 'review',
    currentRound: 1,
    fixAttemptCount: 0,
    assurance: 'practical',
    runtimePlatform: 'codex',
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    runtimeSubagentProbe: 'ready',
    runtimeSubagentProbeEvidence: 'route-asserted-ready',
    runtimeFingerprintGuard: 'passed',
    runtimeStdinHandoff: 'ready',
    runtimeStdinHandoffEvidence: 'route-asserted-ready',
    runtimeDowngradeReason: 'none',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: 'none',
    lastReviewerReportPath: 'none',
    lastTriageReportPath: 'none',
    lastFixReportPath: 'none',
    lastDiffReviewReportPath: 'none',
    base: 'main',
    baseRevision: '1'.repeat(40),
    mergeBase: '2'.repeat(40),
    head: '3'.repeat(40),
    fileSetFingerprint: 'f'.repeat(64),
    roundLimit: '5',
    lastModifiedAt: '2026-05-21T00:00:00.000Z',
    references: [],
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z'
  });
  const prPath = path.join(root, 'MANIFEST-pr.md');
  fs.writeFileSync(prPath, prText);

  const parsed = readManifestAny(prPath);
  assert.equal(parsed.manifestSchema, 2);
  assert.equal(parsed.targetContextKind, 'pr');
  assert.equal(parsed.base, 'main');
  assert.equal(parsed.fileSetFingerprint, 'f'.repeat(64));
});

test('keeps one-shot read-only mode non-persistent without ledger, resume, round2, audit, or checkpoint', () => {
  assert.equal(shouldCreatePersistentState({ mode: 'read-only', ledger: null, resume: false, round: 1, auditTrail: false, checkpointReason: null }), false);
  assert.equal(shouldCreatePersistentState({ mode: 'read-only', ledger: 'ISSUES.md', resume: false, round: 1, auditTrail: false, checkpointReason: null }), true);
  assert.equal(shouldCreatePersistentState({ mode: 'read-only', ledger: null, resume: true, round: 1, auditTrail: false, checkpointReason: null }), true);
  assert.equal(shouldCreatePersistentState({ mode: 'read-only', ledger: null, resume: false, round: 2, auditTrail: false, checkpointReason: null }), true);
  assert.equal(shouldCreatePersistentState({ mode: 'read-only', ledger: null, resume: false, round: 1, auditTrail: true, checkpointReason: null }), true);
  assert.equal(shouldCreatePersistentState({ mode: 'read-only', ledger: null, resume: false, round: 1, auditTrail: false, checkpointReason: 'context-pressure' }), true);
  assert.equal(shouldCreatePersistentState({ mode: 'review-and-fix', ledger: null, resume: false, round: 1, auditTrail: false, checkpointReason: null }), true);
});

// ---------------------------------------------------------------------------
// PLAN-TASK-003: over-cap whole-root review-fix-code → partitioned-review entry
// + checkpoint state. A whole-root review that exceeds MAX_WHOLE_ROOT_*
// stops returning the hard file-set-too-large block and instead enters
// reviewMode:'partitioned'. Persistent (review-and-fix) runs write a
// Status: checkpoint manifest + project-review/ plan files and return
// partitioned-review; one-shot read-only --no-state runs return a no-state
// plan and write NOTHING under .drfx/targets/. Under-cap and explicit-scope
// runs are unchanged (covered in workflow-fileset-start.test.js).
// ---------------------------------------------------------------------------

const { execFileSync } = require('node:child_process');
const { formatManifestV2, parseManifestV2 } = require('../lib/workflow-state');
const { runWorkflowCommand } = require('../lib/workflow');
const {
  CROSSCUTTING_BACKSTOPS,
  MAX_UNIT_BYTES
} = require('../lib/project-review');

function gitInit(cwd) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com'
  };
  execFileSync('git', ['init', '-b', 'main'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Build an over-cap whole-root project (> MAX_WHOLE_ROOT_FILES files). Each
// file carries a require() of a sibling so suggestedRefs is non-trivially
// fillable, plus one oversize file (> MAX_UNIT_BYTES) to exercise the
// oversize-unit path (empty suggestedRefs, body never read).
function makeOverCapRepo(t, { git = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-overcap-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (let i = 0; i < 320; i += 1) {
    fs.writeFileSync(
      path.join(root, 'src', `mod-${i}.js`),
      `'use strict';\nconst dep = require('./mod-${(i + 1) % 320}.js');\nmodule.exports = ${i};\n`
    );
  }
  // One oversize file (> MAX_UNIT_BYTES) becomes its own oversize unit.
  fs.writeFileSync(path.join(root, 'src', 'big.bin'), Buffer.alloc(MAX_UNIT_BYTES + 10, 0x61));
  if (git) gitInit(root);
  return root;
}

function persistentArgs(extra) {
  return [
    ...extra,
    'review-and-fix',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ];
}

function noStateContextArgs(extra) {
  return [
    ...extra,
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ];
}

test('whole-root over-cap persistent CODE start enters partitioned-review with the right JSON shape', async (t) => {
  const root = makeOverCapRepo(t);
  const result = await runWorkflowCommand(
    'start',
    persistentArgs(['review-fix-code', 'guard=snapshot']),
    { cwd: root }
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'partitioned-review');
  assert.equal(result.reviewMode, 'partitioned');
  assert.equal(result.currentPhase, 'review');
  assert.equal(result.reviewPlanPath, 'project-review/units.json');
  assert.ok(Number.isInteger(result.unitCount) && result.unitCount >= 1);
  assert.ok(typeof result.nextAction === 'string' && result.nextAction.length > 0);
  // A partitioned-review entry is a PLAN, never a PASS.
  assert.notEqual(result.status, 'pass');
  // Persistent run carries a real target state dir.
  assert.ok(result.targetStateDir && result.targetStateDir.includes('.drfx'));
  assert.equal(fs.existsSync(result.manifestPath), true);
});

test('whole-root over-cap persistent CODE start writes a checkpoint manifest + project-review plan files', async (t) => {
  const root = makeOverCapRepo(t);
  const result = await runWorkflowCommand(
    'start',
    persistentArgs(['review-fix-code', 'guard=snapshot']),
    { cwd: root }
  );
  assert.equal(result.ok, true, JSON.stringify(result));

  // 1) Checkpoint manifest round-trips through parseManifestV2.
  const manifest = parseManifestV2(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.targetContextKind, 'code');
  assert.equal(manifest.status, 'checkpoint');
  assert.equal(manifest.statusReason, 'checkpoint-requested');
  assert.equal(manifest.currentPhase, 'review');
  assert.equal(manifest.blockingReason, 'none');
  assert.match(manifest.fileSetFingerprint, /^[0-9a-f]{64}$/);

  // 2) project-review/ plan files exist and are well-formed.
  const planDir = path.join(result.targetStateDir, 'project-review');
  const unitsPath = path.join(planDir, 'units.json');
  const inventoryPath = path.join(planDir, 'inventory.jsonl');
  assert.equal(fs.existsSync(unitsPath), true);
  assert.equal(fs.existsSync(inventoryPath), true);

  const units = JSON.parse(fs.readFileSync(unitsPath, 'utf8'));
  assert.equal(units.reviewMode, 'partitioned');
  assert.equal(units.unitByteBudget, MAX_UNIT_BYTES);
  // D-C: units.json carries the contentId projectReviewFingerprint VERBATIM,
  // which is exactly the manifest fileSetFingerprint for the checkpoint.
  assert.equal(units.projectReviewFingerprint, manifest.fileSetFingerprint);
  assert.deepEqual(units.crosscuttingBackstops, CROSSCUTTING_BACKSTOPS);
  assert.equal(units.crosscuttingBackstops.length, 7);
  assert.equal(units.units.length, result.unitCount);

  // suggestedRefs filled for non-oversize units; oversize units stay empty.
  const oversizeUnits = units.units.filter((u) => u.oversize_file === true);
  assert.ok(oversizeUnits.length >= 1, 'expected at least one oversize unit (big.bin)');
  for (const u of oversizeUnits) {
    assert.deepEqual(u.suggestedRefs, []);
  }
  const filledRefs = units.units.some(
    (u) => u.oversize_file !== true && Array.isArray(u.suggestedRefs) && u.suggestedRefs.length > 0
  );
  assert.equal(filledRefs, true, 'expected at least one non-oversize unit with filled suggestedRefs');
  for (const u of units.units) {
    for (const ref of u.suggestedRefs) {
      assert.ok(typeof ref.path === 'string' && /^[0-9a-f]{64}$/.test(ref.contentId));
    }
  }

  // inventory.jsonl: one JSON object per line, each {path,size,ext,contentId,unit_id}.
  const lines = fs.readFileSync(inventoryPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 1);
  const unitIds = new Set(units.units.map((u) => u.unit_id));
  let previousPath = '';
  for (const line of lines) {
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row).sort(), ['contentId', 'ext', 'path', 'size', 'unit_id']);
    assert.ok(unitIds.has(row.unit_id));
    // deterministic ordering: rows are sorted by path
    assert.ok(row.path >= previousPath, `inventory.jsonl rows must be path-sorted: ${row.path} < ${previousPath}`);
    previousPath = row.path;
  }
});

test('whole-root over-cap persistent CODE start rejects a stale project-review symlink before writing plan files', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await runWorkflowCommand(
    'start',
    persistentArgs(['review-fix-code', 'guard=snapshot']),
    { cwd: root }
  );
  assert.equal(start.ok, true, JSON.stringify(start));

  const escapeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-plan-escape-')));
  t.after(() => fs.rmSync(escapeDir, { recursive: true, force: true }));

  fs.rmSync(start.manifestPath, { force: true });
  fs.rmSync(path.join(start.targetStateDir, 'project-review'), { recursive: true, force: true });
  fs.symlinkSync(escapeDir, path.join(start.targetStateDir, 'project-review'), 'dir');

  await assert.rejects(
    runWorkflowCommand(
      'start',
      persistentArgs(['review-fix-code', 'guard=snapshot']),
      { cwd: root }
    ),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED'
  );
  assert.equal(fs.existsSync(path.join(escapeDir, 'inventory.jsonl')), false);
  assert.equal(fs.existsSync(path.join(escapeDir, 'units.json')), false);
});

test('whole-root over-cap persistent CODE start output is deterministic across two runs', async (t) => {
  const rootA = makeOverCapRepo(t);
  const rootB = makeOverCapRepo(t);
  const a = await runWorkflowCommand('start', persistentArgs(['review-fix-code', 'guard=snapshot']), { cwd: rootA });
  const b = await runWorkflowCommand('start', persistentArgs(['review-fix-code', 'guard=snapshot']), { cwd: rootB });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const unitsA = fs.readFileSync(path.join(a.targetStateDir, 'project-review', 'units.json'), 'utf8');
  const unitsB = fs.readFileSync(path.join(b.targetStateDir, 'project-review', 'units.json'), 'utf8');
  const invA = fs.readFileSync(path.join(a.targetStateDir, 'project-review', 'inventory.jsonl'), 'utf8');
  const invB = fs.readFileSync(path.join(b.targetStateDir, 'project-review', 'inventory.jsonl'), 'utf8');
  assert.equal(unitsA, unitsB, 'identical trees ⇒ byte-identical units.json');
  assert.equal(invA, invB, 'identical trees ⇒ byte-identical inventory.jsonl');
});

test('reset archives a checkpoint manifest and starts fresh', async (t) => {
  const root = makeOverCapRepo(t);
  const start = await runWorkflowCommand('start', persistentArgs(['review-fix-code', 'guard=snapshot']), { cwd: root });
  assert.equal(start.ok, true);
  assert.equal(start.status, 'partitioned-review');

  // A plain fresh start over the checkpoint state is refused (no silent reuse).
  await assert.rejects(
    runWorkflowCommand('start', persistentArgs(['review-fix-code', 'guard=snapshot']), { cwd: root }),
    (error) => error.code === 'ERR_STATE_EXISTS'
  );

  // reset ARCHIVES the checkpoint state (never deletes) and starts fresh.
  const reset = await runWorkflowCommand('start', persistentArgs(['review-fix-code', 'guard=snapshot', 'reset']), { cwd: root });
  assert.equal(reset.ok, true);
  assert.equal(reset.status, 'partitioned-review');
  assert.match(reset.archivedStatePath, /[\\/]\.drfx[\\/]archived[\\/]code-/);
  assert.equal(fs.existsSync(path.join(reset.archivedStatePath, 'MANIFEST.md')), true);
  // The archived manifest is the prior checkpoint.
  const archivedManifest = parseManifestV2(fs.readFileSync(path.join(reset.archivedStatePath, 'MANIFEST.md'), 'utf8'));
  assert.equal(archivedManifest.status, 'checkpoint');
  // The fresh checkpoint is rewritten under the same key.
  assert.equal(parseManifestV2(fs.readFileSync(reset.manifestPath, 'utf8')).status, 'checkpoint');
});

test('one-shot read-only --no-state over-cap CODE context returns a no-state partition plan and writes nothing', async (t) => {
  const root = makeOverCapRepo(t);
  const result = await runWorkflowCommand(
    'context',
    noStateContextArgs(['review-fix-code']),
    { cwd: root }
  );

  assert.equal(result.status, 'partitioned-review');
  assert.equal(result.reviewMode, 'partitioned');
  assert.equal(result.mode, 'read-only');
  assert.equal(result.targetStateDir, null);
  assert.ok(Number.isInteger(result.unitCount) && result.unitCount >= 1);
  assert.ok(typeof result.nextAction === 'string' && result.nextAction.length > 0);
  // No-state partitioned review is plan/advisory only — never a PASS.
  assert.notEqual(result.status, 'pass');
  // CRITICAL: it must NOT create any persistent state under .drfx/targets/.
  assert.equal(fs.existsSync(path.join(root, '.drfx', 'targets')), false);
  assert.equal(fs.existsSync(path.join(root, '.drfx')), false);
});

test('checkpoint manifest with Current phase review round-trips through formatManifestV2/parseManifestV2', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-checkpoint-'));
  const manifest = {
    manifestSchema: 2,
    targetContextKind: 'code',
    target: 'none',
    normalizedTarget: 'none',
    documentType: 'none',
    strictness: 'normal',
    mode: 'review-and-fix',
    guardMode: 'snapshot',
    targetKey: 'code-0123456789ab',
    ledgerPath: '.drfx/targets/code-0123456789ab/ISSUES.md',
    status: 'checkpoint',
    currentPhase: 'review',
    currentRound: 1,
    fixAttemptCount: 0,
    assurance: 'practical',
    runtimePlatform: 'codex',
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    runtimeSubagentProbe: 'ready',
    runtimeSubagentProbeEvidence: 'route-asserted-ready',
    runtimeFingerprintGuard: 'not-run',
    runtimeStdinHandoff: 'ready',
    runtimeStdinHandoffEvidence: 'route-asserted-ready',
    runtimeDowngradeReason: 'none',
    blockingReason: 'none',
    statusReason: 'checkpoint-requested',
    currentReportPath: 'none',
    lastReviewerReportPath: 'none',
    lastTriageReportPath: 'none',
    lastFixReportPath: 'none',
    lastDiffReviewReportPath: 'none',
    fileSetFingerprint: 'a'.repeat(64),
    lastModifiedAt: '2026-06-20T00:00:00.000Z',
    normalizedScopes: [],
    exclusions: ['node_modules'],
    userExcludes: [],
    references: [],
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z'
  };
  const manifestPath = path.join(root, 'MANIFEST.md');
  fs.writeFileSync(manifestPath, formatManifestV2(manifest));
  const parsed = readManifestAny(manifestPath);
  assert.equal(parsed.targetContextKind, 'code');
  assert.equal(parsed.status, 'checkpoint');
  assert.equal(parsed.currentPhase, 'review');
  assert.equal(parsed.statusReason, 'checkpoint-requested');
  assert.equal(parsed.blockingReason, 'none');
  assert.equal(parsed.fileSetFingerprint, 'a'.repeat(64));
  fs.rmSync(root, { recursive: true, force: true });
});
