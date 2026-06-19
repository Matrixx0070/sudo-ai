/**
 * @file tests/consciousness/heartbeat-wraprunner.test.ts
 * @description Integration test for HeartbeatRunner.wrapRunner — the per-task
 * orchestration the live cron path was wired to use (cli.ts). Exercises the full
 * gate sequence against a real (temp-redirected) HEARTBEAT.md with a fake base
 * runner (no LLM): per-task interval due-filtering, skip-when-none-due, live
 * message rebuild, task-state persistence, and HEARTBEAT_OK suppression.
 *
 * The workspace is redirected via SUDO_AI_HOME in vi.hoisted (runs before the
 * imports below resolve their module-const paths), so wrapRunner's hard-wired
 * HEARTBEAT_FILE / PATHS.WORKSPACE point at a throwaway temp dir.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const { root: ROOT, priorHome: PRIOR_HOME } = vi.hoisted(() => {
  const base = (process.env['TMPDIR'] || '/tmp').replace(/\/+$/, '');
  const root = `${base}/sudo-hb-wraprunner-test`;
  const priorHome = process.env['SUDO_AI_HOME'];
  process.env['SUDO_AI_HOME'] = root;
  // Ensure no quiet-hours window suppresses ticks during the test.
  delete process.env['HEARTBEAT_ACTIVE_START'];
  delete process.env['HEARTBEAT_ACTIVE_END'];
  return { root, priorHome };
});

import { HeartbeatRunner, type HeartbeatPayloadRunner } from '../../src/core/cron/heartbeat.js';
import { PATHS } from '../../src/core/shared/constants.js';

const WS = path.resolve(ROOT, 'workspace');
const HB = path.resolve(WS, 'HEARTBEAT.md');
const STATE = path.resolve(WS, 'memory', 'heartbeat-task-state.json');

const MD = [
  '---',
  'tasks:',
  '  - name: system-health',
  '    interval: 30m',
  '  - name: cost-check',
  '    interval: 1h',
  '  - name: task-sweep',
  '    interval: 2h',
  '---',
  '',
  '# Heartbeat',
  'body',
  '',
].join('\n');

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
function setState(s: Record<string, string>): void {
  writeFileSync(STATE, JSON.stringify(s), 'utf8');
}
function clearState(): void {
  if (existsSync(STATE)) rmSync(STATE);
}

/** Build a fresh wrapped runner with a tracking fake base. */
function makeWrapped(response: string) {
  const hb = new HeartbeatRunner({} as never, {} as never); // store/scheduler unused by wrapRunner
  const tracker = { calls: 0, lastMessage: '' };
  const base: HeartbeatPayloadRunner = async (payload) => {
    tracker.calls++;
    tracker.lastMessage = payload.kind === 'agentTurn' ? payload.message : '';
    return response;
  };
  return { run: hb.wrapRunner(base), tracker };
}

const JOB = { id: 'hb-test', name: 'system.heartbeat', payload: { kind: 'agentTurn', message: 'x' } } as never;
const PAYLOAD = { kind: 'agentTurn', message: 'x' } as never;
const dueOf = (msg: string) => msg.match(/Due tasks this tick: (.*)/)?.[1] ?? '';

describe('HeartbeatRunner.wrapRunner — per-task orchestration', () => {
  beforeAll(() => {
    mkdirSync(path.join(WS, 'memory'), { recursive: true });
    writeFileSync(HB, MD, 'utf8');
  });
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    // Restore the process-global env so the redirect can't leak into other
    // test files sharing this worker.
    if (PRIOR_HOME === undefined) delete process.env['SUDO_AI_HOME'];
    else process.env['SUDO_AI_HOME'] = PRIOR_HOME;
  });
  beforeEach(() => clearState());

  it('WR-0: workspace redirect took effect', () => {
    expect(PATHS.WORKSPACE).toBe(WS);
    expect(existsSync(HB)).toBe(true);
  });

  it('WR-1: cold start (no state) → all tasks due, base runs, state persisted', async () => {
    const { run, tracker } = makeWrapped('did some work');
    await run(PAYLOAD, JOB);
    expect(tracker.calls).toBe(1);
    expect(dueOf(tracker.lastMessage).split(', ').sort())
      .toEqual(['cost-check', 'system-health', 'task-sweep']);
    // markTasksRun persisted all three.
    expect(existsSync(STATE)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(STATE, 'utf8'))).sort())
      .toEqual(['cost-check', 'system-health', 'task-sweep']);
  });

  it('WR-2: only the 30m task is due after 30m elapsed (per-task filtering)', async () => {
    setState({ 'system-health': iso(40 * 60_000), 'cost-check': iso(0), 'task-sweep': iso(0) });
    const { run, tracker } = makeWrapped('health checked');
    await run(PAYLOAD, JOB);
    expect(tracker.calls).toBe(1);
    expect(dueOf(tracker.lastMessage)).toBe('system-health');
  });

  it('WR-3: nothing due → tick skipped, base never runs', async () => {
    setState({ 'system-health': iso(0), 'cost-check': iso(0), 'task-sweep': iso(0) });
    const { run, tracker } = makeWrapped('should not run');
    const result = await run(PAYLOAD, JOB);
    expect(tracker.calls).toBe(0);
    expect(result).toBeUndefined();
  });

  it('WR-4: HEARTBEAT_OK response is suppressed (base runs, returns void)', async () => {
    const { run, tracker } = makeWrapped('HEARTBEAT_OK');
    const result = await run(PAYLOAD, JOB);
    expect(tracker.calls).toBe(1);
    expect(result).toBeUndefined();
  });

  it('WR-5: a substantive response passes through', async () => {
    const { run } = makeWrapped('found a failing job, restarting it');
    const result = await run(PAYLOAD, JOB);
    expect(result).toBe('found a failing job, restarting it');
  });
});
