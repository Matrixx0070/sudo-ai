/**
 * @file tests/tools/system-platform.test.ts
 * @description Cross-platform branches of system.process and system.monitor:
 *   - Linux keeps the exact GNU ps invocations (regression guard for prod).
 *   - darwin uses BSD-compatible ps (no --no-headers/--sort) with the header
 *     skipped and CPU-sort done in code.
 *   - darwin monitor metrics come from node:os; sources with no clean darwin
 *     equivalent are reported as explicitly unavailable, not silent zeros.
 *
 * runCmd is mocked — no real ps is spawned in the execute-level tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runCmdMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/tools/builtin/system/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/tools/builtin/system/exec.js')>();
  return { ...actual, runCmd: runCmdMock };
});

import type { ToolContext } from '../../src/core/tools/types.js';
import {
  processTool,
  buildPsListArgs,
  buildPsInfoArgs,
} from '../../src/core/tools/builtin/system/process.js';
import {
  monitorTool,
  buildTopProcessesArgs,
} from '../../src/core/tools/builtin/system/monitor.js';

function makeCtx(): ToolContext {
  return { sessionId: `test-${Date.now()}`, workingDir: '/tmp', config: null, logger: null } as ToolContext;
}

/** Temporarily override process.platform; returns a restore fn. */
function stubPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', original);
}

const PS_HEADER = 'USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND';
const PS_LINE_1 = 'root                 1   0.5  0.1  4321000  15000   ??  Ss   9:41AM    0:12.34 /sbin/launchd';
const PS_LINE_2 = 'frank              234  12.5  2.0  5000000  90000   ??  R    9:42AM    1:00.00 node server.js';

beforeEach(() => {
  runCmdMock.mockReset();
});

// ---------------------------------------------------------------------------
// Pure builders: exact commands per platform
// ---------------------------------------------------------------------------

describe('ps argv builders', () => {
  it('linux list: GNU `ps aux --no-headers` (unchanged)', () => {
    expect(buildPsListArgs('linux')).toEqual({ args: ['aux', '--no-headers'], skipHeader: false });
  });

  it('darwin list: BSD `ps aux`, header skipped in code', () => {
    expect(buildPsListArgs('darwin')).toEqual({ args: ['aux'], skipHeader: true });
  });

  it('linux info: `ps aux --no-headers -p <pid>` (unchanged)', () => {
    expect(buildPsInfoArgs(42, 'linux')).toEqual({
      args: ['aux', '--no-headers', '-p', '42'],
      skipHeader: false,
    });
  });

  it('darwin info: explicit BSD -o column list reproducing the aux layout', () => {
    expect(buildPsInfoArgs(42, 'darwin')).toEqual({
      args: ['-ww', '-o', 'user,pid,%cpu,%mem,vsz,rss,tt,stat,start,time,command', '-p', '42'],
      skipHeader: true,
    });
  });

  it('linux top-processes: GNU `ps aux --no-headers --sort=-%cpu` (unchanged)', () => {
    expect(buildTopProcessesArgs('linux')).toEqual({
      args: ['aux', '--no-headers', '--sort=-%cpu'],
      skipHeader: false,
      sortInCode: false,
    });
  });

  it('darwin top-processes: BSD `ps aux`, header skipped + CPU-sorted in code', () => {
    expect(buildTopProcessesArgs('darwin')).toEqual({
      args: ['aux'],
      skipHeader: true,
      sortInCode: true,
    });
  });
});

// ---------------------------------------------------------------------------
// system.process execute-level wiring
// ---------------------------------------------------------------------------

describe('system.process list', () => {
  it('linux: invokes ps with GNU flags and parses every line', async () => {
    const restore = stubPlatform('linux');
    try {
      runCmdMock.mockResolvedValue({ stdout: `${PS_LINE_1}\n${PS_LINE_2}`, stderr: '', exitCode: 0 });
      const result = await processTool.execute({ operation: 'list' }, makeCtx());
      expect(runCmdMock).toHaveBeenCalledWith('ps', ['aux', '--no-headers'], expect.anything());
      expect(result.success).toBe(true);
      const { processes } = result.data as { processes: Array<{ pid: number }> };
      expect(processes.map((p) => p.pid)).toEqual([1, 234]);
    } finally {
      restore();
    }
  });

  it('darwin: invokes BSD `ps aux` and skips the header line', async () => {
    const restore = stubPlatform('darwin');
    try {
      runCmdMock.mockResolvedValue({
        stdout: `${PS_HEADER}\n${PS_LINE_1}\n${PS_LINE_2}`,
        stderr: '',
        exitCode: 0,
      });
      const result = await processTool.execute({ operation: 'list' }, makeCtx());
      expect(runCmdMock).toHaveBeenCalledWith('ps', ['aux'], expect.anything());
      expect(result.success).toBe(true);
      const { processes } = result.data as { processes: Array<{ pid: number; command: string }> };
      // Header line skipped — only the two real rows survive
      expect(processes.map((p) => p.pid)).toEqual([1, 234]);
      expect(processes[1]!.command).toBe('node server.js');
    } finally {
      restore();
    }
  });
});

describe('system.process info', () => {
  it('darwin: BSD -o invocation, ppid from `ps -o ppid=`, threads unavailable', async () => {
    const restore = stubPlatform('darwin');
    try {
      runCmdMock
        .mockResolvedValueOnce({ stdout: `${PS_HEADER}\n${PS_LINE_2}`, stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '  1', stderr: '', exitCode: 0 });
      const result = await processTool.execute({ operation: 'info', pid: 234 }, makeCtx());
      expect(runCmdMock).toHaveBeenNthCalledWith(
        1,
        'ps',
        ['-ww', '-o', 'user,pid,%cpu,%mem,vsz,rss,tt,stat,start,time,command', '-p', '234'],
        expect.anything(),
      );
      expect(runCmdMock).toHaveBeenNthCalledWith(2, 'ps', ['-p', '234', '-o', 'ppid='], expect.anything());
      expect(result.success).toBe(true);
      const { process: info } = result.data as {
        process: { pid: number; ppid?: number; threads?: number; cmdline?: string };
      };
      expect(info.pid).toBe(234);
      expect(info.ppid).toBe(1);
      expect(info.threads).toBeUndefined();
      expect(info.cmdline).toBe('node server.js');
    } finally {
      restore();
    }
  });

  it('linux: unchanged GNU invocation (no second ps call — details come from /proc)', async () => {
    const restore = stubPlatform('linux');
    try {
      runCmdMock.mockResolvedValue({ stdout: PS_LINE_2, stderr: '', exitCode: 0 });
      const result = await processTool.execute({ operation: 'info', pid: 234 }, makeCtx());
      expect(runCmdMock).toHaveBeenCalledTimes(1);
      expect(runCmdMock).toHaveBeenCalledWith(
        'ps',
        ['aux', '--no-headers', '-p', '234'],
        expect.anything(),
      );
      expect(result.success).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// system.monitor
// ---------------------------------------------------------------------------

describe('system.monitor top-processes', () => {
  it('linux: unchanged GNU invocation, no in-code sort', async () => {
    const restore = stubPlatform('linux');
    try {
      runCmdMock.mockResolvedValue({ stdout: `${PS_LINE_2}\n${PS_LINE_1}`, stderr: '', exitCode: 0 });
      const result = await monitorTool.execute({ operation: 'top-processes' }, makeCtx());
      expect(runCmdMock).toHaveBeenCalledWith('ps', ['aux', '--no-headers', '--sort=-%cpu'], expect.anything());
      const { processes } = result.data as { processes: Array<{ pid: number }> };
      // Order preserved exactly as ps emitted it (ps already sorted)
      expect(processes.map((p) => p.pid)).toEqual([234, 1]);
    } finally {
      restore();
    }
  });

  it('darwin: `ps aux` with header skipped and CPU-sort done in code', async () => {
    const restore = stubPlatform('darwin');
    try {
      // Unsorted input: low-CPU row first
      runCmdMock.mockResolvedValue({
        stdout: `${PS_HEADER}\n${PS_LINE_1}\n${PS_LINE_2}`,
        stderr: '',
        exitCode: 0,
      });
      const result = await monitorTool.execute({ operation: 'top-processes' }, makeCtx());
      expect(runCmdMock).toHaveBeenCalledWith('ps', ['aux'], expect.anything());
      const { processes } = result.data as { processes: Array<{ pid: number; cpu: number }> };
      // Sorted by CPU desc in code; header did not become a bogus row
      expect(processes.map((p) => p.pid)).toEqual([234, 1]);
      expect(processes[0]!.cpu).toBe(12.5);
    } finally {
      restore();
    }
  });
});

describe('system.monitor darwin metrics (no /proc)', () => {
  it('snapshot: real CPU/memory from node:os; disks/network explicitly unavailable', async () => {
    const restore = stubPlatform('darwin');
    try {
      const result = await monitorTool.execute({ operation: 'snapshot' }, makeCtx());
      expect(result.success).toBe(true);
      const data = result.data as {
        cpu: { usagePercent: number };
        memory: { totalKb: number; usedKb: number };
        disks: unknown[];
        network: unknown[];
        unavailable: string[];
      };
      // Genuine values, not silent zeros
      expect(data.memory.totalKb).toBeGreaterThan(0);
      expect(data.cpu.usagePercent).toBeGreaterThan(0);
      // Honest degradation is labeled
      expect(data.unavailable).toEqual(['disks', 'network']);
      expect(result.output).toContain('unavailable');
      // No shell commands for metrics
      expect(runCmdMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('uptime: from os.uptime()', async () => {
    const restore = stubPlatform('darwin');
    try {
      const result = await monitorTool.execute({ operation: 'uptime' }, makeCtx());
      expect(result.success).toBe(true);
      expect((result.data as { seconds: number }).seconds).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('load-average: from os.loadavg(); thread counts labeled unavailable', async () => {
    const restore = stubPlatform('darwin');
    try {
      const result = await monitorTool.execute({ operation: 'load-average' }, makeCtx());
      expect(result.success).toBe(true);
      const data = result.data as { load1: number; unavailable: string[] };
      expect(typeof data.load1).toBe('number');
      expect(data.unavailable).toEqual(['runningThreads', 'totalThreads', 'lastPid']);
    } finally {
      restore();
    }
  });
});

describe('system.monitor linux metrics (regression guard)', () => {
  it('snapshot still reads /proc and reports interfaces (no unavailable label)', async () => {
    const restore = stubPlatform('linux');
    try {
      const result = await monitorTool.execute({ operation: 'snapshot' }, makeCtx());
      expect(result.success).toBe(true);
      const data = result.data as { memory: { totalKb: number }; unavailable?: string[] };
      // This test runs on a real Linux box: /proc/meminfo yields a real total
      expect(data.memory.totalKb).toBeGreaterThan(0);
      expect(data.unavailable).toBeUndefined();
      expect(result.output).toContain('interfaces');
    } finally {
      restore();
    }
  });

  it('load-average still parses /proc/loadavg extras', async () => {
    const restore = stubPlatform('linux');
    try {
      const result = await monitorTool.execute({ operation: 'load-average' }, makeCtx());
      expect(result.success).toBe(true);
      const data = result.data as { totalThreads: number; unavailable?: string[] };
      expect(data.totalThreads).toBeGreaterThan(0);
      expect(data.unavailable).toBeUndefined();
    } finally {
      restore();
    }
  });
});
