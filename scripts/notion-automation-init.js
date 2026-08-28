#!/usr/bin/env node
/**
 * notion automation init
 *
 * Workspace-local bootstrap:
 * - Ensures .notion directories exist for generated artifacts.
 * - Appends required ignore entries to .git/info/exclude.
 */

import process from 'process';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const REQUIRED_EXCLUDES = [
  '.notion/',
  '.notion.local',
  'notion-handoff.md',
  'notion-review.md',
  'notion-review-*.md',
];

function print(message, color = '') {
  // eslint-disable-next-line no-console
  console.log(`${color}${message}${colors.reset}`);
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
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function resolveWorkspaceFromArgs(args) {
  const raw = String(
    args.workspace || process.env.NOTION_TOOLKIT_WORKSPACE || process.env.NOTION_WORKSPACE || '',
  ).trim();
  if (!raw) return process.cwd();
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

async function runGit(workspace, gitArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs, {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (chunk) => (stdout += String(chunk || '')));
    if (child.stderr) child.stderr.on('data', (chunk) => (stderr += String(chunk || '')));

    child.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `git ${gitArgs.join(' ')} failed (${code})`));
    });
    child.on('error', (error) => reject(error));
  });
}

async function ensureWorkspaceIsGitRepo(workspace) {
  try {
    const result = await runGit(workspace, ['rev-parse', '--is-inside-work-tree']);
    return String(result).trim() === 'true';
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    print('');
    print('notion automation init', colors.cyan);
    print('');
    print('Usage:');
    print('  node scripts/notion-automation-init.js [--workspace <path>]');
    print('');
    return 0;
  }

  const workspace = resolveWorkspaceFromArgs(args);
  try {
    process.chdir(workspace);
  } catch {
    throw new Error(`Workspace path is not accessible: ${workspace}`);
  }

  const isGitRepo = await ensureWorkspaceIsGitRepo(workspace);
  if (!isGitRepo) {
    throw new Error(`Workspace is not a git repository: ${workspace}`);
  }

  print(`workspace: ${workspace}`, colors.dim);

  const gitExcludePath = await runGit(workspace, ['rev-parse', '--git-path', 'info/exclude']);
  const excludeAbsolute = path.isAbsolute(gitExcludePath)
    ? gitExcludePath
    : path.resolve(workspace, gitExcludePath);

  await fs.mkdir(path.resolve(workspace, '.notion', 'handoffs'), { recursive: true });
  await fs.mkdir(path.resolve(workspace, '.notion', 'intake'), { recursive: true });
  await fs.mkdir(path.resolve(workspace, '.notion', 'reviews'), { recursive: true });

  const existing = await readTextIfExists(excludeAbsolute);
  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const missing = REQUIRED_EXCLUDES.filter((entry) => !lines.includes(entry));

  if (missing.length > 0) {
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
    const prefix = needsLeadingNewline ? '\n' : '';
    const appended = `${prefix}${missing.join('\n')}\n`;
    await fs.mkdir(path.dirname(excludeAbsolute), { recursive: true });
    await fs.appendFile(excludeAbsolute, appended, 'utf8');
    print(`Updated ${excludeAbsolute} with: ${missing.join(', ')}`, colors.green);
  } else {
    print(`${excludeAbsolute} already contains required ignore entries.`, colors.dim);
  }

  print('Ensured local directories: .notion/handoffs, .notion/intake, and .notion/reviews', colors.green);
  print('notion automation init complete.', colors.green);
  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
