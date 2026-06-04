'use strict';

// Unit tests for `drfx status` (lib/status.js). It must never report a platform
// as installed from a missing or corrupt manifest.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runStatus } = require('../lib/status');

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-status-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeManifest(home, platform, text) {
  const dir = path.join(home, '.drfx', 'manifests');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${platform}.manifest`), text);
}

test('status reports not installed when the manifest file is missing', (t) => {
  const home = tmpHome(t);
  const report = runStatus({ platforms: ['claude'], homeDir: home }).platforms;
  assert.equal(report.claude.installed, false);
  assert.equal(report.claude.invalid, undefined);
});

test('status reports invalid for a parseable but incomplete manifest, not installed', (t) => {
  const home = tmpHome(t);
  // Valid scalar syntax but no `generated` section (e.g. a truncated write).
  writeManifest(home, 'claude', 'schemaVersion: 2\npackageName: "@xenonbyte/drfx"\npackageVersion: "0.3.0"\nplatform: "claude"\n');
  const report = runStatus({ platforms: ['claude'], homeDir: home }).platforms;
  assert.equal(report.claude.installed, false);
  assert.equal(report.claude.invalid, true);
});

test('status reports invalid for an unparseable manifest without throwing', (t) => {
  const home = tmpHome(t);
  writeManifest(home, 'codex', 'this is not a valid manifest at all\n');
  const report = runStatus({ platforms: ['codex'], homeDir: home }).platforms;
  assert.equal(report.codex.installed, false);
  assert.equal(report.codex.invalid, true);
});

test('status reports invalid when the manifest platform does not match the requested platform', (t) => {
  const home = tmpHome(t);
  // A well-formed manifest, but claiming a different platform than the file name.
  writeManifest(
    home,
    'claude',
    'schemaVersion: 2\npackageName: "@xenonbyte/drfx"\npackageVersion: "0.3.0"\nplatform: "codex"\ngenerated:\n'
  );
  const report = runStatus({ platforms: ['claude'], homeDir: home }).platforms;
  assert.equal(report.claude.installed, false);
  assert.equal(report.claude.invalid, true);
});
