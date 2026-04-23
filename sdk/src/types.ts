// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

export interface LockstepConfig {
  /** API key (ls_live_... or ls_test_...) or JWT access token. */
  apiKey: string;
  /** Base URL. Defaults to https://api.lockstepai.dev */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000 (30s). */
  timeout?: number;
  /** Max retries on 5xx/network errors. Defaults to 3. */
  maxRetries?: number;
  /** Custom fetch implementation (for testing or Node 16). */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface CreateRunRequest {
  /** Full YAML content of the .lockstep.yml spec. */
  spec: string;
}

export interface CreateRunResponse {
  runId: string;
  instanceId: string;
}

export interface RunStatus {
  id: string;
  status:
    | 'pending'
    | 'running'
    | 'waiting_for_cli'
    | 'processing'
    | 'completed'
    | 'failed'
    | 'cancelled';
  currentStep: number;
  currentAttempt: number;
  totalSteps: number;
  specHash: string;
  specName: string | null;
  chainHash: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface PromptReady {
  status: 'prompt_ready';
  runId: string;
  stepIndex: number;
  stepName: string;
  prompt: string;
  attempt: number;
  maxRetries: number;
  validators: ValidatorConfig[];
  preCommands?: string[];
  postCommands?: string[];
  context?: string;
}

export interface Processing {
  status: 'processing';
  currentStep: number;
  totalSteps: number;
  retryAfter: number;
}

export interface Terminal {
  status: 'completed' | 'failed';
  receipt?: Receipt | null;
  completedAt?: string;
}

export type PollResponse = PromptReady | Processing | Terminal;

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

export interface ValidationResult {
  type: string;
  target: string;
  passed: boolean;
  details?: string;
  exit_code?: number;
  stdout_truncated?: string;
  stderr_truncated?: string;
  optional?: boolean;
}

export interface SubmitResultRequest {
  stepIndex: number;
  attempt: number;
  validationResults: ValidationResult[];
  agentStdoutHash: string;
  agentStderrHash: string;
}

export interface SubmitResultResponse {
  status: string;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface StepProof {
  step_index: number;
  step_name: string;
  attempt: number;
  status: string;
  all_passed: boolean;
  validation_summary: Array<{
    type: string;
    target: string;
    passed: boolean;
  }>;
  previous_step_hash: string;
  step_hash: string;
}

export interface Receipt {
  run_id: string;
  spec_hash: string;
  status: string;
  agent: string;
  total_steps: number;
  steps_passed: number;
  steps_failed: number;
  chain_hash: string;
  receipt_signature: string;
  signing_key_id: string;
  trust_model: string;
  started_at: string;
  completed_at: string;
  step_proofs: StepProof[];
}

export interface VerifyReceiptResponse {
  verified: boolean;
  signature_valid: boolean;
  chain_valid: boolean;
  trust_model: string;
  receipt: Receipt;
  verified_at: string;
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export interface BillingOverview {
  plan: string;
  product: string;
  currentSpend: number;
  limit: number;
  creditsRemaining: number;
  periodStart: string;
  periodEnd: string;
  paymentMethod: {
    type: string;
    label: string;
    brand?: string;
    last4?: string;
    exp_month?: number;
    exp_year?: number;
  } | null;
}

export interface BillingPlanCatalogEntry {
  plan: string;
  name: string;
  credits: number;
  priceId: string | null;
  amount: number | null;
  currency: string;
  interval: string | null;
  active: boolean;
}

export interface BillingCheckoutSession {
  id: string;
  url: string;
  customerId: string;
  priceId: string;
  plan: string;
}

export interface BillingPortalSession {
  url: string;
  customerId: string;
}

export interface BillingInvoiceSummary {
  id: string;
  number: string | null;
  status: string | null;
  currency: string;
  subtotal: number;
  total: number;
  amount_paid: number;
  amount_due: number;
  created_at: string;
  period_start: string | null;
  period_end: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface SignupRequest {
  email: string;
  name?: string;
  password?: string;
}

export interface SignupResponse {
  userId: string;
  email: string;
  apiKey: string;
  plan: string;
  credits: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface RefreshResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

export interface CreateKeyResponse {
  key: string;
  short_token: string;
}

// ---------------------------------------------------------------------------
// Runtime response validators
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertString(obj: Record<string, unknown>, key: string, label: string): string {
  const val = obj[key];
  if (typeof val !== 'string') {
    throw new TypeError(`Invalid API response: expected string for ${label}, got ${typeof val}`);
  }
  return val;
}

function assertNumber(obj: Record<string, unknown>, key: string, label: string): number {
  const val = obj[key];
  if (typeof val !== 'number') {
    throw new TypeError(`Invalid API response: expected number for ${label}, got ${typeof val}`);
  }
  return val;
}

function assertStringOrNull(obj: Record<string, unknown>, key: string, label: string): string | null {
  const val = obj[key];
  if (val === null || val === undefined) return null;
  if (typeof val !== 'string') {
    throw new TypeError(`Invalid API response: expected string|null for ${label}, got ${typeof val}`);
  }
  return val;
}

function assertBoolean(obj: Record<string, unknown>, key: string, label: string): boolean {
  const val = obj[key];
  if (typeof val !== 'boolean') {
    throw new TypeError(`Invalid API response: expected boolean for ${label}, got ${typeof val}`);
  }
  return val;
}

export function validateCreateRunResponse(data: unknown): CreateRunResponse {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for CreateRunResponse');
  return {
    runId: assertString(data, 'runId', 'CreateRunResponse.runId'),
    instanceId: assertString(data, 'instanceId', 'CreateRunResponse.instanceId'),
  };
}

const VALID_RUN_STATUSES = new Set([
  'pending', 'running', 'waiting_for_cli', 'processing', 'completed', 'failed', 'cancelled',
]);

export function validateRunStatus(data: unknown): RunStatus {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for RunStatus');
  const status = assertString(data, 'status', 'RunStatus.status');
  if (!VALID_RUN_STATUSES.has(status)) {
    throw new TypeError(`Invalid API response: unknown run status "${status}"`);
  }
  return {
    id: assertString(data, 'id', 'RunStatus.id'),
    status: status as RunStatus['status'],
    currentStep: assertNumber(data, 'current_step', 'RunStatus.current_step'),
    currentAttempt: assertNumber(data, 'current_attempt', 'RunStatus.current_attempt'),
    totalSteps: assertNumber(data, 'total_steps', 'RunStatus.total_steps'),
    specHash: assertString(data, 'spec_hash', 'RunStatus.spec_hash'),
    specName: assertStringOrNull(data, 'spec_name', 'RunStatus.spec_name'),
    chainHash: assertString(data, 'chain_hash', 'RunStatus.chain_hash'),
    createdAt: assertString(data, 'created_at', 'RunStatus.created_at'),
    updatedAt: assertString(data, 'updated_at', 'RunStatus.updated_at'),
    completedAt: assertStringOrNull(data, 'completed_at', 'RunStatus.completed_at'),
  };
}

export function validatePollResponse(data: unknown): PollResponse {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for PollResponse');
  const status = assertString(data, 'status', 'PollResponse.status');

  switch (status) {
    case 'prompt_ready': {
      const validators = data['validators'];
      if (!Array.isArray(validators)) {
        throw new TypeError('Invalid API response: expected array for PollResponse.validators');
      }
      return {
        status: 'prompt_ready',
        runId: assertString(data, 'runId', 'PollResponse.runId'),
        stepIndex: assertNumber(data, 'stepIndex', 'PollResponse.stepIndex'),
        stepName: assertString(data, 'stepName', 'PollResponse.stepName'),
        prompt: assertString(data, 'prompt', 'PollResponse.prompt'),
        attempt: assertNumber(data, 'attempt', 'PollResponse.attempt'),
        maxRetries: assertNumber(data, 'maxRetries', 'PollResponse.maxRetries'),
        validators: validators as ValidatorConfig[],
        ...(data['preCommands'] !== undefined ? { preCommands: data['preCommands'] as string[] } : {}),
        ...(data['postCommands'] !== undefined ? { postCommands: data['postCommands'] as string[] } : {}),
        ...(data['context'] !== undefined ? { context: String(data['context']) } : {}),
      };
    }
    case 'processing':
      return {
        status: 'processing',
        currentStep: assertNumber(data, 'currentStep', 'PollResponse.currentStep'),
        totalSteps: assertNumber(data, 'totalSteps', 'PollResponse.totalSteps'),
        retryAfter: assertNumber(data, 'retryAfter', 'PollResponse.retryAfter'),
      };
    case 'completed':
    case 'failed':
      return {
        status,
        ...(data['receipt'] !== undefined ? { receipt: data['receipt'] as Receipt | null } : {}),
        ...(data['completedAt'] !== undefined ? { completedAt: String(data['completedAt']) } : {}),
      };
    default:
      throw new TypeError(`Invalid API response: unknown poll status "${status}"`);
  }
}

export function validateSubmitResultResponse(data: unknown): SubmitResultResponse {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for SubmitResultResponse');
  return {
    status: assertString(data, 'status', 'SubmitResultResponse.status'),
  };
}

export function validateVerifyReceiptResponse(data: unknown): VerifyReceiptResponse {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for VerifyReceiptResponse');
  return {
    verified: assertBoolean(data, 'verified', 'VerifyReceiptResponse.verified'),
    signature_valid: assertBoolean(data, 'signature_valid', 'VerifyReceiptResponse.signature_valid'),
    chain_valid: assertBoolean(data, 'chain_valid', 'VerifyReceiptResponse.chain_valid'),
    trust_model: assertString(data, 'trust_model', 'VerifyReceiptResponse.trust_model'),
    receipt: data['receipt'] as Receipt,
    verified_at: assertString(data, 'verified_at', 'VerifyReceiptResponse.verified_at'),
  };
}

function assertNumberOrNull(obj: Record<string, unknown>, key: string, label: string): number | null {
  const val = obj[key];
  if (val === null || val === undefined) return null;
  if (typeof val !== 'number') {
    throw new TypeError(`Invalid API response: expected number|null for ${label}, got ${typeof val}`);
  }
  return val;
}

export function validateBillingOverview(data: unknown): BillingOverview {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for BillingOverview');
  const paymentMethod = data['paymentMethod'];

  return {
    plan: assertString(data, 'plan', 'BillingOverview.plan'),
    product: assertString(data, 'product', 'BillingOverview.product'),
    currentSpend: assertNumber(data, 'currentSpend', 'BillingOverview.currentSpend'),
    limit: assertNumber(data, 'limit', 'BillingOverview.limit'),
    creditsRemaining: assertNumber(data, 'creditsRemaining', 'BillingOverview.creditsRemaining'),
    periodStart: assertString(data, 'periodStart', 'BillingOverview.periodStart'),
    periodEnd: assertString(data, 'periodEnd', 'BillingOverview.periodEnd'),
    paymentMethod: isObject(paymentMethod)
      ? {
          type: assertString(paymentMethod, 'type', 'BillingOverview.paymentMethod.type'),
          label: assertString(paymentMethod, 'label', 'BillingOverview.paymentMethod.label'),
          ...(typeof paymentMethod['brand'] === 'string' ? { brand: paymentMethod['brand'] } : {}),
          ...(typeof paymentMethod['last4'] === 'string' ? { last4: paymentMethod['last4'] } : {}),
          ...(typeof paymentMethod['exp_month'] === 'number' ? { exp_month: paymentMethod['exp_month'] } : {}),
          ...(typeof paymentMethod['exp_year'] === 'number' ? { exp_year: paymentMethod['exp_year'] } : {}),
        }
      : null,
  };
}

export function validateBillingPlanCatalog(data: unknown): BillingPlanCatalogEntry[] {
  if (!Array.isArray(data)) {
    throw new TypeError('Invalid API response: expected array for BillingPlanCatalog');
  }

  return data.map((entry, index) => {
    if (!isObject(entry)) {
      throw new TypeError(`Invalid API response: expected object for BillingPlanCatalog[${index}]`);
    }

    return {
      plan: assertString(entry, 'plan', `BillingPlanCatalog[${index}].plan`),
      name: assertString(entry, 'name', `BillingPlanCatalog[${index}].name`),
      credits: assertNumber(entry, 'credits', `BillingPlanCatalog[${index}].credits`),
      priceId: assertStringOrNull(entry, 'priceId', `BillingPlanCatalog[${index}].priceId`),
      amount: assertNumberOrNull(entry, 'amount', `BillingPlanCatalog[${index}].amount`),
      currency: assertString(entry, 'currency', `BillingPlanCatalog[${index}].currency`),
      interval: assertStringOrNull(entry, 'interval', `BillingPlanCatalog[${index}].interval`),
      active: assertBoolean(entry, 'active', `BillingPlanCatalog[${index}].active`),
    };
  });
}

export function validateBillingCheckoutSession(data: unknown): BillingCheckoutSession {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for BillingCheckoutSession');
  return {
    id: assertString(data, 'id', 'BillingCheckoutSession.id'),
    url: assertString(data, 'url', 'BillingCheckoutSession.url'),
    customerId: assertString(data, 'customerId', 'BillingCheckoutSession.customerId'),
    priceId: assertString(data, 'priceId', 'BillingCheckoutSession.priceId'),
    plan: assertString(data, 'plan', 'BillingCheckoutSession.plan'),
  };
}

export function validateBillingPortalSession(data: unknown): BillingPortalSession {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for BillingPortalSession');
  return {
    url: assertString(data, 'url', 'BillingPortalSession.url'),
    customerId: assertString(data, 'customerId', 'BillingPortalSession.customerId'),
  };
}

export function validateBillingInvoiceSummaries(data: unknown): BillingInvoiceSummary[] {
  if (!Array.isArray(data)) {
    throw new TypeError('Invalid API response: expected array for BillingInvoiceSummary[]');
  }

  return data.map((entry, index) => {
    if (!isObject(entry)) {
      throw new TypeError(`Invalid API response: expected object for BillingInvoiceSummary[${index}]`);
    }

    return {
      id: assertString(entry, 'id', `BillingInvoiceSummary[${index}].id`),
      number: assertStringOrNull(entry, 'number', `BillingInvoiceSummary[${index}].number`),
      status: assertStringOrNull(entry, 'status', `BillingInvoiceSummary[${index}].status`),
      currency: assertString(entry, 'currency', `BillingInvoiceSummary[${index}].currency`),
      subtotal: assertNumber(entry, 'subtotal', `BillingInvoiceSummary[${index}].subtotal`),
      total: assertNumber(entry, 'total', `BillingInvoiceSummary[${index}].total`),
      amount_paid: assertNumber(entry, 'amount_paid', `BillingInvoiceSummary[${index}].amount_paid`),
      amount_due: assertNumber(entry, 'amount_due', `BillingInvoiceSummary[${index}].amount_due`),
      created_at: assertString(entry, 'created_at', `BillingInvoiceSummary[${index}].created_at`),
      period_start: assertStringOrNull(entry, 'period_start', `BillingInvoiceSummary[${index}].period_start`),
      period_end: assertStringOrNull(entry, 'period_end', `BillingInvoiceSummary[${index}].period_end`),
      hosted_invoice_url: assertStringOrNull(entry, 'hosted_invoice_url', `BillingInvoiceSummary[${index}].hosted_invoice_url`),
      invoice_pdf: assertStringOrNull(entry, 'invoice_pdf', `BillingInvoiceSummary[${index}].invoice_pdf`),
    };
  });
}

export function validateSignupResponse(data: unknown): SignupResponse {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for SignupResponse');
  return {
    userId: assertString(data, 'userId', 'SignupResponse.userId'),
    email: assertString(data, 'email', 'SignupResponse.email'),
    apiKey: assertString(data, 'apiKey', 'SignupResponse.apiKey'),
    plan: assertString(data, 'plan', 'SignupResponse.plan'),
    credits: assertNumber(data, 'credits', 'SignupResponse.credits'),
  };
}

export function validateLoginResponse(data: unknown): LoginResponse {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for LoginResponse');
  return {
    access_token: assertString(data, 'access_token', 'LoginResponse.access_token'),
    token_type: assertString(data, 'token_type', 'LoginResponse.token_type'),
    expires_in: assertNumber(data, 'expires_in', 'LoginResponse.expires_in'),
  };
}

export function validateRefreshResponse(data: unknown): RefreshResponse {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for RefreshResponse');
  return {
    access_token: assertString(data, 'access_token', 'RefreshResponse.access_token'),
    token_type: assertString(data, 'token_type', 'RefreshResponse.token_type'),
    expires_in: assertNumber(data, 'expires_in', 'RefreshResponse.expires_in'),
  };
}

export function validateCreateKeyResponse(data: unknown): CreateKeyResponse {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object for CreateKeyResponse');
  return {
    key: assertString(data, 'key', 'CreateKeyResponse.key'),
    short_token: assertString(data, 'short_token', 'CreateKeyResponse.short_token'),
  };
}

export function validateStatusResponse(data: unknown): { status: string } {
  if (!isObject(data)) throw new TypeError('Invalid API response: expected object');
  return {
    status: assertString(data, 'status', 'status'),
  };
}
