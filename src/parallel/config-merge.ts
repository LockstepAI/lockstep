import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Deterministic config file merging (CRDT-inspired)
// ---------------------------------------------------------------------------

const MERGEABLE_JSON_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
]);

/**
 * Checks if a file can be deterministically merged (JSON key-union).
 */
export function isDeterministicMergeable(filePath: string): boolean {
  const basename = path.basename(filePath);
  return MERGEABLE_JSON_FILES.has(basename);
}

/**
 * Deep-merges two JSON objects using key-union semantics.
 * - Objects: recursively merge keys (union)
 * - Arrays: union by value (deduplicated)
 * - Primitives: last writer wins (b takes precedence)
 */
export function deepMergeJSON(a: unknown, b: unknown): unknown {
  // If either is not an object, b wins
  if (a === null || b === null) return b;
  if (typeof a !== 'object' || typeof b !== 'object') return b;

  // Both arrays: union by value
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set<string>();
    const result: unknown[] = [];
    for (const item of [...a, ...b]) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
    return result;
  }

  // One array, one object: b wins
  if (Array.isArray(a) !== Array.isArray(b)) return b;

  // Both objects: recursive key-union
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  // Collect all keys from both
  const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);

  for (const key of allKeys) {
    if (key in aObj && key in bObj) {
      result[key] = deepMergeJSON(aObj[key], bObj[key]);
    } else if (key in bObj) {
      result[key] = bObj[key];
    } else {
      result[key] = aObj[key];
    }
  }

  return result;
}

/**
 * Merges a config file from two branch versions.
 * Reads the base version from `basePath` and the incoming version from `incomingPath`,
 * produces a deterministically merged result, and writes it to `outputPath`.
 *
 * Returns true if merge was successful, false if files aren't valid JSON.
 */
export async function mergeConfigFile(
  basePath: string,
  incomingPath: string,
  outputPath: string,
): Promise<boolean> {
  try {
    const baseContent = await readFile(basePath, 'utf-8');
    const incomingContent = await readFile(incomingPath, 'utf-8');

    const baseJSON = JSON.parse(baseContent);
    const incomingJSON = JSON.parse(incomingContent);

    const merged = deepMergeJSON(baseJSON, incomingJSON);
    const mergedContent = JSON.stringify(merged, null, 2) + '\n';

    await writeFile(outputPath, mergedContent, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-merges all deterministically mergeable config files between
 * the main repo and a worker's worktree. This runs BEFORE git merge
 * to eliminate a class of config conflicts entirely.
 *
 * Returns the list of files that were pre-merged.
 */
export async function preMergeConfigFiles(
  repoPath: string,
  worktreePath: string,
  modifiedFiles: string[],
): Promise<string[]> {
  const preMerged: string[] = [];

  for (const file of modifiedFiles) {
    if (!isDeterministicMergeable(file)) continue;

    const basePath = path.join(repoPath, file);
    const incomingPath = path.join(worktreePath, file);

    const success = await mergeConfigFile(basePath, incomingPath, basePath);
    if (success) {
      preMerged.push(file);
    }
  }

  return preMerged;
}
