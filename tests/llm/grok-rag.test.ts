/**
 * @file grok-rag.test.ts
 * @description Unit tests for the subscription-free Grok document-grounded RAG
 * lane (app-chat file-attach). NO net/browser/disk: manager, bridge and mint
 * are injected. Asserts the flag gate, input validation, the request shape
 * handed to the bridge (docs + minted statsig), mint-failure surfacing and
 * bridge ok:false surfacing. Mocks mirror the REAL bridge response shape. The
 * live seat round-trip (positive + negative control) is proven separately.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

beforeAll(async () => {
  await import('../../src/llm/grok-rag.js');
}, 60_000);

beforeEach(() => {
  process.env['SUDO_GROK_WEBSESSION'] = '1';
});
afterEach(() => {
  delete process.env['SUDO_GROK_WEBSESSION'];
});

const SESSION = { cookie: 'cf_clearance=X; sso=Y', userAgent: 'UA' };
function fakeManager(session = SESSION) {
  return {
    ensureHealthy: async () => session,
  } as unknown as import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}

type BridgeReq = { op: string; question: string; docs: Array<{ fileName: string; contentB64: string }>; modelName?: string };
type BridgeCreds = { cookie: string; userAgent: string; statsigId?: string };

describe('grokRagQuery', () => {
  it('happy path: uploads text doc + minted statsig, returns grounded answer', async () => {
    const { grokRagQuery } = await import('../../src/llm/grok-rag.js');
    const bridge = vi.fn(async (req: BridgeReq, creds: BridgeCreds) => {
      expect(req.op).toBe('rag');
      expect(req.question).toBe('Who ratified it?');
      expect(req.docs).toHaveLength(1);
      expect(Buffer.from(req.docs[0]!.contentB64, 'base64').toString('utf8')).toContain('Zorblax');
      expect(creds.cookie).toBe(SESSION.cookie);
      expect(creds.statsigId).toBe('STATSIG-TOKEN');
      return { ok: true, status: 200, answer: 'Marnix Vollenhoven ratified it.', conversationId: 'c1', fileIds: ['f1'], attachmentsPreprocessed: true };
    });
    const mint = vi.fn(async (p: string, m: string) => {
      expect(p).toBe('/rest/app-chat/conversations/new');
      expect(m).toBe('POST');
      return 'STATSIG-TOKEN';
    });
    const result = await grokRagQuery(
      { question: 'Who ratified it?', texts: ['The Zorblax Protocol was ratified by Marnix.'] },
      { deps: { manager: fakeManager(), bridge: bridge as never, mint } },
    );
    expect(result.answer).toBe('Marnix Vollenhoven ratified it.');
    expect(result.conversationId).toBe('c1');
    expect(mint).toHaveBeenCalledOnce();
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('flag OFF → GrokWebDisabledError (never mints, never calls the bridge)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { grokRagQuery, GrokWebDisabledError } = await import('../../src/llm/grok-rag.js');
    let bridgeCalled = false;
    let mintCalled = false;
    await expect(
      grokRagQuery(
        { question: 'q', texts: ['doc'] },
        {
          deps: {
            manager: fakeManager(),
            bridge: (async () => { bridgeCalled = true; return { ok: true, answer: 'x' }; }) as never,
            mint: async () => { mintCalled = true; return 't'; },
          },
        },
      ),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(bridgeCalled).toBe(false);
    expect(mintCalled).toBe(false);
  });

  it('empty question → TypeError', async () => {
    const { grokRagQuery } = await import('../../src/llm/grok-rag.js');
    await expect(
      grokRagQuery({ question: '  ', texts: ['doc'] }, { deps: { manager: fakeManager(), bridge: (async () => ({ ok: true, answer: 'x' })) as never, mint: async () => 't' } }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('no documents → TypeError (never mints)', async () => {
    const { grokRagQuery } = await import('../../src/llm/grok-rag.js');
    let mintCalled = false;
    await expect(
      grokRagQuery({ question: 'q' }, { deps: { manager: fakeManager(), bridge: (async () => ({ ok: true, answer: 'x' })) as never, mint: async () => { mintCalled = true; return 't'; } } }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mintCalled).toBe(false);
  });

  it('mint failure → GrokRagError (statsig), bridge never called', async () => {
    const { grokRagQuery, GrokRagError } = await import('../../src/llm/grok-rag.js');
    let bridgeCalled = false;
    await expect(
      grokRagQuery(
        { question: 'q', texts: ['doc'] },
        {
          deps: {
            manager: fakeManager(),
            bridge: (async () => { bridgeCalled = true; return { ok: true, answer: 'x' }; }) as never,
            mint: async () => { throw new Error('minter returned no token'); },
          },
        },
      ),
    ).rejects.toBeInstanceOf(GrokRagError);
    expect(bridgeCalled).toBe(false);
  });

  it('bridge ok:false → GrokRagError carrying the errorClass', async () => {
    const { grokRagQuery, GrokRagError } = await import('../../src/llm/grok-rag.js');
    const bridge = vi.fn(async () => ({ ok: false, status: 403, errorClass: 'statsig', detail: 'anti-bot' }));
    await expect(
      grokRagQuery(
        { question: 'q', texts: ['doc'] },
        { deps: { manager: fakeManager(), bridge: bridge as never, mint: async () => 't' } },
      ),
    ).rejects.toMatchObject({ name: 'GrokRagError', errorClass: 'statsig' });
    await expect(
      grokRagQuery(
        { question: 'q', texts: ['doc'] },
        { deps: { manager: fakeManager(), bridge: bridge as never, mint: async () => 't' } },
      ),
    ).rejects.toBeInstanceOf(GrokRagError);
  });
});
