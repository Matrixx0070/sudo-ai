/**
 * @file xai-oauth-manager.test.ts
 * @description Unit tests for the xAI subscription OAuth manager. No live
 * calls: fetch/sleep/now are injected seams; the store lives in a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  XaiOAuthManager,
  XaiOAuthReloginRequiredError,
  getXaiOAuthManager,
  __resetXaiOAuthManager,
} from '../../src/llm/xai-oauth-manager.js';

const DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration';
const DEVICE_EP = 'https://auth.x.ai/oauth2/device/code';
const TOKEN_EP = 'https://auth.x.ai/oauth2/token';

const BASE_NOW = 1_800_000_000_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Records every call; dispatches on URL; token-endpoint responses are a queue. */
function makeFetch(tokenResponses: Array<() => Response>) {
  const calls: Array<{ url: string; body: string }> = [];
  let tokenIdx = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? '') });
    if (url === DISCOVERY_URL) {
      return json({ device_authorization_endpoint: DEVICE_EP, token_endpoint: TOKEN_EP });
    }
    if (url === DEVICE_EP) {
      return json({
        device_code: 'dev-code-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://x.ai/activate',
        verification_uri_complete: 'https://x.ai/activate?code=ABCD-EFGH',
        interval: 5,
      });
    }
    if (url === TOKEN_EP) {
      const next = tokenResponses[tokenIdx];
      if (!next) throw new Error(`unexpected token-endpoint call #${tokenIdx + 1}`);
      tokenIdx += 1;
      return next();
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    tokenCalls: () => calls.filter((c) => c.url === TOKEN_EP),
  };
}

describe('XaiOAuthManager', () => {
  let dir: string;
  let storePath: string;
  let now: number;
  let sleeps: number[];

  /** Fake sleep: records the duration and advances the fake clock. */
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    now += ms;
    return Promise.resolve();
  };
  const clock = () => now;

  const writeStore = (obj: Record<string, unknown>): void => {
    writeFileSync(storePath, JSON.stringify(obj), { mode: 0o600 });
  };
  const readStore = (): Record<string, unknown> =>
    JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'xai-oauth-test-'));
    storePath = path.join(dir, 'xai-oauth.json');
    now = BASE_NOW;
    sleeps = [];
    __resetXaiOAuthManager();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    __resetXaiOAuthManager();
  });

  // -------------------------------------------------------------------------
  // Device login flow
  // -------------------------------------------------------------------------

  it('deviceLogin happy path: pending → slow_down → token, interval honored, 0600 persisted', async () => {
    const f = makeFetch([
      () => json({ error: 'authorization_pending' }, 400),
      () => json({ error: 'slow_down' }, 400),
      () => json({ access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 21_600 }),
    ]);
    const mgr = new XaiOAuthManager(storePath, { fetch: f.fetch, sleep, now: clock });

    const codes: Array<[string, string]> = [];
    await mgr.deviceLogin({ onCode: (url, code) => codes.push([url, code]) });

    // Verification surface: complete URI + user code passed to the callback.
    expect(codes).toEqual([['https://x.ai/activate?code=ABCD-EFGH', 'ABCD-EFGH']]);

    // Interval honored: 5s, 5s (pending), then slow_down bumps to 10s.
    expect(sleeps).toEqual([5000, 5000, 10_000]);

    // Poll bodies used the device grant.
    for (const c of f.tokenCalls()) {
      expect(c.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
      expect(c.body).toContain('client_id=b1a00492-073a-47ea-816f-4c329264a828');
    }

    // Persisted 0600 with computed expires_at.
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    const store = readStore();
    expect(store['access_token']).toBe('AT-1');
    expect(store['refresh_token']).toBe('RT-1');
    expect(store['expires_at']).toBe(new Date(now + 21_600_000).toISOString());
    expect(store['obtained_at']).toBe(new Date(now).toISOString());
  });

  // -------------------------------------------------------------------------
  // Refresh discipline
  // -------------------------------------------------------------------------

  it('refresh rotates tokens and persists BEFORE resolving (write-then-use)', async () => {
    writeStore({
      access_token: 'AT-old',
      refresh_token: 'RT-old',
      expires_at: new Date(now - 1000).toISOString(), // already expired
    });
    let persistedAtResolve: Record<string, unknown> | null = null;
    const f = makeFetch([
      () => json({ access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 21_600 }),
    ]);
    const mgr = new XaiOAuthManager(storePath, { fetch: f.fetch, sleep, now: clock });

    // Chain a synchronous disk read onto the resolution: if persistence
    // happened after resolve, this would still see the OLD tokens.
    const token = await mgr.getAccessToken().then((t) => {
      persistedAtResolve = readStore();
      return t;
    });

    expect(token).toBe('AT-new');
    expect(persistedAtResolve).not.toBeNull();
    expect(persistedAtResolve!['access_token']).toBe('AT-new');
    expect(persistedAtResolve!['refresh_token']).toBe('RT-new'); // rotated
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    // Refresh body shape.
    expect(f.tokenCalls()[0]?.body).toContain('grant_type=refresh_token');
    expect(f.tokenCalls()[0]?.body).toContain('refresh_token=RT-old');
  });

  it('expiry skew: 3599s left → refreshes; 2h left → no refresh', async () => {
    // 3599s left — inside the 3600s skew window → refresh.
    writeStore({
      access_token: 'AT-a',
      refresh_token: 'RT-a',
      expires_at: new Date(now + 3599_000).toISOString(),
    });
    const f1 = makeFetch([() => json({ access_token: 'AT-b', refresh_token: 'RT-b', expires_in: 21_600 })]);
    const m1 = new XaiOAuthManager(storePath, { fetch: f1.fetch, sleep, now: clock });
    expect(await m1.getAccessToken()).toBe('AT-b');
    expect(f1.tokenCalls()).toHaveLength(1);

    // 2h left — outside the window → returned as-is, zero fetches.
    writeStore({
      access_token: 'AT-fresh',
      refresh_token: 'RT-fresh',
      expires_at: new Date(now + 7200_000).toISOString(),
    });
    const f2 = makeFetch([]);
    const m2 = new XaiOAuthManager(storePath, { fetch: f2.fetch, sleep, now: clock });
    expect(await m2.getAccessToken()).toBe('AT-fresh');
    expect(f2.calls).toHaveLength(0);
  });

  it('short-token skew guard: 30-min lifetime → effective skew 450s (lifetime/4), not 3600s', async () => {
    // 30-min (1800s) token with 1700s of validity left. The fixed 3600s skew
    // would call this stale ON ARRIVAL — refresh-per-request churn if xAI ever
    // issues ≤1h tokens. min(3600, floor(1800/4)) = 450s keeps it fresh.
    writeStore({
      access_token: 'AT-short',
      refresh_token: 'RT-short',
      obtained_at: new Date(now - 100_000).toISOString(),
      expires_at: new Date(now + 1_700_000).toISOString(),
    });
    const f1 = makeFetch([]);
    const m1 = new XaiOAuthManager(storePath, { fetch: f1.fetch, sleep, now: clock });
    expect(await m1.getAccessToken()).toBe('AT-short');
    expect(f1.calls).toHaveLength(0); // no refresh, no discovery

    // Same 1800s lifetime with only 400s left — inside the 450s effective
    // window → refreshes.
    writeStore({
      access_token: 'AT-short-stale',
      refresh_token: 'RT-short-stale',
      obtained_at: new Date(now - 1_400_000).toISOString(),
      expires_at: new Date(now + 400_000).toISOString(),
    });
    const f2 = makeFetch([() => json({ access_token: 'AT-short-new', refresh_token: 'RT-short-new', expires_in: 1800 })]);
    const m2 = new XaiOAuthManager(storePath, { fetch: f2.fetch, sleep, now: clock });
    expect(await m2.getAccessToken()).toBe('AT-short-new');
    expect(f2.tokenCalls()).toHaveLength(1);
  });

  it('long-token skew unchanged: ~6h lifetime keeps the full 3600s ceiling; no obtained_at → 3600s', async () => {
    // 6h lifetime, 3599s left — lifetime/4 (5400s) exceeds the 3600s ceiling,
    // so the effective skew stays 3600s and this still refreshes.
    writeStore({
      access_token: 'AT-6h',
      refresh_token: 'RT-6h',
      obtained_at: new Date(now + 3_599_000 - 21_600_000).toISOString(),
      expires_at: new Date(now + 3_599_000).toISOString(),
    });
    const f1 = makeFetch([() => json({ access_token: 'AT-6h-new', refresh_token: 'RT-6h-new', expires_in: 21_600 })]);
    const m1 = new XaiOAuthManager(storePath, { fetch: f1.fetch, sleep, now: clock });
    expect(await m1.getAccessToken()).toBe('AT-6h-new');
    expect(f1.tokenCalls()).toHaveLength(1);

    // Lifetime unknown (no obtained_at — legacy/probe-shaped store): falls
    // back to the conservative full 3600s skew — 3599s left refreshes exactly
    // as before this guard.
    writeStore({
      access_token: 'AT-legacy',
      refresh_token: 'RT-legacy',
      expires_at: new Date(now + 3_599_000).toISOString(),
    });
    const f2 = makeFetch([() => json({ access_token: 'AT-legacy-new', refresh_token: 'RT-legacy-new', expires_in: 21_600 })]);
    const m2 = new XaiOAuthManager(storePath, { fetch: f2.fetch, sleep, now: clock });
    expect(await m2.getAccessToken()).toBe('AT-legacy-new');
    expect(f2.tokenCalls()).toHaveLength(1);
  });

  it('invalid_grant: persists needs_relogin, throws typed error, never retries', async () => {
    writeStore({ access_token: 'AT-x', refresh_token: 'RT-dead' });
    const f = makeFetch([() => json({ error: 'invalid_grant' }, 400)]);
    const mgr = new XaiOAuthManager(storePath, { fetch: f.fetch, sleep, now: clock });

    await expect(mgr.getAccessToken()).rejects.toBeInstanceOf(XaiOAuthReloginRequiredError);
    expect(readStore()['needs_relogin']).toBe(true);
    expect(f.tokenCalls()).toHaveLength(1);

    // Second call: throws again WITHOUT another refresh attempt (no new fetch).
    await expect(mgr.getAccessToken()).rejects.toBeInstanceOf(XaiOAuthReloginRequiredError);
    expect(f.tokenCalls()).toHaveLength(1);

    // status() reflects it, with no token material.
    expect(mgr.status()).toEqual({ connected: false, needsRelogin: true });
  });

  it('ROTATION RACE: two concurrent getAccessToken → exactly ONE refresh fetch', async () => {
    writeStore({ access_token: 'AT-old', refresh_token: 'RT-old' }); // probe-shaped, expired-now
    const f = makeFetch([
      () => json({ access_token: 'AT-one', refresh_token: 'RT-one', expires_in: 21_600 }),
    ]);
    const mgr = new XaiOAuthManager(storePath, { fetch: f.fetch, sleep, now: clock });

    const [a, b] = await Promise.all([mgr.getAccessToken(), mgr.getAccessToken()]);
    expect(a).toBe('AT-one');
    expect(b).toBe('AT-one');
    expect(f.tokenCalls()).toHaveLength(1); // single-flight
  });

  // -------------------------------------------------------------------------
  // Cross-process file lock
  // -------------------------------------------------------------------------

  it('held lock (fresh timestamp): second refresh waits until the lock is released', async () => {
    writeStore({ access_token: 'AT-old', refresh_token: 'RT-old' });
    const lockPath = `${storePath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, ts: now })); // fresh — NOT stale

    const f = makeFetch([
      () => json({ access_token: 'AT-w', refresh_token: 'RT-w', expires_in: 21_600 }),
    ]);
    // Release the lock after the 3rd poll sleep — refresh must have been
    // waiting (not refreshing) until then.
    let pollSleeps = 0;
    const waitingSleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      now += ms;
      pollSleeps += 1;
      if (pollSleeps === 3) unlinkSync(lockPath);
      return Promise.resolve();
    };
    const mgr = new XaiOAuthManager(storePath, { fetch: f.fetch, sleep: waitingSleep, now: clock });

    const token = await mgr.getAccessToken();
    expect(token).toBe('AT-w');
    expect(pollSleeps).toBe(3); // waited 3 × 100ms polls
    expect(sleeps).toEqual([100, 100, 100]);
    expect(f.tokenCalls()).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false); // released in finally
  });

  it('held lock never released → times out after ~10s with a lock error', async () => {
    writeStore({ access_token: 'AT-old', refresh_token: 'RT-old' });
    const lockPath = `${storePath}.lock`;
    // Keep the lock perpetually fresh so stale-steal never triggers.
    const freshSleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      now += ms;
      writeFileSync(lockPath, JSON.stringify({ pid: 99999, ts: now }));
      return Promise.resolve();
    };
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, ts: now }));
    const f = makeFetch([]);
    const mgr = new XaiOAuthManager(storePath, { fetch: f.fetch, sleep: freshSleep, now: clock });

    await expect(mgr.getAccessToken()).rejects.toThrow(/Timed out .* xAI OAuth lock/);
    expect(f.calls).toHaveLength(0); // never got to refresh
  });

  it('stale lock (35s old) is stolen and refresh proceeds', async () => {
    writeStore({ access_token: 'AT-old', refresh_token: 'RT-old' });
    const lockPath = `${storePath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, ts: now - 35_000 })); // stale

    const f = makeFetch([
      () => json({ access_token: 'AT-s', refresh_token: 'RT-s', expires_in: 21_600 }),
    ]);
    const mgr = new XaiOAuthManager(storePath, { fetch: f.fetch, sleep, now: clock });

    expect(await mgr.getAccessToken()).toBe('AT-s');
    expect(sleeps).toEqual([]); // stolen immediately — no polling wait
    expect(f.tokenCalls()).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Probe-file adoption + misc
  // -------------------------------------------------------------------------

  it('probe-shaped file (no expires_at) is treated as expired → refresh path, file migrated', async () => {
    // Exact Phase-0 probe shape: expires_in present, expires_at absent.
    writeStore({
      access_token: 'AT-probe',
      token_type: 'Bearer',
      expires_in: 21_600,
      refresh_token: 'RT-probe',
      scope: 'openid profile email offline_access grok-cli:access api:access',
      obtained_at: new Date(now - 60_000).toISOString(),
    });
    const f = makeFetch([
      () => json({ access_token: 'AT-m', refresh_token: 'RT-m', expires_in: 21_600 }),
    ]);
    const mgr = new XaiOAuthManager(storePath, { fetch: f.fetch, sleep, now: clock });

    expect(await mgr.getAccessToken()).toBe('AT-m');
    expect(f.tokenCalls()[0]?.body).toContain('grant_type=refresh_token');
    expect(f.tokenCalls()[0]?.body).toContain('refresh_token=RT-probe');
    // Migrated to the manager's shape with a real expires_at.
    const store = readStore();
    expect(store['expires_at']).toBe(new Date(now + 21_600_000).toISOString());
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
  });

  it('getAccessToken returns null when no store exists; status() disconnected', async () => {
    const f = makeFetch([]);
    const mgr = new XaiOAuthManager(storePath, { fetch: f.fetch, sleep, now: clock });
    expect(await mgr.getAccessToken()).toBeNull();
    expect(mgr.status()).toEqual({ connected: false });
    expect(f.calls).toHaveLength(0);
  });

  it('status() reports connected + expiresAt without token material', () => {
    const exp = new Date(now + 7200_000).toISOString();
    writeStore({ access_token: 'AT-secret', refresh_token: 'RT-secret', expires_at: exp });
    const mgr = new XaiOAuthManager(storePath, { fetch: makeFetch([]).fetch, sleep, now: clock });
    const s = mgr.status();
    expect(s).toEqual({ connected: true, expiresAt: exp });
    expect(JSON.stringify(s)).not.toContain('secret');
  });

  it('singleton accessor returns a stable instance; __reset creates a new one', () => {
    const a = getXaiOAuthManager();
    expect(getXaiOAuthManager()).toBe(a);
    __resetXaiOAuthManager();
    expect(getXaiOAuthManager()).not.toBe(a);
  });
});
