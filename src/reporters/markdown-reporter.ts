import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { LockstepReceipt, StepProof } from '../core/hasher.js';
import type { ValidationResult } from '../validators/base.js';
import { getPublicSignalName } from '../core/public-surface.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a filename-safe ISO timestamp: replaces colons with hyphens.
 */
function safeTimestamp(): string {
  return new Date().toISOString().replace(/:/g, '-');
}

/**
 * Converts a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Computes total elapsed time from the receipt's started_at / completed_at.
 */
function computeTotalTime(receipt: LockstepReceipt): string {
  const start = new Date(receipt.started_at).getTime();
  const end = new Date(receipt.completed_at).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return 'N/A';
  }
  return formatDuration(end - start);
}

/**
 * Returns the total number of attempts across all step proofs.
 */
function totalAttempts(receipt: LockstepReceipt): number {
  let count = 0;
  for (const proof of receipt.step_proofs) {
    count += proof.attempts.length;
  }
  return count;
}

/**
 * Status badge for the report header.
 */
function statusBadge(status: LockstepReceipt['status']): string {
  switch (status) {
    case 'completed':
      return '\u2705 Completed';
    case 'failed':
      return '\u274C Failed';
    case 'partial':
      return '\u26A0\uFE0F Partial';
  }
}

/**
 * Per-step status icon.
 */
function stepIcon(proof: StepProof): string {
  return proof.all_passed ? '\u2705' : '\u274C';
}

/**
 * Format a single validation result as a markdown list item.
 */
function formatValidation(v: ValidationResult): string {
  const signalName = getPublicSignalName(v.type);
  if (v.passed) {
    return `- \u2705 \`${signalName}\` ${v.target}${v.details ? ': ' + v.details : ''}`;
  }
  if (v.optional) {
    return `- \u26A0\uFE0F \`${signalName}\` ${v.target} *(optional)* ${v.details ? ': ' + v.details : ''}`;
  }
  return `- \u274C \`${signalName}\` ${v.target}${v.details ? ': ' + v.details : ''}`;
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function buildMarkdown(receipt: LockstepReceipt, receiptPath: string): string {
  const lines: string[] = [];

  // Title
  lines.push('# \uD83D\uDD12 Lockstep Verification Report');
  lines.push('');

  // Metadata
  lines.push(`**Spec:** ${receipt.spec_file}`);
  lines.push(`**Agent:** ${receipt.agent}`);
  lines.push(`**Date:** ${receipt.completed_at}`);
  lines.push(`**Status:** ${statusBadge(receipt.status)}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total Phases | ${receipt.total_steps} |`);
  lines.push(`| Passed | ${receipt.steps_passed} |`);
  lines.push(`| Failed | ${receipt.steps_failed} |`);
  lines.push(`| Total Attempts | ${totalAttempts(receipt)} |`);
  lines.push(`| Total Time | ${computeTotalTime(receipt)} |`);
  lines.push(`| Chain Hash | \`${receipt.chain_hash}\` |`);
  lines.push('');

  // Step details
  lines.push('## Phase Details');
  lines.push('');

  for (const proof of receipt.step_proofs) {
    lines.push(`### Phase ${proof.step_index + 1}: ${proof.step_name} ${stepIcon(proof)}`);
    lines.push('');
    lines.push(`- **Hash:** \`${proof.step_hash}\``);
    lines.push(`- **Attempts:** ${proof.attempts.length}`);

    // Use the final attempt's validations for the summary
    const finalAttempt = proof.attempts[proof.attempts.length - 1];
    if (finalAttempt) {
      const passed = finalAttempt.validations.filter((v) => v.passed).length;
      const total = finalAttempt.validations.length;
      lines.push(`- **Signals:** ${passed}/${total} passed`);
      lines.push('');
      for (const v of finalAttempt.validations) {
        lines.push(formatValidation(v));
      }
    }

    lines.push('');
  }

  // Verification instructions
  lines.push('## Verification');
  lines.push('');
  lines.push('To verify this receipt:');
  lines.push('');
  lines.push('```bash');
  lines.push(`lockstep verify ${receiptPath}`);
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a human-readable Markdown report from a LockstepReceipt and
 * writes it to disk.
 *
 * @param receipt   - The completed receipt to report on.
 * @param outputDir - Directory to write into.  Defaults to `.lockstep/`
 *                    relative to the current working directory.
 * @returns The absolute path of the written file.
 */
export function writeMarkdownReport(
  receipt: LockstepReceipt,
  outputDir?: string,
): string {
  const dir = outputDir ?? path.join(process.cwd(), '.lockstep');
  mkdirSync(dir, { recursive: true });

  const filename = `report-${safeTimestamp()}.md`;
  const filePath = path.join(dir, filename);

  // Build the receipt JSON path (co-located, same timestamp base is fine
  // since the caller generates both together)
  const receiptJsonPath = filePath.replace(/report-/, 'receipt-').replace(/\.md$/, '.json');

  const markdown = buildMarkdown(receipt, receiptJsonPath);
  writeFileSync(filePath, markdown, 'utf-8');

  return filePath;
}
