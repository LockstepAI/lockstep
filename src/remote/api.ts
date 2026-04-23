export interface RunResponse {
  runId: string;
  instanceId: string;
}

export interface ValidatorConfig {
  type: string;
  target?: string;
  command?: string;
  path?: string;
  url?: string;
  pattern?: string;
  is_regex?: boolean;
  timeout?: number;
  optional?: boolean;
  [key: string]: unknown;
}

export interface ReceiptSummary {
  status: string;
  chain_hash?: string;
  steps_passed?: number;
  steps_failed?: number;
  total_steps?: number;
  completed_at?: string;
}

export interface PromptReadyResponse {
  status: 'prompt_ready';
  runId: string;
  stepIndex: number;
  stepName: string;
  prompt: string;
  validators: ValidatorConfig[];
  attempt: number;
  maxRetries: number;
  stepTimeoutSeconds?: number;
  preCommands?: string[];
  postCommands?: string[];
  context?: string;
}

export interface ProcessingResponse {
  status: 'processing';
  retryAfter: number;
  currentStep: number;
  totalSteps: number;
}

export interface TerminalResponse {
  status: 'completed' | 'failed';
  receipt?: ReceiptSummary | null;
  completedAt?: string;
}

export type NextResponse = PromptReadyResponse | ProcessingResponse | TerminalResponse;

export interface ValidationResult {
  type: string;
  target: string;
  passed: boolean;
  details?: string;
  exit_code?: number;
  optional?: boolean;
}

export interface SubmitResultResponse {
  status: string;
}

export interface WorkspaceMetadata {
  workspaceBranch?: string;
  workspaceCommit?: string;
  changedFiles?: string[];
}

const DEFAULT_API_TIMEOUT_MS = 30_000;

function getApiTimeoutMs(): number {
  const rawValue = process.env.LOCKSTEP_API_TIMEOUT_MS?.trim();
  if (!rawValue) {
    return DEFAULT_API_TIMEOUT_MS;
  }

  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_API_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected "${fieldName}" to be a string`);
  }
  return value;
}

function readNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Expected "${fieldName}" to be a number`);
  }
  return value;
}

function readStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Expected "${fieldName}" to be a string array`);
  }
  return value;
}

function parseValidatorConfig(value: unknown): ValidatorConfig {
  if (!isRecord(value)) {
    throw new Error('Expected validator config to be an object');
  }

  const type = readString(value.type, 'validator.type');
  return { ...value, type };
}

function parseReceiptSummary(value: unknown): ReceiptSummary | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('Expected "receipt" to be an object');
  }

  return {
    status: readString(value.status, 'receipt.status'),
    ...(typeof value.chain_hash === 'string' ? { chain_hash: value.chain_hash } : {}),
    ...(typeof value.steps_passed === 'number' ? { steps_passed: value.steps_passed } : {}),
    ...(typeof value.steps_failed === 'number' ? { steps_failed: value.steps_failed } : {}),
    ...(typeof value.total_steps === 'number' ? { total_steps: value.total_steps } : {}),
    ...(typeof value.completed_at === 'string' ? { completed_at: value.completed_at } : {}),
  };
}

function parseRunResponse(value: unknown): RunResponse {
  if (!isRecord(value)) {
    throw new Error('Expected run response to be an object');
  }

  return {
    runId: readString(value.runId, 'runId'),
    instanceId: readString(value.instanceId, 'instanceId'),
  };
}

function parseNextResponse(value: unknown): NextResponse {
  if (!isRecord(value)) {
    throw new Error('Expected next response to be an object');
  }

  const status = readString(value.status, 'status');

  switch (status) {
    case 'prompt_ready':
      return {
        status,
        runId: readString(value.runId, 'runId'),
        stepIndex: readNumber(value.stepIndex, 'stepIndex'),
        stepName: readString(value.stepName, 'stepName'),
        prompt: readString(value.prompt, 'prompt'),
        validators: Array.isArray(value.validators)
          ? value.validators.map(parseValidatorConfig)
          : [],
        attempt: readNumber(value.attempt, 'attempt'),
        maxRetries: readNumber(value.maxRetries, 'maxRetries'),
        ...(typeof value.stepTimeoutSeconds === 'number'
          ? { stepTimeoutSeconds: value.stepTimeoutSeconds }
          : {}),
        ...(value.preCommands !== undefined
          ? { preCommands: readStringArray(value.preCommands, 'preCommands') }
          : {}),
        ...(value.postCommands !== undefined
          ? { postCommands: readStringArray(value.postCommands, 'postCommands') }
          : {}),
        ...(value.context !== undefined
          ? { context: readString(value.context, 'context') }
          : {}),
      };
    case 'processing':
      return {
        status,
        retryAfter: readNumber(value.retryAfter, 'retryAfter'),
        currentStep: readNumber(value.currentStep, 'currentStep'),
        totalSteps: readNumber(value.totalSteps, 'totalSteps'),
      };
    case 'completed':
    case 'failed':
      return {
        status,
        ...(value.receipt !== undefined && value.receipt !== null
          ? { receipt: parseReceiptSummary(value.receipt) ?? null }
          : value.receipt === null
            ? { receipt: null }
            : {}),
        ...(typeof value.completedAt === 'string' ? { completedAt: value.completedAt } : {}),
      };
    default:
      throw new Error(`Unexpected run status: ${status}`);
  }
}

function parseSubmitResultResponse(value: unknown): SubmitResultResponse {
  if (!isRecord(value)) {
    throw new Error('Expected submit result response to be an object');
  }

  return {
    status: readString(value.status, 'status'),
  };
}

export class LockstepApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${this.apiKey}`);
    const timeoutMs = getApiTimeoutMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Lockstep API request to ${path} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    try {
      return await fetch(`${this.apiUrl}/v1${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Lockstep API request to ${path} timed out after ${String(timeoutMs)}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseError(res: Response): Promise<string> {
    const payload = await res.json().catch(() => ({ error: res.statusText }));
    return JSON.stringify(payload);
  }

  async startRun(specYaml: string): Promise<RunResponse> {
    const res = await this.request('/runs', {
      method: 'POST',
      body: JSON.stringify({ spec: specYaml }),
    });

    if (!res.ok) {
      throw new Error(`Failed to start run: ${await this.parseError(res)}`);
    }

    return parseRunResponse(await res.json());
  }

  async getNext(runId: string): Promise<NextResponse> {
    const res = await this.request(`/runs/${runId}/next`);

    if (!res.ok) {
      throw new Error(`Failed to get next step: ${await this.parseError(res)}`);
    }

    return parseNextResponse(await res.json());
  }

  async submitResult(
    runId: string,
    stepIndex: number,
    attempt: number,
    validationResults: ValidationResult[],
    agentStdoutHash: string,
    agentStderrHash: string,
    workspaceMetadata: WorkspaceMetadata = {},
  ): Promise<SubmitResultResponse> {
    const res = await this.request(`/runs/${runId}/result`, {
      method: 'POST',
      body: JSON.stringify({
        stepIndex,
        attempt,
        validationResults,
        agentStdoutHash,
        agentStderrHash,
        ...workspaceMetadata,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to submit result: ${await this.parseError(res)}`);
    }

    return parseSubmitResultResponse(await res.json());
  }
}
