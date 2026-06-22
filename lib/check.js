'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkPlatforms, validateCurrentDescriptor, createRunId } = require('./capability');
const { parsePlatformList } = require('./install');
const { readInstallManifest } = require('./manifest');
const { collectUnknownRuleFileWarnings } = require('./rulebook');

const DOCTOR_TEMP_DIR_STALE_MS = 24 * 60 * 60 * 1000;

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
}

function writeDescriptor(directory, platform, descriptor) {
  const descriptorPath = path.join(directory, `${platform}.json`);
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  return descriptorPath;
}

function sweepStaleDoctorTempDirs(tmpDir) {
  let entries;
  const now = Date.now();
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch (error) {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('drfx-doctor-')) {
      const entryPath = path.join(tmpDir, entry.name);
      let stats;
      try {
        stats = fs.statSync(entryPath);
      } catch (error) {
        continue;
      }
      if (now - stats.mtimeMs < DOCTOR_TEMP_DIR_STALE_MS) continue;
      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
      } catch (error) {
        // best-effort cleanup of stale descriptor temp dirs; never fail the doctor run
      }
    }
  }
}

async function runCheck(options = {}) {
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const cwd = path.resolve(options.cwd || process.cwd());
  const packageJson = readPackage();
  const packageName = options.packageName || packageJson.name;
  const packageVersion = options.packageVersion || packageJson.version;
  const platforms = parsePlatformList(options.platforms);
  const runId = createRunId();
  let descriptorDirectory;
  if (options.json) {
    const tmpDir = options.tmpDir || os.tmpdir();
    sweepStaleDoctorTempDirs(tmpDir);
    descriptorDirectory = fs.mkdtempSync(path.join(tmpDir, 'drfx-doctor-'));
  } else {
    descriptorDirectory = path.join(homeDir, '.drfx', 'capabilities');
  }
  const descriptors = await checkPlatforms({
    platforms,
    packageVersion,
    runId,
    tmpDir: options.tmpDir || os.tmpdir()
  });

  const platformReports = {};
  for (const platform of platforms) {
    const descriptorPath = writeDescriptor(descriptorDirectory, platform, descriptors[platform]);
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
    ok: true,
    packageName,
    packageVersion,
    runId,
    checkedAt: new Date().toISOString(),
    descriptorDirectory,
    homeDir,
    cwd,
    platforms: platformReports,
    userRules: {
      path: path.join(homeDir, '.drfx', 'rules'),
      present: fs.existsSync(path.join(homeDir, '.drfx', 'rules')),
      staleRulePath: path.join(homeDir, '.drfx', 'RULE.md'),
      staleRulePresent: fs.existsSync(path.join(homeDir, '.drfx', 'RULE.md'))
    },
    preferences: {
      path: path.join(homeDir, '.drfx', 'preferences.md'),
      present: fs.existsSync(path.join(homeDir, '.drfx', 'preferences.md'))
    },
    projectRules: {
      path: path.join(cwd, '.drfx', 'rules'),
      present: fs.existsSync(path.join(cwd, '.drfx', 'rules')),
      staleRulePath: path.join(cwd, '.drfx', 'RULE.md'),
      staleRulePresent: fs.existsSync(path.join(cwd, '.drfx', 'RULE.md'))
    },
    ruleWarnings: collectUnknownRuleFileWarnings({ homeDir, projectRoot: cwd }),
    projectState: {
      path: path.join(cwd, '.drfx'),
      present: fs.existsSync(path.join(cwd, '.drfx'))
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
    `drfx doctor ${result.packageVersion}`,
    `user rules: ${result.userRules.present ? 'present' : 'missing'}${result.userRules.staleRulePresent ? '; stale RULE.md present' : ''}`,
    `project rules: ${result.projectRules.present ? 'present' : 'missing'}${result.projectRules.staleRulePresent ? '; stale RULE.md present' : ''}`,
    `project state: ${result.projectState.present ? 'present' : 'missing'}`
  ];

  for (const [platform, report] of Object.entries(result.platforms)) {
    const manifestStatus = report.manifest.missing ? 'manifest missing' : 'manifest present';
    const status = primaryStatus(report);
    lines.push(`${platform}: ${status}; ${manifestStatus}`);
    if (report.advisoryReason) lines.push(`  Advisory-only: ${report.advisoryReason.replace(/^Advisory-only:\s*/i, '')}`);
  }
  for (const warning of result.ruleWarnings || []) {
    lines.push(`warn: ${warning.message}`);
  }

  return `${lines.join('\n')}\n`;
}

function formatCheckJson(result) {
  const platforms = {};
  for (const [platform, report] of Object.entries(result.platforms)) {
    platforms[platform] = {
      descriptorPath: report.descriptorPath,
      validation: report.validation,
      advisoryReason: report.advisoryReason || null
    };
  }

  return `${JSON.stringify({
    ok: result.ok,
    packageName: result.packageName,
    packageVersion: result.packageVersion,
    runId: result.runId,
    checkedAt: result.checkedAt,
    descriptorDirectory: result.descriptorDirectory,
    ruleWarnings: result.ruleWarnings || [],
    platforms
  })}\n`;
}

module.exports = {
  runCheck,
  formatCheckReport,
  formatCheckJson,
  sweepStaleDoctorTempDirs
};
