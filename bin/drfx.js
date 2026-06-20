#!/usr/bin/env node
'use strict';

const { runCheck, formatCheckReport, formatCheckJson } = require('../lib/check');
const { runStatus, formatStatusReport, formatStatusJson } = require('../lib/status');
const { installPlatforms, uninstallPlatforms, parsePlatformList } = require('../lib/install');
const { runWorkflowCommand, formatWorkflowJson, formatWorkflowError } = require('../lib/workflow');

const USER_COMMANDS = new Set(['version', 'help', 'doctor', 'status', 'install', 'uninstall']);
const WORKFLOW_STDIN_FLAGS = new Set([
  '--result-stdin',
  '--triage-stdin',
  '--final-response-stdin',
  '--fix-report-stdin',
  '--diff-review-stdin',
  '--payload-stdin'
]);

function packageVersion() {
  return require('../package.json').version;
}

function printHelp() {
  process.stdout.write([
    'drfx - install and run document and code review-fix routes for Claude Code, Codex, and Gemini',
    '',
    'Usage:',
    '  drfx version',
    '  drfx help',
    '  drfx doctor    [--platform claude,codex,gemini] [--json]',
    '  drfx status    [--platform claude,codex,gemini] [--json]',
    '  drfx install   [--platform claude,codex,gemini]',
    '  drfx uninstall [--platform claude,codex,gemini]',
    '',
    'Commands:',
    '  version      Print the installed drfx version.',
    '  help         Show this help.',
    '  doctor       Probe local platform capabilities (use --json for strict-verified proof).',
    '  status       Report which generated routes are installed per platform.',
    '  install      Install generated routes. --platform is optional; omit it to target all platforms.',
    '  uninstall    Remove package-owned generated routes. --platform is optional; omit it to target all platforms.',
    ''
  ].join('\n'));
}

function printWorkflowHelp() {
  process.stdout.write([
    'drfx workflow - internal route workflow dispatcher (invoked by generated routes, not by hand)',
    '',
    'Usage:',
    '  drfx workflow start <entry-skill> [tokens...] [--json] [--assurance advisory|practical|strict-verified]',
    '  drfx workflow preflight|context|record-review|record-triage|begin-fix|refresh-lock|end-fix|abort-fix|record-diff-review|finalize ...',
    '  drfx workflow aggregate-review <target-state-dir> [--json]',
    ''
  ].join('\n'));
}

// Parse `--platform <list>` / `--platform=<list>` (optional; absent ⇒ all platforms) and `--json`
// from the tokens that follow the command (argv[3..]).
function parseCommandOptions(argv) {
  let platforms;
  let json = false;
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--platform') {
      index += 1;
      if (index >= argv.length) throw new Error('--platform requires a value');
      platforms = parsePlatformList(argv[index]);
      continue;
    }
    if (arg.startsWith('--platform=')) {
      platforms = parsePlatformList(arg.slice('--platform='.length));
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return { platforms, json };
}

function workflowNeedsStdin(args) {
  return args.some((arg) => WORKFLOW_STDIN_FLAGS.has(arg));
}

function readProcessStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

async function main(argv) {
  const command = argv[2];

  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }
  if (command === 'workflow') {
    const workflowSubcommand = argv[3];
    const workflowArgs = argv.slice(4);
    if (!workflowSubcommand || workflowSubcommand === '--help' || workflowSubcommand === '-h') {
      printWorkflowHelp();
      return 0;
    }
    const options = workflowNeedsStdin(workflowArgs)
      ? { stdin: await readProcessStdin() }
      : {};
    const result = await runWorkflowCommand(workflowSubcommand, workflowArgs, options);
    process.stdout.write(formatWorkflowJson(result));
    return 0;
  }

  if (!USER_COMMANDS.has(command)) {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    return 1;
  }

  const { platforms, json } = parseCommandOptions(argv);

  if (command === 'doctor') {
    const result = await runCheck({ platforms, json });
    process.stdout.write(json ? formatCheckJson(result) : formatCheckReport(result));
    return 0;
  }
  if (command === 'status') {
    const result = runStatus({ platforms });
    process.stdout.write(json ? formatStatusJson(result) : formatStatusReport(result));
    return 0;
  }
  if (command === 'install') {
    const result = await installPlatforms({ platforms });
    process.stdout.write(`installed: ${Object.keys(result.platforms).join(', ')}\n`);
    return 0;
  }
  if (command === 'uninstall') {
    const result = await uninstallPlatforms({ platforms });
    const entries = Object.entries(result.platforms);
    const fullyDone = entries.filter(([, o]) => !o.partial && !o.missing).map(([p]) => p);
    const lines = [];
    if (fullyDone.length > 0) lines.push(`uninstalled: ${fullyDone.join(', ')}`);
    for (const [platform, outcome] of entries) {
      if (outcome.missing) {
        lines.push(`not installed: ${platform}`);
      } else if (outcome.partial) {
        const modified = (outcome.skipped || []).filter((s) => s.reason === 'modified').length;
        lines.push(`partially uninstalled: ${platform} (kept ${modified} modified file(s); manifest retained)`);
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  return 1;
}

function workflowJsonRequested(argv) {
  if (argv[2] !== 'workflow') return false;
  return argv.slice(4).some((arg) => arg === '--json' || arg.startsWith('--json='));
}

main(process.argv)
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    if (workflowJsonRequested(process.argv)) {
      process.stdout.write(formatWorkflowJson(formatWorkflowError({ error })));
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
