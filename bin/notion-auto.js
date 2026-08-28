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
  done: {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-done.js'),
    prependArgs: [],
  },
  push: {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-push.js'),
    prependArgs: [],
  },
  review: {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-mr-review.js'),
    prependArgs: [],
  },
  'review-comment': {
    script: path.resolve(TOOLKIT_ROOT, 'scripts/notion-mr-review.js'),
    prependArgs: ['--post-comment'],
  },
};

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      'notion-auto / na (standalone notion automation toolkit)',
      '',
      'Usage:',
      '  notion-auto <command> [--workspace <path>] [command-options...]',
      '  na <command> [--workspace <path>] [command-options...]',
      '  (If --workspace is omitted, current directory is used)',
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
      '  done    Push current branch and open GitLab MR to target branch',
      '  push    Commit changes, push, open MR to dev, and assign reviewers',
      '  review  Write a GitLab MR review handoff (@notion-review-<iid>.md)',
      '  review-comment  Post a GitLab MR comment after the review discussion',
      '',
      'Examples:',
      '  na init --workspace /path/to/repo',
      '  na check --workspace /path/to/repo',
      '  na start --workspace /path/to/repo',
      '  na stop --workspace /path/to/repo',
      '  na intake --workspace /path/to/repo --page-id <notion-page-id> --dispatch',
      '  na tickets --checkout',
      '  na done --target-branch dev',
      '  na push --message "Fix ticket behavior"',
      '  na review --mr-iid 42',
      '  na review-comment --mr-iid 42 --body "Consider X instead of Y"',
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
