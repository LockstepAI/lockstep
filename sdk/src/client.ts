import {
  LockstepError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  CreditsExhaustedError,
  ConflictError,
  RateLimitError,
  ServerError,
  ConnectionError,
  CircuitBreakerError,
} from './errors.js';
import type {
  LockstepConfig,
  CreateRunResponse,
  RunStatus,
  PollResponse,
  SubmitResultRequest,
  SubmitResultResponse,
  VerifyReceiptResponse,
  SignupRequest,
  SignupResponse,
  LoginRequest,
  LoginResponse,
  RefreshResponse,
  CreateKeyResponse,
  BillingOverview,
  BillingPlanCatalogEntry,
  BillingCheckoutSession,
  BillingPortalSession,
  BillingInvoiceSummary,
} from './types.js';
import {
  validateCreateRunResponse,
  validateRunStatus,
  validatePollResponse,
  validateSubmitResultResponse,
  validateVerifyReceiptResponse,
  validateSignupResponse,
  validateLoginResponse,
  validateRefreshResponse,
  validateCreateKeyResponse,
  validateStatusResponse,
  validateBillingOverview,
  validateBillingPlanCatalog,
  validateBillingCheckoutSession,
  validateBillingPortalSession,
  validateBillingInvoiceSummaries,
} from './types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://api.lockstepai.dev';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

// Circuit breaker: open after this many consecutive failures
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 30_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class Lockstep {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly _fetch: typeof globalThis.fetch;

  // Circuit breaker state
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(config: LockstepConfig) {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) {
      throw new Error('apiKey is required');
    }

    const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error('baseUrl must use http or https protocol');
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeout = Number.isFinite(config.timeout) ? Math.max(config.timeout!, 1) : DEFAULT_TIMEOUT_MS;
    this.maxRetries = Number.isFinite(config.maxRetries)
      ? Math.min(Math.max(Math.floor(config.maxRetries!), 0), 10)
      : DEFAULT_MAX_RETRIES;
    this._fetch = config.fetch ?? globalThis.fetch;
  }

  // =========================================================================
  // Runs
  // =========================================================================

  /** Start a new Lockstep run from a YAML spec. */
  async createRun(spec: string, signal?: AbortSignal): Promise<CreateRunResponse> {
    if (typeof spec !== 'string' || spec.trim() === '') {
      throw new Error('spec must be a non-empty string');
    }
    const data = await this.post('/v1/runs', { spec }, true, signal);
    return validateCreateRunResponse(data);
  }

  /** Get the full status of a run. */
  async getRun(runId: string, signal?: AbortSignal): Promise<RunStatus> {
    requireId(runId, 'runId');
    const data = await this.get(`/v1/runs/${enc(runId)}`, true, signal);
    return validateRunStatus(data);
  }

  /** Poll for the next prompt or final result. */
  async poll(runId: string, signal?: AbortSignal): Promise<PollResponse> {
    requireId(runId, 'runId');
    const data = await this.get(`/v1/runs/${enc(runId)}/next`, true, signal);
    return validatePollResponse(data);
  }

  /** Submit step validation results. */
  async submitResult(
    runId: string,
    result: SubmitResultRequest,
    signal?: AbortSignal,
  ): Promise<SubmitResultResponse> {
    requireId(runId, 'runId');
    validateSubmitResultRequest(result);
    const data = await this.post(`/v1/runs/${enc(runId)}/result`, result, true, signal);
    return validateSubmitResultResponse(data);
  }

  /** Cancel a running run. */
  async cancelRun(runId: string, signal?: AbortSignal): Promise<{ status: string }> {
    requireId(runId, 'runId');
    const data = await this.post(`/v1/runs/${enc(runId)}/cancel`, {}, true, signal);
    return validateStatusResponse(data);
  }

  // =========================================================================
  // Receipts (public — no auth required)
  // =========================================================================

  /** Verify a receipt's cryptographic integrity. No auth required. */
  async verifyReceipt(runId: string, signal?: AbortSignal): Promise<VerifyReceiptResponse> {
    requireId(runId, 'runId');
    const data = await this.get(`/v1/receipts/${enc(runId)}/verify`, false, signal);
    return validateVerifyReceiptResponse(data);
  }

  // =========================================================================
  // Auth
  // =========================================================================

  /** Create a new account. No auth required. */
  async signup(req: SignupRequest, signal?: AbortSignal): Promise<SignupResponse> {
    validateSignupRequest(req);
    const data = await this.post('/v1/signup', req, false, signal);
    return validateSignupResponse(data);
  }

  /** Login with email/password. Returns JWT access token. No auth required. */
  async login(req: LoginRequest, signal?: AbortSignal): Promise<LoginResponse> {
    validateLoginRequest(req);
    const data = await this.post('/v1/auth/login', req, false, signal);
    return validateLoginResponse(data);
  }

  /** Refresh JWT access token using refresh cookie. No auth required. */
  async refresh(signal?: AbortSignal): Promise<RefreshResponse> {
    const data = await this.post('/v1/auth/refresh', {}, false, signal);
    return validateRefreshResponse(data);
  }

  /** Logout and revoke session. */
  async logout(revokeAll = false, signal?: AbortSignal): Promise<{ status: string }> {
    const path = revokeAll ? '/v1/auth/logout?all=true' : '/v1/auth/logout';
    const data = await this.post(path, {}, true, signal);
    return validateStatusResponse(data);
  }

  /** Change password. Revokes all sessions. */
  async changePassword(
    currentPassword: string,
    newPassword: string,
    signal?: AbortSignal,
  ): Promise<{ status: string }> {
    if (typeof currentPassword !== 'string' || currentPassword === '') {
      throw new Error('currentPassword must be a non-empty string');
    }
    if (typeof newPassword !== 'string' || newPassword === '') {
      throw new Error('newPassword must be a non-empty string');
    }
    const data = await this.post(
      '/v1/auth/change-password',
      { current_password: currentPassword, new_password: newPassword },
      true,
      signal,
    );
    return validateStatusResponse(data);
  }

  // =========================================================================
  // API Keys
  // =========================================================================

  /** Generate a new API key. */
  async createKey(signal?: AbortSignal): Promise<CreateKeyResponse> {
    const data = await this.post('/v1/keys', {}, true, signal);
    return validateCreateKeyResponse(data);
  }

  /** Revoke an API key. */
  async revokeKey(keyId: string, signal?: AbortSignal): Promise<{ status: string }> {
    requireId(keyId, 'keyId');
    const data = await this.delete(`/v1/keys/${enc(keyId)}`, true, signal);
    return validateStatusResponse(data);
  }

  // =========================================================================
  // Billing
  // =========================================================================

  /** Get the current billing summary for the authenticated user. */
  async getBilling(signal?: AbortSignal): Promise<BillingOverview> {
    const data = await this.get('/v1/billing', true, signal);
    return validateBillingOverview(data);
  }

  /** List the currently configured self-serve plans. */
  async listBillingPlans(signal?: AbortSignal): Promise<BillingPlanCatalogEntry[]> {
    const data = await this.get('/v1/billing/plans', true, signal);
    return validateBillingPlanCatalog(data);
  }

  /** Create a Stripe Checkout session for a paid plan. */
  async createCheckoutSession(
    input: { plan: 'pro' | 'team'; successUrl: string; cancelUrl: string },
    signal?: AbortSignal,
  ): Promise<BillingCheckoutSession> {
    const data = await this.post('/v1/billing/checkout', input, true, signal);
    return validateBillingCheckoutSession(data);
  }

  /** Create a Stripe Billing Portal session for the authenticated user. */
  async createBillingPortalSession(returnUrl: string, signal?: AbortSignal): Promise<BillingPortalSession> {
    if (typeof returnUrl !== 'string' || returnUrl.trim() === '') {
      throw new Error('returnUrl must be a non-empty string');
    }
    const data = await this.post('/v1/billing/portal', { returnUrl }, true, signal);
    return validateBillingPortalSession(data);
  }

  /** List the recent Stripe invoices for the authenticated user. */
  async listInvoices(signal?: AbortSignal): Promise<BillingInvoiceSummary[]> {
    const data = await this.get('/v1/billing/invoices', true, signal);
    return validateBillingInvoiceSummaries(data);
  }

  // =========================================================================
  // Convenience: wait for run completion
  // =========================================================================

  /**
   * Poll a run until it reaches a terminal state.
   * Returns the final PollResponse (completed or failed).
   * Throws on timeout. Supports cancellation via AbortSignal.
   */
  async waitForCompletion(
    runId: string,
    options?: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<Extract<PollResponse, { status: 'completed' | 'failed' }>> {
    requireId(runId, 'runId');
    const pollInterval = Math.max(options?.pollIntervalMs ?? 2_000, 500);
    const timeout = options?.timeoutMs ?? 30 * 60 * 1000; // 30 min default
    const signal = options?.signal;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      signal?.throwIfAborted();

      const response = await this.poll(runId, signal);
      if (response.status === 'completed' || response.status === 'failed') {
        return response;
      }

      const delay =
        response.status === 'processing'
          ? Math.max(response.retryAfter * 1000, pollInterval)
          : pollInterval;

      await cancellableSleep(delay, signal);
    }

    throw new ConnectionError(`Timed out waiting for run ${runId} after ${timeout}ms`);
  }

  // =========================================================================
  // HTTP layer — retry, backoff, error mapping, circuit breaker
  // =========================================================================

  private async get(
    path: string,
    auth = true,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    return this.request('GET', path, undefined, auth, signal, headers);
  }

  private async post(
    path: string,
    body: unknown,
    auth = true,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    return this.request('POST', path, body, auth, signal, headers);
  }

  private async delete(
    path: string,
    auth = true,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    return this.request('DELETE', path, undefined, auth, signal, headers);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    auth: boolean,
    callerSignal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    // Circuit breaker check
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      if (Date.now() < this.circuitOpenUntil) {
        throw new CircuitBreakerError(this.consecutiveFailures);
      }
      // Half-open: allow one request through to test
    }

    // Generate idempotency key for POST requests to prevent duplicate side effects
    const idempotencyKey = extraHeaders?.['Idempotency-Key']
      ?? (method === 'POST' ? generateIdempotencyKey() : undefined);

    let lastError: LockstepError | null = null;
    // Decorrelated jitter state: tracks previous delay for decorrelation
    let prevDelay = INITIAL_RETRY_DELAY_MS;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      callerSignal?.throwIfAborted();

      if (attempt > 0) {
        // Check if last error was a 429 with retry_after — honor server backpressure
        let delay: number;
        if (lastError instanceof RateLimitError) {
          delay = lastError.retryAfter * 1000;
        } else {
          // Decorrelated jitter: nextDelay = random(base, prevDelay * 3), capped
          delay = Math.min(
            INITIAL_RETRY_DELAY_MS + Math.random() * (prevDelay * 3 - INITIAL_RETRY_DELAY_MS),
            MAX_RETRY_DELAY_MS,
          );
        }
        prevDelay = delay;
        await cancellableSleep(delay, callerSignal);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      // Link caller signal to request abort
      const onCallerAbort = (): void => controller.abort();
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': `lockstep-sdk/0.1.0 node/${process.version}`,
          ...(extraHeaders ?? {}),
        };
        if (auth) {
          headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        if (idempotencyKey) {
          headers['Idempotency-Key'] = idempotencyKey;
        }

        const res = await this._fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);

        if (res.ok) {
          // Reset circuit breaker on success
          this.consecutiveFailures = 0;
          const data: unknown = await res.json();
          return data;
        }

        const responseBody: unknown = await res.json().catch(() => ({ error: res.statusText }));

        // Retry on retryable status codes
        if (RETRYABLE_STATUS_CODES.has(res.status) && attempt < this.maxRetries) {
          lastError = this.mapError(res.status, responseBody, path);
          this.recordFailure();
          continue;
        }

        this.recordFailure();
        throw this.mapError(res.status, responseBody, path);
      } catch (err: unknown) {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);

        if (err instanceof LockstepError) {
          throw err;
        }

        // Caller-initiated abort
        if (callerSignal?.aborted) {
          throw new ConnectionError('Request aborted by caller');
        }

        // Network/timeout error — retry
        const message = err instanceof Error ? err.message : String(err);
        lastError = new ConnectionError(
          message.includes('abort') ? `Request timed out after ${this.timeout}ms` : message,
        );
        this.recordFailure();

        if (attempt >= this.maxRetries) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new ConnectionError('Request failed after all retries');
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
    }
  }

  private mapError(status: number, body: unknown, path: string): LockstepError {
    const safeBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

    switch (status) {
      case 401:
        return new AuthenticationError(body);
      case 402:
        return new CreditsExhaustedError(body);
      case 403:
        return new PermissionError(body);
      case 404:
        return new NotFoundError(path, body);
      case 409: {
        const msg =
          'error' in safeBody && typeof safeBody['error'] === 'string'
            ? safeBody['error']
            : 'Conflict';
        return new ConflictError(msg, body);
      }
      case 429: {
        const retryAfter =
          'retry_after' in safeBody && typeof safeBody['retry_after'] === 'number'
            ? safeBody['retry_after']
            : 5;
        return new RateLimitError(retryAfter || 5, body);
      }
      default:
        if (status >= 500) return new ServerError(status, body);
        return new LockstepError(`Request failed with status ${status}`, status, body);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ConnectionError('Request aborted by caller'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ConnectionError('Request aborted by caller'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function generateIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Input validators (system boundary)
// ---------------------------------------------------------------------------

function validateSubmitResultRequest(result: SubmitResultRequest): void {
  if (typeof result !== 'object' || result === null) {
    throw new Error('result must be an object');
  }
  if (typeof result.stepIndex !== 'number' || !Number.isInteger(result.stepIndex) || result.stepIndex < 0) {
    throw new Error('result.stepIndex must be a non-negative integer');
  }
  if (typeof result.attempt !== 'number' || !Number.isInteger(result.attempt) || result.attempt < 0) {
    throw new Error('result.attempt must be a non-negative integer');
  }
  if (!Array.isArray(result.validationResults)) {
    throw new Error('result.validationResults must be an array');
  }
  if (typeof result.agentStdoutHash !== 'string') {
    throw new Error('result.agentStdoutHash must be a string');
  }
  if (typeof result.agentStderrHash !== 'string') {
    throw new Error('result.agentStderrHash must be a string');
  }
}

function validateSignupRequest(req: SignupRequest): void {
  if (typeof req !== 'object' || req === null) {
    throw new Error('signup request must be an object');
  }
  if (typeof req.email !== 'string' || req.email.trim() === '') {
    throw new Error('email must be a non-empty string');
  }
}

function validateLoginRequest(req: LoginRequest): void {
  if (typeof req !== 'object' || req === null) {
    throw new Error('login request must be an object');
  }
  if (typeof req.email !== 'string' || req.email.trim() === '') {
    throw new Error('email must be a non-empty string');
  }
  if (typeof req.password !== 'string' || req.password === '') {
    throw new Error('password must be a non-empty string');
  }
}
