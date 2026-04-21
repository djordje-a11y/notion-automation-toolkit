#!/usr/bin/env node
/**
 * notion ticket -> agent intake dispatcher.
 *
 * Flow:
 * 1) Fetch page details from Notion (properties, comments, blocks).
 * 2) Build structured context JSON + prompt markdown.
 * 3) Propose deterministic branch name candidate.
 * 4) Write timestamped prompt/context plus IDE handoff files.
 * 5) Optionally run a configured agent command with prompt/context paths.
 */

import process from 'process';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

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
const DEFAULT_MAX_COMMENTS = 30;
const DEFAULT_OUTPUT_DIR = '.notion/intake';
const DEFAULT_HANDOFF_DIR = '.notion/handoffs';
const DEFAULT_HANDOFF_ALIAS_FILE = 'notion-handoff.md';
const DEFAULT_HANDOFF_RETRIGGER_LATEST_ONLY = true;
const DEFAULT_BRANCH_PREFIX = 'dev/notion';
const DEFAULT_BRANCH_PREFIX_RULES = 'bugs=fix,epics backlog=feat';
const DEFAULT_BRANCH_INCLUDE_TICKET_ID = false;
const DEFAULT_GIT_PREPARE_BRANCH = true;
const DEFAULT_GIT_BASE_BRANCH = 'acceptance';
const DEFAULT_GIT_REMOTE = 'origin';
const DEFAULT_GIT_REQUIRE_CLEAN_WORKTREE = true;
const DEFAULT_AGENT_CREATE_CHAT = true;
const DEFAULT_AGENT_CREATE_CHAT_COMMAND = '$HOME/.local/bin/cursor-agent create-chat';
const DEFAULT_AGENT_UNSET_CURSOR_API_KEY = true;
const DEFAULT_AGENT_HEADLESS_PRINT = true;
const DEFAULT_IDE_HANDOFF = true;
const DEFAULT_LOCAL_ENV_FILES = ['.notion.local', '.env.local', 'scripts/.notion.local'];
const DEFAULT_SECTION_PROPERTY = 'Type';

const DEFAULT_RULES = [
  'Ticket intake rules:',
  '- Investigate root cause first. Do not propose symptom-only workarounds.',
  '- Preserve security constraints and account isolation (no access widening fixes).',
  '- Keep scope minimal and explicit; call out behavior changes separately.',
  '- Include deterministic validation plan (targeted tests first, then confidence checks).',
  '- Output must include: ticket understanding, proposed branch name, solution approach, risks/blockers.',
  '',
  'Completion and handoff rules (mandatory when user asks to commit):',
  '- Use custom signing/author commit command only when user explicitly asks for it.',
  '- If user does not explicitly request custom signing/author, use normal commit flow (`git commit -m "<message>"`).',
  '- Write a meaningful commit message: fix|feat|chore subject + user-visible outcome + why (avoid vague messages).',
  '- Staged-first workflow: user stages reviewed files and tells agent changes are staged.',
  '- On "staged push" (or equivalent): verify staged diff is non-empty, commit staged files only, push branch, post Notion update via `notion-auto reply-latest --workspace "$PWD" --page-id "<page-id>" --body-file "<reply-file.md>"`.',
].join('\n');

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

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = normalize(value);
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeOptionalPath(value, fallback = '') {
  const raw = String(value ?? fallback ?? '').trim();
  if (!raw) return '';
  const normalized = normalize(raw);
  if (['0', 'false', 'no', 'n', 'off', 'none', 'disable', 'disabled'].includes(normalized)) {
    return '';
  }
  return raw;
}

function normalizePrefix(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function parseRuleMatcher(matchRaw) {
  const raw = String(matchRaw || '').trim();
  if (!raw) return { matchType: 'title', match: '' };

  const marker = raw.match(/^(id|group|group-id)\s*:\s*(.+)$/i);
  if (marker) {
    return {
      matchType: 'id',
      match: normalize(marker[2]),
    };
  }

  return {
    matchType: 'title',
    match: normalize(raw),
  };
}

function createBranchRule(matchRaw, prefixRaw, forcedMatchType = '') {
  const parsed = parseRuleMatcher(matchRaw);
  const prefix = normalizePrefix(prefixRaw);
  const normalizedForcedType = normalize(forcedMatchType);
  const matchType = normalizedForcedType === 'id' ? 'id' : parsed.matchType;

  if (!parsed.match || !prefix) return null;
  return {
    matchType,
    match: parsed.match,
    prefix,
  };
}

function parseBranchPrefixRules(rawValue) {
  const normalizedRaw = String(rawValue || '').trim();
  const source = normalizedRaw || DEFAULT_BRANCH_PREFIX_RULES;

  if (!source) return [];

  if (source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const rules = [];

        if (parsed.title && typeof parsed.title === 'object' && !Array.isArray(parsed.title)) {
          for (const [match, prefix] of Object.entries(parsed.title)) {
            const rule = createBranchRule(match, prefix, 'title');
            if (rule) rules.push(rule);
          }
        }

        if (parsed.id && typeof parsed.id === 'object' && !Array.isArray(parsed.id)) {
          for (const [match, prefix] of Object.entries(parsed.id)) {
            const rule = createBranchRule(match, prefix, 'id');
            if (rule) rules.push(rule);
          }
        }

        for (const [match, prefix] of Object.entries(parsed)) {
          if (match === 'title' || match === 'id') continue;
          const rule = createBranchRule(match, prefix);
          if (rule) rules.push(rule);
        }

        if (rules.length > 0) return rules;
      }
    } catch {
      // fall back to CSV parser
    }
  }

  return source
    .split(',')
    .map((pair) => String(pair || '').trim())
    .filter(Boolean)
    .map((pair) => {
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex <= 0) return null;
      return createBranchRule(pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1));
    })
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

function getRequiredArg(args, key, label) {
  const value = String(args[key] || '').trim();
  if (!value) fail(`Missing required argument: ${label}`);
  return value;
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
    'NOTION_AGENT_COMMAND',
    'NOTION_AGENT_OUTPUT_DIR',
    'NOTION_AGENT_HANDOFF_DIR',
    'NOTION_AGENT_HANDOFF_ALIAS_FILE',
    'NOTION_AGENT_HANDOFF_RETRIGGER_LATEST_ONLY',
    'NOTION_AGENT_RULES_FILE',
    'NOTION_AGENT_BRANCH_PREFIX',
    'NOTION_AGENT_BRANCH_PREFIX_RULES',
    'NOTION_AGENT_BRANCH_INCLUDE_TICKET_ID',
    'NOTION_AGENT_GIT_PREPARE_BRANCH',
    'NOTION_AGENT_GIT_BASE_BRANCH',
    'NOTION_AGENT_GIT_REMOTE',
    'NOTION_AGENT_GIT_REQUIRE_CLEAN_WORKTREE',
    'NOTION_AGENT_CREATE_CHAT',
    'NOTION_AGENT_CREATE_CHAT_COMMAND',
    'NOTION_AGENT_UNSET_CURSOR_API_KEY',
    'NOTION_AGENT_HEADLESS_PRINT',
    'NOTION_AGENT_IDE_HANDOFF',
    'NOTION_AGENT_SECTION_PROPERTY',
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
    const hasRelevantKeys = keys.some((key) => String(parsed[key] || '').trim());
    if (!source && hasRelevantKeys) source = candidate;

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
  const token = String(process.env.NOTION_API_TOKEN || envValues.NOTION_API_TOKEN || '').trim();
  if (!token) {
    fail(
      'NOTION_API_TOKEN is required. Set it in shell or in an ignored local env file ' +
        '(.notion.local, .env.local, scripts/.notion.local, or --env-file).',
    );
  }

  return {
    token,
    apiUrl: String(process.env.NOTION_API_URL || envValues.NOTION_API_URL || DEFAULT_API_URL).replace(/\/$/, ''),
    apiVersion: String(process.env.NOTION_API_VERSION || envValues.NOTION_API_VERSION || DEFAULT_API_VERSION).trim(),
    pageId: getRequiredArg(args, 'page-id', '--page-id'),
    maxComments: parseInteger(
      getOptionalArg(args, 'max-comments', String(DEFAULT_MAX_COMMENTS)),
      DEFAULT_MAX_COMMENTS,
    ),
    outputDir: getOptionalArg(
      args,
      'output-dir',
      process.env.NOTION_AGENT_OUTPUT_DIR || envValues.NOTION_AGENT_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    ),
    handoffDir: getOptionalArg(
      args,
      'handoff-dir',
      process.env.NOTION_AGENT_HANDOFF_DIR || envValues.NOTION_AGENT_HANDOFF_DIR || DEFAULT_HANDOFF_DIR,
    ),
    handoffAliasFile: normalizeOptionalPath(
      getOptionalArg(
        args,
        'handoff-alias-file',
        process.env.NOTION_AGENT_HANDOFF_ALIAS_FILE ||
          envValues.NOTION_AGENT_HANDOFF_ALIAS_FILE ||
          DEFAULT_HANDOFF_ALIAS_FILE,
      ),
      DEFAULT_HANDOFF_ALIAS_FILE,
    ),
    handoffRetriggerLatestOnly: parseBoolean(
      getOptionalArg(
        args,
        'handoff-retrigger-latest-only',
        process.env.NOTION_AGENT_HANDOFF_RETRIGGER_LATEST_ONLY ||
          envValues.NOTION_AGENT_HANDOFF_RETRIGGER_LATEST_ONLY ||
          String(DEFAULT_HANDOFF_RETRIGGER_LATEST_ONLY),
      ),
      DEFAULT_HANDOFF_RETRIGGER_LATEST_ONLY,
    ),
    dispatch: parseBoolean(getOptionalArg(args, 'dispatch', 'false'), false) || Boolean(args.dispatch),
    agentCommand: getOptionalArg(
      args,
      'agent-command',
      process.env.NOTION_AGENT_COMMAND || envValues.NOTION_AGENT_COMMAND || '',
    ),
    rulesFile: getOptionalArg(
      args,
      'rules-file',
      process.env.NOTION_AGENT_RULES_FILE || envValues.NOTION_AGENT_RULES_FILE || '',
    ),
    branchPrefix: getOptionalArg(
      args,
      'branch-prefix',
      process.env.NOTION_AGENT_BRANCH_PREFIX || envValues.NOTION_AGENT_BRANCH_PREFIX || DEFAULT_BRANCH_PREFIX,
    ),
    branchPrefixRules: parseBranchPrefixRules(
      getOptionalArg(
        args,
        'branch-prefix-rules',
        process.env.NOTION_AGENT_BRANCH_PREFIX_RULES ||
          envValues.NOTION_AGENT_BRANCH_PREFIX_RULES ||
          DEFAULT_BRANCH_PREFIX_RULES,
      ),
    ),
    branchIncludeTicketId: parseBoolean(
      getOptionalArg(
        args,
        'branch-include-ticket-id',
        process.env.NOTION_AGENT_BRANCH_INCLUDE_TICKET_ID ||
          envValues.NOTION_AGENT_BRANCH_INCLUDE_TICKET_ID ||
          String(DEFAULT_BRANCH_INCLUDE_TICKET_ID),
      ),
      DEFAULT_BRANCH_INCLUDE_TICKET_ID,
    ),
    gitPrepareBranch: parseBoolean(
      getOptionalArg(
        args,
        'git-prepare-branch',
        process.env.NOTION_AGENT_GIT_PREPARE_BRANCH ||
          envValues.NOTION_AGENT_GIT_PREPARE_BRANCH ||
          String(DEFAULT_GIT_PREPARE_BRANCH),
      ),
      DEFAULT_GIT_PREPARE_BRANCH,
    ),
    gitBaseBranch: getOptionalArg(
      args,
      'git-base-branch',
      process.env.NOTION_AGENT_GIT_BASE_BRANCH ||
        envValues.NOTION_AGENT_GIT_BASE_BRANCH ||
        DEFAULT_GIT_BASE_BRANCH,
    ),
    gitRemote: getOptionalArg(
      args,
      'git-remote',
      process.env.NOTION_AGENT_GIT_REMOTE || envValues.NOTION_AGENT_GIT_REMOTE || DEFAULT_GIT_REMOTE,
    ),
    gitRequireCleanWorktree: parseBoolean(
      getOptionalArg(
        args,
        'git-require-clean-worktree',
        process.env.NOTION_AGENT_GIT_REQUIRE_CLEAN_WORKTREE ||
          envValues.NOTION_AGENT_GIT_REQUIRE_CLEAN_WORKTREE ||
          String(DEFAULT_GIT_REQUIRE_CLEAN_WORKTREE),
      ),
      DEFAULT_GIT_REQUIRE_CLEAN_WORKTREE,
    ),
    agentCreateChat: parseBoolean(
      getOptionalArg(
        args,
        'agent-create-chat',
        process.env.NOTION_AGENT_CREATE_CHAT ||
          envValues.NOTION_AGENT_CREATE_CHAT ||
          String(DEFAULT_AGENT_CREATE_CHAT),
      ),
      DEFAULT_AGENT_CREATE_CHAT,
    ),
    agentCreateChatCommand: getOptionalArg(
      args,
      'agent-create-chat-command',
      process.env.NOTION_AGENT_CREATE_CHAT_COMMAND ||
        envValues.NOTION_AGENT_CREATE_CHAT_COMMAND ||
        DEFAULT_AGENT_CREATE_CHAT_COMMAND,
    ),
    unsetCursorApiKey: parseBoolean(
      getOptionalArg(
        args,
        'unset-cursor-api-key',
        process.env.NOTION_AGENT_UNSET_CURSOR_API_KEY ||
          envValues.NOTION_AGENT_UNSET_CURSOR_API_KEY ||
          String(DEFAULT_AGENT_UNSET_CURSOR_API_KEY),
      ),
      DEFAULT_AGENT_UNSET_CURSOR_API_KEY,
    ),
    agentHeadlessPrint: parseBoolean(
      getOptionalArg(
        args,
        'agent-headless-print',
        process.env.NOTION_AGENT_HEADLESS_PRINT ||
          envValues.NOTION_AGENT_HEADLESS_PRINT ||
          String(DEFAULT_AGENT_HEADLESS_PRINT),
      ),
      DEFAULT_AGENT_HEADLESS_PRINT,
    ),
    ideHandoff: parseBoolean(
      getOptionalArg(
        args,
        'ide-handoff',
        process.env.NOTION_AGENT_IDE_HANDOFF ||
          envValues.NOTION_AGENT_IDE_HANDOFF ||
          String(DEFAULT_IDE_HANDOFF),
      ),
      DEFAULT_IDE_HANDOFF,
    ),
    sectionPropertyName: String(
      process.env.NOTION_AGENT_SECTION_PROPERTY ||
        envValues.NOTION_AGENT_SECTION_PROPERTY ||
        getOptionalArg(args, 'section-property', DEFAULT_SECTION_PROPERTY),
    ).trim(),
  };
}

function adaptCursorAgentCommandForHeadless(command, headless) {
  let raw = String(command || '').trim();
  if (headless || !raw) return raw;

  const before = raw;
  raw = raw.replace(/\s--print\b/g, '');
  raw = raw.replace(/\s--trust\b/g, '');
  raw = raw.replace(/\s--stream-partial-output\b/g, '');
  raw = raw.replace(/\s{2,}/g, ' ').trim();

  if (raw !== before) {
    print(
      'NOTION_AGENT_HEADLESS_PRINT=false: removed --print / --trust / --stream-partial-output for interactive Agent UI.',
      colors.yellow,
    );
  }
  return raw;
}

function buildCursorAgentChildEnv(config, extra = {}) {
  const env = { ...process.env, ...extra };
  if (config.unsetCursorApiKey) {
    delete env.CURSOR_API_KEY;
  }
  return env;
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
    const message = payload?.message || payload?.code || payload?.error || `HTTP ${response.status}`;
    fail(`Notion API request failed: ${String(message).slice(0, 400)}`);
  }

  return payload || {};
}

function plainTextFromRichText(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list
    .map((entry) => String(entry?.plain_text || '').trim())
    .filter(Boolean)
    .join('');
}

function propertyValueToText(property) {
  if (!property || typeof property !== 'object') return '';
  const type = String(property.type || '').trim();
  if (type === 'title') return plainTextFromRichText(property.title);
  if (type === 'rich_text') return plainTextFromRichText(property.rich_text);
  if (type === 'status') return String(property.status?.name || '').trim();
  if (type === 'select') return String(property.select?.name || '').trim();
  if (type === 'multi_select') {
    return (property.multi_select || [])
      .map((entry) => String(entry?.name || '').trim())
      .filter(Boolean)
      .join(', ');
  }
  if (type === 'people') {
    return (property.people || [])
      .map((entry) => String(entry?.name || entry?.id || '').trim())
      .filter(Boolean)
      .join(', ');
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

function getPageTitle(page) {
  const explicit = findPropertyByType(page, 'title');
  const text = propertyValueToText(explicit);
  return text || String(page?.id || '');
}

function normalizePropertySnapshot(properties) {
  const rows = [];
  const source = properties && typeof properties === 'object' ? properties : {};
  for (const [name, property] of Object.entries(source)) {
    rows.push({
      name,
      type: String(property?.type || ''),
      value: propertyValueToText(property),
    });
  }
  rows.sort((left, right) => left.name.localeCompare(right.name));
  return rows;
}

function extractFilesFromBlock(block) {
  if (!block || typeof block !== 'object') return [];
  const files = [];
  const type = String(block.type || '').trim();
  const typePayload = block[type];
  if (type === 'file' && typePayload) {
    const externalUrl = String(typePayload?.external?.url || '').trim();
    const fileUrl = String(typePayload?.file?.url || '').trim();
    const expiry = String(typePayload?.file?.expiry_time || '').trim();
    const name = String(typePayload?.caption?.[0]?.plain_text || typePayload?.name || 'file').trim();
    files.push({
      blockId: String(block.id || ''),
      name,
      url: externalUrl || fileUrl,
      expiryTime: expiry,
      kind: typePayload?.type || 'file',
    });
  }
  return files;
}

function normalizeComment(comment) {
  return {
    id: String(comment?.id || ''),
    createdAt: String(comment?.created_time || ''),
    discussionId: String(comment?.discussion_id || ''),
    createdBy: String(comment?.created_by?.name || comment?.created_by?.id || 'unknown'),
    text: plainTextFromRichText(comment?.rich_text),
  };
}

async function getPageDetails(config) {
  const page = await notionRequest(config, `/pages/${config.pageId}`, { method: 'GET' });
  const commentsPayload = await notionRequest(
    config,
    `/comments?block_id=${encodeURIComponent(config.pageId)}&page_size=${encodeURIComponent(
      String(config.maxComments),
    )}`,
    { method: 'GET' },
  );
  const blocksPayload = await notionRequest(
    config,
    `/blocks/${config.pageId}/children?page_size=100`,
    { method: 'GET' },
  );

  const comments = (Array.isArray(commentsPayload?.results) ? commentsPayload.results : []).map(normalizeComment);
  const blocks = Array.isArray(blocksPayload?.results) ? blocksPayload.results : [];
  const files = blocks.flatMap((block) => extractFilesFromBlock(block));

  return {
    page,
    comments,
    files,
    blocksCount: blocks.length,
  };
}

function slugifyForBranch(value, maxLen = 48) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug || 'ticket';
}

function sanitizeBranchForHandoffFilename(branch) {
  const raw = String(branch || '').trim() || 'notion-ticket';
  let s = raw.replace(/[/\\:*?"<>|]+/g, '-');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (s.length > 180) s = s.slice(0, 180).replace(/-+$/g, '');
  return s || 'notion-ticket';
}

function buildIdeHandoffBody({ branchLabel, relativeHandoffPath, archiveHandoffPath, promptText }) {
  const archiveLine =
    archiveHandoffPath && archiveHandoffPath !== relativeHandoffPath
      ? `- **Branch-specific handoff file:** \`${archiveHandoffPath}\``
      : '';
  return [
    '# Cursor IDE Agent — Notion handoff',
    '',
    'Use **Agent** in the Cursor IDE (sidebar), start a chat, and attach this file with `@` using the path below.',
    '',
    `- **Git branch:** \`${branchLabel}\``,
    `- **This file (repo-relative):** \`${relativeHandoffPath}\``,
    ...(archiveLine ? [archiveLine] : []),
    '',
    'Branch handoff files are kept in `.notion/handoffs/` and the stable alias is refreshed on each run.',
    '',
    '---',
    '',
    promptText.trimEnd(),
    '',
  ].join('\n');
}

function resolveRepoRelativePath(absolutePath) {
  const rel = path.relative(process.cwd(), absolutePath);
  return rel.split(path.sep).join('/');
}

function ensureTrailingNewline(text) {
  const raw = String(text || '');
  if (!raw) return '\n';
  return raw.endsWith('\n') ? raw : `${raw}\n`;
}

function pickLatestComment(comments) {
  const entries = Array.isArray(comments) ? comments : [];
  if (entries.length === 0) return null;
  const ranked = entries.map((entry, index) => {
    const timestamp = Date.parse(String(entry?.createdAt || '').trim());
    return {
      entry,
      index,
      timestamp: Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY,
    };
  });
  ranked.sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return a.index - b.index;
  });
  return ranked[0]?.entry || entries[0] || null;
}

function extractLatestCommentDetails(context) {
  const latest = pickLatestComment(context?.comments);
  if (!latest) {
    return {
      found: false,
      id: 'unknown',
      createdAt: 'unknown',
      author: 'unknown',
      text: '(No Notion comments found for this retrigger.)',
    };
  }
  return {
    found: true,
    id: String(latest.id || '').trim() || 'unknown',
    createdAt: String(latest.createdAt || '').trim() || 'unknown',
    author: String(latest.createdBy || '').trim() || 'unknown',
    text: String(latest.text || '').trim() || '(empty comment text)',
  };
}

function buildRetriggerLatestOnlyPrompt({
  context,
  branchLabel,
  promptPath,
  contextPath,
  latestComment,
}) {
  return [
    `Ticket ${context.ticket.id} — ${context.ticket.title}`,
    '',
    '## Retrigger intake mode',
    'Same-ticket retrigger detected. This handoff intentionally includes only the latest Notion comment to avoid re-sending full task context.',
    '',
    '## Ticket',
    `- Page ID: ${context.ticket.id}`,
    `- Title: ${context.ticket.title}`,
    `- Branch: ${branchLabel}`,
    '',
    '## Latest Notion comment',
    `- Comment ID: ${latestComment.id}`,
    `- Time: ${latestComment.createdAt}`,
    `- Author: ${latestComment.author}`,
    '',
    '```text',
    latestComment.text,
    '```',
    '',
    '## Optional full artifacts (only if needed)',
    `- Full prompt artifact: \`${promptPath}\``,
    `- Full context artifact: \`${contextPath}\``,
    '',
    '## Required Output (exact sections)',
    '1. What changed in this latest comment',
    '2. Code changes needed on the current branch',
    '3. Validation steps for this delta',
    '4. Risks or questions',
    '',
  ].join('\n');
}

function resolveSectionContext(page, sectionPropertyName) {
  const explicitProperty = findPropertyByName(page, sectionPropertyName);
  const explicitValue = propertyValueToText(explicitProperty);
  if (explicitValue) {
    return {
      sectionId: normalize(explicitValue),
      sectionTitle: explicitValue,
      source: `property:${sectionPropertyName}`,
    };
  }

  const fallbackCandidates = ['Type', 'Category', 'Team', 'Workstream', 'Priority'];
  for (const candidate of fallbackCandidates) {
    if (candidate === sectionPropertyName) continue;
    const fallback = findPropertyByName(page, candidate);
    const fallbackValue = propertyValueToText(fallback);
    if (fallbackValue) {
      return {
        sectionId: normalize(fallbackValue),
        sectionTitle: fallbackValue,
        source: `property:${candidate}`,
      };
    }
  }

  return {
    sectionId: '',
    sectionTitle: '',
    source: 'none',
  };
}

function resolveBranchPrefixForSection(sectionTitle, sectionId, rules, fallbackPrefix) {
  const normalizedSection = normalize(sectionTitle);
  const normalizedSectionId = normalize(sectionId);
  const normalizedFallback = String(fallbackPrefix || DEFAULT_BRANCH_PREFIX).trim().replace(/\/+$/g, '');
  const parsedRules = Array.isArray(rules) ? rules : [];

  if (!normalizedSection && !normalizedSectionId) {
    return {
      prefix: normalizedFallback,
      matchedRule: null,
    };
  }

  if (normalizedSectionId) {
    const idRule = parsedRules.find(
      (rule) => rule?.matchType === 'id' && normalize(rule?.match) === normalizedSectionId,
    );
    if (idRule) {
      return {
        prefix: normalizePrefix(idRule.prefix) || normalizedFallback,
        matchedRule: idRule,
      };
    }
  }

  const exact = parsedRules.find(
    (rule) =>
      (rule?.matchType || 'title') !== 'id' && normalizedSection && normalizedSection === normalize(rule?.match),
  );
  if (exact) {
    return {
      prefix: normalizePrefix(exact.prefix) || normalizedFallback,
      matchedRule: exact,
    };
  }

  const partial = parsedRules.find(
    (rule) =>
      (rule?.matchType || 'title') !== 'id' &&
      normalizedSection &&
      normalize(rule?.match) &&
      normalizedSection.includes(normalize(rule?.match)),
  );
  if (partial) {
    return {
      prefix: normalizePrefix(partial.prefix) || normalizedFallback,
      matchedRule: partial,
    };
  }

  return {
    prefix: normalizedFallback,
    matchedRule: null,
  };
}

function buildBranchCandidate(prefix, page, sectionContext, branchPrefixRules, branchIncludeTicketId) {
  const resolved = resolveBranchPrefixForSection(
    sectionContext?.sectionTitle || '',
    sectionContext?.sectionId || '',
    branchPrefixRules,
    prefix,
  );
  const resolvedPrefix = resolved.prefix;
  const cleanPrefix = String(resolvedPrefix || DEFAULT_BRANCH_PREFIX).replace(/\/+$/g, '');
  const pageTitle = getPageTitle(page);
  const slug = slugifyForBranch(pageTitle || '');
  const includeTicketId = Boolean(branchIncludeTicketId);
  const branchName = includeTicketId ? `${String(page?.id || 'unknown')}-${slug}` : slug;
  return {
    branchCandidate: `${cleanPrefix}/${branchName}`,
    resolvedPrefix: cleanPrefix,
    matchedRule: resolved.matchedRule,
    includeTicketId,
  };
}

async function runCommandCapture(binary, args, options = {}) {
  const cwd = options.cwd || process.cwd();
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

async function runGit(args, config) {
  const cwd = String(config?.gitWorkingDirectory || process.cwd());
  const result = await runCommandCapture('git', args, {
    cwd,
    env: process.env,
  });
  if (result.signal) {
    fail(`git ${args.join(' ')} terminated by signal: ${result.signal}`);
  }
  if (result.code !== 0) {
    const stderrText = String(result.stderr || '').trim();
    const stdoutText = String(result.stdout || '').trim();
    const details = stderrText || stdoutText || `exit code ${result.code}`;
    fail(`git ${args.join(' ')} failed: ${details}`);
  }
  return String(result.stdout || '').trim();
}

function parseAheadBehind(value) {
  const raw = String(value || '').trim();
  const [aheadRaw, behindRaw] = raw.split(/\s+/);
  const ahead = Number.parseInt(aheadRaw || '0', 10);
  const behind = Number.parseInt(behindRaw || '0', 10);
  if (Number.isNaN(ahead) || Number.isNaN(behind)) {
    fail(`Could not parse branch divergence output: ${raw || '(empty)'}`);
  }
  return { ahead, behind };
}

async function hasGitRef(ref, config) {
  try {
    await runGit(['show-ref', '--verify', '--quiet', ref], config);
    return true;
  } catch {
    return false;
  }
}

async function remoteBranchExists(remote, branch, config) {
  const output = await runGit(['ls-remote', '--heads', remote, branch], config);
  return Boolean(String(output || '').trim());
}

async function prepareGitBranch(config, branchName) {
  const baseBranch = String(config.gitBaseBranch || DEFAULT_GIT_BASE_BRANCH).trim();
  const remote = String(config.gitRemote || DEFAULT_GIT_REMOTE).trim();
  const targetBranch = String(branchName || '').trim();

  if (!baseBranch) fail('NOTION_AGENT_GIT_BASE_BRANCH must not be empty.');
  if (!remote) fail('NOTION_AGENT_GIT_REMOTE must not be empty.');
  if (!targetBranch) fail('Branch candidate is empty; cannot prepare git branch.');

  await runGit(['rev-parse', '--is-inside-work-tree'], config);
  await runGit(['check-ref-format', '--branch', targetBranch], config);

  if (config.gitRequireCleanWorktree) {
    const status = await runGit(['status', '--porcelain', '--untracked-files=no'], config);
    if (status) {
      fail(
        'Refusing branch checkout because working tree has tracked changes. ' +
          'Commit or stash changes first, or set NOTION_AGENT_GIT_REQUIRE_CLEAN_WORKTREE=false.',
      );
    }
  }

  const hasLocalTargetBranch = await hasGitRef(`refs/heads/${targetBranch}`, config);
  if (hasLocalTargetBranch) {
    print(
      `Reusing existing local branch '${targetBranch}' (safe mode: no reset from base).`,
      colors.yellow,
    );
    await runGit(['checkout', targetBranch], config);
    const headSha = await runGit(['rev-parse', '--short', 'HEAD'], config);
    return {
      baseBranch,
      remote,
      preparedBranch: targetBranch,
      headSha,
      reusedExistingBranch: true,
      branchSource: 'local-existing',
    };
  }

  if (await remoteBranchExists(remote, targetBranch, config)) {
    print(
      `Reusing existing remote branch '${remote}/${targetBranch}' (safe mode: no reset from base).`,
      colors.yellow,
    );
    await runGit(['fetch', remote, targetBranch], config);
    await runGit(['checkout', '-B', targetBranch, `${remote}/${targetBranch}`], config);
    const headSha = await runGit(['rev-parse', '--short', 'HEAD'], config);
    return {
      baseBranch,
      remote,
      preparedBranch: targetBranch,
      headSha,
      reusedExistingBranch: true,
      branchSource: 'remote-existing',
    };
  }

  print(`Preparing git base branch '${baseBranch}' from '${remote}'...`, colors.cyan);
  await runGit(['fetch', remote, baseBranch], config);

  const remoteRef = `refs/remotes/${remote}/${baseBranch}`;
  if (!(await hasGitRef(remoteRef, config))) {
    fail(`Remote base branch not found: ${remote}/${baseBranch}`);
  }

  const hasLocalBaseBranch = await hasGitRef(`refs/heads/${baseBranch}`, config);

  if (hasLocalBaseBranch) {
    await runGit(['checkout', baseBranch], config);
  } else {
    await runGit(['checkout', '-B', baseBranch, `${remote}/${baseBranch}`], config);
  }

  const divergenceBefore = parseAheadBehind(
    await runGit(['rev-list', '--left-right', '--count', `${baseBranch}...${remote}/${baseBranch}`], config),
  );

  if (divergenceBefore.ahead > 0) {
    fail(
      `Local ${baseBranch} is ahead of ${remote}/${baseBranch} by ${divergenceBefore.ahead} commit(s). ` +
        'Refusing to continue because branch must match remote exactly.',
    );
  }

  if (divergenceBefore.behind > 0) {
    await runGit(['merge', '--ff-only', `${remote}/${baseBranch}`], config);
  }

  const divergenceAfter = parseAheadBehind(
    await runGit(['rev-list', '--left-right', '--count', `${baseBranch}...${remote}/${baseBranch}`], config),
  );
  if (divergenceAfter.ahead !== 0 || divergenceAfter.behind !== 0) {
    fail(
      `Failed to sync ${baseBranch} with ${remote}/${baseBranch} ` +
        `(ahead=${divergenceAfter.ahead}, behind=${divergenceAfter.behind}).`,
    );
  }

  await runGit(['checkout', '-B', targetBranch], config);
  const headSha = await runGit(['rev-parse', '--short', 'HEAD'], config);

  return {
    baseBranch,
    remote,
    preparedBranch: targetBranch,
    headSha,
    reusedExistingBranch: false,
    branchSource: 'remote-base',
  };
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function extractCursorChatId(text) {
  const raw = stripAnsi(String(text || '')).trim();
  if (!raw) return '';
  const exact = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (exact) return exact[0];
  const loose = raw.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
  if (loose) return loose[0];
  const token = raw.split(/\s+/).find((value) => value.length >= 12);
  return String(token || '').trim();
}

async function createCursorChatId(config) {
  const command = String(config.agentCreateChatCommand || '').trim();
  if (!command) return '';

  const result = await runCommandCapture('bash', ['-lc', command], {
    cwd: process.cwd(),
    env: buildCursorAgentChildEnv(config),
  });
  if (result.signal) {
    fail(`Chat creation command terminated by signal: ${result.signal}`);
  }
  if (result.code !== 0) {
    const details = String(result.stderr || result.stdout || '').trim() || `exit code ${result.code}`;
    fail(`Failed to create Cursor chat session: ${details}`);
  }

  const chatId = extractCursorChatId(result.stdout);
  if (!chatId) {
    fail(
      'Cursor chat creation did not return a chat ID. ' +
        'Set NOTION_AGENT_CREATE_CHAT=false to bypass, or fix NOTION_AGENT_CREATE_CHAT_COMMAND.',
    );
  }
  return chatId;
}

function commandStartsWithCursorAgent(raw) {
  const trimmed = String(raw || '').trim();
  if (/^cursor\s+agent(?:\s|$)/i.test(trimmed)) return true;
  if (/^\$HOME\/\.local\/bin\/cursor-agent(?:\s|$)/.test(trimmed)) return true;
  const firstToken = trimmed.match(/^[^\s]+/);
  return Boolean(firstToken && /cursor-agent$/i.test(firstToken[0]));
}

function injectResumeFlagIfNeeded(command, chatId) {
  const raw = String(command || '').trim();
  if (!raw || !chatId) return raw;

  if (!commandStartsWithCursorAgent(raw)) return raw;

  if (/(^|\s)--resume(\s|=)/.test(raw) || /(^|\s)--continue(\s|$)/.test(raw)) {
    return raw;
  }

  const safeId = String(chatId).replace(/"/g, '\\"');
  const firstSpace = raw.search(/\s/);
  if (firstSpace === -1) {
    return `${raw} --resume "${safeId}"`;
  }
  const bin = raw.slice(0, firstSpace);
  const rest = raw.slice(firstSpace + 1).trimStart();
  return `${bin} --resume "${safeId}" ${rest}`;
}

async function readRulesText(rulesFile) {
  const normalizedPath = String(rulesFile || '').trim();
  if (!normalizedPath) return DEFAULT_RULES;

  const absolutePath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(process.cwd(), normalizedPath);
  try {
    const content = await fs.readFile(absolutePath, 'utf8');
    const text = String(content || '').trim();
    return text || DEFAULT_RULES;
  } catch {
    return DEFAULT_RULES;
  }
}

function buildPrompt({ page, pageSnapshot, branchCandidate, rulesText, sectionContext, resolvedPrefix, gitPreparation }) {
  const comments = Array.isArray(pageSnapshot.comments) ? pageSnapshot.comments : [];
  const latestCommentLines = comments.slice(0, 8).map((comment, index) => {
    const creator = String(comment?.createdBy || '').trim() || 'unknown';
    const created = String(comment?.createdAt || '').trim() || 'unknown-time';
    const body = String(comment?.text || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    return `${index + 1}. [${created}] ${creator}: ${body || '(empty comment)'}`;
  });

  const fileLines = (pageSnapshot.files || []).slice(0, 15).map((asset, index) => {
    const name = String(asset?.name || '').trim() || `file-${index + 1}`;
    const url = String(asset?.url || '').trim();
    return `${index + 1}. ${name}${url ? ` -> ${url}` : ''}`;
  });

  const propertyLines = (pageSnapshot.propertyRows || []).slice(0, 25).map((row) => {
    const value = String(row?.value || '').trim() || '(empty)';
    return `- ${row?.name} [${row?.type}]: ${value}`;
  });

  return [
    '# Notion Ticket Agent Intake',
    '',
    'You are a focused ticket triage agent.',
    '',
    '## Ticket Context',
    `- Page ID: ${page?.id || ''}`,
    `- Title: ${getPageTitle(page)}`,
    `- URL: ${String(page?.url || '').trim() || '(none)'}`,
    `- Parent database: ${String(page?.parent?.database_id || '').trim() || '(none)'}`,
    `- Last edited: ${String(page?.last_edited_time || '').trim() || '(unknown)'}`,
    `- Section used for branch strategy: ${sectionContext?.sectionTitle || '(unknown)'} [id=${sectionContext?.sectionId || '(none)'}] (${sectionContext?.source || 'n/a'})`,
    `- Resolved Branch Prefix: ${resolvedPrefix || '(unknown)'}`,
    `- Proposed Branch Name Candidate: ${branchCandidate}`,
    `- Git Base Branch: ${gitPreparation?.baseBranch || '(not prepared)'}`,
    `- Git Prepared Branch: ${gitPreparation?.preparedBranch || '(not prepared)'}`,
    `- Git Base Remote: ${gitPreparation?.remote || '(not prepared)'}`,
    `- Git Prepared Head: ${gitPreparation?.headSha || '(not prepared)'}`,
    '',
    '## Property Snapshot',
    ...(propertyLines.length > 0 ? propertyLines : ['(No page properties found)']),
    '',
    '## Latest Comments',
    ...(latestCommentLines.length > 0 ? latestCommentLines : ['(No comments found)']),
    '',
    '## Attached Files (first-level blocks)',
    ...(fileLines.length > 0 ? fileLines : ['(No files found)']),
    '',
    '## Mandatory Rules',
    rulesText,
    '',
    '## Required Output (exact sections)',
    '1. Ticket understanding',
    '2. Root cause hypotheses (ordered by confidence)',
    '3. Proposed branch name (final)',
    '4. Proposed solution approach (step-by-step)',
    '5. Validation and regression checks',
    '6. Risks, unknowns, and questions for clarifications',
    '',
    'Keep recommendations actionable and implementation-ready.',
    '',
  ].join('\n');
}

function buildContextObject({
  page,
  pageSnapshot,
  branchCandidate,
  rulesText,
  sectionContext,
  resolvedPrefix,
  branchPrefixRules,
  matchedBranchRule,
  branchIncludeTicketId,
  gitPreparation,
}) {
  return {
    generatedAt: new Date().toISOString(),
    ticket: {
      id: String(page?.id || ''),
      title: getPageTitle(page),
      url: String(page?.url || ''),
      parentDatabaseId: String(page?.parent?.database_id || ''),
      lastEditedAt: String(page?.last_edited_time || ''),
      sectionForBranching: {
        id: String(sectionContext?.sectionId || ''),
        name: String(sectionContext?.sectionTitle || ''),
        source: String(sectionContext?.source || ''),
      },
    },
    branchCandidate,
    branchPrefixResolved: resolvedPrefix,
    branchPrefixRules,
    branchPrefixRuleMatched: matchedBranchRule || null,
    branchIncludeTicketId: Boolean(branchIncludeTicketId),
    gitPreparation: gitPreparation || null,
    rules: rulesText,
    properties: pageSnapshot.propertyRows || [],
    comments: pageSnapshot.comments || [],
    files: pageSnapshot.files || [],
    blocksCount: Number(pageSnapshot.blocksCount || 0),
  };
}

async function writeIntakeFiles(config, context, promptText) {
  const outputDir = path.isAbsolute(config.outputDir)
    ? config.outputDir
    : path.resolve(process.cwd(), config.outputDir);
  const handoffDir = path.isAbsolute(config.handoffDir)
    ? config.handoffDir
    : path.resolve(process.cwd(), config.handoffDir);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(handoffDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeTitle = slugifyForBranch(context.ticket.title || 'ticket', 36);
  const baseName = `${context.ticket.id}-${safeTitle}-${timestamp}`;

  const promptPath = path.join(outputDir, `${baseName}.prompt.md`);
  const contextPath = path.join(outputDir, `${baseName}.context.json`);

  await fs.writeFile(promptPath, `${promptText}\n`, 'utf8');
  await fs.writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8');

  const branchLabel =
    String(context.gitPreparation?.preparedBranch || '').trim() || context.branchCandidate;
  let handoffPath = '';
  let handoffBaseName = '';
  let handoffAliasPath = '';
  let handoffWriteMode = 'full-ticket';
  let retriggerComment = null;
  if (config.ideHandoff) {
    const shouldUseRetriggerLatestOnly = Boolean(
      config.handoffRetriggerLatestOnly && context.gitPreparation?.reusedExistingBranch,
    );
    if (shouldUseRetriggerLatestOnly) {
      handoffWriteMode = 'retrigger-latest-only';
      retriggerComment = extractLatestCommentDetails(context);
    }

    handoffBaseName = `${sanitizeBranchForHandoffFilename(branchLabel)}.agent-handoff`;
    handoffPath = path.join(handoffDir, `${handoffBaseName}.md`);
    const handoffPrompt = shouldUseRetriggerLatestOnly
      ? buildRetriggerLatestOnlyPrompt({
          context,
          branchLabel,
          promptPath: resolveRepoRelativePath(promptPath),
          contextPath: resolveRepoRelativePath(contextPath),
          latestComment: retriggerComment || extractLatestCommentDetails(context),
        })
      : promptText;
    const handoffBody = buildIdeHandoffBody({
      branchLabel,
      relativeHandoffPath: resolveRepoRelativePath(handoffPath),
      archiveHandoffPath: '',
      promptText: handoffPrompt,
    });
    await fs.writeFile(handoffPath, ensureTrailingNewline(handoffBody), 'utf8');

    if (config.handoffAliasFile) {
      handoffAliasPath = path.isAbsolute(config.handoffAliasFile)
        ? config.handoffAliasFile
        : path.resolve(process.cwd(), config.handoffAliasFile);
      await fs.mkdir(path.dirname(handoffAliasPath), { recursive: true });
      const aliasBody = buildIdeHandoffBody({
        branchLabel,
        relativeHandoffPath: resolveRepoRelativePath(handoffAliasPath),
        archiveHandoffPath: resolveRepoRelativePath(handoffPath),
        promptText: handoffPrompt,
      });
      await fs.writeFile(handoffAliasPath, ensureTrailingNewline(aliasBody), 'utf8');
    }
  }

  return {
    outputDir,
    handoffDir,
    promptPath,
    contextPath,
    baseName,
    handoffPath: handoffPath || null,
    handoffBaseName: handoffBaseName || null,
    handoffAliasPath: handoffAliasPath || null,
    handoffWriteMode,
    retriggerComment: retriggerComment
      ? {
          found: Boolean(retriggerComment.found),
          id: retriggerComment.id,
          createdAt: retriggerComment.createdAt,
          author: retriggerComment.author,
        }
      : null,
  };
}

async function dispatchAgent(config, files, context, gitPreparation) {
  const configuredCommand = String(config.agentCommand || '').trim();
  if (!configuredCommand) {
    fail(
      'Dispatch requested but NOTION_AGENT_COMMAND is not configured. ' +
        'Set it in .notion.local or pass --agent-command.',
    );
  }

  let chatId = '';
  if (config.agentCreateChat) {
    chatId = await createCursorChatId(config);
    print(`Created Cursor chat session: ${chatId}`, colors.green);
  }

  let command = injectResumeFlagIfNeeded(configuredCommand, chatId);
  command = adaptCursorAgentCommandForHeadless(command, config.agentHeadlessPrint);

  const env = buildCursorAgentChildEnv(config, {
    NOTION_AGENT_PROMPT_FILE: files.promptPath,
    NOTION_AGENT_CONTEXT_FILE: files.contextPath,
    NOTION_AGENT_IDE_HANDOFF_FILE: files.handoffPath ? resolveRepoRelativePath(files.handoffPath) : '',
    NOTION_AGENT_IDE_HANDOFF_ALIAS_FILE: files.handoffAliasPath
      ? resolveRepoRelativePath(files.handoffAliasPath)
      : '',
    NOTION_AGENT_PAGE_ID: context.ticket.id,
    NOTION_AGENT_PAGE_TITLE: context.ticket.title,
    NOTION_AGENT_BRANCH_CANDIDATE: context.branchCandidate,
    NOTION_AGENT_CHAT_ID: chatId,
    NOTION_AGENT_BASE_BRANCH: String(gitPreparation?.baseBranch || ''),
    NOTION_AGENT_GIT_REMOTE: String(gitPreparation?.remote || ''),
    NOTION_AGENT_PREPARED_BRANCH: String(gitPreparation?.preparedBranch || ''),
    NOTION_AGENT_PREPARED_HEAD_SHA: String(gitPreparation?.headSha || ''),
    NOTION_AGENT_PREPARED_BRANCH_REUSED: String(Boolean(gitPreparation?.reusedExistingBranch)),
    NOTION_AGENT_PREPARED_BRANCH_SOURCE: String(gitPreparation?.branchSource || ''),
  });

  if (config.unsetCursorApiKey && String(process.env.CURSOR_API_KEY || '').trim()) {
    print(
      'NOTION_AGENT_UNSET_CURSOR_API_KEY: omitting CURSOR_API_KEY for cursor-agent (use login session).',
      colors.dim,
    );
  }

  print(`Dispatching agent command: ${command}`, colors.cyan);
  if (config.agentHeadlessPrint && /\s--print\b/.test(command)) {
    print(
      'Headless mode: output stays in this terminal. For a visible Cursor Agent chat, set NOTION_AGENT_HEADLESS_PRINT=false.',
      colors.dim,
    );
  }

  await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Agent command terminated by signal: ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Agent command failed with exit code: ${code}`));
        return;
      }
      resolve();
    });

    child.on('error', (error) => reject(error));
  });
}

function printUsage() {
  print('');
  print('notion ticket -> agent intake', colors.cyan);
  print('');
  print('Usage:');
  print('  node scripts/notion-agent-intake.js --page-id <id> [--dispatch]');
  print('');
  print('Options:');
  print('  --workspace <path>');
  print('  --page-id <id> (required)');
  print('  --max-comments <n>');
  print('  --output-dir <dir>');
  print('  --handoff-dir <dir>');
  print('  --handoff-alias-file <path|false> (default notion-handoff.md)');
  print('  --handoff-retrigger-latest-only true|false (default true)');
  print('  --section-property <property-name> (default Type)');
  print('  --rules-file <path>');
  print('  --branch-prefix <prefix>');
  print('  --branch-prefix-rules "bugs=fix,epics backlog=feat"');
  print('  --branch-include-ticket-id true|false');
  print('  --git-prepare-branch true|false');
  print('  --git-base-branch <branch>');
  print('  --git-remote <remote>');
  print('  --git-require-clean-worktree true|false');
  print('  --agent-create-chat true|false');
  print('  --agent-create-chat-command "<shell command>"');
  print('  --unset-cursor-api-key true|false');
  print('  --agent-headless-print true|false');
  print('  --ide-handoff true|false');
  print('  --dispatch');
  print('  --agent-command "<shell command>"');
  print('  --env-file <path>');
  print('');
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
  print(`page: ${config.pageId}`, colors.dim);
  print(`dispatch: ${config.dispatch ? 'yes' : 'no'}`, colors.dim);
  if (config.dispatch) {
    print(
      `git prep: ${config.gitPrepareBranch ? 'enabled' : 'disabled'} (base=${config.gitBaseBranch}, remote=${config.gitRemote})`,
      colors.dim,
    );
    print(`cursor chat creation: ${config.agentCreateChat ? 'enabled' : 'disabled'}`, colors.dim);
  }

  const pageSnapshot = await getPageDetails(config);
  const page = pageSnapshot.page;
  const sectionContext = resolveSectionContext(page, config.sectionPropertyName);
  const branchResolution = buildBranchCandidate(
    config.branchPrefix,
    page,
    sectionContext,
    config.branchPrefixRules,
    config.branchIncludeTicketId,
  );
  const branchCandidate = branchResolution.branchCandidate;
  const resolvedPrefix = branchResolution.resolvedPrefix;
  const matchedBranchRule = branchResolution.matchedRule;
  const branchIncludeTicketId = branchResolution.includeTicketId;
  let gitPreparation = null;

  if (config.dispatch && config.gitPrepareBranch) {
    gitPreparation = await prepareGitBranch(config, branchCandidate);
    const branchMode = gitPreparation.reusedExistingBranch
      ? `reused existing (${gitPreparation.branchSource})`
      : `created from ${gitPreparation.remote}/${gitPreparation.baseBranch}`;
    print(
      `Git prepared: base=${gitPreparation.baseBranch} remote=${gitPreparation.remote} branch=${gitPreparation.preparedBranch} @ ${gitPreparation.headSha} [${branchMode}]`,
      colors.green,
    );
  } else if (config.dispatch && !config.gitPrepareBranch) {
    print('Git branch preparation disabled (NOTION_AGENT_GIT_PREPARE_BRANCH=false).', colors.yellow);
  }

  pageSnapshot.propertyRows = normalizePropertySnapshot(page?.properties);
  const rulesText = await readRulesText(config.rulesFile);

  const promptText = buildPrompt({
    page,
    pageSnapshot,
    branchCandidate,
    rulesText,
    sectionContext,
    resolvedPrefix,
    gitPreparation,
  });
  const context = buildContextObject({
    page,
    pageSnapshot,
    branchCandidate,
    rulesText,
    sectionContext,
    resolvedPrefix,
    branchPrefixRules: config.branchPrefixRules,
    matchedBranchRule,
    branchIncludeTicketId,
    gitPreparation,
  });
  const files = await writeIntakeFiles(config, context, promptText);

  print(`Prompt file: ${files.promptPath}`, colors.green);
  print(`Context file: ${files.contextPath}`, colors.green);
  if (files.handoffPath) {
    print(
      `IDE handoff (@ this file in Cursor Agent): ${resolveRepoRelativePath(files.handoffPath)}`,
      colors.green,
    );
  }
  if (files.handoffAliasPath) {
    print(
      `Stable handoff alias (@ this file in Cursor Agent): ${resolveRepoRelativePath(files.handoffAliasPath)}`,
      colors.green,
    );
  }
  if (files.handoffWriteMode === 'retrigger-latest-only') {
    print(
      'Retrigger mode: handoff rewritten to latest Notion comment only (full ticket context intentionally omitted).',
      colors.yellow,
    );
  }
  print(
    `Section: ${sectionContext.sectionTitle || '(unknown)'} [id=${sectionContext.sectionId || '(none)'}] (${sectionContext.source}) -> prefix ${resolvedPrefix}`,
    colors.green,
  );
  print(`Branch includes ticket ID: ${branchIncludeTicketId ? 'yes' : 'no'}`, colors.green);
  if (matchedBranchRule) {
    print(
      `Matched branch rule: ${matchedBranchRule.matchType}:${matchedBranchRule.match} => ${matchedBranchRule.prefix}`,
      colors.green,
    );
  } else {
    print('Matched branch rule: fallback prefix (no section rule matched)', colors.yellow);
  }
  print(`Branch candidate: ${branchCandidate}`, colors.green);
  if (gitPreparation) {
    const preparedSource = gitPreparation.reusedExistingBranch
      ? gitPreparation.branchSource === 'remote-existing'
        ? `existing remote branch ${gitPreparation.remote}/${gitPreparation.preparedBranch}`
        : 'existing local branch'
      : `${gitPreparation.remote}/${gitPreparation.baseBranch}`;
    print(`Prepared git branch: ${gitPreparation.preparedBranch} (from ${preparedSource})`, colors.green);
  }

  if (config.dispatch) {
    await dispatchAgent(config, files, context, gitPreparation);
    print('Agent dispatch completed.', colors.green);
  } else {
    print('Dispatch skipped (use --dispatch to run agent command).', colors.yellow);
  }

  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
