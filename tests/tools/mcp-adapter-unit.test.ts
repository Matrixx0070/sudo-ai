/**
 * mcp-adapter-unit.test.ts — F124 unit tests for the stdio/remote MCPAdapter class.
 *
 * The sibling suites (mcp-http, mcp-adapter-ssrf, mcp-streamable-http) cover
 * HTTPMCPAdapter / StreamableHTTPMCPAdapter / parseSSEMessages. This file pins
 * the previously-untested MCPAdapter class itself:
 *
 *  - connect() kill-switches + config validation (no transport ever opened)
 *  - stdio JSON-RPC plumbing via an injected fake child process:
 *    request framing, chunked stdout line reassembly, response dispatch,
 *    error mapping, listTools() name-prefixing/toolFilter, callTool()
 *    prefix-stripping + disabled-tool guard + content normalization
 *  - accessors: serverId, isConnected(), getCachedTools() copy semantics,
 *    getEnabledTools(), setToolEnabled()
 *  - HTTP transport callTool() via a mocked global fetch (payload shape,
 *    content normalization, JSON-RPC and HTTP error mapping)
 *
 * NO network, NO child processes: the stdio "process" is a hand-rolled fake
 * injected into the adapter's private field.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MCPAdapter, type MCPServerConfig } from '../../src/core/tools/mcp-adapter.js';

// ---------------------------------------------------------------------------
// Env hygiene
// ---------------------------------------------------------------------------

const ENV_KEYS = ['SUDO_MCP_DISABLE', 'SUDO_MCP_REMOTE_DISABLE', 'SUDO_MCP_OAUTH_DISABLE'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fake stdio harness
// ---------------------------------------------------------------------------

interface FakeProc {
  written: string[];
  stdin: { write(line: string): boolean } | null;
  kill(signal?: string): void;
  killed: string[];
}

function makeFakeProc(): FakeProc {
  const proc: FakeProc = {
    written: [],
    stdin: null,
    killed: [],
    kill(signal?: string) {
      proc.killed.push(signal ?? 'SIGTERM');
    },
  };
  proc.stdin = {
    write(line: string) {
      proc.written.push(line);
      return true;
    },
  };
  return proc;
}

/**
 * Build a stdio adapter with the fake process injected directly into the
 * private field (bypasses spawn entirely). Also returns helpers to read the
 * last JSON-RPC request written to "stdin" and to feed stdout chunks.
 */
function makeStdioAdapter(configOverrides: Partial<MCPServerConfig> = {}) {
  const adapter = new MCPAdapter({
    id: 'srv',
    transport: 'stdio',
    command: 'unused',
    ...configOverrides,
  });
  const proc = makeFakeProc();
  (adapter as unknown as { process: unknown }).process = proc;

  const lastRequest = (): { jsonrpc: string; id: string; method: string; params: unknown } =>
    JSON.parse(proc.written[proc.written.length - 1]!);

  const feed = (chunk: string): void => {
    (adapter as unknown as { _handleStdoutChunk(c: string): void })._handleStdoutChunk(chunk);
  };

  /** Reply to the most recent pending request with a result. */
  const replyResult = (result: unknown): void => {
    const req = lastRequest();
    feed(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
  };

  const replyError = (code: number, message: string): void => {
    const req = lastRequest();
    feed(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code, message } }) + '\n');
  };

  return { adapter, proc, lastRequest, feed, replyResult, replyError };
}

// ---------------------------------------------------------------------------
// connect() kill-switches + config validation
// ---------------------------------------------------------------------------

describe('MCPAdapter.connect() guards', () => {
  it('SUDO_MCP_DISABLE=1 rejects connect() for every transport', async () => {
    process.env['SUDO_MCP_DISABLE'] = '1';
    for (const transport of ['stdio', 'http', 'sse', 'websocket'] as const) {
      const adapter = new MCPAdapter({ id: 'x', transport, command: 'node', baseUrl: 'https://example.com' });
      await expect(adapter.connect()).rejects.toThrow('SUDO_MCP_DISABLE');
    }
  });

  it('stdio transport without command rejects with a config error', async () => {
    const adapter = new MCPAdapter({ id: 'nocmd', transport: 'stdio' });
    await expect(adapter.connect()).rejects.toThrow("'command' is required for stdio transport");
  });

  it('http transport without baseUrl rejects with a config error', async () => {
    const adapter = new MCPAdapter({ id: 'nohttp', transport: 'http' });
    await expect(adapter.connect()).rejects.toThrow("'baseUrl' is required for HTTP transport");
  });

  it('SUDO_MCP_REMOTE_DISABLE=1 rejects http/sse/websocket but is checked before baseUrl', async () => {
    process.env['SUDO_MCP_REMOTE_DISABLE'] = '1';
    for (const transport of ['http', 'sse', 'websocket'] as const) {
      const adapter = new MCPAdapter({ id: 'r', transport, baseUrl: 'https://example.com' });
      await expect(adapter.connect()).rejects.toThrow('SUDO_MCP_REMOTE_DISABLE');
    }
  });

  it('unknown transport rejects', async () => {
    const adapter = new MCPAdapter({ id: 'u', transport: 'carrier-pigeon' as never });
    await expect(adapter.connect()).rejects.toThrow('unknown transport carrier-pigeon');
  });
});

// ---------------------------------------------------------------------------
// Accessors + connection state
// ---------------------------------------------------------------------------

describe('MCPAdapter accessors', () => {
  it('serverId returns the configured id', () => {
    const adapter = new MCPAdapter({ id: 'my-server', transport: 'stdio', command: 'x' });
    expect(adapter.serverId).toBe('my-server');
  });

  it('isConnected() is false before connect for all transports', () => {
    for (const transport of ['stdio', 'http', 'sse', 'websocket'] as const) {
      const adapter = new MCPAdapter({ id: 'x', transport, baseUrl: 'https://example.com', command: 'x' });
      expect(adapter.isConnected()).toBe(false);
    }
  });

  it('http connect() establishes a session; disconnect() clears it', async () => {
    const adapter = new MCPAdapter({ id: 'h', transport: 'http', baseUrl: 'https://example.com' });
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('listTools()/callTool() throw when not connected', async () => {
    const adapter = new MCPAdapter({ id: 'nc', transport: 'http', baseUrl: 'https://example.com' });
    await expect(adapter.listTools()).rejects.toThrow('is not connected');
    await expect(adapter.callTool('t', {})).rejects.toThrow('is not connected');
  });
});

// ---------------------------------------------------------------------------
// stdio JSON-RPC plumbing (fake process)
// ---------------------------------------------------------------------------

describe('MCPAdapter stdio JSON-RPC (fake process)', () => {
  it('listTools() sends a tools/list request framed as one JSON line', async () => {
    const { adapter, proc, lastRequest, replyResult } = makeStdioAdapter();
    const p = adapter.listTools();
    // _send is synchronous — the request is already on "stdin".
    expect(proc.written).toHaveLength(1);
    expect(proc.written[0]!.endsWith('\n')).toBe(true);
    const req = lastRequest();
    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('tools/list');
    expect(typeof req.id).toBe('string');
    replyResult({ tools: [] });
    await expect(p).resolves.toEqual([]);
  });

  it('listTools() prefixes names with mcp__<id>__, defaults description/schema, applies toolFilter', async () => {
    const { adapter, replyResult } = makeStdioAdapter({
      id: 'gh',
      toolFilter: { off: false },
    });
    const p = adapter.listTools();
    replyResult({
      tools: [
        { name: 'search', description: 'find things', inputSchema: { type: 'object' } },
        { name: 'off' },
      ],
    });
    const tools = await p;
    expect(tools).toEqual([
      {
        name: 'mcp__gh__search',
        description: 'find things',
        inputSchema: { type: 'object' },
        serverId: 'gh',
        enabled: true,
      },
      {
        name: 'mcp__gh__off',
        description: 'MCP tool from gh',
        inputSchema: {},
        serverId: 'gh',
        enabled: false,
      },
    ]);
  });

  it('listTools() tolerates a result with no tools array', async () => {
    const { adapter, replyResult } = makeStdioAdapter();
    const p = adapter.listTools();
    replyResult({});
    await expect(p).resolves.toEqual([]);
  });

  it('getCachedTools() returns a fresh array copy after listTools()', async () => {
    const { adapter, replyResult } = makeStdioAdapter();
    const p = adapter.listTools();
    replyResult({ tools: [{ name: 'a' }] });
    await p;
    const cached = adapter.getCachedTools();
    expect(cached).toHaveLength(1);
    cached.pop();
    expect(adapter.getCachedTools()).toHaveLength(1);
  });

  it('setToolEnabled() toggles by RAW name; getEnabledTools() filters', async () => {
    const { adapter, replyResult } = makeStdioAdapter({ id: 's' });
    const p = adapter.listTools();
    replyResult({ tools: [{ name: 'a' }, { name: 'b' }] });
    await p;
    adapter.setToolEnabled('a', false);
    expect(adapter.getEnabledTools().map((t) => t.name)).toEqual(['mcp__s__b']);
    // Unknown raw name is a warn-level no-op, never a throw.
    expect(() => adapter.setToolEnabled('nope', true)).not.toThrow();
    adapter.setToolEnabled('a', true);
    expect(adapter.getEnabledTools()).toHaveLength(2);
  });

  it('callTool() strips the mcp__<id>__ prefix from the outgoing request', async () => {
    const { adapter, lastRequest, replyResult } = makeStdioAdapter({ id: 'gh' });
    const p = adapter.callTool('mcp__gh__search', { q: 'x' });
    const req = lastRequest();
    expect(req.method).toBe('tools/call');
    expect(req.params).toEqual({ name: 'search', arguments: { q: 'x' } });
    replyResult({ content: 'ok' });
    await expect(p).resolves.toEqual({ content: 'ok' });
  });

  it('callTool() passes a raw (un-prefixed) name through unchanged', async () => {
    const { adapter, lastRequest, replyResult } = makeStdioAdapter({ id: 'gh' });
    const p = adapter.callTool('search', {});
    expect((lastRequest().params as { name: string }).name).toBe('search');
    replyResult({ content: '' });
    await p;
  });

  it('callTool() rejects a tool disabled via setToolEnabled without sending anything', async () => {
    const { adapter, proc, replyResult } = makeStdioAdapter({ id: 's' });
    const p = adapter.listTools();
    replyResult({ tools: [{ name: 'a' }] });
    await p;
    adapter.setToolEnabled('a', false);
    const before = proc.written.length;
    await expect(adapter.callTool('mcp__s__a', {})).rejects.toThrow('Tool a is disabled on server s');
    expect(proc.written.length).toBe(before);
  });

  it('callTool() joins array-of-text content, JSON-stringifying non-text parts', async () => {
    const { adapter, replyResult } = makeStdioAdapter();
    const p = adapter.callTool('t', {});
    replyResult({
      content: [
        { type: 'text', text: 'line1' },
        { type: 'image', data: 'zz' },
        { type: 'text', text: 'line2' },
      ],
    });
    await expect(p).resolves.toEqual({
      content: 'line1\n{"type":"image","data":"zz"}\nline2',
    });
  });

  it('callTool() falls back to JSON.stringify of the whole result object', async () => {
    const { adapter, replyResult } = makeStdioAdapter();
    const p = adapter.callTool('t', {});
    replyResult({ weird: true });
    await expect(p).resolves.toEqual({ content: '{"weird":true}' });
  });

  it('callTool() maps a JSON-RPC error response to "MCP RPC error [code]: message"', async () => {
    const { adapter, replyError } = makeStdioAdapter();
    const p = adapter.callTool('t', {});
    replyError(-32000, 'boom');
    await expect(p).rejects.toThrow('MCP RPC error [-32000]: boom');
  });

  it('reassembles a response split across multiple stdout chunks', async () => {
    const { adapter, lastRequest, feed } = makeStdioAdapter();
    const p = adapter.callTool('t', {});
    const line = JSON.stringify({ jsonrpc: '2.0', id: lastRequest().id, result: { content: 'joined' } }) + '\n';
    feed(line.slice(0, 10));
    feed(line.slice(10, 25));
    feed(line.slice(25));
    await expect(p).resolves.toEqual({ content: 'joined' });
  });

  it('dispatches multiple responses arriving in one chunk (out of order)', async () => {
    const { adapter, proc, feed } = makeStdioAdapter();
    const p1 = adapter.callTool('a', {});
    const p2 = adapter.callTool('b', {});
    const id1 = JSON.parse(proc.written[0]!).id as string;
    const id2 = JSON.parse(proc.written[1]!).id as string;
    feed(
      JSON.stringify({ jsonrpc: '2.0', id: id2, result: { content: 'second' } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: id1, result: { content: 'first' } }) + '\n',
    );
    await expect(p1).resolves.toEqual({ content: 'first' });
    await expect(p2).resolves.toEqual({ content: 'second' });
  });

  it('ignores non-JSON stdout lines, blank lines, and responses with unknown ids', async () => {
    const { adapter, lastRequest, feed } = makeStdioAdapter();
    const p = adapter.callTool('t', {});
    feed('not json at all\n\n');
    feed(JSON.stringify({ jsonrpc: '2.0', id: 'no-such-request', result: 1 }) + '\n');
    // Server-initiated notification (no id) is also ignored.
    feed(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\n');
    feed(JSON.stringify({ jsonrpc: '2.0', id: lastRequest().id, result: { content: 'ok' } }) + '\n');
    await expect(p).resolves.toEqual({ content: 'ok' });
  });

  it('a synchronous stdin failure rejects the RPC immediately (no timeout wait)', async () => {
    const { adapter, proc } = makeStdioAdapter();
    proc.stdin = null; // pipe gone
    await expect(adapter.callTool('t', {})).rejects.toThrow('process stdin unavailable');
  });

  it('disconnect() rejects in-flight requests and kills the child with SIGTERM', async () => {
    const { adapter, proc } = makeStdioAdapter();
    const p = adapter.callTool('t', {});
    await adapter.disconnect();
    await expect(p).rejects.toThrow('MCP adapter disconnected');
    expect(proc.killed).toContain('SIGTERM');
    expect(adapter.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP transport callTool() via mocked fetch
// ---------------------------------------------------------------------------

describe('MCPAdapter http transport callTool() (mocked fetch)', () => {
  function makeHttpAdapter(accessToken?: string) {
    return new MCPAdapter({ id: 'web', transport: 'http', baseUrl: 'https://mcp.example.com', accessToken });
  }

  it('POSTs a JSON-RPC tools/call to <baseUrl>/rpc with bearer auth and normalizes string content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { content: 'hello' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = makeHttpAdapter('tok-123');
    await adapter.connect();
    const res = await adapter.callTool('mcp__web__echo', { msg: 'hi' });
    expect(res).toEqual({ content: 'hello' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://mcp.example.com/rpc');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer tok-123');
    const body = JSON.parse(init.body as string);
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'echo', arguments: { msg: 'hi' } });
  });

  it('omits the Authorization header when no token is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { content: '' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = makeHttpAdapter();
    await adapter.connect();
    await adapter.callTool('echo', {});
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers['Authorization']).toBeUndefined();
  });

  it('maps a JSON-RPC error body to "MCP RPC error [code]: message"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'no such method' } }),
        { status: 200 },
      ),
    ));
    const adapter = makeHttpAdapter();
    await adapter.connect();
    await expect(adapter.callTool('echo', {})).rejects.toThrow('MCP RPC error [-32601]: no such method');
  });

  it('maps a non-2xx HTTP status to "HTTP RPC failed"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const adapter = makeHttpAdapter();
    await adapter.connect();
    await expect(adapter.callTool('echo', {})).rejects.toThrow('HTTP RPC failed: HTTP 500');
  });

  it('a 401 without an OAuth client is NOT retried — surfaces as HTTP RPC failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = makeHttpAdapter('expired');
    await adapter.connect();
    await expect(adapter.callTool('echo', {})).rejects.toThrow('HTTP RPC failed: HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('listTools over http transport (dead-path fix)', () => {
  it('routes tools/list through _httpRpc instead of throwing "_send not used"', async () => {
    const { MCPAdapter } = await import('../../src/core/tools/mcp-adapter.js');
    const adapter = new MCPAdapter({ id: 'http-list', transport: 'http', baseUrl: 'http://mcp.example' });
    (adapter as unknown as { connected: boolean }).connected = true;
    (adapter as unknown as { httpSession: unknown }).httpSession = { baseUrl: 'http://mcp.example', headers: {} };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'ping', description: 'p' }] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const tools = await adapter.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('mcp__http-list__ping');
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
