/**
 * @file tests/llm/transport-fast-mode.test.ts
 * @description Fast mode on the Claude seat (2026-07-31). Live-probed: opus-5
 * and opus-4-8 accept `speed:'fast'` (usage.speed=fast); sonnet-5 returns a
 * hard 400. So the gate must be strict, and because fast mode has its OWN rate
 * limit a 429 must degrade THIS call to standard speed rather than burn the
 * failover chain. All network is a mocked fetchImpl.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IRRequest } from '../../shared-types/ir/v1.js';
import { callIR } from '../../src/llm/transport.js';
import { fastModeApplies, stripSpeedFromWireBody } from '../../src/llm/fast-mode.js';
import { __resetPolicyState } from '../../src/llm/policy.js';

const oauthMock = {
  getAccessToken: vi.fn<() => string | null>(() => 'oauth-test-token'),
  refreshToken: vi.fn(async () => true),
  isAvailable: vi.fn(() => true),
};
vi.mock('../../src/llm/claude-oauth-manager.js', () => ({
  getClaudeOAuthManager: () => oauthMock,
}));

const WIRE = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 2 },
};

function baseIR(alias: string): IRRequest {
  return {
    alias,
    caller: 'test',
    purpose: 'fast-mode-unit',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    priority: 'user',
    trace_id: 'trace-fast-1',
    max_tokens: 256,
  };
}

interface Captured {
  bodies: string[];
  betas: string[];
}

/** fetchImpl that records each attempt; `statuses` drives per-attempt status. */
function mockFetch(statuses: number[] = [200]): { fetchImpl: typeof fetch; cap: Captured } {
  const cap: Captured = { bodies: [], betas: [] };
  let i = 0;
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    cap.bodies.push(String(init?.body));
    const h = (init?.headers ?? {}) as Record<string, string>;
    cap.betas.push(h['anthropic-beta'] ?? '');
    const status = statuses[Math.min(i, statuses.length - 1)] ?? 200;
    i += 1;
    if (status !== 200) return new Response('rate limited', { status });
    return new Response(JSON.stringify(WIRE), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, cap };
}

beforeEach(() => {
  __resetPolicyState();
  delete process.env['SUDO_FAST_MODE'];
});

afterEach(() => {
  delete process.env['SUDO_FAST_MODE'];
  vi.clearAllMocks();
});

describe('fastModeApplies — strict model gate', () => {
  it('true for the live-proven fast-capable seat models', () => {
    expect(fastModeApplies('claude-oauth', 'claude-opus-5')).toBe(true);
    expect(fastModeApplies('claude-oauth', 'claude-opus-4-8')).toBe(true);
    expect(fastModeApplies('claude-oauth', 'claude-opus-4-7')).toBe(true);
  });

  it('false for models that 400 on `speed`, and for non-seat providers', () => {
    expect(fastModeApplies('claude-oauth', 'claude-sonnet-5')).toBe(false);
    expect(fastModeApplies('claude-oauth', 'claude-haiku-4-5-20251001')).toBe(false);
    expect(fastModeApplies('anthropic', 'claude-opus-5')).toBe(false);
    expect(fastModeApplies('xai', 'grok-4-fast')).toBe(false);
  });

  it('SUDO_FAST_MODE=0 disables it entirely', () => {
    process.env['SUDO_FAST_MODE'] = '0';
    expect(fastModeApplies('claude-oauth', 'claude-opus-5')).toBe(false);
  });
});

describe('stripSpeedFromWireBody', () => {
  it('removes speed and leaves everything else byte-identical', () => {
    const out = stripSpeedFromWireBody(JSON.stringify({ model: 'm', speed: 'fast', max_tokens: 4 }));
    expect(JSON.parse(out)).toEqual({ model: 'm', max_tokens: 4 });
  });
  it('passes through bodies without speed and non-JSON safely', () => {
    expect(JSON.parse(stripSpeedFromWireBody('{"a":1}'))).toEqual({ a: 1 });
    expect(stripSpeedFromWireBody('not json')).toBe('not json');
  });
});

describe('callIR — fast mode on the wire', () => {
  it('opus-5 sends speed:fast and the fast-mode beta', async () => {
    const { fetchImpl, cap } = mockFetch();
    await callIR(baseIR('claude-oauth/claude-opus-5'), { fetchImpl, noRetry: true });
    expect(JSON.parse(cap.bodies[0]!).speed).toBe('fast');
    expect(cap.betas[0]).toContain('fast-mode-2026-02-01');
    expect(cap.betas[0]).toContain('oauth-2025-04-20');
  });

  it('sonnet-5 sends NO speed and no fast beta (would be a hard 400)', async () => {
    const { fetchImpl, cap } = mockFetch();
    await callIR(baseIR('claude-oauth/claude-sonnet-5'), { fetchImpl, noRetry: true });
    expect(JSON.parse(cap.bodies[0]!).speed).toBeUndefined();
    expect(cap.betas[0]).not.toContain('fast-mode');
  });

  it('SUDO_FAST_MODE=0 sends no speed', async () => {
    process.env['SUDO_FAST_MODE'] = '0';
    const { fetchImpl, cap } = mockFetch();
    await callIR(baseIR('claude-oauth/claude-opus-5'), { fetchImpl, noRetry: true });
    expect(JSON.parse(cap.bodies[0]!).speed).toBeUndefined();
  });

  it('a 429 on the fast attempt degrades the retry to standard speed', async () => {
    const { fetchImpl, cap } = mockFetch([429, 200]);
    await callIR(baseIR('claude-oauth/claude-opus-5'), { fetchImpl, sleep: async () => {} });
    expect(cap.bodies.length).toBeGreaterThanOrEqual(2);
    // First attempt asked for fast; the retry dropped both speed and the beta.
    expect(JSON.parse(cap.bodies[0]!).speed).toBe('fast');
    expect(cap.betas[0]).toContain('fast-mode');
    expect(JSON.parse(cap.bodies[1]!).speed).toBeUndefined();
    expect(cap.betas[1]).not.toContain('fast-mode');
  });
});
