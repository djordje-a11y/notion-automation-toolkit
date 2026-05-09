#!/usr/bin/env node

import process from 'process';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCRIPT_MAP = {
  start: {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-automation-start.js'),
    prependArgs: [],
  },
  check: {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-automation-start.js'),
    prependArgs: ['--check'],
  },
  stop: {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-automation-stop.js'),
    prependArgs: [],
  },
  init: {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-automation-init.js'),
    prependArgs: [],
  },
  bridge: {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-polling-bridge.js'),
    prependArgs: [],
  },
  intake: {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-agent-intake.js'),
    prependArgs: [],
  },
  'reply-latest': {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-reply-latest.js'),
    prependArgs: [],
  },
  tickets: {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-list-tickets.js'),
    prependArgs: [],
  },
};

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      'notion-auto (standalone notion automation toolkit)',
      '',
      'Usage:',
      '  notion-auto <command> [--workspace <path>] [command-options...]',
      '',
      'Commands:',
      '  init    Add local ignore entries + create .notion dirs in a workspace',
      '  check   Validate notion automation setup for a workspace',
      '  start   Start Notion polling bridge workflow',
      '  stop    Stop polling bridge process for a workspace',
      '  bridge  Run polling bridge directly',
      '  intake  Run intake directly',
      '  reply-latest  Add comment to the latest discussion (fallback: page comment)',
      '  tickets  List active tracked ticket worktrees',
      '',
      'Examples:',
      '  notion-auto init --workspace /path/to/repo',
      '  notion-auto check --workspace /path/to/repo',
      '  notion-auto start --workspace /path/to/repo',
      '  notion-auto stop --workspace /path/to/repo',
      '  notion-auto intake --workspace /path/to/repo --page-id <notion-page-id> --dispatch',
      '  notion-auto tickets --workspace /path/to/repo',
      '',
    ].join('\n'),
  );
}

function parseCommand(argv = process.argv) {
  const args = argv.slice(2);
  let command = '';
  let commandIndex = -1;
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '').trim();
    if (!token || token.startsWith('--')) continue;
    command = token;
    commandIndex = i;
    break;
  }
  return { command, commandIndex, args };
}

async function main(argv = process.argv) {
  const { command, commandIndex, args } = parseCommand(argv);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }

  const target = SCRIPT_MAP[command];
  if (!target) {
    // eslint-disable-next-line no-console
    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
  }

  const commandArgs = [...args];
  commandArgs.splice(commandIndex, 1);

  return new Promise((resolve, reject) => {
    const child = spawn('node', [target.script, ...target.prependArgs, ...commandArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`notion-auto ${command} terminated by signal ${signal}`));
        return;
      }
      resolve(code || 0);
    });
    child.on('error', (error) => reject(error));
  });
}

main()
  .then((exitCode) => process.exit(exitCode))
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error?.message || String(error));
    process.exit(1);
  });
