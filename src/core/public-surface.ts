type JsonObject = Record<string, unknown>;

const PUBLIC_TO_INTERNAL_SIGNAL: Record<string, string> = {
  artifact_ready: 'file_exists',
  artifact_absent: 'file_not_exists',
  artifact_match: 'file_contains',
  artifact_clean: 'file_not_contains',
  execution_ok: 'command_passes',
  execution_match: 'command_output',
  service_ok: 'api_responds',
  artifact_structured: 'json_valid',
  integrity_ok: 'type_check',
  quality_ok: 'lint_passes',
  verification_ok: 'test_passes',
  review_ok: 'ai_judge',
};

const INTERNAL_TO_PUBLIC_SIGNAL: Record<string, string> = {
  file_exists: 'artifact_ready',
  file_not_exists: 'artifact_absent',
  file_contains: 'artifact_match',
  file_not_contains: 'artifact_clean',
  command_passes: 'execution_ok',
  command_output: 'execution_match',
  api_responds: 'service_ok',
  json_valid: 'artifact_structured',
  type_check: 'integrity_ok',
  lint_passes: 'quality_ok',
  test_passes: 'verification_ok',
  ai_judge: 'review_ok',
};

const CONFIG_FIELD_ALIASES: Record<string, string> = {
  runner: 'agent',
  runner_model: 'agent_model',
  autonomy: 'execution_mode',
  review_model: 'judge_model',
  review_mode: 'judge_mode',
  effort_budget: 'max_retries',
  phase_timeout: 'step_timeout',
  workspace: 'working_directory',
};

const STEP_FIELD_ALIASES: Record<string, string> = {
  signals: 'validate',
  effort: 'retries',
  window_seconds: 'timeout',
  preflight: 'pre_commands',
  postflight: 'post_commands',
};

const VALIDATOR_FIELD_ALIASES: Record<string, string> = {
  signal: 'type',
  probe: 'command',
  endpoint: 'url',
  status_code: 'status',
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyFieldAliases(source: JsonObject, aliases: Record<string, string>): JsonObject {
  const result = { ...source };

  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias in result && !(canonical in result)) {
      result[canonical] = result[alias];
    }
  }

  return result;
}

export function canonicalizeValidatorType(type: string | undefined): string | undefined {
  if (!type) return type;
  return PUBLIC_TO_INTERNAL_SIGNAL[type] ?? type;
}

export function getPublicSignalName(type: string | undefined): string {
  const canonicalType = canonicalizeValidatorType(type);
  if (!canonicalType) return 'unknown_signal';
  return INTERNAL_TO_PUBLIC_SIGNAL[canonicalType] ?? canonicalType;
}

export function canonicalizeValidatorConfig(raw: unknown): unknown {
  if (!isObject(raw)) {
    return raw;
  }

  const validator = applyFieldAliases(raw, VALIDATOR_FIELD_ALIASES);
  const type = canonicalizeValidatorType(typeof validator.type === 'string' ? validator.type : undefined);

  if (type) {
    validator.type = type;
  }

  if ('artifact' in raw) {
    const artifact = raw.artifact;
    if ((type === 'file_exists' || type === 'file_not_exists') && !('target' in validator)) {
      validator.target = artifact;
    }
    if (
      (type === 'file_contains' || type === 'file_not_contains' || type === 'json_valid')
      && !('path' in validator)
    ) {
      validator.path = artifact;
    }
  }

  if ('expect' in raw) {
    const expect = raw.expect;
    if ((type === 'file_contains' || type === 'file_not_contains' || type === 'command_output') && !('pattern' in validator)) {
      validator.pattern = expect;
    }
    if (type === 'api_responds' && !('body_contains' in validator)) {
      validator.body_contains = expect;
    }
  }

  return validator;
}

export function canonicalizeStepInput(raw: unknown): unknown {
  if (!isObject(raw)) {
    return raw;
  }

  const step = applyFieldAliases(raw, STEP_FIELD_ALIASES);

  if (Array.isArray(step.validate)) {
    step.validate = step.validate.map((validator) => canonicalizeValidatorConfig(validator));
  }

  return step;
}

export function canonicalizeSpecInput(raw: unknown): unknown {
  if (!isObject(raw)) {
    return raw;
  }

  const spec = { ...raw };

  if ('brief' in spec && !('context' in spec)) {
    spec.context = spec.brief;
  }

  if ('phases' in spec && !('steps' in spec)) {
    spec.steps = spec.phases;
  }

  if (isObject(spec.config)) {
    spec.config = applyFieldAliases(spec.config, CONFIG_FIELD_ALIASES);
  }

  if (Array.isArray(spec.steps)) {
    spec.steps = spec.steps.map((step) => canonicalizeStepInput(step));
  }

  return spec;
}

export const LAUNCH_RUNNERS = ['codex', 'claude'] as const;
