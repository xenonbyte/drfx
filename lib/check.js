'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkPlatforms, validateCurrentDescriptor, createRunId } = require('./capability');
const { parsePlatformList } = require('./install');
const { readInstallManifest } = require('./manifest');

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return packageJson.version;
}

function writeDescriptor(homeDir, platform, descriptor) {
  const descriptorPath = path.join(homeDir, '.docs-review-fix', 'capabilities', `${platform}.json`);
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  return descriptorPath;
}

async function runCheck(options = {}) {
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const cwd = path.resolve(options.cwd || process.cwd());
  const packageVersion = options.packageVersion || readPackageVersion();
  const platforms = parsePlatformList(options.platforms);
  const runId = createRunId();
  const descriptors = await checkPlatforms({
    platforms,
    packageVersion,
    runId,
    tmpDir: options.tmpDir || os.tmpdir()
  });

  const platformReports = {};
  for (const platform of platforms) {
    const descriptorPath = writeDescriptor(homeDir, platform, descriptors[platform]);
    const validation = validateCurrentDescriptor(descriptors[platform], {
      packageVersion,
      platform,
      runId,
      requireVerified: true
    });
    platformReports[platform] = {
      manifest: readInstallManifest(platform, { homeDir }),
      descriptorPath,
      descriptor: descriptors[platform],
      validation,
      advisoryReason: validation.advisoryReason || descriptors[platform].advisoryReason
    };
  }

  return {
    packageVersion,
    runId,
    checkedAt: new Date().toISOString(),
    homeDir,
    cwd,
    platforms: platformReports,
    globalRule: {
      path: path.join(homeDir, '.docs-review-fix', 'RULE.md'),
      present: fs.existsSync(path.join(homeDir, '.docs-review-fix', 'RULE.md'))
    },
    preferences: {
      path: path.join(homeDir, '.docs-review-fix', 'preferences.md'),
      present: fs.existsSync(path.join(homeDir, '.docs-review-fix', 'preferences.md'))
    },
    projectState: {
      path: path.join(cwd, '.docs-review-fix'),
      present: fs.existsSync(path.join(cwd, '.docs-review-fix'))
    }
  };
}

function primaryStatus(platformReport) {
  const statuses = Object.values(platformReport.descriptor.capabilities).map((capability) => capability.status);
  if (statuses.every((status) => status === 'verified')) return 'verified';
  if (statuses.includes('unsupported')) return 'unsupported';
  return 'unverified';
}

function formatCheckReport(result) {
  const lines = [
    `drfx check ${result.packageVersion}`,
    `global rule: ${result.globalRule.present ? 'present' : 'missing'}`,
    `project state: ${result.projectState.present ? 'present' : 'missing'}`
  ];

  for (const [platform, report] of Object.entries(result.platforms)) {
    const manifestStatus = report.manifest.missing ? 'manifest missing' : 'manifest present';
    const status = primaryStatus(report);
    lines.push(`${platform}: ${status}; ${manifestStatus}`);
    if (report.advisoryReason) lines.push(`  Advisory-only: ${report.advisoryReason.replace(/^Advisory-only:\s*/i, '')}`);
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  runCheck,
  formatCheckReport
};
