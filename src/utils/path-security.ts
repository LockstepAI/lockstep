import path from 'node:path';

function normalizeRoot(root: string): string {
  return path.resolve(root);
}

export function toPortablePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export function resolveWithinRoot(root: string, requestedPath: string): string {
  const resolvedRoot = normalizeRoot(root);
  const resolvedPath = path.resolve(resolvedRoot, requestedPath);
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedPath;
  }

  throw new Error(`Path escapes working directory: ${requestedPath}`);
}

export function toRepoRelativePath(root: string, requestedPath: string): string {
  const resolvedRoot = normalizeRoot(root);
  const resolvedPath = resolveWithinRoot(resolvedRoot, requestedPath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  return toPortablePath(relative);
}

export function sanitizeTaskId(rawId: string, fallback = 'task'): string {
  const collapsed = rawId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const safeId = collapsed || fallback;
  return safeId.slice(0, 48).replace(/-+$/g, '') || fallback;
}

export function sanitizeFileExtension(
  extension: string | undefined,
  fallback: string,
): string {
  const trimmed = extension?.trim();
  if (!trimmed) {
    return fallback;
  }

  if (!/^\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(trimmed)) {
    throw new Error(`Invalid contracts_file_extension: ${trimmed}`);
  }

  return trimmed;
}

