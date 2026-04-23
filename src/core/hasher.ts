import { hashObject } from '../utils/crypto.js';
import type { ValidationResult } from '../validators/base.js';
import { canonicalizeValidatorType } from './public-surface.js';

// ---------------------------------------------------------------------------
// Receipt / proof interfaces
// ---------------------------------------------------------------------------

export interface AttemptRecord {
  attempt_number: number;
  prompt_hash: string;
  agent_stdout_hash: string;
  agent_stderr_hash: string;
  validations: ValidationResult[];
  all_required_passed: boolean;
  started_at: string;
  completed_at: string;
}

export interface StepProof {
  step_index: number;
  step_name: string;
  criteria_hash: string;
  attempts: AttemptRecord[];
  final_attempt: number;
  all_passed: boolean;
  previous_step_hash: string;
  step_hash: string;
}

export interface LockstepReceipt {
  version: "1";
  hash_algorithm: "sha256";
  canonicalization: "json-stable-stringify";
  lockstep_version: string;
  node_version: string;
  platform: string;
  runner_cli_version: string;
  spec_file: string;
  spec_hash: string;
  agent: string;
  judge_model: string;
  judge_mode: string;
  judge_runs: number;
  started_at: string;
  completed_at: string;
  total_steps: number;
  steps_passed: number;
  steps_failed: number;
  step_proofs: StepProof[];
  chain_hash: string;
  status: "completed" | "failed" | "partial";
}

// ---------------------------------------------------------------------------
// Validator field whitelists — ONLY these keys survive normalization
// ---------------------------------------------------------------------------

const VALIDATOR_FIELD_WHITELIST: Record<string, readonly string[]> = {
  file_exists:      ['type', 'target', 'optional'],
  file_not_exists:  ['type', 'target', 'optional'],
  file_contains:    ['type', 'path', 'pattern', 'is_regex', 'optional'],
  file_not_contains:['type', 'path', 'pattern', 'is_regex', 'optional'],
  command_passes:   ['type', 'command', 'timeout', 'optional'],
  command_output:   ['type', 'command', 'pattern', 'is_regex', 'timeout', 'optional'],
  api_responds:     ['type', 'url', 'status', 'body_contains', 'timeout', 'optional'],
  json_valid:       ['type', 'path', 'schema', 'optional'],
  type_check:       ['type', 'command', 'timeout', 'optional'],
  lint_passes:      ['type', 'command', 'timeout', 'optional'],
  test_passes:      ['type', 'command', 'timeout', 'optional'],
  ai_judge:         ['type', 'criteria', 'threshold', 'max_variance', 'rubric', 'evaluation_method', 'evaluation_targets', 'timeout', 'optional'],
};

// ---------------------------------------------------------------------------
// Field defaults to materialize during normalization
// ---------------------------------------------------------------------------

const FIELD_DEFAULTS: Record<string, unknown> = {
  optional: false,
  is_regex: false,
  max_variance: null,
  rubric: false,
  evaluation_method: 'file_content',
  timeout: null,
  schema: null,
  body_contains: null,
};

// Non-semantic fields that are always stripped (for unknown validator types)
const NON_SEMANTIC_FIELDS = new Set(['label', 'description']);

// ---------------------------------------------------------------------------
// Criteria normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes an array of validator definitions for deterministic hashing.
 *
 * For each validator:
 * 1. Only whitelisted keys are retained (stripping `label`, `description`,
 *    and any other non-semantic fields).
 * 2. Missing keys that have a known default are materialized with that default.
 * 3. For unknown validator types, all fields survive except `label` and
 *    `description`, and known defaults are still materialized.
 */
export function normalizeCriteria(
  validators: Record<string, unknown>[],
): Record<string, unknown>[] {
  return validators.map((validator) => {
    const type = canonicalizeValidatorType(validator.type as string | undefined) ?? 'unknown';
    const whitelist = VALIDATOR_FIELD_WHITELIST[type];

    let normalized: Record<string, unknown>;

    if (whitelist) {
      // Known type: pick only whitelisted fields
      normalized = {};
      for (const key of whitelist) {
        if (key in validator) {
          normalized[key] = key === 'type' ? type : validator[key];
        } else if (key in FIELD_DEFAULTS) {
          // Materialize default for missing whitelisted field
          normalized[key] = FIELD_DEFAULTS[key];
        }
      }
    } else {
      // Unknown type: include everything except non-semantic fields
      normalized = {};
      for (const [key, value] of Object.entries(validator)) {
        if (!NON_SEMANTIC_FIELDS.has(key)) {
          normalized[key] = key === 'type' ? type : value;
        }
      }
      // Materialize defaults for any known default fields that are missing
      for (const [key, defaultValue] of Object.entries(FIELD_DEFAULTS)) {
        if (!(key in normalized) && key !== 'type') {
          // Only materialize defaults that are relevant — skip if the field
          // isn't in the whitelist for any known type and wasn't present.
          // For unknown types, we conservatively materialize `optional` only.
          if (key === 'optional') {
            normalized[key] = defaultValue;
          }
        }
      }
    }

    return normalized;
  });
}

// ---------------------------------------------------------------------------
// Hashing functions
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic hash over the normalized criteria array.
 * This hash represents "what must pass" for a step, independent of
 * cosmetic fields like labels or descriptions.
 */
export function computeCriteriaHash(
  validators: Record<string, unknown>[],
): string {
  const normalized = normalizeCriteria(validators);
  return hashObject(normalized);
}

/**
 * Computes the `step_hash` for a StepProof by hashing all fields of the
 * proof except for `step_hash` itself.
 */
export function computeStepHash(proof: StepProof): string {
  // Destructure out step_hash, hash everything else
  const { step_hash: _, ...hashable } = proof;
  return hashObject(hashable);
}
