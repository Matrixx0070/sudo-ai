/**
 * Unified grok connector: budget-guarded delegation to the web services and a
 * shared health snapshot. grok-web-media is mocked — this tests the facade,
 * not the lanes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/llm/grok-web-media.js', () => ({
  grokWebComplete: vi.fn(async () => [{ type: 'text', text: 'ok' }]),
  generateGrokImage: vi.fn(async () => ({ url: 'u', files: [], jobIds: [] })),
  generateGrokVideo: vi.fn(async () => ({ videoUrl: 'v', imageUrl: null })),
  synthesizeGrokVoice: vi.fn(async () => ({ audioBase64: 'AAA', audioFormat: 'wav' })),
  transcribeGrokVoice: vi.fn(async () => ({ text: 'heard' })),
}));

vi.mock('../../src/llm/grok-rag.js', () => ({
  grokRagQuery: vi.fn(async () => ({ answer: 'grounded answer', fileIds: ['f1'] })),
}));

vi.mock('../../src/llm/grok-embeddings.js', () => ({
  listGrokEmbeddingModels: vi.fn(async () => ['grok-embedding-small']),
  createGrokCollection: vi.fn(async () => ({ collectionId: 'c1', collectionName: 'kb' })),
  addGrokDocument: vi.fn(async () => ({ fileId: 'd1', processingStatus: 'PENDING' })),
  listGrokCollections: vi.fn(async () => [{ collectionId: 'c1', collectionName: 'kb' }]),
  listGrokDocuments: vi.fn(async () => [{ fileId: 'd1', name: 'doc-1' }]),
  getGrokCollectionMetadata: vi.fn(async () => ({ collectionId: 'c1', documentsCount: 1 })),
  deleteGrokCollection: vi.fn(async () => undefined),
  searchGrokCollection: vi.fn(async () => ({ answer: 'from the collection' })),
}));

import { grokWebComplete } from '../../src/llm/grok-web-media.js';
import { GrokConnector } from '../../src/llm/grok-connector.js';
import { GrokBudget, GrokBudgetExhaustedError } from '../../src/llm/grok-budget.js';

const fakePool = { size: () => 4, prime: async () => {} } as never;

beforeEach(() => vi.mocked(grokWebComplete).mockClear());

describe('GrokConnector', () => {
  it('budget-guards and delegates complete() to grokWebComplete', async () => {
    const conn = new GrokConnector({ budget: new GrokBudget({ perRun: 10 }), pool: fakePool });
    const blocks = await conn.complete([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], []);
    expect(blocks).toEqual([{ type: 'text', text: 'ok' }]);
    expect(grokWebComplete).toHaveBeenCalledOnce();
    expect(conn.health().budget.runUsed).toBe(1);
  });

  it('halts with GrokBudgetExhaustedError when the budget is spent (no call made)', async () => {
    const conn = new GrokConnector({ budget: new GrokBudget({ perRun: 1 }), pool: fakePool });
    await conn.complete([{ role: 'user', content: [{ type: 'text', text: '1' }] }], []);
    await expect(
      conn.complete([{ role: 'user', content: [{ type: 'text', text: '2' }] }], []),
    ).rejects.toBeInstanceOf(GrokBudgetExhaustedError);
    // the blocked call did NOT reach the lane
    expect(grokWebComplete).toHaveBeenCalledOnce();
  });

  it('health() reports pool size and budget status', () => {
    const conn = new GrokConnector({ budget: new GrokBudget({ perRun: 9, perDay: 99 }), pool: fakePool });
    const h = conn.health();
    expect(h.poolSize).toBe(4);
    expect(h.budget).toMatchObject({ runUsed: 0, runLimit: 9, dayLimit: 99 });
  });
});

describe('GrokConnector voice lane', () => {
  it('voice.tts + voice.stt are budget-guarded and delegate', async () => {
    const conn = new GrokConnector({ budget: new GrokBudget({ perRun: 10 }), pool: fakePool });
    const tts = await conn.voice.tts('hello', { voice: 'altair' });
    expect(tts).toEqual({ audioBase64: 'AAA', audioFormat: 'wav' });
    const stt = await conn.voice.stt('BASE64AUDIO');
    expect(stt).toEqual({ text: 'heard' });
    expect(conn.health().budget.runUsed).toBe(2); // both counted against the budget
  });

  it('voice halts when the budget is spent', async () => {
    const conn = new GrokConnector({ budget: new GrokBudget({ perRun: 0 }), pool: fakePool });
    await expect(conn.voice.tts('x')).rejects.toBeInstanceOf(GrokBudgetExhaustedError);
  });
});

describe('GrokConnector rag lane', () => {
  it('rag() is budget-guarded and delegates to grokRagQuery', async () => {
    const conn = new GrokConnector({ budget: new GrokBudget({ perRun: 10 }), pool: fakePool });
    const r = await conn.rag({ question: 'what?', texts: ['some doc'] });
    expect(r).toMatchObject({ answer: 'grounded answer' });
    expect(conn.health().budget.runUsed).toBe(1);
  });
  it('rag halts when the budget is spent', async () => {
    const conn = new GrokConnector({ budget: new GrokBudget({ perRun: 0 }), pool: fakePool });
    await expect(conn.rag({ question: 'q' })).rejects.toBeInstanceOf(GrokBudgetExhaustedError);
  });
});

describe('GrokConnector collections lane', () => {
  it('create + add are budget-guarded; reads are direct', async () => {
    const conn = new GrokConnector({ budget: new GrokBudget({ perRun: 10 }), pool: fakePool });
    const col = await conn.collections.create('kb');
    expect(col).toMatchObject({ collectionId: 'c1' });
    await conn.collections.add('c1', 'doc-1', 'hello world');
    expect(conn.health().budget.runUsed).toBe(2); // create + add counted
    const models = await conn.collections.models();
    expect(models).toContain('grok-embedding-small');
    const cols = await conn.collections.list();
    expect(cols[0]).toMatchObject({ collectionId: 'c1' });
    expect(conn.health().budget.runUsed).toBe(2); // reads NOT counted
  });
  it('collections.add halts when the budget is spent', async () => {
    const conn = new GrokConnector({ budget: new GrokBudget({ perRun: 0 }), pool: fakePool });
    await expect(conn.collections.add('c1', 'd', 'x')).rejects.toBeInstanceOf(GrokBudgetExhaustedError);
  });
});

describe('GrokConnector collections.search', () => {
  it('search is budget-guarded and returns a grounded answer', async () => {
    const conn = new GrokConnector({ budget: new GrokBudget({ perRun: 10 }), pool: fakePool });
    const r = await conn.collections.search('c1', 'what is in the kb?');
    expect(r).toMatchObject({ answer: 'from the collection' });
    expect(conn.health().budget.runUsed).toBe(1);
  });
});
