/**
 * @file grok-web-session-manager.test.ts
 * @description Unit tests for the GW3 grok-web session manager. NO net, NO
 * browser: the bridge and refresher are injected seams; the store is a temp file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebDeps,
} from '../../src/llm/grok-web-session-manager.js';
import type { GrokWebResponse } from '../../src/llm/grok-web-bridge.js';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gw3-'));
  storePath = path.join(dir, 'grok-web-session.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ok200: GrokWebResponse = { ok: true, status: 200, quota: { image: { available: true, windowSizeSeconds: 64800 } } };

function mgr(overrides: Partial<GrokWebDeps> = {}): GrokWebSessionManager {
  const deps: Partial<GrokWebDeps> = {
    bridge: async () => ok200,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return new GrokWebSessionManager(storePath, deps);
}

describe('persistence', () => {
  it('capture writes a 0600 store and loads it back', () => {
    const m = mgr();
    m.capture({ cookie: 'cf_clearance=X; sso=Y', userAgent: 'UA/1', statsigId: 'SS' });
    const mode = statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
    const s = m.loadSession();
    expect(s?.cookie).toContain('cf_clearance');
    expect(s?.statsigId).toBe('SS');
    expect(s?.capturedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('never writes secrets into status()', () => {
    const m = mgr();
    m.capture({ cookie: 'cf_clearance=SECRET', userAgent: 'UA', statsigId: 'SECRET2' });
    const st = m.status();
    expect(JSON.stringify(st)).not.toContain('SECRET');
    expect(st.connected).toBe(true);
    expect(st.hasStatsig).toBe(true);
  });

  it('missing store → not connected', () => {
    expect(mgr().status()).toEqual({ connected: false });
    expect(mgr().loadSession()).toBeNull();
  });
});

describe('health', () => {
  it('isHealthy true on 200 probe', async () => {
    const m = mgr();
    m.capture({ cookie: 'c', userAgent: 'u' });
    expect(await m.isHealthy()).toBe(true);
  });

  it('probe with no session returns relogin class (no bridge call)', async () => {
    let called = false;
    const m = mgr({ bridge: async () => { called = true; return ok200; } });
    const r = await m.probe();
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe('relogin');
    expect(called).toBe(false);
  });
});

describe('ensureHealthy + refresh', () => {
  it('cloudflare probe → single refresh → healthy', async () => {
    let probeCall = 0;
    let refreshed = false;
    const m = mgr({
      bridge: async () => (probeCall++ === 0 ? { ok: false, status: 403, errorClass: 'cloudflare' } : ok200),
      refresher: async (profileDir) => {
        refreshed = true;
        expect(profileDir).toBe('/prof');
        return { cookie: 'cf_clearance=NEW; sso=Y', userAgent: 'UA', statsigId: 'SS2', profileDir: '/prof' };
      },
    });
    m.capture({ cookie: 'cf_clearance=OLD; sso=Y', userAgent: 'UA', statsigId: 'SS1', profileDir: '/prof' });
    const s = await m.ensureHealthy();
    expect(refreshed).toBe(true);
    expect(s.cookie).toContain('NEW');
    // refreshed session persisted
    expect(m.loadSession()?.cookie).toContain('NEW');
  });

  it('relogin probe → marks needsRelogin and throws, no refresh', async () => {
    let refreshed = false;
    const m = mgr({
      bridge: async () => ({ ok: false, status: 401, errorClass: 'relogin' }),
      refresher: async () => { refreshed = true; return { cookie: 'x', userAgent: 'u' }; },
    });
    m.capture({ cookie: 'c', userAgent: 'u' });
    await expect(m.ensureHealthy()).rejects.toBeInstanceOf(GrokWebReloginRequiredError);
    expect(refreshed).toBe(false);
    expect(m.loadSession()?.needsRelogin).toBe(true);
    expect(m.status()).toEqual({ connected: false, needsRelogin: true });
  });

  it('refresher throwing relogin marks the store and rethrows', async () => {
    const m = mgr({
      bridge: async () => ({ ok: false, status: 403, errorClass: 'cloudflare' }),
      refresher: async () => { throw new GrokWebReloginRequiredError(); },
    });
    m.capture({ cookie: 'c', userAgent: 'u' });
    await expect(m.ensureHealthy()).rejects.toBeInstanceOf(GrokWebReloginRequiredError);
    expect(m.loadSession()?.needsRelogin).toBe(true);
  });

  it('refresh is single-flighted (concurrent callers share one)', async () => {
    let refreshCount = 0;
    const m = mgr({
      refresher: async () => {
        refreshCount++;
        await new Promise((r) => setTimeout(r, 10));
        return { cookie: 'cf_clearance=NEW', userAgent: 'u' };
      },
    });
    m.capture({ cookie: 'old', userAgent: 'u' });
    await Promise.all([m.refresh(), m.refresh(), m.refresh()]);
    expect(refreshCount).toBe(1);
  });

  it('needsRelogin session → ensureHealthy throws without probing', async () => {
    let probed = false;
    const m = mgr({ bridge: async () => { probed = true; return ok200; } });
    m.capture({ cookie: 'c', userAgent: 'u' });
    // force needsRelogin
    const s = m.loadSession()!;
    m.saveSession({ ...s, needsRelogin: true });
    await expect(m.ensureHealthy()).rejects.toBeInstanceOf(GrokWebReloginRequiredError);
    expect(probed).toBe(false);
  });
});
