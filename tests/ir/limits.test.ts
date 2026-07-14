/**
 * @file tests/ir/limits.test.ts
 * @description Tests for alias/model context budgets and the rough token
 * estimator (gw-refactor Phase 2, part A).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getAliasLimits,
  refreshAliasLimitsFromGateway,
  clearGatewayLimitOverrides,
  estimateTokens,
  DEFAULT_LIMITS,
} from '../../src/llm/limits.js';
import type { IRRequest, IRMessage } from '../../shared-types/ir/v1.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  clearGatewayLimitOverrides();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

function baseRequest(messages: IRMessage[]): IRRequest {
  return {
    alias: 'sudo/mid',
    caller: 'test',
    purpose: 'estimator',
    messages,
    priority: 'background',
    trace_id: 't-1',
  };
}

describe('getAliasLimits', () => {
  it('returns table values for a known alias (sudo/frontier → opus 200K/32000)', () => {
    expect(getAliasLimits('sudo/frontier')).toEqual({
      context_window: 200_000,
      max_output: 32_000,
    });
  });

  it('returns 2M context for the grok-4-fast family (sudo/cheap, sudo/mid, concrete id)', () => {
    expect(getAliasLimits('sudo/cheap').context_window).toBe(2_000_000);
    expect(getAliasLimits('sudo/mid').context_window).toBe(2_000_000);
    expect(getAliasLimits('xai/grok-4-fast-reasoning').context_window).toBe(2_000_000);
  });

  it('matches bare model ids without provider prefix', () => {
    expect(getAliasLimits('grok-4-fast-non-reasoning').context_window).toBe(2_000_000);
    expect(getAliasLimits('claude-opus-4-8')).toEqual({
      context_window: 200_000,
      max_output: 32_000,
    });
  });

  it('falls back to DEFAULT_LIMITS for unknown models', () => {
    expect(getAliasLimits('acme/unknown-model-9000')).toEqual(DEFAULT_LIMITS);
    expect(getAliasLimits('')).toEqual(DEFAULT_LIMITS);
  });

  it('gateway override wins after refresh', async () => {
    process.env['LLM_BASE_URL'] = 'http://gw.local';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'xai/grok-4-fast-reasoning', context_window: 1_000_000, max_output_tokens: 65_536 },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const updated = await refreshAliasLimitsFromGateway();
    expect(updated).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith('http://gw.local/v1/models', expect.anything());
    // sudo/mid resolves to xai/grok-4-fast-reasoning → override applies.
    expect(getAliasLimits('sudo/mid')).toEqual({
      context_window: 1_000_000,
      max_output: 65_536,
    });
    expect(getAliasLimits('xai/grok-4-fast-reasoning').context_window).toBe(1_000_000);
  });

  it('partial gateway metadata keeps the fallback for the missing field', async () => {
    process.env['LLM_BASE_URL'] = 'http://gw.local';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'anthropic/claude-opus-4-8', context_window: 500_000 }] }),
      }),
    );
    await refreshAliasLimitsFromGateway();
    expect(getAliasLimits('sudo/frontier')).toEqual({
      context_window: 500_000,
      max_output: 32_000, // fallback preserved
    });
  });

  it('fetch failure keeps fallbacks in place (fail-open)', async () => {
    process.env['LLM_BASE_URL'] = 'http://gw.local';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const updated = await refreshAliasLimitsFromGateway();
    expect(updated).toBe(0);
    expect(getAliasLimits('sudo/frontier')).toEqual({
      context_window: 200_000,
      max_output: 32_000,
    });
  });

  it('non-2xx and malformed bodies are ignored', async () => {
    process.env['LLM_BASE_URL'] = 'http://gw.local';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await refreshAliasLimitsFromGateway()).toBe(0);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: 'nope' }) }),
    );
    expect(await refreshAliasLimitsFromGateway()).toBe(0);
    expect(getAliasLimits('sudo/cheap').context_window).toBe(2_000_000);
  });

  it('no LLM_BASE_URL → refresh is a no-op without touching fetch', async () => {
    delete process.env['LLM_BASE_URL'];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await refreshAliasLimitsFromGateway()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('estimateTokens', () => {
  it('estimates plain strings at ~chars/4', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('')).toBe(0);
  });

  it('a ~1000-char text message estimates 200-300 tokens', () => {
    const msgs: IRMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(1000) }] },
    ];
    const t = estimateTokens(msgs);
    expect(t).toBeGreaterThanOrEqual(200);
    expect(t).toBeLessThanOrEqual(300);
  });

  it('is monotonic in text length', () => {
    const mk = (n: number): IRMessage[] => [
      { role: 'user', content: [{ type: 'text', text: 'y'.repeat(n) }] },
    ];
    const sizes = [10, 100, 1000, 10_000];
    const estimates = sizes.map((n) => estimateTokens(mk(n)));
    for (let i = 1; i < estimates.length; i++) {
      expect(estimates[i]!).toBeGreaterThan(estimates[i - 1]!);
    }
  });

  it('counts per-message and per-block overhead', () => {
    const one: IRMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const two: IRMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    const single = estimateTokens(one);
    expect(single).toBeGreaterThanOrEqual(4 + 6); // overheads alone
    expect(estimateTokens(two)).toBe(single * 2);
  });

  it('an image adds ~1500 tokens', () => {
    const withoutImage: IRMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }] },
    ];
    const withImage: IRMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aa' } },
        ],
      },
    ];
    const delta = estimateTokens(withImage) - estimateTokens(withoutImage);
    expect(delta).toBeGreaterThanOrEqual(1500);
    expect(delta).toBeLessThanOrEqual(1520);
  });

  it('counts tool definitions and system prompt on IRRequest', () => {
    const bare = baseRequest([{ role: 'user', content: [{ type: 'text', text: 'q' }] }]);
    const loaded: IRRequest = {
      ...bare,
      system: 's'.repeat(400),
      tools: [
        {
          name: 'big_tool',
          description: 'd'.repeat(200),
          input_schema: { type: 'object', properties: { a: { type: 'string' } } },
        },
      ],
    };
    const delta = estimateTokens(loaded) - estimateTokens(bare);
    expect(delta).toBeGreaterThan(100); // system 100 + tool def
  });

  it('counts tool_use input and tool_result content', () => {
    const small = baseRequest([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }],
      },
    ]);
    const big = baseRequest([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'f', input: { blob: 'z'.repeat(4000) } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r'.repeat(2000) }],
      },
    ]);
    expect(estimateTokens(big) - estimateTokens(small)).toBeGreaterThan(1400);
  });

  it('an empty request estimates small', () => {
    expect(estimateTokens(baseRequest([]))).toBeLessThan(10);
    expect(estimateTokens([])).toBe(0);
  });
});
