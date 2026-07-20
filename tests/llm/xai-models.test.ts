/**
 * @file tests/llm/xai-models.test.ts
 * @description GP1 — unit tests for the live Grok model-discovery service.
 * All network is a mocked fetch; credentials are injected (never touch disk).
 * The OAuth 200 body is the real fixture Fable captured live 2026-07-20 (§1a);
 * the api.x.ai body is the standard OpenAI-shaped xAI models list.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  XaiModelDiscovery,
  XaiNotConnectedError,
  type XaiAuthMethod,
} from '../../src/llm/xai-models.js';

/** Real OAuth-proxy 200 body (Fable, 2026-07-20 — §1a of the GP handoff). */
const OAUTH_BODY = {
  object: 'list',
  data: [
    {
      id: 'grok-4.5',
      name: 'Grok 4.5',
      context_window: 500000,
      api_backend: 'responses',
      supports_reasoning_effort: true,
      reasoning_efforts: ['low', 'high'],
    },
  ],
};

/** Standard OpenAI-shaped api.x.ai/v1/models body (metered API key path). */
const APIKEY_BODY = {
  object: 'list',
  data: [
    { id: 'grok-4-fast', created: 1_700_000_000, object: 'model', owned_by: 'xai' },
    { id: 'grok-2-image', created: 1_690_000_000, object: 'model', owned_by: 'xai' },
  ],
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeDeps(opts: {
  body?: unknown;
  status?: number;
  cred?: string | null;
  capture?: (url: string, init: RequestInit) => void;
}) {
  const fetchImpl = vi.fn(async (url: unknown, init?: unknown) => {
    opts.capture?.(String(url), (init ?? {}) as RequestInit);
    if (opts.status && opts.status !== 200) {
      return new Response('nope', { status: opts.status });
    }
    return okResponse(opts.body);
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    getCredential: vi.fn(async (_m: XaiAuthMethod) => opts.cred ?? null),
    cliVersion: () => '0.2.22',
    now: () => 1000,
  };
}

describe('XaiModelDiscovery — oauth (subscription proxy)', () => {
  it('hits the cli-chat-proxy models URL with the grok-cli headers', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const deps = makeDeps({
      body: OAUTH_BODY,
      cred: 'tok-oauth',
      capture: (url, init) => {
        seenUrl = url;
        seenHeaders = (init.headers ?? {}) as Record<string, string>;
      },
    });
    const d = new XaiModelDiscovery(deps);
    const models = await d.refresh('oauth');

    expect(seenUrl).toBe('https://cli-chat-proxy.grok.com/v1/models');
    expect(seenHeaders['Authorization']).toBe('Bearer tok-oauth');
    expect(seenHeaders['x-grok-client-version']).toBe('0.2.22');
    expect(seenHeaders['x-grok-client-identifier']).toBe('grok-shell');
    expect(seenHeaders['User-Agent']).toBe('grok/0.2.22');
    expect(models).toEqual([
      {
        id: 'grok-4.5',
        name: 'Grok 4.5',
        contextWindow: 500000,
        backend: 'responses',
        supportsReasoningEffort: true,
        reasoningEfforts: ['low', 'high'],
        aliases: [],
        billing: 'subscription',
      },
    ]);
  });
});

describe('XaiModelDiscovery — apikey (metered api.x.ai)', () => {
  it('hits api.x.ai/v1/models with bearer only (no grok-cli headers) and marks billing metered', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const deps = makeDeps({
      body: APIKEY_BODY,
      cred: 'xai-key',
      capture: (url, init) => {
        seenUrl = url;
        seenHeaders = (init.headers ?? {}) as Record<string, string>;
      },
    });
    const d = new XaiModelDiscovery(deps);
    const models = await d.refresh('apikey');

    expect(seenUrl).toBe('https://api.x.ai/v1/models');
    expect(seenHeaders['Authorization']).toBe('Bearer xai-key');
    expect(seenHeaders['x-grok-client-version']).toBeUndefined();
    expect(models.map((m) => m.id)).toEqual(['grok-4-fast', 'grok-2-image']);
    expect(models[0]).toMatchObject({
      id: 'grok-4-fast',
      name: 'Grok 4 Fast', // no `name` in the api.x.ai shape → prettified id
      contextWindow: null,
      backend: null,
      supportsReasoningEffort: false,
      billing: 'metered',
    });
  });
});

describe('XaiModelDiscovery — credential independence + errors', () => {
  it('throws XaiNotConnectedError (not a fetch) when the store is empty', async () => {
    const deps = makeDeps({ body: OAUTH_BODY, cred: null });
    const d = new XaiModelDiscovery(deps);
    await expect(d.refresh('oauth')).rejects.toBeInstanceOf(XaiNotConnectedError);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('reads a SEPARATE credential per method (never clobbers the other)', async () => {
    const creds: Record<XaiAuthMethod, string> = { oauth: 'tok-oauth', apikey: 'xai-key' };
    const getCredential = vi.fn(async (m: XaiAuthMethod) => creds[m]);
    const d = new XaiModelDiscovery({
      fetch: vi.fn(async () => okResponse(OAUTH_BODY)) as unknown as typeof fetch,
      getCredential,
      cliVersion: () => '0.2.22',
      now: () => 1000,
    });
    await d.refresh('oauth');
    await d.refresh('apikey');
    expect(getCredential).toHaveBeenCalledWith('oauth');
    expect(getCredential).toHaveBeenCalledWith('apikey');
  });

  it('surfaces a non-2xx as a descriptive error', async () => {
    const deps = makeDeps({ status: 426, cred: 'tok-oauth' });
    const d = new XaiModelDiscovery(deps);
    await expect(d.refresh('oauth')).rejects.toThrow(/HTTP 426/);
  });
});

describe('XaiModelDiscovery — cache + refresh', () => {
  it('list() serves cache within TTL; refresh() forces a re-fetch', async () => {
    const fetchImpl = vi.fn(async () => okResponse(OAUTH_BODY));
    const d = new XaiModelDiscovery({
      fetch: fetchImpl as unknown as typeof fetch,
      getCredential: async () => 'tok-oauth',
      cliVersion: () => '0.2.22',
      now: () => 1000,
    });
    await d.list('oauth'); // fetch #1
    await d.list('oauth'); // cache hit
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await d.refresh('oauth'); // forced
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(d.cached('oauth')).toHaveLength(1);
  });

  it('drops malformed entries (no id) without throwing', async () => {
    const body = { object: 'list', data: [{ name: 'no id' }, { id: 'grok-build' }] };
    const d = new XaiModelDiscovery(makeDeps({ body, cred: 'tok-oauth' }));
    const models = await d.refresh('oauth');
    expect(models.map((m) => m.id)).toEqual(['grok-build']);
  });
});


/**
 * Fable-verified LIVE 2026-07-20 (throwaway api.x.ai key, queried /v1/models,
 * key deleted). The metered endpoint's per-model shape DIFFERS from the OAuth
 * proxy: `context_length` (not `context_window`), NO `name` (id + `aliases`),
 * and integer micro-unit token prices. This fixture pins that real shape.
 */
const APIKEY_REAL_BODY = {
  object: 'list',
  data: [
    { id: 'grok-4.20-0309-non-reasoning', created: 1731000000, object: 'model', owned_by: 'xai', aliases: [], context_length: 256000, prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 100000, prompt_image_token_price: 0 },
    { id: 'grok-4.20-0309-reasoning', created: 1731000001, object: 'model', owned_by: 'xai', aliases: [], context_length: 256000, prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 100000, prompt_image_token_price: 0 },
    { id: 'grok-4.20-multi-agent-0309', created: 1731000002, object: 'model', owned_by: 'xai', aliases: [], context_length: 256000, prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 100000, prompt_image_token_price: 0 },
    { id: 'grok-4.3', created: 1731000003, object: 'model', owned_by: 'xai', aliases: ['grok-4'], context_length: 1000000, prompt_text_token_price: 12500, cached_prompt_text_token_price: 3125, completion_text_token_price: 62500, prompt_image_token_price: 12500 },
    { id: 'grok-4.5', created: 1731000004, object: 'model', owned_by: 'xai', aliases: [], context_length: 1000000, prompt_text_token_price: 12500, cached_prompt_text_token_price: 3125, completion_text_token_price: 62500, prompt_image_token_price: 12500 },
    { id: 'grok-build-0.1', created: 1731000005, object: 'model', owned_by: 'xai', aliases: [], context_length: 512000, prompt_text_token_price: 10000, cached_prompt_text_token_price: 2500, completion_text_token_price: 50000, prompt_image_token_price: 0 },
    { id: 'grok-imagine-image', created: 1731000006, object: 'model', owned_by: 'xai', aliases: [], context_length: 0 },
    { id: 'grok-imagine-image-quality', created: 1731000007, object: 'model', owned_by: 'xai', aliases: [], context_length: 0 },
    { id: 'grok-imagine-video', created: 1731000008, object: 'model', owned_by: 'xai', aliases: [], context_length: 0 },
    { id: 'grok-imagine-video-1.5', created: 1731000009, object: 'model', owned_by: 'xai', aliases: [], context_length: 0 },
  ],
};

describe('XaiModelDiscovery — api.x.ai REAL verified shape (Fable live 2026-07-20)', () => {
  it('parses all 10 models, maps context_length→contextWindow, derives name from id, keeps aliases + pricing', async () => {
    const d = new XaiModelDiscovery(makeDeps({ body: APIKEY_REAL_BODY, cred: 'xai-key' }));
    const models = await d.refresh('apikey');

    // all 10 ids parse
    expect(models).toHaveLength(10);
    expect(models.map((m) => m.id)).toContain('grok-4.20-multi-agent-0309');

    // context_length maps to contextWindow (the DIFFERENT field name)
    const g45 = models.find((m) => m.id === 'grok-4.5')!;
    expect(g45.contextWindow).toBe(1000000);
    expect(g45.name).toBe('Grok 4.5'); // no `name` field → prettified id
    expect(g45.billing).toBe('metered');
    expect(g45.pricing).toEqual({
      promptTextTokenPrice: 12500,
      cachedPromptTextTokenPrice: 3125,
      completionTextTokenPrice: 62500,
      promptImageTokenPrice: 12500,
    });

    // aliases carried through when present
    const g43 = models.find((m) => m.id === 'grok-4.3')!;
    expect(g43.aliases).toEqual(['grok-4']);

    // image/video models with context_length 0 still parse (contextWindow 0, no pricing)
    const img = models.find((m) => m.id === 'grok-imagine-image')!;
    expect(img.contextWindow).toBe(0);
    expect(img.pricing).toBeUndefined();
  });
});
