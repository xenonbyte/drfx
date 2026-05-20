#!/usr/bin/env node
'use strict';

const { runCheck, formatCheckReport } = require('../lib/check');
const { installPlatforms, uninstallPlatforms, parsePlatformList } = require('../lib/install');

function printHelp() {
  process.stdout.write([
    'drfx - document-review-loop installer and capability checker',
    '',
    'Usage:',
    '  drfx check [--platform claude,codex,gemini]',
    '  drfx install --platform claude,codex,gemini',
    '  drfx uninstall --platform claude,codex,gemini',
    ''
  ].join('\n'));
}

function parseArgs(argv) {
  const parsed = { command: argv[2], platforms: undefined };
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--platform') {
      index += 1;
      if (index >= argv.length) throw new Error('--platform requires a value');
      parsed.platforms = parsePlatformList(argv[index]);
      continue;
    }
    if (arg.startsWith('--platform=')) {
      parsed.platforms = parsePlatformList(arg.slice('--platform='.length));
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

async function main(argv) {
  const { command, platforms } = parseArgs(argv);
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }
  if (!['check', 'install', 'uninstall'].includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    return 1;
  }

  if ((command === 'install' || command === 'uninstall') && !platforms) {
    throw new Error(`${command} requires --platform claude,codex,gemini`);
  }

  if (command === 'check') {
    const result = await runCheck({ platforms });
    process.stdout.write(formatCheckReport(result));
    return 0;
  }
  if (command === 'install') {
    const result = await installPlatforms({ platforms });
    process.stdout.write(`installed: ${Object.keys(result.platforms).join(', ')}\n`);
    return 0;
  }
  if (command === 'uninstall') {
    const result = await uninstallPlatforms({ platforms });
    process.stdout.write(`uninstalled: ${Object.keys(result.platforms).join(', ')}\n`);
    return 0;
  }

  return 1;
}

main(process.argv)
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
