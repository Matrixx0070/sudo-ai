/**
 * @file tests/cli/grok-providers.test.ts
 * @description GP5 — the unified provider-management view reflects each Grok
 * method's independent state (creds/default/billing) without cross-talk.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/llm/xai-oauth-manager.js', () => ({
  getXaiOAuthManager: () => ({
    status: () => ({ connected: true, expiresAt: '2026-07-20T10:00:00Z' }),
    getDefaultModel: () => 'grok-build',
    listModels: () => [{ id: 'grok-build' }],
  }),
}));
vi.mock('../../src/llm/xai-apikey-manager.js', () => ({
  getXaiApiKeyManager: () => ({
    status: () => ({ connected: false, source: null, defaultModel: null, modelsCount: 0 }),
    getDefaultModel: () => null,
  }),
}));

import { collectGrokProviders } from '../../src/cli/commands/grok.js';

describe('collectGrokProviders', () => {
  it('renders each method independently with its own billing semantics', async () => {
    const views = await collectGrokProviders();
    expect(views.map((v) => v.provider)).toEqual(['xai-oauth', 'xai']);

    const oauth = views[0]!;
    expect(oauth.connected).toBe(true);
    expect(oauth.defaultModel).toBe('grok-build');
    expect(oauth.billing).toMatch(/subscription/);
    expect(oauth.detail).toContain('2026-07-20');

    const api = views[1]!;
    expect(api.connected).toBe(false); // one being configured does not imply the other
    expect(api.defaultModel).toBeNull();
    expect(api.billing).toMatch(/pay-per-token/);
  });
});
