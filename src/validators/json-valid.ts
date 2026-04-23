import { readFileSync } from 'node:fs';
import type { Validator, ValidatorContext, ValidationResult } from './base.js';
import { resolveWithinRoot } from '../utils/path-security.js';

export class JsonValidValidator implements Validator {
  type = 'json_valid';

  async validate(
    config: Record<string, unknown>,
    context: ValidatorContext,
  ): Promise<ValidationResult> {
    const filePath = config.path as string;
    const schema = config.schema as Record<string, unknown> | undefined;

    try {
      const resolvedPath = resolveWithinRoot(context.workingDirectory, filePath);
      const contents = readFileSync(resolvedPath, 'utf-8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch (parseErr) {
        const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
        return {
          type: this.type,
          target: filePath,
          passed: false,
          details: `Invalid JSON: ${message}`,
          optional: config.optional as boolean | undefined,
        };
      }

      // Basic schema validation: check that required keys exist
      if (schema && typeof schema === 'object') {
        const requiredKeys = schema.required;
        if (Array.isArray(requiredKeys) && typeof parsed === 'object' && parsed !== null) {
          const obj = parsed as Record<string, unknown>;
          const missingKeys = requiredKeys.filter(
            (key) => typeof key === 'string' && !(key in obj),
          );

          if (missingKeys.length > 0) {
            return {
              type: this.type,
              target: filePath,
              passed: false,
              details: `Missing required keys: ${missingKeys.join(', ')}`,
              optional: config.optional as boolean | undefined,
            };
          }
        }
      }

      return {
        type: this.type,
        target: filePath,
        passed: true,
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
