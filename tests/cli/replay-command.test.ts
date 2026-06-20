/**
 * @file tests/cli/replay-command.test.ts
 * @description Tests for the `sudo-ai replay` command — orphan wiring of the
 * ReplayEngine over captured TraceStore sessions.
 *
 *   1. buildReplayReport summarizes a captured session (tool+brain steps, replayable, sampling)
 *   2. scopes strictly to the requested session
 *   3. an unknown session reports empty + not replayable
 *   4. runReplay returns 2 (usage) when no sessionId is given
 *   5. runReplay returns 0 for a valid session
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceStore } from '../../src/core/learning/trace-store.js';
import { buildReplayReport, runReplay } from '../../src/cli/commands/replay.js';

let tmpDir: string;
let dbPath: string;
let savedCapture: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  dbPath = path.join(tmpDir, 'traces.db');
  // Raw args/result are captured only under SUDO_TRACE_CAPTURE=1 — required to
  // make the seeded traces re-feedable (replayable).
  savedCapture = process.env['SUDO_TRACE_CAPTURE'];
  process.env['SUDO_TRACE_CAPTURE'] = '1';
});

afterEach(() => {
  if (savedCapture === undefined) delete process.env['SUDO_TRACE_CAPTURE'];
  else process.env['SUDO_TRACE_CAPTURE'] = savedCapture;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seed(): Promise<TraceStore> {
  const store = new TraceStore(dbPath);
  await store.init();
  store.recordToolCall('sess-A', 'coder.grep', true, 5, undefined, { pattern: 'foo' }, 'match: foo');
  store.recordToolCall('sess-A', 'system.exec', true, 12, undefined, { command: 'echo hi' }, 'hi');
  store.recordBrainCall('sess-A', 'opus', true, 200, undefined, undefined, {
    prompt: 'p', response: 'r', modelParams: { temperature: 0.7, model: 'opus' },
  });
  store.recordToolCall('sess-OTHER', 'browser.fetch', true, 9, undefined, { url: 'x' }, 'body');
  return store;
}

describe('replay command', () => {
  it('buildReplayReport summarizes a captured session', async () => {
    const store = await seed();
    const r = buildReplayReport(store, 'sess-A');
    store.close();
    expect(r.replayable).toBe(true);
    expect(r.toolStepCount).toBe(2);
    expect(r.brainStepCount).toBe(1);
    expect(r.toolSequence.map((t) => t.toolName)).toEqual(['coder.grep', 'system.exec']);
    expect(r.toolSequence.every((t) => t.hasResult)).toBe(true);
    expect(r.sampling?.temperature).toBe(0.7);
  });

  it('scopes strictly to the requested session', async () => {
    const store = await seed();
    const r = buildReplayReport(store, 'sess-OTHER');
    store.close();
    expect(r.toolStepCount).toBe(1);
    expect(r.toolSequence[0]!.toolName).toBe('browser.fetch');
  });

  it('reports an unknown session as empty + not replayable', async () => {
    const store = await seed();
    const r = buildReplayReport(store, 'does-not-exist');
    store.close();
    expect(r.replayable).toBe(false);
    expect(r.toolStepCount).toBe(0);
    expect(r.brainStepCount).toBe(0);
  });

  it('runReplay returns 2 (usage) when no sessionId is given', async () => {
    const code = await runReplay(['--json']);
    expect(code).toBe(2);
  });

  it('runReplay returns 0 for a valid session', async () => {
    (await seed()).close();
    const code = await runReplay(['sess-A', '--db', dbPath, '--json']);
    expect(code).toBe(0);
  });

  it('runReplay returns 2 when --db has no path argument (trailing or flag-like)', async () => {
    expect(await runReplay(['sess-A', '--db'])).toBe(2);
    expect(await runReplay(['sess-A', '--db', '--json'])).toBe(2);
  });
});
