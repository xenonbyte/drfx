'use strict';

function canonicalFingerprint(fingerprint, normalizedPath = null) {
  const canonical = {
    sha256: fingerprint.sha256,
    size: Number(fingerprint.size),
    mtimeMs: Math.trunc(Number(fingerprint.mtimeMs))
  };
  if (normalizedPath) canonical.normalizedPath = normalizedPath;
  return canonical;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

module.exports = {
  canonicalFingerprint,
  stableJson
};
