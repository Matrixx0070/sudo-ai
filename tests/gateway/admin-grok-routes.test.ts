/**
 * @file tests/gateway/admin-grok-routes.test.ts
 * @description GP6 — the admin routes backing the web Grok dropdown. Real HTTP
 * server, mocked managers + discovery (no disk, no network).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const oauthModels = [
  { id: 'grok-build', name: 'Grok Build', contextWindow: 512000, backend: 'responses', supportsReasoningEffort: true, reasoningEfforts: [], billing: 'subscription' },
];
let oauthDefault: string | null = null;
const oauthMgr = {
  status: () => ({ connected: true }),
  listModels: () => oauthModels,
  setModels: vi.fn(),
  getDefaultModel: () => oauthDefault ?? oauthModels[0]!.id,
  setDefaultModel: vi.fn((id: string) => {
    if (!oauthModels.some((m) => m.id === id)) return false;
    oauthDefault = id;
    return true;
  }),
};
const apiMgr = {
  status: () => ({ connected: false, source: null, defaultModel: null, modelsCount: 0 }),
  listModels: () => [],
  setModels: vi.fn(),
  getDefaultModel: () => null,
  setDefaultModel: () => false,
};

vi.mock('../../src/llm/xai-oauth-manager.js', () => ({ getXaiOAuthManager: () => oauthMgr }));
vi.mock('../../src/llm/xai-apikey-manager.js', () => ({ getXaiApiKeyManager: () => apiMgr }));
vi.mock('../../src/llm/xai-models.js', async (orig) => {
  const actual = await orig<typeof import('../../src/llm/xai-models.js')>();
  return { ...actual, getXaiModelDiscovery: () => ({ refresh: async () => oauthModels }) };
});

import { registerAdminGrokRoutes } from '../../src/core/gateway/admin-grok-routes.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer();
  registerAdminGrokRoutes(server, null); // null = no auth for the test
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => { oauthDefault = null; });

describe('admin-grok-routes', () => {
  it('GET /status returns both providers with billing tags', async () => {
    const res = await fetch(`${base}/v1/admin/grok/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const provs = body.data.providers;
    expect(provs.map((p: { provider: string }) => p.provider)).toEqual(['xai-oauth', 'xai']);
    expect(provs[0].billing).toBe('subscription');
    expect(provs[1].billing).toBe('metered');
    expect(provs[0].connected).toBe(true);
    expect(provs[1].connected).toBe(false);
  });

  it('GET /models?method=oauth returns models + default', async () => {
    const res = await fetch(`${base}/v1/admin/grok/models?method=oauth`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.method).toBe('oauth');
    expect(body.data.models.map((m: { id: string }) => m.id)).toEqual(['grok-build']);
  });

  it('GET /models without method → 400', async () => {
    const res = await fetch(`${base}/v1/admin/grok/models`);
    expect(res.status).toBe(400);
  });

  it('GET /models?method=apikey (not connected) → 400', async () => {
    const res = await fetch(`${base}/v1/admin/grok/models?method=apikey`);
    expect(res.status).toBe(400);
  });

  it('PUT /default-model sets a valid oauth model', async () => {
    const res = await fetch(`${base}/v1/admin/grok/default-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'oauth', modelId: 'grok-build' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.defaultModel).toBe('grok-build');
    expect(oauthMgr.setDefaultModel).toHaveBeenCalledWith('grok-build');
  });

  it('PUT /default-model rejects an unknown model id', async () => {
    const res = await fetch(`${base}/v1/admin/grok/default-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'oauth', modelId: 'grok-nope' }),
    });
    expect(res.status).toBe(400);
  });
});
