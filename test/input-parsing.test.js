'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseInvocation, parseNaturalLanguageInvocation, validateEntryPaths, DOCUMENT_TYPES } = require('../lib/input');
const { getRouteDescriptor, listDocumentRoutes } = require('../lib/routes');

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
    'ledger=.drfx/targets/key/ISSUES.md',
    'root=/tmp/project'
  ]);

  assert.equal(parsed.entrySkill, 'review-fix-spec');
  assert.equal(parsed.documentType, 'SPEC');
  assert.equal(parsed.target, 'docs/target.md');
  assert.deepEqual(parsed.refs, ['docs/ref.md']);
  assert.equal(parsed.strictness, 'strict');
  assert.equal(parsed.mode, 'read-only');
  assert.equal(parsed.resume, true);
  assert.equal(parsed.ledger, '.drfx/targets/key/ISSUES.md');
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

// ---------------------------------------------------------------------------
// Compatibility: DOCUMENT_TYPES in input.js must stay aligned with routes registry
// ---------------------------------------------------------------------------

test('DOCUMENT_TYPES aligns with route registry documentType values', () => {
  for (const route of listDocumentRoutes()) {
    assert.equal(
      DOCUMENT_TYPES[route.routeName],
      route.documentType,
      `DOCUMENT_TYPES['${route.routeName}'] must match registry documentType`
    );
  }
});

// ---------------------------------------------------------------------------
// review-fix-pr parser tests
// ---------------------------------------------------------------------------

test('review-fix-pr requires base token and defaults mode and guardMode', () => {
  const result = parseInvocation('review-fix-pr', ['base=main']);
  assert.equal(result.entrySkill, 'review-fix-pr');
  assert.equal(result.routeKind, 'pr');
  assert.equal(result.documentType, null);
  assert.equal(result.base, 'main');
  assert.equal(result.mode, 'review-and-fix');
  assert.equal(result.guardMode, 'git');
  assert.equal(result.resume, false);
  assert.equal(result.root, null);
  assert.equal(result.roundLimit, null);
});

test('review-fix-pr throws usage error when base is missing', () => {
  assert.throws(
    () => parseInvocation('review-fix-pr', []),
    (error) => typeof error.code === 'string' && /base/i.test(error.message)
  );
  assert.throws(
    () => parseInvocation('review-fix-pr', ['read-only']),
    (error) => typeof error.code === 'string' && /base/i.test(error.message)
  );
});

test('review-fix-pr accepts explicit mode, guard, resume, root, and rounds', () => {
  const result = parseInvocation('review-fix-pr', [
    'base=origin/main',
    'review-and-fix',
    'guard=snapshot',
    'resume',
    'root=/project',
    'rounds=3'
  ]);
  assert.equal(result.base, 'origin/main');
  assert.equal(result.mode, 'review-and-fix');
  assert.equal(result.guardMode, 'snapshot');
  assert.equal(result.resume, true);
  assert.equal(result.root, '/project');
  assert.equal(result.roundLimit, 3);
});

test('review-fix-pr rejects document-only tokens: target, ref, strict, normal, assurance, ledger, type', () => {
  assert.throws(() => parseInvocation('review-fix-pr', ['base=main', 'target=foo.md']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-pr', ['base=main', 'ref=foo.md']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-pr', ['base=main', 'strict']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-pr', ['base=main', 'normal']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-pr', ['base=main', 'assurance=practical']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-pr', ['base=main', 'ledger=ISSUES.md']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-pr', ['base=main', 'type=SPEC']), /unknown token/i);
});

test('review-fix-pr rejects scope token (CODE-only)', () => {
  assert.throws(() => parseInvocation('review-fix-pr', ['base=main', 'scope=src/']), /unknown token/i);
});

test('review-fix-pr rejects duplicate base', () => {
  assert.throws(
    () => parseInvocation('review-fix-pr', ['base=main', 'base=other']),
    /duplicate base/i
  );
});

test('review-fix-pr rejects conflicting mode flags', () => {
  assert.throws(
    () => parseInvocation('review-fix-pr', ['base=main', 'read-only', 'review-and-fix']),
    /read-only.*review-and-fix/i
  );
});

test('review-fix-pr rejects read-only rounds=<n> (unsupported loop semantics)', () => {
  assert.throws(
    () => parseInvocation('review-fix-pr', ['base=main', 'read-only', 'rounds=2']),
    (error) => typeof error.code === 'string' && /rounds/i.test(error.message)
  );
});

test('review-fix-pr with includeMetadata exposes routeKind and requestedMode', () => {
  const result = parseInvocation('review-fix-pr', ['base=main', 'review-and-fix'], {
    defaultMode: 'read-only',
    includeMetadata: true
  });
  assert.equal(result.routeKind, 'pr');
  assert.equal(result.requestedMode, 'review-and-fix');
  assert.equal(result.modeSource, 'explicit');
});

// ---------------------------------------------------------------------------
// review-fix-code parser tests
// ---------------------------------------------------------------------------

test('review-fix-code accepts zero scopes (whole project root) and defaults mode and guardMode', () => {
  const result = parseInvocation('review-fix-code', []);
  assert.equal(result.entrySkill, 'review-fix-code');
  assert.equal(result.routeKind, 'code');
  assert.equal(result.documentType, null);
  assert.deepEqual(result.scopes, []);
  assert.equal(result.mode, 'review-and-fix');
  assert.equal(result.guardMode, 'git');
  assert.equal(result.resume, false);
  assert.equal(result.root, null);
  assert.equal(result.roundLimit, null);
});

test('review-fix-code accepts repeated scope= paths', () => {
  const result = parseInvocation('review-fix-code', ['scope=src/', 'scope=lib/']);
  assert.deepEqual(result.scopes, ['src/', 'lib/']);
});

test('review-fix-code rejects base= token with message referencing review-fix-pr', () => {
  assert.throws(
    () => parseInvocation('review-fix-code', ['base=main']),
    (error) => typeof error.code === 'string' && /review-fix-pr/.test(error.message)
  );
});

test('review-fix-code rejects document-only tokens: target, ref, strict, normal, assurance, ledger, type', () => {
  assert.throws(() => parseInvocation('review-fix-code', ['target=foo.md']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-code', ['ref=foo.md']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-code', ['strict']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-code', ['normal']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-code', ['assurance=practical']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-code', ['ledger=ISSUES.md']), /unknown token/i);
  assert.throws(() => parseInvocation('review-fix-code', ['type=SPEC']), /unknown token/i);
});

test('review-fix-code accepts explicit mode, guard, resume, root, and rounds', () => {
  const result = parseInvocation('review-fix-code', [
    'scope=src/',
    'review-and-fix',
    'guard=snapshot',
    'resume',
    'root=/project',
    'rounds=5'
  ]);
  assert.deepEqual(result.scopes, ['src/']);
  assert.equal(result.mode, 'review-and-fix');
  assert.equal(result.guardMode, 'snapshot');
  assert.equal(result.resume, true);
  assert.equal(result.root, '/project');
  assert.equal(result.roundLimit, 5);
});

test('review-fix-code rejects read-only rounds=<n> (unsupported loop semantics)', () => {
  assert.throws(
    () => parseInvocation('review-fix-code', ['read-only', 'rounds=2']),
    (error) => typeof error.code === 'string' && /rounds/i.test(error.message)
  );
});

test('review-fix-code with includeMetadata exposes routeKind and requestedMode', () => {
  const result = parseInvocation('review-fix-code', ['scope=src/'], {
    defaultMode: 'read-only',
    includeMetadata: true
  });
  assert.equal(result.routeKind, 'code');
  assert.equal(result.requestedMode, 'read-only');
  assert.equal(result.modeSource, 'default');
});

// ---------------------------------------------------------------------------
// rounds=<n> token tests (all six routes — document routes tested here)
// ---------------------------------------------------------------------------

test('document routes accept valid rounds=<n> and expose roundLimit', () => {
  const result = parseInvocation('review-fix-spec', ['target=docs/spec.md', 'rounds=3']);
  assert.equal(result.roundLimit, 3);
});

test('document routes roundLimit is null when rounds is omitted', () => {
  const result = parseInvocation('review-fix-spec', ['target=docs/spec.md']);
  assert.equal(result.roundLimit, null);
});

test('rounds=<n> rejects zero', () => {
  assert.throws(
    () => parseInvocation('review-fix-spec', ['target=docs/spec.md', 'rounds=0']),
    (error) => typeof error.code === 'string' && /rounds/i.test(error.message)
  );
});

test('rounds=<n> rejects negative integers', () => {
  assert.throws(
    () => parseInvocation('review-fix-spec', ['target=docs/spec.md', 'rounds=-1']),
    (error) => typeof error.code === 'string' && /rounds/i.test(error.message)
  );
});

test('rounds=<n> rejects non-integer values', () => {
  assert.throws(
    () => parseInvocation('review-fix-spec', ['target=docs/spec.md', 'rounds=1.5']),
    (error) => typeof error.code === 'string' && /rounds/i.test(error.message)
  );
  assert.throws(
    () => parseInvocation('review-fix-spec', ['target=docs/spec.md', 'rounds=abc']),
    (error) => typeof error.code === 'string' && /rounds/i.test(error.message)
  );
});

test('rounds=<n> rejects hex, scientific, padded, and leading-zero values (strict decimal integer)', () => {
  for (const value of ['0x3', '1e2', ' 3', '3 ', '03', '+3', '3px']) {
    assert.throws(
      () => parseInvocation('review-fix-spec', ['target=docs/spec.md', `rounds=${value}`]),
      (error) => error.code === 'ERR_ROUNDS_INVALID',
      `rounds=${value} must throw ERR_ROUNDS_INVALID`
    );
  }
});

test('rounds=<n> rejects missing value (bare rounds=)', () => {
  assert.throws(
    () => parseInvocation('review-fix-spec', ['target=docs/spec.md', 'rounds=']),
    (error) => typeof error.code === 'string' && /rounds/i.test(error.message)
  );
});

test('rounds=<n> rejects duplicate rounds token', () => {
  assert.throws(
    () => parseInvocation('review-fix-spec', ['target=docs/spec.md', 'rounds=2', 'rounds=3']),
    /duplicate rounds/i
  );
});

test('document route read-only rounds=<n> is unsupported', () => {
  assert.throws(
    () => parseInvocation('review-fix-spec', ['target=docs/spec.md', 'read-only', 'rounds=2']),
    (error) => typeof error.code === 'string' && /rounds/i.test(error.message)
  );
});

test('route registry documentType matches getRouteDescriptor for all four document routes', () => {
  const pairs = [
    ['review-fix-spec', 'SPEC'],
    ['review-fix-plan', 'PLAN'],
    ['review-fix-design', 'DESIGN'],
    ['review-fix-doc', 'COMMON'],
  ];
  for (const [routeName, expectedType] of pairs) {
    assert.equal(getRouteDescriptor(routeName).documentType, expectedType);
  }
});
