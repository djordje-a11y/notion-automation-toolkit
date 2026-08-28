#!/usr/bin/env node
/**
 * GitLab MR review helper (human-in-the-loop).
 *
 * - review: fetch MR + diff and write @notion-review-<iid>.md (same flow as ticket handoff)
 * - review-comment: post a GitLab note only after the user asks
 */

import process from 'process';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_GIT_REMOTE = 'origin';
const DEFAULT_GITLAB_API_URL = 'https://gitlab.com/api/v4';
const DEFAULT_LOCAL_ENV_FILES = ['.notion.local', '.env.local', 'scripts/.notion.local'];
const DEFAULT_REVIEW_DIR = '.notion/reviews';
const DEFAULT_REVIEW_ALIAS_FILE = 'notion-review.md';
const DEFAULT_REVIEW_STATE_FILE = '.notion/review-state.json';
const DEFAULT_ACTIVE_REVIEWS_FILE = '.notion/active-reviews.md';
const DEFAULT_RULES_FILE = path.resolve(TOOLKIT_ROOT, 'scripts/notion-review-agent-rules.md');
const DEFAULT_SKIP_OWN = true;
const MAX_DIFF_CHARS = 60_000;
const MAX_FILE_DIFF_LINES = 200;
const MAX_FILES = 30;
const MAX_EXISTING_NOTES = 15;
const SKIP_DIFF_NAME_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.map)$/i;

const DEFAULT_REVIEW_RULES = [
  'GitLab MR review rules (human-in-the-loop):',
  '- This file is read-once input for a review chat. Do not edit the review `.md`.',
  '- First explain: the problem/feature, what the MR changed, and what to pay attention to.',
  '- Then wait for the user to ask questions. Discuss before proposing comments.',
  '- Do NOT post to GitLab until the user explicitly asks.',
  '- Only comment when there is a real issue or a clearly better approach.',
  '- When asked to post: `notion-auto review-comment --mr-iid <iid> --body "<comment>"`',
  '- Optional inline: add `--path <file> --line <n>`.',
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

function resolveEnvFileCandidate(baseDir, rawPath) {
  const normalizedPath = String(rawPath || '').trim();
  if (!normalizedPath) return '';
  if (path.isAbsolute(normalizedPath)) return normalizedPath;
  return path.resolve(baseDir, normalizedPath);
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
  const candidates = uniqueNonEmpty([explicit, fromEnv, ...workspaceDefaults, ...rootDefaults]);
  const keys = [
    'GITLAB_TOKEN',
    'GITLAB_PROJECT_ID',
    'GITLAB_API_URL',
    'GITLAB_REMOTE',
    'GITLAB_REVIEW_USER_ID',
    'GITLAB_REVIEW_SKIP_OWN',
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
      if (values[key] || !parsed[key]) continue;
      values[key] = String(parsed[key] || '').trim();
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
  return payload;
}

function slugify(value, maxLen = 40) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug || 'mr';
}

function parseMrRef(rawIid, rawUrl) {
  const iidRaw = String(rawIid || '').trim();
  if (iidRaw && /^\d+$/.test(iidRaw)) {
    return { iid: Number(iidRaw), projectPath: '', url: '' };
  }
  const url = String(rawUrl || iidRaw || '').trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/(?:-\/)?merge_requests\/(\d+)/);
    if (!match) return null;
    const projectPath = parsed.pathname
      .replace(/\/-\/merge_requests\/\d+.*$/, '')
      .replace(/\/merge_requests\/\d+.*$/, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    return { iid: Number(match[1]), projectPath, url };
  } catch {
    return null;
  }
}

function shouldSkipDiffPath(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return true;
  return SKIP_DIFF_NAME_RE.test(raw);
}

function truncateDiff(diffText) {
  const lines = String(diffText || '').split(/\r?\n/);
  if (lines.length <= MAX_FILE_DIFF_LINES) return String(diffText || '');
  return `${lines.slice(0, MAX_FILE_DIFF_LINES).join('\n')}\n… (diff truncated)`;
}

async function fetchMrDiffs(config, projectRef, iid) {
  try {
    const diffs = await gitlabRequest(
      config,
      `/projects/${projectRef}/merge_requests/${iid}/diffs?per_page=100`,
    );
    return Array.isArray(diffs) ? diffs : [];
  } catch {
    const payload = await gitlabRequest(
      config,
      `/projects/${projectRef}/merge_requests/${iid}/changes`,
    );
    return Array.isArray(payload?.changes) ? payload.changes : [];
  }
}

function formatDiffs(changes) {
  const files = [];
  let used = 0;
  for (const change of Array.isArray(changes) ? changes : []) {
    const filePath = String(change?.new_path || change?.old_path || '').trim();
    if (!filePath || shouldSkipDiffPath(filePath)) continue;
    const header = change?.deleted_file
      ? `### ${filePath} (deleted)`
      : change?.new_file
        ? `### ${filePath} (new)`
        : `### ${filePath}`;
    const diff = truncateDiff(change?.diff || '');
    const block = `${header}\n\n\`\`\`diff\n${diff || '(no textual diff)'}\n\`\`\`\n`;
    if (files.length >= MAX_FILES || used + block.length > MAX_DIFF_CHARS) {
      files.push('_Additional files omitted from this handoff. Inspect the MR in GitLab if needed._');
      break;
    }
    files.push(block);
    used += block.length;
  }
  return files.length > 0 ? files.join('\n') : '_No textual diffs returned._';
}

function formatExistingNotes(notes) {
  const entries = (Array.isArray(notes) ? notes : [])
    .filter((note) => note && !note.system)
    .slice(0, MAX_EXISTING_NOTES);
  if (entries.length === 0) return '_No existing reviewer comments._';
  return entries
    .map((note) => {
      const author = String(note?.author?.username || note?.author?.name || 'unknown');
      const created = String(note?.created_at || '').trim() || 'unknown-time';
      const body = String(note?.body || '').trim().slice(0, 500) || '(empty)';
      return `- [${created}] @${author}: ${body.replace(/\s+/g, ' ')}`;
    })
    .join('\n');
}

async function readRulesText(rulesFile) {
  try {
    const text = await fs.readFile(rulesFile, 'utf8');
    return String(text || '').trim() || DEFAULT_REVIEW_RULES;
  } catch {
    return DEFAULT_REVIEW_RULES;
  }
}

function ensureTrailingNewline(text) {
  const raw = String(text || '');
  return raw.endsWith('\n') ? raw : `${raw}\n`;
}

function repoRelative(workspace, absolutePath) {
  return path.relative(workspace, absolutePath).split(path.sep).join('/');
}

function extractNotionUrl(description) {
  const text = String(description || '');
  const match = text.match(/https?:\/\/(?:www\.)?notion\.so\/[^\s)]+/i);
  return match ? match[0] : '';
}

function buildReviewHandoff({
  mr,
  iid,
  diffsText,
  notesText,
  rulesText,
  archivePath,
  aliasPath,
  workspace,
}) {
  const title = String(mr?.title || `MR !${iid}`).trim();
  const url = String(mr?.web_url || '').trim();
  const author = String(mr?.author?.username || mr?.author?.name || 'unknown').trim();
  const source = String(mr?.source_branch || '').trim();
  const target = String(mr?.target_branch || '').trim();
  const sha = String(mr?.sha || mr?.diff_refs?.head_sha || '').trim();
  const description = String(mr?.description || '').trim() || '_No MR description._';
  const notionUrl = extractNotionUrl(description);

  return [
    '# Cursor IDE Agent — GitLab MR review',
    '',
    `- **MR:** !${iid} ${title}`,
    `- **URL:** ${url || '(none)'}`,
    `- **Author:** @${author}`,
    `- **Branches:** \`${source}\` → \`${target}\``,
    `- **Head SHA:** \`${sha || '(unknown)'}\``,
    `- **This file:** \`${aliasPath}\``,
    `- **Archive:** \`${archivePath}\``,
    notionUrl ? `- **Notion ticket:** ${notionUrl}` : '- **Notion ticket:** _(not found in MR description)_',
    '',
    'Open a **new** Cursor Agent chat and attach this file (`@` it). Do not mix this review with a ticket implementation chat.',
    '',
    'HARD STOP:',
    '1) Read the MR description and diff below.',
    '2) Explain the problem/feature, what the MR changed, and what to pay attention to.',
    '3) Wait for the user. Discuss questions back and forth.',
    '4) Do not post a GitLab comment unless the user explicitly asks.',
    '',
    '---',
    '',
    '## Review rules',
    '',
    rulesText.trim(),
    '',
    '## MR description',
    '',
    description,
    '',
    '## Existing comments',
    '',
    notesText,
    '',
    '## Diff',
    '',
    diffsText,
    '',
    '## When the user asks to post a comment',
    '',
    '```bash',
    `notion-auto review-comment --workspace "${workspace}" --mr-iid ${iid} --body "<agreed comment>"`,
    '# optional inline:',
    `# notion-auto review-comment --workspace "${workspace}" --mr-iid ${iid} --path src/file.ts --line 42 --body "<agreed comment>"`,
    '```',
    '',
  ].join('\n');
}

async function readJsonFileSafe(filePath, fallbackValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

async function writeJsonFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function writeActiveReviewsIndex(rootWorkspace, state) {
  const indexPath = path.join(rootWorkspace, DEFAULT_ACTIVE_REVIEWS_FILE);
  const handoffs = state?.handoffs && typeof state.handoffs === 'object' ? state.handoffs : {};
  const rows = Object.entries(handoffs)
    .map(([iid, entry]) => ({
      iid,
      title: String(entry?.title || '').trim(),
      aliasFile: String(entry?.aliasFile || '').trim(),
      url: String(entry?.url || '').trim(),
      updatedAt: String(entry?.updatedAt || '').trim(),
    }))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const body = [
    '# Active GitLab MR reviews',
    '',
    `Updated: ${new Date().toISOString()}`,
    '',
    rows.length === 0
      ? '_No active review handoffs._'
      : '| MR | Alias | Title |',
    ...(rows.length === 0 ? [] : ['|---|---|---|']),
    ...rows.map(
      (row) =>
        `| !${row.iid} | \`${row.aliasFile || '(none)'}\` | ${row.title || row.url || ''} |`,
    ),
    '',
  ].join('\n');
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, ensureTrailingNewline(body), 'utf8');
  return indexPath;
}

function printUsage(mode) {
  print('');
  print(mode === 'comment' ? 'notion review-comment' : 'notion review', colors.cyan);
  print('');
  if (mode === 'comment') {
    print('Usage:');
    print('  notion-auto review-comment --mr-iid <id> --body "<comment>"');
    print('');
    print('Options:');
    print('  --workspace <path>');
    print('  --mr-iid <id> | --mr-url <url>');
    print('  --body "<markdown comment>"');
    print('  --path <file> --line <n>   (inline discussion when possible)');
    print('  --dry-run true|false');
    print('');
  } else {
    print('Usage:');
    print('  notion-auto review --mr-iid <id>');
    print('  notion-auto review --mr-url https://gitlab.com/group/proj/-/merge_requests/42');
    print('');
    print('Writes a review handoff. Open a new Cursor chat and attach @notion-review-<iid>.md');
    print('Do not post GitLab comments until the user asks (then use review-comment).');
    print('');
    print('Options:');
    print('  --workspace <path>');
    print('  --mr-iid <id>');
    print('  --mr-url <url>');
    print('  --force true|false');
    print('  --dry-run true|false');
    print('');
  }
}

async function resolveProjectRef(config, remoteUrl, urlProjectPath) {
  if (urlProjectPath) return encodeURIComponent(urlProjectPath);
  if (config.gitlabProjectId) return config.gitlabProjectId;
  const inferred = parseGitlabProjectPath(remoteUrl);
  if (!inferred) fail('Could not infer GitLab project. Set GITLAB_PROJECT_ID or pass --mr-url.');
  return encodeURIComponent(inferred);
}

async function postReviewComment(config, projectRef, iid, { body, filePath, line, dryRun }) {
  const text = String(body || '').trim();
  if (!text) fail('Comment body is required (--body).');
  const lower = text.toLowerCase();
  if (/^(lgtm|looks good|nice work|approved?)\b/.test(lower) && text.length < 40) {
    fail('Refusing to post an approval-only comment. Write a specific finding or skip.');
  }

  if (dryRun) {
    print(`[dry-run] would post on !${iid}${filePath ? ` ${filePath}:${line || ''}` : ''}:`, colors.yellow);
    print(text, colors.dim);
    return { posted: false, dryRun: true };
  }

  const mr = await gitlabRequest(config, `/projects/${projectRef}/merge_requests/${iid}`);
  const diffRefs = mr?.diff_refs || {};
  if (filePath && Number(line) > 0 && diffRefs.base_sha && diffRefs.head_sha) {
    try {
      const created = await gitlabRequest(
        config,
        `/projects/${projectRef}/merge_requests/${iid}/discussions`,
        {
          method: 'POST',
          body: {
            body: text,
            position: {
              base_sha: diffRefs.base_sha,
              start_sha: diffRefs.start_sha || diffRefs.base_sha,
              head_sha: diffRefs.head_sha,
              old_path: filePath,
              new_path: filePath,
              position_type: 'text',
              new_line: Number(line),
            },
          },
        },
      );
      return { posted: true, inline: true, url: created?.notes?.[0]?.web_url || mr.web_url };
    } catch (error) {
      print(`Inline comment failed (${error?.message || error}); posting a general note.`, colors.yellow);
    }
  }

  const prefixed = filePath ? `\`${filePath}\`${line ? `:${line}` : ''}\n\n${text}` : text;
  const note = await gitlabRequest(config, `/projects/${projectRef}/merge_requests/${iid}/notes`, {
    method: 'POST',
    body: { body: prefixed },
  });
  return { posted: true, inline: false, url: note?.web_url || mr.web_url };
}

async function writeReviewHandoff(config, projectRef, iid) {
  const mr = await gitlabRequest(config, `/projects/${projectRef}/merge_requests/${iid}`);
  if (mr?.draft || mr?.work_in_progress) {
    fail(`MR !${iid} is a draft. Mark it ready before writing a review handoff.`);
  }
  if (config.skipOwn && config.reviewerUserId && Number(mr?.author?.id) === Number(config.reviewerUserId)) {
    fail(`Skipping own MR !${iid} (set GITLAB_REVIEW_SKIP_OWN=false to override).`);
  }

  const [changes, notes, rulesText] = await Promise.all([
    fetchMrDiffs(config, projectRef, iid),
    gitlabRequest(
      config,
      `/projects/${projectRef}/merge_requests/${iid}/notes?sort=asc&per_page=50`,
    ).catch(() => []),
    readRulesText(config.rulesFile),
  ]);

  const title = String(mr?.title || `MR !${iid}`).trim();
  const slug = slugify(title);
  const reviewDir = path.join(config.rootWorkspace, DEFAULT_REVIEW_DIR);
  await fs.mkdir(reviewDir, { recursive: true });
  const archivePath = path.join(reviewDir, `${iid}-${slug}.review.md`);
  const aliasName = `notion-review-${iid}.md`;
  const aliasPath = path.join(config.rootWorkspace, aliasName);
  const stableAliasPath = path.join(config.rootWorkspace, DEFAULT_REVIEW_ALIAS_FILE);

  const body = buildReviewHandoff({
    mr,
    iid,
    diffsText: formatDiffs(changes),
    notesText: formatExistingNotes(notes),
    rulesText,
    archivePath: repoRelative(config.rootWorkspace, archivePath),
    aliasPath: aliasName,
    workspace: config.rootWorkspace,
  });

  if (config.dryRun) {
    print(`[dry-run] would write ${aliasName}`, colors.yellow);
    print(`[dry-run] archive ${repoRelative(config.rootWorkspace, archivePath)}`, colors.dim);
    return {
      dryRun: true,
      iid,
      title,
      url: String(mr?.web_url || ''),
      aliasFile: aliasName,
      aliasPath,
      archivePath,
    };
  }

  await fs.writeFile(archivePath, ensureTrailingNewline(body), 'utf8');
  await fs.writeFile(aliasPath, ensureTrailingNewline(body), 'utf8');
  await fs.writeFile(stableAliasPath, ensureTrailingNewline(body), 'utf8');

  const statePath = path.join(config.rootWorkspace, DEFAULT_REVIEW_STATE_FILE);
  const state = await readJsonFileSafe(statePath, { knownMrIids: [], handoffs: {} });
  const known = new Set((state.knownMrIids || []).map((value) => String(value)));
  known.add(String(iid));
  const handoffs = state.handoffs && typeof state.handoffs === 'object' ? state.handoffs : {};
  handoffs[String(iid)] = {
    title,
    url: String(mr?.web_url || ''),
    aliasFile: aliasName,
    archivePath: repoRelative(config.rootWorkspace, archivePath),
    updatedAt: new Date().toISOString(),
  };
  const nextState = {
    ...state,
    knownMrIids: [...known],
    handoffs,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(statePath, nextState);
  await writeActiveReviewsIndex(config.rootWorkspace, nextState);

  return {
    dryRun: false,
    iid,
    title,
    url: String(mr?.web_url || ''),
    aliasFile: aliasName,
    aliasPath,
    archivePath,
    stableAliasPath,
  };
}

async function resolveGitlabConfig(args, workspace) {
  try {
    process.chdir(workspace);
  } catch {
    fail(`Workspace path is not accessible: ${workspace}`);
  }
  const rootWorkspace = await resolveRootWorkspaceFromGitOrCwd(process.cwd());
  const loadedEnv = await loadLocalEnvValues(args, process.cwd(), rootWorkspace);
  const remote = getOptionalArg(
    args,
    'remote',
    process.env.GITLAB_REMOTE ||
      loadedEnv.values.GITLAB_REMOTE ||
      process.env.NOTION_AGENT_GIT_REMOTE ||
      loadedEnv.values.NOTION_AGENT_GIT_REMOTE ||
      DEFAULT_GIT_REMOTE,
  );
  let remoteUrl = '';
  try {
    const result = await runCommandCapture('git', ['remote', 'get-url', remote], {
      cwd: rootWorkspace,
    });
    remoteUrl = String(result.stdout || '').trim();
  } catch {
    remoteUrl = '';
  }

  const gitlabToken = String(process.env.GITLAB_TOKEN || loadedEnv.values.GITLAB_TOKEN || '').trim();
  if (!gitlabToken) fail('GITLAB_TOKEN is required for MR review.');

  return {
    workspace: process.cwd(),
    rootWorkspace,
    envSource: loadedEnv.source,
    remote,
    gitlabToken,
    gitlabProjectId: String(
      process.env.GITLAB_PROJECT_ID || loadedEnv.values.GITLAB_PROJECT_ID || '',
    ).trim(),
    gitlabApiUrl: String(
      process.env.GITLAB_API_URL || loadedEnv.values.GITLAB_API_URL || inferGitlabApiUrl(remoteUrl),
    ).trim() || inferGitlabApiUrl(remoteUrl),
    reviewerUserId: Number(
      getOptionalArg(args, 'review-user-id', process.env.GITLAB_REVIEW_USER_ID || loadedEnv.values.GITLAB_REVIEW_USER_ID || ''),
    ) || 0,
    skipOwn: parseBoolean(
      getOptionalArg(
        args,
        'skip-own',
        process.env.GITLAB_REVIEW_SKIP_OWN || loadedEnv.values.GITLAB_REVIEW_SKIP_OWN || String(DEFAULT_SKIP_OWN),
      ),
      DEFAULT_SKIP_OWN,
    ),
    rulesFile: getOptionalArg(args, 'rules-file', DEFAULT_RULES_FILE),
    dryRun: parseBoolean(getOptionalArg(args, 'dry-run', 'false'), false),
    force: parseBoolean(getOptionalArg(args, 'force', 'false'), false),
    remoteUrl,
  };
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const postComment = Boolean(args['post-comment'] || args._[0] === 'comment');
  if (args.help || args.h) {
    printUsage(postComment ? 'comment' : 'review');
    return 0;
  }

  const workspace = resolveWorkspaceFromArgv(
    argv,
    process.env.NOTION_TOOLKIT_WORKSPACE || process.env.NOTION_WORKSPACE || '',
  );
  const config = await resolveGitlabConfig(args, workspace);
  const mrRef = parseMrRef(getOptionalArg(args, 'mr-iid'), getOptionalArg(args, 'mr-url'));
  if (!mrRef?.iid) fail('Provide --mr-iid <id> or --mr-url <merge request url>.');

  const projectRef = await resolveProjectRef(config, config.remoteUrl, mrRef.projectPath);
  if (config.envSource) print(`env source: ${config.envSource}`, colors.dim);

  if (postComment) {
    const result = await postReviewComment(config, projectRef, mrRef.iid, {
      body: getOptionalArg(args, 'body'),
      filePath: getOptionalArg(args, 'path'),
      line: getOptionalArg(args, 'line'),
      dryRun: config.dryRun,
    });
    if (result.dryRun) return 0;
    print(`Comment posted on !${mrRef.iid}${result.inline ? ' (inline)' : ''}`, colors.green);
    if (result.url) print(result.url, colors.dim);
    return 0;
  }

  const files = await writeReviewHandoff(config, projectRef, mrRef.iid);
  print(`MR !${files.iid}: ${files.title}`, colors.green);
  if (files.url) print(files.url, colors.dim);
  if (!files.dryRun) {
    print(`Review handoff (@ this file in a new Cursor chat): ${files.aliasFile}`, colors.green);
    print(`Stable alias: ${DEFAULT_REVIEW_ALIAS_FILE}`, colors.dim);
    print('Do not post GitLab comments until the user asks. Then use notion-auto review-comment.', colors.yellow);
  }
  return 0;
}

main().catch((error) => {
  print(`Error: ${error?.message || String(error)}`, colors.red);
  process.exit(1);
});
