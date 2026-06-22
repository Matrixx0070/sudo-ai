/**
 * prompt-cache-telemetry — in-process Anthropic prompt-cache counters.
 *
 * Covers the recording guard (non-positive / non-finite values ignored,
 * denominator not polluted), hit-rate rounding, and the defensive
 * providerMetadata extractor — including the nested snake_case `usage.*`
 * fields vs the top-level camelCase fallback (the bug the extractor exists
 * to avoid: reading only camelCase silently loses every cache READ).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordPromptCacheUsage,
  getPromptCacheStats,
  extractPromptCacheTokens,
  recordPromptCacheUsageFromProviderMetadata,
  _resetPromptCacheStatsForTest,
} from '../../../src/core/shared/prompt-cache-telemetry.js';

beforeEach(() => {
  _resetPromptCacheStatsForTest();
});

describe('recordPromptCacheUsage / getPromptCacheStats', () => {
  it('starts at zero with a 0 hit rate', () => {
    expect(getPromptCacheStats()).toEqual({
      promptCacheCreateTokens: 0,
      promptCacheReadTokens: 0,
      promptCacheTurnsWithRead: 0,
      promptCacheTurnsTotal: 0,
      promptCacheHitRate: 0,
    });
  });

  it('accumulates create and read tokens across calls', () => {
    recordPromptCacheUsage(100, 0); // create-only turn
    recordPromptCacheUsage(50, 200); // turn with a read
    const s = getPromptCacheStats();
    expect(s.promptCacheCreateTokens).toBe(150);
    expect(s.promptCacheReadTokens).toBe(200);
    expect(s.promptCacheTurnsTotal).toBe(2);
    expect(s.promptCacheTurnsWithRead).toBe(1);
  });

  it('ignores turns where both values are non-positive (no denominator pollution)', () => {
    recordPromptCacheUsage(0, 0);
    recordPromptCacheUsage(-5, -1);
    recordPromptCacheUsage(NaN, Infinity);
    expect(getPromptCacheStats().promptCacheTurnsTotal).toBe(0);
  });

  it('clamps a single negative/non-finite field but still counts the turn', () => {
    recordPromptCacheUsage(-10, 200); // negative create dropped, read counts
    const s = getPromptCacheStats();
    expect(s.promptCacheCreateTokens).toBe(0);
    expect(s.promptCacheReadTokens).toBe(200);
    expect(s.promptCacheTurnsTotal).toBe(1);
    expect(s.promptCacheTurnsWithRead).toBe(1);
  });

  it('rounds the hit rate to 3 decimals', () => {
    // 1 read out of 3 turns = 0.3333... -> 0.333
    recordPromptCacheUsage(10, 5);
    recordPromptCacheUsage(10, 0);
    recordPromptCacheUsage(10, 0);
    expect(getPromptCacheStats().promptCacheHitRate).toBe(0.333);
  });
});

describe('extractPromptCacheTokens', () => {
  it('returns zeros for null / non-object / non-anthropic shapes', () => {
    expect(extractPromptCacheTokens(undefined)).toEqual({ create: 0, read: 0 });
    expect(extractPromptCacheTokens(null)).toEqual({ create: 0, read: 0 });
    expect(extractPromptCacheTokens(42)).toEqual({ create: 0, read: 0 });
    expect(extractPromptCacheTokens({ openai: {} })).toEqual({ create: 0, read: 0 });
  });

  it('reads the nested snake_case usage fields (authoritative shape)', () => {
    const meta = {
      anthropic: {
        usage: { cache_creation_input_tokens: 123, cache_read_input_tokens: 456 },
      },
    };
    expect(extractPromptCacheTokens(meta)).toEqual({ create: 123, read: 456 });
  });

  it('falls back to top-level camelCase create when usage is absent', () => {
    const meta = { anthropic: { cacheCreationInputTokens: 77 } };
    expect(extractPromptCacheTokens(meta)).toEqual({ create: 77, read: 0 });
  });

  it('prefers nested usage over top-level camelCase when both present', () => {
    const meta = {
      anthropic: {
        usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
        cacheCreationInputTokens: 999,
      },
    };
    expect(extractPromptCacheTokens(meta)).toEqual({ create: 10, read: 20 });
  });

  it('treats non-numeric token fields as zero', () => {
    const meta = {
      anthropic: { usage: { cache_creation_input_tokens: '5', cache_read_input_tokens: null } },
    };
    expect(extractPromptCacheTokens(meta)).toEqual({ create: 0, read: 0 });
  });
});

describe('recordPromptCacheUsageFromProviderMetadata', () => {
  it('records straight from a providerMetadata shape', () => {
    recordPromptCacheUsageFromProviderMetadata({
      anthropic: { usage: { cache_creation_input_tokens: 30, cache_read_input_tokens: 70 } },
    });
    const s = getPromptCacheStats();
    expect(s.promptCacheCreateTokens).toBe(30);
    expect(s.promptCacheReadTokens).toBe(70);
    expect(s.promptCacheTurnsTotal).toBe(1);
    expect(s.promptCacheTurnsWithRead).toBe(1);
  });

  it('no-ops cleanly on malformed / non-anthropic metadata', () => {
    recordPromptCacheUsageFromProviderMetadata(undefined);
    recordPromptCacheUsageFromProviderMetadata({ openai: { foo: 1 } });
    expect(getPromptCacheStats().promptCacheTurnsTotal).toBe(0);
  });
});
