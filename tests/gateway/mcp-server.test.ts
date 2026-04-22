/**
 * @file mcp-server.test.ts
 * @description MCP Loopback Server test suite — 16 tests minimum.
 *
 * Uses PassThrough streams to avoid spawning child processes.
 * All tests run in-process for speed and determinism.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { createMCPServer } from '../../src/core/gateway/mcp-server.js';
import type { MCPLoopbackServer, MCPServerOptions } from '../../src/core/gateway/mcp-server.js';
import type { ToolRegistry } from '../../src/core/tools/registry.js';
import type { HookManager } from '../../src/core/hooks/index.js';
import type { ToolDefinition, ToolResult } from '../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-secret-token-1234';
const TEST_TOKEN_WRONG = 'wrong-token-xyz';

/**
 * Minimal ToolDefinition factory for tests.
 */
function makeTool(
  name: string,
  safety: 'readonly' | 'destructive' = 'readonly',
  result: ToolResult = { success: true, output: `result of ${name}` },
): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    category: 'system',
    safety,
    parameters: {
      input: { type: 'string', description: 'Input string', required: false },
    },
    execute: vi.fn().mockResolvedValue(result),
  };
}

/**
 * Build a mock ToolRegistry with the given tools.
 */
function makeRegistry(tools: ToolDefinition[]): ToolRegistry {
  const map = new Map(tools.map((t) => [t.name, t]));
  return {
    get: (name: string) => map.get(name),
    listAll: () => [...map.values()],
    listEnabled: () => [...map.values()],
    execute: vi.fn(async (name: string, params: Record<string, unknown>) => {
      const tool = map.get(name);
      if (!tool) throw new Error(`Tool not found: ${name}`);
      return tool.execute(params, { sessionId: 'test', workingDir: '/', config: {}, logger: {} });
    }),
  } as unknown as ToolRegistry;
}

/**
 * Build a mock HookManager that records emitted events.
 */
function makeHooks(): HookManager & { emitted: Array<{ event: string; ctx: unknown }> } {
  const emitted: Array<{ event: string; ctx: unknown }> = [];
  return {
    emitted,
    emit: vi.fn(async (event: string, ctx: unknown) => {
      emitted.push({ event, ctx });
    }),
    register: vi.fn(),
    unregister: vi.fn(),
    listHooks: vi.fn().mockReturnValue([]),
    get size() { return 0; },
  } as unknown as HookManager & { emitted: Array<{ event: string; ctx: unknown }> };
}

/**
 * Creates server with injected stdin/stdout streams.
 * Returns helpers for sending requests and collecting responses.
 */
async function createTestServer(
  registryTools: ToolDefinition[],
  opts: Partial<MCPServerOptions> & { exposedTools?: string } = {},
  hooks?: HookManager,
): Promise<{
  server: MCPLoopbackServer;
  stdin: PassThrough;
  stdout: PassThrough;
  send: (req: unknown) => void;
  nextResponse: () => Promise<unknown>;
  teardown: () => Promise<void>;
}> {
  const registry = makeRegistry(registryTools);
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const token = opts.token ?? TEST_TOKEN;
  const server = createMCPServer({
    transport: 'stdio',
    token,
    exposedTools: opts.exposedTools,
    registry,
    hooks,
  });

  // Patch start() to use our injected streams instead of process.stdin/stdout.
  // We test internal dispatch via a helper that directly calls dispatchLine.
  // Since dispatchLine is internal, we test via the public contract:
  // write to stdin PassThrough → readline reads it → server writes response to stdout.
  const responses: unknown[] = [];
  let resolveNext: ((v: unknown) => void) | null = null;

  // Accumulate lines from stdout.
  let buf = '';
  stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (resolveNext) {
          const resolve = resolveNext;
          resolveNext = null;
          resolve(parsed);
        } else {
          responses.push(parsed);
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  });

  function send(req: unknown): void {
    stdin.write(JSON.stringify(req) + '\n');
  }

  function nextResponse(): Promise<unknown> {
    if (responses.length > 0) {
      return Promise.resolve(responses.shift());
    }
    return new Promise<unknown>((resolve) => {
      resolveNext = resolve;
    });
  }

  // Override the server start to use injected streams.
  // We do this by calling a patched version.
  await startWithStreams(server, stdin, stdout);

  async function teardown(): Promise<void> {
    await server.stop();
    stdin.destroy();
    stdout.destroy();
  }

  return { server, stdin, stdout, send, nextResponse, teardown };
}

/**
 * Starts the server using injected streams instead of process.stdin/stdout.
 * This is done by temporarily replacing process.stdin/stdout.
 * A cleaner approach uses readline directly.
 */
async function startWithStreams(
  server: MCPLoopbackServer,
  stdin: PassThrough,
  stdout: PassThrough,
): Promise<void> {
  // We patch process.stdin and process.stdout for the duration of start().
  // Since vitest runs in Node, we can temporarily reassign them.
  const origStdin = process.stdin;
  const origStdout = process.stdout;

  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });

  try {
    await server.start();
  } finally {
    Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true });
  }
}

// ---------------------------------------------------------------------------
// Initialization requests
// ---------------------------------------------------------------------------

function initRequest(token: string | undefined, id = 1): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0', token },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMCPServer', () => {
  it('throws when SUDO_MCP_TOKEN is absent', () => {
    expect(() =>
      createMCPServer({
        transport: 'stdio',
        token: '',
        registry: makeRegistry([]),
      }),
    ).toThrow('SUDO_MCP_TOKEN is not set');
  });

  it('returns a server instance with isRunning=false when token is valid', () => {
    const server = createMCPServer({
      transport: 'stdio',
      token: TEST_TOKEN,
      registry: makeRegistry([]),
    });
    expect(server.isRunning).toBe(false);
  });
});

describe('initialize handshake', () => {
  let ctx: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    ctx = await createTestServer([makeTool('test.read')]);
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it('accepts a valid token and returns server info', async () => {
    ctx.send(initRequest(TEST_TOKEN, 1));
    const res = await ctx.nextResponse() as Record<string, unknown>;
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: expect.objectContaining({
        serverInfo: expect.objectContaining({ name: 'sudo-ai-mcp' }),
      }),
    });
    expect(res['error']).toBeUndefined();
  });

  it('rejects an invalid token with error -32600', async () => {
    ctx.send(initRequest(TEST_TOKEN_WRONG, 2));
    const res = await ctx.nextResponse() as Record<string, unknown>;
    expect(res).toMatchObject({ jsonrpc: '2.0', id: 2 });
    const error = res['error'] as Record<string, unknown>;
    expect(error['code']).toBe(-32600);
  });

  it('rejects a missing token with error -32600', async () => {
    ctx.send(initRequest(undefined, 3));
    const res = await ctx.nextResponse() as Record<string, unknown>;
    const error = res['error'] as Record<string, unknown>;
    expect(error['code']).toBe(-32600);
  });
});

describe('tools/list before initialize', () => {
  let ctx: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    ctx = await createTestServer([makeTool('test.read')]);
  });

  afterEach(async () => { await ctx.teardown(); });

  it('rejects tools/list before initialize with -32600', async () => {
    ctx.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    const res = await ctx.nextResponse() as Record<string, unknown>;
    const error = res['error'] as Record<string, unknown>;
    expect(error['code']).toBe(-32600);
  });
});

describe('tools/list after initialize', () => {
  let ctx: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    ctx = await createTestServer([
      makeTool('test.read', 'readonly'),
      makeTool('test.destroy', 'destructive'),
    ]);
  });

  afterEach(async () => { await ctx.teardown(); });

  it('returns only readonly tools when SUDO_MCP_EXPOSE_TOOLS is empty', async () => {
    ctx.send(initRequest(TEST_TOKEN, 1));
    await ctx.nextResponse(); // init response

    ctx.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const res = await ctx.nextResponse() as Record<string, unknown>;
    const result = res['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain('test.read');
    expect(names).not.toContain('test.destroy');
  });
});

describe('tools/list with explicit allowlist', () => {
  it('returns exactly the named tools (including destructive) when SUDO_MCP_EXPOSE_TOOLS is set', async () => {
    const ctx = await createTestServer(
      [makeTool('test.read', 'readonly'), makeTool('test.destroy', 'destructive')],
      { exposedTools: 'test.destroy' },
    );
    ctx.send(initRequest(TEST_TOKEN, 1));
    await ctx.nextResponse();

    ctx.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const res = await ctx.nextResponse() as Record<string, unknown>;
    const result = res['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain('test.destroy');
    expect(names).not.toContain('test.read');
    await ctx.teardown();
  });
});

describe('tools/call', () => {
  let ctx: Awaited<ReturnType<typeof createTestServer>>;
  let hooks: ReturnType<typeof makeHooks>;

  beforeEach(async () => {
    hooks = makeHooks();
    ctx = await createTestServer(
      [
        makeTool('test.read', 'readonly', { success: true, output: 'file contents' }),
        makeTool('test.destroy', 'destructive'),
        makeTool('system.shell-exec', 'destructive'),
      ],
      {},
      hooks,
    );
    ctx.send(initRequest(TEST_TOKEN, 1));
    await ctx.nextResponse(); // consume init response
  });

  afterEach(async () => { await ctx.teardown(); });

  it('calls registry.execute and returns content on success', async () => {
    ctx.send({
      jsonrpc: '2.0', id: 10,
      method: 'tools/call',
      params: { name: 'test.read', arguments: {} },
    });
    const res = await ctx.nextResponse() as Record<string, unknown>;
    expect(res['error']).toBeUndefined();
    const result = res['result'] as Record<string, unknown>;
    const content = result['content'] as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('file contents');
  });

  it('emits mcp:tool-call hook with correct toolName', async () => {
    ctx.send({
      jsonrpc: '2.0', id: 11,
      method: 'tools/call',
      params: { name: 'test.read', arguments: {} },
    });
    await ctx.nextResponse();
    const hookCall = hooks.emitted.find((e) => e.event === 'mcp:tool-call');
    expect(hookCall).toBeDefined();
    expect((hookCall?.ctx as Record<string, unknown>)['toolName']).toBe('test.read');
  });

  it('returns -32601 for an unknown tool', async () => {
    ctx.send({
      jsonrpc: '2.0', id: 12,
      method: 'tools/call',
      params: { name: 'nonexistent.tool', arguments: {} },
    });
    const res = await ctx.nextResponse() as Record<string, unknown>;
    const error = res['error'] as Record<string, unknown>;
    expect(error['code']).toBe(-32601);
  });

  it('returns isError:true and no stack when tool throws', async () => {
    // Override execute to throw.
    const throwingTool = makeTool('test.thrower', 'readonly');
    (throwingTool.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('internal error with secret /etc/passwd path'),
    );
    const reg = makeRegistry([throwingTool]);
    const ctx2 = await createTestServer([throwingTool], {}, hooks);
    ctx2.send(initRequest(TEST_TOKEN, 1));
    await ctx2.nextResponse();
    ctx2.send({
      jsonrpc: '2.0', id: 20,
      method: 'tools/call',
      params: { name: 'test.thrower', arguments: {} },
    });
    const res = await ctx2.nextResponse() as Record<string, unknown>;
    // No JSON-RPC error — returned as content with isError
    expect(res['error']).toBeUndefined();
    const result = res['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
    const content = result['content'] as Array<{ text: string }>;
    // Must not leak internal paths
    expect(content[0].text).not.toContain('/etc/passwd');
    expect(content[0].text).toBe('Tool execution failed');
    await ctx2.teardown();
    void reg; // suppress unused warning
  });

  it('returns -32601 for a destructive tool not in allowlist', async () => {
    ctx.send({
      jsonrpc: '2.0', id: 13,
      method: 'tools/call',
      params: { name: 'test.destroy', arguments: {} },
    });
    const res = await ctx.nextResponse() as Record<string, unknown>;
    const error = res['error'] as Record<string, unknown>;
    expect(error['code']).toBe(-32601);
  });

  it('rejects tools/call with wrong token after re-auth attempt fails', async () => {
    // Simulate: send a fresh initialize with wrong token, then call a tool.
    // The server should still be authenticated from the valid init.
    // But if we had a second server instance with wrong token:
    const ctx2 = await createTestServer([makeTool('test.read')], { token: TEST_TOKEN });
    ctx2.send(initRequest(TEST_TOKEN_WRONG, 1));
    const initRes = await ctx2.nextResponse() as Record<string, unknown>;
    // Init with wrong token is rejected.
    expect((initRes['error'] as Record<string, unknown>)['code']).toBe(-32600);
    // Server is NOT authenticated. tools/call should get -32600.
    ctx2.send({
      jsonrpc: '2.0', id: 2,
      method: 'tools/call',
      params: { name: 'test.read', arguments: {} },
    });
    const res = await ctx2.nextResponse() as Record<string, unknown>;
    const error = res['error'] as Record<string, unknown>;
    expect(error['code']).toBe(-32600);
    await ctx2.teardown();
  });

  it('returns -32602 for invalid params (required param missing)', async () => {
    // Tool with a required param.
    const strictTool: ToolDefinition = {
      name: 'test.strict',
      description: 'Strict tool',
      category: 'system',
      safety: 'readonly',
      parameters: {
        required_param: { type: 'string', description: 'Required', required: true },
      },
      execute: vi.fn().mockResolvedValue({ success: true, output: 'ok' }),
    };
    const ctx2 = await createTestServer([strictTool]);
    ctx2.send(initRequest(TEST_TOKEN, 1));
    await ctx2.nextResponse();
    ctx2.send({
      jsonrpc: '2.0', id: 2,
      method: 'tools/call',
      params: { name: 'test.strict', arguments: {} },
    });
    const res = await ctx2.nextResponse() as Record<string, unknown>;
    const error = res['error'] as Record<string, unknown>;
    expect(error['code']).toBe(-32602);
    await ctx2.teardown();
  });
});

describe('stdio framing', () => {
  it('handles malformed JSON without crashing the server', async () => {
    const ctx = await createTestServer([makeTool('test.read')]);

    // Send garbage first.
    ctx.stdin.write('{ this is not json }\n');
    const parseErrRes = await ctx.nextResponse() as Record<string, unknown>;
    const error = parseErrRes['error'] as Record<string, unknown>;
    expect(error['code']).toBe(-32700);

    // Server should still be alive and respond to valid requests.
    ctx.send(initRequest(TEST_TOKEN, 1));
    const initRes = await ctx.nextResponse() as Record<string, unknown>;
    expect(initRes['result']).toBeDefined();

    await ctx.teardown();
  });

  it('server isRunning becomes false after stop()', async () => {
    const ctx = await createTestServer([]);
    expect(ctx.server.isRunning).toBe(true);
    await ctx.server.stop();
    expect(ctx.server.isRunning).toBe(false);
    ctx.stdin.destroy();
    ctx.stdout.destroy();
  });
});

describe('shell-exec double gate', () => {
  it('does NOT expose system.shell-exec even if SUDO_MCP_EXPOSE_TOOLS names it (no SUDO_MCP_ALLOW_SHELL)', async () => {
    const origEnv = process.env['SUDO_MCP_ALLOW_SHELL'];
    delete process.env['SUDO_MCP_ALLOW_SHELL'];

    const shellTool = makeTool('system.shell-exec', 'destructive');
    const ctx = await createTestServer([shellTool], { exposedTools: 'system.shell-exec' });
    ctx.send(initRequest(TEST_TOKEN, 1));
    await ctx.nextResponse();

    ctx.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const res = await ctx.nextResponse() as Record<string, unknown>;
    const result = res['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('system.shell-exec');

    if (origEnv !== undefined) process.env['SUDO_MCP_ALLOW_SHELL'] = origEnv;
    await ctx.teardown();
  });

  it('exposes system.shell-exec when BOTH in allowlist AND SUDO_MCP_ALLOW_SHELL=1', async () => {
    const origEnv = process.env['SUDO_MCP_ALLOW_SHELL'];
    process.env['SUDO_MCP_ALLOW_SHELL'] = '1';

    const shellTool = makeTool('system.shell-exec', 'destructive');
    const ctx = await createTestServer([shellTool], { exposedTools: 'system.shell-exec' });
    ctx.send(initRequest(TEST_TOKEN, 1));
    await ctx.nextResponse();

    ctx.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const res = await ctx.nextResponse() as Record<string, unknown>;
    const result = res['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain('system.shell-exec');

    if (origEnv !== undefined) process.env['SUDO_MCP_ALLOW_SHELL'] = origEnv;
    else delete process.env['SUDO_MCP_ALLOW_SHELL'];
    await ctx.teardown();
  });
});

describe('prompts/list and resources/list stubs', () => {
  it('returns empty prompts list', async () => {
    const ctx = await createTestServer([]);
    ctx.send(initRequest(TEST_TOKEN, 1));
    await ctx.nextResponse();
    ctx.send({ jsonrpc: '2.0', id: 2, method: 'prompts/list' });
    const res = await ctx.nextResponse() as Record<string, unknown>;
    expect(res['result']).toMatchObject({ prompts: [] });
    await ctx.teardown();
  });

  it('returns empty resources list', async () => {
    const ctx = await createTestServer([]);
    ctx.send(initRequest(TEST_TOKEN, 1));
    await ctx.nextResponse();
    ctx.send({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    const res = await ctx.nextResponse() as Record<string, unknown>;
    expect(res['result']).toMatchObject({ resources: [] });
    await ctx.teardown();
  });
});
