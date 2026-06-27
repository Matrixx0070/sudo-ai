/**
 * Integration tests for meta.ptc-python: spawns the REAL python3 harness and
 * drives the line-protocol against a mocked ToolRegistry.execute.
 */
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { ptcPythonTool, setPtcPythonRegistry } from '../../../../src/core/tools/builtin/meta/ptc-python.js';
import type { ToolContext } from '../../../../src/core/tools/types.js';
import type { ToolRegistry } from '../../../../src/core/tools/registry.js';

const hasPython3 = (() => {
  try { return spawnSync('python3', ['--version']).status === 0; } catch { return false; }
})();

const ctx = { sessionId: 'test', workingDir: process.cwd(), config: {}, logger: console } as unknown as ToolContext;

function mockRegistry(execute: (name: string, args: Record<string, unknown>) => unknown): ToolRegistry {
  return { execute: vi.fn(async (name: string, args: Record<string, unknown>) => execute(name, args)) } as unknown as ToolRegistry;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!hasPython3)('meta.ptc-python', () => {
  it('returns disabled when no registry is injected', async () => {
    setPtcPythonRegistry(null);
    const res = await ptcPythonTool.execute({ script: 'result = 1' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/registry has not been injected/i);
  });

  it('runs a script, bridges tool() through the registry, captures print + result', async () => {
    const reg = mockRegistry((_name, args) => ({ ok: true, echoed: args }));
    setPtcPythonRegistry(reg);
    const res = await ptcPythonTool.execute({
      script: [
        'print("hi from python")',
        'r = tool("demo.echo", {"x": 7})',
        'result = {"got": r, "n": 7}',
      ].join('\n'),
    }, ctx);
    expect(res.success).toBe(true);
    expect(reg.execute as any).toHaveBeenCalledWith('demo.echo', { x: 7 }, ctx);
    const data = res.data as any;
    expect(data.stdout).toMatch(/hi from python/);
    expect(data.value).toEqual({ got: { ok: true, echoed: { x: 7 } }, n: 7 });
    expect(data.toolCallCount).toBe(1);
    expect(data.callLog).toEqual([{ name: 'demo.echo', args: { x: 7 } }]);
  });

  it('surfaces a registry tool error as a python exception', async () => {
    const reg = mockRegistry(() => { throw new Error('boom from host'); });
    setPtcPythonRegistry(reg);
    const res = await ptcPythonTool.execute({ script: 'result = tool("will.fail", {})' }, ctx);
    expect(res.success).toBe(false);
    expect((res.data as any).error).toMatch(/boom from host/);
  });

  it('blocks recursive self-invocation without dispatching to the registry', async () => {
    const reg = mockRegistry(() => ({}));
    setPtcPythonRegistry(reg);
    const res = await ptcPythonTool.execute({ script: 'result = tool("meta.ptc-python", {})' }, ctx);
    expect(res.success).toBe(false);
    expect((res.data as any).error).toMatch(/cannot recursively invoke itself/i);
    expect(reg.execute as any).not.toHaveBeenCalled();
  });

  it('caps tool calls at MAX_TOOL_CALLS (50)', async () => {
    const reg = mockRegistry(() => ({}));
    setPtcPythonRegistry(reg);
    const res = await ptcPythonTool.execute({
      script: [
        'caught = None',
        'for i in range(60):',
        '    try:',
        '        tool("x.y", {})',
        '    except Exception as e:',
        '        caught = str(e)',
        '        break',
        'result = caught',
      ].join('\n'),
    }, ctx);
    const data = res.data as any;
    expect(data.capped).toBe(true);
    expect(data.toolCallCount).toBe(50);
    expect(String(data.value)).toMatch(/MAX_TOOL_CALLS/);
  });

  it('times out a runaway script', async () => {
    const reg = mockRegistry(() => ({}));
    setPtcPythonRegistry(reg);
    const res = await ptcPythonTool.execute({ script: 'while True:\n    pass', timeout_seconds: 0.4 }, ctx);
    expect(res.success).toBe(false);
    expect((res.data as any).timedOut).toBe(true);
  }, 10_000);

  it('rejects an empty script', async () => {
    setPtcPythonRegistry(mockRegistry(() => ({})));
    const res = await ptcPythonTool.execute({ script: '   ' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/non-empty/);
  });
});
