import { existsSync } from 'node:fs';
import type { Validator, ValidatorContext, ValidationResult } from './base.js';
import { resolveWithinRoot } from '../utils/path-security.js';

export class FileNotExistsValidator implements Validator {
  type = 'file_not_exists';

  async validate(
    config: Record<string, unknown>,
    context: ValidatorContext,
  ): Promise<ValidationResult> {
    const target = config.target as string;

    try {
      const resolvedPath = resolveWithinRoot(context.workingDirectory, target);
      const exists = existsSync(resolvedPath);

      return {
        type: this.type,
        target,
        passed: !exists,
        details: exists
          ? `Expected path to NOT exist: ${resolvedPath}`
          : undefined,
        optional: config.optional as boolean | undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: this.type,
        target,
        passed: false,
        details: `Error checking file existence: ${message}`,
        optional: config.optional as boolean | undefined,
      };
    }
  }
}
