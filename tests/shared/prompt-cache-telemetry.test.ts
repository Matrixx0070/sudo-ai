/**
 * @file prompt-cache-telemetry.test.ts
 * @description Tests for the Anthropic prompt-cache token counters that the
 * gateway /health endpoint exposes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordPromptCacheUsage,
  recordPromptCacheUsageFromProviderMetadata,
  extractPromptCacheTokens,
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

  // Regression: ai@6 / @ai-sdk/anthropic@3 surface the READ count ONLY at the
  // nested snake_case `anthropic.usage.cache_read_input_tokens`. There is no
  // top-level `cacheReadInputTokens`, so the old camelCase-only extractor
  // recorded every cache HIT as (0,0) and bailed — /health showed readTokens=0
  // and turnsTotal=1 across thousands of cache-amortised consciousness ticks.
  // This is the verbatim providerMetadata shape captured live from the daemon.
  it('records cache READS from the nested anthropic.usage shape (the live SDK shape)', () => {
    recordPromptCacheUsageFromProviderMetadata({
      anthropic: {
        usage: {
          input_tokens: 1279,
          output_tokens: 115,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 25749,
        },
        cacheCreationInputTokens: 0, // top-level camelCase present, read field absent
        stopSequence: null,
      },
    });
    const s = getPromptCacheStats();
    expect(s.promptCacheReadTokens).toBe(25749);
    expect(s.promptCacheTurnsWithRead).toBe(1);
    expect(s.promptCacheTurnsTotal).toBe(1);
    expect(s.promptCacheHitRate).toBe(1);
  });

  it('records the cold-start MINT from the nested usage shape', () => {
    recordPromptCacheUsageFromProviderMetadata({
      anthropic: {
        usage: { cache_creation_input_tokens: 25749, cache_read_input_tokens: 0 },
        cacheCreationInputTokens: 25749,
      },
    });
    const s = getPromptCacheStats();
    expect(s.promptCacheCreateTokens).toBe(25749);
    expect(s.promptCacheReadTokens).toBe(0);
    expect(s.promptCacheTurnsWithRead).toBe(0);
  });
});

describe('extractPromptCacheTokens', () => {
  it('prefers nested usage and falls back to top-level camelCase', () => {
    expect(extractPromptCacheTokens({
      anthropic: { usage: { cache_read_input_tokens: 25749, cache_creation_input_tokens: 0 } },
    })).toEqual({ create: 0, read: 25749 });

    // Fallback path: only the top-level camelCase creation field present.
    expect(extractPromptCacheTokens({
      anthropic: { cacheCreationInputTokens: 2048 },
    })).toEqual({ create: 2048, read: 0 });
  });

  it('returns zeros for non-Anthropic / malformed metadata', () => {
    expect(extractPromptCacheTokens(undefined)).toEqual({ create: 0, read: 0 });
    expect(extractPromptCacheTokens({ openai: { cachedTokens: 100 } })).toEqual({ create: 0, read: 0 });
  });
});
