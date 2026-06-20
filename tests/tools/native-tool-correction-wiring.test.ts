/**
 * @file native-tool-correction-wiring.test.ts
 * @description Integration tests for gap #7 — the ToolRegistry wires
 * NativeToolCorrection into the MCP tool-dispatch failure path. When an MCP tool
 * call FAILS and SUDO_NATIVE_TOOL_CORRECTION_FALLBACK=1, the registry
 * auto-corrects to the native SUDO-AI equivalent and re-dispatches. Default OFF
 * is byte-identical (returns the original MCP failure).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ToolRegistry } from '@core/tools/registry.js';
import type { ToolContext, ToolDefinition } from '@core/tools/types.js';
import type { MCPAdapter, MCPToolDef } from '@core/tools/mcp-adapter.js';

function ctx(): ToolContext {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return { sessionId: 's', workingDir: '/tmp', config: {}, logger } as ToolContext;
}

/** A native stub tool that records the args it received. */
function nativeStub(name: string, sink: { args: Record<string, unknown> | null }): ToolDefinition {
  return {
    name,
    description: 'stub native tool',
    category: 'system',
    parameters: {},
    async execute(params: Record<string, unknown>) {
      sink.args = params;
      return { success: true, output: `native:${name}` };
    },
  };
}

/** A failing MCP adapter exposing one tool whose callTool always throws. */
function failingAdapter(serverId: string, bareTool: string): MCPAdapter {
  const def = {
    name: `mcp__${serverId}__${bareTool}`,
    description: 'mcp tool',
    inputSchema: {},
    serverId,
  } as MCPToolDef;
  return {
    serverId,
    getCachedTools: () => [def],
    callTool: async () => { throw new Error('MCP server unavailable'); },
  } as unknown as MCPAdapter;
}

afterEach(() => { delete process.env['SUDO_NATIVE_TOOL_CORRECTION_FALLBACK']; });

describe('NativeToolCorrection wiring (registry MCP failure path)', () => {
  it('NTC-1: flag ON → MCP failure auto-corrects to the native tool and re-dispatches', async () => {
    process.env['SUDO_NATIVE_TOOL_CORRECTION_FALLBACK'] = '1';
    const sink: { args: Record<string, unknown> | null } = { args: null };
    const registry = new ToolRegistry();
    registry.register(nativeStub('system.exec', sink)); // shell_execute → system.exec
    registry.registerMCPSource(failingAdapter('fs', 'shell_execute'), 'fs');

    const result = await registry.execute('mcp__fs__shell_execute', { command: 'ls' }, ctx());
    expect(result.success).toBe(true);
    expect(result.output).toBe('native:system.exec');
    expect(sink.args).toEqual({ command: 'ls' }); // converted args reached the native tool
  });

  it('NTC-2: flag OFF → MCP failure returns the original error, native NOT called', async () => {
    const sink: { args: Record<string, unknown> | null } = { args: null };
    const registry = new ToolRegistry();
    registry.register(nativeStub('system.exec', sink));
    registry.registerMCPSource(failingAdapter('fs', 'shell_execute'), 'fs');

    const result = await registry.execute('mcp__fs__shell_execute', { command: 'ls' }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('MCP server unavailable');
    expect(sink.args).toBeNull();
  });

  it('NTC-3: flag ON but no native mapping → original MCP failure (fail-open)', async () => {
    process.env['SUDO_NATIVE_TOOL_CORRECTION_FALLBACK'] = '1';
    const registry = new ToolRegistry();
    registry.registerMCPSource(failingAdapter('x', 'some_unmapped_tool'), 'x');

    const result = await registry.execute('mcp__x__some_unmapped_tool', {}, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('MCP server unavailable');
  });
});
