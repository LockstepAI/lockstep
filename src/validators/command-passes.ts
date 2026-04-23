import { exec } from 'node:child_process';
import { sha256 } from '../utils/crypto.js';
import type { Validator, ValidatorContext, ValidationResult } from './base.js';

const MAX_TRUNCATED_BYTES = 1024 * 1024; // 1 MB

export interface CommandExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandExecutionResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const child = exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024, // 50 MB
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime;
        const exitCode = error?.code !== undefined
          ? (typeof error.code === 'number' ? error.code : 1)
          : (child.exitCode ?? 0);

        resolve({
          exitCode,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          durationMs,
        });
      },
    );
  });
}

function truncate(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, 'utf-8') <= maxBytes) return str;
  const buf = Buffer.from(str, 'utf-8');
  return buf.subarray(0, maxBytes).toString('utf-8') + '\n... [truncated]';
}

export class CommandPassesValidator implements Validator {
  type = 'command_passes';

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
        validationResult.details = `Command exited with code ${result.exitCode}`;
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
