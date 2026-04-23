/**
 * Production quality rules injected into worker prompts.
 * Distilled from research across 618 anti-patterns, static analysis rules,
 * AI code smells, security advisories, and production postmortems.
 *
 * These rules target the specific failure modes of AI-generated code.
 */

// ---------------------------------------------------------------------------
// Rule categories
// ---------------------------------------------------------------------------

const TYPE_SAFETY = `
### Type Safety
- NEVER use \`as any\`. If you cannot type something, use \`unknown\` and narrow with type guards.
- NEVER initialize objects as \`{} as SomeType\`. Construct objects with all required properties.
- NEVER use \`JSON.parse(JSON.stringify(obj))\` for deep cloning — use structuredClone() or spread.
- If a value can be null/undefined, handle it explicitly. Do not assume it exists.
- NEVER use floating-point (number) for money/currency. Use integer cents or a Decimal library.
- NEVER compare with NaN using ===. Use Number.isNaN(). (NaN === NaN is always false.)
`;

const ERROR_HANDLING = `
### Error Handling
- NEVER write empty catch blocks. At minimum, log the error with context.
- NEVER swallow errors by returning null/undefined/empty arrays from catch blocks without logging.
- Let unexpected errors propagate — only catch errors you can actually handle or enrich.
- Wrap error messages for callers with context: \`throw new Error(\`Failed to X: \${err.message}\`)\`
- For async code: every Promise must have a .catch() or be inside try/catch. No fire-and-forget.
- NEVER call an async function without awaiting it — floating promises silently swallow all errors.
- NEVER use \`array.forEach(async fn)\` — it fires all callbacks and doesn't await any. Use \`Promise.all(array.map(async fn))\` or a for-of loop.
- In Express/HTTP handlers: wrap async handlers to catch rejections — unhandled rejections crash Node.js 15+.
`;

const SECURITY = `
### Security
- NEVER hardcode secrets, API keys, tokens, or passwords. Use environment variables.
- NEVER use eval(), new Function(), or dynamic code execution.
- NEVER concatenate user input into SQL/NoSQL queries — use parameterized queries or query builders.
- NEVER render user input as HTML without sanitization (no raw innerHTML/dangerouslySetInnerHTML).
- NEVER construct file paths from user input without path traversal validation.
- NEVER use MD5, SHA1, DES, RC4, or ECB mode. Use bcrypt/argon2 for passwords, SHA-256+ for hashing.
- NEVER use Math.random() for security tokens — use crypto.randomUUID() or crypto.randomBytes().
- NEVER pass user input to child_process.exec/spawn or os.system without sanitization.
- NEVER make server-side HTTP requests to user-supplied URLs without allowlist validation (SSRF).
- NEVER accept file uploads without validating file type, size, and storing outside the web root.
- NEVER grant access on error — auth/authz failures must DENY by default (fail closed, not open).
- Validate and sanitize ALL external input at system boundaries (API handlers, message consumers).
- Filter __proto__ and constructor keys when merging objects from external sources.
- Set CORS origins explicitly — never use wildcard '*' with credentials.
- Return generic error messages to clients. Never expose stack traces, internal paths, or DB details.
- For JWT: always verify algorithm explicitly (never allow "none"), use strong secrets (256+ bits).
- NEVER use \`===\` to compare secrets/tokens — use crypto.timingSafeEqual() to prevent timing attacks.
- NEVER deserialize untrusted data with pickle, yaml.load(), or ObjectInputStream — use safe alternatives.
- NEVER bind request body directly to models (mass assignment). Whitelist allowed fields explicitly.
- NEVER log passwords, tokens, PII, or full user objects. Redact sensitive fields before logging.
`;

const RESOURCE_MANAGEMENT = `
### Resource Management
- NEVER create Map/Set/Array caches without eviction (TTL, maxSize, or LRU). They leak memory.
- Always close resources (DB connections, file handles, streams) in finally blocks or using patterns.
- Set explicit timeouts on ALL network requests, DB queries, and external API calls.
- Never use readFileSync, writeFileSync, or other sync I/O in request handlers — use async versions.
- For EventEmitter/event listeners: always remove listeners when done (removeListener/off).
- Bound ALL queues and buffers with a max size. When full, apply backpressure or shed load — never grow unbounded.
- Configure connection pools with explicit size limits, timeouts, and health checks (pool_pre_ping).
`;

const PRODUCTION_READINESS = `
### Production Readiness
- Add SIGTERM/SIGINT handlers for graceful shutdown in long-running services.
- Include structured logging (with request IDs, timestamps, context) — not just console.log.
- Implement retry with exponential backoff AND jitter for transient failures. Set max retries.
- Add idempotency keys for mutating operations (POST/PUT/DELETE handlers, message consumers).
- Paginate all list queries — never return unbounded result sets.
- Use database transactions for multi-step mutations. Never assume all steps will succeed.
- Rate-limit expensive endpoints. At minimum: per-IP or per-user throttling.
- Validate boundary values: empty strings, null, zero-length arrays, negative numbers, MAX_SAFE_INTEGER.
- Close connections/handles in error paths too — not just the happy path (connection pool exhaustion).
- Add circuit breakers around external service calls to prevent cascading failures.
- For caches: handle cache-miss thundering herd with locking or request coalescing.
`;

const TEST_QUALITY = `
### Test Quality
- Tests MUST cover error paths and edge cases, not just the happy path.
- NEVER write tautological tests that assert on values the test itself constructs.
- Test actual behavior through the public API — don't just verify mocks were called.
- Include boundary tests: empty input, null, undefined, max values, concurrent access.
- If mocking, verify the mock matches the real interface. Mocks that diverge from reality are worse than no test.
- Test error messages and error types, not just that "it throws".
`;

const CONCURRENCY = `
### Concurrency & Performance
- Protect shared mutable state from race conditions. Use locks, atomic operations, or immutable patterns.
- Never use setTimeout(resolve, 0) as a synchronization mechanism.
- Avoid N+1 query patterns — use eager loading, batch queries, or DataLoader.
- Watch for regex with nested quantifiers — they cause catastrophic backtracking (ReDoS).
`;

const CODE_QUALITY = `
### Code Quality
- Do NOT leave TODO/FIXME/HACK comments — implement the feature or explicitly document the limitation.
- Do NOT reference packages that don't exist. Verify package names against npm/registry before importing.
- Do NOT use deprecated APIs. Check current documentation for the library version in use.
- Do NOT duplicate code blocks — extract shared logic into functions when a pattern repeats 3+ times.
- Every exported function must have explicit return types. No implicit any.
`;

// ---------------------------------------------------------------------------
// Assembled rules block for worker prompt injection
// ---------------------------------------------------------------------------

export function getProductionRules(): string {
  return [
    '## Production Quality Rules (MANDATORY)',
    '',
    'Your code MUST meet production standards. AI-generated code is frequently rejected',
    'for the following patterns. Violating any CRITICAL rule will fail the build.',
    '',
    TYPE_SAFETY,
    ERROR_HANDLING,
    SECURITY,
    RESOURCE_MANAGEMENT,
    PRODUCTION_READINESS,
    TEST_QUALITY,
    CONCURRENCY,
    CODE_QUALITY,
  ].join('\n');
}

/**
 * Returns a condensed checklist for the AI judge to evaluate against.
 * Each item maps to a specific research finding with severity.
 */
export function getJudgeRubric(): string {
  return `## Production Quality Rubric (Score each 0-2: 0=violation, 1=partial, 2=compliant)

### Critical (any 0 = automatic fail)
1. Type safety: No \`as any\`, no \`{} as Type\`, no implicit any returns, no float for money
2. Error handling: No empty catch, no swallowed errors, no floating promises, no forEach(async), proper propagation
3. Security: No hardcoded secrets, no eval(), no SQL/NoSQL concat, no unsanitized HTML, no timing-unsafe comparisons, no PII in logs
4. Resource cleanup: All handles/connections closed in all paths (including error), no unbounded caches/queues

### High (each scored 0-2)
5. Input validation: External input validated at boundaries, boundary values checked, mass assignment prevented
6. Timeouts: All network/DB calls have explicit timeouts, connection pools sized and configured
7. Graceful shutdown: SIGTERM/SIGINT handled for services, in-flight requests drained
8. Logging: Structured logging with context, sensitive fields redacted, no console.log in production
9. Test coverage: Error paths tested, no tautological assertions, edge cases and boundaries covered
10. Concurrency: No race conditions, no sync I/O in handlers, no unguarded shared mutable state

### Medium (each scored 0-2)
11. Retry & resilience: Exponential backoff with jitter, max retries, circuit breakers on external calls
12. Idempotency: Mutating operations are idempotent or documented as non-idempotent
13. Pagination: List queries are bounded, no unbounded result sets
14. Rate limiting: Expensive operations are throttled
15. Code quality: No TODOs, no deprecated APIs, no hallucinated packages, no ReDoS-vulnerable regex

### Scoring
- Critical: 4 items x 2 points = 8 points (any 0 = automatic fail regardless of total)
- High: 6 items x 2 points = 12 points
- Medium: 5 items x 2 points = 10 points
- Total: 30 points. Score = (points / 30) * 10

### Output format
Return JSON: { "scores": { "1": N, "2": N, ... "15": N }, "total": N, "grade": N, "auto_fail": bool, "violations": ["..."] }`;
}
