/**
 * Tests for the MCP Streamable HTTP transport and the mcp.connect /
 * mcp.list / mcp.disconnect connector tools.
 *
 * Real remote MCP servers (GitHub's https://api.githubcopilot.com/mcp/)
 * speak the Streamable HTTP spec: JSON-RPC POSTed to the endpoint itself,
 * initialize handshake, Authorization bearer, Mcp-Session-Id, responses
 * optionally SSE-framed. The legacy HTTPMCPAdapter's homegrown
 * `POST ${baseUrl}/rpc` shape gets 401/404 from all of them (proven live
 * against GitHub). The adapter here is driven end-to-end against an
 * in-process mock server implementing the spec shapes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// DATA_DIR is captured at module load (shared/paths.ts) — point it at a temp
// dir BEFORE any src import evaluates so connector persistence lands there.
const TMP_DATA_DIR = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-conn-data-'));
  process.env['DATA_DIR'] = dir;
  return dir;
});
import {
  StreamableHTTPMCPAdapter,
  parseSSEMessages,
} from '../../src/core/tools/mcp-adapter.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolContext } from '../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// parseSSEMessages (unit)
// ---------------------------------------------------------------------------

describe('parseSSEMessages', () => {
  it('extracts JSON-RPC messages from event frames', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(parseSSEMessages(body)).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  });

  it('handles multiple events, CRLF framing, and multi-data-line events', () => {
    const body =
      'data: {"id":1}\r\n\r\n' +
      'event: message\ndata: {"id":2,\ndata:  "a":3}\n\n' + // joined with \n → {"id":2,\n "a":3}
      ': keep-alive comment\n\n' +
      'data: not-json\n\n';
    expect(parseSSEMessages(body)).toEqual([{ id: 1 }, { id: 2, a: 3 }]);
  });

  it('returns empty for empty or non-SSE bodies', () => {
    expect(parseSSEMessages('')).toEqual([]);
    expect(parseSSEMessages('{"id":1}')).toEqual([]); // no data: prefix
  });
});

// ---------------------------------------------------------------------------
// Mock Streamable HTTP MCP server
// ---------------------------------------------------------------------------

interface MockState {
  requests: Array<{ method: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }>;
  sse: boolean;
  requireToken: string | null;
  deleted: boolean;
}

function startMockServer(state: MockState): Promise<{ server: Server; url: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      if (req.method === 'DELETE') {
        state.deleted = true;
        res.writeHead(204).end();
        return;
      }
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const rpcMethod = body['method'] as string;
      state.requests.push({ method: rpcMethod, headers: { ...req.headers }, body });

      if (state.requireToken && req.headers['authorization'] !== `Bearer ${state.requireToken}`) {
        res.writeHead(401).end('missing or bad token');
        return;
      }

      // Notifications get 202 + no body (spec).
      if (body['id'] === undefined) {
        res.writeHead(202).end();
        return;
      }

      let result: Record<string, unknown>;
      if (rpcMethod === 'initialize') {
        result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock' } };
      } else if (rpcMethod === 'tools/list') {
        const cursor = (body['params'] as Record<string, unknown>)?.['cursor'];
        result = cursor === 'page2'
          ? { tools: [{ name: 'echo_two', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } }] }
          : {
              tools: [{ name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } }],
              nextCursor: 'page2',
            };
      } else if (rpcMethod === 'tools/call') {
        const params = body['params'] as { name: string; arguments: Record<string, unknown> };
        if (params.name === 'boom') {
          result = { content: [{ type: 'text', text: 'tool exploded' }], isError: true };
        } else {
          result = { content: [{ type: 'text', text: JSON.stringify({ got: params.arguments, typeofN: typeof params.arguments['n'] }) }] };
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body['id'], error: { code: -32601, message: 'unknown method' } }));
        return;
      }

      const reply = JSON.stringify({ jsonrpc: '2.0', id: body['id'], result });
      if (state.sse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sess-123' });
        // Interleave a server notification before the response — client must skip it.
        res.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${reply}\n\n`);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-123' });
        res.end(reply);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}/mcp` });
    });
  });
}

describe('StreamableHTTPMCPAdapter (vs in-process spec server)', () => {
  const state: MockState = { requests: [], sse: true, requireToken: 'tok-abc', deleted: false };
  let server: Server;
  let url = '';

  beforeAll(async () => {
    process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'] = '1';
    ({ server, url } = await startMockServer(state));
  });
  afterAll(() => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    server.close();
  });
  beforeEach(() => {
    state.requests = [];
    state.sse = true;
    state.deleted = false;
  });

  it('performs the full lifecycle: initialize → initialized → paginated list → SSE-framed call → DELETE', async () => {
    const adapter = new StreamableHTTPMCPAdapter({ id: 'mock', url, accessToken: 'tok-abc' });
    await adapter.connect();

    // Handshake order + headers.
    expect(state.requests.map((r) => r.method)).toEqual(['initialize', 'notifications/initialized']);
    const init = state.requests[0]!;
    expect(init.headers['authorization']).toBe('Bearer tok-abc');
    expect(init.headers['accept']).toContain('text/event-stream');
    // Session captured from initialize, replayed on the follow-up notification.
    expect(state.requests[1]!.headers['mcp-session-id']).toBe('sess-123');
    // Negotiated version echoed after initialize.
    expect(state.requests[1]!.headers['mcp-protocol-version']).toBe('2025-03-26');

    const tools = await adapter.listTools();
    expect(tools.map((t) => t.name)).toEqual(['mcp__mock__echo', 'mcp__mock__echo_two']); // pagination followed
    expect(adapter.getCachedTools()).toHaveLength(2);

    const { content } = await adapter.callTool('mcp__mock__echo', { n: 5 });
    expect(JSON.parse(content)).toEqual({ got: { n: 5 }, typeofN: 'number' });

    await adapter.disconnect();
    expect(state.deleted).toBe(true);
  });

  it('handles plain-JSON (non-SSE) responses identically', async () => {
    state.sse = false;
    const adapter = new StreamableHTTPMCPAdapter({ id: 'mock2', url, accessToken: 'tok-abc' });
    await adapter.connect();
    const tools = await adapter.listTools();
    expect(tools).toHaveLength(2);
    const { content } = await adapter.callTool('echo', { n: 1 }); // raw name accepted
    expect(JSON.parse(content).got).toEqual({ n: 1 });
  });

  it('surfaces HTTP 401 with body detail when the token is missing', async () => {
    const adapter = new StreamableHTTPMCPAdapter({ id: 'noauth', url });
    await expect(adapter.connect()).rejects.toThrow(/401.*missing or bad token/s);
  });

  it('throws on result.isError tool failures so ToolResult.success goes false upstream', async () => {
    const adapter = new StreamableHTTPMCPAdapter({ id: 'mock3', url, accessToken: 'tok-abc' });
    await adapter.connect();
    await adapter.listTools();
    await expect(adapter.callTool('boom', {})).rejects.toThrow('tool exploded');
  });

  it('registry.execute routes to the adapter AND applies #681 JSON-Schema coercion', async () => {
    const adapter = new StreamableHTTPMCPAdapter({ id: 'mock4', url, accessToken: 'tok-abc' });
    await adapter.connect();
    await adapter.listTools();
    const registry = new ToolRegistry();
    registry.registerMCPSource(adapter, 'mock4');
    const result = await registry.execute(
      'mcp__mock4__echo',
      { n: '42' }, // string on a declared number — must arrive as 42
      { sessionId: 't' } as ToolContext,
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(String(result.output))).toEqual({ got: { n: 42 }, typeofN: 'number' });
  });

  it('rejects private hosts without the dev escape hatch', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    try {
      expect(() => new StreamableHTTPMCPAdapter({ id: 'x', url: 'http://127.0.0.1:9/mcp' }))
        .toThrow(/SSRF/);
      expect(() => new StreamableHTTPMCPAdapter({ id: 'x', url: 'ftp://example.com/mcp' }))
        .toThrow(/protocol/);
    } finally {
      process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'] = '1';
    }
  });
});

// ---------------------------------------------------------------------------
// Connector tools + persistence
// ---------------------------------------------------------------------------

describe('mcp.connect / mcp.list / mcp.disconnect + persistence', () => {
  const state: MockState = { requests: [], sse: true, requireToken: null, deleted: false };
  let server: Server;
  let url = '';
  const tmpData = TMP_DATA_DIR;
  const ctx = { sessionId: 'test' } as ToolContext;

  beforeAll(async () => {
    process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'] = '1';
    ({ server, url } = await startMockServer(state));
  });
  afterAll(() => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    server.close();
    rmSync(tmpData, { recursive: true, force: true });
  });
  beforeEach(() => {
    rmSync(path.join(tmpData, 'mcp-connectors.json'), { force: true });
  });

  async function loadTools(): Promise<typeof import('../../src/core/tools/builtin/meta/mcp-connector.js')> {
    return import('../../src/core/tools/builtin/meta/mcp-connector.js');
  }

  it('connect registers live tools, persists WITHOUT secrets, list shows it, disconnect forgets it', async () => {
    const { mcpConnectTool, mcpListTool, mcpDisconnectTool, loadPersistedConnectors } = await loadTools();
    const registry = new ToolRegistry();
    ToolRegistry.setGlobal(registry);
    process.env['FAKE_MCP_TOKEN'] = 'shh-secret';
    state.requireToken = 'shh-secret';
    try {
      const res = await mcpConnectTool.execute(
        { serverId: 'mock', url, authEnvKey: 'FAKE_MCP_TOKEN' },
        ctx,
      );
      expect(res.success).toBe(true);
      expect(String(res.output)).toContain('mcp__mock__echo');

      // Live execution works through the global registry.
      const exec = await registry.execute('mcp__mock__echo', { n: 7 }, ctx);
      expect(exec.success).toBe(true);

      // Persistence file exists, references the env KEY, never the VALUE.
      const persisted = loadPersistedConnectors();
      expect(persisted).toEqual([{ serverId: 'mock', transport: 'http', url, authEnvKey: 'FAKE_MCP_TOKEN' }]);
      const fileRaw = readFileSync(path.join(tmpData, 'mcp-connectors.json'), 'utf8');
      expect(fileRaw).not.toContain('shh-secret');

      // Duplicate connect refused.
      const dup = await mcpConnectTool.execute({ serverId: 'mock', url }, ctx);
      expect(dup.success).toBe(false);
      expect(String(dup.output)).toContain('already connected');

      // list shows the live server with its origin.
      const list = await mcpListTool.execute({}, ctx);
      expect(String(list.output)).toContain('mock: 2 tool(s)');

      // disconnect removes tools + forgets persistence.
      const disc = await mcpDisconnectTool.execute({ serverId: 'mock' }, ctx);
      expect(disc.success).toBe(true);
      expect(loadPersistedConnectors()).toEqual([]);
      await expect(registry.execute('mcp__mock__echo', { n: 1 }, ctx)).rejects.toThrow(/not found/);
    } finally {
      delete process.env['FAKE_MCP_TOKEN'];
      state.requireToken = null;
    }
  });

  it('removeMCPSource tears the transport down (session DELETE fires)', async () => {
    const { mcpConnectTool, mcpDisconnectTool } = await loadTools();
    const registry = new ToolRegistry();
    ToolRegistry.setGlobal(registry);
    state.deleted = false;
    const res = await mcpConnectTool.execute({ serverId: 'teardown', url, persist: false }, ctx);
    expect(res.success).toBe(true);
    await mcpDisconnectTool.execute({ serverId: 'teardown' }, ctx);
    await new Promise((r) => setTimeout(r, 50)); // disconnect is fire-and-forget
    expect(state.deleted).toBe(true);
  });

  it('replay skips a persisted connector whose serverId is already registered', async () => {
    const { mcpConnectTool, mcpDisconnectTool, replayPersistedConnectors } = await loadTools();
    const registry = new ToolRegistry();
    ToolRegistry.setGlobal(registry);
    await mcpConnectTool.execute({ serverId: 'dupe', url }, ctx); // persisted + live
    const outcomes = await replayPersistedConnectors(registry); // same registry: id already live
    expect(outcomes).toEqual([
      { serverId: 'dupe', ok: false, toolCount: 0, error: 'serverId already registered — skipped' },
    ]);
    expect(registry.listMCPSources()).toHaveLength(1); // original untouched
    await mcpDisconnectTool.execute({ serverId: 'dupe' }, ctx);
  });

  it('rejects serverIds containing consecutive underscores (tool-name ambiguity)', async () => {
    const { mcpConnectTool } = await loadTools();
    ToolRegistry.setGlobal(new ToolRegistry());
    const res = await mcpConnectTool.execute({ serverId: 'a__b', url }, ctx);
    expect(res.success).toBe(false);
  });

  it('connect validates inputs: serverId charset, url XOR command, env-key shape, missing env var', async () => {
    const { mcpConnectTool } = await loadTools();
    ToolRegistry.setGlobal(new ToolRegistry());
    expect((await mcpConnectTool.execute({ serverId: 'bad id!', url }, ctx)).success).toBe(false);
    expect((await mcpConnectTool.execute({ serverId: 'x' }, ctx)).success).toBe(false);
    expect((await mcpConnectTool.execute({ serverId: 'x', url, command: 'npx' }, ctx)).success).toBe(false);
    expect((await mcpConnectTool.execute({ serverId: 'x', url, authEnvKey: 'not a name' }, ctx)).success).toBe(false);
    const missing = await mcpConnectTool.execute({ serverId: 'x', url, authEnvKey: 'DEFINITELY_UNSET_VAR_XYZ' }, ctx);
    expect(missing.success).toBe(false);
    expect(String(missing.output)).toContain('DEFINITELY_UNSET_VAR_XYZ');
  });

  it('persist=false connects session-only; replay honors the kill-switch and dead servers', async () => {
    const { mcpConnectTool, replayPersistedConnectors, loadPersistedConnectors } = await loadTools();
    const registry = new ToolRegistry();
    ToolRegistry.setGlobal(registry);
    const res = await mcpConnectTool.execute({ serverId: 'ephem', url, persist: false }, ctx);
    expect(res.success).toBe(true);
    expect(loadPersistedConnectors()).toEqual([]);
    expect(existsSync(path.join(tmpData, 'mcp-connectors.json'))).toBe(false);

    // Kill-switch: replay returns nothing even with connectors on disk.
    const p2 = await mcpConnectTool.execute({ serverId: 'persisted', url }, ctx);
    expect(p2.success).toBe(true);
    process.env['SUDO_MCP_CONNECTORS'] = '0';
    try {
      expect(await replayPersistedConnectors(new ToolRegistry())).toEqual([]);
    } finally {
      delete process.env['SUDO_MCP_CONNECTORS'];
    }

    // Replay into a fresh registry reconnects the persisted one only.
    const fresh = new ToolRegistry();
    const outcomes = await replayPersistedConnectors(fresh);
    expect(outcomes).toEqual([{ serverId: 'persisted', ok: true, toolCount: 2 }]);
    expect(fresh.listMCPSources().map((s) => s.serverId)).toEqual(['persisted']);

    // A dead endpoint is skipped, not thrown.
    const { mcpDisconnectTool } = await loadTools();
    await mcpDisconnectTool.execute({ serverId: 'persisted', forget: false }, ctx);
    server.close();
    const deadOutcomes = await replayPersistedConnectors(new ToolRegistry());
    expect(deadOutcomes).toHaveLength(1);
    expect(deadOutcomes[0]!.ok).toBe(false);
    ({ server, url } = await startMockServer(state)); // restore for other tests
  });
});
