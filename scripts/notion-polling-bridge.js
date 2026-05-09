#!/usr/bin/env node
/**
 * Notion polling bridge for local Cursor workflows.
 *
 * Purpose:
 * - Poll a Notion database for recently edited pages.
 * - Filter by status/assignee/routing key.
 * - Trigger a local command when a page matches.
 */

import process from 'process';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
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

const DEFAULT_API_URL = 'https://api.notion.com/v1';
const DEFAULT_API_VERSION = '2022-06-28';
const DEFAULT_TRIGGER_STATUS = 'AI work in progress';
const DEFAULT_STATUS_PROPERTY = 'Status';
const DEFAULT_LOCAL_ENV_FILES = ['.notion.local', '.env.local', 'scripts/.notion.local'];
const DEFAULT_POLL_INTERVAL_SECONDS = 15;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_DEDUPE_SECONDS = 120;
const DEFAULT_SINGLE_TICKET_MODE = true;
const DEFAULT_STATE_FILE = '.notion/bridge-state.json';
const DEFAULT_INITIAL_LOOKBACK_SECONDS = 0;
const DEFAULT_AGENT_OUTPUT_DIR = '.notion/intake';
const DEFAULT_CLEANUP_ON_STATUS = true;
const DEFAULT_CLEANUP_STATUS = 'Pushed to dev';
const DEFAULT_WORKTREE_MODE = false;
const DEFAULT_WORKTREE_MAP_FILE = '.notion/worktree-map.json';
const DEFAULT_ACTIVE_TICKETS_FILE = '.notion/active-tickets.md';
const DEFAULT_WORKTREE_AUTO_REMOVE_ON_CLEANUP = true;
const DEFAULT_HANDOFF_ALIAS_MAP_FILE = '.notion/handoff-alias-map.json';
const DEFAULT_ACTIVE_HANDOFFS_FILE = '.notion/active-handoffs.md';
const DEFAULT_ON_MATCH_COMMAND = `node "${path.resolve(
  TOOLKIT_ROOT,
  'scripts/notion-agent-intake.js',
)}" --page-id "$NOTION_TRIGGER_PAGE_ID" --dispatch`;

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const dedupeMap = new Map();
const cleanupSeenEvents = new Set();
let dispatchChain = Promise.resolve();
let dispatchQueueDepth = 0;
let dispatchInFlight = false;
let dispatchActivePageId = '';
let dispatchStartedAt = '';
let stopping = false;

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

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = normalize(value);
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolvePathFromWorkspace(workspacePath, rawPath, fallbackValue = '') {
  const value = String(rawPath || fallbackValue || '').trim();
  if (!value) return '';
  if (path.isAbsolute(value)) return value;
  return path.resolve(workspacePath, value);
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
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
    'NOTION_TRIGGER_STATUS',
    'NOTION_STATUS_PROPERTY',
    'NOTION_ASSIGNEE_PROPERTY',
    'NOTION_ASSIGNEE_IDS',
    'NOTION_ROUTING_KEY_PROPERTY',
    'NOTION_ROUTING_KEY',
    'NOTION_ON_MATCH_COMMAND',
    'NOTION_POLL_INTERVAL_SECONDS',
    'NOTION_BRIDGE_PAGE_SIZE',
    'NOTION_DEDUPE_SECONDS',
    'NOTION_SINGLE_TICKET_MODE',
    'NOTION_BRIDGE_DRY_RUN',
    'NOTION_BRIDGE_STATE_FILE',
    'NOTION_BRIDGE_INITIAL_LOOKBACK_SECONDS',
    'NOTION_AGENT_OUTPUT_DIR',
    'NOTION_CLEANUP_ON_STATUS',
    'NOTION_CLEANUP_STATUS',
    'NOTION_AGENT_WORKTREE_MODE',
    'NOTION_AGENT_WORKTREE_MAP_FILE',
    'NOTION_AGENT_ACTIVE_TICKETS_FILE',
    'NOTION_AGENT_WORKTREE_AUTO_REMOVE_ON_CLEANUP',
    'NOTION_AGENT_HANDOFF_ALIAS_MAP_FILE',
    'NOTION_AGENT_ACTIVE_HANDOFFS_FILE',
    'NOTION_ENV_FILE',
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
    candidates,
  };
}

function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}...${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function buildRuntimeConfig(args, envValues) {
  const rootWorkspace = process.cwd();
  const token = String(process.env.NOTION_API_TOKEN || envValues.NOTION_API_TOKEN || '').trim();
  if (!token) {
    fail(
      'NOTION_API_TOKEN is required. Set it in shell or in an ignored local env file ' +
        '(.notion.local, .env.local, scripts/.notion.local, or --env-file).',
    );
  }

  const databaseId = String(
    process.env.NOTION_DATABASE_ID ||
      envValues.NOTION_DATABASE_ID ||
      getOptionalArg(args, 'database-id'),
  ).trim();
  if (!databaseId) {
    fail('NOTION_DATABASE_ID is required.');
  }
  const dataSourceId = String(
    process.env.NOTION_DATA_SOURCE_ID ||
      envValues.NOTION_DATA_SOURCE_ID ||
      getOptionalArg(args, 'data-source-id'),
  ).trim();

  const stateFileRaw = getOptionalArg(
    args,
    'state-file',
    process.env.NOTION_BRIDGE_STATE_FILE || envValues.NOTION_BRIDGE_STATE_FILE || DEFAULT_STATE_FILE,
  );
  const stateFile = path.isAbsolute(stateFileRaw)
    ? stateFileRaw
    : path.resolve(process.cwd(), stateFileRaw);

  const triggerStatus = String(
    process.env.NOTION_TRIGGER_STATUS ||
      envValues.NOTION_TRIGGER_STATUS ||
      getOptionalArg(args, 'trigger-status', DEFAULT_TRIGGER_STATUS),
  ).trim();
  if (!triggerStatus) {
    fail('NOTION_TRIGGER_STATUS must not be empty.');
  }
  const outputDirRaw = getOptionalArg(
    args,
    'output-dir',
    process.env.NOTION_AGENT_OUTPUT_DIR || envValues.NOTION_AGENT_OUTPUT_DIR || DEFAULT_AGENT_OUTPUT_DIR,
  );
  const outputDir = resolvePathFromWorkspace(rootWorkspace, outputDirRaw, DEFAULT_AGENT_OUTPUT_DIR);
  const worktreeMapFile = resolvePathFromWorkspace(
    rootWorkspace,
    getOptionalArg(
      args,
      'worktree-map-file',
      process.env.NOTION_AGENT_WORKTREE_MAP_FILE ||
        envValues.NOTION_AGENT_WORKTREE_MAP_FILE ||
        DEFAULT_WORKTREE_MAP_FILE,
    ),
    DEFAULT_WORKTREE_MAP_FILE,
  );
  const activeTicketsFile = resolvePathFromWorkspace(
    rootWorkspace,
    getOptionalArg(
      args,
      'active-tickets-file',
      process.env.NOTION_AGENT_ACTIVE_TICKETS_FILE ||
        envValues.NOTION_AGENT_ACTIVE_TICKETS_FILE ||
        DEFAULT_ACTIVE_TICKETS_FILE,
    ),
    DEFAULT_ACTIVE_TICKETS_FILE,
  );
  const handoffAliasMapFile = resolvePathFromWorkspace(
    rootWorkspace,
    getOptionalArg(
      args,
      'handoff-alias-map-file',
      process.env.NOTION_AGENT_HANDOFF_ALIAS_MAP_FILE ||
        envValues.NOTION_AGENT_HANDOFF_ALIAS_MAP_FILE ||
        DEFAULT_HANDOFF_ALIAS_MAP_FILE,
    ),
    DEFAULT_HANDOFF_ALIAS_MAP_FILE,
  );
  const activeHandoffsFile = resolvePathFromWorkspace(
    rootWorkspace,
    getOptionalArg(
      args,
      'active-handoffs-file',
      process.env.NOTION_AGENT_ACTIVE_HANDOFFS_FILE ||
        envValues.NOTION_AGENT_ACTIVE_HANDOFFS_FILE ||
        DEFAULT_ACTIVE_HANDOFFS_FILE,
    ),
    DEFAULT_ACTIVE_HANDOFFS_FILE,
  );

  return {
    rootWorkspace,
    token,
    apiUrl: String(process.env.NOTION_API_URL || envValues.NOTION_API_URL || DEFAULT_API_URL).replace(/\/$/, ''),
    apiVersion: String(
      process.env.NOTION_API_VERSION || envValues.NOTION_API_VERSION || DEFAULT_API_VERSION,
    ).trim(),
    databaseId,
    dataSourceId,
    triggerStatus,
    statusPropertyName: String(
      process.env.NOTION_STATUS_PROPERTY ||
        envValues.NOTION_STATUS_PROPERTY ||
        getOptionalArg(args, 'status-property', DEFAULT_STATUS_PROPERTY),
    ).trim(),
    assigneePropertyName: String(
      process.env.NOTION_ASSIGNEE_PROPERTY ||
        envValues.NOTION_ASSIGNEE_PROPERTY ||
        getOptionalArg(args, 'assignee-property'),
    ).trim(),
    assigneeIds: new Set(
      parseList(
        process.env.NOTION_ASSIGNEE_IDS ||
          envValues.NOTION_ASSIGNEE_IDS ||
          getOptionalArg(args, 'assignee-ids'),
      ),
    ),
    routingKeyPropertyName: String(
      process.env.NOTION_ROUTING_KEY_PROPERTY ||
        envValues.NOTION_ROUTING_KEY_PROPERTY ||
        getOptionalArg(args, 'routing-key-property'),
    ).trim(),
    routingKey: String(
      process.env.NOTION_ROUTING_KEY ||
        envValues.NOTION_ROUTING_KEY ||
        getOptionalArg(args, 'routing-key'),
    ).trim(),
    onMatchCommand: String(
      process.env.NOTION_ON_MATCH_COMMAND ||
        envValues.NOTION_ON_MATCH_COMMAND ||
        getOptionalArg(args, 'on-match-command', DEFAULT_ON_MATCH_COMMAND),
    ).trim(),
    pollIntervalMs:
      Math.max(
        3,
        parseInteger(
          getOptionalArg(
            args,
            'poll-interval-seconds',
            process.env.NOTION_POLL_INTERVAL_SECONDS ||
              envValues.NOTION_POLL_INTERVAL_SECONDS ||
              String(DEFAULT_POLL_INTERVAL_SECONDS),
          ),
          DEFAULT_POLL_INTERVAL_SECONDS,
        ),
      ) * 1000,
    pageSize: Math.min(
      100,
      Math.max(
        1,
        parseInteger(
          getOptionalArg(
            args,
            'page-size',
            process.env.NOTION_BRIDGE_PAGE_SIZE ||
              envValues.NOTION_BRIDGE_PAGE_SIZE ||
              String(DEFAULT_PAGE_SIZE),
          ),
          DEFAULT_PAGE_SIZE,
        ),
      ),
    ),
    dedupeWindowMs:
      Math.max(
        0,
        parseInteger(
          getOptionalArg(
            args,
            'dedupe-seconds',
            process.env.NOTION_DEDUPE_SECONDS ||
              envValues.NOTION_DEDUPE_SECONDS ||
              String(DEFAULT_DEDUPE_SECONDS),
          ),
          DEFAULT_DEDUPE_SECONDS,
        ),
      ) * 1000,
    singleTicketMode: parseBoolean(
      getOptionalArg(
        args,
        'single-ticket-mode',
        process.env.NOTION_SINGLE_TICKET_MODE ||
          envValues.NOTION_SINGLE_TICKET_MODE ||
          String(DEFAULT_SINGLE_TICKET_MODE),
      ),
      DEFAULT_SINGLE_TICKET_MODE,
    ),
    initialLookbackSeconds: Math.max(
      0,
      parseInteger(
        getOptionalArg(
          args,
          'initial-lookback-seconds',
          process.env.NOTION_BRIDGE_INITIAL_LOOKBACK_SECONDS ||
            envValues.NOTION_BRIDGE_INITIAL_LOOKBACK_SECONDS ||
            String(DEFAULT_INITIAL_LOOKBACK_SECONDS),
        ),
        DEFAULT_INITIAL_LOOKBACK_SECONDS,
      ),
    ),
    stateFile,
    dryRun: parseBoolean(
      getOptionalArg(
        args,
        'dry-run',
        process.env.NOTION_BRIDGE_DRY_RUN || envValues.NOTION_BRIDGE_DRY_RUN || 'false',
      ),
      false,
    ),
    outputDir,
    cleanupOnStatus: parseBoolean(
      getOptionalArg(
        args,
        'cleanup-on-status',
        process.env.NOTION_CLEANUP_ON_STATUS ||
          envValues.NOTION_CLEANUP_ON_STATUS ||
          String(DEFAULT_CLEANUP_ON_STATUS),
      ),
      DEFAULT_CLEANUP_ON_STATUS,
    ),
    cleanupStatus: String(
      getOptionalArg(
        args,
        'cleanup-status',
        process.env.NOTION_CLEANUP_STATUS || envValues.NOTION_CLEANUP_STATUS || DEFAULT_CLEANUP_STATUS,
      ),
    ).trim(),
    worktreeMode: parseBoolean(
      getOptionalArg(
        args,
        'worktree-mode',
        process.env.NOTION_AGENT_WORKTREE_MODE ||
          envValues.NOTION_AGENT_WORKTREE_MODE ||
          String(DEFAULT_WORKTREE_MODE),
      ),
      DEFAULT_WORKTREE_MODE,
    ),
    worktreeMapFile,
    activeTicketsFile,
    handoffAliasMapFile,
    activeHandoffsFile,
    worktreeAutoRemoveOnCleanup: parseBoolean(
      getOptionalArg(
        args,
        'worktree-auto-remove-on-cleanup',
        process.env.NOTION_AGENT_WORKTREE_AUTO_REMOVE_ON_CLEANUP ||
          envValues.NOTION_AGENT_WORKTREE_AUTO_REMOVE_ON_CLEANUP ||
          String(DEFAULT_WORKTREE_AUTO_REMOVE_ON_CLEANUP),
      ),
      DEFAULT_WORKTREE_AUTO_REMOVE_ON_CLEANUP,
    ),
  };
}

function normalizeTextList(values) {
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) continue;
    out.push(text);
  }
  return out;
}

function plainTextFromRichText(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return normalizeTextList(list.map((entry) => String(entry?.plain_text || '').trim())).join('');
}

function propertyValueToText(property) {
  if (!property || typeof property !== 'object') return '';
  const type = String(property.type || '').trim();

  if (type === 'status') return String(property.status?.name || '').trim();
  if (type === 'select') return String(property.select?.name || '').trim();
  if (type === 'multi_select') {
    return normalizeTextList((property.multi_select || []).map((entry) => entry?.name)).join(', ');
  }
  if (type === 'rich_text') return plainTextFromRichText(property.rich_text);
  if (type === 'title') return plainTextFromRichText(property.title);
  if (type === 'people') {
    return normalizeTextList((property.people || []).map((person) => person?.name || person?.id)).join(', ');
  }
  if (type === 'email') return String(property.email || '').trim();
  if (type === 'phone_number') return String(property.phone_number || '').trim();
  if (type === 'url') return String(property.url || '').trim();
  if (type === 'number') return property.number === null || property.number === undefined ? '' : String(property.number);
  if (type === 'checkbox') return property.checkbox ? 'true' : 'false';
  if (type === 'date') return String(property.date?.start || '').trim();
  if (type === 'formula') {
    const formula = property.formula || {};
    if (formula.type === 'string') return String(formula.string || '').trim();
    if (formula.type === 'number') return formula.number === null || formula.number === undefined ? '' : String(formula.number);
    if (formula.type === 'boolean') return formula.boolean ? 'true' : 'false';
    if (formula.type === 'date') return String(formula.date?.start || '').trim();
    return '';
  }
  return '';
}

function findPropertyByName(page, propertyName) {
  const properties = page?.properties && typeof page.properties === 'object' ? page.properties : {};
  if (propertyName && properties[propertyName]) return properties[propertyName];
  return null;
}

function findPropertyByType(page, propertyType) {
  const properties = page?.properties && typeof page.properties === 'object' ? page.properties : {};
  for (const property of Object.values(properties)) {
    if (String(property?.type || '').trim() === propertyType) return property;
  }
  return null;
}

function resolvePageTitle(page) {
  const titleProperty = findPropertyByType(page, 'title');
  const text = propertyValueToText(titleProperty);
  return text || String(page?.id || '').trim();
}

function resolveStatusText(page, statusPropertyName) {
  const explicit = findPropertyByName(page, statusPropertyName);
  const explicitText = propertyValueToText(explicit);
  if (explicitText) return explicitText;

  const statusLike = findPropertyByType(page, 'status') || findPropertyByType(page, 'select');
  return propertyValueToText(statusLike);
}

function resolveAssigneeIds(page, assigneePropertyName) {
  const explicit = findPropertyByName(page, assigneePropertyName);
  const source = explicit || findPropertyByType(page, 'people');
  if (!source || String(source.type || '').trim() !== 'people') return [];
  return normalizeTextList((source.people || []).map((person) => String(person?.id || '').trim()));
}

function evaluateFilters({ config, page }) {
  const pageId = String(page?.id || '').trim();
  if (!pageId) return { matched: false, reason: 'Page id is missing from query result.' };

  const status = resolveStatusText(page, config.statusPropertyName);
  if (!status) {
    return {
      matched: false,
      reason: `Could not resolve status from '${config.statusPropertyName}'.`,
    };
  }
  if (normalize(status) !== normalize(config.triggerStatus)) {
    return {
      matched: false,
      reason: `Status '${status}' does not match trigger '${config.triggerStatus}'.`,
    };
  }

  const assigneeIds = resolveAssigneeIds(page, config.assigneePropertyName);
  if (config.assigneeIds.size > 0) {
    const matchesAssignee = assigneeIds.some((id) => config.assigneeIds.has(id));
    if (!matchesAssignee) {
      return {
        matched: false,
        reason: `Assignee mismatch. Page assignees=[${assigneeIds.join(', ')}], expected any of [${Array.from(config.assigneeIds).join(', ')}].`,
      };
    }
  }

  if (config.routingKey) {
    if (!config.routingKeyPropertyName) {
      return {
        matched: false,
        reason: 'NOTION_ROUTING_KEY is set but NOTION_ROUTING_KEY_PROPERTY is missing.',
      };
    }
    const routingProperty = findPropertyByName(page, config.routingKeyPropertyName);
    const routingValue = propertyValueToText(routingProperty);
    if (!routingValue) {
      return {
        matched: false,
        reason: `Routing key property '${config.routingKeyPropertyName}' is empty.`,
      };
    }
    if (normalize(routingValue) !== normalize(config.routingKey)) {
      return {
        matched: false,
        reason: `Routing key mismatch. Page='${routingValue}', expected='${config.routingKey}'.`,
      };
    }
  }

  return {
    matched: true,
    reason: 'Matched all configured filters.',
    metadata: {
      status,
      assigneeIds,
      title: resolvePageTitle(page),
    },
  };
}

async function notionRequest(config, endpointPath, { method = 'GET', body = null } = {}) {
  const endpoint = endpointPath.startsWith('/')
    ? `${config.apiUrl}${endpointPath}`
    : `${config.apiUrl}/${endpointPath}`;
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
    fail(`Notion API request failed: ${String(message).slice(0, 400)}`);
  }

  return payload || {};
}

function resolveQueryTarget(config) {
  const dataSourceId = String(config.dataSourceId || '').trim();
  if (dataSourceId) {
    return {
      endpoint: `/data_sources/${dataSourceId}/query`,
      id: dataSourceId,
      type: 'data_source',
    };
  }

  return {
    endpoint: `/databases/${config.databaseId}/query`,
    id: String(config.databaseId || ''),
    type: 'database',
  };
}

async function queryDatabaseSince(config, cursorIso) {
  const pages = [];
  let nextCursor = '';
  const target = resolveQueryTarget(config);

  do {
    const body = {
      page_size: config.pageSize,
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    };

    if (cursorIso) {
      body.filter = {
        timestamp: 'last_edited_time',
        last_edited_time: {
          on_or_after: cursorIso,
        },
      };
    }
    if (nextCursor) body.start_cursor = nextCursor;

    const data = await notionRequest(config, target.endpoint, {
      method: 'POST',
      body,
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    for (const entry of results) {
      if (String(entry?.object || '').trim() !== 'page') continue;
      pages.push(entry);
    }

    if (data?.has_more && data?.next_cursor) {
      nextCursor = String(data.next_cursor || '').trim();
    } else {
      nextCursor = '';
    }
  } while (nextCursor);

  pages.sort((left, right) => {
    const leftTs = Date.parse(String(left?.last_edited_time || ''));
    const rightTs = Date.parse(String(right?.last_edited_time || ''));
    return (Number.isFinite(leftTs) ? leftTs : 0) - (Number.isFinite(rightTs) ? rightTs : 0);
  });

  return pages;
}

function buildDedupeKey(pageId, editedAt, statusText) {
  return [String(pageId || ''), String(editedAt || ''), String(statusText || '')].join('|');
}

async function cleanupTicketIntakeArtifacts(config, pageId) {
  const id = String(pageId || '').trim();
  if (!id) return { removedFiles: 0, removedAssetDir: false };

  let removedFiles = 0;
  let removedAssetDir = false;
  const outputDir = path.resolve(config.outputDir);
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = String(entry.name || '');
      if (!name.startsWith(`${id}-`)) continue;
      await fs.rm(path.join(outputDir, name), { force: true });
      removedFiles += 1;
    }
  } catch {
    // ignore when output directory doesn't exist yet
  }

  const assetsDir = path.join(outputDir, 'assets', id);
  try {
    await fs.rm(assetsDir, { recursive: true, force: true });
    removedAssetDir = true;
  } catch {
    removedAssetDir = false;
  }

  return { removedFiles, removedAssetDir };
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
    child.on('exit', (code, signal) => {
      resolve({
        code: Number(code || 0),
        signal: signal || '',
        stdout,
        stderr,
      });
    });
  });
}

async function readJsonFileSafe(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

async function writeJsonFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function writeActiveTicketsIndex(config, ticketsMap) {
  const tickets = ticketsMap && typeof ticketsMap === 'object' ? ticketsMap : {};
  const rows = Object.values(tickets)
    .filter((entry) => entry && typeof entry === 'object')
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  const body = [
    '# Active Notion Tickets',
    '',
    `Updated: ${new Date().toISOString()}`,
    '',
    rows.length === 0 ? '_No active worktree tickets tracked._' : '| Ticket | Status | Branch | Worktree |',
    ...(rows.length === 0 ? [] : ['|---|---|---|---|']),
    ...rows.map((entry) => {
      const ticket = String(entry.pageId || '').trim() || '(unknown)';
      const status = String(entry.status || '').trim() || '(unknown)';
      const branch = String(entry.branch || '').trim() || '(unknown)';
      const worktree = String(entry.worktreePath || '').trim() || '(unknown)';
      return `| ${ticket} | ${status} | \`${branch}\` | \`${worktree}\` |`;
    }),
    '',
  ].join('\n');
  await fs.mkdir(path.dirname(config.activeTicketsFile), { recursive: true });
  await fs.writeFile(config.activeTicketsFile, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
}

async function cleanupTicketWorktreeTracking(config, pageId, statusText, pageTitle) {
  if (!config.worktreeMode) {
    return { tracked: false, removedEntry: false, removedWorktree: false, removeError: '' };
  }
  const id = String(pageId || '').trim();
  if (!id) return { tracked: false, removedEntry: false, removedWorktree: false, removeError: '' };

  const mapData = await readJsonFileSafe(config.worktreeMapFile, { tickets: {} });
  const tickets = mapData?.tickets && typeof mapData.tickets === 'object' ? mapData.tickets : {};
  const ticketEntry = tickets[id];
  if (!ticketEntry || typeof ticketEntry !== 'object') {
    return { tracked: false, removedEntry: false, removedWorktree: false, removeError: '' };
  }

  let removedWorktree = false;
  let removeError = '';
  const worktreePath = String(ticketEntry.worktreePath || '').trim();
  if (config.worktreeAutoRemoveOnCleanup && worktreePath) {
    try {
      const result = await runCommandCapture(
        'git',
        ['worktree', 'remove', worktreePath],
        { cwd: config.rootWorkspace, env: process.env },
      );
      if (!result.signal && result.code === 0) {
        removedWorktree = true;
      } else {
        const details = String(result.stderr || result.stdout || '').trim();
        removeError = details || `exit code ${result.code}${result.signal ? ` signal ${result.signal}` : ''}`;
      }
    } catch (error) {
      removeError = String(error?.message || error || 'unknown git worktree remove error');
    }
  }

  const canRemoveEntry = !config.worktreeAutoRemoveOnCleanup || removedWorktree || !worktreePath;
  if (canRemoveEntry) {
    delete tickets[id];
  } else {
    tickets[id] = {
      ...ticketEntry,
      status: String(statusText || '').trim() || ticketEntry.status || '',
      pageTitle: String(pageTitle || '').trim() || ticketEntry.pageTitle || '',
      cleanupPending: true,
      cleanupError: removeError,
      updatedAt: new Date().toISOString(),
    };
  }

  await writeJsonFile(config.worktreeMapFile, { ...mapData, tickets });
  await writeActiveTicketsIndex(config, tickets);
  return {
    tracked: true,
    removedEntry: canRemoveEntry,
    removedWorktree,
    removeError,
  };
}

async function writeActiveHandoffsIndex(config, aliasesMap) {
  const aliases = aliasesMap && typeof aliasesMap === 'object' ? aliasesMap : {};
  const rows = Object.entries(aliases)
    .map(([pageId, entry]) => ({
      pageId,
      aliasFile: String(entry?.aliasFile || '').trim(),
      branch: String(entry?.branch || '').trim(),
      worktreePath: String(entry?.worktreePath || '').trim(),
      updatedAt: String(entry?.updatedAt || '').trim(),
    }))
    .filter((entry) => entry.aliasFile)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  const body = [
    '# Active Notion Handoff Aliases',
    '',
    `Updated: ${new Date().toISOString()}`,
    '',
    rows.length === 0 ? '_No active handoff aliases tracked._' : '| Ticket | Alias file | Branch | Worktree |',
    ...(rows.length === 0 ? [] : ['|---|---|---|---|']),
    ...rows.map((entry) => {
      const ticket = String(entry.pageId || '').trim() || '(unknown)';
      const aliasFile = String(entry.aliasFile || '').trim() || '(unknown)';
      const branch = String(entry.branch || '').trim() || '(unknown)';
      const worktree = String(entry.worktreePath || '').trim() || '(unknown)';
      return `| ${ticket} | \`${aliasFile}\` | \`${branch}\` | \`${worktree}\` |`;
    }),
    '',
  ].join('\n');
  await fs.mkdir(path.dirname(config.activeHandoffsFile), { recursive: true });
  await fs.writeFile(config.activeHandoffsFile, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
}

async function cleanupTicketRootHandoffAlias(config, pageId) {
  const id = String(pageId || '').trim();
  if (!id) {
    return { tracked: false, removedEntry: false, removedAliasFile: false, removeError: '' };
  }
  const mapData = await readJsonFileSafe(config.handoffAliasMapFile, { aliases: {} });
  const aliases = mapData?.aliases && typeof mapData.aliases === 'object' ? mapData.aliases : {};
  const aliasEntry = aliases[id];
  if (!aliasEntry || typeof aliasEntry !== 'object') {
    return { tracked: false, removedEntry: false, removedAliasFile: false, removeError: '' };
  }

  let removedAliasFile = false;
  let removeError = '';
  const aliasPath = path.isAbsolute(String(aliasEntry.aliasPath || '').trim())
    ? String(aliasEntry.aliasPath || '').trim()
    : path.resolve(config.rootWorkspace, String(aliasEntry.aliasFile || '').trim());
  if (aliasPath) {
    try {
      await fs.rm(aliasPath, { force: true });
      removedAliasFile = true;
    } catch (error) {
      removeError = String(error?.message || error || 'unknown alias cleanup error');
    }
  }

  delete aliases[id];
  await writeJsonFile(config.handoffAliasMapFile, { ...mapData, aliases });
  await writeActiveHandoffsIndex(config, aliases);
  return {
    tracked: true,
    removedEntry: true,
    removedAliasFile,
    removeError,
  };
}

function shouldSkipAsDuplicate(key, dedupeWindowMs) {
  if (!key || dedupeWindowMs <= 0) return false;

  const now = Date.now();
  for (const [existingKey, timestamp] of dedupeMap.entries()) {
    if (now - timestamp > dedupeWindowMs) dedupeMap.delete(existingKey);
  }

  const previous = dedupeMap.get(key);
  if (previous && now - previous <= dedupeWindowMs) return true;

  dedupeMap.set(key, now);
  return false;
}

function buildBusyReason() {
  if (dispatchInFlight) {
    const pageInfo = dispatchActivePageId ? `page ${dispatchActivePageId}` : 'another page';
    const startedInfo = dispatchStartedAt ? ` (started ${dispatchStartedAt})` : '';
    return `Single-ticket mode is active; dispatch already running for ${pageInfo}${startedInfo}.`;
  }
  if (dispatchQueueDepth > 0) {
    return `Single-ticket mode is active; dispatch queue already contains ${dispatchQueueDepth} pending job(s).`;
  }
  return 'Single-ticket mode is active; another ticket is already being processed.';
}

function queueCommandExecution(config, context) {
  if (config.singleTicketMode && (dispatchInFlight || dispatchQueueDepth > 0)) {
    return {
      queued: false,
      reason: buildBusyReason(),
    };
  }

  dispatchQueueDepth += 1;
  dispatchChain = dispatchChain
    .then(async () => {
      dispatchQueueDepth = Math.max(0, dispatchQueueDepth - 1);
      dispatchInFlight = true;
      dispatchActivePageId = String(context?.page?.id || '');
      dispatchStartedAt = new Date().toISOString();
      try {
        await executeOnMatchCommand(config, context);
      } finally {
        dispatchInFlight = false;
        dispatchActivePageId = '';
        dispatchStartedAt = '';
      }
    })
    .catch((error) => {
      dispatchInFlight = false;
      dispatchActivePageId = '';
      dispatchStartedAt = '';
      print(`Dispatch error: ${error?.message || String(error)}`, colors.red);
    });

  return {
    queued: true,
    reason: 'Queued local command dispatch.',
  };
}

function executeOnMatchCommand(config, context) {
  const command = String(config.onMatchCommand || '').trim();
  if (!command) {
    print('No NOTION_ON_MATCH_COMMAND configured; skipping command dispatch.', colors.yellow);
    return Promise.resolve();
  }

  const env = {
    ...process.env,
    NOTION_TRIGGER_PAGE_ID: String(context.page.id || ''),
    NOTION_TRIGGER_PAGE_TITLE: String(context.pageTitle || ''),
    NOTION_TRIGGER_DATABASE_ID: String(config.databaseId || ''),
    NOTION_TRIGGER_DATA_SOURCE_ID: String(config.dataSourceId || ''),
    NOTION_TRIGGER_STATUS: String(context.statusText || ''),
    NOTION_TRIGGER_PAGE_EDITED_AT: String(context.editedAt || ''),
  };

  if (config.dryRun) {
    print(`[dry-run] Would run command: ${command}`, colors.yellow);
    return Promise.resolve();
  }

  print(`Running command: ${command}`, colors.cyan);

  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        print(`Command exited by signal: ${signal}`, colors.red);
      } else if (code === 0) {
        print('Command finished successfully.', colors.green);
      } else {
        print(`Command failed with exit code: ${code}`, colors.red);
      }
      resolve();
    });

    child.on('error', (error) => {
      print(`Failed to start command: ${error?.message || String(error)}`, colors.red);
      resolve();
    });
  });
}

async function writeStateFile(stateFilePath, payload) {
  await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
  await fs.writeFile(stateFilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoWithLookback(seconds) {
  const ms = Math.max(0, Number(seconds || 0)) * 1000;
  return new Date(Date.now() - ms).toISOString();
}

function isIsoAfter(left, right) {
  const leftTs = Date.parse(String(left || ''));
  const rightTs = Date.parse(String(right || ''));
  if (!Number.isFinite(leftTs) && !Number.isFinite(rightTs)) return false;
  if (!Number.isFinite(leftTs)) return false;
  if (!Number.isFinite(rightTs)) return true;
  return leftTs > rightTs;
}

function printUsage() {
  print('');
  print('Notion polling bridge', colors.cyan);
  print('');
  print('Usage:');
  print('  node scripts/notion-polling-bridge.js --database-id <id>');
  print('');
  print('Optional flags:');
  print('  --workspace <path>');
  print('  --env-file <path>');
  print('  --database-id <id>');
  print('  --data-source-id <id>');
  print('  --trigger-status "<label>"');
  print('  --status-property "<name>"');
  print('  --assignee-property "<name>"');
  print('  --assignee-ids abc,def');
  print('  --routing-key-property "<name>"');
  print('  --routing-key "<value>"');
  print('  --on-match-command "<shell command>"');
  print('  --poll-interval-seconds 15');
  print('  --page-size 100');
  print('  --dedupe-seconds 120');
  print('  --single-ticket-mode true|false');
  print('  --state-file .notion/bridge-state.json');
  print('  --initial-lookback-seconds 0');
  print('  --output-dir .notion/intake');
  print('  --cleanup-on-status true|false');
  print('  --cleanup-status "Pushed to dev"');
  print('  --worktree-mode true|false');
  print('  --worktree-map-file .notion/worktree-map.json');
  print('  --active-tickets-file .notion/active-tickets.md');
  print('  --handoff-alias-map-file .notion/handoff-alias-map.json');
  print('  --active-handoffs-file .notion/active-handoffs.md');
  print('  --worktree-auto-remove-on-cleanup true|false');
  print('  --dry-run true|false');
  print('');
}

async function runPollingLoop(config) {
  const state = await readJsonFileSafe(config.stateFile, {});
  let cursorIso = String(state?.cursor || '').trim();
  if (!cursorIso) {
    cursorIso = isoWithLookback(config.initialLookbackSeconds);
    await writeStateFile(config.stateFile, {
      startedAt: new Date().toISOString(),
      pid: process.pid,
      cursor: cursorIso,
      lastPollAt: null,
      lastError: null,
      running: true,
      databaseId: config.databaseId,
      dataSourceId: config.dataSourceId || null,
      triggerStatus: config.triggerStatus,
    });
    print(`Initialized polling cursor at ${cursorIso}`, colors.dim);
  }

  while (!stopping) {
    const pollStartedAt = new Date().toISOString();
    let nextCursorIso = cursorIso;
    let matchedCount = 0;
    let ignoredCount = 0;
    let polledCount = 0;
    let lastError = '';

    try {
      const pages = await queryDatabaseSince(config, cursorIso);
      polledCount = pages.length;

      for (const page of pages) {
        const pageId = String(page?.id || '').trim();
        const editedAt = String(page?.last_edited_time || '').trim();
        if (isIsoAfter(editedAt, nextCursorIso)) nextCursorIso = editedAt;
        const statusText = resolveStatusText(page, config.statusPropertyName);
        const pageTitle = resolvePageTitle(page);

        if (config.cleanupOnStatus && config.cleanupStatus) {
          const isCleanupStatus = normalize(statusText) === normalize(config.cleanupStatus);
          if (isCleanupStatus) {
            const cleanupKey = `cleanup|${pageId}|${editedAt}|${normalize(statusText)}`;
            if (!cleanupSeenEvents.has(cleanupKey)) {
              cleanupSeenEvents.add(cleanupKey);
              const cleanupResult = await cleanupTicketIntakeArtifacts(config, pageId);
              if (cleanupResult.removedFiles > 0 || cleanupResult.removedAssetDir) {
                print(
                  `Cleanup for page ${pageId} (${pageTitle}): removed prompt/context files=${cleanupResult.removedFiles}, assets=${cleanupResult.removedAssetDir ? 'yes' : 'no'}.`,
                  colors.dim,
                );
              }
              const worktreeCleanup = await cleanupTicketWorktreeTracking(
                config,
                pageId,
                statusText,
                pageTitle,
              );
              if (worktreeCleanup.tracked) {
                if (worktreeCleanup.removedEntry) {
                  print(`Worktree tracking removed for page ${pageId}.`, colors.dim);
                }
                if (worktreeCleanup.removedWorktree) {
                  print(`Worktree removed for page ${pageId}.`, colors.dim);
                }
                if (worktreeCleanup.removeError) {
                  print(
                    `Worktree cleanup pending for page ${pageId}: ${worktreeCleanup.removeError}`,
                    colors.yellow,
                  );
                }
              }
              const rootAliasCleanup = await cleanupTicketRootHandoffAlias(config, pageId);
              if (rootAliasCleanup.tracked) {
                if (rootAliasCleanup.removedEntry) {
                  print(`Root handoff alias tracking removed for page ${pageId}.`, colors.dim);
                }
                if (rootAliasCleanup.removedAliasFile) {
                  print(`Root handoff alias file removed for page ${pageId}.`, colors.dim);
                }
                if (rootAliasCleanup.removeError) {
                  print(
                    `Root handoff alias cleanup warning for page ${pageId}: ${rootAliasCleanup.removeError}`,
                    colors.yellow,
                  );
                }
              }
            }
          }
        }

        const filterResult = evaluateFilters({ config, page });
        if (!filterResult.matched) {
          ignoredCount += 1;
          if (pageId) {
            print(`Ignored page ${pageId}: ${filterResult.reason}`, colors.dim);
          }
          continue;
        }
        const matchedStatusText = String(filterResult.metadata?.status || statusText).trim();
        const matchedPageTitle = String(filterResult.metadata?.title || pageTitle || pageId).trim();
        const dedupeKey = buildDedupeKey(pageId, editedAt, statusText);
        if (shouldSkipAsDuplicate(dedupeKey, config.dedupeWindowMs)) {
          ignoredCount += 1;
          print(`Ignored duplicate event for page ${pageId}.`, colors.dim);
          continue;
        }

        const queueResult = queueCommandExecution(config, {
          page,
          statusText: matchedStatusText,
          pageTitle: matchedPageTitle,
          editedAt,
        });
        if (!queueResult.queued) {
          ignoredCount += 1;
          print(`Ignored page ${pageId} (${matchedPageTitle}): ${queueResult.reason}`, colors.yellow);
          continue;
        }

        matchedCount += 1;
        print(`Matched page ${pageId} (${matchedPageTitle}) -> dispatching local command.`, colors.green);
      }

      cursorIso = nextCursorIso;
      await writeStateFile(config.stateFile, {
        startedAt: String(state?.startedAt || new Date().toISOString()),
        pid: process.pid,
        cursor: cursorIso,
        lastPollAt: pollStartedAt,
        lastError: null,
        running: true,
        databaseId: config.databaseId,
        dataSourceId: config.dataSourceId || null,
        triggerStatus: config.triggerStatus,
        stats: {
          polledCount,
          matchedCount,
          ignoredCount,
        },
      });
      if (polledCount > 0 || matchedCount > 0) {
        print(
          `Poll cycle complete: polled=${polledCount} matched=${matchedCount} ignored=${ignoredCount} cursor=${cursorIso}`,
          colors.dim,
        );
      }
    } catch (error) {
      lastError = String(error?.message || error || 'Unknown polling error');
      print(`Polling error: ${lastError}`, colors.red);
      if (
        !config.dataSourceId &&
        normalize(lastError).includes('multiple data sources are not supported')
      ) {
        print(
          'Hint: set NOTION_DATA_SOURCE_ID in .notion.local (example: collection://... id without the "collection://" prefix) and set NOTION_API_VERSION="2025-09-03".',
          colors.yellow,
        );
      }
      if (
        config.dataSourceId &&
        normalize(lastError).includes('invalid request url') &&
        normalize(config.apiVersion) !== '2025-09-03'
      ) {
        print('Hint: NOTION_DATA_SOURCE_ID requires NOTION_API_VERSION="2025-09-03".', colors.yellow);
      }
      await writeStateFile(config.stateFile, {
        startedAt: String(state?.startedAt || new Date().toISOString()),
        pid: process.pid,
        cursor: cursorIso,
        lastPollAt: pollStartedAt,
        lastError,
        running: true,
        databaseId: config.databaseId,
        dataSourceId: config.dataSourceId || null,
        triggerStatus: config.triggerStatus,
      });
    }

    if (stopping) break;
    await sleep(config.pollIntervalMs);
  }

  await writeStateFile(config.stateFile, {
    startedAt: String(state?.startedAt || new Date().toISOString()),
    pid: process.pid,
    cursor: cursorIso,
    lastPollAt: new Date().toISOString(),
    lastError: null,
    running: false,
    databaseId: config.databaseId,
    dataSourceId: config.dataSourceId || null,
    triggerStatus: config.triggerStatus,
  });
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help || args.h || args._[0] === 'help') {
    printUsage();
    return 0;
  }

  const loadedEnv = await loadNotionEnvValues(args);
  const config = buildRuntimeConfig(args, loadedEnv.values);

  print(`notion token: ${maskSecret(config.token)} (masked)`, colors.dim);
  print(`workspace: ${process.cwd()}`, colors.dim);
  if (loadedEnv.source) {
    print(`notion env source: ${loadedEnv.source}`, colors.dim);
  }
  print(`api: ${config.apiUrl} (version ${config.apiVersion})`, colors.dim);
  print(`database: ${config.databaseId}`, colors.dim);
  if (config.dataSourceId) {
    print(`data source: ${config.dataSourceId}`, colors.dim);
  }
  print(`trigger status: ${config.triggerStatus} (property: ${config.statusPropertyName})`, colors.dim);
  if (config.assigneeIds.size > 0) {
    print(
      `assignee filter: [${Array.from(config.assigneeIds).join(', ')}]` +
        ` (property: ${config.assigneePropertyName || 'auto-detect people property'})`,
      colors.dim,
    );
  }
  if (config.routingKey) {
    print(
      `routing key filter: '${config.routingKey}' (property: ${config.routingKeyPropertyName || '(missing)'})`,
      colors.dim,
    );
  }
  print(`on-match command: ${config.onMatchCommand}`, colors.dim);
  print(`single-ticket mode: ${config.singleTicketMode ? 'ENABLED' : 'DISABLED'}`, colors.dim);
  print(
    `poll interval: ${Math.round(config.pollIntervalMs / 1000)}s page-size=${config.pageSize} dedupe=${Math.round(config.dedupeWindowMs / 1000)}s`,
    colors.dim,
  );
  print(
    `cleanup: ${config.cleanupOnStatus ? `enabled on status '${config.cleanupStatus || '(empty)'}'` : 'disabled'} (output dir: ${config.outputDir})`,
    colors.dim,
  );
  if (config.worktreeMode) {
    print(
      `worktree cleanup: map=${config.worktreeMapFile}, index=${config.activeTicketsFile}, auto-remove=${config.worktreeAutoRemoveOnCleanup ? 'yes' : 'no'}`,
      colors.dim,
    );
    print(
      `handoff alias cleanup: map=${config.handoffAliasMapFile}, index=${config.activeHandoffsFile}`,
      colors.dim,
    );
  }
  print(`state file: ${config.stateFile}`, colors.dim);
  print(`mode: ${config.dryRun ? 'DRY-RUN' : 'APPLY'}`, config.dryRun ? colors.yellow : colors.green);

  process.on('SIGINT', () => {
    print('Received SIGINT, stopping polling bridge...', colors.yellow);
    stopping = true;
  });
  process.on('SIGTERM', () => {
    print('Received SIGTERM, stopping polling bridge...', colors.yellow);
    stopping = true;
  });

  await runPollingLoop(config);
  print('Polling bridge stopped.', colors.green);
  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
