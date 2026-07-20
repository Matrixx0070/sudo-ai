/**
 * @file tests/cli/xai-picker-shared.test.ts
 * @description GP4 — the shared Grok picker helper: cache-vs-live selection,
 * persistence side-effect, and the visible cost label.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { XaiModelEntry } from '../../src/llm/xai-models.js';

const OAUTH_MODELS: XaiModelEntry[] = [
  { id: 'grok-build', name: 'Grok Build', contextWindow: 512000, backend: 'responses', supportsReasoningEffort: true, reasoningEfforts: ['low'], billing: 'subscription' },
];

const refreshMock = vi.fn(async () => OAUTH_MODELS);
vi.mock('../../src/llm/xai-models.js', async (orig) => {
  const actual = await orig<typeof import('../../src/llm/xai-models.js')>();
  return { ...actual, getXaiModelDiscovery: () => ({ refresh: refreshMock }) };
});

import { billingLabel, getModelsForDisplay } from '../../src/cli/commands/xai-picker-shared.js';

function fakeMgr(initial: XaiModelEntry[]) {
  let cache = [...initial];
  return {
    listModels: () => cache,
    setModels: vi.fn((m: XaiModelEntry[]) => { cache = m; }),
    getDefaultModel: () => cache[0]?.id ?? null,
    setDefaultModel: () => true,
  };
}

afterEach(() => refreshMock.mockClear());

describe('billingLabel', () => {
  it('makes the cost class human + visible', () => {
    expect(billingLabel('subscription')).toBe('subscription-covered');
    expect(billingLabel('metered')).toBe('pay-per-token');
  });
});

describe('getModelsForDisplay', () => {
  it('serves the persisted cache without a live fetch when not refreshing', async () => {
    const mgr = fakeMgr(OAUTH_MODELS);
    const { models, live } = await getModelsForDisplay('oauth', mgr, false);
    expect(live).toBe(false);
    expect(models).toHaveLength(1);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('fetches live + caches when refresh is requested', async () => {
    const mgr = fakeMgr(OAUTH_MODELS);
    const { models, live } = await getModelsForDisplay('oauth', mgr, true);
    expect(live).toBe(true);
    expect(models).toEqual(OAUTH_MODELS);
    expect(refreshMock).toHaveBeenCalledWith('oauth');
    expect(mgr.setModels).toHaveBeenCalledWith(OAUTH_MODELS);
  });

  it('fetches live when the cache is empty even without refresh', async () => {
    const mgr = fakeMgr([]);
    const { live } = await getModelsForDisplay('apikey', mgr, false);
    expect(live).toBe(true);
    expect(refreshMock).toHaveBeenCalledWith('apikey');
  });
});
