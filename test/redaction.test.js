'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { redactSensitive, redactFinding, redactMarkdown, redactSensitiveWithMeta } = require('../lib/redaction');

function assertNoRawSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [
    'sk-live-1234567890abcdef',
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'abc.def.ghi',
    'super-session-value',
    'username=reviewer',
    'password=hunter2',
    'token=plain-secret-token',
    'BEGIN PRIVATE KEY',
    'line-one-secret',
    'line-two-secret'
  ]) {
    assert.equal(text.includes(secret), false, `raw secret leaked: ${secret}`);
  }
}

test('redacts API tokens without preserving prefix suffix hash or checksum', () => {
  const text = 'token sk-live-1234567890abcdef and github ghp_abcdefghijklmnopqrstuvwxyz123456';

  assert.equal(redactSensitive(text), 'token [REDACTED:api-token] and github [REDACTED:api-token]');
  assertNoRawSecrets(redactSensitive(text));
});

test('redacts bearer token values while preserving the authorization scheme', () => {
  const text = 'Authorization: Bearer sk-live-1234567890abcdef';

  assert.equal(redactSensitive(text), 'Authorization: Bearer [REDACTED:api-token]');
  assertNoRawSecrets(redactSensitive(text));
});

test('redacts PEM private key blocks as a single canonical marker', () => {
  const text = '-----BEGIN PRIVATE KEY-----\nline-one-secret\nline-two-secret\n-----END PRIVATE KEY-----';

  assert.equal(redactSensitive(text), '[REDACTED:private-key]');
  assertNoRawSecrets(redactSensitive(text));
});

test('redacts cookie header and set-cookie values', () => {
  assert.equal(
    redactSensitive('Cookie: session=super-session-value; theme=light'),
    'Cookie: [REDACTED:cookie]'
  );
  assert.equal(
    redactSensitive('Set-Cookie: session=super-session-value; HttpOnly; Path=/'),
    'Set-Cookie: [REDACTED:cookie]'
  );
  assertNoRawSecrets(redactSensitive('Cookie: session=super-session-value; theme=light'));
});

test('redacts credential assignments and URLs', () => {
  const text = 'login username=reviewer password=hunter2 token=plain-secret-token url=https://alice:hunter2@example.test/path';

  assert.equal(
    redactSensitive(text),
    'login username=[REDACTED:credential] password=[REDACTED:credential] token=[REDACTED:api-token] url=https://[REDACTED:credential]@example.test/path'
  );
  assertNoRawSecrets(redactSensitive(text));
});

test('recursively redacts finding report objects without mutating input', () => {
  const finding = {
    id: 'ISSUE-001',
    issue: 'leaks token sk-live-1234567890abcdef',
    token: 'plain-secret-token',
    password: 'hunter2',
    evidence: {
      header: 'Authorization: Bearer abc.def.ghi',
      cookie: 'Cookie: session=super-session-value'
    },
    sensitive: true
  };

  const redacted = redactFinding(finding);

  assert.equal(redacted.issue, 'leaks token [REDACTED:api-token]');
  assert.equal(redacted.token, '[REDACTED:api-token]');
  assert.equal(redacted.password, '[REDACTED:credential]');
  assert.deepEqual(redacted.evidence, {
    header: 'Authorization: Bearer [REDACTED:api-token]',
    cookie: '[REDACTED:cookie]'
  });
  assert.equal(finding.issue, 'leaks token sk-live-1234567890abcdef');
  assertNoRawSecrets(redacted);
});

test('redacts markdown ledger rows', () => {
  const markdown = [
    '| ID | Status | Finding | Evidence |',
    '| --- | --- | --- | --- |',
    '| ISSUE-001 | open | leaked password=hunter2 | Authorization: Bearer sk-live-1234567890abcdef |',
    '| ISSUE-002 | open | cookie leak | Cookie: session=super-session-value |'
  ].join('\n');

  const redacted = redactMarkdown(markdown);

  assert.match(redacted, /\[REDACTED:credential\]/);
  assert.match(redacted, /\[REDACTED:api-token\]/);
  assert.match(redacted, /\[REDACTED:cookie\]/);
  assertNoRawSecrets(redacted);
});

test('redacts quoted assignment keys in structured snippets', () => {
  const text = '{"password": "hunter2", "token": "plain-secret-token"}';

  assert.equal(
    redactSensitive(text),
    '{"password": [REDACTED:credential], "token": [REDACTED:api-token]}'
  );
  assertNoRawSecrets(redactSensitive(text));
});

test('reports whether sensitive text was redacted', () => {
  assert.deepEqual(redactSensitiveWithMeta('plain text'), {
    value: 'plain text',
    redacted: false
  });

  const result = redactSensitiveWithMeta('Authorization: Bearer sk-live-1234567890abcdef');
  assert.equal(result.redacted, true);
  assert.equal(result.value, 'Authorization: Bearer [REDACTED:api-token]');
  assertNoRawSecrets(result.value);
});
