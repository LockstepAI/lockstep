import { describe, it, expect, vi } from 'vitest';
import { Lockstep } from './client.js';
import { AuthenticationError, CreditsExhaustedError, PermissionError, NotFoundError, ConflictError, RateLimitError, ServerError, LockstepError } from './errors.js';

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, statusText: `${status}`, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)), headers: new Headers() }) as unknown as typeof fetch;
}
function mockSeq(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce({ ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.body), text: () => Promise.resolve(JSON.stringify(r.body)), headers: new Headers() });
  return fn as unknown as typeof fetch;
}
const KEY = 'ls_live_abc123def456ghij7890';
const URL = 'https://api.test.com';
const c = (f: typeof fetch) => new Lockstep({ apiKey: KEY, baseUrl: URL, fetch: f, maxRetries: 0, timeout: 5000 });
const RUN = { id: 'run_1', status: 'running', current_step: 0, current_attempt: 1, total_steps: 2, spec_hash: 'h', spec_name: null, chain_hash: 'c', created_at: 't', updated_at: 't', completed_at: null };

describe('Constructor', () => {
  it('throws on empty key', () => { expect(() => new Lockstep({ apiKey: '' })).toThrow(); });
  it('throws on whitespace key', () => { expect(() => new Lockstep({ apiKey: '   ' })).toThrow(); });
  it('accepts ls_live_ key', () => { expect(() => new Lockstep({ apiKey: KEY, fetch: mockFetch(200, {}) })).not.toThrow(); });
  it('accepts ls_test_ key', () => { expect(() => new Lockstep({ apiKey: 'ls_test_abc123def456ghij7890', fetch: mockFetch(200, {}) })).not.toThrow(); });
  it('accepts JWT', () => { expect(() => new Lockstep({ apiKey: 'eyJhbGciOiJIUzI1NiJ9.t.s', fetch: mockFetch(200, {}) })).not.toThrow(); });
  it('rejects javascript: url', () => { expect(() => new Lockstep({ apiKey: KEY, baseUrl: 'javascript:alert(1)' })).toThrow(); });
  it('allows http://localhost', () => { expect(() => new Lockstep({ apiKey: KEY, baseUrl: 'http://localhost:8787', fetch: mockFetch(200, {}) })).not.toThrow(); });
  it('caps maxRetries at 10', () => { expect(() => new Lockstep({ apiKey: KEY, maxRetries: 100, fetch: mockFetch(200, {}) })).not.toThrow(); });
  it('floors negative retries to 0', () => { expect(() => new Lockstep({ apiKey: KEY, maxRetries: -5, fetch: mockFetch(200, {}) })).not.toThrow(); });
});

describe('Errors', () => {
  it('401 → AuthenticationError', async () => { await expect(c(mockFetch(401, {})).getRun('run_1')).rejects.toThrow(AuthenticationError); });
  it('402 → CreditsExhaustedError', async () => { await expect(c(mockFetch(402, {})).createRun('s')).rejects.toThrow(CreditsExhaustedError); });
  it('403 → PermissionError', async () => { await expect(c(mockFetch(403, {})).createKey()).rejects.toThrow(PermissionError); });
  it('404 → NotFoundError', async () => { await expect(c(mockFetch(404, {})).getRun('run_1')).rejects.toThrow(NotFoundError); });
  it('409 → ConflictError', async () => { await expect(c(mockFetch(409, {})).submitResult('run_1', { stepIndex: 0, attempt: 1, validationResults: [], agentStdoutHash: 'a', agentStderrHash: 'b' })).rejects.toThrow(ConflictError); });
  it('429 → RateLimitError', async () => { await expect(c(mockFetch(429, {})).getRun('run_1')).rejects.toThrow(RateLimitError); });
  it('500 → ServerError', async () => { await expect(c(mockFetch(500, {})).getRun('run_1')).rejects.toThrow(ServerError); });
});

describe('Input validation', () => {
  it('empty runId', async () => { await expect(c(mockFetch(200, {})).getRun('')).rejects.toThrow(); });
  it('whitespace runId', async () => { await expect(c(mockFetch(200, {})).getRun('   ')).rejects.toThrow(); });
  it('slash in runId', async () => { await expect(c(mockFetch(200, {})).getRun('../../x')).rejects.toThrow(); });
  it('backslash in runId', async () => { await expect(c(mockFetch(200, {})).getRun('..\\x')).rejects.toThrow(); });
  it('empty keyId', async () => { await expect(c(mockFetch(200, {})).revokeKey('')).rejects.toThrow(); });
});

describe('Retry', () => {
  it('retries on 429', { timeout: 30000 }, async () => {
    const fn = mockSeq([{ status: 429, body: {} }, { status: 200, body: RUN }]);
    const result = await new Lockstep({ apiKey: KEY, baseUrl: URL, fetch: fn, maxRetries: 1, timeout: 5000 }).getRun('run_1');
    expect(result.id).toBe('run_1');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('stops after maxRetries', { timeout: 30000 }, async () => {
    const fn = mockFetch(429, {});
    await expect(new Lockstep({ apiKey: KEY, baseUrl: URL, fetch: fn, maxRetries: 1, timeout: 5000 }).getRun('run_1')).rejects.toThrow(RateLimitError);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('Auth methods', () => {
  it('signup', async () => { expect((await c(mockFetch(200, { userId: 'u1', email: 'a@b.com', apiKey: KEY, plan: 'free', credits: 5 })).signup({ email: 'a@b.com' })).userId).toBe('u1'); });
  it('login', async () => { expect((await c(mockFetch(200, { access_token: 'jwt', token_type: 'Bearer', expires_in: 900 })).login({ email: 'a@b.com', password: 'p' })).access_token).toBe('jwt'); });
  it('logout revokeAll', async () => { const fn = mockFetch(200, { status: 'ok' }); await c(fn).logout(true); expect((fn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('all=true'); });
});

describe('Billing methods', () => {
  it('getBilling', async () => {
    const fn = mockFetch(200, {
      plan: 'free',
      product: 'dev',
      currentSpend: 0,
      limit: 5,
      creditsRemaining: 5,
      periodStart: 't1',
      periodEnd: 't2',
      paymentMethod: null,
    });
    expect((await c(fn).getBilling()).plan).toBe('free');
  });

  it('listBillingPlans', async () => {
    const fn = mockFetch(200, [
      { plan: 'free', name: 'Free', credits: 5, priceId: null, amount: 0, currency: 'usd', interval: 'month', active: true },
      { plan: 'pro', name: 'Lockstep Pro', credits: 1000, priceId: 'price_pro', amount: 1900, currency: 'usd', interval: 'month', active: true },
    ]);
    const plans = await c(fn).listBillingPlans();
    expect(plans[1]?.priceId).toBe('price_pro');
  });

  it('createCheckoutSession', async () => {
    const fn = mockFetch(201, {
      id: 'cs_123',
      url: 'https://checkout.stripe.com/c/pay/cs_123',
      customerId: 'cus_123',
      priceId: 'price_pro',
      plan: 'pro',
    });
    const session = await c(fn).createCheckoutSession({
      plan: 'pro',
      successUrl: 'https://lockstep.ai/success',
      cancelUrl: 'https://lockstep.ai/cancel',
    });
    expect(session.id).toBe('cs_123');
  });

  it('createBillingPortalSession', async () => {
    const fn = mockFetch(201, {
      url: 'https://billing.stripe.com/session/test',
      customerId: 'cus_123',
    });
    expect((await c(fn).createBillingPortalSession('https://lockstep.ai/billing')).customerId).toBe('cus_123');
  });

  it('listInvoices', async () => {
    const fn = mockFetch(200, [{
      id: 'in_123',
      number: '0001',
      status: 'paid',
      currency: 'usd',
      subtotal: 1900,
      total: 1900,
      amount_paid: 1900,
      amount_due: 0,
      created_at: 't',
      period_start: 't1',
      period_end: 't2',
      hosted_invoice_url: 'https://invoice',
      invoice_pdf: 'https://invoice.pdf',
    }]);
    expect((await c(fn).listInvoices())[0]?.id).toBe('in_123');
  });
});

describe('Error safety', () => {
  it('toJSON excludes body', () => { const j = JSON.parse(JSON.stringify(new LockstepError('t', 400, { secret: 'x' }))); expect(j.body).toBeUndefined(); });
  it('body not enumerable', () => { expect(Object.keys(new LockstepError('t', 400, {}))).not.toContain('body'); });
  it('no API key in error', async () => { try { await c(mockFetch(401, {})).getRun('r'); } catch (e) { expect(String(e)).not.toContain('ls_live_'); } });
});

describe('Auth headers', () => {
  it('sends auth on protected', async () => { const fn = mockFetch(200, RUN); await c(fn).getRun('run_1'); expect((fn as ReturnType<typeof vi.fn>).mock.calls[0][1].headers['Authorization']).toContain('Bearer'); });
  it('no auth on public', async () => {
    const receipt = { verified: true, signature_valid: true, chain_valid: true, trust_model: 's', receipt: { run_id: 'r', spec_hash: 's', status: 'completed', agent: 'c', total_steps: 1, steps_passed: 1, steps_failed: 0, chain_hash: 'c', receipt_signature: 's', signing_key_id: 'k', trust_model: 's', started_at: 't', completed_at: 't', step_proofs: [] }, verified_at: 't' };
    const fn = mockFetch(200, receipt); await c(fn).verifyReceipt('run_1');
    expect((fn as ReturnType<typeof vi.fn>).mock.calls[0][1].headers['Authorization']).toBeUndefined();
  });
});
