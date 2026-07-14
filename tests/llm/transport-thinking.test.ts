/**
 * @file tests/llm/transport-thinking.test.ts
 * @description F1 (gw-cutover review): the IR transport's anthropic branch
 * must inject the extended-thinking budget for opus-4-8+ EXACTLY like the
 * legacy claude-oauth interceptor (legacy/providers.ts section 1c) — same
 * resolveThinkingBudget math, same {thinking, max_tokens} bytes, same
 * SUDO_THINKING_DISABLE kill-switch and SUDO_THINKING_BUDGET /
 * SUDO_THINKING_MODEL_MAX env interplay. All network is a mocked fetchImpl.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IRRequest } from '../../shared-types/ir/v1.js';
import { callIR } from '../../src/llm/transport.js';
import { __resetPolicyState } from '../../src/llm/policy.js';
import { resolveThinkingBudget } from '../../src/core/brain/thinking-inject.js';

// claude-oauth manager mock (transport.test.ts idiom) — no disk credentials.
const oauthMock = {
  getAccessToken: vi.fn<() => string | null>(() => 'oauth-test-token'),
  refreshToken: vi.fn(async () => true),
  isAvailable: vi.fn(() => true),
};
vi.mock('../../src/llm/legacy/claude-oauth-manager.js', () => ({
  getClaudeOAuthManager: () => oauthMock,
}));

const ANTHROPIC_TEXT_WIRE = {
  content: [{ type: 'text', text: 'Hello back.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 4 },
};

function baseIR(partial: Partial<IRRequest> = {}): IRRequest {
  return {
    alias: 'anthropic/claude-opus-4-8',
    caller: 'test',
    purpose: 'transport-thinking-unit',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    priority: 'user',
    trace_id: 'trace-thinking-1',
    max_tokens: 8192,
    ...partial,
  };
}

function mockFetch(): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify(ANTHROPIC_TEXT_WIRE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

const ENV_KEYS = [
  'XAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'SUDO_THINKING_DISABLE',
  'SUDO_THINKING_BUDGET',
  'SUDO_THINKING_MODEL_MAX',
] as const;
let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
  delete process.env['ANTHROPIC_AUTH_TOKEN'];
  delete process.env['SUDO_THINKING_DISABLE'];
  delete process.env['SUDO_THINKING_BUDGET'];
  delete process.env['SUDO_THINKING_MODEL_MAX'];
  __resetPolicyState();
  oauthMock.getAccessToken.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

/** What the LEGACY interceptor would inject for a body with this max_tokens. */
function legacyExpectation(model: string, currentMaxTokens: number): { thinking: unknown; max_tokens: number } | null {
  const tb = resolveThinkingBudget(model, currentMaxTokens, {
    disable: process.env['SUDO_THINKING_DISABLE'],
    budget: process.env['SUDO_THINKING_BUDGET'],
    modelMax: process.env['SUDO_THINKING_MODEL_MAX'],
  });
  if (!tb) return null;
  return { thinking: { type: 'enabled', budget_tokens: tb.budgetTokens }, max_tokens: tb.maxTokens };
}

describe('transport thinking-budget injection (legacy providers.ts 1c parity)', () => {
  it('opus-4-8: thinking injected, BYTE-parity with the legacy interceptor output', async () => {
    const { fetchImpl, bodies } = mockFetch();
    await callIR(baseIR(), { fetchImpl });

    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    // Legacy computes from the pre-injection body max_tokens (ir.max_tokens 8192).
    const expected = legacyExpectation('claude-opus-4-8', 8192);
    expect(expected).not.toBeNull();
    expect(body['thinking']).toEqual(expected!.thinking);
    expect(body['max_tokens']).toBe(expected!.max_tokens);
    // Byte parity of the injected slice (key order fixed by construction).
    expect(JSON.stringify({ thinking: body['thinking'], max_tokens: body['max_tokens'] })).toBe(
      JSON.stringify(expected),
    );
    // Sanity on the actual values (defaults: budget 27904 = 32000-4096 clamp,
    // max_tokens bumped to 32000 since 8192 <= budget).
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 27904 });
    expect(body['max_tokens']).toBe(32000);
  });

  it('claude-opus-4-7: NOT injected (OPUS_THINKING_RE is opus-4-8+ only)', async () => {
    const { fetchImpl, bodies } = mockFetch();
    await callIR(baseIR({ alias: 'anthropic/claude-opus-4-7' }), { fetchImpl });
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(body['thinking']).toBeUndefined();
    expect(body['max_tokens']).toBe(8192); // untouched
  });

  it('SUDO_THINKING_DISABLE=1 suppresses injection entirely', async () => {
    process.env['SUDO_THINKING_DISABLE'] = '1';
    const { fetchImpl, bodies } = mockFetch();
    await callIR(baseIR(), { fetchImpl });
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(body['thinking']).toBeUndefined();
    expect(body['max_tokens']).toBe(8192);
  });

  it('SUDO_THINKING_BUDGET + SUDO_THINKING_MODEL_MAX clamp interplay matches legacy', async () => {
    process.env['SUDO_THINKING_BUDGET'] = '40000'; // above the model-max clamp
    process.env['SUDO_THINKING_MODEL_MAX'] = '16000';
    const { fetchImpl, bodies } = mockFetch();
    await callIR(baseIR({ max_tokens: 20000 }), { fetchImpl });

    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    const expected = legacyExpectation('claude-opus-4-8', 20000);
    expect(JSON.stringify({ thinking: body['thinking'], max_tokens: body['max_tokens'] })).toBe(
      JSON.stringify(expected),
    );
    // budget clamped to 16000-4096=11904; caller's 20000 > modelMax 16000 → 16000.
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 11904 });
    expect(body['max_tokens']).toBe(16000);
  });

  it('claude-oauth route: injected too (before the oauth contract), attestation intact', async () => {
    const { fetchImpl, bodies } = mockFetch();
    await callIR(baseIR({ alias: 'claude-oauth/claude-opus-4-8' }), { fetchImpl });
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    const expected = legacyExpectation('claude-opus-4-8', 8192);
    expect(body['thinking']).toEqual(expected!.thinking);
    expect(body['max_tokens']).toBe(expected!.max_tokens);
    const system = body['system'] as Array<{ text: string }>;
    expect(system[0]!.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it('non-anthropic family untouched (no thinking field on openai-compat bodies)', async () => {
    process.env['XAI_API_KEY'] = 'xai-test-key';
    const { fetchImpl, bodies } = mockFetch();
    await callIR(baseIR({ alias: 'xai/grok-4-fast-non-reasoning' }), { fetchImpl });
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(body['thinking']).toBeUndefined();
  });
});
