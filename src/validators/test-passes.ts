import { sha256 } from '../utils/crypto.js';
import { executeCommand } from './command-passes.js';
import type { Validator, ValidatorContext, ValidationResult } from './base.js';

const MAX_TRUNCATED_BYTES = 1024 * 1024; // 1 MB

function truncate(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, 'utf-8') <= maxBytes) return str;
  const buf = Buffer.from(str, 'utf-8');
  return buf.subarray(0, maxBytes).toString('utf-8') + '\n... [truncated]';
}

export class TestPassesValidator implements Validator {
  type = 'test_passes';

  async validate(
    config: Record<string, unknown>,
    context: ValidatorContext,
  ): Promise<ValidationResult> {
    const command = config.command as string;
    const timeoutSec = (config.timeout as number | undefined)
      ?? context.stepTimeout
      ?? 300;
    const timeoutMs = timeoutSec * 1000;

    try {
      const result = await executeCommand(
        command,
        context.workingDirectory,
        timeoutMs,
      );

      const passed = result.exitCode === 0;

      const validationResult: ValidationResult = {
        type: this.type,
        target: command,
        passed,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
        stdout_hash: sha256(result.stdout),
        stderr_hash: sha256(result.stderr),
        optional: config.optional as boolean | undefined,
      };

      if (!passed) {
        validationResult.stdout_truncated = truncate(result.stdout, MAX_TRUNCATED_BYTES);
        validationResult.stderr_truncated = truncate(result.stderr, MAX_TRUNCATED_BYTES);
        validationResult.details = `Tests failed with exit code ${result.exitCode}`;
      }

      return validationResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: this.type,
        target: command,
        passed: false,
        details: `Error running tests: ${message}`,
        optional: config.optional as boolean | undefined,
      };
    }
  }
}
