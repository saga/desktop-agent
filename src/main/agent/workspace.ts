import fs from 'node:fs/promises';
import path from 'node:path';

export const SAFE_READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Skill',
  'AskUserQuestion',
  'TodoRead',
  'TaskGet',
]);

/**
 * Resolve a candidate against the canonical workspace and verify its real
 * filesystem location. This blocks ordinary symlink escapes, but not TOCTOU
 * races; process isolation or descriptor-relative access is still required.
 */
export async function isInsideWorkspace(root: string, candidate: string): Promise<boolean> {
  if (!candidate || candidate.startsWith('~')) return false;

  try {
    const canonicalRoot = await fs.realpath(path.resolve(root));
    const requestedPath = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(canonicalRoot, candidate);
    const canonicalTarget = await fs.realpath(requestedPath);
    const relative = path.relative(canonicalRoot, canonicalTarget);

    return relative === '' || (
      relative !== '..'
      && !relative.startsWith('..' + path.sep)
      && !path.isAbsolute(relative)
    );
  } catch {
    return false;
  }
}

/** Validate read-only SDK tool arguments before bypassing the SDK permission prompt. */
export async function isWorkspaceReadAllowed(
  root: string,
  toolName: string,
  toolInput: unknown,
): Promise<boolean> {
  if (!SAFE_READ_TOOLS.has(toolName)) return false;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return false;

  const input = toolInput as Record<string, unknown>;
  if (toolName === 'Glob') {
    const pattern = typeof input.pattern === 'string'
      ? input.pattern.replaceAll(String.fromCharCode(92), '/')
      : '';
    if (!pattern || pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)
      || pattern.split('/').includes('..')) return false;
  }

  if (toolName === 'Read') {
    const candidate = typeof input.file_path === 'string' ? input.file_path : input.path;
    return typeof candidate === 'string' && isInsideWorkspace(root, candidate);
  }

  for (const key of ['file_path', 'path', 'directory', 'search_path', 'cwd']) {
    if (!(key in input)) continue;
    const candidate = input[key];
    if (typeof candidate !== 'string' || !await isInsideWorkspace(root, candidate)) return false;
  }
  return true;
}
