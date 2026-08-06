/**
 * @file tests/llm/model-catalog.test.ts
 * @description ADR 0010 D2. Pins the behaviour that six disagreeing tables
 * could not give us: one answer per model, and — the expensive one — a seat
 * lane costing $0 in real money while still reporting a notional figure.
 *
 * Each drift case below is a bug that was live before this catalog existed.
 */

import { describe, it, expect } from 'vitest';
import {
  lookupModel, contextLimitsFor, rateFor, meteredCostUsd, notionalCostUsd,
  isSeatLane, billingClassOf, canonicalModelId, catalogConflicts,
  registerCatalogRows, CATALOG_DEFAULTS, type CatalogRow,
} from '../../src/llm/model-catalog.js';

const M = 1_000_000;

describe('the catalog has no internal conflicts', () => {
  it('built-in rows declare each model exactly once', () => {
    expect(catalogConflicts()).toEqual([]);
  });
});

describe('seat vs metered — the distinction that caused two outages', () => {
  it('a seat lane costs $0 REAL money regardless of the model behind it', () => {
    const tokens = { inputTokens: 1 * M, outputTokens: 100_000 };
    // Same underlying model, two lanes.
    expect(meteredCostUsd('claude-oauth/claude-opus-5', tokens)).toBe(0);
    expect(meteredCostUsd('anthropic/claude-opus-5', tokens)).toBeGreaterThan(0);
  });

  it('but still reports a NOTIONAL figure for the same seat call', () => {
    const tokens = { inputTokens: 1 * M, outputTokens: 100_000 };
    const notional = notionalCostUsd('claude-oauth/claude-opus-5', tokens);
    expect(notional).toBeCloseTo(5.0 + 2.5, 6); // $5/M in + $25/M on 100k out
    // The pair that must never be confused: $0 to spend, ~$7.50 to report.
    expect(meteredCostUsd('claude-oauth/claude-opus-5', tokens)).toBe(0);
  });

  it('classifies every seat prefix, including transport routes', () => {
    for (const lane of ['claude-oauth/x', 'claude-oauth:messages', 'ollama/glm-5.2:cloud', 'ollama:chat']) {
      expect(isSeatLane(lane), lane).toBe(true);
      expect(billingClassOf(lane)).toBe('seat');
    }
    for (const lane of ['anthropic/claude-opus-5', 'google/gemini-2.5-flash', 'xai-oauth/grok-4.5']) {
      expect(isSeatLane(lane), lane).toBe(false);
      expect(billingClassOf(lane)).toBe('metered');
    }
  });

  it('xai-oauth is METERED despite the oauth prefix (proven live; $161.27/30d)', () => {
    expect(isSeatLane('xai-oauth/grok-4.5')).toBe(false);
    expect(meteredCostUsd('xai-oauth/grok-4.5', { inputTokens: 1 * M, outputTokens: 0 })).toBeCloseTo(3.0, 6);
  });
});

describe('drift the six tables produced — each was a live bug', () => {
  it('ollama is not priced at the $5/$20 default (the ~$473 phantom-spend pattern)', () => {
    // It had no COST_RATES row at all, so it fell to DEFAULT_COST_RATE.
    const t = { inputTokens: 1 * M, outputTokens: 1 * M };
    expect(notionalCostUsd('ollama/glm-5.2:cloud', t)).toBe(0);
    expect(meteredCostUsd('ollama/glm-5.2:cloud', t)).toBe(0);
  });

  it('the judge resolves to $1/$5 under BOTH spellings (was 5x on the dated id)', () => {
    const dated = 'claude-oauth/claude-haiku-4-5-20251001'; // what aliases.ts routes
    const bare = 'anthropic/claude-haiku-4-5';
    expect(rateFor(dated).inUsdPerM).toBe(1.0);
    expect(rateFor(dated).outUsdPerM).toBe(5.0);
    expect(rateFor(bare).inUsdPerM).toBe(1.0);
    expect(lookupModel(dated)!.id).toBe(bare); // one row, two spellings
  });

  it('opus-4-5 costs $15/$75, not the $3/$15 default it fell to', () => {
    expect(rateFor('anthropic/claude-opus-4-5').inUsdPerM).toBe(15.0);
    expect(rateFor('anthropic/claude-opus-4-5').outUsdPerM).toBe(75.0);
  });

  it('models that existed in only one table now have BOTH price and limits', () => {
    for (const id of ['openai/o3', 'google/gemini-1.5-pro', 'xai/grok-4.20-0309-reasoning']) {
      const r = lookupModel(id);
      expect(r, id).not.toBeNull();
      expect(r!.contextWindow, id).toBeGreaterThan(CATALOG_DEFAULTS.contextWindow);
    }
  });

  it('gemini-1.5-pro keeps its 2M window instead of the 128K default', () => {
    expect(contextLimitsFor('google/gemini-1.5-pro').context_window).toBe(2 * M);
  });

  it('an unknown model gets ONE shared default, not three that disagree', () => {
    expect(contextLimitsFor('who/knows')).toEqual({
      context_window: CATALOG_DEFAULTS.contextWindow,
      max_output: CATALOG_DEFAULTS.maxOutput,
    });
    expect(rateFor('who/knows')).toEqual(CATALOG_DEFAULTS.price);
  });
});

describe('cache-aware pricing (was a global hardcoded multiplier)', () => {
  it('charges cache reads at 0.1x and writes at 1.25x of input', () => {
    const cost = notionalCostUsd('anthropic/claude-opus-5', {
      inputTokens: 1 * M,          // SDK total, INCLUDES the cached counts
      outputTokens: 0,
      cacheReadTokens: 900_000,
      cacheCreationTokens: 100_000,
    });
    // fresh 0 + read 0.9M*5*0.1 + write 0.1M*5*1.25 = 0.45 + 0.625
    expect(cost).toBeCloseTo(1.075, 6);
  });

  it('a fully-cached call is far cheaper than the same tokens uncached', () => {
    const t = { inputTokens: 1 * M, outputTokens: 0 };
    const uncached = notionalCostUsd('anthropic/claude-opus-5', t);
    const cached = notionalCostUsd('anthropic/claude-opus-5', { ...t, cacheReadTokens: 1 * M });
    expect(cached).toBeLessThan(uncached / 5);
  });

  it('models without declared cache ratios bill cached tokens at the input rate', () => {
    const t = { inputTokens: 1 * M, outputTokens: 0, cacheReadTokens: 1 * M };
    expect(notionalCostUsd('openai/gpt-4o', t)).toBeCloseTo(2.5, 6);
  });
});

describe('tiered pricing (previously inexpressible — silently flat-rated)', () => {
  it('uses the base rate below the tier threshold', () => {
    expect(rateFor('google/gemini-1.5-pro', 100_000).inUsdPerM).toBe(3.5);
  });
  it('switches to the higher rate above it', () => {
    expect(rateFor('google/gemini-1.5-pro', 500_000).inUsdPerM).toBe(7.0);
    expect(rateFor('google/gemini-1.5-pro', 500_000).outUsdPerM).toBe(21.0);
  });
  it('a long-context call costs strictly more than a short one per token', () => {
    const short = notionalCostUsd('google/gemini-1.5-pro', { inputTokens: 100_000, outputTokens: 0 });
    const long = notionalCostUsd('google/gemini-1.5-pro', { inputTokens: 200_000, outputTokens: 0 });
    expect(long / 200_000).toBeGreaterThan(short / 100_000);
  });
});

describe('authority precedence', () => {
  it('a config row overrides the built-in one', () => {
    const override: CatalogRow = {
      id: 'openai/gpt-4o', source: 'config',
      contextWindow: 999_999, maxOutput: 1, price: { inUsdPerM: 42, outUsdPerM: 43 },
    };
    registerCatalogRows([override]);
    expect(rateFor('openai/gpt-4o').inUsdPerM).toBe(42);
    expect(contextLimitsFor('openai/gpt-4o').context_window).toBe(999_999);
    registerCatalogRows([]); // restore built-ins for other tests
    expect(rateFor('openai/gpt-4o').inUsdPerM).toBe(2.5);
  });

  it('runtime discovery does NOT override an explicit built-in', () => {
    registerCatalogRows([{
      id: 'openai/gpt-4o', source: 'runtime',
      contextWindow: 1, maxOutput: 1, price: { inUsdPerM: 999, outUsdPerM: 999 },
    }]);
    expect(rateFor('openai/gpt-4o').inUsdPerM).toBe(2.5); // builtin (1) beats runtime (2)
    registerCatalogRows([]);
  });
});

describe('canonicalModelId', () => {
  it('maps a seat lane onto the underlying vendor model', () => {
    expect(canonicalModelId('claude-oauth/claude-opus-5')).toBe('anthropic/claude-opus-5');
  });
  it('leaves other ids untouched', () => {
    expect(canonicalModelId('xai/grok-3')).toBe('xai/grok-3');
  });
});
