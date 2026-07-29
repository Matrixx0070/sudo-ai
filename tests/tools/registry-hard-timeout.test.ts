/**
 * Regression test for the stuck-tool-call incident: a tool call that never
 * settles (ignores its abort signal, or — for MCP — has no timeout at all)
 * used to hang ToolRegistry.execute() forever. Because KeyedAsyncQueue and
 * MessageCoalescer both serialize turns per-peer with no timeout of their
 * own, one wedged tool call silenced an entire chat indefinitely (every
 * later message queued behind a promise that would never settle).
 *
 * These tests prove ToolRegistry.execute() always settles within a bounded
 * time even when the underlying tool/adapter never returns and ignores its
 * abort signal.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { ToolRegistry as ToolRegistryClass } from '../../src/core/tools/registry.js';
import type { ToolDefinition, ToolContext } from '../../src/core/tools/types.js';
import type { MCPAdapterLike, MCPToolDef } from '../../src/core/tools/mcp-adapter.js';

const ctx = { sessionId: 'test-session', workingDir: '/tmp', config: null, logger: console } as ToolContext;

describe('ToolRegistry hard timeout — stuck-tool-call regression', () => {
  let ToolRegistry: typeof ToolRegistryClass;

  beforeAll(async () => {
    // MCP_TOOL_TIMEOUT_MS is read from SUDO_MCP_TOOL_TIMEOUT_MS once at
    // module load — static imports hoist above plain statements, so the env
    // var must be set before a dynamic import triggers that module load, to
    // keep the MCP test fast (production default is 120s; this test only
    // needs to prove the timeout fires, not wait out the real default).
    process.env['SUDO_MCP_TOOL_TIMEOUT_MS'] = '200';
    ({ ToolRegistry } = await import('../../src/core/tools/registry.js'));
  });

  it('native tool: execute() settles even when the tool ignores its abort signal and never returns', async () => {
    const registry = new ToolRegistry();
    const hungTool: ToolDefinition = {
      name: 'test.hang-ignores-signal',
      description: 'never resolves, does not check ctx.signal',
      category: 'system',
      parameters: {},
      timeout: 50, // soft cooperative timeout — tool below deliberately ignores it
      execute: () => new Promise(() => { /* never settles, never checks ctx.signal */ }),
    };
    registry.register(hungTool);

    const start = Date.now();
    await expect(registry.execute('test.hang-ignores-signal', {}, ctx)).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - start;
    // Hard deadline is tool.timeout (50ms) + 5s grace — must settle well under
    // that, and MUST NOT hang indefinitely (the bug this regresses against).
    expect(elapsed).toBeLessThan(6_000);
  }, 8_000);

  it('MCP tool: execute() settles even when the adapter never returns (previously had NO timeout at all)', async () => {
    const registry = new ToolRegistry();
    const defs: MCPToolDef[] = [{
      name: 'mcp__fake__hang',
      description: 'fake hanging MCP tool',
      inputSchema: { type: 'object', properties: {} },
      serverId: 'fake',
      enabled: true,
    }];
    const adapter: MCPAdapterLike = {
      serverId: 'fake',
      connect: async () => {},
      disconnect: async () => {},
      listTools: async () => defs,
      getCachedTools: () => defs,
      callTool: () => new Promise(() => { /* wedged remote server, never resolves */ }),
    };
    registry.registerMCPSource(adapter, 'fake');

    const start = Date.now();
    const result = await registry.execute('mcp__fake__hang', {}, ctx);
    const elapsed = Date.now() - start;
    // _executeMCPTool catches internally and returns a failure result rather
    // than throwing (matches its existing error-handling contract).
    expect(result.success).toBe(false);
    expect(String(result.output)).toMatch(/timed out/i);
    // SUDO_MCP_TOOL_TIMEOUT_MS=200 (set in beforeAll); production default 120s.
    // The regression guard is "settles at all", not the exact bound.
    expect(elapsed).toBeLessThan(2_000);
  }, 5_000);
});
