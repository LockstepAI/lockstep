import { readFileSync } from 'node:fs';
import type { Validator, ValidatorContext, ValidationResult } from './base.js';
import { resolveWithinRoot } from '../utils/path-security.js';

export class FileContainsValidator implements Validator {
  type = 'file_contains';

  async validate(
    config: Record<string, unknown>,
    context: ValidatorContext,
  ): Promise<ValidationResult> {
    const filePath = config.path as string;
    const pattern = config.pattern as string;
    const isRegex = config.is_regex as boolean | undefined;

    try {
      const resolvedPath = resolveWithinRoot(context.workingDirectory, filePath);
      const contents = readFileSync(resolvedPath, 'utf-8');
      let matched: boolean;

      if (isRegex) {
        const regex = new RegExp(pattern, 'm');
        matched = regex.test(contents);
      } else {
        matched = contents.includes(pattern);
      }

      return {
        type: this.type,
        target: filePath,
        passed: matched,
        details: matched
          ? undefined
          : `Pattern not found in ${filePath}: ${isRegex ? `/${pattern}/` : JSON.stringify(pattern)}`,
        optional: config.optional as boolean | undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: this.type,
        target: filePath,
        passed: false,
        details: `Error reading file: ${message}`,
        optional: config.optional as boolean | undefined,
      };
    }
  }
}
