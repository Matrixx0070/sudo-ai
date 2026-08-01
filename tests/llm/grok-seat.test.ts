/**
 * @file grok-seat.test.ts
 * @description GrokSeat façade (ADR 0008) — health/observability contract.
 *
 * These assert the properties whose ABSENCE caused five silent seat outages in a
 * week: dead credentials must be reported as `down` with a remedy, a degraded
 * mint path must not read as healthy, and — critically — a health check must
 * never touch a metered endpoint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const cookieStatus = { connected: true, capturedAt: new Date().toISOString() } as {
  connected: boolean;
  capturedAt?: string;
  needsRelogin?: boolean;
};
const oauthStatus = { connected: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as {
  connected: boolean;
  expiresAt?: string;
  needsRelogin?: boolean;
};
let session: { cookie: string; userAgent: string } | null = { cookie: 'sso=X', userAgent: 'UA' };

vi.mock('../../src/llm/grok-web-session-manager.js', () => ({
  getGrokWebSessionManager: () => ({
    status: () => cookieStatus,
    loadSession: () => session,
  }),
}));
vi.mock('../../src/llm/xai-oauth-manager.js', () => ({
  getXaiOAuthManager: () => ({ status: () => oauthStatus }),
}));
vi.mock('../../src/llm/grok-statsig-pool.js', () => ({
  isGrokBrowserlessActive: () => true,
}));

const OK_SUBS = { ok: true, status: 200, json: async () => ({}) };
const OK_QUOTA = { ok: true, status: 200, json: async () => ({ remainingQueries: 40, totalQueries: 40 }) };

beforeEach(() => {
  cookieStatus.connected = true;
  cookieStatus.needsRelogin = undefined;
  cookieStatus.capturedAt = new Date().toISOString();
  oauthStatus.connected = true;
  oauthStatus.needsRelogin = undefined;
  oauthStatus.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  session = { cookie: 'sso=X', userAgent: 'UA' };
  process.env['SUDO_GROK_STATSIG_BROWSERLESS'] = '1';
});
afterEach(() => {
  delete process.env['SUDO_GROK_STATSIG_BROWSERLESS'];
  vi.resetModules();
});

describe('GrokSeat.status (offline)', () => {
  it('reports ok and requires no network when both lanes hold credentials', async () => {
    const { GrokSeat } = await import('../../src/llm/grok-seat.js');
    const fetchImpl = vi.fn();
    const s = new GrokSeat({ fetchImpl: fetchImpl as never }).status();

    expect(s.overall).toBe('ok');
    expect(s.needsLogin).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled(); // status() is strictly offline
  });

  it('surfaces a dead cookie session as down WITH a remedy, and flags needsLogin', async () => {
    cookieStatus.needsRelogin = true;
    const { GrokSeat } = await import('../../src/llm/grok-seat.js');
    const s = new GrokSeat().status();

    expect(s.overall).toBe('down');
    expect(s.needsLogin).toBe(true);
    const check = s.checks.find((c) => c.name === 'cookie-credentials')!;
    expect(check.health).toBe('down');
    expect(check.remedy).toBeTruthy(); // a failure without an action is not actionable
  });

  it('an expired-but-refreshable oauth token is degraded, not down', async () => {
    oauthStatus.expiresAt = new Date(Date.now() - 1000).toISOString();
    const { GrokSeat } = await import('../../src/llm/grok-seat.js');
    const s = new GrokSeat().status();

    const check = s.checks.find((c) => c.name === 'oauth-credentials')!;
    expect(check.health).toBe('degraded');
    expect(s.needsLogin).toBe(false); // refresh handles it; no human needed
  });

  it('the slow oracle mint path reads as degraded, never ok', async () => {
    process.env['SUDO_GROK_STATSIG_BROWSERLESS'] = '0';
    const { GrokSeat } = await import('../../src/llm/grok-seat.js');
    const s = new GrokSeat().status();

    const check = s.checks.find((c) => c.name === 'statsig-minting')!;
    expect(check.health).toBe('degraded');
    expect(s.overall).toBe('degraded');
  });
});

describe('GrokSeat.doctor (live, $0)', () => {
  it('probes ONLY free cookie-lane endpoints — never a metered one', async () => {
    const { GrokSeat } = await import('../../src/llm/grok-seat.js');
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(String(url));
      return String(url).includes('rate-limits') ? OK_QUOTA : OK_SUBS;
    });

    const s = await new GrokSeat({ fetchImpl: fetchImpl as never }).doctor();

    expect(s.overall).toBe('ok');
    // Every probed host is grok.com (subscription-covered). The metered lane
    // (cli-chat-proxy / api.x.ai) must never appear — a paid health check is a bug.
    expect(seen.every((u) => u.startsWith('https://grok.com/rest/'))).toBe(true);
    expect(seen.some((u) => u.includes('cli-chat-proxy') || u.includes('api.x.ai'))).toBe(false);
    expect(s.checks.find((c) => c.name === 'free-quota')!.detail).toContain('40/40');
  });

  it('reports exhausted free quota as degraded rather than healthy', async () => {
    const { GrokSeat } = await import('../../src/llm/grok-seat.js');
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes('rate-limits')
        ? { ok: true, status: 200, json: async () => ({ remainingQueries: 0, totalQueries: 40 }) }
        : OK_SUBS,
    );

    const s = await new GrokSeat({ fetchImpl: fetchImpl as never }).doctor();
    expect(s.checks.find((c) => c.name === 'free-quota')!.health).toBe('degraded');
  });

  it('a rejected session is down with a remedy', async () => {
    const { GrokSeat } = await import('../../src/llm/grok-seat.js');
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));

    const s = await new GrokSeat({ fetchImpl: fetchImpl as never }).doctor();
    const check = s.checks.find((c) => c.name === 'cookie-lane-live')!;
    expect(check.health).toBe('down');
    expect(check.remedy).toBeTruthy();
  });

  it('never throws when the network is unreachable — it degrades to unknown', async () => {
    const { GrokSeat } = await import('../../src/llm/grok-seat.js');
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const s = await new GrokSeat({ fetchImpl: fetchImpl as never }).doctor();
    expect(s.checks.find((c) => c.name === 'cookie-lane-live')!.health).toBe('unknown');
    // One failed probe, not two — no point repeating a dead network.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('formatSeatStatus', () => {
  it('names the failing checks so a log line is actionable on its own', async () => {
    cookieStatus.needsRelogin = true;
    const { GrokSeat, formatSeatStatus } = await import('../../src/llm/grok-seat.js');
    const line = formatSeatStatus(new GrokSeat().status());

    expect(line).toContain('down');
    expect(line).toContain('cookie-credentials');
  });
});
