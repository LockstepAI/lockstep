import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { LockstepReceipt } from '../core/hasher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a filename-safe ISO timestamp: replaces colons with hyphens.
 * Example: "2026-02-26T14-30-00.000Z"
 */
function safeTimestamp(): string {
  return new Date().toISOString().replace(/:/g, '-');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Writes a LockstepReceipt as formatted JSON to disk.
 *
 * @param receipt   - The completed receipt to serialize.
 * @param outputDir - Directory to write into.  Defaults to `.lockstep/`
 *                    relative to the current working directory.
 * @returns The absolute path of the written file.
 */
export function writeJsonReceipt(
  receipt: LockstepReceipt,
  outputDir?: string,
): string {
  const dir = outputDir ?? path.join(process.cwd(), '.lockstep');
  mkdirSync(dir, { recursive: true });

  const filename = `receipt-${safeTimestamp()}.json`;
  const filePath = path.join(dir, filename);

  writeFileSync(filePath, JSON.stringify(receipt, null, 2) + '\n', 'utf-8');

  return filePath;
}
