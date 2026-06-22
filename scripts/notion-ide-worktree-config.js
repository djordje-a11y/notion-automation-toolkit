import path from 'path';

export const DEFAULT_WORKTREE_DIR = '.notion/worktrees';

const CURSOR_COMPATIBLE_IDES = new Set(['', 'cursor', 'vscode']);

const JETBRAINS_IDES = new Set([
  'webstorm',
  'jetbrains',
  'idea',
  'intellij',
  'phpstorm',
  'pycharm',
  'goland',
  'rider',
  'clion',
  'rubymine',
  'datagrip',
  'fleet',
  'androidstudio',
]);

export function normalizeIdeName(raw) {
  return String(raw || '').trim().toLowerCase();
}

export function parseWorktreeDirByIdeMap(raw) {
  const map = {};
  const text = String(raw || '').trim();
  if (!text) return map;

  for (const part of text.split(',')) {
    const segment = part.trim();
    if (!segment) continue;
    const eqIndex = segment.indexOf('=');
    if (eqIndex <= 0) continue;
    const ide = normalizeIdeName(segment.slice(0, eqIndex));
    const dir = segment.slice(eqIndex + 1).trim();
    if (ide && dir) map[ide] = dir;
  }
  return map;
}

export function expandWorktreeDirTemplate(template, workspacePath) {
  const workspace = String(workspacePath || '').trim();
  const repoBasename = path.basename(workspace || 'repo');
  return String(template || '')
    .replace(/\{repo\}/g, repoBasename)
    .replace(/\{workspace\}/g, workspace);
}

function builtInWorktreeDirForIde(ide, workspacePath) {
  if (CURSOR_COMPATIBLE_IDES.has(ide)) {
    return DEFAULT_WORKTREE_DIR;
  }
  if (JETBRAINS_IDES.has(ide)) {
    const repoBasename = path.basename(String(workspacePath || '').trim() || 'repo');
    return `../${repoBasename}-worktrees`;
  }
  return DEFAULT_WORKTREE_DIR;
}

export function resolveWorktreeDir({
  workspacePath,
  ide = '',
  explicitWorktreeDir = '',
  worktreeDirByIde = '',
}) {
  const normalizedIde = normalizeIdeName(ide);
  const explicit = String(explicitWorktreeDir || '').trim();
  if (explicit) {
    return {
      worktreeDir: expandWorktreeDirTemplate(explicit, workspacePath),
      source: 'explicit',
      ide: normalizedIde,
    };
  }

  const byIdeMap = parseWorktreeDirByIdeMap(worktreeDirByIde);
  if (normalizedIde && byIdeMap[normalizedIde]) {
    return {
      worktreeDir: expandWorktreeDirTemplate(byIdeMap[normalizedIde], workspacePath),
      source: 'ide-map',
      ide: normalizedIde,
    };
  }

  if (normalizedIde) {
    return {
      worktreeDir: expandWorktreeDirTemplate(
        builtInWorktreeDirForIde(normalizedIde, workspacePath),
        workspacePath,
      ),
      source: JETBRAINS_IDES.has(normalizedIde) ? 'jetbrains-default' : 'ide-default',
      ide: normalizedIde,
    };
  }

  return {
    worktreeDir: DEFAULT_WORKTREE_DIR,
    source: 'default',
    ide: '',
  };
}
