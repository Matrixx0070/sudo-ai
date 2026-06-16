/**
 * @file prompt-cache-telemetry.test.ts
 * @description Tests for the Anthropic prompt-cache token counters that the
 * gateway /health endpoint exposes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordPromptCacheUsage,
  recordPromptCacheUsageFromProviderMetadata,
  getPromptCacheStats,
  _resetPromptCacheStatsForTest,
} from '../../src/core/shared/prompt-cache-telemetry.js';

beforeEach(() => {
  _resetPromptCacheStatsForTest();
});

describe('getPromptCacheStats — initial state', () => {
  it('returns zeros and hitRate 0 when nothing recorded', () => {
    expect(getPromptCacheStats()).toEqual({
      promptCacheCreateTokens: 0,
      promptCacheReadTokens: 0,
      promptCacheTurnsWithRead: 0,
      promptCacheTurnsTotal: 0,
      promptCacheHitRate: 0,
    });
  });
});

describe('recordPromptCacheUsage', () => {
  it('ignores both-zero calls (non-Anthropic providers do not pollute the denominator)', () => {
    recordPromptCacheUsage(0, 0);
    expect(getPromptCacheStats().promptCacheTurnsTotal).toBe(0);
  });

  it('counts a cache-write-only turn (create > 0, read = 0)', () => {
    recordPromptCacheUsage(1200, 0);
    const s = getPromptCacheStats();
    expect(s.promptCacheCreateTokens).toBe(1200);
    expect(s.promptCacheReadTokens).toBe(0);
    expect(s.promptCacheTurnsTotal).toBe(1);
    expect(s.promptCacheTurnsWithRead).toBe(0);
    expect(s.promptCacheHitRate).toBe(0);
  });

  it('counts a cache-hit turn (read > 0) toward both totals', () => {
    recordPromptCacheUsage(0, 850);
    const s = getPromptCacheStats();
    expect(s.promptCacheReadTokens).toBe(850);
    expect(s.promptCacheTurnsWithRead).toBe(1);
    expect(s.promptCacheTurnsTotal).toBe(1);
    expect(s.promptCacheHitRate).toBe(1);
  });

  it('accumulates across turns and rounds hitRate to 3 decimals', () => {
    recordPromptCacheUsage(1024, 0); // turn 1: write only
    recordPromptCacheUsage(0, 800); // turn 2: hit
    recordPromptCacheUsage(0, 800); // turn 3: hit
    const s = getPromptCacheStats();
    expect(s.promptCacheCreateTokens).toBe(1024);
    expect(s.promptCacheReadTokens).toBe(1600);
    expect(s.promptCacheTurnsTotal).toBe(3);
    expect(s.promptCacheTurnsWithRead).toBe(2);
    expect(s.promptCacheHitRate).toBe(0.667);
  });

  it('rejects NaN and negative inputs without poisoning state', () => {
    recordPromptCacheUsage(Number.NaN, -50);
    recordPromptCacheUsage(-10, 0);
    expect(getPromptCacheStats().promptCacheTurnsTotal).toBe(0);
  });
});

describe('recordPromptCacheUsageFromProviderMetadata', () => {
  it('extracts Anthropic fields from Vercel AI SDK providerMetadata shape', () => {
    recordPromptCacheUsageFromProviderMetadata({
      anthropic: { cacheCreationInputTokens: 2048, cacheReadInputTokens: 1500 },
    });
    const s = getPromptCacheStats();
    expect(s.promptCacheCreateTokens).toBe(2048);
    expect(s.promptCacheReadTokens).toBe(1500);
    expect(s.promptCacheTurnsTotal).toBe(1);
    expect(s.promptCacheTurnsWithRead).toBe(1);
  });

  it('is a no-op for undefined / null / non-object / missing-anthropic', () => {
    recordPromptCacheUsageFromProviderMetadata(undefined);
    recordPromptCacheUsageFromProviderMetadata(null);
    recordPromptCacheUsageFromProviderMetadata('string');
    recordPromptCacheUsageFromProviderMetadata({});
    recordPromptCacheUsageFromProviderMetadata({ openai: { cachedTokens: 100 } });
    expect(getPromptCacheStats().promptCacheTurnsTotal).toBe(0);
  });

  it('is a no-op when Anthropic fields are present but not numbers', () => {
    recordPromptCacheUsageFromProviderMetadata({
      anthropic: { cacheCreationInputTokens: 'oops', cacheReadInputTokens: null },
    });
    expect(getPromptCacheStats().promptCacheTurnsTotal).toBe(0);
  });
});
