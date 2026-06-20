/**
 * @file tests/learning/replay-engine.test.ts
 * @description Deterministic replay over captured traces (audit #5). Seeds a real
 * TraceStore under SUDO_TRACE_CAPTURE=1, then verifies the engine re-feeds tool
 * outputs by (tool, args) in capture order, pins sampling from brain calls,
 * detects divergence, and drives a replay tool executor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';
import { TraceStore } from '../../src/core/learning/trace-store.js';
import {
  ReplayEngine,
  makeReplayToolExecutor,
  ReplayMissError,
} from '../../src/core/learning/replay-engine.js';

let tmpDir: string;
let store: TraceStore;
let savedFlag: string | undefined;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `sudo-replay-${Date.now()}-${Math.floor(performance.now())}`);
  mkdirSync(tmpDir, { recursive: true });
  savedFlag = process.env['SUDO_TRACE_CAPTURE'];
  process.env['SUDO_TRACE_CAPTURE'] = '1'; // capture raw payloads
  store = new TraceStore(path.join(tmpDir, 'traces.db'));
  await store.init();
});
afterEach(() => {
  try { store.close(); } catch { /* ignore */ }
  if (savedFlag === undefined) delete process.env['SUDO_TRACE_CAPTURE']; else process.env['SUDO_TRACE_CAPTURE'] = savedFlag;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ReplayEngine', () => {
  it('R-1: re-feeds the captured tool output keyed by (tool, args)', async () => {
    store.recordToolCall('s1', 'search', true, 5, undefined, { q: 'cats' }, { rows: ['a', 'b'] });
    const engine = ReplayEngine.fromSession(store, 's1');
    expect(engine.isReplayable).toBe(true);
    const hit = engine.nextToolResult('search', { q: 'cats' });
    expect(hit.hit).toBe(true);
    expect(hit.result).toEqual({ rows: ['a', 'b'] });
  });

  it('R-2: a different tool or different args is a miss (divergence)', async () => {
    store.recordToolCall('s1', 'search', true, 5, undefined, { q: 'cats' }, { rows: [] });
    const engine = ReplayEngine.fromSession(store, 's1');
    expect(engine.nextToolResult('search', { q: 'dogs' }).hit).toBe(false); // different args
    expect(engine.nextToolResult('fetch', { q: 'cats' }).hit).toBe(false);  // different tool
  });

  it('R-3: repeated identical calls replay distinct outputs in order, then exhaust', async () => {
    store.recordToolCall('s1', 'roll', true, 1, undefined, { sides: 6 }, 4);
    store.recordToolCall('s1', 'roll', true, 1, undefined, { sides: 6 }, 2);
    const engine = ReplayEngine.fromSession(store, 's1');
    expect(engine.nextToolResult('roll', { sides: 6 }).result).toBe(4);
    expect(engine.nextToolResult('roll', { sides: 6 }).result).toBe(2);
    const third = engine.nextToolResult('roll', { sides: 6 });
    expect(third.hit).toBe(false);
    expect(third.exhausted).toBe(true);
    engine.reset();
    expect(engine.nextToolResult('roll', { sides: 6 }).result).toBe(4); // rewound
  });

  it('R-4: pins sampling parsed from a captured brain call', async () => {
    store.recordBrainCall('s1', 'anthropic/claude', true, 0, undefined, undefined, {
      prompt: [{ role: 'user', content: 'hi' }],
      response: { content: 'hello', toolCalls: [] },
      modelParams: { model: 'anthropic/claude', temperature: 0.5, maxTokens: 4096 },
    });
    const engine = ReplayEngine.fromSession(store, 's1');
    const s = engine.sampling(0);
    expect(s).toMatchObject({ model: 'anthropic/claude', temperature: 0.5, maxTokens: 4096 });
    expect(engine.brainSteps()[0]!.response).toEqual({ content: 'hello', toolCalls: [] });
  });

  it('R-5: steps are chronological and exclude routing traces', async () => {
    store.recordToolCall('s1', 'a', true, 1, undefined, { n: 1 }, 'r1');
    store.recordRouting('s1', 'm', 'fast', 'keyword', 0.5); // ignored by replay
    store.recordToolCall('s1', 'b', true, 1, undefined, { n: 2 }, 'r2');
    const engine = ReplayEngine.fromSession(store, 's1');
    expect(engine.steps().map((s) => (s.kind === 'tool' ? s.toolName : 'brain'))).toEqual(['a', 'b']);
  });

  it('R-6: verifyToolSequence matches identical runs and flags divergence', async () => {
    store.recordToolCall('s1', 'a', true, 1, undefined, { n: 1 }, 'r1');
    store.recordToolCall('s1', 'b', true, 1, undefined, { n: 2 }, 'r2');
    const engine = ReplayEngine.fromSession(store, 's1');

    expect(engine.verifyToolSequence([{ toolName: 'a', args: { n: 1 } }, { toolName: 'b', args: { n: 2 } }]))
      .toEqual({ matched: true });

    const diverged = engine.verifyToolSequence([{ toolName: 'a', args: { n: 1 } }, { toolName: 'b', args: { n: 99 } }]);
    expect(diverged.matched).toBe(false);
    expect(diverged.divergedAt).toBe(1);

    const missing = engine.verifyToolSequence([{ toolName: 'a', args: { n: 1 } }]);
    expect(missing.matched).toBe(false);
    expect(missing.reason).toContain('missing 1');
  });

  it('R-7: makeReplayToolExecutor returns captured results and throws on miss', async () => {
    store.recordToolCall('s1', 'search', true, 5, undefined, { q: 'cats' }, { rows: 2 });
    const exec = makeReplayToolExecutor(ReplayEngine.fromSession(store, 's1'));
    await expect(exec('search', { q: 'cats' })).resolves.toEqual({ rows: 2 });
    await expect(exec('search', { q: 'cats' })).rejects.toBeInstanceOf(ReplayMissError); // exhausted
    await expect(exec('search', { q: 'dogs' })).rejects.toBeInstanceOf(ReplayMissError); // never captured
  });

  it('R-9: a pinned seed in captured model params is surfaced for replay', async () => {
    store.recordBrainCall('s1', 'xai/grok', true, 0, undefined, undefined, {
      prompt: [{ role: 'user', content: 'roll' }],
      response: { content: '4', toolCalls: [] },
      modelParams: { model: 'xai/grok', temperature: 0.7, maxTokens: 1024, seed: 12345 },
    });
    const engine = ReplayEngine.fromSession(store, 's1');
    expect(engine.sampling(0)?.seed).toBe(12345);
  });

  it('R-8: capture OFF → not replayable (no raw payloads to re-feed)', async () => {
    delete process.env['SUDO_TRACE_CAPTURE'];
    store.recordToolCall('s2', 'search', true, 5, undefined, { q: 'x' }, { rows: 1 });
    const engine = ReplayEngine.fromSession(store, 's2');
    expect(engine.isReplayable).toBe(false);
    expect(engine.nextToolResult('search', { q: 'x' }).hit).toBe(false);
  });
});
