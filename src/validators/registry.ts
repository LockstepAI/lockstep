import type { Validator, ValidatorContext, ValidationResult } from './base.js';
import type { JudgeConfig } from './ai-judge.js';

import { FileExistsValidator } from './file-exists.js';
import { FileNotExistsValidator } from './file-not-exists.js';
import { FileContainsValidator } from './file-contains.js';
import { FileNotContainsValidator } from './file-not-contains.js';
import { CommandPassesValidator } from './command-passes.js';
import { CommandOutputValidator } from './command-output.js';
import { ApiRespondsValidator } from './api-responds.js';
import { JsonValidValidator } from './json-valid.js';
import { TypeCheckValidator } from './type-check.js';
import { LintPassesValidator } from './lint-passes.js';
import { TestPassesValidator } from './test-passes.js';
import { AiJudgeValidator } from './ai-judge.js';
import { canonicalizeValidatorType } from '../core/public-surface.js';

// ---------------------------------------------------------------------------
// Validator registry
// ---------------------------------------------------------------------------

const validatorMap = new Map<string, Validator>();

// Register all built-in validators
validatorMap.set('file_exists', new FileExistsValidator());
validatorMap.set('file_not_exists', new FileNotExistsValidator());
validatorMap.set('file_contains', new FileContainsValidator());
validatorMap.set('file_not_contains', new FileNotContainsValidator());
validatorMap.set('command_passes', new CommandPassesValidator());
validatorMap.set('command_output', new CommandOutputValidator());
validatorMap.set('api_responds', new ApiRespondsValidator());
validatorMap.set('json_valid', new JsonValidValidator());
validatorMap.set('type_check', new TypeCheckValidator());
validatorMap.set('lint_passes', new LintPassesValidator());
validatorMap.set('test_passes', new TestPassesValidator());
// ai_judge is registered with a default config; runValidation overrides it when judgeConfig is provided
validatorMap.set('ai_judge', new AiJudgeValidator());

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the Validator implementation for the given type string.
 *
 * @throws Error if the type is not registered.
 */
export function getValidator(type: string): Validator {
  const canonicalType = canonicalizeValidatorType(type) ?? type;
  const validator = validatorMap.get(canonicalType);
  if (!validator) {
    throw new Error(`Unknown validator type: ${type}`);
  }
  return validator;
}

/**
 * Runs a single validation using the validator config object (which must include a `type` field).
 *
 * For `ai_judge` validators, the optional `judgeConfig` parameter is forwarded
 * to configure the judge mode and model.
 */
export async function runValidation(
  validatorConfig: Record<string, unknown>,
  context: ValidatorContext,
  judgeConfig?: JudgeConfig,
): Promise<ValidationResult> {
  const type = canonicalizeValidatorType(validatorConfig.type as string | undefined) as string | undefined;

  if (!type) {
    return {
      type: 'unknown',
      target: 'unknown',
      passed: false,
      details: 'Signal config missing "type" or "signal" field',
    };
  }

  try {
    // For ai_judge, create a fresh instance with the provided judgeConfig
    if (type === 'ai_judge') {
      const aiJudge = new AiJudgeValidator(judgeConfig);
      return await aiJudge.validate({ ...validatorConfig, type }, context);
    }

    const validator = getValidator(type);
    return await validator.validate({ ...validatorConfig, type }, context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      type,
      target: (validatorConfig.target as string)
        ?? (validatorConfig.artifact as string)
        ?? (validatorConfig.command as string)
        ?? (validatorConfig.probe as string)
        ?? (validatorConfig.path as string)
        ?? (validatorConfig.endpoint as string)
        ?? (validatorConfig.url as string)
        ?? 'unknown',
      passed: false,
      details: `Signal error: ${message}`,
      optional: validatorConfig.optional as boolean | undefined,
    };
  }
}
