/**
 * @file grok-skills.test.ts
 * @description Unit tests for the subscription-free Grok skills lanes
 * (installed list/search/get, verified marketplace, enable/disable toggle).
 * NO net/browser/disk: the manager + bridge are injected. Mocks mirror the
 * REAL response shapes probed live 2026-07-22 (GET /rest/user-skills →
 * {skills:[{name,description,enabled,...}]}; POST {name}/enabled → 200 echo,
 * read-back verified, hence the persisted field). The live grok.com
 * round-trip is proven separately (never in CI).
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

// Mirrors the exact live GET /rest/user-skills summary shape (2026-07-22).
const BROWSER_USE = {
  name: 'browser-use',
  description: 'Use for web browsing automation content extraction data scraping',
  enabled: true,
  fileCount: 1,
  totalBytes: '9788',
  updatedAt: '2026-06-05T20:40:19.588+00:00',
};

describe('listGrokUserSkills', () => {
  it('sends a list op with cookie creds and parses the skills array', async () => {
    const { listGrokUserSkills } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async (req: { op: string }, creds: { cookie: string; userAgent: string }) => {
      expect(req.op).toBe('list');
      expect(creds.cookie).toBe(SESSION.cookie);
      expect(creds.userAgent).toBe(SESSION.userAgent);
      return { ok: true, skills: [BROWSER_USE] };
    });
    const r = await listGrokUserSkills({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('browser-use');
    expect(r[0]!.enabled).toBe(true);
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('query set → sends a search op with q', async () => {
    const { listGrokUserSkills } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async (req: { op: string; q?: string }) => {
      expect(req.op).toBe('search');
      expect(req.q).toBe('browser');
      return { ok: true, skills: [BROWSER_USE] };
    });
    const r = await listGrokUserSkills({
      query: 'browser',
      deps: { manager: fakeManager(), bridge: bridge as never },
    });
    expect(r).toHaveLength(1);
  });

  it('flag OFF → GrokWebDisabledError (never calls the bridge)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { listGrokUserSkills, GrokWebDisabledError } = await import('../../src/llm/grok-skills.js');
    let called = false;
    await expect(
      listGrokUserSkills({
        deps: {
          manager: fakeManager(),
          bridge: (async () => { called = true; return { ok: true, skills: [] }; }) as never,
        },
      }),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(called).toBe(false);
  });

  it('bridge ok:false → surfaces a structured error', async () => {
    const { listGrokUserSkills } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'cloudflare' as const, detail: 'Just a moment' }));
    await expect(
      listGrokUserSkills({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok skills list failed: cloudflare/);
  });

  it('ok reply without a skills array → structured error (no silent empty)', async () => {
    const { listGrokUserSkills } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async () => ({ ok: true }));
    await expect(
      listGrokUserSkills({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok skills list failed/);
  });
});

describe('getGrokUserSkill', () => {
  it('empty name → TypeError (never calls the bridge)', async () => {
    const { getGrokUserSkill } = await import('../../src/llm/grok-skills.js');
    let called = false;
    await expect(
      getGrokUserSkill('  ', {
        deps: { manager: fakeManager(), bridge: (async () => { called = true; return { ok: true }; }) as never },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(called).toBe(false);
  });

  it('sends a get op and parses the full skill (incl. SKILL.md body)', async () => {
    const { getGrokUserSkill } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async (req: { op: string; name?: string }) => {
      expect(req.op).toBe('get');
      expect(req.name).toBe('browser-use');
      return { ok: true, skill: { ...BROWSER_USE, skillMdContent: '---\nname: "browser-use"\n---\n# Browser Use' } };
    });
    const s = await getGrokUserSkill('browser-use', {
      deps: { manager: fakeManager(), bridge: bridge as never },
    });
    expect(s.name).toBe('browser-use');
    expect(s.skillMdContent).toContain('# Browser Use');
  });

  it('bridge ok:false → structured throw', async () => {
    const { getGrokUserSkill } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'http_error' as const, detail: 'HTTP 404' }));
    await expect(
      getGrokUserSkill('nope', { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok skills get failed: http_error/);
  });
});

describe('listGrokVerifiedSkills', () => {
  it('sends verified_published and parses skills + nextPageToken', async () => {
    const { listGrokVerifiedSkills } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('verified_published');
      // Mirrors live: 200 {"skills":[], "nextPageToken":""} on this seat.
      return { ok: true, skills: [], nextPageToken: '' };
    });
    const r = await listGrokVerifiedSkills({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(r.skills).toEqual([]);
    expect(r.nextPageToken).toBe('');
  });

  it('bridge ok:false (org-scoped 403) → structured throw', async () => {
    const { listGrokVerifiedSkills } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async () => ({
      ok: false,
      errorClass: 'http_error' as const,
      detail: 'HTTP 403: organization context required',
    }));
    await expect(
      listGrokVerifiedSkills({ deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/Grok skills verified list failed: http_error/);
  });
});

describe('setGrokUserSkillEnabled', () => {
  it('empty name → TypeError (never calls the bridge)', async () => {
    const { setGrokUserSkillEnabled } = await import('../../src/llm/grok-skills.js');
    let called = false;
    await expect(
      setGrokUserSkillEnabled('', false, {
        deps: { manager: fakeManager(), bridge: (async () => { called = true; return { ok: true }; }) as never },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(called).toBe(false);
  });

  it('non-boolean enabled → TypeError (never calls the bridge)', async () => {
    const { setGrokUserSkillEnabled } = await import('../../src/llm/grok-skills.js');
    let called = false;
    await expect(
      setGrokUserSkillEnabled('browser-use', 'yes' as never, {
        deps: { manager: fakeManager(), bridge: (async () => { called = true; return { ok: true }; }) as never },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(called).toBe(false);
  });

  it('sends set_enabled and reports read-back persistence (live round-trip shape)', async () => {
    const { setGrokUserSkillEnabled } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async (req: { op: string; name?: string; enabled?: boolean }) => {
      expect(req.op).toBe('set_enabled');
      expect(req.name).toBe('browser-use');
      expect(req.enabled).toBe(false);
      // Mirrors live 2026-07-22: POST 200 echo then GET read-back false.
      return { ok: true, name: 'browser-use', enabled: false, persisted: true };
    });
    const r = await setGrokUserSkillEnabled('browser-use', false, {
      deps: { manager: fakeManager(), bridge: bridge as never },
    });
    expect(r.enabled).toBe(false);
    expect(r.persisted).toBe(true);
  });

  it('persisted:false when the read-back disagrees (never trusts the 200)', async () => {
    const { setGrokUserSkillEnabled } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async () => ({ ok: true, name: 'browser-use', enabled: true, persisted: false }));
    const r = await setGrokUserSkillEnabled('browser-use', false, {
      deps: { manager: fakeManager(), bridge: bridge as never },
    });
    expect(r.persisted).toBe(false);
    expect(r.enabled).toBe(true);
  });

  it('bridge ok:false → structured throw', async () => {
    const { setGrokUserSkillEnabled } = await import('../../src/llm/grok-skills.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'relogin' as const, detail: 'sso dead' }));
    await expect(
      setGrokUserSkillEnabled('browser-use', true, {
        deps: { manager: fakeManager(), bridge: bridge as never },
      }),
    ).rejects.toThrow(/Grok skills toggle failed: relogin/);
  });
});
