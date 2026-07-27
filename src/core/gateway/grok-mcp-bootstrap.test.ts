/**
 * Tests for the grok-web-mcp boundary allowlist resolver — the resilience seam
 * that keeps a single conditionally-registered/absent tool from taking down the
 * whole boundary while never widening exposure beyond registered readonly tools.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition } from '../tools/types.js';
import { resolveBoundaryAllowlist, startGrokMcpBoundary, type GrokMcpLifecycle } from './grok-mcp-bootstrap.js';

function tool(name: string, safety: 'readonly' | 'destructive'): ToolDefinition {
  return {
    name,
    description: name,
    category: 'system',
    safety,
    parameters: {},
    async execute() {
      return { success: true, output: 'ok' };
    },
  };
}

function registryWith(...tools: ToolDefinition[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

describe('resolveBoundaryAllowlist', () => {
  it('keeps registered readonly tools and drops absent ones', () => {
    const reg = registryWith(tool('git.status', 'readonly'), tool('github.pr_status', 'readonly'));
    const { valid, dropped } = resolveBoundaryAllowlist(reg, 'git.status,meta.search-tools,github.pr_status');
    expect(valid).toEqual(['git.status', 'github.pr_status']);
    expect(dropped).toEqual(['meta.search-tools']); // present in source, not registered at boot
  });

  it('drops a registered-but-destructive tool (never widens exposure)', () => {
    const reg = registryWith(tool('git.status', 'readonly'), tool('coder.write', 'destructive'));
    const { valid, dropped } = resolveBoundaryAllowlist(reg, 'git.status,coder.write');
    expect(valid).toEqual(['git.status']);
    expect(dropped).toEqual(['coder.write']);
  });

  it('trims whitespace and ignores empty entries', () => {
    const reg = registryWith(tool('git.status', 'readonly'));
    const { valid } = resolveBoundaryAllowlist(reg, ' git.status , , ');
    expect(valid).toEqual(['git.status']);
  });

  it('returns all-dropped when nothing matches', () => {
    const reg = registryWith(tool('git.status', 'readonly'));
    const { valid, dropped } = resolveBoundaryAllowlist(reg, 'nope.one,nope.two');
    expect(valid).toEqual([]);
    expect(dropped).toEqual(['nope.one', 'nope.two']);
  });
});

describe('startGrokMcpBoundary + commandTool (full-control lane)', () => {
  function mockLifecycle(): { lc: GrokMcpLifecycle; calls: string[] } {
    const calls: string[] = [];
    const lc: GrokMcpLifecycle = {
      create: async () => { calls.push('create'); return 'conn-123'; },
      connect: async () => { calls.push('connect'); },
      discover: async () => { calls.push('discover'); return [{ name: 'agent_command' }]; },
      remove: async () => { calls.push('remove'); },
    };
    return { lc, calls };
  }

  const BASE = {
    publicBaseUrl: 'https://mcp.example.test',
    token: 'tok-abcdef0123',
    teamId: 'team-1',
    connectorName: 'sudo-ai-brain',
    port: 18993,
  };

  it('stands up the boundary with a destructive commandTool and no readonly tools', async () => {
    const reg = registryWith(tool('agent.command', 'destructive'));
    const { lc, calls } = mockLifecycle();
    const boundary = await startGrokMcpBoundary({
      registry: reg, exposedTools: '', commandTool: 'agent.command', lifecycle: lc, ...BASE,
    });
    try {
      expect(boundary.connectorId).toBe('conn-123');
      expect(calls).toEqual(['create', 'connect', 'discover']);
      expect(process.env['SUDO_GROK_WEB_MCP_CONNECTOR_ID']).toBe('conn-123');
    } finally {
      await boundary.stop();
    }
  });

  it('fails loud when the commandTool is not registered', async () => {
    const reg = registryWith(tool('git.status', 'readonly'));
    const { lc } = mockLifecycle();
    await expect(
      startGrokMcpBoundary({ registry: reg, exposedTools: 'git.status', commandTool: 'agent.command', lifecycle: lc, ...BASE }),
    ).rejects.toThrow(/commandTool "agent.command" is not registered/);
  });
});
