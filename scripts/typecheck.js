'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CHECK_DIRECTORIES = ['bin', 'lib', 'test'];

function collectJavaScriptFiles(directoryPath, files = []) {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      collectJavaScriptFiles(entryPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath);
  }
  return files;
}

const files = CHECK_DIRECTORIES.flatMap((directory) =>
  collectJavaScriptFiles(path.join(ROOT, directory))
).sort();

let failures = 0;
for (const filePath of files) {
  const result = childProcess.spawnSync(process.execPath, ['--check', filePath], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    failures += 1;
    process.stderr.write(`${path.relative(ROOT, filePath)} failed syntax check\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

if (failures > 0) {
  process.stderr.write(`typecheck failed: ${failures}/${files.length} files failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`typecheck passed: ${files.length} files checked\n`);
}
