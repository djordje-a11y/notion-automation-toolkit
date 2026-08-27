#!/usr/bin/env node
/**
 * notion push
 *
 * Reviewer-controlled delivery helper:
 * - commits all uncommitted changes
 * - pushes the current branch
 * - creates or reuses a GitLab MR toward dev
 * - fills MR description with ticket context, solution (commits), and Notion link
 * - assigns configured GitLab reviewers
 */

import process from 'process';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { buildTicketAwareMrDescription } from './notion-mr-description.js';

const DEFAULT_GIT_REMOTE = 'origin';
const DEFAULT_TARGET_BRANCH = 'dev';
const DEFAULT_GITLAB_API_URL = 'https://gitlab.com/api/v4';
const DEFAULT_LOCAL_ENV_FILES = ['.notion.local', '.env.local', 'scripts/.notion.local'];

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

function parseBoolean(value, fallback = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseReviewerIds(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const parts = raw.split(',').map((item) => item.trim());
  if (parts.some((item) => !/^\d+$/.test(item))) {
    fail('GITLAB_REVIEWER_IDS must contain positive numeric IDs separated by commas.');
  }
  const ids = parts.map((item) => Number(item));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    fail('GITLAB_REVIEWER_IDS must contain positive numeric IDs separated by commas.');
  }
  return [...new Set(ids)];
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
      args[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
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

function getOptionalArg(args, key, fallback = '') {
  const value = String(args[key] || '').trim();
  return value || fallback;
}

function resolveWorkspace(argv = process.argv) {
  const args = parseArgs(argv);
  const selected =
    getOptionalArg(args, 'workspace') ||
    String(process.env.NOTION_TOOLKIT_WORKSPACE || process.env.NOTION_WORKSPACE || '').trim();
  if (!selected) return process.cwd();
  return path.isAbsolute(selected) ? selected : path.resolve(process.cwd(), selected);
}

async function runCommandCapture(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(binary, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.stdout) child.stdout.on('data', (chunk) => (stdout += String(chunk || '')));
    if (child.stderr) child.stderr.on('data', (chunk) => (stderr += String(chunk || '')));
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      resolve({ code: Number(code || 0), signal: signal || '', stdout, stderr }),
    );
  });
}

async function runGit(args, cwd) {
  const result = await runCommandCapture('git', args, { cwd });
  if (result.signal) fail(`git ${args.join(' ')} terminated by signal ${result.signal}`);
  if (result.code !== 0) {
    const details = String(result.stderr || result.stdout || '').trim();
    fail(`git ${args.join(' ')} failed: ${details || `exit code ${result.code}`}`);
  }
  return String(result.stdout || '').trim();
}

async function resolveRootWorkspace(cwd) {
  const result = await runCommandCapture('git', ['rev-parse', '--git-common-dir'], { cwd }).catch(
    () => null,
  );
  if (!result || result.code !== 0) return cwd;
  const raw = String(result.stdout || '').trim();
  if (!raw) return cwd;
  const commonDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return path.resolve(commonDir, '..');
}

function stripOptionalQuotes(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/\\n/g, '\n');
  return raw.replace(/\s+#.*$/, '').trim();
}

function parseEnvText(content) {
  const entries = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = normalized.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    entries[key] = stripOptionalQuotes(normalized.slice(eqIndex + 1));
  }
  return entries;
}

async function loadLocalEnv(args, workspace, rootWorkspace) {
  const explicit = getOptionalArg(args, 'env-file');
  const candidates = [
    explicit ? (path.isAbsolute(explicit) ? explicit : path.resolve(workspace, explicit)) : '',
    ...DEFAULT_LOCAL_ENV_FILES.map((file) => path.resolve(workspace, file)),
    ...DEFAULT_LOCAL_ENV_FILES.map((file) => path.resolve(rootWorkspace, file)),
  ];
  const keys = [
    'GITLAB_TOKEN',
    'GITLAB_PROJECT_ID',
    'GITLAB_API_URL',
    'GITLAB_TARGET_BRANCH',
    'GITLAB_REMOTE',
    'GITLAB_REVIEWER_IDS',
    'NOTION_AGENT_GIT_REMOTE',
    'NOTION_PUSH_COMMIT_MESSAGE',
  ];
  const values = {};
  let source = '';
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    let content = '';
    try {
      content = await fs.readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseEnvText(content);
    if (!source && keys.some((key) => parsed[key])) source = candidate;
    for (const key of keys) {
      if (!values[key] && parsed[key]) values[key] = parsed[key];
    }
  }
  return { values, source };
}

function parseGitlabProjectPath(remoteUrl) {
  const sshMatch = String(remoteUrl || '').trim().match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) return String(sshMatch[2] || '').replace(/\.git$/i, '').trim();
  try {
    return new URL(remoteUrl).pathname.replace(/^\/+/, '').replace(/\.git$/i, '').trim();
  } catch {
    return '';
  }
}

function inferGitlabApiUrl(remoteUrl) {
  const sshMatch = String(remoteUrl || '').trim().match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) return `https://${String(sshMatch[1] || '').trim()}/api/v4`;
  try {
    const url = new URL(remoteUrl);
    return `${url.protocol}//${url.host}/api/v4`;
  } catch {
    return DEFAULT_GITLAB_API_URL;
  }
}

function buildGitlabAuthHeader(token) {
  return token.startsWith('glpat-')
    ? { 'PRIVATE-TOKEN': token }
    : { Authorization: `Bearer ${token}` };
}

async function gitlabRequest(config, endpointPath, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${config.gitlabApiUrl}${endpointPath}`, {
    method,
    headers: {
      ...buildGitlabAuthHeader(config.gitlabToken),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.message
      ? typeof payload.message === 'string'
        ? payload.message
        : JSON.stringify(payload.message)
      : payload?.error || `HTTP ${response.status}`;
    fail(`GitLab API request failed: ${String(message).slice(0, 500)}`);
  }
  return payload || {};
}

function defaultCommitMessage(branch) {
  return `Update ${branch.replace(/[\/_-]+/g, ' ').trim()}`;
}

async function resolveMrCopy(config, branch, pendingCommitMessage = '') {
  return buildTicketAwareMrDescription({
    workspace: config.workspace,
    rootWorkspace: config.rootWorkspace,
    branch,
    remote: config.remote,
    targetBranch: config.targetBranch,
    runGit,
    pendingCommitMessage,
  });
}

function printMrDescriptionPreview(description, { dryRun = false } = {}) {
  const label = dryRun ? '[dry-run] MR description:' : 'MR description:';
  const color = dryRun ? colors.yellow : colors.dim;
  const text = String(description || '').trim();
  if (!text) {
    print(`${label} (empty)`, colors.dim);
    return;
  }
  print(label, color);
  for (const line of text.split(/\r?\n/)) {
    print(`  ${line}`, colors.dim);
  }
}

function printUsage() {
  print('');
  print('notion push', colors.cyan);
  print('');
  print('Usage:');
  print('  notion-auto push [--workspace /path/to/repo] [--message "commit message"]');
  print('');
  print('Options:');
  print('  --workspace <path>');
  print('  --message "<commit message>"');
  print('  --remote <name> (default origin)');
  print('  --target-branch <name> (default dev)');
  print('  --reviewer-ids "<id,id,...>"');
  print('  --mr-title "<title>"');
  print('  --mr-description "<text>"');
  print('  --env-file <path>');
  print('  --dry-run true|false');
  print('  --json true|false');
  print('');
  print('Env: GITLAB_TOKEN and GITLAB_REVIEWER_IDS are required.');
  print('');
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help || args.h || args._[0] === 'help') {
    printUsage();
    return 0;
  }

  const workspace = resolveWorkspace(argv);
  try {
    process.chdir(workspace);
  } catch {
    fail(`Workspace path is not accessible: ${workspace}`);
  }
  const rootWorkspace = await resolveRootWorkspace(process.cwd());
  const loadedEnv = await loadLocalEnv(args, process.cwd(), rootWorkspace);
  const config = {
    workspace: process.cwd(),
    rootWorkspace,
    envSource: loadedEnv.source,
    remote: getOptionalArg(
      args,
      'remote',
      process.env.GITLAB_REMOTE ||
        loadedEnv.values.GITLAB_REMOTE ||
        process.env.NOTION_AGENT_GIT_REMOTE ||
        loadedEnv.values.NOTION_AGENT_GIT_REMOTE ||
        DEFAULT_GIT_REMOTE,
    ),
    targetBranch: getOptionalArg(
      args,
      'target-branch',
      process.env.GITLAB_TARGET_BRANCH ||
        loadedEnv.values.GITLAB_TARGET_BRANCH ||
        DEFAULT_TARGET_BRANCH,
    ),
    reviewerIds: parseReviewerIds(
      getOptionalArg(
        args,
        'reviewer-ids',
        process.env.GITLAB_REVIEWER_IDS || loadedEnv.values.GITLAB_REVIEWER_IDS || '',
      ),
    ),
    commitMessage: getOptionalArg(
      args,
      'message',
      process.env.NOTION_PUSH_COMMIT_MESSAGE || loadedEnv.values.NOTION_PUSH_COMMIT_MESSAGE || '',
    ),
    mrTitle: getOptionalArg(args, 'mr-title'),
    mrDescription: getOptionalArg(args, 'mr-description'),
    gitlabToken: String(process.env.GITLAB_TOKEN || loadedEnv.values.GITLAB_TOKEN || '').trim(),
    gitlabProjectId: String(
      process.env.GITLAB_PROJECT_ID || loadedEnv.values.GITLAB_PROJECT_ID || '',
    ).trim(),
    gitlabApiUrl: String(
      process.env.GITLAB_API_URL || loadedEnv.values.GITLAB_API_URL || '',
    ).trim(),
    dryRun: parseBoolean(getOptionalArg(args, 'dry-run', 'false'), false),
    json: parseBoolean(getOptionalArg(args, 'json', 'false'), false),
  };

  await runGit(['rev-parse', '--is-inside-work-tree'], config.workspace);
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], config.workspace);
  if (!branch || branch === 'HEAD') fail('Detached HEAD is not supported for notion-auto push.');
  if (branch === config.targetBranch) {
    fail(`Refusing to create an MR from the target branch '${config.targetBranch}'.`);
  }
  if (!config.gitlabToken && !config.dryRun) {
    fail('GITLAB_TOKEN is required for notion-auto push.');
  }
  if (config.reviewerIds.length === 0) {
    fail('GITLAB_REVIEWER_IDS is required for notion-auto push.');
  }

  const remoteUrl = await runGit(['remote', 'get-url', config.remote], config.workspace);
  config.gitlabApiUrl = config.gitlabApiUrl || inferGitlabApiUrl(remoteUrl);
  const projectRef =
    config.gitlabProjectId || encodeURIComponent(parseGitlabProjectPath(remoteUrl) || '');
  if (!projectRef) {
    fail('Could not infer GitLab project. Set GITLAB_PROJECT_ID in .notion.local.');
  }

  const status = await runGit(['status', '--porcelain'], config.workspace);
  const hasChanges = Boolean(status);
  const commitMessage = config.commitMessage || defaultCommitMessage(branch);

  if (config.dryRun) {
    print(`[dry-run] branch: ${branch}`, colors.dim);
    print(
      hasChanges ? `[dry-run] commit all changes: "${commitMessage}"` : '[dry-run] commit: no changes',
      hasChanges ? colors.yellow : colors.dim,
    );
    print(`[dry-run] push: git push -u ${config.remote} HEAD`, colors.yellow);
  } else {
    if (hasChanges) {
      await runGit(['add', '-A'], config.workspace);
      await runGit(['commit', '-m', commitMessage], config.workspace);
    }
    await runGit(['push', '-u', config.remote, 'HEAD'], config.workspace);
  }

  const generated =
    config.mrTitle && config.mrDescription
      ? null
      : await resolveMrCopy(config, branch, config.dryRun && hasChanges ? commitMessage : '');
  const title = config.mrTitle || generated?.title || `${branch} -> ${config.targetBranch}`;
  const description = config.mrDescription || generated?.description || '';

  if (config.dryRun) {
    print(
      `[dry-run] MR: ${title}; reviewers=${config.reviewerIds.join(',')}`,
      colors.yellow,
    );
    if (!config.mrDescription) printMrDescriptionPreview(description, { dryRun: true });
  }

  let mrUrl = '';
  let mrIid = null;
  let mrCreated = null;
  if (!config.dryRun) {
    const existing = await gitlabRequest(
      config,
      `/projects/${projectRef}/merge_requests?state=opened&source_branch=${encodeURIComponent(
        branch,
      )}&target_branch=${encodeURIComponent(config.targetBranch)}`,
    );
    const existingMr = Array.isArray(existing) ? existing[0] : null;
    if (existingMr) {
      mrIid = Number(existingMr.iid || 0) || null;
      mrUrl = String(existingMr.web_url || '').trim();
      if (!mrIid) fail('Existing GitLab MR is missing its IID.');
      const updated = await gitlabRequest(
        config,
        `/projects/${projectRef}/merge_requests/${mrIid}`,
        { method: 'PUT', body: { reviewer_ids: config.reviewerIds } },
      );
      mrUrl = String(updated.web_url || mrUrl).trim();
      mrCreated = false;
    } else {
      const created = await gitlabRequest(config, `/projects/${projectRef}/merge_requests`, {
        method: 'POST',
        body: {
          source_branch: branch,
          target_branch: config.targetBranch,
          title,
          description,
          reviewer_ids: config.reviewerIds,
          remove_source_branch: false,
        },
      });
      mrIid = Number(created.iid || 0) || null;
      mrUrl = String(created.web_url || '').trim();
      mrCreated = true;
    }
  }

  const output = {
    workspace: config.workspace,
    branch,
    committed: config.dryRun ? null : hasChanges,
    commitMessage: hasChanges ? commitMessage : null,
    remote: config.remote,
    targetBranch: config.targetBranch,
    reviewerIds: config.reviewerIds,
    dryRun: config.dryRun,
    mrCreated,
    mrIid,
    mrUrl: mrUrl || null,
  };

  if (config.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }
  if (config.envSource) print(`env source: ${config.envSource}`, colors.dim);
  print(`branch: ${branch}`, colors.green);
  if (!config.dryRun) {
    print(hasChanges ? `commit: ${commitMessage}` : 'commit: skipped (no changes)', colors.dim);
    print(`push: ${config.remote}/${branch}`, colors.green);
    print(`MR: ${mrUrl || 'created but URL missing'}`, mrUrl ? colors.green : colors.yellow);
    print(`reviewers: ${config.reviewerIds.join(', ')}`, colors.green);
  }
  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
