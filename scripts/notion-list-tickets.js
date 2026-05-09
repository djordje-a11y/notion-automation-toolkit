#!/usr/bin/env node
/**
 * notion list tickets
 *
 * Prints active ticket -> worktree mappings from .notion/worktree-map.json.
 */

import process from 'process';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_WORKTREE_MAP_FILE = '.notion/worktree-map.json';

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
  if (!selected) return process.cwd();
  return path.isAbsolute(selected) ? selected : path.resolve(process.cwd(), selected);
}

function resolveMapPath(workspace, raw) {
  const value = String(raw || DEFAULT_WORKTREE_MAP_FILE).trim();
  if (!value) return path.resolve(workspace, DEFAULT_WORKTREE_MAP_FILE);
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
  print('  notion-auto tickets --workspace /path/to/repo');
  print('');
  print('Options:');
  print('  --workspace <path>');
  print(`  --map-file <path> (default ${DEFAULT_WORKTREE_MAP_FILE})`);
  print('  --json true|false');
  print('');
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
  const outputJson = parseBoolean(args.json, false);
  const mapData = await readJsonFileSafe(mapFile, { tickets: {} });
  const tickets = mapData?.tickets && typeof mapData.tickets === 'object' ? mapData.tickets : {};
  const rows = sortTickets(
    Object.values(tickets).filter((entry) => entry && typeof entry === 'object'),
  );

  if (outputJson) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          workspace,
          mapFile,
          count: rows.length,
          tickets: rows,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  print(`workspace: ${workspace}`, colors.dim);
  print(`map file: ${mapFile}`, colors.dim);

  if (rows.length === 0) {
    print('No active tracked tickets found.', colors.yellow);
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
    print(`- ${pageId} | ${status} | ${branch}`, colors.green);
    print(`  title: ${title}`, colors.dim);
    print(`  worktree: ${worktreePath}`, colors.dim);
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

