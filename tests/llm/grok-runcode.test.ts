/**
 * @file grok-runcode.test.ts
 * @description Unit tests for the free grok code-interpreter lane. NO network:
 * fetch + token are injected. Mocks mirror the REAL /v1/responses payload
 * observed on the live cli proxy 2026-07-21 (reasoning item +
 * code_interpreter_call with EMPTY logs + assistant message carrying the
 * GRK_STDOUT/GRK_STDERR protocol + usage.server_side_tool_usage_details).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runGrokCode,
  GrokRunCodeError,
  type GrokRunCodeDeps,
} from '../../src/llm/grok-runcode.js';

beforeEach(() => {
  delete process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'];
});
afterEach(() => {
  delete process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'];
  vi.restoreAllMocks();
});

/** Real response shape from the live probe (trimmed to the parsed fields). */
function proxyPayload(msgText: string, interpreterCalls = 1): Record<string, unknown> {
  return {
    id: '34f13feb-a37d-95e4-9052-70e088f8a9c4',
    model: 'grok-4.5-build',
    object: 'response',
    status: 'completed',
    output: [
      {
        id: 'rs_x',
        type: 'reasoning',
        status: 'completed',
        summary: [{ text: 'run it', type: 'summary_text' }],
      },
      {
        id: 'ci_x',
        type: 'code_interpreter_call',
        status: 'completed',
        code: 'print(1)',
        // Live-observed: logs arrive EMPTY even on success — never parse them.
        outputs: [{ type: 'logs', logs: '' }],
      },
      {
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: msgText, logprobs: [], annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 1967,
      output_tokens: 247,
      total_tokens: 2214,
      num_server_side_tools_used: interpreterCalls,
      server_side_tool_usage_details: {
        web_search_calls: 0,
        x_search_calls: 0,
        code_interpreter_calls: interpreterCalls,
        file_search_calls: 0,
        mcp_calls: 0,
        document_search_calls: 0,
        image_generation_calls: 0,
      },
    },
    error: null,
  };
}

const OK_MSG =
  '<GRK_STDOUT>\nhello-out\n</GRK_STDOUT>\n<GRK_STDERR>\nhello-err\nValueError: boom-77\n</GRK_STDERR>';

function deps(payload: unknown, status = 200): GrokRunCodeDeps & { fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn(
    async () =>
      new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status }),
  );
  return { getAccessToken: async () => 'seat-token', fetchImpl: fetchImpl as unknown as typeof fetch } as never;
}

describe('runGrokCode', () => {
  it('rejects empty code with TypeError before any network call', async () => {
    const d = deps(proxyPayload(OK_MSG));
    await expect(runGrokCode('python', '   ', { deps: d })).rejects.toThrow(TypeError);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an invalid language tag with TypeError', async () => {
    const d = deps(proxyPayload(OK_MSG));
    await expect(runGrokCode('py thon;rm', 'print(1)', { deps: d })).rejects.toThrow(TypeError);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when the subscription proxy flag is OFF (never metered fallback)', async () => {
    process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'] = '0';
    const d = deps(proxyPayload(OK_MSG));
    const err = await runGrokCode('python', 'print(1)', { deps: d }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokRunCodeError);
    expect((err as GrokRunCodeError).errorClass).toBe('disabled');
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('throws relogin when no seat token is available', async () => {
    const d = deps(proxyPayload(OK_MSG));
    d.getAccessToken = async () => null;
    const err = await runGrokCode('python', 'print(1)', { deps: d }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokRunCodeError);
    expect((err as GrokRunCodeError).errorClass).toBe('relogin');
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('parses executed stdout/stderr from the delimited assistant message', async () => {
    const d = deps(proxyPayload(OK_MSG));
    const r = await runGrokCode('python', 'print("x")', { deps: d });
    expect(r.stdout).toBe('hello-out');
    expect(r.stderr).toBe('hello-err\nValueError: boom-77');
    expect(r.raw).toBe(OK_MSG);
    // Request contract: proxy URL + grok-cli headers + code_execution tool.
    const [url, init] = d.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/responses');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer seat-token');
    expect(headers['x-grok-client-identifier']).toBe('grok-shell');
    expect(headers['x-grok-client-version']).toBeTruthy();
    const body = JSON.parse(String(init.body)) as {
      tools: Array<{ type: string }>;
      input: Array<{ role: string; content: Array<{ text: string }> }>;
      stream: boolean;
    };
    expect(body.tools).toEqual([{ type: 'code_execution' }]);
    expect(body.stream).toBe(false);
    expect(body.input[1]?.content[0]?.text).toContain('print("x")');
  });

  it('returns empty stderr when the protocol stderr section is empty', async () => {
    const msg = '<GRK_STDOUT>\n42\n</GRK_STDOUT>\n<GRK_STDERR>\n\n</GRK_STDERR>';
    const r = await runGrokCode('python', 'print(6*7)', { deps: deps(proxyPayload(msg)) });
    expect(r.stdout).toBe('42');
    expect(r.stderr).toBe('');
  });

  it('rejects a reply with ZERO real interpreter calls (hallucination guard)', async () => {
    const err = await runGrokCode('python', 'print(1)', {
      deps: deps(proxyPayload(OK_MSG, 0)),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokRunCodeError);
    expect((err as GrokRunCodeError).errorClass).toBe('not_executed');
  });

  it('throws bad_response when the executed reply lacks the markers', async () => {
    const err = await runGrokCode('python', 'print(1)', {
      deps: deps(proxyPayload('sure, the answer is 42')),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokRunCodeError);
    expect((err as GrokRunCodeError).errorClass).toBe('bad_response');
  });

  it('throws bad_response on a non-JSON proxy body', async () => {
    const err = await runGrokCode('python', 'print(1)', {
      deps: deps('<html>nope</html>'),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokRunCodeError);
    expect((err as GrokRunCodeError).errorClass).toBe('bad_response');
  });

  it('throws http_error with status on a non-200 proxy reply', async () => {
    const err = await runGrokCode('python', 'print(1)', {
      deps: deps({ error: 'upstream' }, 426),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokRunCodeError);
    expect((err as GrokRunCodeError).errorClass).toBe('http_error');
    expect((err as GrokRunCodeError).message).toContain('426');
  });
});
