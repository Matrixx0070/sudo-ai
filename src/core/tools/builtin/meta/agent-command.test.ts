/**
 * Tests for agent.command — the full-control grok-web-mcp entry point.
 * Focus: owner-tier turn dispatch, the recursion guard, and the budgets that
 * bound how hard the external cloud can drive the agent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agentCommandTool, _resetCommandBudget } from './agent-command.js';
import { injectMetaToolDeps } from './index.js';
import { ToolRegistry } from '../../registry.js';
import type { ToolContext } from '../../types.js';

const ctx = { sessionId: 'web:owner', workingDir: '/tmp', config: {}, logger: console } as unknown as ToolContext;

interface RunOpts { caller?: { isOwner?: boolean; channel?: string; peerId?: string } }

function wireDeps(run: (id: string, msg: string, ev: unknown, opts?: RunOpts) => Promise<{ text: string }>): void {
  injectMetaToolDeps({
    sessionManager: { getOrCreate: async () => ({ id: 'grok-mcp:owner' }) },
    agentLoop: { run },
  });
}

describe('agent.command', () => {
  beforeEach(() => {
    _resetCommandBudget();
    // Clear injected deps by default; individual tests wire what they need.
    injectMetaToolDeps({ sessionManager: null, agentLoop: null });
  });

  it('is hiddenFromAgent: excluded from listEnabled/schema but present in listAll', () => {
    expect(agentCommandTool.hiddenFromAgent).toBe(true);
    const reg = new ToolRegistry();
    reg.register(agentCommandTool);
    expect(reg.listAll().map((t) => t.name)).toContain('agent.command');
    expect(reg.listEnabled().map((t) => t.name)).not.toContain('agent.command');
    expect(reg.getSchemaForLLM().map((s) => s.function.name)).not.toContain('agent.command');
    // Still directly reachable by name (the MCP boundary path).
    expect(reg.get('agent.command')).toBeDefined();
  });

  it('requires a non-empty instruction', async () => {
    const r = await agentCommandTool.execute({ instruction: '  ' }, ctx);
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/instruction.*required/i);
  });

  it('runs a full turn at OWNER tier and returns the reply', async () => {
    let seen: RunOpts | undefined;
    wireDeps(async (_id, msg, _ev, opts) => { seen = opts; return { text: `handled: ${msg}` }; });
    const r = await agentCommandTool.execute({ instruction: 'restart yourself' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toBe('handled: restart yourself');
    expect(seen?.caller?.isOwner).toBe(true);
    expect(seen?.caller?.channel).toBe('grok-mcp');
  });

  it('refuses to recurse: a nested call on the active command session is rejected', async () => {
    // getOrCreate resolves the command session to 'grok-mcp:owner'. While the
    // outer turn runs, that id is in the active set — a nested call from inside
    // it (same ctx.sessionId) must be refused.
    let nested: Awaited<ReturnType<typeof agentCommandTool.execute>> | undefined;
    wireDeps(async () => {
      const innerCtx = { ...ctx, sessionId: 'grok-mcp:owner' } as ToolContext;
      nested = await agentCommandTool.execute({ instruction: 'recurse' }, innerCtx);
      return { text: 'outer done' };
    });
    const r = await agentCommandTool.execute({ instruction: 'outer' }, ctx);
    expect(r.success).toBe(true);
    expect(nested?.success).toBe(false);
    expect(nested?.output).toMatch(/within a command-driven turn/);
  });

  it('errors gracefully when deps are not injected', async () => {
    const r = await agentCommandTool.execute({ instruction: 'do it' }, ctx);
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/not initialised/);
  });

  it('serializes: with the default in-flight cap of 1, a concurrent second command is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    wireDeps(async () => { await gate; return { text: 'ok' }; });

    const p1 = agentCommandTool.execute({ instruction: 'one' }, ctx);
    // Let the first turn register its in-flight increment.
    await new Promise((r) => setTimeout(r, 0));
    const r2 = await agentCommandTool.execute({ instruction: 'two' }, ctx);
    expect(r2.success).toBe(false);
    expect(r2.output).toMatch(/busy/);

    release();
    await p1;
  });
});
