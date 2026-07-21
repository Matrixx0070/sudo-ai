/**
 * @file grok-models.test.ts
 * @description Unit tests for the subscription-free Grok model catalog +
 * rate-limit lanes. NO net/browser/disk: the manager + bridge are injected.
 * Mocks mirror the REAL response shapes probed live 2026-07-21. The live
 * grok.com round-trip is proven separately (never in CI).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  process.env['SUDO_GROK_WEBSESSION'] = '1';
});
afterEach(() => {
  delete process.env['SUDO_GROK_WEBSESSION'];
  vi.resetModules();
});

const SESSION = { cookie: 'cf_clearance=X; sso=Y', userAgent: 'UA' };
function fakeManager(session = SESSION) {
  return {
    ensureHealthy: async () => session,
  } as unknown as import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}

/** Mirrors the exact live /rest/models shape (reshaped by the python bridge). */
const CATALOG_RESPONSE = {
  ok: true,
  models: [
    {
      modelId: 'grok-4-auto',
      name: '',
      description: '',
      modeDescription: '',
      modeName: '',
      badgeText: ' ',
      tags: ['computer'],
      modelMode: 'MODEL_MODE_AUTO',
      promptingBackend: 'CHAT',
    },
    {
      modelId: 'grok-4',
      name: 'Grok 4',
      description: 'Flagship',
      modeDescription: '',
      modeName: '',
      badgeText: '',
      tags: [],
      modelMode: 'MODEL_MODE_EXPERT',
      promptingBackend: 'CHAT',
    },
  ],
  unavailableModels: [],
  defaults: {
    free: 'grok-3',
    pro: 'grok-4',
    heavy: 'grok-4',
    anon: 'grok-3',
    freeMode: 'MODEL_MODE_AUTO',
    proMode: 'MODEL_MODE_AUTO',
    heavyMode: 'MODEL_MODE_AUTO',
    anonMode: 'MODEL_MODE_AUTO',
  },
};

describe('getGrokModelCatalog', () => {
  it('sends a models op with cookie creds and parses the catalog', async () => {
    const { getGrokModelCatalog } = await import('../../src/llm/grok-models.js');
    const bridge = vi.fn(async (req: { op: string }, creds: { cookie: string; userAgent: string }) => {
      expect(req.op).toBe('models');
      expect(creds.cookie).toBe(SESSION.cookie);
      expect(creds.userAgent).toBe(SESSION.userAgent);
      return CATALOG_RESPONSE;
    });
    const c = await getGrokModelCatalog({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(c.models).toHaveLength(2);
    expect(c.models[0]?.modelId).toBe('grok-4-auto');
    expect(c.models[1]?.modelMode).toBe('MODEL_MODE_EXPERT');
    expect(c.unavailableModels).toEqual([]);
    expect(c.defaults.free).toBe('grok-3');
    expect(c.defaults.pro).toBe('grok-4');
    expect(c.defaults.heavy).toBe('grok-4');
    expect(c.defaults.proMode).toBe('MODEL_MODE_AUTO');
  });

  it('flag OFF → GrokWebDisabledError (never calls the bridge)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { getGrokModelCatalog, GrokWebDisabledError } = await import('../../src/llm/grok-models.js');
    let called = false;
    await expect(
      getGrokModelCatalog({
        deps: { manager: fakeManager(), bridge: (async () => { called = true; return CATALOG_RESPONSE; }) as never },
      }),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(called).toBe(false);
  });

  it('bridge ok:false → surfaces a structured error', async () => {
    const { getGrokModelCatalog } = await import('../../src/llm/grok-models.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'cloudflare' as const, detail: 'Just a moment' }));
    await expect(
      getGrokModelCatalog({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok model catalog failed: cloudflare/);
  });

  it('passes the locale through to the bridge', async () => {
    const { getGrokModelCatalog } = await import('../../src/llm/grok-models.js');
    const bridge = vi.fn(async (req: { op: string; locale?: string }) => {
      expect(req.locale).toBe('de');
      return CATALOG_RESPONSE;
    });
    await getGrokModelCatalog({ locale: 'de', deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(bridge).toHaveBeenCalledOnce();
  });
});

describe('getGrokRateLimits', () => {
  /** Mirrors the exact live /rest/rate-limits shape. */
  const LIMITS_RESPONSE = {
    ok: true,
    modelName: 'grok-4',
    requestKind: 'DEFAULT',
    windowSizeSeconds: 7200,
    remainingQueries: 40,
    totalQueries: 40,
    lowEffortRateLimits: null,
    highEffortRateLimits: null,
  };

  it('sends a rate_limits op and parses the windows', async () => {
    const { getGrokRateLimits } = await import('../../src/llm/grok-models.js');
    const bridge = vi.fn(async (req: { op: string; modelName?: string }) => {
      expect(req.op).toBe('rate_limits');
      expect(req.modelName).toBe('grok-4');
      return LIMITS_RESPONSE;
    });
    const r = await getGrokRateLimits('grok-4', { deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r.remainingQueries).toBe(40);
    expect(r.totalQueries).toBe(40);
    expect(r.windowSizeSeconds).toBe(7200);
    expect(r.requestKind).toBe('DEFAULT');
  });

  it('empty modelName → TypeError before touching the network', async () => {
    const { getGrokRateLimits } = await import('../../src/llm/grok-models.js');
    await expect(
      getGrokRateLimits('   ', { deps: { manager: fakeManager(), bridge: (async () => LIMITS_RESPONSE) as never } }),
    ).rejects.toThrow(/non-empty/);
  });

  it('flag OFF → GrokWebDisabledError', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { getGrokRateLimits, GrokWebDisabledError } = await import('../../src/llm/grok-models.js');
    await expect(
      getGrokRateLimits('grok-4', { deps: { manager: fakeManager(), bridge: (async () => LIMITS_RESPONSE) as never } }),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
  });

  it('bridge ok:false → surfaces a structured error', async () => {
    const { getGrokRateLimits } = await import('../../src/llm/grok-models.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'relogin' as const, detail: 'sso dead' }));
    await expect(
      getGrokRateLimits('grok-4', { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok rate limits failed: relogin/);
  });
});
