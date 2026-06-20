/**
 * @file bg-shell-realproc.test.ts
 * @description Real-process integration tests for the background-shell tools
 * (gap #10). Uses Branch A (no sandbox policy on ctx → raw detached /bin/bash),
 * so it runs deterministically in CI without bwrap. Exec/sandbox features have a
 * history of unit tests missing exit-code/tree-kill bugs a live process catches.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult } from '../../src/core/tools/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let dir: string;

type Registry = typeof import('../../src/core/tools/builtin/system/bg-shell/process-registry.js');
interface Tools { start: ToolDefinition; poll: ToolDefinition; kill: ToolDefinition; reg: Registry }

async function loadTools(env: Record<string, string>): Promise<Tools> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const mod = await import('../../src/core/tools/builtin/system/bg-shell/index.js');
  const reg = await import('../../src/core/tools/builtin/system/bg-shell/process-registry.js');
  const find = (n: string): ToolDefinition => {
    const t = mod.BG_SHELL_TOOLS.find((x) => x.name === n);
    if (!t) throw new Error(`tool ${n} not found`);
    return t;
  };
  return { start: find('system.shell.start'), poll: find('system.shell.poll'), kill: find('system.shell.kill'), reg };
}

function ctx(): ToolContext {
  // No sandboxPolicy → useSandbox=false → Branch A (raw detached bash).
  // Unique sessionId per call so a future killSession test can't cross-kill.
  return { sessionId: randomUUID(), workingDir: dir, config: {}, logger: {} } as ToolContext;
}

const data = (r: ToolResult): Record<string, unknown> => (r.data ?? {}) as Record<string, unknown>;

beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'bg-shell-it-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('background shell — real process (Branch A)', () => {
  let T: Tools;
  beforeAll(async () => { T = await loadTools({ EXEC_APPROVAL_MODE: 'off' }); });
  afterEach(() => { T.reg.killAll(); });

  it('IT-1: streams output incrementally and reports exit 0', async () => {
    const r = await T.start.execute({ command: 'for i in 1 2 3; do echo $i; sleep 0.2; done' }, ctx());
    expect(r.success).toBe(true);
    const shellId = data(r)['shellId'] as string;
    expect(shellId).toBeTruthy();

    let acc = '';
    let status = 'running';
    for (let i = 0; i < 40 && status === 'running'; i++) {
      await sleep(100);
      const p = await T.poll.execute({ shellId }, ctx());
      acc += (data(p)['stdout'] as string) ?? '';
      status = data(p)['status'] as string;
    }
    const final = await T.poll.execute({ shellId }, ctx());
    acc += (data(final)['stdout'] as string) ?? '';

    const lines = acc.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(lines).toEqual(['1', '2', '3']); // ordered, complete
    expect(data(final)['status']).toBe('exited');
    expect(data(final)['exitCode']).toBe(0);
  }, 15_000);

  it('IT-2: kill stops the process and leaves no live pid', async () => {
    const r = await T.start.execute({ command: 'while true; do echo tick; sleep 0.1; done' }, ctx());
    const shellId = data(r)['shellId'] as string;
    const pid = T.reg.get(shellId)?.child.pid;
    expect(typeof pid).toBe('number');

    let seen = false;
    for (let i = 0; i < 30 && !seen; i++) {
      await sleep(100);
      const p = await T.poll.execute({ shellId }, ctx());
      if (((data(p)['stdout'] as string) ?? '').includes('tick')) seen = true;
    }
    expect(seen).toBe(true);

    await T.kill.execute({ shellId }, ctx());
    // SIGTERM, then SIGKILL after KILL_GRACE_MS (3s). Poll the pid up to ~5s so the
    // assertion tolerates the full grace window on a loaded CI host (no flake).
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      await sleep(100);
      try { process.kill(pid as number, 0); } catch { gone = true; }
    }
    expect(gone).toBe(true); // whole process group terminated, no orphan
    const p = await T.poll.execute({ shellId }, ctx());
    expect(['killed', 'exited']).toContain(data(p)['status']);
  }, 20_000);

  it('IT-3: refuses to start past the concurrency cap', async () => {
    const ids: string[] = [];
    for (let i = 0; i < T.reg.MAX_CONCURRENT; i++) {
      const r = await T.start.execute({ command: 'sleep 30' }, ctx());
      ids.push(data(r)['shellId'] as string);
    }
    const over = await T.start.execute({ command: 'sleep 30' }, ctx());
    expect(over.success).toBe(false);
    expect(over.output).toMatch(/limit reached/i);
    expect(data(over)['shellId']).toBeUndefined();
  }, 15_000);
});

describe('background shell — approval no-leak', () => {
  it('IT-4: a strict-mode command with no approver expires to pending and leaks NO process', async () => {
    const T = await loadTools({
      EXEC_APPROVAL_MODE: 'strict',
      EXEC_APPROVAL_WAIT_MS: '300',
      SUDO_AI_HOME: dir,
      DATA_DIR: dir,
    });
    const before = T.reg.runningCount();
    const r = await T.start.execute({ command: 'sleep 30' }, ctx());
    expect(r.success).toBe(false);
    expect(data(r)['decision']).toBe('pending'); // expired → pending, never spawned
    expect(data(r)['shellId']).toBeUndefined();
    expect(T.reg.runningCount()).toBe(before); // CRITICAL: no handle created
    T.reg.killAll();
  }, 10_000);
});
