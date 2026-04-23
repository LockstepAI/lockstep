import type { LockstepReceipt } from './hasher.js';
import { writeJsonReceipt } from '../reporters/json-reporter.js';
import { writeMarkdownReport } from '../reporters/markdown-reporter.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates both the JSON receipt and the Markdown report for a completed
 * Lockstep run, writing them into the specified output directory (or the
 * default `.lockstep/` directory).
 *
 * @param receipt   - The completed receipt to persist.
 * @param outputDir - Directory to write files into.  Defaults to `.lockstep/`
 *                    relative to the current working directory.
 * @returns An object with the absolute paths of both generated files.
 */
export function generateReceiptFiles(
  receipt: LockstepReceipt,
  outputDir?: string,
): { jsonPath: string; markdownPath: string } {
  const jsonPath = writeJsonReceipt(receipt, outputDir);
  const markdownPath = writeMarkdownReport(receipt, outputDir);

  return { jsonPath, markdownPath };
}
