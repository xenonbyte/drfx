'use strict';

const fs = require('node:fs');
const path = require('node:path');

const action = process.argv[2];
const root = path.join(__dirname, '..');
const readmePath = path.join(root, 'README.zh-CN.md');
const hiddenPath = path.join(root, '.README.zh-CN.md.packhide');

function restoreIfHidden() {
  if (fs.existsSync(hiddenPath) && !fs.existsSync(readmePath)) {
    fs.renameSync(hiddenPath, readmePath);
  }
}

if (action === 'hide') {
  restoreIfHidden();
  if (fs.existsSync(readmePath)) fs.renameSync(readmePath, hiddenPath);
} else if (action === 'restore') {
  if (fs.existsSync(hiddenPath)) fs.renameSync(hiddenPath, readmePath);
} else {
  throw new Error(`unknown pack README action: ${action || 'none'}`);
}
