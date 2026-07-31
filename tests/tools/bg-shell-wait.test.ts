/**
 * @file bg-shell-wait.test.ts
 * @description Blocking wait on system.shell.poll — the one capability
 * sudo-ai's background tasks lacked versus Claude Code's BashOutput
 * (`block: true`, `timeout`). Without it the agent must busy-poll, burning a
 * turn per check; with it, "wait for this build to say something" is one call.
 *
 * Registry handles are driven by a fake ChildProcess (same idiom as
 * bg-shell-registry.test.ts) so no real process is spawned and the tool's
 * approval gate is not involved — what is under test is the wait logic.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as reg from '../../src/core/tools/builtin/system/bg-shell/process-registry.js';
import { BG_SHELL_TOOLS } from '../../src/core/tools/builtin/system/bg-shell/index.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(pid = 4321): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = pid;
  c.kill = vi.fn();
  return c;
}

const pollTool = BG_SHELL_TOOLS.find((t) => t.name === 'system.shell.poll')!;
const ctx = { sessionId: 'wait-test' } as never;

function track(shellId: string, child: FakeChild): reg.ShellHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return reg.track({ shellId, sessionId: 'wait-test', command: 'x', child: child as any, pgid: null, sandboxed: true });
}

afterEach(() => {
  reg._resetForTest();
  vi.restoreAllMocks();
});

describe('system.shell.poll — blocking wait', () => {
  it('declares the waitMs parameter and a timeout that outlives the max wait', () => {
    expect(pollTool.parameters['waitMs']).toBeDefined();
    expect(pollTool.parameters['waitMs']!.required).not.toBe(true); // opt-in
    // A blocking poll must not be killed by the tool deadline before it returns.
    expect(pollTool.timeout!).toBeGreaterThan(120_000);
  });

  it('without waitMs it returns immediately even while the shell is silent', async () => {
    const child = fakeChild();
    track('sh-1', child);
    const t0 = Date.now();
    const r = await pollTool.execute({ shellId: 'sh-1' }, ctx);
    expect(Date.now() - t0).toBeLessThan(120); // non-blocking, unchanged contract
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>)['status']).toBe('running');
    expect(String(r.output)).toContain('(no new output)');
  });

  it('with waitMs it returns as soon as output arrives, not after the full wait', async () => {
    const child = fakeChild();
    track('sh-2', child);
    setTimeout(() => child.stdout.emit('data', Buffer.from('BUILD DONE')), 300);

    const t0 = Date.now();
    const r = await pollTool.execute({ shellId: 'sh-2', waitMs: 5_000 }, ctx);
    const elapsed = Date.now() - t0;

    expect(String(r.output)).toContain('BUILD DONE');
    expect(elapsed).toBeGreaterThanOrEqual(250); // it really waited
    expect(elapsed).toBeLessThan(2_000); // but returned early, not at 5s
  });

  it('returns as soon as the shell EXITS, even with no output', async () => {
    const child = fakeChild();
    track('sh-3', child);
    setTimeout(() => child.emit('exit', 0, null), 250);

    const t0 = Date.now();
    const r = await pollTool.execute({ shellId: 'sh-3', waitMs: 5_000 }, ctx);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(2_000);
    expect((r.data as Record<string, unknown>)['status']).not.toBe('running');
  });

  it('gives up at waitMs when nothing ever happens (bounded, reports waitedMs)', async () => {
    const child = fakeChild();
    track('sh-4', child);
    const t0 = Date.now();
    const r = await pollTool.execute({ shellId: 'sh-4', waitMs: 400 }, ctx);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(2_000);
    expect((r.data as Record<string, unknown>)['waitedMs']).toBeGreaterThan(0);
    expect(String(r.output)).toContain('(no new output)');
  });

  it('clamps a hostile waitMs instead of holding the turn open forever', async () => {
    const child = fakeChild();
    track('sh-5', child);
    setTimeout(() => child.emit('exit', 0, null), 200);
    // Absurd request: must be clamped to MAX_WAIT_MS, and the exit ends it anyway.
    const t0 = Date.now();
    await pollTool.execute({ shellId: 'sh-5', waitMs: 999_999_999 }, ctx);
    expect(Date.now() - t0).toBeLessThan(3_000);

    // Negative / NaN degrade to non-blocking rather than throwing.
    const child2 = fakeChild();
    track('sh-6', child2);
    const t1 = Date.now();
    await pollTool.execute({ shellId: 'sh-6', waitMs: -5 }, ctx);
    await pollTool.execute({ shellId: 'sh-6', waitMs: Number.NaN }, ctx);
    expect(Date.now() - t1).toBeLessThan(300);
  });
});
