import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { SpecValidationError } from '../utils/errors.js';
import { canonicalizeSpecInput } from './public-surface.js';

// ---------------------------------------------------------------------------
// Validator schemas (discriminated union on `type`)
// ---------------------------------------------------------------------------

const FileExistsValidator = z.object({
  type: z.literal('file_exists'),
  target: z.string(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
});

const FileNotExistsValidator = z.object({
  type: z.literal('file_not_exists'),
  target: z.string(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
});

const FileContainsValidator = z.object({
  type: z.literal('file_contains'),
  path: z.string(),
  pattern: z.string(),
  is_regex: z.boolean().optional(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
});

const FileNotContainsValidator = z.object({
  type: z.literal('file_not_contains'),
  path: z.string(),
  pattern: z.string(),
  is_regex: z.boolean().optional(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
});

const CommandPassesValidator = z.object({
  type: z.literal('command_passes'),
  command: z.string(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
  timeout: z.number().optional(),
});

const CommandOutputValidator = z.object({
  type: z.literal('command_output'),
  command: z.string(),
  pattern: z.string(),
  is_regex: z.boolean().optional(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
  timeout: z.number().optional(),
});

const ApiRespondsValidator = z.object({
  type: z.literal('api_responds'),
  url: z.string(),
  status: z.number(),
  body_contains: z.string().optional(),
  timeout: z.number().optional(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
});

const JsonValidValidator = z.object({
  type: z.literal('json_valid'),
  path: z.string(),
  schema: z.unknown().optional(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
});

const TypeCheckValidator = z.object({
  type: z.literal('type_check'),
  command: z.string().optional(),
  timeout: z.number().optional(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
});

const LintPassesValidator = z.object({
  type: z.literal('lint_passes'),
  command: z.string().optional(),
  timeout: z.number().optional(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
});

const TestPassesValidator = z.object({
  type: z.literal('test_passes'),
  command: z.string(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
  timeout: z.number().optional(),
});

const AiJudgeValidator = z.object({
  type: z.literal('ai_judge'),
  criteria: z.string().min(1, 'ai_judge criteria must be a non-empty string'),
  threshold: z.number(),
  max_variance: z.number().optional(),
  rubric: z.boolean().optional(),
  evaluation_method: z.literal('file_content').default('file_content'),
  evaluation_targets: z.array(z.string()).optional(),
  timeout: z.number().optional(),
  description: z.string().optional(),
  label: z.string().optional(),
  optional: z.boolean().optional(),
});

const ValidatorSchema = z.discriminatedUnion('type', [
  FileExistsValidator,
  FileNotExistsValidator,
  FileContainsValidator,
  FileNotContainsValidator,
  CommandPassesValidator,
  CommandOutputValidator,
  ApiRespondsValidator,
  JsonValidValidator,
  TypeCheckValidator,
  LintPassesValidator,
  TestPassesValidator,
  AiJudgeValidator,
]);

// ---------------------------------------------------------------------------
// Step schema
// ---------------------------------------------------------------------------

const StepSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  model: z.string().optional(),
  timeout: z.number().optional(),
  retries: z.number().optional(),
  pre_commands: z.array(z.string()).optional(),
  post_commands: z.array(z.string()).optional(),
  validate: z.array(ValidatorSchema).min(1),
});

// ---------------------------------------------------------------------------
// Parallel execution config
// ---------------------------------------------------------------------------

const ParallelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  max_concurrency: z.number().default(10),
  decomposition_hint: z.string().optional(),
  symlink_directories: z.array(z.string()).default(['node_modules']),
  language: z.string().optional(),
  test_first: z.boolean().optional(),
  repo_map: z.boolean().optional(),
  dynamic_routing: z.boolean().optional(),
  speculative_architect: z.boolean().optional(),
  best_of_n: z.number().optional(),
  merge_tree: z.boolean().optional(),
  entity_ownership: z.boolean().optional(),
  max_test_iterations: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  agent: z.string().default('codex'),
  agent_model: z.string().optional(),
  effort_level: z.enum(['low', 'medium', 'high', 'max']).optional(),
  execution_mode: z.enum(['standard', 'yolo']).optional(),
  judge_model: z.string().optional(),
  judge_mode: z.enum(['codex', 'claude']).optional(),
  claude_auth_mode: z.enum([
    'auto',
    'interactive',
    'api-key',
    'auth-token',
    'oauth-token',
    'bedrock',
    'vertex',
    'foundry',
  ]).optional(),
  max_retries: z.number().default(3),
  step_timeout: z.number().default(300),
  working_directory: z.string().default('.'),
  env_file: z.string().optional(),
  parallel: ParallelConfigSchema.optional().default({}),
});

// ---------------------------------------------------------------------------
// Top-level spec schema
// ---------------------------------------------------------------------------

const LockstepSpecSchema = z.object({
  version: z.literal('1'),
  config: ConfigSchema.optional().default({}),
  context: z.string().optional(),
  steps: z
    .array(StepSchema)
    .min(1)
    .superRefine((steps, ctx) => {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const hasNonAiJudge = step.validate.some((v) => v.type !== 'ai_judge');
        if (!hasNonAiJudge) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'ai_judge cannot be the only validator. Add at least one structural or functional check.',
            path: [i, 'validate'],
          });
        }
      }
    }),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type LockstepSpec = z.infer<typeof LockstepSpecSchema>;
export type LockstepStep = z.infer<typeof StepSchema>;
export type LockstepValidator = z.infer<typeof ValidatorSchema>;
export type LockstepConfig = z.infer<typeof ConfigSchema>;

// Re-export the schemas for external use
export {
  LockstepSpecSchema,
  StepSchema,
  ValidatorSchema,
  ConfigSchema,
  ParallelConfigSchema,
  AiJudgeValidator,
};

// ---------------------------------------------------------------------------
// Error formatting helpers
// ---------------------------------------------------------------------------

function formatZodIssues(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  ${path}: ${issue.message}`;
  });
}

function normalizePathFragment(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '') {
    return '.';
  }
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function stripWorkingDirectoryPrefix(targetPath: string, workingDirectory: string): string {
  const normalizedWorkspace = normalizePathFragment(workingDirectory);
  if (normalizedWorkspace === '.') {
    return normalizePathFragment(targetPath);
  }

  const normalizedTarget = normalizePathFragment(targetPath);
  if (normalizedTarget === normalizedWorkspace) {
    return '.';
  }

  const workspacePrefix = `${normalizedWorkspace}/`;
  if (normalizedTarget.startsWith(workspacePrefix)) {
    return normalizedTarget.slice(workspacePrefix.length);
  }

  return normalizedTarget;
}

function normalizeValidatorPaths(
  validator: LockstepValidator,
  workingDirectory: string,
): LockstepValidator {
  switch (validator.type) {
    case 'file_exists':
    case 'file_not_exists':
      return {
        ...validator,
        target: stripWorkingDirectoryPrefix(validator.target, workingDirectory),
      };
    case 'file_contains':
    case 'file_not_contains':
    case 'json_valid':
      return {
        ...validator,
        path: stripWorkingDirectoryPrefix(validator.path, workingDirectory),
      };
    case 'ai_judge':
      return {
        ...validator,
        evaluation_targets: validator.evaluation_targets?.map((target) =>
          stripWorkingDirectoryPrefix(target, workingDirectory),
        ),
      };
    default:
      return validator;
  }
}

export function normalizeSpecWorkingDirectoryPaths(spec: LockstepSpec): LockstepSpec {
  const workingDirectory = spec.config.working_directory;
  if (!workingDirectory || normalizePathFragment(workingDirectory) === '.') {
    return spec;
  }

  return {
    ...spec,
    config: {
      ...spec.config,
      working_directory: normalizePathFragment(workingDirectory),
    },
    steps: spec.steps.map((step) => ({
      ...step,
      validate: step.validate.map((validator) => normalizeValidatorPaths(validator, workingDirectory)),
    })),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads a `.lockstep.yml` file, parses it as YAML, validates it against
 * the Lockstep spec schema, and returns the fully validated spec object.
 *
 * @throws {SpecValidationError} when the file cannot be read or the
 *   content fails schema validation.
 */
export function parseSpec(filePath: string): LockstepSpec {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SpecValidationError(`Failed to read spec file: ${filePath}`, [msg]);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SpecValidationError(`Failed to parse YAML in ${filePath}`, [msg]);
  }

  const result = LockstepSpecSchema.safeParse(canonicalizeSpecInput(parsed));

  if (!result.success) {
    const details = formatZodIssues(result.error.issues);
    throw new SpecValidationError(
      `Spec validation failed for ${filePath} (${result.error.issues.length} issue${result.error.issues.length === 1 ? '' : 's'})`,
      details,
    );
  }

  return normalizeSpecWorkingDirectoryPaths(result.data);
}

/**
 * Validates a `.lockstep.yml` file without throwing. Returns an object
 * indicating whether the spec is valid and, if not, a list of
 * human-readable error strings.
 */
export function validateSpec(filePath: string): { valid: boolean; errors?: string[] } {
  try {
    parseSpec(filePath);
    return { valid: true };
  } catch (err) {
    if (err instanceof SpecValidationError) {
      return {
        valid: false,
        errors: err.details ?? [err.message],
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, errors: [msg] };
  }
}
