'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claude = require('./adapters/claude');
const codex = require('./adapters/codex');
const gemini = require('./adapters/gemini');
const opencode = require('./adapters/opencode');
const { buildDescriptor } = require('./capability');
const { ROUTES, generatePlatformFiles, copySharedAssets } = require('./generator');
const {
  SCHEMA_VERSION,
  manifestPathForPlatform,
  readInstallManifest,
  validateGeneratedRemoval,
  writeInstallManifest,
  directoryTreeMetadata
} = require('./manifest');

const PACKAGE_NAME = '@xenonbyte/drfx';
const PLATFORMS = ['claude', 'codex', 'gemini', 'opencode'];
const OWNERSHIP_MARKER = '.drfx-owned';
const ADAPTERS = { claude, codex, gemini, opencode };

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return packageJson.version;
}

function parsePlatformList(value) {
  const raw = Array.isArray(value) ? value.join(',') : value;
  if (raw === undefined || raw === null || raw === '') return [...PLATFORMS];
  if (typeof raw !== 'string') fail('ERR_PLATFORM_LIST', 'platform list must be a comma-separated string');
  const platforms = raw
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean);
  if (platforms.length === 0) fail('ERR_PLATFORM_LIST', 'platform list must include at least one platform');
  const seen = new Set();
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform)) fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
    if (seen.has(platform)) fail('ERR_PLATFORM_DUPLICATE', `duplicate platform: ${platform}`);
    seen.add(platform);
  }
  return platforms;
}

function hasBasename(filePath, basename) {
  return path.basename(path.resolve(filePath)) === basename;
}

function normalizePlatformRoots(homeDir, platformRoots = {}) {
  const claudeRoot = platformRoots.claude
    ? hasBasename(platformRoots.claude, 'commands')
      ? path.dirname(platformRoots.claude)
      : platformRoots.claude
    : path.join(homeDir, '.claude');
  const claudeCommands = platformRoots.claude && hasBasename(platformRoots.claude, 'commands')
    ? platformRoots.claude
    : path.join(claudeRoot, 'commands');

  const codexRoot = platformRoots.codex || (platformRoots.codexSkills ? path.dirname(platformRoots.codexSkills) : path.join(homeDir, '.codex'));
  const codexSkills = platformRoots.codexSkills || path.join(codexRoot, 'skills');
  const codexPrompts = platformRoots.codexPrompts || path.join(codexRoot, 'prompts');

  const geminiRoot = platformRoots.gemini
    ? hasBasename(platformRoots.gemini, 'commands')
      ? path.dirname(platformRoots.gemini)
      : platformRoots.gemini
    : path.join(homeDir, '.gemini');
  const geminiCommands = platformRoots.gemini && hasBasename(platformRoots.gemini, 'commands')
    ? platformRoots.gemini
    : path.join(geminiRoot, 'commands');

  const opencodeRoot = platformRoots.opencode
    ? hasBasename(platformRoots.opencode, 'commands')
      ? path.dirname(platformRoots.opencode)
      : platformRoots.opencode
    : path.join(homeDir, '.config', 'opencode');
  const opencodeCommands = platformRoots.opencode && hasBasename(platformRoots.opencode, 'commands')
    ? platformRoots.opencode
    : path.join(opencodeRoot, 'commands');

  return {
    installRoots: {
      claude: path.resolve(claudeRoot),
      codex: path.resolve(codexRoot),
      gemini: path.resolve(geminiRoot),
      opencode: path.resolve(opencodeRoot)
    },
    allowedRoots: {
      claude: path.resolve(claudeCommands),
      codex: path.resolve(codexSkills),
      gemini: path.resolve(geminiCommands),
      opencode: path.resolve(opencodeCommands)
    },
    codexPrompts: path.resolve(codexPrompts),
    manifestPlatformRoots: {
      claude: path.resolve(claudeRoot),
      codex: path.resolve(codexRoot),
      gemini: path.resolve(geminiRoot),
      opencode: path.resolve(opencodeRoot)
    }
  };
}

function ensureBaseDirectories(platform, roots, homeDir, cwd) {
  fs.mkdirSync(homeDir, { recursive: true });
  if (cwd) fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(roots.installRoots[platform], { recursive: true });
  fs.mkdirSync(roots.allowedRoots[platform], { recursive: true });
  if (platform === 'codex') fs.mkdirSync(roots.codexPrompts, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.drfx', 'capabilities'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.drfx', 'backups', platform), { recursive: true });
}

function hasOwnershipMarker(directoryPath) {
  const markerPath = path.join(directoryPath, OWNERSHIP_MARKER);
  if (!pathExists(markerPath)) return false;
  const stat = fs.lstatSync(markerPath);
  return stat.isFile() && fs.readFileSync(markerPath, 'utf8').includes(PACKAGE_NAME);
}

function hasFileOwnershipMarker(filePath) {
  if (!pathExists(filePath)) return false;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) fail('ERR_REMOVE_SYMLINK', `refusing to remove symlink: ${filePath}`);
  if (!stat.isFile()) return false;
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .some((line) => line.startsWith(`Generated by \`${PACKAGE_NAME}\``));
}

function codexLegacyPromptTargets(roots) {
  return Object.keys(ROUTES).map((routeName) => path.join(roots.codexPrompts, `${routeName}.md`));
}

function ownershipMarkedCodexLegacyPrompts(roots, recordedPaths = new Set()) {
  const prompts = [];
  for (const promptPath of codexLegacyPromptTargets(roots)) {
    if (recordedPaths.has(promptPath)) continue;
    if (hasFileOwnershipMarker(promptPath)) prompts.push({ path: promptPath, kind: 'file', action: 'legacy-owned' });
  }
  return prompts;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function checksumFile(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function checksumContent(content) {
  return sha256Buffer(Buffer.from(content));
}

function backupPathFor(platform, originalPath, homeDir) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const nonce = crypto.randomBytes(4).toString('hex');
  const basename = path.basename(originalPath);
  return path.join(homeDir, '.drfx', 'backups', platform, `${stamp}-${nonce}`, basename);
}

function backupExisting(platform, targetPath, homeDir, stat) {
  const backupPath = backupPathFor(platform, targetPath, homeDir);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  if (stat.isDirectory()) {
    fs.cpSync(targetPath, backupPath, { recursive: true });
    return { originalPath: targetPath, backupPath, checksum: 'none' };
  }
  fs.copyFileSync(targetPath, backupPath);
  return { originalPath: targetPath, backupPath, checksum: checksumFile(backupPath) };
}

function restoreBackup(backup, kind) {
  if (pathExists(backup.originalPath)) fs.rmSync(backup.originalPath, { recursive: true, force: true });
  if (kind === 'directory') fs.cpSync(backup.backupPath, backup.originalPath, { recursive: true });
  else fs.copyFileSync(backup.backupPath, backup.originalPath);
}

function cleanupCreated(targetPath) {
  if (pathExists(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
}

function installTargetFor(platform, generated, roots) {
  return path.join(roots.installRoots[platform], generated.relativePath);
}

function flattenGeneratedEntry(platform, generated, roots) {
  const targetPath = installTargetFor(platform, generated, roots);
  if (generated.kind === 'directory') {
    return {
      platform,
      kind: 'directory',
      targetPath,
      generated
    };
  }
  return {
    platform,
    kind: 'file',
    targetPath,
    content: generated.content,
    generated
  };
}

function planInstall(platform, roots, packageVersion) {
  return generatePlatformFiles(platform, { packageVersion }).map((entry) => flattenGeneratedEntry(platform, entry, roots));
}

function preflightInstall(platform, planned) {
  for (const item of planned) {
    if (!pathExists(item.targetPath)) continue;
    const stat = fs.lstatSync(item.targetPath);
    if (stat.isSymbolicLink()) fail('ERR_INSTALL_SYMLINK', `refusing to install over symlink: ${item.targetPath}`);

    if (platform === 'codex') {
      if (!stat.isDirectory()) {
        fail('ERR_CODEX_TARGET_KIND', `refusing non-owned Codex skill target that is not a directory: ${item.targetPath}`);
      }
      if (!hasOwnershipMarker(item.targetPath)) {
        fail('ERR_CODEX_OWNERSHIP', `refusing non-owned Codex skill directory: ${item.targetPath}`);
      }
      continue;
    }

    if (!stat.isFile()) fail('ERR_INSTALL_TARGET_KIND', `refusing to install over non-file target: ${item.targetPath}`);
  }
}

function tempSiblingPath(targetPath, suffix) {
  const parent = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  return path.join(parent, `.${basename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.${suffix}`);
}

function writeGeneratedDirectory(targetPath, generated, hooks = {}) {
  const stagingPath = tempSiblingPath(targetPath, 'staging');
  const replacedPath = tempSiblingPath(targetPath, 'replaced');
  let targetMoved = false;
  try {
    fs.mkdirSync(stagingPath, { recursive: true });
    for (const file of generated.files) {
      const filePath = path.join(stagingPath, file.relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content);
    }
    if (typeof hooks._onBeforeReplaceGeneratedDirectory === 'function') {
      hooks._onBeforeReplaceGeneratedDirectory({ targetPath, stagingPath, generated });
    }
    if (pathExists(targetPath)) {
      fs.renameSync(targetPath, replacedPath);
      targetMoved = true;
    }
    fs.renameSync(stagingPath, targetPath);
    fs.rmSync(replacedPath, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    if (targetMoved && !pathExists(targetPath) && pathExists(replacedPath)) {
      fs.renameSync(replacedPath, targetPath);
    }
    fs.rmSync(replacedPath, { recursive: true, force: true });
    throw error;
  }
}

function writeGeneratedFile(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const stagingPath = tempSiblingPath(targetPath, 'staging');
  try {
    fs.writeFileSync(stagingPath, content);
    fs.renameSync(stagingPath, targetPath);
  } catch (error) {
    fs.rmSync(stagingPath, { force: true });
    throw error;
  }
}

async function writeInstallerDefaultDescriptor(platform, { homeDir, packageVersion }) {
  const adapterCapabilities = await ADAPTERS[platform].checkCapabilities({ packageVersion });
  const descriptor = buildDescriptor({
    platform,
    packageVersion,
    adapterCapabilities,
    fingerprintGuard: {
      status: 'unverified',
      proof: 'none',
      proofRunId: 'none',
      detail: 'Installer default has not run the local probe.'
    },
    provenanceSource: 'installer-default',
    generatedBy: 'drfx install'
  });
  const descriptorPath = path.join(homeDir, '.drfx', 'capabilities', `${platform}.json`);
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  return descriptorPath;
}

async function installPlatform(platform, options = {}) {
  const [normalizedPlatform] = parsePlatformList(platform);
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const cwd = path.resolve(options.cwd || process.cwd());
  const packageVersion = options.packageVersion || readPackageVersion();
  const roots = normalizePlatformRoots(homeDir, options.platformRoots);

  ensureBaseDirectories(normalizedPlatform, roots, homeDir, cwd);
  copySharedAssets(path.join(homeDir, '.drfx'), { all: true });

  const planned = planInstall(normalizedPlatform, roots, packageVersion);
  preflightInstall(normalizedPlatform, planned);

  const generated = [];
  const backups = [];
  const applied = [];
  let descriptorPath = null;
  try {
    for (const item of planned) {
      const exists = pathExists(item.targetPath);
      const stat = exists ? fs.lstatSync(item.targetPath) : null;
      const action = exists ? 'overwritten' : 'created';
      const backup = exists ? backupExisting(normalizedPlatform, item.targetPath, homeDir, stat) : null;
      if (backup) backups.push(backup);

      if (item.kind === 'directory') writeGeneratedDirectory(item.targetPath, item.generated, options);
      else writeGeneratedFile(item.targetPath, item.content);

      applied.push({ path: item.targetPath, kind: item.kind, action, backup });
      if (item.kind === 'directory') {
        const tree = directoryTreeMetadata(item.targetPath);
        generated.push({
          path: item.targetPath,
          kind: 'directory',
          action,
          checksum: 'none',
          treeChecksum: tree.treeChecksum,
          childFiles: tree.childFiles
        });
      } else {
        generated.push({
          path: item.targetPath,
          kind: 'file',
          action,
          checksum: checksumContent(item.content)
        });
      }
    }

    descriptorPath = await writeInstallerDefaultDescriptor(normalizedPlatform, { homeDir, packageVersion });
    const now = new Date().toISOString();
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      packageName: PACKAGE_NAME,
      packageVersion,
      platform: normalizedPlatform,
      installedAt: now,
      updatedAt: now,
      installRoot: fs.realpathSync.native(roots.installRoots[normalizedPlatform]),
      allowedRoots: [fs.realpathSync.native(roots.allowedRoots[normalizedPlatform])],
      sharedAssets: {
        path: '~/.drfx/shared',
        checksum: 'none'
      },
      capabilityDescriptor: {
        path: `~/.drfx/capabilities/${normalizedPlatform}.json`,
        mutable: true
      },
      generated,
      backups
    };
    const manifestPath = writeInstallManifest(manifest, { homeDir });

    return {
      platform: normalizedPlatform,
      manifestPath,
      descriptorPath,
      generated,
      backups
    };
  } catch (error) {
    for (const item of applied.reverse()) {
      if (item.action === 'overwritten' && item.backup) restoreBackup(item.backup, item.kind);
      else cleanupCreated(item.path);
    }
    if (descriptorPath && pathExists(descriptorPath)) {
      const descriptorStat = fs.lstatSync(descriptorPath);
      if (!descriptorStat.isSymbolicLink() && descriptorStat.isFile()) fs.unlinkSync(descriptorPath);
    }
    throw error;
  }
}

async function installPlatforms(options = {}) {
  const platforms = parsePlatformList(options.platforms);
  const results = {};
  for (const platform of platforms) {
    results[platform] = await installPlatform(platform, options);
  }
  return { platforms: results };
}

function validateCapabilityDescriptorRemoval(validation) {
  if (!validation.capabilityDescriptor || !validation.capabilityDescriptor.mutable) {
    return { removable: false, path: null };
  }
  const descriptorPath = validation.capabilityDescriptor.path;
  if (!pathExists(descriptorPath)) return { removable: false, path: descriptorPath };
  const stat = fs.lstatSync(descriptorPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('ERR_DESCRIPTOR_REMOVE', `refusing to remove unsafe capability descriptor: ${descriptorPath}`);
  }
  return { removable: true, path: descriptorPath };
}

function validateManifestRemoval(platform, homeDir) {
  const manifestPath = manifestPathForPlatform(platform, { homeDir });
  if (!pathExists(manifestPath)) fail('ERR_MANIFEST_REMOVE', `manifest disappeared before uninstall: ${manifestPath}`);
  const stat = fs.lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('ERR_MANIFEST_REMOVE', `refusing to remove unsafe manifest: ${manifestPath}`);
  }
  return manifestPath;
}

function removeCapabilityDescriptor(validatedDescriptor) {
  if (!validatedDescriptor.removable) return false;
  const descriptorPath = validatedDescriptor.path;
  fs.unlinkSync(descriptorPath);
  return true;
}

async function uninstallPlatform(platform, options = {}) {
  const [normalizedPlatform] = parsePlatformList(platform);
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const roots = normalizePlatformRoots(homeDir, options.platformRoots);
  const manifestRead = readInstallManifest(normalizedPlatform, { homeDir });
  if (manifestRead.missing) return { platform: normalizedPlatform, missing: true, removed: [], skipped: [] };

  const validation = validateGeneratedRemoval(manifestRead, {
    homeDir,
    platformRoots: roots.manifestPlatformRoots
  });
  const descriptorRemoval = validateCapabilityDescriptorRemoval(validation);
  const manifestPath = validateManifestRemoval(normalizedPlatform, homeDir);

  const removed = [];
  const recordedRemovalPaths = new Set(validation.removable.map((item) => item.path));
  const legacyPrompts =
    normalizedPlatform === 'codex' ? ownershipMarkedCodexLegacyPrompts(roots, recordedRemovalPaths) : [];
  for (const item of [...validation.removable, ...legacyPrompts]) {
    const stat = fs.lstatSync(item.path);
    if (stat.isSymbolicLink()) fail('ERR_REMOVE_SYMLINK', `refusing to remove symlink: ${item.path}`);
    if (item.kind === 'directory') fs.rmSync(item.path, { recursive: true, force: false });
    else fs.unlinkSync(item.path);
    removed.push(item.path);
  }
  const skipped = validation.skipped || [];
  const retained = skipped.filter((item) => item.reason === 'modified');
  const partial = retained.length > 0;

  let descriptorRemoved = false;
  if (!partial) {
    descriptorRemoved = removeCapabilityDescriptor(descriptorRemoval);
    fs.unlinkSync(manifestPath);
  } else {
    const manifest = manifestRead.manifest;
    const retainedPaths = new Set(retained.map((item) => item.path));
    writeInstallManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      generated: manifest.generated.filter((entry) => retainedPaths.has(entry.path))
    }, { homeDir });
  }

  return {
    platform: normalizedPlatform,
    missing: false,
    partial,
    removed,
    skipped,
    descriptorRemoved
  };
}

async function uninstallPlatforms(options = {}) {
  const platforms = parsePlatformList(options.platforms);
  const results = {};
  for (const platform of platforms) {
    results[platform] = await uninstallPlatform(platform, options);
  }
  return { platforms: results };
}

module.exports = {
  parsePlatformList,
  installPlatforms,
  uninstallPlatforms,
  installPlatform,
  uninstallPlatform,
  writeGeneratedFile
};
