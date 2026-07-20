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
      name: 'grok-4-fast', // no display name in the api.x.ai shape → id fallback
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
