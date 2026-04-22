/**
 * mcp-http.test.ts — Unit tests for HTTPMCPAdapter (HTTP transport for MCP).
 *
 * Tests:
 *   1. listTools() parses valid JSON-RPC tools/list response correctly          (1 test)
 *   2. listTools() caches parsed tools; getCachedTools() returns them           (1 test)
 *   3. listTools() throws on JSON-RPC error response                            (1 test)
 *   4. listTools() throws on non-2xx HTTP status                                (1 test)
 *   5. listTools() AbortController fires after 15s fake-timer advance           (1 test)
 *   6. callTool() sends proper JSON-RPC tools/call payload                      (1 test)
 *   7. callTool() normalises string content response                            (1 test)
 *   8. callTool() normalises array-of-text content response                     (1 test)
 *   9. callTool() normalises result-object fallback content                     (1 test)
 *  10. callTool() strips mcp__<serverId>__ prefix before sending                (1 test)
 *  11. callTool() throws on JSON-RPC error response                             (1 test)
 *  12. callTool() AbortController fires after 30s fake-timer advance            (1 test)
 *  13. Constructor throws on empty id                                           (1 test)
 *  14. Constructor throws on empty baseUrl                                      (1 test)
 *  15. serverId getter returns configured id                                    (1 test)
 *  16. connect() and disconnect() are no-ops (resolve without error)            (1 test)
 *  17. SSRF: constructor throws for cloud metadata IP 169.254.169.254           (1 test)
 *  18. SSRF: constructor throws for file:// protocol                            (1 test)
 *  19. SSRF: SUDO_MCP_ALLOW_PRIVATE_HOSTS=1 bypasses SSRF guard for localhost   (1 test)
 *  20. DoS: listTools() throws when response body exceeds 10 MB cap             (1 test)
 *
 * Total: 20 tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock logger — suppress noise
// ---------------------------------------------------------------------------

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { HTTPMCPAdapter } from '../../src/core/tools/mcp-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides: Partial<{ id: string; baseUrl: string }> = {}) {
  return new HTTPMCPAdapter({
    id: overrides.id ?? 'test-server',
    transport: 'http',
    baseUrl: overrides.baseUrl ?? 'http://localhost:9999',
  });
}

/** Build a JSON-RPC 2.0 tools/list success response. */
function toolsListResponse(tools: Array<{ name: string; description?: string }>) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? `Tool ${t.name}`,
        inputSchema: { type: 'object', properties: {} },
      })),
    },
  };
}

/** Build a JSON-RPC 2.0 tools/call success response. */
function toolsCallResponse(content: unknown) {
  return { jsonrpc: '2.0', id: 1, result: { content } };
}

/** Build a JSON-RPC 2.0 error response. */
function rpcErrorResponse(code: number, message: string) {
  return { jsonrpc: '2.0', id: 1, error: { code, message } };
}

/** Stub global fetch to return a resolved Response with given JSON body. */
function stubFetch(body: unknown, status = 200) {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HTTPMCPAdapter', () => {
  beforeEach(() => {
    // Allow localhost in all existing tests — the SSRF guard blocks private IPs
    // unless this env var is set. The makeAdapter() default is localhost:9999.
    // NOTE: 'localhost' as a hostname does NOT match the PRIVATE_IP_RE (which
    // checks numeric IPs only). This env var is set here as belt-and-suspenders
    // to protect against future regex extensions.
    process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'] = '1';
  });

  afterEach(() => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Constructor validation
  // -------------------------------------------------------------------------

  describe('constructor validation', () => {
    it('13. throws on empty id', () => {
      expect(
        () =>
          new HTTPMCPAdapter({
            id: '',
            transport: 'http',
            baseUrl: 'http://localhost:9999',
          }),
      ).toThrow('config.id must be a non-empty string');
    });

    it('14. throws on empty baseUrl', () => {
      expect(
        () =>
          new HTTPMCPAdapter({
            id: 'srv',
            transport: 'http',
            baseUrl: '',
          }),
      ).toThrow('config.baseUrl must be a non-empty string');
    });

    it('15. serverId getter returns configured id', () => {
      const adapter = makeAdapter({ id: 'my-server' });
      expect(adapter.serverId).toBe('my-server');
    });

    // -----------------------------------------------------------------------
    // SSRF protection (Fix 1)
    // -----------------------------------------------------------------------

    it('17. SSRF: throws for cloud-metadata IP 169.254.169.254', () => {
      // Ensure the env var is NOT set for this test so the guard fires.
      delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
      expect(
        () =>
          new HTTPMCPAdapter({
            id: 'ssrf-test',
            transport: 'http',
            baseUrl: 'http://169.254.169.254/rpc',
          }),
      ).toThrow('SSRF protection');
    });

    it('18. SSRF: throws for file:// protocol', () => {
      delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
      expect(
        () =>
          new HTTPMCPAdapter({
            id: 'file-test',
            transport: 'http',
            baseUrl: 'file:///etc/passwd',
          }),
      ).toThrow('unsupported protocol');
    });

    it('19. SSRF: SUDO_MCP_ALLOW_PRIVATE_HOSTS=1 allows 127.0.0.1 (loopback dev bypass)', () => {
      // beforeEach already sets SUDO_MCP_ALLOW_PRIVATE_HOSTS=1
      expect(
        () =>
          new HTTPMCPAdapter({
            id: 'loopback-dev',
            transport: 'http',
            baseUrl: 'http://127.0.0.1:9999',
          }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // No-op lifecycle
  // -------------------------------------------------------------------------

  describe('lifecycle stubs', () => {
    it('16. connect() and disconnect() resolve without error', async () => {
      const adapter = makeAdapter();
      await expect(adapter.connect()).resolves.toBeUndefined();
      await expect(adapter.disconnect()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listTools()
  // -------------------------------------------------------------------------

  describe('listTools()', () => {
    it('1. parses valid JSON-RPC tools/list response', async () => {
      stubFetch(toolsListResponse([{ name: 'greet' }, { name: 'echo' }]));

      const adapter = makeAdapter();
      const tools = await adapter.listTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('mcp__test-server__greet');
      expect(tools[0].serverId).toBe('test-server');
      expect(tools[1].name).toBe('mcp__test-server__echo');
    });

    it('2. getCachedTools() returns tools after listTools()', async () => {
      stubFetch(toolsListResponse([{ name: 'ping' }]));

      const adapter = makeAdapter();
      expect(adapter.getCachedTools()).toHaveLength(0);

      await adapter.listTools();

      const cached = adapter.getCachedTools();
      expect(cached).toHaveLength(1);
      expect(cached[0].name).toBe('mcp__test-server__ping');
    });

    it('3. throws on JSON-RPC error response', async () => {
      stubFetch(rpcErrorResponse(-32601, 'Method not found'));

      const adapter = makeAdapter();
      await expect(adapter.listTools()).rejects.toThrow('MCP RPC error [-32601]: Method not found');
    });

    it('4. throws on non-2xx HTTP status', async () => {
      stubFetch({}, 503);

      const adapter = makeAdapter();
      await expect(adapter.listTools()).rejects.toThrow('HTTP 503');
    });

    it('5. AbortController fires after 15s fake-timer advance', async () => {
      vi.useFakeTimers();

      // fetch never resolves — simulates hung connection
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          });
        }),
      );

      const adapter = makeAdapter();
      const promise = adapter.listTools();

      // Advance past the 15s timeout
      vi.advanceTimersByTime(15_001);

      await expect(promise).rejects.toThrow();
    });

    // -----------------------------------------------------------------------
    // Response body size cap (Fix 2)
    // -----------------------------------------------------------------------

    it('20. DoS: listTools() throws when response body exceeds 10 MB cap', async () => {
      // Use a ReadableStream that produces 11 MB in one chunk so the streaming
      // reader's cap check fires without allocating a 10 MB literal in the test.
      const oversized = new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new Uint8Array(11 * 1024 * 1024));
            ctrl.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(oversized));

      const adapter = makeAdapter();
      await expect(adapter.listTools()).rejects.toThrow('exceeds');
    });
  });

  // -------------------------------------------------------------------------
  // callTool()
  // -------------------------------------------------------------------------

  describe('callTool()', () => {
    it('6. sends proper JSON-RPC tools/call payload', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(toolsCallResponse('ok')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const adapter = makeAdapter();
      await adapter.callTool('run', { x: 1 });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9999/rpc');

      const body = JSON.parse(init.body as string) as {
        jsonrpc: string;
        method: string;
        params: { name: string; arguments: Record<string, unknown> };
      };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('tools/call');
      expect(body.params.name).toBe('run');
      expect(body.params.arguments).toEqual({ x: 1 });
    });

    it('7. normalises string content response', async () => {
      stubFetch(toolsCallResponse('hello world'));

      const adapter = makeAdapter();
      const result = await adapter.callTool('greet', {});
      expect(result.content).toBe('hello world');
    });

    it('8. normalises array-of-text content response', async () => {
      stubFetch(
        toolsCallResponse([
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ]),
      );

      const adapter = makeAdapter();
      const result = await adapter.callTool('multi', {});
      expect(result.content).toBe('line one\nline two');
    });

    it('9. normalises result-object fallback content', async () => {
      stubFetch({ jsonrpc: '2.0', id: 1, result: { status: 'done', value: 42 } });

      const adapter = makeAdapter();
      const result = await adapter.callTool('compute', {});
      expect(result.content).toContain('done');
    });

    it('10. strips mcp__<serverId>__ prefix before sending', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(toolsCallResponse('ok')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const adapter = makeAdapter({ id: 'my-srv' });
      await adapter.callTool('mcp__my-srv__tool-name', {});

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        params: { name: string };
      };
      expect(body.params.name).toBe('tool-name');
    });

    it('11. throws on JSON-RPC error response', async () => {
      stubFetch(rpcErrorResponse(-32600, 'Invalid request'));

      const adapter = makeAdapter();
      await expect(adapter.callTool('bad', {})).rejects.toThrow(
        'MCP RPC error [-32600]: Invalid request',
      );
    });

    it('12. AbortController fires after 30s fake-timer advance', async () => {
      vi.useFakeTimers();

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          });
        }),
      );

      const adapter = makeAdapter();
      const promise = adapter.callTool('slow', {});

      vi.advanceTimersByTime(30_001);

      await expect(promise).rejects.toThrow();
    });
  });
});
