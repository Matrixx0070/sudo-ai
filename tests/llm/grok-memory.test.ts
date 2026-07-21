/**
 * @file grok-memory.test.ts
 * @description Unit tests for the subscription-free Grok persistent-memory
 * lanes (blurb read/write/clear + imported memory). NO net/browser/disk: the
 * manager + bridge are injected. Mocks mirror the REAL response shapes probed
 * live 2026-07-21 (GET blurb → {memoryContent}; PUT blurb → 200 echo that can
 * be silently dropped server-side, hence the persisted/readBack fields). The
 * live grok.com round-trip is proven separately (never in CI).
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

describe('getGrokMemoryBlurb', () => {
  it('sends a blurb_get op with cookie creds and parses memoryContent', async () => {
    const { getGrokMemoryBlurb } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async (req: { op: string }, creds: { cookie: string; userAgent: string }) => {
      expect(req.op).toBe('blurb_get');
      expect(creds.cookie).toBe(SESSION.cookie);
      expect(creds.userAgent).toBe(SESSION.userAgent);
      // Mirrors the exact live GET /rest/app-chat/user-memory-blurb shape.
      return { ok: true, memoryContent: 'Frank prefers terse answers.' };
    });
    const r = await getGrokMemoryBlurb({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r.memoryContent).toBe('Frank prefers terse answers.');
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('accepts an empty blurb (account with no memory yet)', async () => {
    const { getGrokMemoryBlurb } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async () => ({ ok: true, memoryContent: '' }));
    const r = await getGrokMemoryBlurb({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r.memoryContent).toBe('');
  });

  it('flag OFF → GrokWebDisabledError (never calls the bridge)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { getGrokMemoryBlurb, GrokWebDisabledError } = await import('../../src/llm/grok-memory.js');
    let called = false;
    await expect(
      getGrokMemoryBlurb({
        deps: {
          manager: fakeManager(),
          bridge: (async () => { called = true; return { ok: true, memoryContent: '' }; }) as never,
        },
      }),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(called).toBe(false);
  });

  it('bridge ok:false → surfaces a structured error', async () => {
    const { getGrokMemoryBlurb } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'cloudflare' as const, detail: 'Just a moment' }));
    await expect(
      getGrokMemoryBlurb({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok memory read failed: cloudflare/);
  });

  it('missing memoryContent in an ok reply → structured error (no silent empty)', async () => {
    const { getGrokMemoryBlurb } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async () => ({ ok: true }));
    await expect(
      getGrokMemoryBlurb({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok memory read failed/);
  });
});

describe('setGrokMemoryBlurb', () => {
  it('empty content → TypeError (never calls the bridge)', async () => {
    const { setGrokMemoryBlurb } = await import('../../src/llm/grok-memory.js');
    let called = false;
    await expect(
      setGrokMemoryBlurb('   ', {
        deps: { manager: fakeManager(), bridge: (async () => { called = true; return { ok: true }; }) as never },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(called).toBe(false);
  });

  it('sends blurb_set and reports read-back persistence honestly (persisted:false case, as probed live)', async () => {
    const { setGrokMemoryBlurb } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async (req: { op: string; memoryContent?: string }) => {
      expect(req.op).toBe('blurb_set');
      expect(req.memoryContent).toBe('remember: probe');
      // Live 2026-07-21: PUT 200-echoes but read-back stays "" (server drops it).
      return { ok: true, memoryContent: 'remember: probe', persisted: false, readBack: '' };
    });
    const r = await setGrokMemoryBlurb('remember: probe', {
      deps: { manager: fakeManager(), bridge: bridge as never },
    });
    expect(r.persisted).toBe(false);
    expect(r.readBack).toBe('');
    expect(r.memoryContent).toBe('remember: probe');
  });

  it('persisted:true when the read-back matches', async () => {
    const { setGrokMemoryBlurb } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async () => ({ ok: true, memoryContent: 'kept', persisted: true, readBack: 'kept' }));
    const r = await setGrokMemoryBlurb('kept', { deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r.persisted).toBe(true);
  });

  it('bridge ok:false → structured throw', async () => {
    const { setGrokMemoryBlurb } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'relogin' as const, detail: 'sso dead' }));
    await expect(
      setGrokMemoryBlurb('x', { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok memory write failed: relogin/);
  });
});

describe('clearGrokMemoryBlurb', () => {
  it('sends blurb_clear and returns the verified persistence flag', async () => {
    const { clearGrokMemoryBlurb } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('blurb_clear');
      // Mirrors live: DELETE 200 {} then GET read-back "".
      return { ok: true, persisted: true };
    });
    const r = await clearGrokMemoryBlurb({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r.persisted).toBe(true);
  });

  it('bridge ok:false → structured throw', async () => {
    const { clearGrokMemoryBlurb } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'http_error' as const, detail: 'HTTP 500' }));
    await expect(
      clearGrokMemoryBlurb({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok memory clear failed: http_error/);
  });
});

describe('getGrokImportedMemory', () => {
  it('sends imported_get and parses content + status', async () => {
    const { getGrokImportedMemory } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('imported_get');
      // Mirrors the exact live shapes: {content} + {status}.
      return { ok: true, content: '', importStatus: 'IMPORTED_MEMORY_STATUS_NONE' };
    });
    const r = await getGrokImportedMemory({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r.content).toBe('');
    expect(r.status).toBe('IMPORTED_MEMORY_STATUS_NONE');
  });

  it('bridge ok:false → structured throw', async () => {
    const { getGrokImportedMemory } = await import('../../src/llm/grok-memory.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'timeout' as const, detail: 'bridge timed out' }));
    await expect(
      getGrokImportedMemory({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok imported-memory read failed: timeout/);
  });
});
