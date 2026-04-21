#!/usr/bin/env node
/**
 * notion reply-latest
 *
 * Adds a page comment as:
 * - reply to latest discussion when discussion_id exists
 * - fallback to top-level page comment
 */

import process from 'process';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_API_URL = 'https://api.notion.com/v1';
const DEFAULT_API_VERSION = '2022-06-28';
const DEFAULT_LOCAL_ENV_FILES = ['.notion.local', '.env.local', 'scripts/.notion.local'];
const DEFAULT_COMMENTS_LIMIT = 100;
const MAX_RICH_TEXT_SEGMENT = 1900;

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

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
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
  const keys = ['NOTION_API_TOKEN', 'NOTION_API_URL', 'NOTION_API_VERSION'];
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

  return { values, source };
}

function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}...${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
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
    fail(`Notion API request failed: ${String(message).slice(0, 300)}`);
  }

  return payload || {};
}

async function fetchLatestComment(config) {
  const data = await notionRequest(
    config,
    `/comments?block_id=${encodeURIComponent(config.pageId)}&page_size=${encodeURIComponent(
      String(config.maxComments),
    )}`,
    { method: 'GET' },
  );
  const comments = Array.isArray(data?.results) ? data.results : [];
  if (comments.length === 0) return null;

  const latest = comments
    .map((entry, index) => ({
      entry,
      index,
      timestamp: Number.isFinite(Date.parse(String(entry?.created_time || '').trim()))
        ? Date.parse(String(entry?.created_time || '').trim())
        : Number.NEGATIVE_INFINITY,
    }))
    .sort((a, b) => (b.timestamp !== a.timestamp ? b.timestamp - a.timestamp : a.index - b.index))[0]?.entry;

  return latest || null;
}

function splitTextIntoChunks(text, maxLen = MAX_RICH_TEXT_SEGMENT) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  if (!normalized) return [];
  const chunks = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    chunks.push(normalized.slice(cursor, cursor + maxLen));
    cursor += maxLen;
  }
  return chunks;
}

function buildRichTextFromBody(body) {
  const chunks = splitTextIntoChunks(body, MAX_RICH_TEXT_SEGMENT);
  if (chunks.length === 0) {
    fail('Reply body resolved to empty content.');
  }
  return chunks.map((chunk) => ({
    type: 'text',
    text: {
      content: chunk,
    },
  }));
}

async function createReplyOrComment(config, latestComment) {
  const discussionId = String(latestComment?.discussion_id || '').trim();
  const body = {
    rich_text: buildRichTextFromBody(config.body),
  };

  if (discussionId) {
    body.discussion_id = discussionId;
  } else {
    body.parent = { page_id: String(config.pageId) };
  }

  const data = await notionRequest(config, '/comments', {
    method: 'POST',
    body,
  });
  return {
    createdCommentId: String(data?.id || '').trim(),
    mode: discussionId ? 'reply-latest' : 'top-level',
    discussionId: discussionId || null,
  };
}

async function readBody(args) {
  const direct = getOptionalArg(args, 'body');
  if (direct) return direct;

  const bodyFile = getOptionalArg(args, 'body-file');
  if (bodyFile) {
    const absolutePath = path.isAbsolute(bodyFile) ? bodyFile : path.resolve(process.cwd(), bodyFile);
    const content = await fs.readFile(absolutePath, 'utf8');
    const trimmed = String(content || '').trim();
    if (!trimmed) fail(`Body file is empty: ${absolutePath}`);
    return trimmed;
  }

  fail('Missing reply body. Provide --body "<text>" or --body-file <path>.');
}

function printUsage() {
  print('');
  print('notion reply-latest', colors.cyan);
  print('');
  print('Usage:');
  print('  notion-auto reply-latest --workspace /path/to/repo --page-id <id> --body "<text>"');
  print('  notion-auto reply-latest --workspace /path/to/repo --page-id <id> --body-file ./reply.md');
  print('');
  print('Options:');
  print('  --workspace <path>');
  print('  --page-id <id> (required)');
  print('  --body "<markdown>"');
  print('  --body-file <path>');
  print(`  --max-comments <n> (default ${DEFAULT_COMMENTS_LIMIT})`);
  print('  --dry-run true|false');
  print('  --json true|false');
  print('  --env-file <path>');
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

  const loadedEnv = await loadNotionEnvValues(args);
  const token = String(process.env.NOTION_API_TOKEN || loadedEnv.values.NOTION_API_TOKEN || '').trim();
  if (!token) {
    fail(
      'NOTION_API_TOKEN is required. Set it in shell or in an ignored local env file (.notion.local, .env.local, scripts/.notion.local, or --env-file).',
    );
  }

  const config = {
    token,
    apiUrl: String(process.env.NOTION_API_URL || loadedEnv.values.NOTION_API_URL || DEFAULT_API_URL).replace(/\/$/, ''),
    apiVersion: String(
      process.env.NOTION_API_VERSION || loadedEnv.values.NOTION_API_VERSION || DEFAULT_API_VERSION,
    ).trim(),
    pageId: getRequiredArg(args, 'page-id', '--page-id'),
    body: await readBody(args),
    maxComments: parseInteger(
      getOptionalArg(args, 'max-comments', String(DEFAULT_COMMENTS_LIMIT)),
      DEFAULT_COMMENTS_LIMIT,
    ),
    dryRun: parseBoolean(getOptionalArg(args, 'dry-run', 'false'), false),
    json: parseBoolean(getOptionalArg(args, 'json', 'false'), false),
  };

  print(`workspace: ${process.cwd()}`, colors.dim);
  if (loadedEnv.source) {
    print(`notion env source: ${loadedEnv.source}`, colors.dim);
  }
  print(`notion token: ${maskSecret(config.token)} (masked)`, colors.dim);

  const latestComment = await fetchLatestComment(config);
  const parentDiscussionId = String(latestComment?.discussion_id || '').trim() || null;
  const mode = parentDiscussionId ? 'reply-latest' : 'top-level';

  if (config.dryRun) {
    const output = {
      pageId: String(config.pageId),
      mode,
      parentDiscussionId,
      createdCommentId: null,
    };
    if (config.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(output, null, 2));
    } else {
      print(`page_id=${output.pageId}`, colors.green);
      print(`parent_discussion_id=${output.parentDiscussionId || 'none'}`, colors.green);
      print(`mode=${mode}`, colors.green);
      print('dry_run=true', colors.yellow);
    }
    return 0;
  }

  const created = await createReplyOrComment(config, latestComment);
  if (!created.createdCommentId) {
    fail('Notion did not return comment id');
  }

  const output = {
    pageId: String(config.pageId),
    mode: created.mode,
    parentDiscussionId: created.discussionId,
    createdCommentId: created.createdCommentId,
  };

  if (config.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(output, null, 2));
  } else {
    print(`page_id=${output.pageId}`, colors.green);
    print(`parent_discussion_id=${output.parentDiscussionId || 'none'}`, colors.green);
    print(`new_comment_id=${output.createdCommentId}`, colors.green);
    print(`mode=${output.mode}`, colors.green);
  }

  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
