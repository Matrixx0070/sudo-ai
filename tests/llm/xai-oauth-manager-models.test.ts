/**
 * @file tests/llm/xai-oauth-manager-models.test.ts
 * @description GP3/GP4 — the oauth cred store's model cache + default, and the
 * invariant that a TOKEN REFRESH preserves the picker state (never wipes it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XaiOAuthManager, type XaiOAuthStore } from '../../src/llm/xai-oauth-manager.js';
import type { XaiModelEntry } from '../../src/llm/xai-models.js';

const MODELS: XaiModelEntry[] = [
  { id: 'grok-build', name: 'Grok Build', contextWindow: 512000, backend: 'responses', supportsReasoningEffort: true, reasoningEfforts: ['low', 'high'], aliases: [], billing: 'subscription' },
  { id: 'grok-composer-2.5-fast', name: 'Composer', contextWindow: 200000, backend: 'responses', supportsReasoningEffort: false, reasoningEfforts: [], aliases: [], billing: 'subscription' },
];

let dir: string;
let storePath: string;

function seed(store: Partial<XaiOAuthStore>): void {
  writeFileSync(storePath, JSON.stringify(store), { mode: 0o600 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xai-oauth-'));
  storePath = join(dir, 'xai-oauth.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('XaiOAuthManager — model cache + default', () => {
  it('caches models and resolves + persists the default', () => {
    seed({ access_token: 'a', refresh_token: 'r', expires_at: new Date(Date.now() + 3.6e6 * 10).toISOString() });
    const m = new XaiOAuthManager(storePath);
    m.setModels(MODELS);
    expect(m.getDefaultModel()).toBe('grok-build'); // first cached
    expect(m.setDefaultModel('grok-composer-2.5-fast')).toBe(true);
    expect(m.getDefaultModel()).toBe('grok-composer-2.5-fast');
    // credentials survive the picker writes
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(raw.access_token).toBe('a');
    expect(raw.refresh_token).toBe('r');
    expect(raw.defaultModel).toBe('grok-composer-2.5-fast');
  });

  it('rejects a default id not in the cached list', () => {
    seed({ access_token: 'a', refresh_token: 'r' });
    const m = new XaiOAuthManager(storePath);
    m.setModels(MODELS);
    expect(m.setDefaultModel('grok-nope')).toBe(false);
  });
});

describe('XaiOAuthManager — refresh preserves picker state', () => {
  it('a token refresh keeps defaultModel + models', async () => {
    // Expired token so getAccessToken() forces a refresh.
    seed({
      access_token: 'old',
      refresh_token: 'rt-old',
      expires_at: new Date(Date.now() - 1000).toISOString(),
      obtained_at: new Date(Date.now() - 7.2e6).toISOString(),
      defaultModel: 'grok-build',
      models: MODELS,
      modelsFetchedAt: 111,
    });

    const fetchImpl = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('.well-known')) {
        return new Response(JSON.stringify({
          device_authorization_endpoint: 'https://auth.x.ai/device',
          token_endpoint: 'https://auth.x.ai/token',
        }), { status: 200 });
      }
      // token refresh
      return new Response(JSON.stringify({ access_token: 'NEW', refresh_token: 'rt-new', expires_in: 21600 }), { status: 200 });
    });

    const m = new XaiOAuthManager(storePath, {
      fetch: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      now: () => Date.now(),
    });

    const tok = await m.getAccessToken();
    expect(tok).toBe('NEW');
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(raw.access_token).toBe('NEW');
    expect(raw.refresh_token).toBe('rt-new'); // rotated
    expect(raw.defaultModel).toBe('grok-build');   // preserved
    expect(raw.models).toHaveLength(2);            // preserved
  });
});
