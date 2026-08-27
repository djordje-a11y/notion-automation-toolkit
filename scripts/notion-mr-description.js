import fs from 'fs/promises';
import path from 'path';

const DEFAULT_WORKTREE_MAP_FILE = '.notion/worktree-map.json';
const DEFAULT_INTAKE_DIR = '.notion/intake';
const DEFAULT_HANDOFF_DIR = '.notion/handoffs';
const DEFAULT_HANDOFF_ALIAS_FILE = 'notion-handoff.md';

const MAX_CONTEXT_CHARS = 2500;
const MAX_CONTEXT_LINES = 50;
const MAX_CHANGED_FILES = 20;
const MAX_COMMITS = 30;
const MAX_COMMIT_BODY_CHARS = 400;
const MAX_TITLE_CHARS = 200;

function uniqueResolvedPaths(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function normalizePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.resolve(raw).replace(/\\/g, '/').replace(/\/+$/g, '');
}

function collapseBlankLines(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateText(text, maxChars = MAX_CONTEXT_CHARS, maxLines = MAX_CONTEXT_LINES) {
  const collapsed = collapseBlankLines(text);
  if (!collapsed) return '';
  const lines = collapsed.split(/\r?\n/);
  let clipped = lines.length > maxLines ? `${lines.slice(0, maxLines).join('\n').trimEnd()}\n…` : collapsed;
  if (clipped.length > maxChars) {
    clipped = `${clipped.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return clipped;
}

export function notionUrlFromPageId(pageId) {
  const compact = String(pageId || '')
    .replace(/-/g, '')
    .trim();
  if (!/^[a-f0-9]{32}$/i.test(compact)) return '';
  return `https://www.notion.so/${compact}`;
}

export function sanitizeBranchForHandoffFilename(branch) {
  const raw = String(branch || '').trim() || 'notion-ticket';
  let value = raw.replace(/[/\\:*?"<>|]+/g, '-');
  value = value.replace(/\s+/g, '-');
  value = value.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (value.length > 180) value = value.slice(0, 180).replace(/-+$/g, '');
  return value || 'notion-ticket';
}

export function buildDefaultMrTitle(ticket, branchName, targetBranch) {
  const title = String(ticket?.title || '').trim();
  if (title) return title.slice(0, MAX_TITLE_CHARS);
  return `${branchName} -> ${targetBranch}`;
}

async function readJsonFileSafe(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

async function readTextFileSafe(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function pickMapEntry(tickets, { branch, worktreePath }) {
  const entries = Object.values(tickets || {}).filter((entry) => entry && typeof entry === 'object');
  const normalizedWorktree = normalizePath(worktreePath);
  if (normalizedWorktree) {
    const byPath = entries.find((entry) => normalizePath(entry.worktreePath) === normalizedWorktree);
    if (byPath) return byPath;
  }
  const branchName = String(branch || '').trim();
  if (!branchName) return null;
  return entries.find((entry) => String(entry.branch || '').trim() === branchName) || null;
}

async function loadWorktreeMapTicket(workspaces, { branch, worktreePath }) {
  for (const workspace of workspaces) {
    const mapPath = path.join(workspace, DEFAULT_WORKTREE_MAP_FILE);
    const mapData = await readJsonFileSafe(mapPath, { tickets: {} });
    const tickets = mapData?.tickets && typeof mapData.tickets === 'object' ? mapData.tickets : {};
    const entry = pickMapEntry(tickets, { branch, worktreePath });
    if (!entry) continue;
    const pageId = String(entry.pageId || '').trim();
    return {
      pageId,
      title: String(entry.pageTitle || '').trim(),
      url: notionUrlFromPageId(pageId),
      body: '',
      source: 'worktree-map',
    };
  }
  return null;
}

function contextMatchesBranch(payload, branch) {
  const branchName = String(branch || '').trim();
  if (!branchName) return false;
  const prepared = String(payload?.gitPreparation?.preparedBranch || '').trim();
  const candidate = String(payload?.branchCandidate || '').trim();
  return prepared === branchName || candidate === branchName;
}

async function loadLatestIntakeContext(workspaces, { pageId, branch }) {
  const idPrefix = String(pageId || '').trim();
  let best = null;

  for (const workspace of workspaces) {
    const intakeDir = path.join(workspace, DEFAULT_INTAKE_DIR);
    let names = [];
    try {
      names = await fs.readdir(intakeDir);
    } catch {
      continue;
    }

    const files = names.filter((name) => name.endsWith('.context.json'));
    const preferred = idPrefix ? files.filter((name) => name.startsWith(idPrefix)) : files;
    const candidates = preferred.length > 0 ? preferred : files;
    candidates.sort().reverse();

    for (const name of candidates) {
      const filePath = path.join(intakeDir, name);
      const payload = await readJsonFileSafe(filePath, null);
      if (!payload || typeof payload !== 'object') continue;

      const ticket = payload.ticket && typeof payload.ticket === 'object' ? payload.ticket : {};
      const ticketId = String(ticket.id || '').trim();
      if (idPrefix && ticketId && ticketId !== idPrefix && !name.startsWith(idPrefix)) continue;
      if (!idPrefix && !contextMatchesBranch(payload, branch)) continue;

      const stat = await fs.stat(filePath).catch(() => null);
      const stamp = Number(stat?.mtimeMs || 0);
      if (best && stamp <= best.stamp) continue;

      best = {
        stamp,
        ticket: {
          pageId: ticketId || idPrefix,
          title: String(ticket.title || '').trim(),
          url: String(ticket.url || '').trim() || notionUrlFromPageId(ticketId || idPrefix),
          body: String(payload.ticketBodyText || '').trim() || (payload.ticketBodyLines || []).join('\n').trim(),
          source: 'intake-context',
        },
      };
      if (idPrefix) break;
    }
  }

  return best?.ticket || null;
}

function extractLabeledValue(text, label) {
  const escaped = String(label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`^[ \\t]*-\\s*\\*\\*?${escaped}\\*\\*?:\\s*(.+)$`, 'im'));
  if (match) return String(match[1] || '').trim();
  const plain = String(text || '').match(new RegExp(`^[ \\t]*-\\s*${escaped}:\\s*(.+)$`, 'im'));
  return plain ? String(plain[1] || '').trim() : '';
}

function extractHandoffSection(text, heading) {
  const escaped = String(heading || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(
    new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'm'),
  );
  return match ? String(match[1] || '').trim() : '';
}

function parseHandoffTicket(text, branch) {
  const raw = String(text || '');
  if (!raw.trim()) return null;

  const gitBranchMatch = raw.match(/\*\*Git branch:\*\*\s+`([^`]+)`/);
  const handoffBranch = String(gitBranchMatch?.[1] || '').trim();
  if (handoffBranch && branch && handoffBranch !== branch) return null;

  const pageId = extractLabeledValue(raw, 'Page ID');
  const title = extractLabeledValue(raw, 'Title');
  const url = extractLabeledValue(raw, 'URL');
  const body =
    extractHandoffSection(raw, 'Ticket Body (from page blocks)') ||
    extractHandoffSection(raw, 'Ticket');

  if (!pageId && !title && !url && !body) return null;
  const cleanedUrl = url && url !== '(none)' ? url : notionUrlFromPageId(pageId);
  const cleanedBody = body
    .split(/\r?\n/)
    .filter((line) => !/^\s*-\s*(Page ID|Title|Branch|URL):/i.test(line))
    .join('\n')
    .trim();

  return {
    pageId,
    title,
    url: cleanedUrl,
    body: cleanedBody,
    source: 'handoff',
  };
}

async function loadHandoffTicket(workspaces, branch) {
  const fileNames = [`${sanitizeBranchForHandoffFilename(branch)}.agent-handoff.md`, DEFAULT_HANDOFF_ALIAS_FILE];
  for (const workspace of workspaces) {
    const candidates = [
      ...fileNames.map((name) => path.join(workspace, DEFAULT_HANDOFF_DIR, name)),
      path.join(workspace, DEFAULT_HANDOFF_ALIAS_FILE),
    ];
    for (const filePath of uniqueResolvedPaths(candidates)) {
      const parsed = parseHandoffTicket(await readTextFileSafe(filePath), branch);
      if (parsed) return parsed;
    }
  }
  return null;
}

function mergeTicketParts(...parts) {
  const merged = {
    pageId: '',
    title: '',
    url: '',
    body: '',
    source: '',
  };
  const sources = [];
  for (const part of parts) {
    if (!part) continue;
    if (!merged.pageId && part.pageId) merged.pageId = part.pageId;
    if (!merged.title && part.title) merged.title = part.title;
    if (!merged.url && part.url) merged.url = part.url;
    if (!merged.body && part.body) merged.body = part.body;
    if (part.source) sources.push(part.source);
  }
  if (!merged.url) merged.url = notionUrlFromPageId(merged.pageId);
  merged.source = sources.join('+');
  if (!merged.pageId && !merged.title && !merged.url && !merged.body) return null;
  return merged;
}

export async function resolveTicketContext({ workspace, rootWorkspace, branch, worktreePath }) {
  const workspaces = uniqueResolvedPaths([workspace, rootWorkspace]);
  const lookup = {
    branch: String(branch || '').trim(),
    worktreePath: worktreePath || workspace,
  };
  const fromMap = await loadWorktreeMapTicket(workspaces, lookup);
  const fromIntake = await loadLatestIntakeContext(workspaces, {
    pageId: fromMap?.pageId || '',
    branch: lookup.branch,
  });
  const fromHandoff = await loadHandoffTicket(workspaces, lookup.branch);
  return mergeTicketParts(fromIntake, fromHandoff, fromMap);
}

async function tryGit(runGit, args, cwd) {
  try {
    return String((await runGit(args, cwd)) || '').trim();
  } catch {
    return '';
  }
}

function parseCommitRecords(logOutput) {
  const records = String(logOutput || '').split('\x1e');
  const commits = [];
  for (const record of records) {
    const [hash, subject, body] = String(record || '').split('\x1f');
    const cleanHash = String(hash || '').trim();
    const cleanSubject = String(subject || '').trim();
    if (!cleanHash && !cleanSubject) continue;
    commits.push({
      hash: cleanHash,
      subject: cleanSubject,
      body: truncateText(String(body || '').trim(), MAX_COMMIT_BODY_CHARS, 8),
    });
    if (commits.length >= MAX_COMMITS) break;
  }
  return commits;
}

export async function collectBranchChanges({ runGit, workspace, remote, targetBranch }) {
  const ranges = [`${remote}/${targetBranch}..HEAD`, `${targetBranch}..HEAD`];
  let commits = [];
  let usedRange = '';
  for (const range of ranges) {
    const logOutput = await tryGit(
      runGit,
      ['log', range, '--pretty=format:%h%x1f%s%x1f%b%x1e'],
      workspace,
    );
    const parsed = parseCommitRecords(logOutput);
    if (parsed.length > 0) {
      commits = parsed;
      usedRange = range;
      break;
    }
  }

  const fileRanges = usedRange
    ? [usedRange.replace('..', '...'), usedRange]
    : [`${remote}/${targetBranch}...HEAD`, `${remote}/${targetBranch}..HEAD`, `${targetBranch}...HEAD`];
  let files = [];
  for (const range of fileRanges) {
    const output = await tryGit(runGit, ['diff', '--name-only', range], workspace);
    const names = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (names.length > 0) {
      files = names;
      break;
    }
  }

  return { commits, files };
}

function formatCommitLine(commit) {
  const hash = commit.hash ? `\`${commit.hash}\` ` : '';
  return `- ${hash}${commit.subject || '(no subject)'}`;
}

export function formatMrDescription({ ticket, commits, files, branch, targetBranch }) {
  const title = String(ticket?.title || '').trim();
  const url = String(ticket?.url || '').trim();
  const body = truncateText(ticket?.body || '');
  const commitList = Array.isArray(commits) ? commits : [];
  const fileList = Array.isArray(files) ? files.filter(Boolean) : [];

  const contextLines = ['## Context', ''];
  if (title) contextLines.push(`**${title}**`, '');
  if (body) {
    contextLines.push(body, '');
  } else if (title) {
    contextLines.push('_No ticket body was captured at intake._', '');
  } else {
    contextLines.push(
      `Work on \`${branch}\`${targetBranch ? ` targeting \`${targetBranch}\`` : ''}.`,
      '',
      '_No linked Notion ticket context was found for this branch._',
      '',
    );
  }

  const solutionLines = ['## Solution', ''];
  if (commitList.length === 1) {
    const only = commitList[0];
    solutionLines.push(only.subject || 'See branch commits.');
    if (only.body) solutionLines.push('', only.body);
    solutionLines.push('');
  } else if (commitList.length > 1) {
    solutionLines.push('This MR implements the ticket with:');
    solutionLines.push('');
    for (const commit of commitList) solutionLines.push(formatCommitLine(commit));
    solutionLines.push('');
  } else {
    solutionLines.push(`See the branch diff against \`${targetBranch || 'the target branch'}\`.`, '');
  }

  if (fileList.length > 0) {
    const shown = fileList.slice(0, MAX_CHANGED_FILES);
    const extra = fileList.length - shown.length;
    solutionLines.push('Changed files:');
    solutionLines.push('');
    for (const file of shown) solutionLines.push(`- \`${file}\``);
    if (extra > 0) solutionLines.push(`- …and ${extra} more`);
    solutionLines.push('');
  }

  const ticketLines = ['## Notion ticket', ''];
  if (url && title) ticketLines.push(`[${title}](${url})`, '');
  else if (url) ticketLines.push(url, '');
  else ticketLines.push('_No Notion ticket URL was found for this branch._', '');

  return [...contextLines, ...solutionLines, ...ticketLines].join('\n').trim() + '\n';
}

export async function buildTicketAwareMrDescription({
  workspace,
  rootWorkspace,
  branch,
  remote,
  targetBranch,
  runGit,
  pendingCommitMessage = '',
}) {
  const ticket = await resolveTicketContext({
    workspace,
    rootWorkspace: rootWorkspace || workspace,
    branch,
    worktreePath: workspace,
  });
  const changes = await collectBranchChanges({
    runGit,
    workspace,
    remote,
    targetBranch,
  });
  const pending = String(pendingCommitMessage || '').trim();
  const commits =
    pending && !changes.commits.some((commit) => commit.subject === pending)
      ? [{ hash: '', subject: pending, body: '' }, ...changes.commits]
      : changes.commits;
  return {
    ticket,
    commits,
    files: changes.files,
    title: buildDefaultMrTitle(ticket, branch, targetBranch),
    description: formatMrDescription({
      ticket,
      commits,
      files: changes.files,
      branch,
      targetBranch,
    }),
  };
}
