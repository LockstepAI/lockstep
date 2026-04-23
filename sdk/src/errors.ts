/**
 * Base error class for all Lockstep SDK errors.
 * All errors include the HTTP status code and raw response body.
 * SECURITY: Error messages never include API keys, tokens, or request headers.
 */
export class LockstepError extends Error {
  readonly status: number;
  declare readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'LockstepError';
    this.status = status;
    // Non-enumerable: prevents body (which may contain sensitive data)
    // from appearing in JSON.stringify(), console.log(), or Object.keys()
    Object.defineProperty(this, 'body', { value: body, enumerable: false, writable: false });
  }

  /** Safe serialization — excludes body to prevent API key/token leakage. */
  toJSON(): { name: string; message: string; status: number } {
    return { name: this.name, message: this.message, status: this.status };
  }
}

/** 401 — Invalid or missing API key / JWT token. */
export class AuthenticationError extends LockstepError {
  constructor(body: unknown) {
    super('Authentication failed — check your API key or token', 401, body);
    this.name = 'AuthenticationError';
  }
}

/** 403 — Valid credentials but insufficient permissions. */
export class PermissionError extends LockstepError {
  constructor(body: unknown) {
    super('Insufficient permissions for this operation', 403, body);
    this.name = 'PermissionError';
  }
}

/** 404 — Requested resource not found. */
export class NotFoundError extends LockstepError {
  constructor(resource: string, body: unknown) {
    super(`${resource} not found`, 404, body);
    this.name = 'NotFoundError';
  }
}

/** 402 — No credits remaining (free plan). */
export class CreditsExhaustedError extends LockstepError {
  constructor(body: unknown) {
    super('No credits remaining — upgrade your plan', 402, body);
    this.name = 'CreditsExhaustedError';
  }
}

/** 409 — Conflict (e.g., run not in expected state). */
export class ConflictError extends LockstepError {
  constructor(message: string, body: unknown) {
    super(message, 409, body);
    this.name = 'ConflictError';
  }
}

/** 429 — Rate limited. Includes retryAfter hint in seconds. */
export class RateLimitError extends LockstepError {
  readonly retryAfter: number;

  constructor(retryAfter: number, body: unknown) {
    super(`Rate limited — retry after ${retryAfter}s`, 429, body);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/** 500+ — Server-side error. */
export class ServerError extends LockstepError {
  constructor(status: number, body: unknown) {
    super(`Server error (${status})`, status, body);
    this.name = 'ServerError';
  }
}

/** Network/timeout error — no HTTP response received. */
export class ConnectionError extends LockstepError {
  constructor(message: string) {
    super(message, 0, null);
    this.name = 'ConnectionError';
  }
}

/** Circuit breaker open — too many consecutive failures. */
export class CircuitBreakerError extends LockstepError {
  constructor(failures: number) {
    super(`Circuit breaker open after ${failures} consecutive failures — not sending request`, 0, null);
    this.name = 'CircuitBreakerError';
  }
}
