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
