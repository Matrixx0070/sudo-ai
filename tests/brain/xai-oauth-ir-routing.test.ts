/**
 * @file tests/brain/xai-oauth-ir-routing.test.ts
 * @description Regression suite for the 2026-07-14 prod incident (part 2 —
 * the routing half; the constructor half is provider-prefix-boot.test.ts).
 *
 * xai-oauth models are served ONLY by the IR transport. Pinned here:
 * - brain.call()/brain.stream() route 'xai-oauth/…' through the transport
 *   UNCONDITIONALLY — LLM_IR_CALLERS unset must not matter.
 * - a transport failure on an xai-oauth profile NEVER falls through to the
 *   legacy ai-SDK call (which can only throw 'Unknown provider'); it is
 *   rethrown so the failover loop cooldowns the profile and the NEXT profile
 *   serves via its normal path.
 *
 * Harness pattern from brain-ir-seam.test.ts: vi.mock('ai') stubs the legacy
 * wire hops; the IR path runs the REAL transport against a stubbed global
 * fetch; the xai-oauth manager module is vi.mock'd so auth never reads disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock, streamText: streamTextMock };
});

// Pin the manager accessor shape the transport dynamic-imports — a Bearer
// token without touching disk credentials.
vi.mock('../../src/llm/xai-oauth-manager.js', () => ({
  getXaiOAuthManager: () => ({ getAccessToken: async () => 'xai-oauth-test-token' }),
  XaiOAuthReloginRequiredError: class XaiOAuthReloginRequiredError extends Error {},
}));

import { Brain } from '../../src/core/brain/brain.js';
import { __resetPolicyState } from '../../src/llm/policy.js';
import { XAI_RESPONSES_URL } from '../../src/llm/endpoints.js';

const OAUTH_MODEL = 'xai-oauth/grok-4.5';
const FALLBACK_MODEL = 'xai/grok-4-fast-non-reasoning';
/** Prod-shaped: IR-only primary with a legacy-servable fallback behind it. */
const BRAIN_CONFIG = {
  models: {
    primary: [
      { id: OAUTH_MODEL, maxOutputTokens: 8192 },
      { id: FALLBACK_MODEL, maxOutputTokens: 8192 },
    ],
  },
};

const ENV_KEYS = [
  'LLM_IR_CALLERS',
  'XAI_API_KEY',
  'SUDO_BRAIN_CONSENSUS_DISABLE',
  'SUDO_SMART_ROUTE_DISABLE',
  'SUDO_FAILOVER_BACKOFF_DISABLE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

/** Resolved ai-SDK generateText shape for the legacy fallback profile. */
const LEGACY_RESPONSE = {
  text: 'legacy fallback answer',
  toolCalls: [],
  usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
  finishReason: 'stop',
};

/** xAI Responses-API wire success (family 'xai-responses'). */
const XAI_RESPONSES_WIRE = {
  id: 'resp_1',
  status: 'completed',
  output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'grok via IR transport' }] },
  ],
  usage: { input_tokens: 12, output_tokens: 4 },
};

async function newBrain(): Promise<Brain> {
  const brain = new Brain(BRAIN_CONFIG);
  await (brain as unknown as { providersReady: Promise<void> }).providersReady;
  return brain;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // LLM_IR_CALLERS stays UNSET — the point under test.
  process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1'; // deterministic sequential failover
  process.env['SUDO_SMART_ROUTE_DISABLE'] = '1'; // pin profile order (no cheap-route)
  process.env['SUDO_FAILOVER_BACKOFF_DISABLE'] = '1'; // no real sleeps between attempts
  process.env['XAI_API_KEY'] = 'xai-test-key'; // legacy provider for the fallback profile
  __resetPolicyState();
  generateTextMock.mockReset();
  streamTextMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('brain routes xai-oauth models through the IR transport UNCONDITIONALLY', () => {
  it('call(): LLM_IR_CALLERS unset → xai-oauth served via the transport; legacy ai-SDK untouched', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(XAI_RESPONSES_WIRE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const brain = await newBrain(); // boot itself regresses the constructor half
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(XAI_RESPONSES_URL);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(res.model).toBe(OAUTH_MODEL);
    expect(res.content).toBe('grok via IR transport');
  });

  it('call(): transport failure on xai-oauth NEVER falls to legacy for the SAME profile — failover advances', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchSpy);
    generateTextMock.mockResolvedValue(LEGACY_RESPONSE);

    const brain = await newBrain();
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });

    // The transport WAS attempted for xai-oauth (noRetry → one fetch), the
    // profile was cooled, and generateText ran exactly ONCE — for the NEXT
    // profile. Pre-fix behavior was a same-attempt legacy fallback that threw
    // 'Unknown provider' out of getModel (the crash-loop).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(res.model).toBe(FALLBACK_MODEL);
    expect(res.content).toBe('legacy fallback answer');
  });

  it('stream(): pre-first-token transport failure on xai-oauth rethrows — NEXT profile streams via legacy', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchSpy);
    streamTextMock.mockReturnValue({
      textStream: (async function* () {
        yield 'legacy ';
        yield 'stream';
      })(),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      providerMetadata: Promise.resolve(undefined),
    });

    const brain = await newBrain();
    const chunks: string[] = [];
    for await (const c of brain.stream({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' })) {
      chunks.push(c);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1); // xai-oauth attempt hit the transport
    expect(streamTextMock).toHaveBeenCalledTimes(1); // fallback profile, legacy path
    expect(chunks).toEqual(['legacy ', 'stream']);
  });
});
