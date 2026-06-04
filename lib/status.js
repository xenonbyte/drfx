'use strict';

// `drfx status`: report which generated routes are installed per platform by
// reading the install manifests. Read-only — it never probes capabilities or
// mutates state (that is `drfx doctor`).

const { parsePlatformList } = require('./install');
const { manifestPathForPlatform, readInstallManifest } = require('./manifest');

function runStatus(options = {}) {
  const platforms = parsePlatformList(options.platforms);
  const homeOpt = options.homeDir ? { homeDir: options.homeDir } : {};
  const report = {};
  for (const platform of platforms) {
    const manifestPath = manifestPathForPlatform(platform, homeOpt);
    const { missing, manifest } = readInstallManifest(platform, homeOpt);
    if (missing || !manifest) {
      report[platform] = { installed: false, manifestPath };
      continue;
    }
    report[platform] = {
      installed: true,
      manifestPath,
      packageVersion: manifest.packageVersion || null,
      installedAt: manifest.installedAt || null,
      updatedAt: manifest.updatedAt || null,
      installRoot: manifest.installRoot || null,
      generatedCount: Array.isArray(manifest.generated) ? manifest.generated.length : 0
    };
  }
  return { ok: true, platforms: report };
}

function formatStatusReport(result) {
  const lines = [];
  for (const [platform, info] of Object.entries(result.platforms)) {
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
