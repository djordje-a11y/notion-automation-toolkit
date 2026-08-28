#!/usr/bin/env node
/**
 * notion automation launcher
 *
 * Goal:
 * - Validate local Notion automation requirements.
 * - Start Notion polling bridge.
 * - Write runtime metadata for stop helper.
 */

import process from 'process';
import fs from 'fs/promises';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const SELECTED_WORKSPACE = resolveWorkspaceFromArgv(
  process.argv,
  process.env.NOTION_TOOLKIT_WORKSPACE || process.env.NOTION_WORKSPACE || '',
);
try {
  process.chdir(SELECTED_WORKSPACE);
} catch {
  throw new Error(`Workspace path is not accessible: ${SELECTED_WORKSPACE}`);
}

const DEFAULT_LOCAL_ENV_FILES = ['.notion.local', '.env.local', 'scripts/.notion.local'];
const DEFAULT_API_URL = 'https://api.notion.com/v1';
const DEFAULT_API_VERSION = '2022-06-28';
const DEFAULT_RUNTIME_FILE = '.notion/runtime.json';
const DEFAULT_STATE_FILE = '.notion/bridge-state.json';
const DEFAULT_BRIDGE_READY_TIMEOUT_MS = 180000;
const DEFAULT_REQUIRE_LOCAL_IGNORES = true;
const REQUIRED_LOCAL_IGNORE_ENTRIES = [
  '.notion/',
  '.notion.local',
  'notion-handoff.md',
  'notion-review.md',
  'notion-review-*.md',
];

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

function resolveEnvFileCandidate(rawPath) {
  const normalizedPath = String(rawPath || '').trim();
  if (!normalizedPath) return '';
  if (path.isAbsolute(normalizedPath)) return normalizedPath;
  return path.resolve(process.cwd(), normalizedPath);
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

function resolveEnvFileCandidates(args) {
  const explicit = resolveEnvFileCandidate(getOptionalArg(args, 'env-file'));
  const fromEnv = resolveEnvFileCandidate(process.env.NOTION_ENV_FILE);
  const defaults = DEFAULT_LOCAL_ENV_FILES.map((candidate) => resolveEnvFileCandidate(candidate));
  const fromHome = resolveEnvFileCandidate(
    process.env.HOME ? path.join(process.env.HOME, '.config', 'meetric', 'notion.env') : '',
  );
  return uniqueNonEmpty([explicit, fromEnv, ...defaults, fromHome]);
}

async function loadNotionEnvValues(args) {
  const candidates = resolveEnvFileCandidates(args);
  const keys = [
    'NOTION_API_TOKEN',
    'NOTION_API_URL',
    'NOTION_API_VERSION',
    'NOTION_DATABASE_ID',
    'NOTION_DATA_SOURCE_ID',
    'NOTION_ON_MATCH_COMMAND',
    'NOTION_AUTOMATION_RUNTIME_FILE',
    'NOTION_BRIDGE_STATE_FILE',
    'NOTION_REQUIRE_LOCAL_IGNORES',
    'NOTION_ENV_FILE',
    'NOTION_TRIGGER_STATUS',
    'NOTION_STATUS_PROPERTY',
    'NOTION_ASSIGNEE_PROPERTY',
    'NOTION_ASSIGNEE_IDS',
    'NOTION_AGENT_RULES_FILE',
    'NOTION_AGENT_GIT_BASE_BRANCH',
    'GITLAB_TOKEN',
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
    const hasInterestingKeys = keys.some((key) => String(parsed[key] || '').trim());
    if (!source && hasInterestingKeys) source = candidate;

    for (const key of keys) {
      if (values[key]) continue;
      const nextValue = String(parsed[key] || '').trim();
      if (!nextValue) continue;
      values[key] = nextValue;
    }
  }

  return {
    values,
    source,
  };
}

function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}...${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function parseIgnoreFilePatterns(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
}

function normalizeIgnorePattern(value) {
  return String(value || '')
    .trim()
    .replace(/^\.?\//, '');
}

function matchesRequiredIgnore(pattern, requiredEntry) {
  const normalizedPattern = normalizeIgnorePattern(pattern);
  const normalizedRequired = normalizeIgnorePattern(requiredEntry);
  if (!normalizedPattern || !normalizedRequired) return false;

  if (normalizedRequired === '.notion/') {
    return (
      normalizedPattern === '.notion/' ||
      normalizedPattern === '.notion' ||
      normalizedPattern.startsWith('.notion/')
    );
  }
  return normalizedPattern === normalizedRequired;
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function runGit(workspace, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
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
      reject(new Error(stderr.trim() || `git ${args.join(' ')} failed with code ${code}`));
    });
    child.on('error', (error) => reject(error));
  });
}

async function evaluateLocalIgnoreCoverage(workspace) {
  const trackedGitignorePath = path.resolve(workspace, '.gitignore');
  const trackedGitignoreContent = await readTextIfExists(trackedGitignorePath);

  let localExcludePath = '';
  let localExcludeContent = '';
  try {
    const gitExcludePath = await runGit(workspace, ['rev-parse', '--git-path', 'info/exclude']);
    localExcludePath = path.isAbsolute(gitExcludePath)
      ? gitExcludePath
      : path.resolve(workspace, gitExcludePath);
    localExcludeContent = await readTextIfExists(localExcludePath);
  } catch {
    localExcludePath = '';
    localExcludeContent = '';
  }

  const allPatterns = [
    ...parseIgnoreFilePatterns(trackedGitignoreContent),
    ...parseIgnoreFilePatterns(localExcludeContent),
  ];
  const missing = REQUIRED_LOCAL_IGNORE_ENTRIES.filter(
    (requiredEntry) => !allPatterns.some((pattern) => matchesRequiredIgnore(pattern, requiredEntry)),
  );

  return {
    ok: missing.length === 0,
    missing,
    checkedFiles: [trackedGitignorePath, localExcludePath].filter(Boolean),
  };
}

function buildRuntimeConfig(args, envValues, envFile) {
  const token = String(process.env.NOTION_API_TOKEN || envValues.NOTION_API_TOKEN || '').trim();
  const databaseId = String(
    process.env.NOTION_DATABASE_ID || envValues.NOTION_DATABASE_ID || '',
  ).trim();
  const dataSourceId = String(
    process.env.NOTION_DATA_SOURCE_ID || envValues.NOTION_DATA_SOURCE_ID || '',
  ).trim();
  const runtimeFileRaw = getOptionalArg(
    args,
    'runtime-file',
    process.env.NOTION_AUTOMATION_RUNTIME_FILE ||
      envValues.NOTION_AUTOMATION_RUNTIME_FILE ||
      DEFAULT_RUNTIME_FILE,
  );
  const stateFileRaw = getOptionalArg(
    args,
    'state-file',
    process.env.NOTION_BRIDGE_STATE_FILE || envValues.NOTION_BRIDGE_STATE_FILE || DEFAULT_STATE_FILE,
  );

  return {
    envFile,
    token,
    apiUrl: String(process.env.NOTION_API_URL || envValues.NOTION_API_URL || DEFAULT_API_URL).replace(/\/$/, ''),
    apiVersion: String(
      process.env.NOTION_API_VERSION || envValues.NOTION_API_VERSION || DEFAULT_API_VERSION,
    ).trim(),
    databaseId,
    dataSourceId,
    triggerStatus: String(
      process.env.NOTION_TRIGGER_STATUS || envValues.NOTION_TRIGGER_STATUS || '',
    ).trim(),
    statusPropertyName: String(
      process.env.NOTION_STATUS_PROPERTY || envValues.NOTION_STATUS_PROPERTY || 'Status',
    ).trim(),
    assigneePropertyName: String(
      process.env.NOTION_ASSIGNEE_PROPERTY || envValues.NOTION_ASSIGNEE_PROPERTY || 'Assignee',
    ).trim(),
    assigneeIds: String(process.env.NOTION_ASSIGNEE_IDS || envValues.NOTION_ASSIGNEE_IDS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    rulesFile: String(
      process.env.NOTION_AGENT_RULES_FILE || envValues.NOTION_AGENT_RULES_FILE || '.notion/agent-rules.md',
    ).trim(),
    gitBaseBranch: String(
      process.env.NOTION_AGENT_GIT_BASE_BRANCH || envValues.NOTION_AGENT_GIT_BASE_BRANCH || 'dev',
    ).trim(),
    gitlabToken: String(process.env.GITLAB_TOKEN || envValues.GITLAB_TOKEN || '').trim(),
    skipLiveCheck: parseBoolean(getOptionalArg(args, 'skip-live-check'), false),
    onMatchCommand: String(
      process.env.NOTION_ON_MATCH_COMMAND || envValues.NOTION_ON_MATCH_COMMAND || '',
    ).trim(),
    runtimeFile: path.isAbsolute(runtimeFileRaw)
      ? runtimeFileRaw
      : path.resolve(process.cwd(), runtimeFileRaw),
    stateFile: path.isAbsolute(stateFileRaw) ? stateFileRaw : path.resolve(process.cwd(), stateFileRaw),
    requireLocalIgnores: parseBoolean(
      getOptionalArg(
        args,
        'require-local-ignores',
        process.env.NOTION_REQUIRE_LOCAL_IGNORES ||
          envValues.NOTION_REQUIRE_LOCAL_IGNORES ||
          String(DEFAULT_REQUIRE_LOCAL_IGNORES),
      ),
      DEFAULT_REQUIRE_LOCAL_IGNORES,
    ),
    checkOnly: Boolean(args.check),
  };
}

function validateRequirements(config) {
  const items = [
    {
      key: 'NOTION_API_TOKEN',
      ok: Boolean(config.token),
      required: true,
      message: config.token ? 'Configured' : 'Missing Notion API token',
    },
    {
      key: 'NOTION_DATABASE_ID',
      ok: Boolean(config.databaseId),
      required: true,
      message: config.databaseId ? 'Configured' : 'Missing target Notion database ID',
    },
    {
      key: 'NOTION_ON_MATCH_COMMAND',
      ok: Boolean(config.onMatchCommand),
      required: true,
      message: config.onMatchCommand ? 'Configured' : 'Missing agent spawn command',
    },
    {
      key: 'LOCAL_IGNORES',
      ok: !config.requireLocalIgnores || Boolean(config.localIgnoreCheck?.ok),
      required: config.requireLocalIgnores,
      message: !config.requireLocalIgnores
        ? 'Disabled by NOTION_REQUIRE_LOCAL_IGNORES=false'
        : config.localIgnoreCheck?.ok
          ? `Configured in: ${(config.localIgnoreCheck?.checkedFiles || []).join(', ')}`
          : `Missing ignore entries: ${(config.localIgnoreCheck?.missing || []).join(', ')} (run: notion-auto init --workspace ${process.cwd()})`,
    },
  ];

  return items;
}

async function notionRequestSafe(config, endpointPath, { method = 'GET', body = null } = {}) {
  const endpoint = endpointPath.startsWith('/')
    ? `${config.apiUrl}${endpointPath}`
    : `${config.apiUrl}/${endpointPath}`;

  try {
    const response = await fetch(endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Notion-Version': config.apiVersion,
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
      const message =
        payload?.message ||
        payload?.code ||
        payload?.error ||
        `HTTP ${response.status}`;
      return { ok: false, status: response.status, payload, message: String(message) };
    }

    return { ok: true, status: response.status, payload: payload || {}, message: '' };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      message: error?.message || String(error),
    };
  }
}

function listStatusOptionNames(propertySchema) {
  if (!propertySchema || typeof propertySchema !== 'object') return [];
  const type = String(propertySchema.type || '').trim();
  if (type === 'status') {
    return (propertySchema.status?.options || [])
      .map((entry) => String(entry?.name || '').trim())
      .filter(Boolean);
  }
  if (type === 'select') {
    return (propertySchema.select?.options || [])
      .map((entry) => String(entry?.name || '').trim())
      .filter(Boolean);
  }
  return [];
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveGitBaseBranch(config) {
  try {
    await runGit(process.cwd(), ['rev-parse', '--verify', `refs/heads/${config.gitBaseBranch}`]);
    return { ok: true, message: `Local branch '${config.gitBaseBranch}' exists` };
  } catch {
    // try remote
  }

  try {
    await runGit(process.cwd(), [
      'rev-parse',
      '--verify',
      `refs/remotes/origin/${config.gitBaseBranch}`,
    ]);
    return { ok: true, message: `Remote branch 'origin/${config.gitBaseBranch}' exists` };
  } catch {
    return {
      ok: false,
      message: `Base branch '${config.gitBaseBranch}' not found locally or on origin`,
    };
  }
}

async function resolveCursorAgentBinary() {
  const which = spawnSync('command', ['-v', 'cursor-agent'], { encoding: 'utf8' });
  if (which.status === 0) {
    return { ok: true, message: 'cursor-agent found on PATH' };
  }

  const localBin = path.join(process.env.HOME || '', '.local', 'bin', 'cursor-agent');
  if (await fileExists(localBin)) {
    return { ok: true, message: `cursor-agent found at ${localBin}` };
  }

  return {
    ok: false,
    message: 'cursor-agent not found (optional unless using auto-dispatch or MCP handoff)',
  };
}

async function validateExtendedRequirements(config) {
  const items = [];

  const rulesAbsolutePath = path.isAbsolute(config.rulesFile)
    ? config.rulesFile
    : path.resolve(process.cwd(), config.rulesFile);
  const rulesExists = await fileExists(rulesAbsolutePath);
  items.push({
    key: 'AGENT_RULES_FILE',
    ok: rulesExists,
    required: false,
    message: rulesExists
      ? `Found ${rulesAbsolutePath}`
      : `Missing ${rulesAbsolutePath} (intake uses built-in defaults; copy from toolkit scripts/notion-ticket-agent-rules.md)`,
  });

  if (!config.triggerStatus) {
    items.push({
      key: 'NOTION_TRIGGER_STATUS',
      ok: false,
      required: true,
      message: 'Missing trigger status value',
    });
  }

  if (config.assigneeIds.length === 0) {
    items.push({
      key: 'NOTION_ASSIGNEE_IDS',
      ok: false,
      required: false,
      message: 'Not set — bridge will match any assignee when status matches',
    });
  }

  const gitBase = await resolveGitBaseBranch(config);
  items.push({
    key: 'GIT_BASE_BRANCH',
    ok: gitBase.ok,
    required: false,
    message: gitBase.message,
  });

  const cursorAgent = await resolveCursorAgentBinary();
  items.push({
    key: 'CURSOR_AGENT',
    ok: cursorAgent.ok,
    required: false,
    message: cursorAgent.message,
  });

  if (!config.gitlabToken) {
    items.push({
      key: 'GITLAB_TOKEN',
      ok: false,
      required: false,
      message: 'Not set — notion-auto done will require token or --push-only',
    });
  } else {
    items.push({
      key: 'GITLAB_TOKEN',
      ok: true,
      required: false,
      message: 'Configured',
    });
  }

  if (config.skipLiveCheck) {
    items.push({
      key: 'NOTION_LIVE_CHECK',
      ok: true,
      required: false,
      message: 'Skipped (--skip-live-check)',
    });
    return items;
  }

  if (!config.token) {
    return items;
  }

  const meResult = await notionRequestSafe(config, '/users/me');
  if (!meResult.ok) {
    items.push({
      key: 'NOTION_API_AUTH',
      ok: false,
      required: true,
      message: `Token rejected: ${meResult.message}`,
    });
    return items;
  }

  const botName =
    meResult.payload?.name ||
    meResult.payload?.bot?.owner?.user?.name ||
    'integration';
  items.push({
    key: 'NOTION_API_AUTH',
    ok: true,
    required: true,
    message: `Authenticated as ${botName}`,
  });

  if (!config.databaseId && !config.dataSourceId) {
    return items;
  }

  let schemaProperties = null;
  let databaseTitle = '';
  let schemaFromDatabase = false;

  if (config.dataSourceId) {
    const queryResult = await notionRequestSafe(config, `/data_sources/${config.dataSourceId}/query`, {
      method: 'POST',
      body: { page_size: 1 },
    });

    if (!queryResult.ok) {
      const needsApiVersion =
        normalize(queryResult.message).includes('notion-version') ||
        normalize(queryResult.message).includes('invalid request url');
      items.push({
        key: 'NOTION_DATA_SOURCE_ACCESS',
        ok: false,
        required: true,
        message: needsApiVersion
          ? `${queryResult.message} — set NOTION_API_VERSION="2025-09-03"`
          : queryResult.message,
      });
      return items;
    }

    items.push({
      key: 'NOTION_DATA_SOURCE_ACCESS',
      ok: true,
      required: true,
      message: `Data source ${config.dataSourceId} query succeeded`,
    });

    const samplePage = Array.isArray(queryResult.payload?.results)
      ? queryResult.payload.results.find((entry) => String(entry?.object || '') === 'page')
      : null;
    if (samplePage?.properties) {
      schemaProperties = samplePage.properties;
    }
  } else {
    const dbResult = await notionRequestSafe(
      config,
      `/databases/${encodeURIComponent(config.databaseId)}`,
    );

    if (!dbResult.ok) {
      const multiSource = normalize(dbResult.message).includes('multiple data sources');
      items.push({
        key: 'NOTION_DATABASE_ACCESS',
        ok: false,
        required: true,
        message: multiSource
          ? `${dbResult.message} — set NOTION_DATA_SOURCE_ID and NOTION_API_VERSION="2025-09-03"`
          : dbResult.message,
      });
      return items;
    }

    databaseTitle = plainTextFromRichText(dbResult.payload?.title) || config.databaseId;
    schemaProperties = dbResult.payload?.properties || null;
    schemaFromDatabase = true;
    items.push({
      key: 'NOTION_DATABASE_ACCESS',
      ok: true,
      required: true,
      message: `Database accessible${databaseTitle ? `: ${databaseTitle}` : ''}`,
    });
  }

  if (!schemaProperties || typeof schemaProperties !== 'object') {
    items.push({
      key: 'NOTION_SCHEMA',
      ok: false,
      required: false,
      message: 'Could not read database property schema (query a sample page or check permissions)',
    });
    return items;
  }

  const propertyNames = Object.keys(schemaProperties);
  const statusSchema = schemaProperties[config.statusPropertyName];
  if (!statusSchema) {
    items.push({
      key: 'NOTION_STATUS_PROPERTY',
      ok: false,
      required: true,
      message: `Property '${config.statusPropertyName}' not found. Available: ${propertyNames.slice(0, 8).join(', ')}${propertyNames.length > 8 ? '...' : ''}`,
    });
  } else {
    const statusType = String(statusSchema.type || '').trim();
    const typeOk = statusType === 'status' || statusType === 'select';
    items.push({
      key: 'NOTION_STATUS_PROPERTY',
      ok: typeOk,
      required: true,
      message: typeOk
        ? `'${config.statusPropertyName}' (${statusType})`
        : `'${config.statusPropertyName}' has unsupported type '${statusType}' (expected status or select)`,
    });

    if (typeOk && config.triggerStatus) {
      if (schemaFromDatabase) {
        const options = listStatusOptionNames(statusSchema);
        const exactMatch = options.includes(config.triggerStatus);
        const caseInsensitiveMatch = options.some(
          (option) => normalize(option) === normalize(config.triggerStatus),
        );
        items.push({
          key: 'NOTION_TRIGGER_STATUS',
          ok: exactMatch,
          required: true,
          message: exactMatch
            ? `Option '${config.triggerStatus}' exists`
            : caseInsensitiveMatch
              ? `'${config.triggerStatus}' not found — similar option exists with different casing (${options.filter((o) => normalize(o) === normalize(config.triggerStatus)).join(', ')})`
              : options.length > 0
                ? `'${config.triggerStatus}' not in options. Examples: ${options.slice(0, 6).join(', ')}`
                : `Could not list options for '${config.statusPropertyName}'`,
        });
      } else {
        items.push({
          key: 'NOTION_TRIGGER_STATUS',
          ok: true,
          required: false,
          message: `Set to '${config.triggerStatus}' (option list not verified for data-source mode)`,
        });
      }
    }
  }

  const assigneeSchema = schemaProperties[config.assigneePropertyName];
  if (!assigneeSchema) {
    items.push({
      key: 'NOTION_ASSIGNEE_PROPERTY',
      ok: false,
      required: true,
      message: `Property '${config.assigneePropertyName}' not found. Available: ${propertyNames.slice(0, 8).join(', ')}${propertyNames.length > 8 ? '...' : ''}`,
    });
  } else {
    const assigneeType = String(assigneeSchema.type || '').trim();
    items.push({
      key: 'NOTION_ASSIGNEE_PROPERTY',
      ok: assigneeType === 'people',
      required: true,
      message:
        assigneeType === 'people'
          ? `'${config.assigneePropertyName}' (people)`
          : `'${config.assigneePropertyName}' has type '${assigneeType}' (expected people)`,
    });
  }

  if (config.assigneeIds.length > 0) {
    const usersResult = await notionRequestSafe(config, '/users');
    if (usersResult.ok && Array.isArray(usersResult.payload?.results)) {
      const knownIds = new Set(
        usersResult.payload.results.map((user) => String(user?.id || '').trim()).filter(Boolean),
      );
      const unknown = config.assigneeIds.filter((id) => !knownIds.has(id));
      items.push({
        key: 'NOTION_ASSIGNEE_IDS',
        ok: unknown.length === 0,
        required: false,
        message:
          unknown.length === 0
            ? `${config.assigneeIds.length} assignee id(s) recognized by workspace`
            : `Unknown assignee id(s): ${unknown.join(', ')}`,
      });
    } else {
      items.push({
        key: 'NOTION_ASSIGNEE_IDS',
        ok: true,
        required: false,
        message: `${config.assigneeIds.length} assignee id(s) configured (workspace user list not verified)`,
      });
    }
  }

  return items;
}

function plainTextFromRichText(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list
    .map((entry) => String(entry?.plain_text || '').trim())
    .filter(Boolean)
    .join('');
}

function printRequirementsReport(items, title = 'Requirements check') {
  print('');
  print(`${title}:`, colors.cyan);
  for (const item of items) {
    const ok = item.ok;
    const required = item.required;
    const marker = ok ? 'OK' : required ? 'FAIL' : 'WARN';
    const color = ok ? colors.green : required ? colors.red : colors.yellow;
    print(`- [${marker}] ${item.key}: ${item.message}`, color);
  }
  print('');
}

async function ensureRuntimeDir(runtimeFilePath) {
  const dir = path.dirname(runtimeFilePath);
  await fs.mkdir(dir, { recursive: true });
}

async function writeRuntimeFile(runtimeFilePath, payload) {
  await ensureRuntimeDir(runtimeFilePath);
  await fs.writeFile(runtimeFilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function readJsonFileSafe(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function isPidAlive(pid) {
  const numericPid = Number(pid || 0);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function prefixChildOutput(child, prefix, color = colors.dim) {
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      const lines = String(chunk || '')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      for (const line of lines) {
        print(`[${prefix}] ${line}`, color);
      }
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      const lines = String(chunk || '')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      for (const line of lines) {
        print(`[${prefix}] ${line}`, colors.red);
      }
    });
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBridgeReadyTimeoutMs() {
  const fromMs = Number.parseInt(String(process.env.NOTION_BRIDGE_READY_TIMEOUT_MS || '').trim(), 10);
  if (Number.isFinite(fromMs) && fromMs > 0) return fromMs;
  const fromSeconds = Number.parseInt(
    String(process.env.NOTION_BRIDGE_READY_TIMEOUT_SECONDS || '').trim(),
    10,
  );
  if (Number.isFinite(fromSeconds) && fromSeconds > 0) return fromSeconds * 1000;
  return DEFAULT_BRIDGE_READY_TIMEOUT_MS;
}

function isBridgeStateReady(state, expectedPid) {
  const statePid = Number(state?.pid || 0);
  if (!state?.running || statePid !== Number(expectedPid || 0)) return false;
  // Older bridges only wrote `running`. New bridges also set baselineReady after
  // the full-database snapshot; wait for that when the field is present.
  if (Object.prototype.hasOwnProperty.call(state, 'baselineReady')) {
    return Boolean(state.baselineReady);
  }
  return true;
}

async function waitForBridgeReady(config, expectedPid) {
  const timeoutMs = resolveBridgeReadyTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  print(
    `Waiting for bridge baseline (timeout ${Math.round(timeoutMs / 1000)}s; large ticket databases can take a minute)...`,
    colors.dim,
  );
  while (Date.now() < deadline) {
    if (!isPidAlive(expectedPid)) {
      const state = await readJsonFileSafe(config.stateFile, null);
      const lastError = String(state?.lastError || '').trim();
      fail(
        `Bridge process exited before becoming ready (pid=${expectedPid}, state file: ${config.stateFile}).` +
          (lastError ? ` Last error: ${lastError}` : ''),
      );
    }
    const state = await readJsonFileSafe(config.stateFile, null);
    if (isBridgeStateReady(state, expectedPid)) {
      return state;
    }
    await sleep(500);
  }

  const state = await readJsonFileSafe(config.stateFile, null);
  const lastError = String(state?.lastError || '').trim();
  const hint = lastError
    ? ` Last error: ${lastError}`
    : ' The first-run baseline query paginates the whole ticket database before polling starts.';
  fail(`Bridge did not report ready state in time (state file: ${config.stateFile}).${hint}`);
}

async function startAutomation(config) {
  const existingRuntime = await readJsonFileSafe(config.runtimeFile, {});
  const existingPid = Number(existingRuntime?.bridge?.pid || 0);
  if (isPidAlive(existingPid)) {
    print(`Reusing existing bridge process pid=${existingPid}`, colors.green);
    print('No new process started. Exiting launcher.', colors.dim);
    return;
  }

  const bridgeScriptPath = path.resolve(TOOLKIT_ROOT, 'scripts/notion-polling-bridge.js');
  const bridgeArgs = [bridgeScriptPath];
  if (config.envFile) bridgeArgs.push('--env-file', config.envFile);
  bridgeArgs.push('--database-id', config.databaseId);

  const state = {
    stopping: false,
    bridgeChild: null,
  };

  const stopAll = async (exitCode = 0) => {
    if (state.stopping) return;
    state.stopping = true;
    if (state.bridgeChild && !state.bridgeChild.killed) {
      state.bridgeChild.kill('SIGTERM');
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    print('Received SIGINT, stopping automation...', colors.yellow);
    stopAll(0);
  });
  process.on('SIGTERM', () => {
    print('Received SIGTERM, stopping automation...', colors.yellow);
    stopAll(0);
  });

  print('Starting Notion polling bridge process...', colors.cyan);
  state.bridgeChild = spawn('node', bridgeArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefixChildOutput(state.bridgeChild, 'bridge', colors.dim);

  state.bridgeChild.on('exit', (code, signal) => {
    if (state.stopping) return;
    const status =
      signal ? `signal ${signal}` : `exit code ${code === null ? 'unknown' : String(code)}`;
    print(`Bridge process ended unexpectedly (${status}).`, colors.red);
    stopAll(1);
  });

  try {
    await waitForBridgeReady(config, state.bridgeChild.pid);
  } catch (error) {
    state.stopping = true;
    if (state.bridgeChild && !state.bridgeChild.killed) {
      state.bridgeChild.kill('SIGTERM');
    }
    throw error;
  }

  await writeRuntimeFile(config.runtimeFile, {
    startedAt: new Date().toISOString(),
    bridge: {
      pid: state.bridgeChild.pid || null,
      script: bridgeScriptPath,
      stateFile: config.stateFile,
      databaseId: config.databaseId,
    },
  });

  print('');
  print('Automation is ready.', colors.green);
  print(`Bridge PID: ${state.bridgeChild.pid || '(unknown)'}`, colors.green);
  print(`Bridge state file: ${config.stateFile}`, colors.dim);
  print(`Runtime info file: ${config.runtimeFile}`, colors.dim);
  print('');
  print(
    'Keep this command running. Stop with Ctrl+C or run `notion-auto stop --workspace <path>`.',
    colors.dim,
  );

  return new Promise(() => {});
}

function printUsage() {
  print('');
  print('notion automation launcher', colors.cyan);
  print('');
  print('Usage:');
  print('  node scripts/notion-automation-start.js');
  print('  node scripts/notion-automation-start.js --check');
  print('');
  print('Options:');
  print('  --workspace <path>');
  print('  --env-file <path>');
  print('  --check');
  print('  --skip-live-check (skip Notion API connectivity and schema validation)');
  print('  --runtime-file <path>');
  print('  --state-file <path>');
  print('  --require-local-ignores true|false (default true)');
  print('');
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help || args.h || args._[0] === 'help') {
    printUsage();
    return 0;
  }

  const loadedEnv = await loadNotionEnvValues(args);
  const envFile = resolveEnvFileCandidate(getOptionalArg(args, 'env-file')) || loadedEnv.source || '';
  const config = buildRuntimeConfig(args, loadedEnv.values, envFile);
  config.localIgnoreCheck = await evaluateLocalIgnoreCoverage(process.cwd());

  print(`notion token: ${maskSecret(config.token)} (masked)`, colors.dim);
  print(`workspace: ${process.cwd()}`, colors.dim);
  if (loadedEnv.source) {
    print(`notion env source: ${loadedEnv.source}`, colors.dim);
  }
  print(`api: ${config.apiUrl} (version ${config.apiVersion})`, colors.dim);
  print(`database: ${config.databaseId || '(unset)'}`, colors.dim);

  const requirements = validateRequirements(config);
  printRequirementsReport(requirements);

  const hardFailures = requirements.filter((item) => item.required && !item.ok);
  if (hardFailures.length > 0) {
    fail('Missing required automation configuration. Fix FAIL items and retry.');
  }

  if (config.checkOnly) {
    const extended = await validateExtendedRequirements(config);
    printRequirementsReport(extended, 'Extended check');

    const extendedFailures = extended.filter((item) => item.required && !item.ok);
    if (extendedFailures.length > 0) {
      fail('Extended check failed. Fix FAIL items and retry.');
    }

    print('Check mode complete.', colors.green);
    return 0;
  }

  await startAutomation(config);
  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
