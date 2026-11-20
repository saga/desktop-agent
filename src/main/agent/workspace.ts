import fs from 'node:fs/promises';
import path from 'node:path';

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
