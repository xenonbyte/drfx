'use strict';

// `drfx status`: report which generated routes are installed per platform by
// reading the install manifests. Read-only — it never probes capabilities or
// mutates state (that is `drfx doctor`).

const { parsePlatformList } = require('./install');
const { SCHEMA_VERSION, manifestPathForPlatform, readInstallManifest } = require('./manifest');

// A syntactically parseable manifest is not necessarily a complete one (e.g. a
// truncated write). Only treat a platform as installed when the manifest carries
// the required, well-typed fields for the platform it claims.
function isWellFormedManifest(manifest, platform) {
  return Boolean(
    manifest &&
    [1, SCHEMA_VERSION].includes(manifest.schemaVersion) &&
    manifest.platform === platform &&
    typeof manifest.packageVersion === 'string' &&
    manifest.packageVersion.length > 0 &&
    Array.isArray(manifest.generated)
  );
}

function runStatus(options = {}) {
  const platforms = parsePlatformList(options.platforms);
  const homeOpt = options.homeDir ? { homeDir: options.homeDir } : {};
  const report = {};
  for (const platform of platforms) {
    const manifestPath = manifestPathForPlatform(platform, homeOpt);
    let read;
    try {
      read = readInstallManifest(platform, homeOpt);
    } catch (error) {
      report[platform] = { installed: false, invalid: true, manifestPath, reason: error && error.message ? error.message : String(error) };
      continue;
    }
    if (read.missing || !read.manifest) {
      report[platform] = { installed: false, manifestPath };
      continue;
    }
    if (!isWellFormedManifest(read.manifest, platform)) {
      report[platform] = { installed: false, invalid: true, manifestPath, reason: 'manifest is missing required fields' };
      continue;
    }
    const manifest = read.manifest;
    report[platform] = {
      installed: true,
      manifestPath,
      packageVersion: manifest.packageVersion,
      installedAt: manifest.installedAt || null,
      updatedAt: manifest.updatedAt || null,
      installRoot: manifest.installRoot || null,
      generatedCount: manifest.generated.length
    };
  }
  return { ok: true, platforms: report };
}

function formatStatusReport(result) {
  const lines = [];
  for (const [platform, info] of Object.entries(result.platforms)) {
    if (info.invalid) {
      lines.push(`${platform}: invalid manifest (${info.reason || 'corrupt state'})`);
      lines.push(`  manifest: ${info.manifestPath}`);
      continue;
    }
    if (!info.installed) {
      lines.push(`${platform}: not installed`);
      continue;
    }
    const version = info.packageVersion ? ` (v${info.packageVersion})` : '';
    const entries = info.generatedCount === 1 ? 'entry' : 'entries';
    lines.push(`${platform}: installed${version} — ${info.generatedCount} generated ${entries}`);
    lines.push(`  manifest: ${info.manifestPath}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatStatusJson(result) {
  return `${JSON.stringify(result)}\n`;
}

module.exports = {
  runStatus,
  formatStatusReport,
  formatStatusJson
};
