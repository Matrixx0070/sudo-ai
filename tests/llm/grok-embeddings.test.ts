/**
 * @file grok-embeddings.test.ts
 * @description Unit tests for the subscription-free Grok managed-embedding RAG
 * collections lane. NO net/browser/disk: the manager + bridge are injected.
 * Asserts the flag gate, input validation, the request shapes handed to the
 * bridge, and error surfacing. The live seat round-trip is proven
 * separately (never in CI). Mocks mirror the REAL bridge response shape.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Warm the module graph once (cold esbuild transform can exceed the default
// 5s/15s per-test timeout); the flag is read at CALL time so no resetModules.
beforeAll(async () => {
  await import('../../src/llm/grok-embeddings.js');
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

describe('listGrokEmbeddingModels', () => {
  it('sends a models op and returns the model list', async () => {
    const { listGrokEmbeddingModels } = await import('../../src/llm/grok-embeddings.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('models');
      return {
        ok: true,
        status: 200,
        models: ['grok-embedding-beta', 'grok-embedding-large', 'grok-embedding-small'],
        chunkConfigEditable: true,
      };
    });
    const models = await listGrokEmbeddingModels({ deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(models).toEqual(['grok-embedding-beta', 'grok-embedding-large', 'grok-embedding-small']);
  });

  it('flag OFF → GrokWebDisabledError (never calls the bridge)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { listGrokEmbeddingModels, GrokWebDisabledError } = await import('../../src/llm/grok-embeddings.js');
    let called = false;
    await expect(
      listGrokEmbeddingModels({
        deps: { manager: fakeManager(), bridge: (async () => { called = true; return { ok: true }; }) as never },
      }),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(called).toBe(false);
  });
});

describe('createGrokCollection', () => {
  it('sends a create op with name + model and returns the created collection', async () => {
    const { createGrokCollection } = await import('../../src/llm/grok-embeddings.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('create');
      expect((req as unknown as { name: string }).name).toBe('kb');
      expect((req as unknown as { model?: string }).model).toBe('grok-embedding-large');
      return {
        ok: true,
        status: 200,
        collectionId: 'collection_abc',
        collectionName: 'kb',
        modelName: 'grok-embedding-large',
      };
    });
    const c = await createGrokCollection('kb', { model: 'grok-embedding-large', deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(c).toEqual({ collectionId: 'collection_abc', collectionName: 'kb', modelName: 'grok-embedding-large' });
  });

  it('empty name → TypeError before touching the network', async () => {
    const { createGrokCollection } = await import('../../src/llm/grok-embeddings.js');
    let called = false;
    await expect(
      createGrokCollection('   ', { deps: { manager: fakeManager(), bridge: (async () => { called = true; return { ok: true }; }) as never } }),
    ).rejects.toThrow(/non-empty/);
    expect(called).toBe(false);
  });

  it('bridge ok:false → surfaces a structured error', async () => {
    const { createGrokCollection } = await import('../../src/llm/grok-embeddings.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'cloudflare' as const, detail: 'Just a moment' }));
    await expect(
      createGrokCollection('kb', { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/cloudflare.*Just a moment/);
  });
});

describe('addGrokDocument', () => {
  it('sends an add_doc op with base64 content and returns file metadata', async () => {
    const { addGrokDocument } = await import('../../src/llm/grok-embeddings.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('add_doc');
      const r = req as unknown as { collectionId: string; docName: string; contentBase64: string };
      expect(r.collectionId).toBe('collection_abc');
      expect(r.docName).toBe('a.txt');
      expect(r.contentBase64).toBe(Buffer.from('hello').toString('base64'));
      return { ok: true, status: 200, fileId: 'file_1', docName: 'a.txt', processingStatus: 'Processing', documentStatus: 'DOCUMENT_STATUS_PROCESSING' };
    });
    const d = await addGrokDocument('collection_abc', 'a.txt', Buffer.from('hello'), { deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(d.fileId).toBe('file_1');
    expect(d.documentStatus).toBe('DOCUMENT_STATUS_PROCESSING');
  });

  it('empty content buffer → TypeError before touching the network', async () => {
    const { addGrokDocument } = await import('../../src/llm/grok-embeddings.js');
    await expect(
      addGrokDocument('c', 'a.txt', Buffer.alloc(0), { deps: { manager: fakeManager(), bridge: (async () => ({ ok: true })) as never } }),
    ).rejects.toThrow(/non-empty Buffer/);
  });

  it('bridge ok:false → surfaces the error class + detail', async () => {
    const { addGrokDocument } = await import('../../src/llm/grok-embeddings.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'http_error' as const, detail: 'boom' }));
    await expect(
      addGrokDocument('c', 'a.txt', Buffer.from('x'), { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/http_error.*boom/);
  });
});

describe('listGrokDocuments', () => {
  it('sends a list_docs op and returns document status rows', async () => {
    const { listGrokDocuments } = await import('../../src/llm/grok-embeddings.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('list_docs');
      return {
        ok: true,
        status: 200,
        documents: [
          { fileId: 'file_1', name: 'a.txt', status: 'DOCUMENT_STATUS_PROCESSED', chunksProcessedCount: '1' },
        ],
      };
    });
    const docs = await listGrokDocuments('collection_abc', { deps: { manager: fakeManager(), bridge: bridge as never } });
    expect(docs).toHaveLength(1);
    expect(docs[0]?.status).toBe('DOCUMENT_STATUS_PROCESSED');
  });

  it('missing collectionId → TypeError', async () => {
    const { listGrokDocuments } = await import('../../src/llm/grok-embeddings.js');
    await expect(
      listGrokDocuments('', { deps: { manager: fakeManager(), bridge: (async () => ({ ok: true })) as never } }),
    ).rejects.toThrow(/collectionId/);
  });
});

describe('deleteGrokCollection', () => {
  it('sends a delete op and resolves on ok', async () => {
    const { deleteGrokCollection } = await import('../../src/llm/grok-embeddings.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      expect(req.op).toBe('delete');
      expect((req as unknown as { collectionId: string }).collectionId).toBe('collection_abc');
      return { ok: true, status: 200 };
    });
    await expect(
      deleteGrokCollection('collection_abc', { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).resolves.toBeUndefined();
  });

  it('bridge ok:false → throws', async () => {
    const { deleteGrokCollection } = await import('../../src/llm/grok-embeddings.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'relogin' as const, detail: 'sso dead' }));
    await expect(
      deleteGrokCollection('c', { deps: { manager: fakeManager(), bridge: bridge as never } }),
    ).rejects.toThrow(/relogin.*sso dead/);
  });
});
