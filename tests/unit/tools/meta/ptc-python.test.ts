/**
 * Integration tests for meta.ptc-python: spawns the REAL python3 harness and
 * drives the line-protocol against a mocked ToolRegistry.execute.
 *
 * Two suites:
 *   - "protocol (unconfined)" runs with SUDO_PTC_PYTHON_BWRAP=0 (direct python3),
 *     so the protocol/cap/timeout/recursion logic is covered even on CI runners
 *     without bubblewrap.
 *   - "bwrap confinement" runs the DEFAULT (bwrap) path, skipped when bwrap is
 *     absent; it proves the jail blocks host fs + network while tool() still works.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { ptcPythonTool, setPtcPythonRegistry } from '../../../../src/core/tools/builtin/meta/ptc-python.js';
import type { ToolContext } from '../../../../src/core/tools/types.js';
import type { ToolRegistry } from '../../../../src/core/tools/registry.js';

const hasPython3 = (() => { try { return spawnSync('python3', ['--version']).status === 0; } catch { return false; } })();
// `bwrap --version` passes even when the kernel denies unshare (e.g. GitHub
// Actions containers), so run a minimal SANDBOXED command to confirm bwrap can
// actually create a namespace — else the confinement tests skip there.
const hasBwrap = (() => {
  try { execSync("bwrap --dev /dev --bind / / sh -c 'exit 0'", { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

const ctx = { sessionId: 'test', workingDir: process.cwd(), config: {}, logger: console } as unknown as ToolContext;

function mockRegistry(execute: (name: string, args: Record<string, unknown>) => unknown): ToolRegistry {
  return { execute: vi.fn(async (name: string, args: Record<string, unknown>) => execute(name, args)) } as unknown as ToolRegistry;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!hasPython3)('meta.ptc-python — protocol (unconfined)', () => {
  beforeEach(() => { process.env['SUDO_PTC_PYTHON_BWRAP'] = '0'; });
  afterEach(() => { delete process.env['SUDO_PTC_PYTHON_BWRAP']; });

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
      script: ['print("hi from python")', 'r = tool("demo.echo", {"x": 7})', 'result = {"got": r, "n": 7}'].join('\n'),
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
    setPtcPythonRegistry(mockRegistry(() => { throw new Error('boom from host'); }));
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
    setPtcPythonRegistry(mockRegistry(() => ({})));
    const res = await ptcPythonTool.execute({
      script: ['caught = None', 'for i in range(60):', '    try:', '        tool("x.y", {})',
        '    except Exception as e:', '        caught = str(e)', '        break', 'result = caught'].join('\n'),
    }, ctx);
    const data = res.data as any;
    expect(data.capped).toBe(true);
    expect(data.toolCallCount).toBe(50);
    expect(String(data.value)).toMatch(/MAX_TOOL_CALLS/);
  });

  it('times out a runaway script', async () => {
    setPtcPythonRegistry(mockRegistry(() => ({})));
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

describe.skipIf(!hasPython3 || !hasBwrap)('meta.ptc-python — bwrap confinement (default)', () => {
  beforeEach(() => { delete process.env['SUDO_PTC_PYTHON_BWRAP']; }); // default = ON
  afterEach(() => { delete process.env['SUDO_PTC_PYTHON_BWRAP']; });

  it('still bridges tool() through the registry under bwrap', async () => {
    const reg = mockRegistry((_n, a) => ({ echoed: a }));
    setPtcPythonRegistry(reg);
    const res = await ptcPythonTool.execute({ script: 'result = tool("demo", {"k": 9})' }, ctx);
    expect(res.success).toBe(true);
    expect(reg.execute as any).toHaveBeenCalledWith('demo', { k: 9 }, ctx);
    expect((res.data as any).value).toEqual({ echoed: { k: 9 } });
  }, 15_000);

  it('confines the filesystem — the script cannot read a host file outside the jail', async () => {
    setPtcPythonRegistry(mockRegistry(() => ({})));
    const res = await ptcPythonTool.execute({
      script: ['try:', '    open("/etc/hostname").read()', '    result = "READ (bad)"',
        'except Exception as e:', '    result = "blocked:" + type(e).__name__'].join('\n'),
    }, ctx);
    expect(res.success).toBe(true);
    expect(String((res.data as any).value)).toMatch(/^blocked:/);
  }, 15_000);

  it('confines the network — the script cannot open a socket', async () => {
    setPtcPythonRegistry(mockRegistry(() => ({})));
    const res = await ptcPythonTool.execute({
      script: ['import socket', 'try:', '    socket.create_connection(("1.1.1.1", 53), timeout=2)',
        '    result = "REACHED (bad)"', 'except Exception as e:', '    result = "blocked:" + type(e).__name__'].join('\n'),
    }, ctx);
    expect(res.success).toBe(true);
    expect(String((res.data as any).value)).toMatch(/^blocked:/);
  }, 15_000);
});
