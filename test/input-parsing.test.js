'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseInvocation, parseNaturalLanguageInvocation, validateEntryPaths, DOCUMENT_TYPES } = require('../lib/input');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-input-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'target.md'), '# Target\n');
  fs.writeFileSync(path.join(root, 'docs', 'ref one.md'), '# Reference\n');
  return root;
}

test('maps entry skills to fixed document types', () => {
  assert.equal(DOCUMENT_TYPES['review-fix-spec'], 'SPEC');
  assert.equal(DOCUMENT_TYPES['review-fix-plan'], 'PLAN');
  assert.equal(DOCUMENT_TYPES['review-fix-design'], 'DESIGN');
  assert.equal(DOCUMENT_TYPES['review-fix-doc'], 'COMMON');
});

test('parses structured tokens with target, repeated refs, flags, ledger, and root', () => {
  const parsed = parseInvocation('review-fix-spec', [
    'target=docs/target.md',
    'ref=docs/ref.md',
    'ref=docs/ref.md',
    'strict',
    'read-only',
    'resume',
    'ledger=.docs-review-fix/targets/key/ISSUES.md',
    'root=/tmp/project'
  ]);

  assert.equal(parsed.entrySkill, 'review-fix-spec');
  assert.equal(parsed.documentType, 'SPEC');
  assert.equal(parsed.target, 'docs/target.md');
  assert.deepEqual(parsed.refs, ['docs/ref.md']);
  assert.equal(parsed.strictness, 'strict');
  assert.equal(parsed.mode, 'read-only');
  assert.equal(parsed.resume, true);
  assert.equal(parsed.ledger, '.docs-review-fix/targets/key/ISSUES.md');
  assert.equal(parsed.root, '/tmp/project');
});

test('preserves v1 parser behavior when options are omitted', () => {
  assert.throws(
    () => parseInvocation('review-fix-spec', ['target=docs/spec.md', 'assurance=practical']),
    /unknown token/i
  );
  const parsed = parseInvocation('review-fix-spec', ['target=docs/spec.md']);
  assert.equal(parsed.mode, 'review-and-fix');
  assert.equal(Object.hasOwn(parsed, 'requestedAssurance'), false);
});

test('parses workflow metadata when includeMetadata is true', () => {
  const parsed = parseInvocation('review-fix-spec', [
    'target=docs/spec.md',
    'read-only',
    'assurance=practical',
    'guard=snapshot'
  ], {
    defaultMode: 'read-only',
    defaultAssurance: 'practical',
    includeMetadata: true
  });
  assert.equal(parsed.requestedMode, 'read-only');
  assert.equal(parsed.mode, 'read-only');
  assert.equal(parsed.modeSource, 'explicit');
  assert.equal(parsed.modeNormalizedFrom, null);
  assert.equal(parsed.requestedAssurance, 'practical');
  assert.equal(parsed.assuranceSource, 'explicit');
  assert.equal(parsed.guardMode, 'snapshot');
});

test('workflow metadata keeps strictness separate from assurance', () => {
  const parsed = parseInvocation('review-fix-design', ['target=design/DESIGN-v2.md', 'strict'], {
    defaultMode: 'read-only',
    defaultAssurance: 'advisory',
    includeMetadata: true
  });
  assert.equal(parsed.strictness, 'strict');
  assert.equal(parsed.requestedAssurance, 'advisory');
  assert.equal(parsed.guardMode, 'git');
});

test('parses guard token with git default and rejects invalid or duplicate guard mode', () => {
  assert.equal(parseInvocation('review-fix-spec', ['target=docs/spec.md']).guardMode, 'git');
  assert.equal(parseInvocation('review-fix-spec', ['target=docs/spec.md', 'guard=git']).guardMode, 'git');
  assert.equal(parseInvocation('review-fix-spec', ['target=docs/spec.md', 'guard=snapshot']).guardMode, 'snapshot');
  assert.throws(
    () => parseInvocation('review-fix-spec', ['target=docs/spec.md', 'guard=none']),
    /guard/i
  );
  assert.throws(
    () => parseInvocation('review-fix-spec', ['target=docs/spec.md', 'guard=git', 'guard=snapshot']),
    /duplicate guard/i
  );
});

test('rejects duplicate target and duplicate root', () => {
  assert.throws(() => parseInvocation('review-fix-plan', ['target=a.md', 'target=b.md']), /duplicate target/i);
  assert.throws(() => parseInvocation('review-fix-plan', ['root=/a', 'root=/b', 'target=a.md']), /duplicate root/i);
});

test('rejects unlabeled extra path when target= is present', () => {
  assert.throws(() => parseInvocation('review-fix-plan', ['target=a.md', 'b.md']), /unlabeled/i);
});

test('rejects conflicting flags and unknown tokens', () => {
  assert.throws(() => parseInvocation('review-fix-plan', ['a.md', 'strict', 'normal']), /strict.*normal/i);
  assert.throws(() => parseInvocation('review-fix-plan', ['a.md', 'read-only', 'review-and-fix']), /read-only.*review-and-fix/i);
  assert.throws(() => parseInvocation('review-fix-plan', ['--mystery']), /unknown/i);
  assert.throws(() => parseInvocation('review-fix-plan', ['target=a.md', '--mystery']), /unknown/i);
});

test('rejects type override from user input', () => {
  assert.throws(() => parseInvocation('review-fix-spec', ['target=a.md', 'type=PLAN']), /type/i);
});

test('rejects missing target and unknown entry skill', () => {
  assert.throws(() => parseInvocation('review-fix-spec', ['strict']), /missing target/i);
  assert.throws(() => parseInvocation('review-fix-unknown', ['target=a.md']), /unknown entry skill/i);
});

test('requires shell-preserved path tokens', () => {
  const parsed = parseInvocation('review-fix-doc', [
    'target=docs/host preserved target.md',
    'ref=docs/ref one.md'
  ]);
  assert.equal(parsed.target, 'docs/host preserved target.md');
  assert.deepEqual(parsed.refs, ['docs/ref one.md']);
  assert.throws(() => parseInvocation('review-fix-doc', ['target=docs/ref', 'one.md']), /unlabeled/i);
});

test('parses explicit natural-language target and references', () => {
  const parsed = parseNaturalLanguageInvocation('review-fix-spec', '修改 docs/spec.md，参考 docs/prd.md');

  assert.equal(parsed.entrySkill, 'review-fix-spec');
  assert.equal(parsed.documentType, 'SPEC');
  assert.equal(parsed.target, 'docs/spec.md');
  assert.deepEqual(parsed.refs, ['docs/prd.md']);
});

test('rejects natural-language ambiguity', () => {
  assert.throws(
    () => parseNaturalLanguageInvocation('review-fix-spec', '处理 docs/spec.md 和 docs/prd.md'),
    /ambiguous/i
  );
});

test('validates target, refs, root containment, and external readonly refs', () => {
  const root = makeWorkspace();
  const external = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-ext-')), 'external.md');
  fs.writeFileSync(external, '# External\n');

  const result = validateEntryPaths({
    target: path.join(root, 'docs', 'target.md'),
    refs: [path.join(root, 'docs', 'ref one.md'), external],
    root
  });

  assert.equal(result.targetPath, fs.realpathSync.native(path.join(root, 'docs', 'target.md')));
  assert.equal(result.projectRoot, fs.realpathSync.native(root));
  assert.equal(result.references.length, 2);
  assert.equal(result.references[0].external, false);
  assert.equal(result.references[0].readOnly, true);
  assert.equal(result.references[1].external, true);
  assert.equal(result.references[1].readOnly, true);
});

test('rejects missing target, missing ref, bad root, target escape, and ref equal target', () => {
  const root = makeWorkspace();
  const target = path.join(root, 'docs', 'target.md');
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-other-root-'));

  assert.throws(() => validateEntryPaths({ target: path.join(root, 'docs', 'missing.md'), refs: [], root }), /target.*exist/i);
  assert.throws(() => validateEntryPaths({ target, refs: [path.join(root, 'docs', 'missing.md')], root }), /reference.*exist/i);
  assert.throws(() => validateEntryPaths({ target, refs: [], root: path.join(root, 'missing-root') }), /root.*exist/i);
  assert.throws(() => validateEntryPaths({ target, refs: [], root: otherRoot }), /root.*contain/i);
  assert.throws(() => validateEntryPaths({ target, refs: [target], root }), /reference.*target/i);
});

test('uses realpaths for root containment and reference equality', () => {
  const root = makeWorkspace();
  const target = path.join(root, 'docs', 'target.md');
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-real-outside-'));
  const outsideTarget = path.join(outsideRoot, 'outside.md');
  fs.writeFileSync(outsideTarget, '# Outside\n');

  const escapingTargetLink = path.join(root, 'docs', 'escaping-target.md');
  fs.symlinkSync(outsideTarget, escapingTargetLink);
  assert.throws(() => validateEntryPaths({ target: escapingTargetLink, refs: [], root }), /contain|escape/i);

  const refLinkToTarget = path.join(root, 'docs', 'ref-link.md');
  fs.symlinkSync(target, refLinkToTarget);
  assert.throws(() => validateEntryPaths({ target, refs: [refLinkToTarget], root }), /reference.*target/i);
});
