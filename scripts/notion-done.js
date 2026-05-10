#!/usr/bin/env node
/**
 * notion done
 *
 * End-of-task helper:
 * - verifies git state
 * - pushes current branch (git push -u origin HEAD when branch has no remote)
 * - opens GitLab MR toward target branch (default: dev)
 * - enables GitLab auto-merge (merge when pipeline succeeds)
 */

import process from 'process';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs/promises';

const DEFAULT_GIT_REMOTE = 'origin';
const DEFAULT_TARGET_BRANCH = 'dev';
const DEFAULT_GITLAB_API_URL = 'https://gitlab.com/api/v4';
const DEFAULT_AUTO_MERGE = true;
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

function getOptionalArg(args, key, fallback = '') {
  const value = String(args[key] || '').trim();
  return value || fallback;
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

async function resolveRootWorkspaceFromGitOrCwd(cwd = process.cwd()) {
  const result = await runCommandCapture('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    env: process.env,
  }).catch(() => null);
  if (!result || result.code !== 0) return cwd;
  const commonDirRaw = String(result.stdout || '').trim();
  if (!commonDirRaw) return cwd;
  const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(cwd, commonDirRaw);
  return path.resolve(commonDir, '..');
}

function resolveEnvFileCandidate(baseDir, rawPath) {
  const normalizedPath = String(rawPath || '').trim();
  if (!normalizedPath) return '';
  if (path.isAbsolute(normalizedPath)) return normalizedPath;
  return path.resolve(baseDir, normalizedPath);
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue || seen.has(normalizedValue)) continue;
    seen.add(normalizedValue);
    out.push(normalizedValue);
  }
  return out;
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
    const normalizedLine = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = normalizedLine.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = normalizedLine.slice(0, eqIndex).trim();
    const value = normalizedLine.slice(eqIndex + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    entries[key] = stripOptionalQuotes(value);
  }
  return entries;
}

async function loadLocalEnvValues(args, workspace, rootWorkspace) {
  const explicit = resolveEnvFileCandidate(workspace, getOptionalArg(args, 'env-file'));
  const fromEnv = resolveEnvFileCandidate(workspace, process.env.NOTION_ENV_FILE || '');
  const workspaceDefaults = DEFAULT_LOCAL_ENV_FILES.map((candidate) =>
    resolveEnvFileCandidate(workspace, candidate),
  );
  const rootDefaults = DEFAULT_LOCAL_ENV_FILES.map((candidate) =>
    resolveEnvFileCandidate(rootWorkspace, candidate),
  );
  const fromHome = resolveEnvFileCandidate(
    workspace,
    process.env.HOME ? path.join(process.env.HOME, '.config', 'meetric', 'notion.env') : '',
  );
  const candidates = uniqueNonEmpty([explicit, fromEnv, ...workspaceDefaults, ...rootDefaults, fromHome]);

  const keys = [
    'GITLAB_TOKEN',
    'GITLAB_PROJECT_ID',
    'GITLAB_API_URL',
    'GITLAB_TARGET_BRANCH',
    'GITLAB_REMOTE',
    'GITLAB_AUTO_MERGE',
    'NOTION_AGENT_GIT_REMOTE',
  ];
  const values = {};
  let source = '';

  for (const candidate of candidates) {
    let fileContent = '';
    try {
      fileContent = await fs.readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseEnvText(fileContent);
    if (!source && keys.some((key) => String(parsed[key] || '').trim())) source = candidate;
    for (const key of keys) {
      if (values[key]) continue;
      const nextValue = String(parsed[key] || '').trim();
      if (!nextValue) continue;
      values[key] = nextValue;
    }
  }

  return { values, source };
}

async function runCommandCapture(binary, args, options = {}) {
  const cwd = String(options.cwd || process.cwd());
  const env = options.env || process.env;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.stdout) child.stdout.on('data', (chunk) => (stdout += String(chunk || '')));
    if (child.stderr) child.stderr.on('data', (chunk) => (stderr += String(chunk || '')));
    child.on('error', (error) => reject(error));
    child.on('exit', (code, signal) =>
      resolve({
        code: Number(code || 0),
        signal: signal || '',
        stdout,
        stderr,
      }),
    );
  });
}

async function runGit(args, cwd) {
  const result = await runCommandCapture('git', args, { cwd, env: process.env });
  if (result.signal) {
    fail(`git ${args.join(' ')} terminated by signal ${result.signal}`);
  }
  if (result.code !== 0) {
    const details = String(result.stderr || result.stdout || '').trim();
    fail(`git ${args.join(' ')} failed: ${details || `exit code ${result.code}`}`);
  }
  return String(result.stdout || '').trim();
}

function parseGitlabProjectPathFromRemote(remoteUrlRaw) {
  const remoteUrl = String(remoteUrlRaw || '').trim();
  if (!remoteUrl) return '';
  // ssh: git@gitlab.com:group/subgroup/project.git
  const sshMatch = remoteUrl.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    return String(sshMatch[2] || '').replace(/\.git$/i, '').trim();
  }
  // https: https://gitlab.com/group/subgroup/project.git
  try {
    const asUrl = new URL(remoteUrl);
    return String(asUrl.pathname || '').replace(/^\/+/, '').replace(/\.git$/i, '').trim();
  } catch {
    return '';
  }
}

function inferGitlabApiUrl(remoteUrlRaw) {
  const remoteUrl = String(remoteUrlRaw || '').trim();
  if (!remoteUrl) return DEFAULT_GITLAB_API_URL;
  const sshMatch = remoteUrl.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) return `https://${String(sshMatch[1] || '').trim()}/api/v4`;
  try {
    const asUrl = new URL(remoteUrl);
    return `${asUrl.protocol}//${asUrl.host}/api/v4`;
  } catch {
    return DEFAULT_GITLAB_API_URL;
  }
}

function buildGitlabAuthHeader(token) {
  const raw = String(token || '').trim();
  if (raw.startsWith('glpat-')) return { 'PRIVATE-TOKEN': raw };
  return { Authorization: `Bearer ${raw}` };
}

async function gitlabRequest(config, endpointPath, { method = 'GET', body = null } = {}) {
  const endpoint = endpointPath.startsWith('/')
    ? `${config.gitlabApiUrl}${endpointPath}`
    : `${config.gitlabApiUrl}/${endpointPath}`;
  const response = await fetch(endpoint, {
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

function buildDefaultMrTitle(branchName, targetBranch) {
  return `${branchName} -> ${targetBranch}`;
}

const AUTO_MERGE_MAX_RETRIES = 4;
const AUTO_MERGE_RETRY_DELAY_MS = 10_000;

async function enableGitlabAutoMerge(config, projectRef, mrIid, currentHeadSha = '') {
  if (!mrIid) fail('Cannot enable auto-merge: merge request IID is missing.');
  const body = {
    auto_merge: true,
    merge_when_pipeline_succeeds: true,
  };
  const headSha = String(currentHeadSha || '').trim();
  if (headSha) body.sha = headSha;

  let lastError = null;
  for (let attempt = 1; attempt <= AUTO_MERGE_MAX_RETRIES; attempt++) {
    try {
      return await gitlabRequest(config, `/projects/${projectRef}/merge_requests/${mrIid}/merge`, {
        method: 'PUT',
        body,
      });
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || '').toLowerCase();
      const retryable = msg.includes('cannot be merged') || msg.includes('405');
      if (!retryable || attempt === AUTO_MERGE_MAX_RETRIES) break;
      print(
        `Auto-merge attempt ${attempt}/${AUTO_MERGE_MAX_RETRIES} failed (pipeline not ready), retrying in ${AUTO_MERGE_RETRY_DELAY_MS / 1000}s...`,
        colors.dim,
      );
      await new Promise((resolve) => setTimeout(resolve, AUTO_MERGE_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

function printUsage() {
  print('');
  print('notion done', colors.cyan);
  print('');
  print('Usage:');
  print('  notion-auto done');
  print('  notion-auto done [--workspace /path/to/repo]');
  print('');
  print('Options:');
  print('  --workspace <path>');
  print(`  --remote <name> (default ${DEFAULT_GIT_REMOTE})`);
  print(`  --target-branch <name> (default ${DEFAULT_TARGET_BRANCH})`);
  print('  --env-file <path>');
  print('  --mr-title "<title>"');
  print('  --mr-description "<text>"');
  print(`  --auto-merge true|false (default ${DEFAULT_AUTO_MERGE ? 'true' : 'false'})`);
  print('  --push-only true|false');
  print('  --dry-run true|false');
  print('  --json true|false');
  print('');
  print('Env:');
  print('  GITLAB_TOKEN (required unless --push-only=true or --dry-run=true)');
  print(`  GITLAB_TARGET_BRANCH (optional; default ${DEFAULT_TARGET_BRANCH})`);
  print(`  GITLAB_REMOTE (optional; default ${DEFAULT_GIT_REMOTE})`);
  print(`  GITLAB_AUTO_MERGE (optional; default ${DEFAULT_AUTO_MERGE ? 'true' : 'false'})`);
  print('  GITLAB_PROJECT_ID (optional; fallback uses remote URL path)');
  print('  GITLAB_API_URL (optional; fallback inferred from remote, then gitlab.com)');
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
  const rootWorkspace = await resolveRootWorkspaceFromGitOrCwd(process.cwd());
  const loadedEnv = await loadLocalEnvValues(args, process.cwd(), rootWorkspace);

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
    mrTitle: getOptionalArg(args, 'mr-title'),
    mrDescription: getOptionalArg(args, 'mr-description'),
    autoMerge: parseBoolean(
      getOptionalArg(
        args,
        'auto-merge',
        process.env.GITLAB_AUTO_MERGE ||
          loadedEnv.values.GITLAB_AUTO_MERGE ||
          String(DEFAULT_AUTO_MERGE),
      ),
      DEFAULT_AUTO_MERGE,
    ),
    pushOnly: parseBoolean(getOptionalArg(args, 'push-only', 'false'), false),
    dryRun: parseBoolean(getOptionalArg(args, 'dry-run', 'false'), false),
    json: parseBoolean(getOptionalArg(args, 'json', 'false'), false),
    gitlabToken: String(process.env.GITLAB_TOKEN || loadedEnv.values.GITLAB_TOKEN || '').trim(),
    gitlabProjectId: String(
      process.env.GITLAB_PROJECT_ID || loadedEnv.values.GITLAB_PROJECT_ID || '',
    ).trim(),
    gitlabApiUrl: String(process.env.GITLAB_API_URL || loadedEnv.values.GITLAB_API_URL || '').trim(),
  };

  await runGit(['rev-parse', '--is-inside-work-tree'], config.workspace);
  const currentBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], config.workspace);
  if (!currentBranch || currentBranch === 'HEAD') {
    fail('Detached HEAD is not supported for notion-auto done.');
  }

  const status = await runGit(['status', '--porcelain'], config.workspace);
  if (status) {
    fail('Working tree is not clean. Commit/stash changes before running notion-auto done.');
  }

  const remoteUrl = await runGit(['remote', 'get-url', config.remote], config.workspace);
  const gitlabApiUrlInferred = inferGitlabApiUrl(remoteUrl);
  config.gitlabApiUrl = config.gitlabApiUrl || gitlabApiUrlInferred;

  const remoteBranchExistsOutput = await runGit(
    ['ls-remote', '--heads', config.remote, currentBranch],
    config.workspace,
  );
  const remoteBranchExists = Boolean(remoteBranchExistsOutput.trim());
  let aheadCount = 0;
  if (remoteBranchExists) {
    const aheadRaw = await runGit(
      ['rev-list', '--count', `${config.remote}/${currentBranch}..HEAD`],
      config.workspace,
    );
    aheadCount = Number.parseInt(String(aheadRaw || '').trim(), 10);
    if (!Number.isFinite(aheadCount)) aheadCount = 0;
  }

  const willPush = !remoteBranchExists || aheadCount > 0;
  const pushCommand = !remoteBranchExists
    ? `git push -u ${config.remote} HEAD`
    : aheadCount > 0
      ? `git push ${config.remote} HEAD`
      : '(skip push: remote branch up to date)';

  let mrUrl = '';
  let mrCreated = false;
  let mrIid = null;
  let autoMergeEnabled = null;
  let autoMergeMessage = '';

  if (config.dryRun) {
    print(`[dry-run] workspace: ${config.workspace}`, colors.dim);
    if (config.envSource) print(`[dry-run] env source: ${config.envSource}`, colors.dim);
    print(`[dry-run] branch: ${currentBranch}`, colors.dim);
    print(`[dry-run] push: ${pushCommand}`, colors.yellow);
  } else if (willPush) {
    if (!remoteBranchExists) {
      await runGit(['push', '-u', config.remote, 'HEAD'], config.workspace);
    } else {
      await runGit(['push', config.remote, 'HEAD'], config.workspace);
    }
  }

  if (!config.pushOnly) {
    if (!config.gitlabToken && !config.dryRun) {
      fail('GITLAB_TOKEN is required to create merge requests (or use --push-only true).');
    }

    const projectRef =
      config.gitlabProjectId ||
      encodeURIComponent(parseGitlabProjectPathFromRemote(remoteUrl) || '');
    if (!projectRef) {
      fail(
        'Could not infer GitLab project from remote URL. Set GITLAB_PROJECT_ID (numeric id or URL-encoded path).',
      );
    }

    const title = config.mrTitle || buildDefaultMrTitle(currentBranch, config.targetBranch);
    const description = config.mrDescription || 'Automated MR created by notion-auto done.';

    if (config.dryRun) {
      print(
        `[dry-run] MR create: source=${currentBranch} target=${config.targetBranch} title="${title}"`,
        colors.yellow,
      );
      if (config.autoMerge) {
        print('[dry-run] MR auto-merge: enable when pipeline succeeds', colors.yellow);
      } else {
        print('[dry-run] MR auto-merge: skipped (--auto-merge false)', colors.dim);
      }
    } else {
      const existing = await gitlabRequest(
        config,
        `/projects/${projectRef}/merge_requests?state=opened&source_branch=${encodeURIComponent(
          currentBranch,
        )}&target_branch=${encodeURIComponent(config.targetBranch)}`,
        { method: 'GET' },
      );
      const existingList = Array.isArray(existing) ? existing : [];
      if (existingList.length > 0) {
        mrUrl = String(existingList[0]?.web_url || '').trim();
        mrIid = Number(existingList[0]?.iid || 0) || null;
      } else {
        const created = await gitlabRequest(config, `/projects/${projectRef}/merge_requests`, {
          method: 'POST',
          body: {
            source_branch: currentBranch,
            target_branch: config.targetBranch,
            title,
            description,
            remove_source_branch: false,
          },
        });
        mrUrl = String(created?.web_url || '').trim();
        mrIid = Number(created?.iid || 0) || null;
        mrCreated = true;
      }

      if (config.autoMerge && mrIid) {
        try {
          const mergeResult = await enableGitlabAutoMerge(
            config,
            projectRef,
            mrIid,
            await runGit(['rev-parse', 'HEAD'], config.workspace),
          );
          autoMergeEnabled = true;
          const detailedMessage = String(mergeResult?.message || '').trim();
          autoMergeMessage = detailedMessage || 'enabled';
        } catch (error) {
          autoMergeEnabled = false;
          autoMergeMessage = String(error?.message || error || 'unknown auto-merge error');
        }
      } else if (config.autoMerge && !mrIid) {
        autoMergeEnabled = false;
        autoMergeMessage = 'MR IID missing from GitLab response';
      } else if (!config.autoMerge) {
        autoMergeEnabled = false;
        autoMergeMessage = 'disabled by config';
      }
    }
  }

  const output = {
    workspace: config.workspace,
    branch: currentBranch,
    remote: config.remote,
    remoteBranchExists,
    aheadCount,
    pushed: config.dryRun ? null : willPush,
    pushCommand,
    targetBranch: config.targetBranch,
    pushOnly: config.pushOnly,
    autoMerge: config.pushOnly ? null : config.autoMerge,
    autoMergeEnabled:
      config.pushOnly || config.dryRun || !config.autoMerge ? null : autoMergeEnabled,
    autoMergeMessage:
      config.pushOnly || config.dryRun ? null : autoMergeMessage || null,
    dryRun: config.dryRun,
    mrCreated: config.pushOnly ? null : config.dryRun ? null : mrCreated,
    mrIid: config.pushOnly ? null : mrIid,
    mrUrl: config.pushOnly ? null : mrUrl || null,
  };

  if (config.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }

  print(`workspace: ${output.workspace}`, colors.dim);
  if (config.envSource) print(`env source: ${config.envSource}`, colors.dim);
  print(`branch: ${output.branch}`, colors.green);
  print(`push: ${output.pushCommand}`, output.pushed ? colors.green : colors.dim);
  if (!config.pushOnly) {
    if (config.dryRun) {
      print('MR: dry-run preview complete', colors.yellow);
    } else if (output.mrUrl) {
      print(`MR: ${output.mrUrl}`, colors.green);
    } else {
      print('MR: created but URL missing from API response', colors.yellow);
    }
    if (!config.dryRun) {
      if (!config.autoMerge) {
        print('Auto-merge: skipped (--auto-merge false)', colors.dim);
      } else if (autoMergeEnabled) {
        print('Auto-merge: enabled (when pipeline succeeds)', colors.green);
      } else {
        print(
          `Auto-merge: failed (${autoMergeMessage || 'unknown reason'})`,
          colors.yellow,
        );
      }
    }
  } else {
    print('MR: skipped (--push-only true)', colors.dim);
  }
  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});

