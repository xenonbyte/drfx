'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Build a hidden, per-process, collision-resistant sibling temp path so the
// write/copy lands on the same filesystem as its target and the final rename is
// atomic. The pid/timestamp/random suffix keeps concurrent writers from sharing
// a temp name even when they target the same file.
function tempSiblingPath(targetPath) {
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  return path.join(
    directory,
    `.${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
}

// Atomically write `content` (string or Buffer) to `filePath`: stage it in a
// sibling temp with the exclusive `wx` flag, then rename over the target so a
// reader never observes a half-written file. On any failure the temp is removed
// best-effort and the original error is rethrown. `options.beforeRename` is an
// optional hook (used by tests) invoked after the temp write but before the
// rename, letting callers inject a failure between the two steps.
function atomicWriteFile(filePath, content, options = {}) {
  const targetPath = path.resolve(filePath);
  const tempPath = tempSiblingPath(targetPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    if (typeof options.beforeRename === 'function') options.beforeRename();
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort temp cleanup; the reported failure remains the original write error.
    }
    throw error;
  }
}

// Atomically copy `sourcePath` onto `destinationPath` using the same stage-then-
// rename discipline as atomicWriteFile. COPYFILE_EXCL guarantees the temp does
// not already exist; the parent dir is recreated in case a fixer removed it
// alongside the monitored file.
function atomicCopyFile(sourcePath, destinationPath) {
  const absoluteSource = path.resolve(sourcePath);
  const targetPath = path.resolve(destinationPath);
  const tempPath = tempSiblingPath(targetPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    fs.copyFileSync(absoluteSource, tempPath, fs.constants.COPYFILE_EXCL);
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort temp cleanup; the reported failure remains the original copy error.
    }
    throw error;
  }
}

module.exports = { atomicWriteFile, atomicCopyFile };
