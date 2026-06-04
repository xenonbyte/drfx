'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { serializeManifest, parseManifestText } = require('../lib/manifest');

function baseManifest(generated) {
  return {
    schemaVersion: 2,
    packageName: '@xenonbyte/drfx',
    packageVersion: '0.2.1',
    platform: 'codex',
    installedAt: '2026-05-31T00:00:00.000Z',
    updatedAt: '2026-05-31T00:00:00.000Z',
    installRoot: '/abs/.codex',
    allowedRoots: ['/abs/.codex'],
    sharedAssets: { path: '~/.drfx/shared', checksum: 'none' },
    capabilityDescriptor: { path: '~/.drfx/capabilities/codex.json', mutable: true },
    generated,
    backups: []
  };
}

test('schema v2 directory entry round-trips childFiles and treeChecksum', () => {
  const manifest = baseManifest([
    {
      path: '/abs/.codex/skills/review-fix-spec',
      kind: 'directory',
      action: 'created',
      checksum: 'none',
      treeChecksum: 'a'.repeat(64),
      childFiles: 'SKILL.md,review/reviewer.md'
    }
  ]);
  const parsed = parseManifestText(serializeManifest(manifest));
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.generated[0].treeChecksum, 'a'.repeat(64));
  assert.equal(parsed.generated[0].childFiles, 'SKILL.md,review/reviewer.md');
});

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { installPlatform, uninstallPlatform } = require('../lib/install');
const { readInstallManifest, writeInstallManifest } = require('../lib/manifest');

test('codex install records childFiles and treeChecksum for skill directories', async (t) => {
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-p1b-home-')));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const platformRoots = {
    codex: path.join(homeDir, '.codex'),
    codexSkills: path.join(homeDir, '.codex', 'skills'),
    codexPrompts: path.join(homeDir, '.codex', 'prompts')
  };
  fs.mkdirSync(path.join(homeDir, '.drfx', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.drfx', 'capabilities'), { recursive: true });

  await installPlatform('codex', { homeDir, platformRoots });
  const { manifest } = readInstallManifest('codex', { homeDir });
  const dirEntry = manifest.generated.find((g) => g.kind === 'directory');

  assert.equal(manifest.schemaVersion, 2);
  assert.ok(dirEntry.treeChecksum && dirEntry.treeChecksum.length === 64);
  const childFiles = dirEntry.childFiles.split(',');
  assert.ok(childFiles.includes('SKILL.md'));
  assert.ok(childFiles.length >= 2);
  assert.ok(childFiles.every((name) => name.length > 0));
});

test('install owns all six routes (document + pr + code) and removes only owned files', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-six-routes-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const platformRoots = {
    claude: path.join(homeDir, '.claude', 'commands'),
    codexSkills: path.join(homeDir, '.codex', 'skills'),
    codexPrompts: path.join(homeDir, '.codex', 'prompts'),
    gemini: path.join(homeDir, '.gemini', 'commands')
  };
  for (const value of Object.values(platformRoots)) fs.mkdirSync(value, { recursive: true });

  const sixRoutes = [
    'review-fix-spec', 'review-fix-plan', 'review-fix-design',
    'review-fix-doc', 'review-fix-pr', 'review-fix-code'
  ];

  for (const platform of ['claude', 'codex', 'gemini']) {
    await installPlatform(platform, { homeDir, platformRoots, cwd });
    const { manifest } = readInstallManifest(platform, { homeDir });
    assert.equal(manifest.generated.length, 6, `${platform} must own six routes`);
  }

  // Codex pr/code skills embed their route-kind rubric.
  assert.equal(fs.existsSync(path.join(platformRoots.codexSkills, 'review-fix-pr', 'shared', 'rubrics', 'pr.md')), true);
  assert.equal(fs.existsSync(path.join(platformRoots.codexSkills, 'review-fix-code', 'shared', 'rubrics', 'code.md')), true);

  // A user file dropped into a code skill directory blocks owned-only removal.
  const userNote = path.join(platformRoots.codexSkills, 'review-fix-code', 'USER-NOTES.md');
  fs.writeFileSync(userNote, 'mine\n');
  const codexResult = await uninstallPlatform('codex', { homeDir, platformRoots, cwd });
  assert.equal(codexResult.partial, true);
  assert.ok(codexResult.skipped.some((s) => s.path === path.join(platformRoots.codexSkills, 'review-fix-code') && s.reason === 'modified'));
  assert.equal(fs.existsSync(userNote), true);
  // The other five codex skills were removed (owned-only).
  assert.equal(fs.existsSync(path.join(platformRoots.codexSkills, 'review-fix-pr')), false);

  // Claude/Gemini uninstall removes all six owned route files cleanly.
  const claudeResult = await uninstallPlatform('claude', { homeDir, platformRoots, cwd });
  assert.notEqual(claudeResult.partial, true);
  for (const routeName of sixRoutes) {
    assert.equal(fs.existsSync(path.join(platformRoots.claude, `${routeName}.md`)), false, `claude ${routeName} removed`);
  }
  const geminiResult = await uninstallPlatform('gemini', { homeDir, platformRoots, cwd });
  assert.notEqual(geminiResult.partial, true);
  for (const routeName of sixRoutes) {
    assert.equal(fs.existsSync(path.join(platformRoots.gemini, `${routeName}.toml`)), false, `gemini ${routeName} removed`);
  }
});

async function installCodex(t) {
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-p1b-uninstall-')));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const platformRoots = {
    codex: path.join(homeDir, '.codex'),
    codexSkills: path.join(homeDir, '.codex', 'skills'),
    codexPrompts: path.join(homeDir, '.codex', 'prompts')
  };
  fs.mkdirSync(path.join(homeDir, '.drfx', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.drfx', 'capabilities'), { recursive: true });
  await installPlatform('codex', { homeDir, platformRoots });
  return { homeDir, platformRoots };
}

function legacyFileOnlyTreeChecksum(directoryPath, childFiles) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of childFiles.split(',').filter(Boolean).sort()) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(directoryPath, ...relativePath.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

test('uninstall skips a codex skill directory that gained a user file', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  fs.writeFileSync(path.join(skillDir, 'USER-NOTES.md'), 'mine\n');

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.path === skillDir && s.reason === 'modified'));
  assert.equal(fs.existsSync(skillDir), true);
});

test('uninstall skips a codex skill directory that gained a user empty directory', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const userDirectory = path.join(skillDir, 'user-notes');
  fs.mkdirSync(userDirectory);

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.path === skillDir && s.reason === 'modified'));
  assert.equal(fs.existsSync(userDirectory), true);
});

test('uninstall skips a codex skill directory that gained a nested ownership-marker-named file', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const nestedMarker = path.join(skillDir, 'shared', '.drfx-owned');
  fs.writeFileSync(nestedMarker, 'user note\n');

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.path === skillDir && s.reason === 'modified'));
  assert.equal(fs.existsSync(nestedMarker), true);
});

test('uninstall removes an unchanged codex skill directory', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const result = await uninstallPlatform('codex', { homeDir, platformRoots });
  assert.notEqual(result.partial, true);
  assert.equal(fs.existsSync(skillDir), false);
});

test('uninstall removes unchanged codex skill directory from legacy schema v2 file-only checksum', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const { manifest } = readInstallManifest('codex', { homeDir });
  writeInstallManifest({
    ...manifest,
    generated: manifest.generated.map((entry) => entry.path === skillDir
      ? { ...entry, treeChecksum: legacyFileOnlyTreeChecksum(skillDir, entry.childFiles) }
      : entry)
  }, { homeDir });

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.notEqual(result.partial, true);
  assert.equal(fs.existsSync(skillDir), false);
});

test('legacy schema v2 file-only checksum still skips unrecognized empty directories', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const { manifest } = readInstallManifest('codex', { homeDir });
  writeInstallManifest({
    ...manifest,
    generated: manifest.generated.map((entry) => entry.path === skillDir
      ? { ...entry, treeChecksum: legacyFileOnlyTreeChecksum(skillDir, entry.childFiles) }
      : entry)
  }, { homeDir });
  fs.mkdirSync(path.join(skillDir, 'user-notes'));

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.path === skillDir && s.reason === 'modified'));
  assert.equal(fs.existsSync(skillDir), true);
});

test('schema v1 uninstall skips a codex skill directory whose tree is not fully recognized', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const { manifest } = readInstallManifest('codex', { homeDir });
  writeInstallManifest({
    ...manifest,
    schemaVersion: 1,
    generated: manifest.generated.map((entry) => entry.path === skillDir
      ? { path: entry.path, kind: 'directory', action: entry.action, checksum: 'none' }
      : entry)
  }, { homeDir });
  fs.writeFileSync(path.join(skillDir, 'USER-NOTES.md'), 'mine\n');

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.path === skillDir && s.reason === 'modified'));
  assert.equal(fs.existsSync(skillDir), true);
  const retained = readInstallManifest('codex', { homeDir }).manifest.generated.map((entry) => entry.path);
  assert.ok(retained.includes(skillDir));
});

test('schema v1 uninstall skips a codex skill directory with an unrecognized empty directory', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const { manifest } = readInstallManifest('codex', { homeDir });
  writeInstallManifest({
    ...manifest,
    schemaVersion: 1,
    generated: manifest.generated.map((entry) => entry.path === skillDir
      ? { path: entry.path, kind: 'directory', action: entry.action, checksum: 'none' }
      : entry)
  }, { homeDir });
  fs.mkdirSync(path.join(skillDir, 'user-notes'));

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.path === skillDir && s.reason === 'modified'));
  assert.equal(fs.existsSync(skillDir), true);
});

test('schema v1 uninstall skips a codex skill directory with comma-crafted user directory names', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const { manifest } = readInstallManifest('codex', { homeDir });
  writeInstallManifest({
    ...manifest,
    schemaVersion: 1,
    generated: manifest.generated.map((entry) => entry.path === skillDir
      ? { path: entry.path, kind: 'directory', action: entry.action, checksum: 'none' }
      : entry)
  }, { homeDir });
  const craftedDirectory = path.join(skillDir, 'shared,F:SKILL.md');
  fs.mkdirSync(craftedDirectory);

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.path === skillDir && s.reason === 'modified'));
  assert.equal(fs.existsSync(craftedDirectory), true);
});

test('schema v1 uninstall removes an unchanged codex skill directory via the recognized set', async (t) => {
  const { homeDir, platformRoots } = await installCodex(t);
  const skillDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const { manifest } = readInstallManifest('codex', { homeDir });
  writeInstallManifest({
    ...manifest,
    schemaVersion: 1,
    generated: manifest.generated.map((entry) => entry.kind === 'directory'
      ? { path: entry.path, kind: 'directory', action: entry.action, checksum: 'none' }
      : entry)
  }, { homeDir });

  const result = await uninstallPlatform('codex', { homeDir, platformRoots });

  assert.notEqual(result.partial, true);
  assert.equal(fs.existsSync(skillDir), false);
});
