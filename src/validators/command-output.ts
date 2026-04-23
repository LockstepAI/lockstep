import { sha256 } from '../utils/crypto.js';
import { executeCommand } from './command-passes.js';
import type { Validator, ValidatorContext, ValidationResult } from './base.js';

const MAX_TRUNCATED_BYTES = 1024 * 1024; // 1 MB

function truncate(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, 'utf-8') <= maxBytes) return str;
  const buf = Buffer.from(str, 'utf-8');
  return buf.subarray(0, maxBytes).toString('utf-8') + '\n... [truncated]';
}

export class CommandOutputValidator implements Validator {
  type = 'command_output';

  async validate(
    config: Record<string, unknown>,
    context: ValidatorContext,
  ): Promise<ValidationResult> {
    const command = config.command as string;
    const pattern = config.pattern as string;
    const isRegex = config.is_regex as boolean | undefined;
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

      const exitCodePassed = result.exitCode === 0;

      let patternMatched: boolean;
      // Strip ANSI escape codes and trim whitespace for clean matching
      // eslint-disable-next-line no-control-regex
      const cleanStdout = result.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
      if (isRegex) {
        const regex = new RegExp(pattern, 'm');
        patternMatched = regex.test(cleanStdout);
      } else {
        patternMatched = cleanStdout.includes(pattern);
      }

      const passed = exitCodePassed && patternMatched;

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

        const reasons: string[] = [];
        if (!exitCodePassed) {
          reasons.push(`Command exited with code ${result.exitCode}`);
        }
        if (!patternMatched) {
          const preview = cleanStdout.slice(0, 200);
          reasons.push(
            `Stdout did not match pattern: ${isRegex ? `/${pattern}/` : JSON.stringify(pattern)}\n           stdout:\n           ${preview}`,
          );
        }
        validationResult.details = reasons.join('; ');
      }

      return validationResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: this.type,
        target: command,
        passed: false,
        details: `Error executing command: ${message}`,
        optional: config.optional as boolean | undefined,
      };
    }
  }
}
