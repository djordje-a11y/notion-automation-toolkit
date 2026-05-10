#!/usr/bin/env node
/**
 * notion list tickets
 *
 * Prints active ticket -> worktree mappings from .notion/worktree-map.json.
 */

import process from 'process';
import fs from 'fs/promises';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import readline from 'readline';

const DEFAULT_WORKTREE_MAP_FILE = '.notion/worktree-map.json';
const DEFAULT_HANDOFF_ALIAS_MAP_FILE = '.notion/handoff-alias-map.json';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function print(message, color = '') {
  // eslint-disable-next-line no-console
  console.log(`${color}${message}${colors.reset}`);
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv = process.argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const eqIndex = token.indexOf('=');
    if (eqIndex > 2) {
      const key = token.slice(2, eqIndex);
      const value = token.slice(eqIndex + 1);
      args[key] = value;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    const isFlag = !next || next.startsWith('--');
    if (isFlag) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = normalize(value);
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolveWorkspaceFromArgv(argv = process.argv, envWorkspace = '') {
  const envCandidate = String(envWorkspace || '').trim();
  let cliCandidate = '';

  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (token === '--workspace') {
      const next = String(argv[i + 1] || '').trim();
      if (next && !next.startsWith('--')) cliCandidate = next;
      break;
    }
    if (token.startsWith('--workspace=')) {
      cliCandidate = token.slice('--workspace='.length).trim();
      break;
    }
  }

  const selected = cliCandidate || envCandidate;
  if (!selected) return resolveRootWorkspaceFromGitOrCwd();
  return path.isAbsolute(selected) ? selected : path.resolve(process.cwd(), selected);
}

function resolveRootWorkspaceFromGitOrCwd() {
  try {
    const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    if (result.status === 0 && !result.error) {
      const commonDirRaw = String(result.stdout || '').trim();
      if (commonDirRaw) {
        const commonDir = path.isAbsolute(commonDirRaw)
          ? commonDirRaw
          : path.resolve(process.cwd(), commonDirRaw);
        const rootCandidate = path.resolve(commonDir, '..');
        return rootCandidate;
      }
    }
  } catch {
    // fall through to cwd
  }
  return process.cwd();
}

function resolveMapPath(workspace, raw) {
  const value = String(raw || DEFAULT_WORKTREE_MAP_FILE).trim();
  if (!value) return path.resolve(workspace, DEFAULT_WORKTREE_MAP_FILE);
  if (path.isAbsolute(value)) return value;
  return path.resolve(workspace, value);
}

function resolveAliasMapPath(workspace, raw) {
  const value = String(raw || DEFAULT_HANDOFF_ALIAS_MAP_FILE).trim();
  if (!value) return path.resolve(workspace, DEFAULT_HANDOFF_ALIAS_MAP_FILE);
  if (path.isAbsolute(value)) return value;
  return path.resolve(workspace, value);
}

async function readJsonFileSafe(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function sortTickets(entries) {
  return [...entries].sort((left, right) =>
    String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')),
  );
}

function printUsage() {
  print('');
  print('notion list tickets', colors.cyan);
  print('');
  print('Usage:');
  print('  notion-auto tickets');
  print('');
  print('Options:');
  print('  --workspace <path> (optional; defaults to current directory)');
  print(`  --map-file <path> (default ${DEFAULT_WORKTREE_MAP_FILE})`);
  print(`  --alias-map-file <path> (default ${DEFAULT_HANDOFF_ALIAS_MAP_FILE})`);
  print('  --json true|false');
  print('  --copy-paths true|false (print copy/paste cd commands only)');
  print('  --paths true|false (alias of --copy-paths)');
  print('  --checkout true|false (interactive selector, then open shell in chosen worktree)');
  print('  --checkout --run (checkout + run NOTION_TICKETS_AFTER_CHECKOUT_COMMAND)');
  print('  --after-checkout-command "<command>" (run command in selected worktree)');
  print('');
  print('Env:');
  print('  NOTION_TICKETS_AFTER_CHECKOUT_COMMAND="<command>"');
  print('');
}

function askLine(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

function hasFzf() {
  try {
    const check = spawnSync('fzf', ['--version'], {
      env: process.env,
      stdio: 'ignore',
    });
    return check.status === 0 && !check.error;
  } catch {
    return false;
  }
}

function pickWithFzf(rows) {
  const lines = rows.map((entry, index) => {
    const pageId = String(entry.pageId || '(unknown)');
    const status = String(entry.status || '(unknown)');
    const branch = String(entry.branch || '(unknown)');
    const worktreePath = String(entry.worktreePath || '').trim();
    return `${index + 1}\t${branch}\t${status}\t${pageId}\t${worktreePath}`;
  });
  const result = spawnSync(
    'fzf',
    ['--prompt', 'Select worktree > ', '--height', '40%', '--reverse', '--delimiter', '\t', '--with-nth', '2,3,4'],
    {
      env: process.env,
      input: `${lines.join('\n')}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  if (result.error) return { ok: false, selected: null };
  if (result.status !== 0) return { ok: true, selected: null };
  const selectedLine = String(result.stdout || '').trim();
  if (!selectedLine) return { ok: true, selected: null };
  const parts = selectedLine.split('\t');
  const picked = Number.parseInt(String(parts[0] || '').trim(), 10);
  if (!Number.isInteger(picked) || picked < 1 || picked > rows.length) {
    return { ok: true, selected: null };
  }
  return { ok: true, selected: rows[picked - 1] };
}

async function runCheckoutSelector(rows, runAfterCheckout = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('Interactive checkout requires a TTY terminal.');
  }
  if (!rows.length) {
    print('No active tracked tickets found.', colors.yellow);
    return 0;
  }

  if (hasFzf()) {
    const fzfPicked = pickWithFzf(rows);
    if (!fzfPicked.ok) {
      fail('Failed to launch fzf interactive selector.');
    }
    if (!fzfPicked.selected) {
      print('Checkout cancelled.', colors.yellow);
      return 0;
    }
    const selectedPath = String(fzfPicked.selected.worktreePath || '').trim();
    if (!selectedPath) {
      fail('Selected ticket has no worktree path.');
    }
    return launchSelectedWorktree(selectedPath, runAfterCheckout);
  }

  print('');
  print('Select worktree to open:', colors.cyan);
  rows.forEach((entry, index) => {
    const pageId = String(entry.pageId || '(unknown)');
    const status = String(entry.status || '(unknown)');
    const branch = String(entry.branch || '(unknown)');
    print(`  [${index + 1}] ${branch} | ${status} | ${pageId}`, colors.green);
  });
  print('');
  const answer = await askLine(`Choose 1-${rows.length} (or 'q' to cancel): `);
  if (!answer || normalize(answer) === 'q' || normalize(answer) === 'quit') {
    print('Checkout cancelled.', colors.yellow);
    return 0;
  }
  const picked = Number.parseInt(answer, 10);
  if (!Number.isInteger(picked) || picked < 1 || picked > rows.length) {
    fail(`Invalid selection '${answer}'. Expected a number between 1 and ${rows.length}.`);
  }
  const selected = rows[picked - 1];
  const selectedPath = String(selected.worktreePath || '').trim();
  if (!selectedPath) {
    fail('Selected ticket has no worktree path.');
  }

  return launchSelectedWorktree(selectedPath, runAfterCheckout);
}

async function launchSelectedWorktree(selectedPath, runAfterCheckout = false) {
  const afterCheckoutCommand = String(
    process.env.NOTION_TICKETS_AFTER_CHECKOUT_COMMAND || '',
  ).trim();

  if (runAfterCheckout && afterCheckoutCommand) {
    print(`Running after-checkout command in ${selectedPath}: ${afterCheckoutCommand}`, colors.cyan);
    await new Promise((resolve, reject) => {
      const child = spawn('bash', ['-lc', afterCheckoutCommand], {
        cwd: selectedPath,
        env: process.env,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal) {
          reject(new Error(`after-checkout command terminated by signal ${signal}`));
          return;
        }
        if (Number(code || 0) !== 0) {
          reject(new Error(`after-checkout command failed with exit code ${code}`));
          return;
        }
        resolve();
      });
    });
    return 0;
  }

  const shellBinary = String(process.env.SHELL || 'bash').trim() || 'bash';
  print(`Opening shell in: ${selectedPath}`, colors.cyan);
  await new Promise((resolve, reject) => {
    const child = spawn(shellBinary, {
      cwd: selectedPath,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', () => resolve());
  });
  return 0;
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help || args.h || args._[0] === 'help') {
    printUsage();
    return 0;
  }

  const workspace = resolveWorkspaceFromArgv(
    argv,
    process.env.NOTION_TOOLKIT_WORKSPACE || process.env.NOTION_WORKSPACE || '',
  );
  try {
    process.chdir(workspace);
  } catch {
    fail(`Workspace path is not accessible: ${workspace}`);
  }

  const mapFile = resolveMapPath(workspace, args['map-file']);
  const aliasMapFile = resolveAliasMapPath(workspace, args['alias-map-file']);
  const outputJson = parseBoolean(args.json, false);
  const checkoutMode = parseBoolean(args.checkout, false);
  const copyPathsOnly = parseBoolean(
    args['copy-paths'] !== undefined ? args['copy-paths'] : args.paths,
    false,
  );
  const afterCheckoutCommand = String(
    args['after-checkout-command'] ||
      process.env.NOTION_TICKETS_AFTER_CHECKOUT_COMMAND ||
      '',
  ).trim();
  if (afterCheckoutCommand) {
    process.env.NOTION_TICKETS_AFTER_CHECKOUT_COMMAND = afterCheckoutCommand;
  }
  const mapData = await readJsonFileSafe(mapFile, { tickets: {} });
  const aliasMapData = await readJsonFileSafe(aliasMapFile, { aliases: {} });
  const aliases = aliasMapData?.aliases && typeof aliasMapData.aliases === 'object' ? aliasMapData.aliases : {};
  const tickets = mapData?.tickets && typeof mapData.tickets === 'object' ? mapData.tickets : {};
  const rows = sortTickets(
    Object.values(tickets).filter((entry) => entry && typeof entry === 'object' && !entry.cleanupPending),
  );

  if (outputJson) {
    const withAlias = rows.map((entry) => {
      const pageId = String(entry?.pageId || '').trim();
      const aliasEntry = aliases[pageId] && typeof aliases[pageId] === 'object' ? aliases[pageId] : {};
      return {
        ...entry,
        shortcutPath: String(aliasEntry.shortcutPath || '').trim(),
        handoffAliasFile: String(aliasEntry.aliasFile || '').trim(),
      };
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          workspace,
          mapFile,
          aliasMapFile,
          count: rows.length,
          tickets: withAlias,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  print(`workspace: ${workspace}`, colors.dim);
  print(`map file: ${mapFile}`, colors.dim);
  print(`alias map file: ${aliasMapFile}`, colors.dim);

  if (rows.length === 0) {
    print('No active tracked tickets found.', colors.yellow);
    return 0;
  }

  if (checkoutMode) {
    const runAfterCheckout = parseBoolean(args.run, false);
    return runCheckoutSelector(rows, runAfterCheckout);
  }

  if (copyPathsOnly) {
    // Print plain commands without ANSI formatting for easy terminal copy/paste.
    // eslint-disable-next-line no-console
    console.log('# Copy/paste one of these commands:');
    for (const entry of rows) {
      const pageId = String(entry.pageId || '(unknown)');
      const branch = String(entry.branch || '(unknown)');
      const worktreePath = String(entry.worktreePath || '').trim();
      if (!worktreePath) continue;
      // eslint-disable-next-line no-console
      console.log(`cd "${worktreePath}" # ${pageId} ${branch}`);
    }
    return 0;
  }

  print('');
  print(`Active tracked tickets: ${rows.length}`, colors.cyan);
  for (const entry of rows) {
    const pageId = String(entry.pageId || '(unknown)');
    const title = String(entry.pageTitle || '(untitled)');
    const status = String(entry.status || '(unknown)');
    const branch = String(entry.branch || '(unknown)');
    const worktreePath = String(entry.worktreePath || '(unknown)');
    const updatedAt = String(entry.updatedAt || '(unknown)');
    const cleanupPending = entry.cleanupPending ? ' yes' : ' no';
    const aliasEntry = aliases[pageId] && typeof aliases[pageId] === 'object' ? aliases[pageId] : {};
    const shortcutPath = String(aliasEntry.shortcutPath || '').trim();
    print(`- ${pageId} | ${status} | ${branch}`, colors.green);
    print(`  title: ${title}`, colors.dim);
    print(`  worktree: ${worktreePath}`, colors.dim);
    if (shortcutPath) {
      print(`  shortcut: ${shortcutPath}`, colors.cyan);
      print(`  open: cd "${shortcutPath}"`, colors.cyan);
    }
    print(`  updated: ${updatedAt} | cleanup_pending:${cleanupPending}`, colors.dim);
    if (entry.cleanupError) {
      print(`  cleanup_error: ${String(entry.cleanupError)}`, colors.yellow);
    }
  }
  print('');
  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});

