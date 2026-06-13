/**
 * meta.ptc — Programmatic Tool Calling (gap #15) end-to-end tests.
 *
 * Each test spawns a real Worker against the real ptc-worker.cjs file and
 * a real ToolRegistry seeded with a handful of stub tools. Tool calls
 * dispatched from the script flow through registry.execute(), so the
 * permission/approval gates are the live ones — same path the loop uses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../../src/core/tools/registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../src/core/tools/types.js';
import { ptcTool, setPtcRegistry } from '../../../src/core/tools/builtin/meta/ptc.js';

let registry: ToolRegistry;

function ctx(): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: '/tmp',
    config: {},
    logger: {},
  };
}

function registerStub(reg: ToolRegistry, name: string, fn: (params: Record<string, unknown>) => Promise<ToolResult> | ToolResult, opts: { timeout?: number } = {}): void {
  const tool: ToolDefinition = {
    name,
    description: `stub ${name}`,
    category: 'meta' as const,
    safety: 'safe',
    requiresConfirmation: false,
    timeout: opts.timeout ?? 5_000,
    parameters: {},
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      return await fn(params);
    },
  };
  reg.register(tool);
}

beforeEach(() => {
  registry = new ToolRegistry();
  setPtcRegistry(registry);
});

afterEach(() => {
  setPtcRegistry(null);
});

describe('meta.ptc validation', () => {
  it('refuses without an injected registry', async () => {
    setPtcRegistry(null);
    const result = await ptcTool.execute({ script: 'print("x")' }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('registry has not been injected');
  });

  it('refuses an empty script', async () => {
    const result = await ptcTool.execute({ script: '   ' }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('non-empty');
  });

  it('refuses an oversized script', async () => {
    const script = 'a'.repeat(100_001);
    const result = await ptcTool.execute({ script }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('exceeds');
  });
});

describe('meta.ptc execution', () => {
  it('captures print() output', async () => {
    const result = await ptcTool.execute({ script: 'print("hello world")' }, ctx());
    expect(result.success).toBe(true);
    expect((result.data as { stdout: string }).stdout).toContain('hello world');
  });

  it('returns the explicit return value as data.value', async () => {
    const result = await ptcTool.execute({ script: 'return 42;' }, ctx());
    expect(result.success).toBe(true);
    expect((result.data as { value: unknown }).value).toBe(42);
  });

  it('dispatches a tool() call through registry.execute()', async () => {
    let received: Record<string, unknown> | undefined;
    registerStub(registry, 'stub.echo', (params) => {
      received = params;
      return { success: true, output: `echo: ${params['msg']}`, data: { msg: params['msg'] } };
    });

    const script = `
      const r = await tool('stub.echo', { msg: 'hi' });
      print(r.output);
      return r.data.msg;
    `;
    const result = await ptcTool.execute({ script }, ctx());

    expect(result.success).toBe(true);
    expect(received).toEqual({ msg: 'hi' });
    expect((result.data as { stdout: string }).stdout).toContain('echo: hi');
    expect((result.data as { value: unknown }).value).toBe('hi');
    expect((result.data as { toolCallCount: number }).toolCallCount).toBe(1);
  });

  it('threads N tool() calls in one model turn (the gap #15 win)', async () => {
    registerStub(registry, 'stub.add', (params) => ({
      success: true,
      output: '',
      data: { sum: Number(params['a']) + Number(params['b']) },
    }));

    const script = `
      let total = 0;
      for (let i = 0; i < 5; i++) {
        const r = await tool('stub.add', { a: i, b: 1 });
        total += r.data.sum;
      }
      return total;
    `;
    const result = await ptcTool.execute({ script }, ctx());
    expect(result.success).toBe(true);
    // 1+2+3+4+5 = 15
    expect((result.data as { value: unknown }).value).toBe(15);
    expect((result.data as { toolCallCount: number }).toolCallCount).toBe(5);
  });

  it('surfaces a registry execute() error as a script-catchable Error', async () => {
    const script = `
      let msg = 'no-error';
      try {
        await tool('does.not.exist', {});
      } catch (e) {
        msg = e.message;
      }
      return msg;
    `;
    const result = await ptcTool.execute({ script }, ctx());
    expect(result.success).toBe(true);
    expect((result.data as { value: unknown }).value).toContain('Tool not found');
  });

  it('caps in-flight tool calls at MAX_TOOL_CALLS and reports `capped`', async () => {
    registerStub(registry, 'stub.noop', () => ({ success: true, output: '', data: {} }));
    const script = `
      let lastErr = null;
      let ok = 0;
      for (let i = 0; i < 100; i++) {
        try {
          await tool('stub.noop', {});
          ok++;
        } catch (e) {
          lastErr = e.message;
          break;
        }
      }
      return { ok, lastErr };
    `;
    const result = await ptcTool.execute({ script }, ctx());
    expect((result.data as { capped: boolean }).capped).toBe(true);
    const v = (result.data as { value: { ok: number; lastErr: string | null } }).value;
    expect(v.lastErr).toContain('MAX_TOOL_CALLS exceeded');
    expect(v.ok).toBe(50);
    expect(result.success).toBe(false);
  });

  it('rejects recursive meta.ptc invocation (including bare "ptc" Ollama-suffix bypass)', async () => {
    const script = `
      const errs = [];
      try { await tool('meta.ptc', { script: 'print("x")' }); }
      catch (e) { errs.push(e.message); }
      try { await tool('ptc', { script: 'print("x")' }); }
      catch (e) { errs.push(e.message); }
      return errs;
    `;
    const result = await ptcTool.execute({ script }, ctx());
    expect(result.success).toBe(true);
    const errs = (result.data as { value: string[] }).value;
    expect(errs).toHaveLength(2);
    for (const e of errs) expect(e).toContain('recursively');
    // Recursion refusals must NOT burn slots from the MAX_TOOL_CALLS budget.
    expect((result.data as { toolCallCount: number }).toolCallCount).toBe(0);
  });

  it('blocks fs/process/require/global from the sandbox', async () => {
    const script = `
      const denied = [];
      if (typeof require === 'undefined') denied.push('require');
      if (typeof process === 'undefined') denied.push('process');
      if (typeof globalThis === 'undefined') denied.push('globalThis');
      if (typeof __dirname === 'undefined') denied.push('__dirname');
      return denied;
    `;
    const result = await ptcTool.execute({ script }, ctx());
    expect(result.success).toBe(true);
    const denied = (result.data as { value: string[] }).value;
    expect(denied).toEqual(expect.arrayContaining(['require', 'process', 'globalThis', '__dirname']));
  });

  it('enforces the wall-clock timeout and reports `timedOut`', async () => {
    registerStub(
      registry,
      'stub.sleep',
      async (params) => {
        await new Promise((r) => setTimeout(r, Number(params['ms'] ?? 0)));
        return { success: true, output: '', data: {} };
      },
      { timeout: 10_000 },
    );
    // Tight, environment-independent timings: 500ms sleep inside the stub,
    // 100ms PTC timeout. The verifier flagged the prior 1s/2s combo as
    // tight on slow CI hosts. timeout_seconds is clamped to a minimum of
    // its default if non-positive, so we pass it as a fraction.
    const script = `
      await tool('stub.sleep', { ms: 500 });
      return 'should-not-reach';
    `;
    const result = await ptcTool.execute({ script, timeout_seconds: 0.1 }, ctx());
    expect((result.data as { timedOut: boolean }).timedOut).toBe(true);
    expect(result.success).toBe(false);
  }, 5000);

  it('records the script-visible call log in the result data', async () => {
    registerStub(registry, 'stub.a', () => ({ success: true, output: '', data: {} }));
    registerStub(registry, 'stub.b', () => ({ success: true, output: '', data: {} }));
    const script = `
      await tool('stub.a', { x: 1 });
      await tool('stub.b', { y: 2 });
      return 'done';
    `;
    const result = await ptcTool.execute({ script }, ctx());
    const log = (result.data as { callLog: Array<{ name: string; args: Record<string, unknown> }> }).callLog;
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ name: 'stub.a', args: { x: 1 } });
    expect(log[1]).toMatchObject({ name: 'stub.b', args: { y: 2 } });
  });
});
