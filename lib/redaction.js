'use strict';

const MARKERS = Object.freeze({
  privateKey: '[REDACTED:private-key]',
  apiToken: '[REDACTED:api-token]',
  cookie: '[REDACTED:cookie]',
  credential: '[REDACTED:credential]'
});

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const COOKIE_HEADER_PATTERN = /(\b(?:Set-Cookie|Cookie):\s*)[^\r\n|]*/gi;
const URL_CREDENTIAL_PATTERN = /\b(https?:\/\/)[^\s/@|]+:[^\s/@|]+@/gi;
const BEARER_TOKEN_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/-]{8,}={0,2}/gi;
const KNOWN_API_TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/g;
const SLACK_WEBHOOK_PATTERN = /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g;
const API_ASSIGNMENT_PATTERN = /((?:"|')?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token)\b(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s|,;]+)/gi;
const CREDENTIAL_ASSIGNMENT_PATTERN = /((?:"|')?\b(?:user(?:name)?|login|password|passwd|pwd|secret|(?:api|auth|jwt|app|session|client)[_-]?secret|secret[_-]?key)\b(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s|,;]+)/gi;
const API_TOKEN_KEY_PATTERN = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token)$/i;
const COOKIE_KEY_PATTERN = /^(?:cookie|cookies|set-cookie)$/i;
const PRIVATE_KEY_KEY_PATTERN = /^(?:private[_-]?key|pem)$/i;
const CREDENTIAL_KEY_PATTERN = /^(?:user(?:name)?|login|password|passwd|pwd|secret|(?:api|auth|jwt|app|session|client)[_-]?secret|secret[_-]?key)$/i;

function redactSensitive(value) {
  if (value === null || value === undefined) return value;

  return String(value)
    .replace(PRIVATE_KEY_PATTERN, MARKERS.privateKey)
    .replace(COOKIE_HEADER_PATTERN, `$1${MARKERS.cookie}`)
    .replace(URL_CREDENTIAL_PATTERN, `$1${MARKERS.credential}@`)
    .replace(BEARER_TOKEN_PATTERN, `$1${MARKERS.apiToken}`)
    .replace(API_ASSIGNMENT_PATTERN, `$1${MARKERS.apiToken}`)
    .replace(KNOWN_API_TOKEN_PATTERN, MARKERS.apiToken)
    .replace(AWS_ACCESS_KEY_PATTERN, MARKERS.apiToken)
    .replace(SLACK_WEBHOOK_PATTERN, MARKERS.apiToken)
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, `$1${MARKERS.credential}`);
}

function redactSensitiveWithMeta(value) {
  const original = value === null || value === undefined ? value : String(value);
  const redacted = redactSensitive(value);
  return {
    value: redacted,
    redacted: redacted !== original
  };
}

function markerForKey(key) {
  if (PRIVATE_KEY_KEY_PATTERN.test(key)) return MARKERS.privateKey;
  if (COOKIE_KEY_PATTERN.test(key)) return MARKERS.cookie;
  if (API_TOKEN_KEY_PATTERN.test(key)) return MARKERS.apiToken;
  if (CREDENTIAL_KEY_PATTERN.test(key)) return MARKERS.credential;
  return null;
}

function redactFinding(value) {
  if (typeof value === 'string') return redactSensitive(value);
  if (Array.isArray(value)) return value.map((item) => redactFinding(item));
  if (!value || typeof value !== 'object') return value;

  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    const marker = markerForKey(key);
    redacted[key] = marker ? marker : redactFinding(item);
  }
  return redacted;
}

function redactMarkdown(markdown) {
  return redactSensitive(markdown);
}

module.exports = {
  redactSensitive,
  redactSensitiveWithMeta,
  redactFinding,
  redactMarkdown
};
