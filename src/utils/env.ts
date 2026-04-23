const VALID_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

export type RunnerEffortLevel = (typeof VALID_EFFORT_LEVELS)[number];
export type CodexReasoningEffort = (typeof VALID_REASONING_EFFORTS)[number];

function isRunnerEffortLevel(value: string | undefined): value is RunnerEffortLevel {
  return value !== undefined && VALID_EFFORT_LEVELS.includes(value as RunnerEffortLevel);
}

function isCodexReasoningEffort(value: string | undefined): value is CodexReasoningEffort {
  return value !== undefined && VALID_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
}

export function resolveRunnerEffortLevel(
  configEffortLevel?: string,
): RunnerEffortLevel {
  if (isRunnerEffortLevel(configEffortLevel)) {
    return configEffortLevel;
  }

  const envEffortLevel = (
    process.env.LOCKSTEP_EFFORT_LEVEL
    ?? process.env.CLAUDE_CODE_EFFORT_LEVEL
  )?.trim();
  if (isRunnerEffortLevel(envEffortLevel)) {
    return envEffortLevel;
  }

  return 'medium';
}

/**
 * Build a clean environment for child runner processes.
 * Some legacy CLIs inherit nested-session guard env vars; strip those so
 * Lockstep can launch a fresh subprocess predictably.
 */
export function cleanEnv(configEffortLevel?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE' || key === 'CLAUDE_CODE_ENTRYPOINT') continue;
    if (value !== undefined) env[key] = value;
  }
  env['LOCKSTEP_EFFORT_LEVEL'] = resolveRunnerEffortLevel(configEffortLevel);
  return env;
}

export const DEFAULT_GENERATE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_GENERATE_MAX_ATTEMPTS = 3;
export const DEFAULT_GENERATE_MODEL = 'gpt-5.4-mini';
export const DEFAULT_GENERATE_REASONING_EFFORT: CodexReasoningEffort = 'medium';
export const DEFAULT_JUDGE_REASONING_EFFORT: CodexReasoningEffort = 'medium';

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function normalizePositiveInteger(
  value: number | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return Math.trunc(value);
}

export function getGenerateTimeoutMs(timeoutMs?: number): number {
  const normalized = normalizePositiveInteger(timeoutMs, 'Generate timeout');
  if (normalized !== undefined) {
    return normalized;
  }

  return readPositiveIntegerEnv('LOCKSTEP_GENERATE_TIMEOUT_MS') ?? DEFAULT_GENERATE_TIMEOUT_MS;
}

export function getGenerateMaxAttempts(maxAttempts?: number): number {
  const normalized = normalizePositiveInteger(maxAttempts, 'Generate max attempts');
  if (normalized !== undefined) {
    return normalized;
  }

  return readPositiveIntegerEnv('LOCKSTEP_GENERATE_MAX_ATTEMPTS') ?? DEFAULT_GENERATE_MAX_ATTEMPTS;
}

export function getGenerateModel(model?: string): string {
  const explicit = model?.trim();
  if (explicit) {
    return explicit;
  }

  return process.env.LOCKSTEP_GENERATE_MODEL?.trim() || DEFAULT_GENERATE_MODEL;
}

export function getGenerateReasoningEffort(
  effort?: string,
): CodexReasoningEffort {
  const explicit = effort?.trim();
  if (isCodexReasoningEffort(explicit)) {
    return explicit;
  }

  const fromEnv = process.env.LOCKSTEP_GENERATE_REASONING_EFFORT?.trim();
  if (isCodexReasoningEffort(fromEnv)) {
    return fromEnv;
  }

  return DEFAULT_GENERATE_REASONING_EFFORT;
}

function normalizeJudgeEffort(
  effort?: string,
): CodexReasoningEffort | undefined {
  if (isCodexReasoningEffort(effort)) {
    return effort;
  }

  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    return effort;
  }

  if (effort === 'max') {
    return 'high';
  }

  return undefined;
}

export function getJudgeModel(model?: string): string | undefined {
  const explicit = model?.trim();
  if (explicit) {
    return explicit;
  }

  return process.env.LOCKSTEP_JUDGE_MODEL?.trim() || undefined;
}

export function getJudgeReasoningEffort(
  effort?: string,
): CodexReasoningEffort {
  const explicit = normalizeJudgeEffort(effort?.trim());
  if (explicit) {
    return explicit;
  }

  const fromEnv = normalizeJudgeEffort(process.env.LOCKSTEP_JUDGE_REASONING_EFFORT?.trim());
  if (fromEnv) {
    return fromEnv;
  }

  return DEFAULT_JUDGE_REASONING_EFFORT;
}
