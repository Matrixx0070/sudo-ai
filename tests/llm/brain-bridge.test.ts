/**
 * @file tests/llm/brain-bridge.test.ts
 * @description gw-cutover Phase 2 — unit tests for the Brain↔IR-transport
 * bridge: the LLM_IR_CALLERS ramp flag, the IRResponse→legacy-result mapper
 * (inverse of shadow.ts resultToIR), the non-streaming transport wrapper
 * (retry disabled — brain's failover loop owns retry), and the streaming
 * facade (textStream deltas + usage/finishReason promises).
 *
 * All network is a mocked fetchImpl (transport.test.ts idiom) — NO sockets.
 * Gateway logging stays dormant (SUDO_GATEWAY_LOG_TEST unset under vitest).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IRResponse } from '../../shared-types/ir/v1.js';
import {
  irResponseToBrainResult,
  irStopReasonToFinishReason,
  callTransportForBrain,
  streamTransportForBrain,
} from '../../src/llm/brain-bridge.js';
import { __resetPolicyState } from '../../src/llm/policy.js';
import type { ShadowBrainRequest } from '../../src/llm/shadow.js';

// ---------------------------------------------------------------------------
// Env scoping
// ---------------------------------------------------------------------------

const ENV_KEYS = ['LLM_IR_CALLERS', 'XAI_API_KEY', 'SUDO_LLM_RETRY_DISABLE'] as const;
let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env['LLM_IR_CALLERS'];
  delete process.env['SUDO_LLM_RETRY_DISABLE'];
  process.env['XAI_API_KEY'] = 'xai-test-key';
  __resetPolicyState();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL = 'xai/grok-4-fast-non-reasoning';

function baseRequest(partial: Partial<ShadowBrainRequest> = {}): ShadowBrainRequest {
  return {
    messages: [{ role: 'user', content: 'Hi' }],
    system: 'be terse',
    source: 'agent',
    maxTokens: 128,
    ...partial,
  };
}

function irResponse(partial: Partial<IRResponse> = {}): IRResponse {
  return {
    blocks: [{ type: 'text', text: 'Hello back.' }],
    stop_reason: 'end_turn',
    usage: { in: 12, out: 4, cached_in: 0 },
    trace_id: 'trace-bridge-1',
    ...partial,
  };
}

interface Captured {
  url: string;
  body: string;
}

type Reply = { status: number; json: unknown } | { status?: 200; stream: () => ReadableStream<Uint8Array> };

const enc = new TextEncoder();

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

function sseStreamThenError(chunks: string[], error: Error): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.error(error);
    },
  });
}

function oai(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function mockFetch(replies: Reply[]): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const reply = replies[Math.min(i, replies.length - 1)]!;
    i += 1;
    calls.push({ url: String(input), body: String(init?.body) });
    if ('json' in reply) {
      return new Response(JSON.stringify(reply.json), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(reply.stream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async (): Promise<void> => {};

describe('irResponseToBrainResult', () => {
  it('joins text blocks and maps usage (ai-SDK v6 naming, cached included)', () => {
    const res = irResponseToBrainResult(
      irResponse({
        blocks: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'back.' },
        ],
        usage: { in: 100, out: 20, cached_in: 60 },
      }),
      MODEL,
    );
    expect(res.text).toBe('Hello back.');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 60, cacheCreationInputTokens: 0 });
    // cached tokens surface through the synthesized Anthropic-shaped metadata
    // (the only providerMetadata reader on the brain path).
    expect(res.providerMetadata).toEqual({
      anthropic: { usage: { cache_read_input_tokens: 60, cache_creation_input_tokens: 0 } },
    });
    expect(res.toolCalls).toEqual([]);
  });

  it('cache_creation_in maps into usage + synthesized providerMetadata (F2)', () => {
    const res = irResponseToBrainResult(
      irResponse({ usage: { in: 100, out: 20, cached_in: 60, cache_creation_in: 15 } }),
      MODEL,
    );
    expect(res.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 60,
      cacheCreationInputTokens: 15,
    });
    expect(res.providerMetadata).toEqual({
      anthropic: { usage: { cache_read_input_tokens: 60, cache_creation_input_tokens: 15 } },
    });
  });

  it('cache creation WITHOUT cache reads still synthesizes providerMetadata (F2)', () => {
    const res = irResponseToBrainResult(
      irResponse({ usage: { in: 50, out: 5, cached_in: 0, cache_creation_in: 30 } }),
      MODEL,
    );
    expect(res.providerMetadata).toEqual({
      anthropic: { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 30 } },
    });
  });

  it('no cached tokens → providerMetadata undefined (legacy absence tolerated)', () => {
    const res = irResponseToBrainResult(irResponse(), MODEL);
    expect(res.providerMetadata).toBeUndefined();
  });

  it('tool_use blocks → ai-SDK-shaped toolCalls with parsed OBJECT input', () => {
    const res = irResponseToBrainResult(
      irResponse({
        blocks: [
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
        ],
        stop_reason: 'tool_use',
      }),
      MODEL,
    );
    expect(res.finishReason).toBe('tool-calls');
    expect(res.toolCalls).toEqual([{ toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Oslo' } }]);
  });

  it('maps every stop_reason to the legacy finishReason', () => {
    expect(irStopReasonToFinishReason('end_turn')).toBe('stop');
    expect(irStopReasonToFinishReason('tool_use')).toBe('tool-calls');
    expect(irStopReasonToFinishReason('max_tokens')).toBe('length');
    expect(irStopReasonToFinishReason('error')).toBe('error');
  });

  it('thinking blocks surface as reasoningText (ai-SDK reasoning field)', () => {
    const res = irResponseToBrainResult(
      irResponse({
        blocks: [
          { type: 'thinking', thinking: 'pondering…', signature: 'sig' },
          { type: 'text', text: 'answer' },
        ],
      }),
      MODEL,
    );
    expect(res.text).toBe('answer');
    expect(res.reasoningText).toBe('pondering…');
  });
});

// ---------------------------------------------------------------------------
// callTransportForBrain (non-streaming)
// ---------------------------------------------------------------------------

const OPENAI_TEXT_WIRE = {
  choices: [{ message: { role: 'assistant', content: 'Hello back.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
};

describe('callTransportForBrain', () => {
  it('happy path: mapped legacy result + a minted traceId', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: OPENAI_TEXT_WIRE }]);
    const { result, traceId } = await callTransportForBrain(baseRequest(), MODEL, { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.x.ai/v1/chat/completions');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['model']).toBe('grok-4-fast-non-reasoning');
    expect(body['max_tokens']).toBe(128);

    expect(result.text).toBe('Hello back.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 3, cacheCreationInputTokens: 0 });
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/); // minted uuid, not the shadow- prefix
  });

  it('policy retry is DISABLED: a retryable 500 throws after exactly ONE fetch', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 500, json: { error: 'boom' } }]);
    await expect(
      callTransportForBrain(baseRequest(), MODEL, { fetchImpl, sleep: noSleep }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1); // brain's failover loop owns retry — no policy retry underneath
  });

  it("stop_reason 'error' response (200 provider lie) → throws so brain falls back to legacy", async () => {
    const { fetchImpl } = mockFetch([{ status: 200, json: { garbage: true } }]);
    await expect(callTransportForBrain(baseRequest(), MODEL, { fetchImpl })).rejects.toThrow(/stop_reason 'error'/);
  });
});

// ---------------------------------------------------------------------------
// streamTransportForBrain (facade)
// ---------------------------------------------------------------------------

const STREAM_OK_CHUNKS = [
  oai({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }),
  oai({ choices: [{ delta: { content: 'lo.' } }] }),
  oai({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  oai({ choices: [], usage: { prompt_tokens: 25, completion_tokens: 17, prompt_tokens_details: { cached_tokens: 10 } } }),
  'data: [DONE]\n\n',
];

describe('streamTransportForBrain', () => {
  it('text deltas accumulate; usage + finishReason resolve from message_end', async () => {
    const { fetchImpl } = mockFetch([{ stream: () => sseStream(STREAM_OK_CHUNKS) }]);
    const facade = await streamTransportForBrain(baseRequest(), MODEL, { fetchImpl });

    let text = '';
    for await (const chunk of facade.textStream) text += chunk;
    expect(text).toBe('Hello.');

    await expect(facade.usage).resolves.toEqual({
      inputTokens: 25,
      outputTokens: 17,
      totalTokens: 42,
      cachedInputTokens: 10,
      cacheCreationInputTokens: 0,
    });
    await expect(facade.finishReason).resolves.toBe('stop');
    expect(facade.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('pre-first-token HTTP failure → REJECTS (brain falls back to legacy), one fetch only', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 500, json: { error: 'boom' } }]);
    await expect(
      streamTransportForBrain(baseRequest(), MODEL, { fetchImpl, sleep: noSleep }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1); // noRetry: policy never re-attempts under brain's failover
  });

  it('mid-stream failure AFTER the first token → textStream throws the terminal error', async () => {
    const { fetchImpl } = mockFetch([
      {
        stream: () =>
          sseStreamThenError(
            [oai({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] })],
            new Error('socket reset'),
          ),
      },
    ]);
    const facade = await streamTransportForBrain(baseRequest(), MODEL, { fetchImpl });

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of facade.textStream) seen.push(chunk);
      })(),
    ).rejects.toThrow(); // terminal error surfaces — the transport never re-requested (Rule 4)
    expect(seen).toEqual(['Hel']); // the partial output was delivered before the failure
    // fail() emits a terminal message_end with whatever usage accumulated (zeros here).
    await expect(facade.usage).resolves.toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 });
    await expect(facade.finishReason).resolves.toBe('error');
  });

  it('consumer break: facade.usage settles with the LAST-KNOWN partial usage, never undefined (F3)', async () => {
    // Usage rides the FIRST chunk (OpenAI include_usage can attach it to any
    // chunk) so the machine has a partial snapshot before the consumer breaks.
    const chunks = [
      oai({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }], usage: { prompt_tokens: 30, completion_tokens: 2 } }),
      oai({ choices: [{ delta: { content: 'lo.' } }] }),
      oai({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ];
    const { fetchImpl } = mockFetch([{ stream: () => sseStream(chunks) }]);
    const facade = await streamTransportForBrain(baseRequest(), MODEL, { fetchImpl });

    for await (const chunk of facade.textStream) {
      expect(chunk).toBe('Hel');
      break; // consumer walks away mid-stream
    }

    // Settles immediately (no terminal event) from the transport's snapshot.
    await expect(facade.usage).resolves.toEqual({
      inputTokens: 30,
      outputTokens: 2,
      totalTokens: 32,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    // No terminal was seen — finishReason stays undefined on abandonment.
    await expect(facade.finishReason).resolves.toBeUndefined();
  });

  it('consumer break BEFORE any usage chunk: facade.usage resolves zeros, never undefined (F3)', async () => {
    const chunks = [
      oai({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }),
      oai({ choices: [{ delta: { content: 'lo.' } }] }),
      'data: [DONE]\n\n',
    ];
    const { fetchImpl } = mockFetch([{ stream: () => sseStream(chunks) }]);
    const facade = await streamTransportForBrain(baseRequest(), MODEL, { fetchImpl });
    for await (const _chunk of facade.textStream) break;
    await expect(facade.usage).resolves.toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});
