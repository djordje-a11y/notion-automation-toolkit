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
import { DEFAULT_WORKTREE_DIR, resolveWorktreeDir } from './notion-ide-worktree-config.js';

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
const DEFAULT_BRANCH_PREFIX = 'fix';
const DEFAULT_BRANCH_PREFIX_RULES = 'bugs=fix,epics backlog=feat';
const DEFAULT_BRANCH_INCLUDE_TICKET_ID = false;
const DEFAULT_GIT_PREPARE_BRANCH = true;
const DEFAULT_GIT_BASE_BRANCH = 'dev';
const DEFAULT_GIT_REMOTE = 'origin';
const DEFAULT_GIT_REQUIRE_CLEAN_WORKTREE = true;
const DEFAULT_AGENT_CREATE_CHAT = false;
const DEFAULT_AGENT_CREATE_CHAT_COMMAND = '$HOME/.local/bin/cursor-agent create-chat';
const DEFAULT_AGENT_MODEL = 'composer-2.5';
const DEFAULT_AGENT_CREATE_CHAT_TIMEOUT_MS = 15000;
const DEFAULT_AGENT_UNSET_CURSOR_API_KEY = true;
const DEFAULT_AGENT_HEADLESS_PRINT = true;
const DEFAULT_IDE_HANDOFF = true;
const DEFAULT_LOCAL_ENV_FILES = ['.notion.local', '.env.local', 'scripts/.notion.local'];
const DEFAULT_SECTION_PROPERTY = 'Type';
const DEFAULT_DOWNLOAD_ATTACHMENTS = true;
const DEFAULT_ATTACHMENTS_MAX = 20;
const DEFAULT_WORKTREE_MODE = false;
const DEFAULT_WORKTREE_MAP_FILE = '.notion/worktree-map.json';
const DEFAULT_ACTIVE_TICKETS_FILE = '.notion/active-tickets.md';
const DEFAULT_WORKTREE_SHORTCUTS_DIR = '.notion/w';
const DEFAULT_PUBLISH_ROOT_HANDOFF_ALIAS = true;
const DEFAULT_HANDOFF_ALIAS_WORDS = 3;
const DEFAULT_HANDOFF_ALIAS_MAP_FILE = '.notion/handoff-alias-map.json';
const DEFAULT_ACTIVE_HANDOFFS_FILE = '.notion/active-handoffs.md';
const DEFAULT_SPRINT_ASSIGN_ON_INTAKE = true;
const DEFAULT_SPRINT_PROPERTY = 'Sprint';
const DEFAULT_SUBITEM_PROPERTY = 'Sub-item';
const DEFAULT_SPRINT_CASCADE_SUBITEMS = true;

const DEFAULT_RULES = [
  'Ticket intake rules:',
  '- Investigate root cause first. Do not propose symptom-only workarounds.',
  '- Preserve security constraints and account isolation (no access widening fixes).',
  '- Keep scope minimal and explicit; call out behavior changes separately.',
  '- Include deterministic validation plan (targeted tests first, then confidence checks).',
  '- After reading the handoff `.md` and confirming the prepared branch, rename chat to the branch name without configured prefix.',
  '- NEVER modify or update the handoff `.md` file. It is read-once input, not a living document.',
  '- Output must include: ticket understanding, proposed branch name, solution approach, risks/blockers.',
  '',
  'Sprint / backlog rules (mandatory):',
  '- New tickets stay in backlog while Sprint is empty. Starting work means assigning the current Sprint so the item leaves backlog.',
  '- Intake assigns Sprint on the triggered ticket and cascades the same Sprint to Sub-item pages when those are still empty.',
  '- If you manually put a parent into a sprint, also set Sprint on all Sub-items (sub-tasks remain in backlog otherwise).',
  '- Do not leave started work with an empty Sprint property.',
  '',
  'Testing rules (CRITICAL — violating these will crash the machine):',
  '- NEVER run the full test suite (`npm test`, `npm run test:unit`, etc.). Only run specific test files related to your changes.',
  '- Always use `--maxWorkers=2` (or lower) when running Jest/Vitest. Example: `npx jest --maxWorkers=2 path/to/test.spec.ts`.',
  '- Do NOT run tests in parallel across multiple terminals or background processes.',
  '- Run tests only when explicitly needed to validate your specific change, not speculatively.',
  '- If a test run is taking too long or consuming too much memory, kill it immediately.',
  '',
  'Completion and handoff rules (mandatory when user asks to commit):',
  '- Do not hardcode personal names/emails in shared rules or ticket comments.',
  '- Use custom signing/author commit command only when user explicitly asks for it.',
  '- If user does not explicitly request custom signing/author, use normal commit flow (`git commit -m "<message>"`).',
  '- Write a meaningful commit message: fix|feat|chore subject + user-visible outcome + why (avoid vague messages). These messages become the GitLab MR Solution section.',
  '- When user says task is done: commit changes with a meaningful message, then run `notion-auto done` to push, create MR, and enable auto-merge.',
  '- Do NOT post comments to Notion or update ticket status unless the user explicitly asks.',
  '',
  'Model usage (token cost control):',
  '- Use your selected premium model ONLY for ticket understanding, solution design, code edits, and debugging.',
  '- For auxiliary work, delegate to a fast/cheap subagent (model: composer-2.5 or auto):',
  '  - Notion MCP reads, comment lookups, and status/property updates',
  '  - Running `notion-auto reply-latest`, `notion-auto done`, or other toolkit CLI without code changes',
  '  - GitLab MR/pipeline status checks (not merge-conflict resolution)',
  '- Do NOT use premium thinking models for repetitive Notion/GitLab fetches.',
  '',
  'Branching and merge conflict rules (CRITICAL):',
  '- NEVER push directly to `dev`, `acceptance`, or `main`. These are protected branches. All changes go through MRs only.',
  '- Never commit on `dev`, `acceptance`, or `main`. Checkout `dev`, pull latest, then create your feature branch from there.',
  '- Branches are created from `dev`: checkout `dev`, pull latest, then create the feature branch.',
  '- MRs target `dev`. If the MR has merge conflicts with `dev`, do NOT merge/rebase `dev` into the fix branch.',
  '- Instead: create a temporary merge branch (e.g. `merge/<original-branch>-to-dev`), merge both the fix branch and `dev` into it, resolve conflicts there, push the merge branch to `dev`, and leave the original fix branch untouched.',
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
    'NOTION_STATUS_PROPERTY',
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
    'NOTION_AGENT_MODEL',
    'NOTION_AGENT_UNSET_CURSOR_API_KEY',
    'NOTION_AGENT_HEADLESS_PRINT',
    'NOTION_AGENT_IDE_HANDOFF',
    'NOTION_AGENT_SECTION_PROPERTY',
    'NOTION_AGENT_DOWNLOAD_ATTACHMENTS',
    'NOTION_AGENT_ATTACHMENTS_MAX',
    'NOTION_AGENT_WORKTREE_MODE',
    'NOTION_AGENT_IDE',
    'NOTION_AGENT_WORKTREE_DIR',
    'NOTION_AGENT_WORKTREE_DIR_BY_IDE',
    'NOTION_AGENT_WORKTREE_MAP_FILE',
    'NOTION_AGENT_ACTIVE_TICKETS_FILE',
    'NOTION_AGENT_WORKTREE_SHORTCUTS_DIR',
    'NOTION_ROOT_WORKSPACE',
    'NOTION_AGENT_PUBLISH_ROOT_HANDOFF_ALIAS',
    'NOTION_AGENT_HANDOFF_ALIAS_WORDS',
    'NOTION_AGENT_HANDOFF_ALIAS_MAP_FILE',
    'NOTION_AGENT_ACTIVE_HANDOFFS_FILE',
    'NOTION_DATABASE_ID',
    'NOTION_DATA_SOURCE_ID',
    'NOTION_SPRINT_ASSIGN_ON_INTAKE',
    'NOTION_SPRINT_PROPERTY',
    'NOTION_CURRENT_SPRINT',
    'NOTION_SUBITEM_PROPERTY',
    'NOTION_SPRINT_CASCADE_SUBITEMS',
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

  const rootWorkspace = getOptionalArg(
    args,
    'root-workspace',
    process.env.NOTION_ROOT_WORKSPACE || envValues.NOTION_ROOT_WORKSPACE || process.cwd(),
  );
  const ide = getOptionalArg(
    args,
    'ide',
    process.env.NOTION_AGENT_IDE || envValues.NOTION_AGENT_IDE || '',
  );
  const worktreeDirResolution = resolveWorktreeDir({
    workspacePath: rootWorkspace,
    ide,
    explicitWorktreeDir:
      process.env.NOTION_AGENT_WORKTREE_DIR ||
      envValues.NOTION_AGENT_WORKTREE_DIR ||
      getOptionalArg(args, 'worktree-dir', ''),
    worktreeDirByIde:
      process.env.NOTION_AGENT_WORKTREE_DIR_BY_IDE ||
      envValues.NOTION_AGENT_WORKTREE_DIR_BY_IDE ||
      getOptionalArg(args, 'worktree-dir-by-ide', ''),
  });

  return {
    rootWorkspace,
    token,
    apiUrl: String(process.env.NOTION_API_URL || envValues.NOTION_API_URL || DEFAULT_API_URL).replace(/\/$/, ''),
    apiVersion: String(process.env.NOTION_API_VERSION || envValues.NOTION_API_VERSION || DEFAULT_API_VERSION).trim(),
    envFile: resolveEnvFileCandidate(getOptionalArg(args, 'env-file')),
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
    agentModel: resolveAgentModel(
      getOptionalArg(
        args,
        'agent-model',
        process.env.NOTION_AGENT_MODEL ||
          envValues.NOTION_AGENT_MODEL ||
          DEFAULT_AGENT_MODEL,
      ),
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
    downloadAttachments: parseBoolean(
      getOptionalArg(
        args,
        'download-attachments',
        process.env.NOTION_AGENT_DOWNLOAD_ATTACHMENTS ||
          envValues.NOTION_AGENT_DOWNLOAD_ATTACHMENTS ||
          String(DEFAULT_DOWNLOAD_ATTACHMENTS),
      ),
      DEFAULT_DOWNLOAD_ATTACHMENTS,
    ),
    attachmentsMax: parseInteger(
      getOptionalArg(
        args,
        'attachments-max',
        process.env.NOTION_AGENT_ATTACHMENTS_MAX ||
          envValues.NOTION_AGENT_ATTACHMENTS_MAX ||
          String(DEFAULT_ATTACHMENTS_MAX),
      ),
      DEFAULT_ATTACHMENTS_MAX,
    ),
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
    worktreeResolved: parseBoolean(
      getOptionalArg(
        args,
        'worktree-resolved',
        process.env.NOTION_AGENT_WORKTREE_RESOLVED || 'false',
      ),
      false,
    ),
    ide: worktreeDirResolution.ide,
    worktreeDir: worktreeDirResolution.worktreeDir,
    worktreeDirSource: worktreeDirResolution.source,
    worktreeDirByIde: getOptionalArg(
      args,
      'worktree-dir-by-ide',
      process.env.NOTION_AGENT_WORKTREE_DIR_BY_IDE || envValues.NOTION_AGENT_WORKTREE_DIR_BY_IDE || '',
    ),
    worktreeMapFile: getOptionalArg(
      args,
      'worktree-map-file',
      process.env.NOTION_AGENT_WORKTREE_MAP_FILE ||
        envValues.NOTION_AGENT_WORKTREE_MAP_FILE ||
        DEFAULT_WORKTREE_MAP_FILE,
    ),
    activeTicketsFile: getOptionalArg(
      args,
      'active-tickets-file',
      process.env.NOTION_AGENT_ACTIVE_TICKETS_FILE ||
        envValues.NOTION_AGENT_ACTIVE_TICKETS_FILE ||
        DEFAULT_ACTIVE_TICKETS_FILE,
    ),
    worktreeShortcutsDir: getOptionalArg(
      args,
      'worktree-shortcuts-dir',
      process.env.NOTION_AGENT_WORKTREE_SHORTCUTS_DIR ||
        envValues.NOTION_AGENT_WORKTREE_SHORTCUTS_DIR ||
        DEFAULT_WORKTREE_SHORTCUTS_DIR,
    ),
    publishRootHandoffAlias: parseBoolean(
      getOptionalArg(
        args,
        'publish-root-handoff-alias',
        process.env.NOTION_AGENT_PUBLISH_ROOT_HANDOFF_ALIAS ||
          envValues.NOTION_AGENT_PUBLISH_ROOT_HANDOFF_ALIAS ||
          String(DEFAULT_PUBLISH_ROOT_HANDOFF_ALIAS),
      ),
      DEFAULT_PUBLISH_ROOT_HANDOFF_ALIAS,
    ),
    handoffAliasWords: parseInteger(
      getOptionalArg(
        args,
        'handoff-alias-words',
        process.env.NOTION_AGENT_HANDOFF_ALIAS_WORDS ||
          envValues.NOTION_AGENT_HANDOFF_ALIAS_WORDS ||
          String(DEFAULT_HANDOFF_ALIAS_WORDS),
      ),
      DEFAULT_HANDOFF_ALIAS_WORDS,
    ),
    handoffAliasMapFile: getOptionalArg(
      args,
      'handoff-alias-map-file',
      process.env.NOTION_AGENT_HANDOFF_ALIAS_MAP_FILE ||
        envValues.NOTION_AGENT_HANDOFF_ALIAS_MAP_FILE ||
        DEFAULT_HANDOFF_ALIAS_MAP_FILE,
    ),
    activeHandoffsFile: getOptionalArg(
      args,
      'active-handoffs-file',
      process.env.NOTION_AGENT_ACTIVE_HANDOFFS_FILE ||
        envValues.NOTION_AGENT_ACTIVE_HANDOFFS_FILE ||
        DEFAULT_ACTIVE_HANDOFFS_FILE,
    ),
    statusPropertyName: String(
      process.env.NOTION_STATUS_PROPERTY || envValues.NOTION_STATUS_PROPERTY || 'Status',
    ).trim(),
    sectionPropertyName: String(
      process.env.NOTION_AGENT_SECTION_PROPERTY ||
        envValues.NOTION_AGENT_SECTION_PROPERTY ||
        getOptionalArg(args, 'section-property', DEFAULT_SECTION_PROPERTY),
    ).trim(),
    databaseId: String(
      process.env.NOTION_DATABASE_ID || envValues.NOTION_DATABASE_ID || '',
    ).trim(),
    dataSourceId: String(
      process.env.NOTION_DATA_SOURCE_ID || envValues.NOTION_DATA_SOURCE_ID || '',
    ).trim(),
    sprintAssignOnIntake: parseBoolean(
      getOptionalArg(
        args,
        'sprint-assign-on-intake',
        process.env.NOTION_SPRINT_ASSIGN_ON_INTAKE ||
          envValues.NOTION_SPRINT_ASSIGN_ON_INTAKE ||
          String(DEFAULT_SPRINT_ASSIGN_ON_INTAKE),
      ),
      DEFAULT_SPRINT_ASSIGN_ON_INTAKE,
    ),
    sprintPropertyName: String(
      getOptionalArg(
        args,
        'sprint-property',
        process.env.NOTION_SPRINT_PROPERTY ||
          envValues.NOTION_SPRINT_PROPERTY ||
          DEFAULT_SPRINT_PROPERTY,
      ),
    ).trim() || DEFAULT_SPRINT_PROPERTY,
    currentSprint: String(
      getOptionalArg(
        args,
        'current-sprint',
        process.env.NOTION_CURRENT_SPRINT || envValues.NOTION_CURRENT_SPRINT || '',
      ),
    ).trim(),
    subitemPropertyName: String(
      getOptionalArg(
        args,
        'subitem-property',
        process.env.NOTION_SUBITEM_PROPERTY ||
          envValues.NOTION_SUBITEM_PROPERTY ||
          DEFAULT_SUBITEM_PROPERTY,
      ),
    ).trim() || DEFAULT_SUBITEM_PROPERTY,
    sprintCascadeSubitems: parseBoolean(
      getOptionalArg(
        args,
        'sprint-cascade-subitems',
        process.env.NOTION_SPRINT_CASCADE_SUBITEMS ||
          envValues.NOTION_SPRINT_CASCADE_SUBITEMS ||
          String(DEFAULT_SPRINT_CASCADE_SUBITEMS),
      ),
      DEFAULT_SPRINT_CASCADE_SUBITEMS,
    ),
  };
}

function resolveAgentModel(raw) {
  const trimmed = String(raw ?? DEFAULT_AGENT_MODEL).trim();
  if (!trimmed) return '';
  if (/^(false|off|none|inherit|default|skip)$/i.test(trimmed)) return '';
  return trimmed;
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

function resolveStatusText(page, statusPropertyName = 'Status') {
  const explicit = findPropertyByName(page, statusPropertyName);
  const explicitText = propertyValueToText(explicit);
  if (explicitText) return explicitText;
  const statusLike = findPropertyByType(page, 'status') || findPropertyByType(page, 'select');
  return propertyValueToText(statusLike);
}

function getIsoWeekNumber(date = new Date()) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
}

function getRelationIds(property) {
  if (!property || typeof property !== 'object') return [];
  if (String(property.type || '').trim() !== 'relation') return [];
  return (Array.isArray(property.relation) ? property.relation : [])
    .map((entry) => String(entry?.id || '').trim())
    .filter(Boolean);
}

function getMultiSelectNames(property) {
  if (!property || typeof property !== 'object') return [];
  const type = String(property.type || '').trim();
  if (type === 'multi_select') {
    return (Array.isArray(property.multi_select) ? property.multi_select : [])
      .map((entry) => String(entry?.name || '').trim())
      .filter(Boolean);
  }
  if (type === 'select') {
    const name = String(property.select?.name || '').trim();
    return name ? [name] : [];
  }
  return [];
}

function pickSprintOptionForWeek(optionNames, weekNumber) {
  const options = (Array.isArray(optionNames) ? optionNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  if (options.length === 0) return '';

  const exact = options.find((name) => {
    const match = name.match(/^sprint\s*week\s*(\d+)$/i);
    return match && Number.parseInt(match[1], 10) === weekNumber;
  });
  if (exact) return exact;

  const ranges = options
    .map((name) => {
      const match = name.match(/^sprint\s*week\s*(\d+)\s*\+\s*(\d+)$/i);
      if (!match) return null;
      const start = Number.parseInt(match[1], 10);
      const end = Number.parseInt(match[2], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      if (weekNumber < Math.min(start, end) || weekNumber > Math.max(start, end)) return null;
      return { name, span: Math.abs(end - start) };
    })
    .filter(Boolean)
    .sort((left, right) => left.span - right.span);
  if (ranges.length > 0) return ranges[0].name;

  const containsWeek = options.find((name) => {
    const numbers = [...String(name).matchAll(/\d+/g)].map((entry) => Number.parseInt(entry[0], 10));
    return numbers.includes(weekNumber);
  });
  return containsWeek || '';
}

function extractSelectOptionNames(propertySchema) {
  if (!propertySchema || typeof propertySchema !== 'object') return [];
  const type = String(propertySchema.type || '').trim();
  if (type === 'multi_select') {
    return (propertySchema.multi_select?.options || [])
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

async function listSprintOptionNames(config, page) {
  const sprintPropertyName = config.sprintPropertyName;
  const ids = uniqueNonEmpty([
    config.dataSourceId,
    config.databaseId,
    page?.parent?.data_source_id,
    page?.parent?.database_id,
  ]);

  for (const id of ids) {
    for (const endpoint of [`/data_sources/${id}`, `/databases/${id}`]) {
      try {
        const schema = await notionRequest(config, endpoint, { method: 'GET' });
        const propertySchema = schema?.properties?.[sprintPropertyName];
        const options = extractSelectOptionNames(propertySchema);
        if (options.length > 0) return options;
      } catch {
        // try next endpoint/id
      }
    }
  }
  return [];
}

async function resolveCurrentSprintName(config, page) {
  const configured = String(config.currentSprint || '').trim();
  if (configured && !['auto', 'detect', 'current'].includes(normalize(configured))) {
    return { sprintName: configured, source: 'config' };
  }

  const weekNumber = getIsoWeekNumber(new Date());
  const options = await listSprintOptionNames(config, page);
  const matched = pickSprintOptionForWeek(options, weekNumber);
  if (matched) {
    return { sprintName: matched, source: `iso-week-${weekNumber}` };
  }

  return {
    sprintName: '',
    source: 'unresolved',
    reason: `Could not resolve current sprint for ISO week ${weekNumber}. Set NOTION_CURRENT_SPRINT.`,
  };
}

function buildSprintPropertyPayload(propertyType, sprintName) {
  const type = String(propertyType || '').trim();
  if (type === 'multi_select') {
    return { multi_select: [{ name: sprintName }] };
  }
  if (type === 'select') {
    return { select: { name: sprintName } };
  }
  return null;
}

async function setPageSprintIfEmpty(config, pageId, sprintName, { force = false } = {}) {
  const page = await notionRequest(config, `/pages/${encodeURIComponent(pageId)}`, {
    method: 'GET',
  });
  const property = findPropertyByName(page, config.sprintPropertyName);
  if (!property) {
    return {
      pageId,
      updated: false,
      reason: `property "${config.sprintPropertyName}" not found`,
      page,
    };
  }

  const existing = getMultiSelectNames(property);
  if (!force && existing.length > 0) {
    return {
      pageId,
      updated: false,
      reason: existing.includes(sprintName) ? 'already set' : `already set (${existing.join(', ')})`,
      page,
    };
  }

  const payload = buildSprintPropertyPayload(property.type, sprintName);
  if (!payload) {
    return {
      pageId,
      updated: false,
      reason: `unsupported sprint property type "${property.type}"`,
      page,
    };
  }

  const updatedPage = await notionRequest(config, `/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    body: {
      properties: {
        [config.sprintPropertyName]: payload,
      },
    },
  });

  return {
    pageId,
    updated: true,
    reason: 'updated',
    page: updatedPage && updatedPage.properties ? updatedPage : page,
  };
}

async function assignSprintOnIntake(config, page) {
  if (!config.sprintAssignOnIntake) {
    return { attempted: false, reason: 'disabled', page };
  }

  const sprintProperty = findPropertyByName(page, config.sprintPropertyName);
  if (!sprintProperty) {
    return {
      attempted: false,
      reason: `sprint property "${config.sprintPropertyName}" not found on page`,
      page,
    };
  }

  const resolved = await resolveCurrentSprintName(config, page);
  if (!resolved.sprintName) {
    return {
      attempted: true,
      updated: false,
      reason: resolved.reason || 'current sprint unresolved',
      page,
    };
  }

  const rootResult = await setPageSprintIfEmpty(config, config.pageId, resolved.sprintName);
  const workingPage = rootResult.page || page;
  if (workingPage?.properties) {
    page.properties = workingPage.properties;
  }
  const subitemResults = [];

  if (config.sprintCascadeSubitems) {
    const subitemIds = getRelationIds(findPropertyByName(page, config.subitemPropertyName));
    for (const subitemId of subitemIds) {
      try {
        const result = await setPageSprintIfEmpty(config, subitemId, resolved.sprintName);
        subitemResults.push({
          pageId: subitemId,
          updated: result.updated,
          reason: result.reason,
        });
      } catch (error) {
        subitemResults.push({
          pageId: subitemId,
          updated: false,
          reason: String(error?.message || error || 'update failed'),
        });
      }
    }
  }

  return {
    attempted: true,
    sprintName: resolved.sprintName,
    source: resolved.source,
    updated: Boolean(rootResult.updated),
    reason: rootResult.reason,
    subitems: subitemResults,
    page,
  };
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

function buildAssetRecord({
  source,
  blockId = '',
  propertyName = '',
  kind = 'file',
  name = '',
  url = '',
  expiryTime = '',
}) {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) return null;
  return {
    source: String(source || ''),
    blockId: String(blockId || ''),
    propertyName: String(propertyName || ''),
    kind: String(kind || 'file'),
    name: String(name || '').trim() || String(kind || 'file'),
    url: normalizedUrl,
    expiryTime: String(expiryTime || '').trim(),
    localPath: '',
    downloadError: '',
  };
}

function extractAssetFromPayload({ source, blockId = '', propertyName = '', blockType = '', payload }) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const externalUrl = String(p?.external?.url || '').trim();
  const fileUrl = String(p?.file?.url || '').trim();
  const expiry = String(p?.file?.expiry_time || '').trim();
  const directUrl = String(p?.url || '').trim();
  const rawName = String(p?.name || plainTextFromRichText(p?.caption) || blockType || 'asset').trim();
  return buildAssetRecord({
    source,
    blockId,
    propertyName,
    kind: blockType || p?.type || 'file',
    name: rawName,
    url: externalUrl || fileUrl || directUrl,
    expiryTime: expiry,
  });
}

function extractFilesFromBlock(block) {
  if (!block || typeof block !== 'object') return [];
  const type = String(block.type || '').trim();
  if (!type) return [];
  const payload = block[type];
  const extractableTypes = new Set([
    'file',
    'image',
    'video',
    'pdf',
    'audio',
    'bookmark',
    'embed',
    'link_preview',
  ]);
  if (!extractableTypes.has(type) || !payload || typeof payload !== 'object') return [];
  const asset = extractAssetFromPayload({
    source: 'block',
    blockId: String(block.id || ''),
    blockType: type,
    payload,
  });
  return asset ? [asset] : [];
}

function extractFilesFromProperties(page) {
  const source = page?.properties && typeof page.properties === 'object' ? page.properties : {};
  const files = [];
  for (const [propertyName, property] of Object.entries(source)) {
    if (String(property?.type || '').trim() !== 'files') continue;
    const entries = Array.isArray(property?.files) ? property.files : [];
    for (const entry of entries) {
      const asset = extractAssetFromPayload({
        source: 'property',
        propertyName,
        blockType: String(entry?.type || 'file'),
        payload: entry,
      });
      if (!asset) continue;
      files.push(asset);
    }
  }
  return files;
}

function dedupeAssets(assets) {
  const out = [];
  const seen = new Set();
  for (const asset of Array.isArray(assets) ? assets : []) {
    const url = String(asset?.url || '').trim();
    if (!url) continue;
    const key = `${url}|${String(asset?.name || '').trim()}|${String(asset?.source || '').trim()}|${String(asset?.propertyName || '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
}

function normalizeBlockText(value, maxLen = 900) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).trimEnd()}…`;
}

function blockToBodyLine(block) {
  if (!block || typeof block !== 'object') return '';
  const type = String(block.type || '').trim();
  if (!type) return '';

  const payload = block[type] && typeof block[type] === 'object' ? block[type] : {};
  const richText = plainTextFromRichText(payload.rich_text);
  const text = normalizeBlockText(richText);

  if (type === 'heading_1') return text ? `# ${text}` : '';
  if (type === 'heading_2') return text ? `## ${text}` : '';
  if (type === 'heading_3') return text ? `### ${text}` : '';
  if (type === 'paragraph') return text;
  if (type === 'bulleted_list_item') return text ? `- ${text}` : '';
  if (type === 'numbered_list_item') return text ? `1. ${text}` : '';
  if (type === 'to_do') {
    if (!text) return '';
    const marker = payload.checked ? 'x' : ' ';
    return `- [${marker}] ${text}`;
  }
  if (type === 'quote') return text ? `> ${text}` : '';
  if (type === 'callout') return text ? `! ${text}` : '';
  if (type === 'toggle') return text ? `Toggle: ${text}` : '';
  if (type === 'code') {
    const language = normalizeBlockText(payload.language || '');
    if (!text) return '';
    return `Code${language ? ` (${language})` : ''}: ${text}`;
  }
  if (type === 'child_page') {
    const title = normalizeBlockText(payload.title || '');
    return title ? `Child page: ${title}` : '';
  }
  if (type === 'bookmark' || type === 'embed' || type === 'link_preview') {
    const url = normalizeBlockText(payload.url || '');
    return url ? `Link: ${url}` : '';
  }
  if (type === 'table_of_contents') return '(Table of contents)';
  if (type === 'divider') return '---';

  return text;
}

function extractBodyLinesFromBlocks(blocks) {
  const source = Array.isArray(blocks) ? blocks : [];
  const lines = [];
  for (const block of source) {
    const line = blockToBodyLine(block);
    if (!line) continue;
    lines.push(line);
  }
  return lines;
}

function isHttpUrl(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw.startsWith('http://') || raw.startsWith('https://');
}

function sanitizeFilename(value, fallback = 'asset') {
  const raw = String(value || '').trim();
  const source = raw || fallback;
  const cleaned = source
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

function extensionFromUrl(urlValue) {
  try {
    const parsed = new URL(String(urlValue || ''));
    const ext = path.extname(parsed.pathname || '').trim();
    if (!ext) return '';
    if (ext.length > 10) return '';
    return ext;
  } catch {
    return '';
  }
}

function isDownloadableAssetKind(kind) {
  const normalized = normalize(kind);
  return ['file', 'image', 'video', 'pdf', 'audio'].includes(normalized);
}

async function downloadAssets(config, assets) {
  if (!config.downloadAttachments) return assets;
  const list = Array.isArray(assets) ? assets : [];
  if (list.length === 0) return list;

  const outputDir = path.isAbsolute(config.outputDir)
    ? config.outputDir
    : path.resolve(process.cwd(), config.outputDir);
  const assetsDir = path.join(outputDir, 'assets', sanitizeFilename(config.pageId, 'ticket'));
  await fs.mkdir(assetsDir, { recursive: true });

  const maxCount = Math.max(0, Number(config.attachmentsMax || DEFAULT_ATTACHMENTS_MAX));
  let downloaded = 0;
  const usedNames = new Set();

  for (const asset of list) {
    if (downloaded >= maxCount) break;
    const kind = String(asset?.kind || '').trim();
    if (!isDownloadableAssetKind(kind)) continue;
    const url = String(asset?.url || '').trim();
    if (!isHttpUrl(url)) continue;

    const ext = path.extname(String(asset?.name || '')) || extensionFromUrl(url);
    const base = sanitizeFilename(asset?.name || `${kind}-${downloaded + 1}`, `asset-${downloaded + 1}`);
    let filename = ext ? `${base}${ext}` : base;
    let dedupeIndex = 2;
    while (usedNames.has(filename.toLowerCase())) {
      filename = ext ? `${base}-${dedupeIndex}${ext}` : `${base}-${dedupeIndex}`;
      dedupeIndex += 1;
    }
    usedNames.add(filename.toLowerCase());

    const targetPath = path.join(assetsDir, filename);
    try {
      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) {
        asset.downloadError = `HTTP ${response.status}`;
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      await fs.writeFile(targetPath, bytes);
      asset.localPath = resolveRepoRelativePath(targetPath);
      downloaded += 1;
    } catch (error) {
      asset.downloadError = String(error?.message || error || 'download failed');
    }
  }

  return list;
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
  const blockFiles = blocks.flatMap((block) => extractFilesFromBlock(block));
  const propertyFiles = extractFilesFromProperties(page);
  const files = dedupeAssets([...blockFiles, ...propertyFiles]);
  await downloadAssets(config, files);
  const bodyLines = extractBodyLinesFromBlocks(blocks);

  return {
    page,
    comments,
    files,
    bodyLines,
    bodyText: bodyLines.join('\n').trim(),
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

function resolveBranchAliasSlug(branchLabel, wordsCountRaw) {
  const wordsCount = Math.max(2, Math.min(3, Number(wordsCountRaw || DEFAULT_HANDOFF_ALIAS_WORDS)));
  const raw = String(branchLabel || '').trim() || 'notion-ticket';
  const branchTail = raw.split('/').filter(Boolean).pop() || raw;
  const words = branchTail
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .slice(0, wordsCount);
  return slugifyForBranch(words.join('-') || branchTail, 64);
}

async function ensureWorktreeShortcut(rootWorkspace, shortcutsDirRaw, shortcutName, worktreePath) {
  const shortcutsDir = resolvePathFromWorkspace(
    rootWorkspace,
    shortcutsDirRaw,
    DEFAULT_WORKTREE_SHORTCUTS_DIR,
  );
  const shortcutPath = path.join(shortcutsDir, shortcutName);
  await fs.mkdir(shortcutsDir, { recursive: true });
  try {
    await fs.rm(shortcutPath, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors; symlink creation below will surface real failures
  }
  await fs.symlink(worktreePath, shortcutPath, 'dir');
  return shortcutPath;
}

function buildIdeHandoffBody({
  branchLabel,
  relativeHandoffPath,
  archiveHandoffPath,
  promptText,
  worktreePath,
  rootWorkspacePath,
}) {
  const archiveLine =
    archiveHandoffPath && archiveHandoffPath !== relativeHandoffPath
      ? `- **Branch-specific handoff file:** \`${archiveHandoffPath}\``
      : '';
  const worktreeLine = String(worktreePath || '').trim()
    ? `- **Worktree path (use this for code changes):** \`${String(worktreePath).trim()}\``
    : '';
  const rootWorkspaceLine = String(rootWorkspacePath || '').trim()
    ? `- **Root workspace:** \`${String(rootWorkspacePath).trim()}\``
    : '';
  return [
    '# Cursor IDE Agent — Notion handoff',
    '',
    `- **Git branch:** \`${branchLabel}\``,
    `- **This file (repo-relative):** \`${relativeHandoffPath}\``,
    ...(worktreeLine ? [worktreeLine] : []),
    ...(rootWorkspaceLine ? [rootWorkspaceLine] : []),
    ...(archiveLine ? [archiveLine] : []),
    '',
    'HARD STOP SAFETY CHECK (must be done before any edits):',
    '1) Verify the **Worktree path** above exists and is checked out on the **Git branch** above: run `git -C "<worktree path>" branch --show-current` and compare.',
    '2) Working from a window rooted at the **Root workspace** is fine (worktrees are nested inside it); do NOT compare the root workspace branch against **Git branch** — only the worktree branch matters.',
    '3) If the worktree is missing or its branch does not match, do not edit any files. Stop and ask the user to re-run intake for this ticket.',
    '',
    'Only modify files under the worktree path listed above for this ticket. Do not mix files from other tasks/worktrees.',
    'Branch handoff files are kept in `.notion/handoffs/` and stable aliases are refreshed on each run.',
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

function resolveRepoRelativePathFrom(workspacePath, absolutePath) {
  const rel = path.relative(workspacePath, absolutePath);
  return rel.split(path.sep).join('/');
}

function ensureTrailingNewline(text) {
  const raw = String(text || '');
  if (!raw) return '\n';
  return raw.endsWith('\n') ? raw : `${raw}\n`;
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

async function withJsonFileLock(filePath, fn, options = {}) {
  const lockPath = `${filePath}.lock`;
  const retries = Math.max(1, Number(options.retries || 50));
  const delayMs = Math.max(10, Number(options.delayMs || 50));
  let handle = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      handle = await fs.open(lockPath, 'wx');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (!handle) {
    fail(`Timed out waiting for lock: ${lockPath}`);
  }

  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {
      // ignore
    }
    try {
      await fs.unlink(lockPath);
    } catch {
      // ignore
    }
  }
}

async function upsertWorktreeMapEntry(mapFilePath, entry) {
  const pageId = String(entry?.pageId || '').trim();
  if (!pageId) fail('Cannot upsert worktree map entry without pageId.');

  return withJsonFileLock(mapFilePath, async () => {
    const mapData = await readJsonFileSafe(mapFilePath, { tickets: {} });
    const tickets = mapData?.tickets && typeof mapData.tickets === 'object' ? mapData.tickets : {};
    const previous = tickets[pageId] && typeof tickets[pageId] === 'object' ? tickets[pageId] : {};
    tickets[pageId] = {
      ...previous,
      ...entry,
      pageId,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(mapFilePath, {
      ...mapData,
      tickets,
    });
    return tickets[pageId];
  });
}

function resolvePathFromWorkspace(workspacePath, rawPath, fallbackValue = '') {
  const value = String(rawPath || fallbackValue || '').trim();
  if (!value) return '';
  if (path.isAbsolute(value)) return value;
  return path.resolve(workspacePath, value);
}

function parseWorktreePorcelain(output) {
  const lines = String(output || '').split(/\r?\n/);
  const entries = [];
  let current = null;
  for (const line of lines) {
    const raw = String(line || '').trim();
    if (!raw) continue;
    if (raw.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        path: raw.slice('worktree '.length).trim(),
        branchRef: '',
      };
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('branch ')) current.branchRef = raw.slice('branch '.length).trim();
  }
  if (current) entries.push(current);
  return entries;
}

async function getGitWorktreeEntries(config) {
  const output = await runGit(['worktree', 'list', '--porcelain'], config);
  return parseWorktreePorcelain(output);
}

function buildWorktreeFolderName(pageId, branchName) {
  const idShort = String(pageId || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
    .toLowerCase();
  const branchFlat = sanitizeBranchForHandoffFilename(branchName || 'ticket');
  return `${idShort || 'ticket'}-${branchFlat}`;
}

async function ensureTicketWorktree(config, page, branchName) {
  const rootWorkspace = String(config.rootWorkspace || process.cwd());
  const gitConfig = { ...config, gitWorkingDirectory: rootWorkspace };
  const worktreeRoot = resolvePathFromWorkspace(rootWorkspace, config.worktreeDir, DEFAULT_WORKTREE_DIR);
  const mapFilePath = resolvePathFromWorkspace(rootWorkspace, config.worktreeMapFile, DEFAULT_WORKTREE_MAP_FILE);
  const pageId = String(page?.id || '').trim();
  const pageTitle = getPageTitle(page);
  const status = resolveStatusText(page, config.statusPropertyName);
  const requestedBranch = String(branchName || '').trim();
  if (!pageId) fail('Cannot create worktree without a Notion page id.');
  if (!requestedBranch) fail('Cannot create worktree without a branch name.');

  const mapEntryPayload = (worktreePath, branch) => ({
    pageId,
    pageTitle,
    status,
    branch,
    worktreePath,
  });

  await fs.mkdir(worktreeRoot, { recursive: true });

  // Prefer an existing mapped worktree for this page, even if the branch candidate changed.
  // This prevents duplicate worktrees like "foo" + "foo-clean" for the same ticket.
  const mapData = await readJsonFileSafe(mapFilePath, { tickets: {} });
  const existingMapEntry =
    mapData?.tickets && typeof mapData.tickets === 'object' ? mapData.tickets[pageId] : null;
  const mappedPath = String(existingMapEntry?.worktreePath || '').trim();
  const mappedBranch = String(existingMapEntry?.branch || '').trim() || requestedBranch;
  if (mappedPath) {
    try {
      await fs.access(mappedPath);
      await upsertWorktreeMapEntry(mapFilePath, mapEntryPayload(mappedPath, mappedBranch));
      return { path: mappedPath, reused: true, branch: mappedBranch };
    } catch {
      // Mapped path gone; fall through and recreate.
    }
  }

  let worktrees = await getGitWorktreeEntries(gitConfig);
  const branchRef = `refs/heads/${requestedBranch}`;
  let existingByBranch = worktrees.find((entry) => String(entry?.branchRef || '').trim() === branchRef);
  if (existingByBranch?.path) {
    try {
      await fs.access(existingByBranch.path);
      await upsertWorktreeMapEntry(
        mapFilePath,
        mapEntryPayload(existingByBranch.path, requestedBranch),
      );
      return { path: existingByBranch.path, reused: true, branch: requestedBranch };
    } catch {
      // Stale git worktree registration (path removed manually). Prune and continue with fresh add.
      await runGit(['worktree', 'prune'], gitConfig);
      worktrees = await getGitWorktreeEntries(gitConfig);
      existingByBranch = worktrees.find((entry) => String(entry?.branchRef || '').trim() === branchRef);
      if (existingByBranch?.path) {
        try {
          await fs.access(existingByBranch.path);
          await upsertWorktreeMapEntry(
            mapFilePath,
            mapEntryPayload(existingByBranch.path, requestedBranch),
          );
          return { path: existingByBranch.path, reused: true, branch: requestedBranch };
        } catch {
          // Continue to re-create worktree at desired path below.
        }
      }
    }
  }

  const folderName = buildWorktreeFolderName(pageId, requestedBranch);
  const desiredPath = path.join(worktreeRoot, folderName);

  const branchExists = await hasGitRef(branchRef, gitConfig);
  if (branchExists) {
    await runGit(['worktree', 'add', desiredPath, requestedBranch], gitConfig);
  } else if (await remoteBranchExists(config.gitRemote, requestedBranch, gitConfig)) {
    await runGit(['fetch', config.gitRemote, requestedBranch], gitConfig);
    await runGit(
      ['worktree', 'add', '-B', requestedBranch, desiredPath, `${config.gitRemote}/${requestedBranch}`],
      gitConfig,
    );
  } else {
    await runGit(['fetch', config.gitRemote, config.gitBaseBranch], gitConfig);
    await runGit(
      ['worktree', 'add', '-b', requestedBranch, desiredPath, `${config.gitRemote}/${config.gitBaseBranch}`],
      gitConfig,
    );
  }

  await upsertWorktreeMapEntry(mapFilePath, mapEntryPayload(desiredPath, requestedBranch));
  return { path: desiredPath, reused: false, branch: requestedBranch };
}

async function writeActiveTicketsIndex(config) {
  const rootWorkspace = String(config.rootWorkspace || process.cwd());
  const mapFilePath = resolvePathFromWorkspace(rootWorkspace, config.worktreeMapFile, DEFAULT_WORKTREE_MAP_FILE);
  const indexFilePath = resolvePathFromWorkspace(
    rootWorkspace,
    config.activeTicketsFile,
    DEFAULT_ACTIVE_TICKETS_FILE,
  );
  const mapData = await readJsonFileSafe(mapFilePath, { tickets: {} });
  const tickets = mapData?.tickets && typeof mapData.tickets === 'object' ? mapData.tickets : {};
  const rows = Object.values(tickets)
    .filter((entry) => entry && typeof entry === 'object')
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

  const body = [
    '# Active Notion Tickets',
    '',
    `Updated: ${new Date().toISOString()}`,
    '',
    rows.length === 0
      ? '_No active worktree tickets tracked yet._'
      : '| Ticket | Status | Branch | Worktree |',
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

  await fs.mkdir(path.dirname(indexFilePath), { recursive: true });
  await fs.writeFile(indexFilePath, ensureTrailingNewline(body), 'utf8');
}

async function writeActiveHandoffsIndex(config, mapPayload) {
  const rootWorkspace = String(config.rootWorkspace || process.cwd());
  const indexFilePath = resolvePathFromWorkspace(
    rootWorkspace,
    config.activeHandoffsFile,
    DEFAULT_ACTIVE_HANDOFFS_FILE,
  );
  const aliases = Object.entries(mapPayload?.aliases || {})
    .map(([pageId, entry]) => ({
      pageId,
      aliasFile: String(entry?.aliasFile || '').trim(),
      branch: String(entry?.branch || '').trim(),
      worktreePath: String(entry?.worktreePath || '').trim(),
      shortcutPath: String(entry?.shortcutPath || '').trim(),
      updatedAt: String(entry?.updatedAt || '').trim(),
    }))
    .filter((entry) => entry.aliasFile)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  const rows =
    aliases.length === 0
      ? ['_No active handoff aliases tracked yet._']
      : [
          '| Ticket | Alias file | Branch | Worktree | Shortcut | Updated |',
          '|---|---|---|---|---|---|',
          ...aliases.map(
            (entry) =>
              `| ${entry.pageId} | \`${entry.aliasFile}\` | \`${entry.branch || '(unknown)'}\` | \`${entry.worktreePath || '(unknown)'}\` | \`${entry.shortcutPath || '(none)'}\` | ${entry.updatedAt || '(unknown)'} |`,
          ),
        ];
  const body = ['# Active Notion Handoff Aliases', '', ...rows, ''].join('\n');
  await fs.mkdir(path.dirname(indexFilePath), { recursive: true });
  await fs.writeFile(indexFilePath, ensureTrailingNewline(body), 'utf8');
  return indexFilePath;
}

async function rerunIntakeInWorktree(config, worktreePath, originalArgs) {
  const scriptPath = path.resolve(String(process.argv[1] || 'scripts/notion-agent-intake.js'));
  const args = [
    'node',
    scriptPath,
    '--workspace',
    worktreePath,
    '--page-id',
    String(config.pageId || ''),
    '--worktree-resolved',
    'true',
  ];

  if (config.dispatch) args.push('--dispatch');
  if (config.envFile) args.push('--env-file', config.envFile);
  if (originalArgs['git-require-clean-worktree'] !== undefined) {
    args.push('--git-require-clean-worktree', String(originalArgs['git-require-clean-worktree']));
  }

  const previousCwd = process.cwd();
  const previousRootWorkspace = process.env.NOTION_ROOT_WORKSPACE;
  try {
    process.chdir(worktreePath);
    process.env.NOTION_ROOT_WORKSPACE = String(config.rootWorkspace || previousCwd);
    const exitCode = await main(args);
    if (Number(exitCode || 0) !== 0) {
      throw new Error(`Worktree intake failed with exit code ${exitCode}`);
    }
  } finally {
    process.chdir(previousCwd);
    if (previousRootWorkspace === undefined) {
      delete process.env.NOTION_ROOT_WORKSPACE;
    } else {
      process.env.NOTION_ROOT_WORKSPACE = previousRootWorkspace;
    }
  }
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

async function ensureBranchCandidateNamespaceSafe(branchCandidate, config) {
  const raw = String(branchCandidate || '').trim();
  if (!raw) return { branchCandidate: raw, adjusted: false, reason: '' };
  const firstSlash = raw.indexOf('/');
  if (firstSlash <= 0) return { branchCandidate: raw, adjusted: false, reason: '' };

  const namespaceHead = raw.slice(0, firstSlash).trim();
  if (!namespaceHead) return { branchCandidate: raw, adjusted: false, reason: '' };

  const namespaceHeadExists = await hasGitRef(`refs/heads/${namespaceHead}`, config);
  if (!namespaceHeadExists) {
    return { branchCandidate: raw, adjusted: false, reason: '' };
  }

  const adjusted = raw.replace(/\//g, '-');
  return {
    branchCandidate: adjusted,
    adjusted: true,
    reason: `Namespace '${namespaceHead}' already exists as a branch; using '${adjusted}' to avoid ref collision.`,
  };
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

async function runCreateChatCommand(config, command) {
  const timeoutMsRaw = Number.parseInt(
    String(process.env.NOTION_AGENT_CREATE_CHAT_TIMEOUT_MS || DEFAULT_AGENT_CREATE_CHAT_TIMEOUT_MS),
    10,
  );
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : DEFAULT_AGENT_CREATE_CHAT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn('bash', ['-lc', command], {
      cwd: process.cwd(),
      env: buildCursorAgentChildEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finishWithChatId = (chatId) => {
      if (settled) return;
      settled = true;
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGTERM');
        } catch {
          // process already ended
        }
      }
      resolve(chatId);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      const chatId = extractCursorChatId(stdout);
      if (chatId) {
        finishWithChatId(chatId);
        return;
      }
      settled = true;
      try {
        if (child.pid) process.kill(child.pid, 'SIGKILL');
      } catch {
        // ignore
      }
      const details = String(stderr || stdout || '').trim();
      reject(
        new Error(
          `Cursor chat creation timed out after ${timeoutMs}ms` +
            (details ? `: ${details.slice(0, 300)}` : ''),
        ),
      );
    }, timeoutMs);

    const inspectForChatId = () => {
      const candidate = extractCursorChatId(stdout);
      if (candidate) {
        clearTimeout(timer);
        finishWithChatId(candidate);
      }
    };

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk || '');
      inspectForChatId();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk || '');
    });

    child.on('error', (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(error);
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      const chatId = extractCursorChatId(stdout);
      if (chatId) {
        settled = true;
        resolve(chatId);
        return;
      }
      settled = true;
      const details = String(stderr || stdout || '').trim();
      if (signal) {
        reject(
          new Error(
            `Failed to create Cursor chat session: terminated by ${signal}` +
              (details ? ` (${details.slice(0, 300)})` : ''),
          ),
        );
        return;
      }
      reject(
        new Error(
          `Failed to create Cursor chat session: ${
            details || `exit code ${code}`
          }`,
        ),
      );
    });
  });
}

async function createCursorChatId(config) {
  const command = String(config.agentCreateChatCommand || '').trim();
  if (!command) return '';

  const chatId = await runCreateChatCommand(config, command);
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

function injectCursorAgentFlagIfNeeded(command, flagName, flagValue) {
  const raw = String(command || '').trim();
  const value = String(flagValue || '').trim();
  if (!raw || !value) return raw;
  if (!commandStartsWithCursorAgent(raw)) return raw;

  const flagPattern = new RegExp(`(^|\\s)--${flagName}(\\s|=)`);
  if (flagPattern.test(raw)) return raw;

  const safeValue = value.replace(/"/g, '\\"');
  const firstSpace = raw.search(/\s/);
  if (firstSpace === -1) {
    return `${raw} --${flagName} "${safeValue}"`;
  }
  const bin = raw.slice(0, firstSpace);
  const rest = raw.slice(firstSpace + 1).trimStart();
  return `${bin} --${flagName} "${safeValue}" ${rest}`;
}

function injectResumeFlagIfNeeded(command, chatId) {
  const raw = String(command || '').trim();
  if (!raw || !chatId) return raw;
  if (!commandStartsWithCursorAgent(raw)) return raw;
  if (/(^|\s)--resume(\s|=)/.test(raw) || /(^|\s)--continue(\s|$)/.test(raw)) {
    return raw;
  }
  return injectCursorAgentFlagIfNeeded(raw, 'resume', chatId);
}

function injectModelFlagIfNeeded(command, model) {
  return injectCursorAgentFlagIfNeeded(command, 'model', model);
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
  const ticketBodyLines = (pageSnapshot.bodyLines || []).slice(0, 140);
  const latestCommentLines = comments.slice(0, 8).map((comment, index) => {
    const creator = String(comment?.createdBy || '').trim() || 'unknown';
    const created = String(comment?.createdAt || '').trim() || 'unknown-time';
    const body = String(comment?.text || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    return `${index + 1}. [${created}] ${creator}: ${body || '(empty comment)'}`;
  });

  const fileLines = (pageSnapshot.files || []).slice(0, 15).map((asset, index) => {
    const name = String(asset?.name || '').trim() || `file-${index + 1}`;
    const url = String(asset?.url || '').trim();
    const kind = String(asset?.kind || '').trim() || 'asset';
    const source = String(asset?.source || '').trim() || 'unknown';
    const propertyName = String(asset?.propertyName || '').trim();
    const localPath = String(asset?.localPath || '').trim();
    const downloadError = String(asset?.downloadError || '').trim();
    const sourceLabel = source === 'property' && propertyName ? `${source}:${propertyName}` : source;
    return `${index + 1}. [${kind}] ${name}${url ? ` -> ${url}` : ''}${localPath ? ` (local: ${localPath})` : ''}${downloadError ? ` (download failed: ${downloadError})` : ''} [source=${sourceLabel}]`;
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
    '## Ticket Body (from page blocks)',
    ...(ticketBodyLines.length > 0 ? ticketBodyLines : ['(No ticket body text extracted from page blocks)']),
    '',
    '## Latest Comments',
    ...(latestCommentLines.length > 0 ? latestCommentLines : ['(No comments found)']),
    '',
    '## Attached Files',
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
    ticketBodyLines: pageSnapshot.bodyLines || [],
    ticketBodyText: String(pageSnapshot.bodyText || ''),
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
  let rootHandoffAliasPath = '';
  let worktreeShortcutPath = '';
  let activeHandoffsPath = '';
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
      worktreePath: process.cwd(),
      rootWorkspacePath: String(config.rootWorkspace || process.cwd()),
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
        worktreePath: process.cwd(),
        rootWorkspacePath: String(config.rootWorkspace || process.cwd()),
      });
      await fs.writeFile(handoffAliasPath, ensureTrailingNewline(aliasBody), 'utf8');
    }

    const shouldPublishRootAlias = Boolean(
      config.publishRootHandoffAlias && config.worktreeMode && config.worktreeResolved,
    );
    if (shouldPublishRootAlias) {
      const rootWorkspace = String(config.rootWorkspace || process.cwd());
      const aliasSlug = resolveBranchAliasSlug(branchLabel, config.handoffAliasWords);
      const aliasFileName = `notion-handoff-${aliasSlug}.md`;
      rootHandoffAliasPath = path.resolve(rootWorkspace, aliasFileName);
      worktreeShortcutPath = await ensureWorktreeShortcut(
        rootWorkspace,
        config.worktreeShortcutsDir,
        aliasSlug,
        process.cwd(),
      );
      const rootAliasBody = buildIdeHandoffBody({
        branchLabel,
        relativeHandoffPath: resolveRepoRelativePathFrom(rootWorkspace, rootHandoffAliasPath),
        archiveHandoffPath: resolveRepoRelativePathFrom(rootWorkspace, handoffPath),
        promptText: handoffPrompt,
        worktreePath: process.cwd(),
        rootWorkspacePath: rootWorkspace,
      });
      await fs.mkdir(path.dirname(rootHandoffAliasPath), { recursive: true });
      await fs.writeFile(rootHandoffAliasPath, ensureTrailingNewline(rootAliasBody), 'utf8');

      const mapFilePath = resolvePathFromWorkspace(
        rootWorkspace,
        config.handoffAliasMapFile,
        DEFAULT_HANDOFF_ALIAS_MAP_FILE,
      );
      const aliasMap = await readJsonFileSafe(mapFilePath, {});
      const aliases = aliasMap && typeof aliasMap.aliases === 'object' ? aliasMap.aliases : {};
      aliases[String(context.ticket.id || '').trim() || 'unknown'] = {
        aliasFile: aliasFileName,
        aliasPath: rootHandoffAliasPath,
        branch: branchLabel,
        worktreePath: process.cwd(),
        shortcutPath: worktreeShortcutPath,
        updatedAt: new Date().toISOString(),
      };
      const mapPayload = { updatedAt: new Date().toISOString(), aliases };
      await writeJsonFile(mapFilePath, mapPayload);
      activeHandoffsPath = await writeActiveHandoffsIndex(config, mapPayload);
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
    rootHandoffAliasPath: rootHandoffAliasPath || null,
    worktreeShortcutPath: worktreeShortcutPath || null,
    activeHandoffsPath: activeHandoffsPath || null,
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
  command = injectModelFlagIfNeeded(command, config.agentModel);
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

  if (config.agentModel) {
    print(`Agent model: ${config.agentModel}`, colors.dim);
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
  print(`  --agent-model <id> (default ${DEFAULT_AGENT_MODEL}; use inherit to skip injection)`);
  print('  --unset-cursor-api-key true|false');
  print('  --agent-headless-print true|false');
  print('  --ide-handoff true|false');
  print(`  --download-attachments true|false (default ${String(DEFAULT_DOWNLOAD_ATTACHMENTS)})`);
  print(`  --attachments-max <n> (default ${String(DEFAULT_ATTACHMENTS_MAX)})`);
  print(`  --worktree-mode true|false (default ${String(DEFAULT_WORKTREE_MODE)})`);
  print('  --ide cursor|webstorm|jetbrains (select IDE-specific worktree dir defaults)');
  print(`  --worktree-dir <dir> (explicit override; default ${DEFAULT_WORKTREE_DIR} for cursor/unset)`);
  print('  --worktree-dir-by-ide "cursor=.notion/worktrees,webstorm=../{repo}-worktrees"');
  print(`  --worktree-map-file <path> (default ${DEFAULT_WORKTREE_MAP_FILE})`);
  print(`  --active-tickets-file <path> (default ${DEFAULT_ACTIVE_TICKETS_FILE})`);
  print(`  --worktree-shortcuts-dir <path> (default ${DEFAULT_WORKTREE_SHORTCUTS_DIR})`);
  print(`  --publish-root-handoff-alias true|false (default ${String(DEFAULT_PUBLISH_ROOT_HANDOFF_ALIAS)})`);
  print(`  --handoff-alias-words <2|3> (default ${String(DEFAULT_HANDOFF_ALIAS_WORDS)})`);
  print(`  --handoff-alias-map-file <path> (default ${DEFAULT_HANDOFF_ALIAS_MAP_FILE})`);
  print(`  --active-handoffs-file <path> (default ${DEFAULT_ACTIVE_HANDOFFS_FILE})`);
  print('  --root-workspace <path>');
  print('  --sprint-assign-on-intake true|false (default true)');
  print(`  --sprint-property <name> (default ${DEFAULT_SPRINT_PROPERTY})`);
  print('  --current-sprint "<Sprint Week N[+M]>" (optional; auto-detect by ISO week)');
  print(`  --subitem-property <name> (default ${DEFAULT_SUBITEM_PROPERTY})`);
  print('  --sprint-cascade-subitems true|false (default true)');
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
  if (!config.envFile && loadedEnv.source) {
    config.envFile = loadedEnv.source;
  }

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
  let page = pageSnapshot.page;

  try {
    const sprintAssignment = await assignSprintOnIntake(config, page);
    if (sprintAssignment.page) page = sprintAssignment.page;
    pageSnapshot.page = page;
    if (!sprintAssignment.attempted) {
      print(`Sprint assign: skipped (${sprintAssignment.reason})`, colors.dim);
    } else if (!sprintAssignment.sprintName) {
      print(`Sprint assign: skipped (${sprintAssignment.reason})`, colors.yellow);
    } else {
      const rootLabel = sprintAssignment.updated
        ? `set "${sprintAssignment.sprintName}"`
        : `kept existing (${sprintAssignment.reason})`;
      print(
        `Sprint assign: ${rootLabel} [source=${sprintAssignment.source || 'config'}]`,
        sprintAssignment.updated ? colors.green : colors.dim,
      );
      const subitems = Array.isArray(sprintAssignment.subitems) ? sprintAssignment.subitems : [];
      if (subitems.length > 0) {
        const updatedCount = subitems.filter((entry) => entry.updated).length;
        print(
          `Sprint cascade: ${updatedCount}/${subitems.length} sub-item(s) updated to "${sprintAssignment.sprintName}"`,
          updatedCount > 0 ? colors.green : colors.dim,
        );
        for (const entry of subitems.filter((item) => !item.updated)) {
          print(`  sub-item ${entry.pageId}: ${entry.reason}`, colors.dim);
        }
      }
    }
  } catch (error) {
    print(
      `Sprint assign: failed (continuing intake): ${error?.message || String(error)}`,
      colors.yellow,
    );
  }

  const sectionContext = resolveSectionContext(page, config.sectionPropertyName);
  const branchResolution = buildBranchCandidate(
    config.branchPrefix,
    page,
    sectionContext,
    config.branchPrefixRules,
    config.branchIncludeTicketId,
  );
  let branchCandidate = branchResolution.branchCandidate;
  const resolvedPrefix = branchResolution.resolvedPrefix;
  const matchedBranchRule = branchResolution.matchedRule;
  const branchIncludeTicketId = branchResolution.includeTicketId;
  const branchNamespaceSafety = await ensureBranchCandidateNamespaceSafe(branchCandidate, {
    ...config,
    gitWorkingDirectory: String(config.rootWorkspace || process.cwd()),
  });
  if (branchNamespaceSafety.adjusted) {
    branchCandidate = branchNamespaceSafety.branchCandidate;
    print(`Adjusted branch candidate: ${branchNamespaceSafety.reason}`, colors.yellow);
  }
  let gitPreparation = null;

  if (config.worktreeMode && !config.worktreeResolved) {
    const ideHint = config.ide ? `ide=${config.ide}, ` : '';
    print(
      `Worktree root (${ideHint}source=${config.worktreeDirSource}): ${config.worktreeDir}`,
      colors.dim,
    );
    const worktree = await ensureTicketWorktree(config, page, branchCandidate);
    await writeActiveTicketsIndex(config);
    print(
      `Worktree mode: ${worktree.reused ? 'reusing' : 'created'} worktree '${worktree.path}' for branch '${worktree.branch}'.`,
      colors.green,
    );
    await rerunIntakeInWorktree(config, worktree.path, args);
    return 0;
  }

  if (config.worktreeMode && config.worktreeResolved && config.dispatch && config.gitPrepareBranch) {
    print('Worktree mode: git prepare skipped in resolved worktree context.', colors.dim);
    config.gitPrepareBranch = false;
  }

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
  if (files.rootHandoffAliasPath) {
    print(
      `Root handoff alias (@ this file from root workspace): ${files.rootHandoffAliasPath}`,
      colors.green,
    );
  }
  if (files.worktreeShortcutPath) {
    print(`Worktree shortcut (quick cd path): ${files.worktreeShortcutPath}`, colors.green);
  }
  if (files.activeHandoffsPath) {
    print(`Active handoff aliases index: ${files.activeHandoffsPath}`, colors.green);
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
