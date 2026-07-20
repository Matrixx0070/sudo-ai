/**
 * @file tests/llm/transport-xai-responses.test.ts
 * @description Transport wiring tests for the 'xai-responses' family
 * (xai-oauth Phase 2). All network is a mocked fetchImpl; the xai-oauth
 * manager module is vi.mock'd so the token accessor shape is pinned without
 * touching disk credentials. Mirrors tests/llm/transport.test.ts style.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IRRequest } from '../../shared-types/ir/v1.js';
import { callIR, streamIR } from '../../src/llm/transport.js';
import type { IRStreamEvent } from '../../src/llm/adapters/stream.js';
import { LLMPolicyError } from '../../src/llm/errors.js';
import { __resetPolicyState } from '../../src/llm/policy.js';
import { __resetGatewayCallLog, getGatewayCallLog } from '../../src/llm/logging.js';

// ---------------------------------------------------------------------------
// xai-oauth manager mock — pins the accessor shape the transport reuses
// (getXaiOAuthManager().getAccessToken() + XaiOAuthReloginRequiredError).
// ---------------------------------------------------------------------------

const xaiOauthMock = {
  getAccessToken: vi.fn<() => Promise<string | null>>(async () => 'xai-oauth-test-token'),
};

class MockReloginError extends Error {
  readonly code = 'XAI_OAUTH_RELOGIN_REQUIRED';
  constructor() {
    super('re-login required');
    this.name = 'XaiOAuthReloginRequiredError';
  }
}

vi.mock('../../src/llm/xai-oauth-manager.js', () => ({
  getXaiOAuthManager: () => xaiOauthMock,
  XaiOAuthReloginRequiredError: MockReloginError,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseIR(partial: Partial<IRRequest> = {}): IRRequest {
  return {
    alias: 'xai-oauth/grok-4.3',
    caller: 'test',
    purpose: 'xai-responses-transport-unit',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    priority: 'user',
    trace_id: 'trace-xai-oauth-1',
    max_tokens: 64,
    ...partial,
  };
}

const RESPONSES_TEXT_WIRE = {
  id: 'resp_1',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ready' }] }],
  usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function mockFetch(replies: Array<{ status: number; json: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const reply = replies[Math.min(i, replies.length - 1)]!;
    i += 1;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url: String(input), headers, body: String(init?.body) });
    return new Response(JSON.stringify(reply.json), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ENV_KEYS = ['SUDO_LLM_RETRY_DISABLE', 'SUDO_GATEWAY_LOG_TEST', 'SUDO_XAI_OAUTH_SUBSCRIPTION', 'SUDO_GROK_CLI_VERSION', 'XAI_API_KEY'] as const;
let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['SUDO_LLM_RETRY_DISABLE'] = '1';
  delete process.env['SUDO_GATEWAY_LOG_TEST'];
  // GX1: default ON (subscription proxy). Individual tests flip it OFF to
  // exercise the legacy metered path. SUDO_GROK_CLI_VERSION unset → 0.2.22.
  delete process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'];
  delete process.env['SUDO_GROK_CLI_VERSION'];
  __resetPolicyState();
  xaiOauthMock.getAccessToken.mockClear();
  xaiOauthMock.getAccessToken.mockResolvedValue('xai-oauth-test-token');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  __resetGatewayCallLog();
});

// ---------------------------------------------------------------------------
// Route + headers
// ---------------------------------------------------------------------------

describe('callIR — xai-responses family', () => {
  it('routes xai-oauth/ to /v1/responses with Bearer + x-grok-conv-id (trace_id fallback)', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: RESPONSES_TEXT_WIRE }]);
    const res = await callIR(baseIR(), { fetchImpl });

    expect(calls).toHaveLength(1);
    // GX1 default ON: seat-covered Grok CLI subscription proxy, not api.x.ai.
    expect(calls[0]!.url).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    expect(calls[0]!.headers['authorization']).toBe('Bearer xai-oauth-test-token');
    // No extra.conv_id → derived from the trace_id.
    expect(calls[0]!.headers['x-grok-conv-id']).toBe('trace-xai-oauth-1');
    // GX1: the five grok-cli client headers the proxy requires (Authorization
    // above + these four). model-override pins the resolved model id.
    expect(calls[0]!.headers['x-grok-client-version']).toBe('0.2.22');
    expect(calls[0]!.headers['x-grok-client-identifier']).toBe('grok-shell');
    expect(calls[0]!.headers['x-grok-model-override']).toBe('grok-4.3');
    expect(calls[0]!.headers['user-agent']).toBe('grok/0.2.22');
    expect(xaiOauthMock.getAccessToken).toHaveBeenCalledTimes(1);

    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['model']).toBe('grok-4.3'); // prefix stripped, exactly once
    expect(body['max_output_tokens']).toBe(64);
    expect(body['input']).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }]);

    expect(res.blocks).toEqual([{ type: 'text', text: 'ready' }]);
    expect(res.stop_reason).toBe('end_turn');
    expect(res.usage).toEqual({ in: 12, out: 4, cached_in: 3 });
  });

  it('x-grok-conv-id comes from ir.extra.conv_id when present', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: RESPONSES_TEXT_WIRE }]);
    await callIR(baseIR({ extra: { conv_id: 'session-42' } }), { fetchImpl });
    expect(calls[0]!.headers['x-grok-conv-id']).toBe('session-42');
  });

  it('tool round trip: flat Responses tools out, function_call → tool_use object input back', async () => {
    const wire = {
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Oslo"}' }],
      usage: { input_tokens: 30, output_tokens: 18 },
    };
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: wire }]);
    const res = await callIR(
      baseIR({
        tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      }),
      { fetchImpl },
    );
    const body = JSON.parse(calls[0]!.body) as { tools: Array<Record<string, unknown>> };
    expect(body.tools[0]!['type']).toBe('function');
    expect(body.tools[0]!['name']).toBe('get_weather');
    expect(body.tools[0]!['function']).toBeUndefined(); // flat, not chat-completions shape
    expect(res.stop_reason).toBe('tool_use');
    expect(res.blocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Auth + error classification
// ---------------------------------------------------------------------------

describe('callIR — xai-oauth auth + classification', () => {
  it('no store (getAccessToken null) → auth throw with login hint, fetch never called', async () => {
    xaiOauthMock.getAccessToken.mockResolvedValue(null);
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: RESPONSES_TEXT_WIRE }]);
    const err = await callIR(baseIR(), { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('auth');
    expect((err as LLMPolicyError).message).toContain('sudo-ai xai-oauth login');
    expect(calls).toHaveLength(0);
  });

  it('dead refresh token (relogin error) → auth throw with login hint', async () => {
    xaiOauthMock.getAccessToken.mockRejectedValue(new MockReloginError());
    const { fetchImpl } = mockFetch([{ status: 200, json: RESPONSES_TEXT_WIRE }]);
    const err = await callIR(baseIR(), { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('auth');
    expect((err as LLMPolicyError).message).toContain('sudo-ai xai-oauth login');
  });

  it('HTTP 401 → auth with re-login hint', async () => {
    const { fetchImpl } = mockFetch([{ status: 401, json: { error: 'invalid token' } }]);
    const err = await callIR(baseIR(), { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('auth');
    expect((err as LLMPolicyError).status).toBe(401);
    expect((err as LLMPolicyError).message).toContain('sudo-ai xai-oauth login');
  });

  it('HTTP 403 → auth + extra.tier_gated=true (tier not allowlisted)', async () => {
    const { fetchImpl } = mockFetch([{ status: 403, json: { error: 'forbidden' } }]);
    const err = await callIR(baseIR(), { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('auth');
    expect((err as LLMPolicyError).status).toBe(403);
    expect((err as LLMPolicyError).extra).toEqual({ tier_gated: true });
  });

  it('HTTP 429 stays rate_limited (policy retry-after classes unchanged)', async () => {
    const { fetchImpl } = mockFetch([{ status: 429, json: { error: 'Rate limit reached for requests' } }]);
    const err = await callIR(baseIR(), { fetchImpl }).catch((e: unknown) => e);
    expect((err as LLMPolicyError).class).toBe('rate_limited');
  });

  it('personalOnly: ir.extra.untrusted === true → invalid_request, no token read, no fetch', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: RESPONSES_TEXT_WIRE }]);
    const err = await callIR(baseIR({ extra: { untrusted: true } }), { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('invalid_request');
    expect((err as LLMPolicyError).message).toContain('personalOnly');
    expect(calls).toHaveLength(0);
    expect(xaiOauthMock.getAccessToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// llm_calls logging
// ---------------------------------------------------------------------------

describe('callIR — xai-oauth llm_calls row', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'transport-xai-log-'));
    process.env['SUDO_GATEWAY_LOG_TEST'] = '1';
    __resetGatewayCallLog();
    getGatewayCallLog(join(dir, 'gateway.db'));
  });

  afterEach(() => {
    __resetGatewayCallLog();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes one row with route 'xai-oauth:responses' and token counts", async () => {
    const { fetchImpl } = mockFetch([{ status: 200, json: RESPONSES_TEXT_WIRE }]);
    await callIR(baseIR({ trace_id: 'trace-xai-log-1' }), { fetchImpl });

    const db = new Database(join(dir, 'gateway.db'), { readonly: true });
    const rows = db.prepare('SELECT * FROM llm_calls').all() as Array<Record<string, unknown>>;
    db.close();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['trace_id']).toBe('trace-xai-log-1');
    expect(row['route']).toBe('xai-oauth:responses');
    expect(row['error_class']).toBeNull();
    expect(row['tokens_in']).toBe(12);
    expect(row['tokens_out']).toBe(4);
    expect(row['tokens_cached']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

const SSE_XAI_SESSION: string[] = [
  'event: response.created\ndata: {"type":"response.created","response":{}}\n\n',
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"rea"}\n\n',
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"dy"}\n\n',
  'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":4,"input_tokens_details":{"cached_tokens":3}}}}\n\n',
];

function sseFetch(chunks: string[]): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const encoder = new TextEncoder();
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url: String(input), headers, body: String(init?.body) });
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
        else controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('streamIR — xai-responses family', () => {
  it('yields text deltas + terminal message_end with usage; stream:true + conv-id on the wire', async () => {
    const { fetchImpl, calls } = sseFetch(SSE_XAI_SESSION);
    const events: IRStreamEvent[] = [];
    for await (const ev of streamIR(baseIR({ extra: { conv_id: 'sess-7' } }), { fetchImpl })) {
      events.push(ev);
    }
    expect(calls[0]!.url).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    expect(calls[0]!.headers['authorization']).toBe('Bearer xai-oauth-test-token');
    expect(calls[0]!.headers['x-grok-conv-id']).toBe('sess-7');
    // GX1: proxy client headers present on the streaming path too.
    expect(calls[0]!.headers['x-grok-client-version']).toBe('0.2.22');
    expect(calls[0]!.headers['x-grok-model-override']).toBe('grok-4.3');
    expect((JSON.parse(calls[0]!.body) as Record<string, unknown>)['stream']).toBe(true);
    expect(events).toEqual([
      { type: 'text_delta', text: 'rea' },
      { type: 'text_delta', text: 'dy' },
      { type: 'message_end', stop_reason: 'end_turn', usage: { in: 12, out: 4, cached_in: 3 } },
    ]);
  });

  it('personalOnly guard applies to streaming too', async () => {
    const { fetchImpl, calls } = sseFetch(SSE_XAI_SESSION);
    const gen = streamIR(baseIR({ extra: { untrusted: true } }), { fetchImpl });
    const err = await gen.next().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GX1 — subscription proxy routing (SUDO_XAI_OAUTH_SUBSCRIPTION)
// ---------------------------------------------------------------------------

describe('GX1 — xai-oauth subscription proxy path', () => {
  it('grok-build model → proxy URL with model-override "grok-build" (default ON)', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: RESPONSES_TEXT_WIRE }]);
    await callIR(baseIR({ alias: 'xai-oauth/grok-build' }), { fetchImpl });
    expect(calls[0]!.url).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['model']).toBe('grok-build');
    expect(calls[0]!.headers['x-grok-model-override']).toBe('grok-build');
    expect(calls[0]!.headers['x-grok-client-identifier']).toBe('grok-shell');
    expect(calls[0]!.headers['x-grok-client-version']).toBe('0.2.22');
    expect(calls[0]!.headers['user-agent']).toBe('grok/0.2.22');
  });

  it('SUDO_GROK_CLI_VERSION overrides the version + User-Agent headers', async () => {
    process.env['SUDO_GROK_CLI_VERSION'] = '0.3.0';
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: RESPONSES_TEXT_WIRE }]);
    await callIR(baseIR({ alias: 'xai-oauth/grok-build' }), { fetchImpl });
    expect(calls[0]!.headers['x-grok-client-version']).toBe('0.3.0');
    expect(calls[0]!.headers['user-agent']).toBe('grok/0.3.0');
  });

  it('flag OFF → legacy metered api.x.ai path, NO grok-cli client headers', async () => {
    process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'] = '0';
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: RESPONSES_TEXT_WIRE }]);
    await callIR(baseIR({ alias: 'xai-oauth/grok-build' }), { fetchImpl });
    expect(calls[0]!.url).toBe('https://api.x.ai/v1/responses');
    // conv-id is not proxy-specific and stays; the four proxy-only headers do not.
    expect(calls[0]!.headers['x-grok-conv-id']).toBeDefined();
    expect(calls[0]!.headers['x-grok-client-version']).toBeUndefined();
    expect(calls[0]!.headers['x-grok-client-identifier']).toBeUndefined();
    expect(calls[0]!.headers['x-grok-model-override']).toBeUndefined();
    expect(calls[0]!.headers['user-agent']).toBeUndefined();
  });

  it('api-key xai family is UNCHANGED — still api.x.ai/v1/chat/completions, no grok headers', async () => {
    // Independent proof the GX1 change is scoped to xai-oauth only: the metered
    // api-key `xai` provider (OpenAI-compat family) keeps hitting api.x.ai.
    process.env['XAI_API_KEY'] = 'xai-test-key';
    const openaiWire = {
      choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: openaiWire }]);
    await callIR(baseIR({ alias: 'xai/grok-4-fast-non-reasoning' }), { fetchImpl });
    expect(calls[0]!.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer xai-test-key');
    expect(calls[0]!.headers['x-grok-client-version']).toBeUndefined();
    expect(calls[0]!.headers['x-grok-model-override']).toBeUndefined();
  });
});
