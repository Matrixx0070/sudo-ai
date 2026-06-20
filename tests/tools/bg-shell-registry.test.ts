/**
 * @file bg-shell-registry.test.ts
 * @description Unit tests for the background-shell ProcessRegistry + RingBuffer +
 * registration gating (gap #10). No real process spawn — a fake ChildProcess
 * EventEmitter drives the registry.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RingBuffer } from '../../src/core/tools/builtin/system/bg-shell/process-registry.js';
import * as reg from '../../src/core/tools/builtin/system/bg-shell/process-registry.js';
import { registerSystemTools } from '../../src/core/tools/builtin/system/index.js';
import type { ToolRegistry } from '../../src/core/tools/registry.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(pid = 1234): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = pid;
  c.kill = vi.fn();
  return c;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function track(shellId: string, sessionId: string, child: FakeChild): reg.ShellHandle {
  return reg.track({ shellId, sessionId, command: 'x', child: child as any, pgid: null, sandboxed: true });
}

afterEach(() => { reg._resetForTest(); vi.restoreAllMocks(); });

describe('RingBuffer', () => {
  it('RB-1: drops oldest bytes past the cap and counts dropped/missed', () => {
    const rb = new RingBuffer(10);
    rb.append(Buffer.from('0123456789'));
    rb.append(Buffer.from('ABCDE'));
    expect(rb.total).toBe(15);
    expect(rb.dropped).toBe(5);
    expect(rb.readFrom(0).text).toBe('56789ABCDE');
    expect(rb.readFrom(0).missed).toBe(5);
  });

  it('RB-2: cursor returns only new bytes', () => {
    const rb = new RingBuffer(100);
    rb.append(Buffer.from('hello'));
    expect(rb.readFrom(0).text).toBe('hello');
    rb.append(Buffer.from('world'));
    expect(rb.readFrom(5).text).toBe('world');
    expect(rb.readFrom(5).missed).toBe(0);
  });
});

describe('ProcessRegistry', () => {
  it('PR-1: buffers stdout/stderr; readNew advances the cursor', () => {
    const c = fakeChild();
    const h = track('s1', 'sess', c);
    c.stdout.emit('data', Buffer.from('out1'));
    c.stderr.emit('data', Buffer.from('err1'));
    let r = reg.readNew(h);
    expect(r.stdout).toBe('out1');
    expect(r.stderr).toBe('err1');
    r = reg.readNew(h);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    c.stdout.emit('data', Buffer.from('out2'));
    expect(reg.readNew(h).stdout).toBe('out2');
  });

  it('PR-2: child exit sets status + exitCode', () => {
    const c = fakeChild();
    const h = track('s2', 'sess', c);
    expect(h.status).toBe('running');
    c.emit('exit', 7);
    expect(h.status).toBe('exited');
    expect(h.exitCode).toBe(7);
  });

  it('PR-3: runningCount reflects live shells', () => {
    for (let i = 0; i < 3; i++) track(`c${i}`, 'sess', fakeChild());
    expect(reg.runningCount()).toBe(3);
  });

  it('PR-4: killSession scopes by session and marks killed', () => {
    const c1 = fakeChild();
    const c2 = fakeChild();
    track('k1', 'A', c1);
    track('k2', 'B', c2);
    expect(reg.killSession('A')).toBe(1);
    expect(c1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(c2.kill).not.toHaveBeenCalled();
    expect(reg.get('k1')?.status).toBe('killed');
    expect(reg.runningCount()).toBe(1);
  });

  it('PR-5: killAll kills every running shell', () => {
    const c1 = fakeChild();
    const c2 = fakeChild();
    track('a1', 'A', c1);
    track('a2', 'B', c2);
    expect(reg.killAll()).toBe(2);
    expect(c1.kill).toHaveBeenCalled();
    expect(c2.kill).toHaveBeenCalled();
    expect(reg.runningCount()).toBe(0);
  });
});

describe('registration gating (SUDO_BG_SHELL)', () => {
  async function registeredNames(flag: string | undefined): Promise<string[]> {
    const saved = process.env['SUDO_BG_SHELL'];
    if (flag === undefined) delete process.env['SUDO_BG_SHELL'];
    else process.env['SUDO_BG_SHELL'] = flag;
    const out: string[] = [];
    const stub = { register: (t: { name: string }) => out.push(t.name) } as unknown as ToolRegistry;
    await registerSystemTools(stub); // reads the flag synchronously before the dynamic import
    if (saved === undefined) delete process.env['SUDO_BG_SHELL'];
    else process.env['SUDO_BG_SHELL'] = saved;
    return out;
  }

  it('REG-1: flag OFF registers no system.shell.* tools', async () => {
    expect((await registeredNames(undefined)).filter((n) => n.startsWith('system.shell.'))).toEqual([]);
  });

  it('REG-2: flag ON registers start/poll/kill', async () => {
    const shellTools = (await registeredNames('1')).filter((n) => n.startsWith('system.shell.')).sort();
    expect(shellTools).toEqual(['system.shell.kill', 'system.shell.poll', 'system.shell.start']);
  });
});
