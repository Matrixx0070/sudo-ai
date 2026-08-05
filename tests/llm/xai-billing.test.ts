/**
 * Tests for the xAI spend guard.
 *
 * The behaviours worth locking in are the failure modes, not the happy path.
 * `cost-tracker.checkBudget()` already demonstrates how a budget check dies: it
 * computes a verdict nobody acts on. The second way it dies is degrading to
 * "allow" when it cannot read the number. Both are asserted against here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getSpendStatus,
  getSpendStatusCached,
  __resetSpendCache,
  assertXaiSpendAllowed,
  readBillingConfigFromEnv,
  isGuardConfigured,
  extractUsd,
  XaiSpendBlockedError,
  type XaiBillingConfig,
  type XaiBillingDeps,
} from '../../src/llm/xai-billing.js';

const CFG: XaiBillingConfig = {
  managementKey: 'mgmt-key',
  teamId: 'team-uuid',
  baseUrl: 'https://management-api.x.ai',
};

/** Route each billing path to a canned body. */
function deps(routes: Record<string, { status?: number; body?: unknown }>): XaiBillingDeps {
  return {
    fetch: vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const hit = Object.entries(routes).find(([p]) => u.includes(p));
      const { status = 200, body = {} } = hit?.[1] ?? { status: 404 };
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch,
  };
}

const PREVIEW = 'postpaid/invoice/preview';
const LIMITS = 'postpaid/spending-limits';
const PREPAID = 'prepaid/balance';

describe('config', () => {
  it('requires both a management key and a team id', () => {
    expect(isGuardConfigured({ baseUrl: 'x' })).toBe(false);
    expect(isGuardConfigured({ baseUrl: 'x', managementKey: 'k' })).toBe(false);
    expect(isGuardConfigured({ baseUrl: 'x', managementKey: 'k', teamId: 't' })).toBe(true);
  });

  it('reads env, defaults the base url, and ignores a non-numeric cap', () => {
    const c = readBillingConfigFromEnv({
      XAI_MANAGEMENT_KEY: 'k', XAI_TEAM_ID: 't', SUDO_XAI_SPEND_CAP_USD: 'abc',
    } as NodeJS.ProcessEnv);
    expect(c.baseUrl).toBe('https://management-api.x.ai');
    expect(c.capUsd).toBeUndefined();
    expect(readBillingConfigFromEnv({ SUDO_XAI_SPEND_CAP_USD: '25.5' } as NodeJS.ProcessEnv).capUsd).toBe(25.5);
  });
});

describe('extractUsd', () => {
  it('finds the first matching key and understands nesting', () => {
    expect(extractUsd({ amount_due_usd: 12.5 }, ['amount_due_usd'])).toBe(12.5);
    expect(extractUsd({ invoice: { amount_usd: 7 } }, ['invoice.amount_usd'])).toBe(7);
  });

  it('converts ticks at 1e-10 USD, matching the /v1/responses encoding', () => {
    expect(extractUsd({ amount_usd_ticks: 441824000 }, ['amount_usd_ticks'])).toBeCloseTo(0.0442, 4);
  });

  it('accepts numeric strings', () => {
    expect(extractUsd({ amount: '3.25' }, ['amount'])).toBe(3.25);
  });

  it('returns null — never 0 — when nothing matches', () => {
    expect(extractUsd({ something_else: 5 }, ['amount_usd'])).toBeNull();
    expect(extractUsd({ amount_usd: 'not-a-number' }, ['amount_usd'])).toBeNull();
    expect(extractUsd(null, ['amount_usd'])).toBeNull();
  });

  it('distinguishes genuine zero from unreadable', () => {
    expect(extractUsd({ amount_usd: 0 }, ['amount_usd'])).toBe(0);
    expect(extractUsd({}, ['amount_usd'])).toBeNull();
  });
});

describe('guard verdicts', () => {
  it('is INACTIVE and makes no call when unconfigured — must not break working lanes', async () => {
    const d = deps({});
    const s = await getSpendStatus({ baseUrl: 'https://management-api.x.ai' }, d);
    expect(s.verdict).toBe('inactive');
    expect(s.reason).toMatch(/XAI_MANAGEMENT_KEY/);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('ALLOWS under the cap and reports headroom', async () => {
    const s = await getSpendStatus({ ...CFG, capUsd: 50 }, deps({
      [PREVIEW]: { body: { amount_due_usd: 12 } },
      [LIMITS]: { body: { soft_limit_usd: 100, hard_limit_usd: 200 } },
      [PREPAID]: { body: { balance_usd: 5 } },
    }));
    expect(s.verdict).toBe('allow');
    expect(s.postpaidDueUsd).toBe(12);
    expect(s.prepaidBalanceUsd).toBe(5);
    expect(s.reason).toMatch(/38\.00 under the operator cap/);
  });

  it('BLOCKS at the operator cap', async () => {
    const s = await getSpendStatus({ ...CFG, capUsd: 10 }, deps({
      [PREVIEW]: { body: { amount_due_usd: 10 } },
    }));
    expect(s.verdict).toBe('block');
    expect(s.reason).toMatch(/operator cap/);
  });

  it("BLOCKS at xAI's own hard limit even with no operator cap", async () => {
    const s = await getSpendStatus(CFG, deps({
      [PREVIEW]: { body: { amount_due_usd: 500 } },
      [LIMITS]: { body: { hard_limit_usd: 400 } },
    }));
    expect(s.verdict).toBe('block');
    expect(s.reason).toMatch(/hard limit/);
  });

  // --- the two failure modes that matter ---

  it('BLOCKS — never allows — when the billing API errors', async () => {
    const s = await getSpendStatus(CFG, deps({ [PREVIEW]: { status: 500 } }));
    expect(s.verdict).toBe('block');
    expect(s.reason).toMatch(/failing closed/i);
  });

  it('BLOCKS when the API is unreachable', async () => {
    const s = await getSpendStatus(CFG, {
      fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch,
    });
    expect(s.verdict).toBe('block');
    expect(s.reason).toMatch(/unverifiable/i);
  });

  it('BLOCKS on an unrecognised response rather than reading it as $0 spend', async () => {
    const s = await getSpendStatus(CFG, deps({ [PREVIEW]: { body: { totally: 'unexpected' } } }));
    expect(s.verdict).toBe('block');
    expect(s.postpaidDueUsd).toBeNull();
    expect(s.reason).toMatch(/UNVERIFIED|unrecognised/i);
  });

  it('still ALLOWS when only the optional limits/balance calls fail', async () => {
    const s = await getSpendStatus({ ...CFG, capUsd: 100 }, deps({
      [PREVIEW]: { body: { amount_due_usd: 3 } },
      [LIMITS]: { status: 500 },
      [PREPAID]: { status: 500 },
    }));
    expect(s.verdict).toBe('allow');
    expect(s.softLimitUsd).toBeNull();
  });

  it('treats a real $0 as allow, not as unreadable', async () => {
    const s = await getSpendStatus({ ...CFG, capUsd: 10 }, deps({
      [PREVIEW]: { body: { amount_due_usd: 0 } },
    }));
    expect(s.verdict).toBe('allow');
    expect(s.postpaidDueUsd).toBe(0);
  });

  it('sends the management key as a bearer token to the documented path', async () => {
    const d = deps({ [PREVIEW]: { body: { amount_due_usd: 1 } } });
    await getSpendStatus(CFG, d);
    const [url, init] = (d.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/billing/teams/team-uuid/');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer mgmt-key');
  });
});

describe('cached read — must not add an HTTP round-trip per LLM call', () => {
  it('serves from cache inside the TTL and refetches after it', async () => {
    __resetSpendCache();
    const d = deps({ [PREVIEW]: { body: { amount_due_usd: 1 } } });
    let clock = 1_000_000;
    const now = () => clock;

    await getSpendStatusCached({ ...CFG, capUsd: 100 }, d, now);
    await getSpendStatusCached({ ...CFG, capUsd: 100 }, d, now);
    // 3 endpoints hit once, not twice.
    expect((d.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);

    clock += 120_001;
    await getSpendStatusCached({ ...CFG, capUsd: 100 }, d, now);
    expect((d.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
  });

  it('caches a block verdict too, so an outage cannot become a stampede', async () => {
    __resetSpendCache();
    const d = deps({ [PREVIEW]: { status: 500 } });
    const now = () => 5_000_000;
    const a = await getSpendStatusCached(CFG, d, now);
    const b = await getSpendStatusCached(CFG, d, now);
    expect(a.verdict).toBe('block');
    expect(b.verdict).toBe('block');
    expect((d.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });
});

describe('assertXaiSpendAllowed', () => {
  beforeEach(() => __resetSpendCache());
  it('throws XaiSpendBlockedError on block, carrying the status', async () => {
    await expect(
      assertXaiSpendAllowed({ ...CFG, capUsd: 1 }, deps({ [PREVIEW]: { body: { amount_due_usd: 5 } } })),
    ).rejects.toThrow(XaiSpendBlockedError);
  });

  it('returns the status on allow', async () => {
    const s = await assertXaiSpendAllowed({ ...CFG, capUsd: 100 },
      deps({ [PREVIEW]: { body: { amount_due_usd: 5 } } }));
    expect(s.verdict).toBe('allow');
  });

  it('does not throw when inactive — unconfigured must not break callers', async () => {
    const s = await assertXaiSpendAllowed({ baseUrl: 'https://management-api.x.ai' }, deps({}));
    expect(s.verdict).toBe('inactive');
  });
});
