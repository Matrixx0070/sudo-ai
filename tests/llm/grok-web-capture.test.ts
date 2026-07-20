/**
 * @file grok-web-capture.test.ts
 * @description Unit tests for the GW4 headless capture/refresh. NO real browser:
 * the persistent-context launcher is a fake that plays back cookies, a UA, and a
 * simulated grok.com /rest/ request carrying x-statsig-id.
 */
import { describe, it, expect } from 'vitest';
import { captureGrokWebSession, makeGrokWebRefresher, type LaunchedContext, type PersistentLauncher } from '../../src/llm/grok-web-capture.js';
import { GrokWebReloginRequiredError } from '../../src/llm/grok-web-session-manager.js';

type Cookie = { name: string; value: string; domain: string };

function fakeLauncher(cfg: {
  cookies: Cookie[];
  ua?: string;
  statsig?: string;
  url?: string;
}): { launcher: PersistentLauncher; closed: () => boolean } {
  let closed = false;
  const launcher: PersistentLauncher = async (): Promise<LaunchedContext> => {
    let reqHandler: ((r: { url: () => string; headers: () => Record<string, string> }) => void) | null = null;
    const context = {
      cookies: async (_url?: string) => cfg.cookies,
      close: async () => {
        closed = true;
      },
      newPage: async () => ({}) as never,
      pages: () => [{}] as never,
    };
    const page = {
      goto: async () => {
        // Simulate the app firing a /rest/ request with x-statsig-id on load.
        if (reqHandler && cfg.statsig) {
          reqHandler({ url: () => 'https://grok.com/rest/media/imagine/quota_info', headers: () => ({ 'x-statsig-id': cfg.statsig! }) });
        }
        return null as never;
      },
      reload: async () => {
        if (reqHandler && cfg.statsig) {
          reqHandler({ url: () => 'https://grok.com/rest/media/imagine/quota_info', headers: () => ({ 'x-statsig-id': cfg.statsig! }) });
        }
        return null as never;
      },
      on: (evt: string, h: (r: { url: () => string; headers: () => Record<string, string> }) => void) => {
        if (evt === 'request') reqHandler = h;
      },
      evaluate: async () => cfg.ua ?? 'Mozilla/5.0 Chrome/150',
      url: () => cfg.url ?? 'https://grok.com/imagine',
      waitForTimeout: async () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { context: context as any, page: page as any };
  };
  return { launcher, closed: () => closed };
}

const HEALTHY_COOKIES: Cookie[] = [
  { name: 'sso', value: 'SSOVAL', domain: '.grok.com' },
  { name: 'sso-rw', value: 'RW', domain: '.grok.com' },
  { name: 'cf_clearance', value: 'CFVAL', domain: '.grok.com' },
  { name: '__cf_bm', value: 'BM', domain: '.grok.com' },
  { name: 'x-userid', value: 'U', domain: 'grok.com' },
  { name: 'not_grok', value: 'X', domain: '.example.com' },
];

describe('captureGrokWebSession', () => {
  it('harvests cookie header + UA + statsig and closes the context', async () => {
    const f = fakeLauncher({ cookies: HEALTHY_COOKIES, ua: 'UA/150', statsig: 'STATSIG123' });
    const r = await captureGrokWebSession('/prof', { launcher: f.launcher, clearTimeoutMs: 100 });
    expect(r.cookie).toContain('cf_clearance=CFVAL');
    expect(r.cookie).toContain('sso=SSOVAL');
    expect(r.cookie).not.toContain('not_grok'); // non-grok cookies excluded
    expect(r.userAgent).toBe('UA/150');
    expect(r.statsigId).toBe('STATSIG123');
    expect(r.profileDir).toBe('/prof');
    expect(f.closed()).toBe(true);
  });

  it('captures image-usable session even when statsig never appears (video best-effort)', async () => {
    const f = fakeLauncher({ cookies: HEALTHY_COOKIES }); // no statsig
    const r = await captureGrokWebSession('/prof', { launcher: f.launcher, clearTimeoutMs: 100 });
    expect(r.cookie).toContain('cf_clearance');
    expect(r.statsigId).toBeUndefined();
  });

  it('throws relogin when sso cookie is absent', async () => {
    const noSso = HEALTHY_COOKIES.filter((c) => c.name !== 'sso');
    const f = fakeLauncher({ cookies: noSso, statsig: 'S' });
    await expect(captureGrokWebSession('/prof', { launcher: f.launcher, clearTimeoutMs: 100 })).rejects.toBeInstanceOf(GrokWebReloginRequiredError);
    expect(f.closed()).toBe(true); // context still closed on the relogin path
  });

  it('throws relogin when the page is on a sign-in URL', async () => {
    const f = fakeLauncher({ cookies: HEALTHY_COOKIES, statsig: 'S', url: 'https://accounts.x.ai/sign-in' });
    await expect(captureGrokWebSession('/prof', { launcher: f.launcher, clearTimeoutMs: 100 })).rejects.toBeInstanceOf(GrokWebReloginRequiredError);
  });

  it('throws a transient (non-relogin) error when cf_clearance never issues', async () => {
    const noCf = HEALTHY_COOKIES.filter((c) => c.name !== 'cf_clearance');
    const f = fakeLauncher({ cookies: noCf, statsig: 'S' });
    const err = await captureGrokWebSession('/prof', { launcher: f.launcher, clearTimeoutMs: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GrokWebReloginRequiredError);
    expect(String(err.message)).toContain('cf_clearance');
  });
});

describe('makeGrokWebRefresher', () => {
  it('uses the stored profileDir', async () => {
    const f = fakeLauncher({ cookies: HEALTHY_COOKIES, statsig: 'S' });
    const refresher = makeGrokWebRefresher({ launcher: f.launcher, clearTimeoutMs: 100 });
    const r = await refresher('/stored-prof');
    expect(r.profileDir).toBe('/stored-prof');
  });

  it('falls back to defaultProfileDir', async () => {
    const f = fakeLauncher({ cookies: HEALTHY_COOKIES, statsig: 'S' });
    const refresher = makeGrokWebRefresher({ launcher: f.launcher, clearTimeoutMs: 100, defaultProfileDir: '/default' });
    const r = await refresher(undefined);
    expect(r.profileDir).toBe('/default');
  });

  it('throws relogin when no profile dir is available at all', async () => {
    const refresher = makeGrokWebRefresher({});
    await expect(refresher(undefined)).rejects.toBeInstanceOf(GrokWebReloginRequiredError);
  });
});
