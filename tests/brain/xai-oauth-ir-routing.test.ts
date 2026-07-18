/**
 * @file tests/brain/xai-oauth-ir-routing.test.ts
 * @description Regression suite for the 2026-07-14 prod incident (part 2 —
 * the routing half; the constructor half is provider-prefix-boot.test.ts).
 *
 * F97: xai-oauth models go through the IR transport like everything else —
 * there is no legacy path left to fall to. Pinned here: a transport failure on
 * an xai-oauth profile surfaces through the failover loop, which cooldowns the
 * profile and advances to the NEXT profile (also served via the transport),
 * for both call() and stream().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const callTransportMock = vi.hoisted(() => vi.fn());
const streamTransportMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/llm/brain-bridge.js', () => ({
  callTransportForBrain: callTransportMock,
  streamTransportForBrain: streamTransportMock,
}));

import { Brain } from '../../src/core/brain/brain.js';
import { AuthProfileRotation } from '../../src/core/brain/auth-profile-rotation.js';

const OAUTH_MODEL = 'xai-oauth/grok-4.5';
const FALLBACK_MODEL = 'xai/grok-4-fast-non-reasoning';
/** Prod-shaped: xai-oauth primary with an env-key fallback behind it. */
const BRAIN_CONFIG = {
  models: {
    primary: [
      { id: OAUTH_MODEL, maxOutputTokens: 8192 },
      { id: FALLBACK_MODEL, maxOutputTokens: 8192 },
    ],
  },
};

const ENV_KEYS = [
  'XAI_API_KEY',
  'SUDO_BRAIN_CONSENSUS_DISABLE',
  'SUDO_SMART_ROUTE_DISABLE',
  'SUDO_FAILOVER_BACKOFF_DISABLE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function okCall(text: string) {
  return {
    result: {
      text,
      finishReason: 'stop' as const,
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
      toolCalls: [],
      reasoning: undefined,
      reasoningText: undefined,
      providerMetadata: undefined,
    },
    traceId: 'trace-xai-oauth',
  };
}

function okFacade(chunks: string[]) {
  return {
    textStream: (async function* () { for (const c of chunks) yield c; })(),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheCreationInputTokens: 0 }),
    finishReason: Promise.resolve('stop' as const),
    traceId: 'trace-xai-oauth-stream',
  };
}

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
  process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1'; // deterministic sequential failover
  process.env['SUDO_SMART_ROUTE_DISABLE'] = '1'; // pin profile order (no cheap-route)
  process.env['SUDO_FAILOVER_BACKOFF_DISABLE'] = '1'; // no real sleeps between attempts
  process.env['XAI_API_KEY'] = 'xai-test-key'; // env-key credential for the fallback profile
  AuthProfileRotation.resetInstance();
  callTransportMock.mockReset();
  streamTransportMock.mockReset();
});

afterEach(() => {
  AuthProfileRotation.resetInstance();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('brain routes xai-oauth models through the IR transport like every other profile (F97)', () => {
  it('call(): xai-oauth success is served via the transport, single attempt, no apiKeyOverride', async () => {
    callTransportMock.mockResolvedValue(okCall('grok via IR transport'));

    const brain = await newBrain(); // boot itself regresses the constructor half
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });

    expect(callTransportMock).toHaveBeenCalledTimes(1);
    expect(callTransportMock.mock.calls[0]![1]).toBe(OAUTH_MODEL);
    // xai-oauth is rotation-exempt: plain transport call, no CallIROptions.
    expect(callTransportMock.mock.calls[0]![2]).toBeUndefined();
    expect(res.model).toBe(OAUTH_MODEL);
    expect(res.content).toBe('grok via IR transport');
  });

  it('call(): transport failure on the xai-oauth profile → failover advances; NEXT profile also served via the transport', async () => {
    callTransportMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // xai-oauth attempt
      .mockResolvedValueOnce(okCall('fallback answer via transport'));

    const brain = await newBrain();
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });

    // One transport attempt per profile — the failed xai-oauth attempt cooled
    // the profile and the failover loop advanced. (Pre-F97 the bug was a
    // same-attempt legacy fallback throwing 'Unknown provider' — that path no
    // longer exists at all.)
    expect(callTransportMock).toHaveBeenCalledTimes(2);
    expect(callTransportMock.mock.calls[0]![1]).toBe(OAUTH_MODEL);
    expect(callTransportMock.mock.calls[1]![1]).toBe(FALLBACK_MODEL);
    expect(res.model).toBe(FALLBACK_MODEL);
    expect(res.content).toBe('fallback answer via transport');
  });

  it('stream(): pre-first-token transport failure on xai-oauth → NEXT profile streams via the transport', async () => {
    streamTransportMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // xai-oauth attempt
      .mockResolvedValueOnce(okFacade(['fallback ', 'stream']));

    const brain = await newBrain();
    const chunks: string[] = [];
    for await (const c of brain.stream({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' })) {
      chunks.push(c);
    }

    expect(streamTransportMock).toHaveBeenCalledTimes(2);
    expect(streamTransportMock.mock.calls[0]![1]).toBe(OAUTH_MODEL);
    expect(streamTransportMock.mock.calls[1]![1]).toBe(FALLBACK_MODEL);
    expect(chunks).toEqual(['fallback ', 'stream']);
  });
});
