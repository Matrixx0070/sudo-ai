/**
 * @file tests/agent/predictor-loop.test.ts
 * @description Opt-in Predictive Intelligence injection (SUDO_PREDICTOR_LOOP).
 * On the first user turn of a session, the loop runs Predictor.anticipate() and
 * injects high-confidence predictions as a '# HEADS UP' advisory system message.
 * Default OFF (no anticipation, no injection); fail-open on any error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainResponse } from '../../src/core/brain/types.js';
import type { Prediction } from '../../src/core/prediction/predictor.js';

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});
function makeLoop(brain: ReturnType<typeof createMockBrain>) {
  return new AgentLoop(brain, createMockToolRegistry(), createMockSessionManager(), undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());
}
function stop(content = 'done'): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}
function pred(p: Partial<Prediction>): Prediction {
  return {
    id: 'id', type: 'schedule', prediction: 'something', confidence: 0.9,
    reasoning: 'because', suggestedAction: undefined, outcome: 'pending',
    createdAt: '2026-06-08T00:00:00.000Z', ...p,
  };
}
function fakePredictor(predictions: Prediction[]) {
  return { anticipate: vi.fn(async () => predictions) };
}
function headsUp(brain: ReturnType<typeof createMockBrain>): string | undefined {
  const msgs = (brain.call.mock.calls[0]?.[0]?.messages ?? []) as Array<{ content?: unknown }>;
  const m = msgs.find((x) => typeof x.content === 'string' && x.content.includes('# HEADS UP'));
  return m?.content as string | undefined;
}

describe('Predictive Intelligence loop injection (SUDO_PREDICTOR_LOOP)', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['SUDO_PREDICTOR_LOOP']; delete process.env['SUDO_PREDICTOR_LOOP']; });
  afterEach(() => { if (saved === undefined) delete process.env['SUDO_PREDICTOR_LOOP']; else process.env['SUDO_PREDICTOR_LOOP'] = saved; });

  it('PRED-off: flag off → anticipate not called, no heads-up injected', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const fp = fakePredictor([pred({ prediction: 'Upload window approaches', confidence: 0.9 })]);
    const loop = makeLoop(brain);
    loop.setPredictor(fp);
    await loop.run('test-session-id', 'hi');
    expect(fp.anticipate).not.toHaveBeenCalled();
    expect(headsUp(brain)).toBeUndefined();
  });

  it('PRED-on: high-confidence predictions injected; low-confidence filtered out', async () => {
    process.env['SUDO_PREDICTOR_LOOP'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const fp = fakePredictor([
      pred({ prediction: 'Upload window approaches', confidence: 0.9, suggestedAction: 'Verify renders are complete' }),
      pred({ prediction: 'LOW-CONF noise', confidence: 0.5 }),
    ]);
    const loop = makeLoop(brain);
    loop.setPredictor(fp);
    await loop.run('test-session-id', 'hi');
    expect(fp.anticipate).toHaveBeenCalledTimes(1);
    const hu = headsUp(brain);
    expect(hu).toBeDefined();
    expect(hu).toContain('Upload window approaches');
    expect(hu).toContain('Verify renders are complete');
    expect(hu).not.toContain('LOW-CONF noise');
  });

  it('PRED-cap: at most MAX_PREDICTOR_INJECTED (3) predictions injected, highest-confidence first', async () => {
    process.env['SUDO_PREDICTOR_LOOP'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const fp = fakePredictor([
      pred({ prediction: 'P-A', confidence: 0.95 }),
      pred({ prediction: 'P-B', confidence: 0.90 }),
      pred({ prediction: 'P-C', confidence: 0.85 }),
      pred({ prediction: 'P-D', confidence: 0.82 }),
    ]);
    const loop = makeLoop(brain);
    loop.setPredictor(fp);
    await loop.run('test-session-id', 'hi');
    const hu = headsUp(brain) ?? '';
    expect(hu).toContain('P-A');
    expect(hu).toContain('P-B');
    expect(hu).toContain('P-C');
    expect(hu).not.toContain('P-D'); // 4th dropped by the cap
  });

  it('PRED-boundary: confidence exactly at the 0.8 threshold is included; just below is excluded', async () => {
    process.env['SUDO_PREDICTOR_LOOP'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const fp = fakePredictor([
      pred({ prediction: 'AT-THRESHOLD', confidence: 0.8 }),
      pred({ prediction: 'BELOW-THRESHOLD', confidence: 0.79 }),
    ]);
    const loop = makeLoop(brain);
    loop.setPredictor(fp);
    await loop.run('test-session-id', 'hi');
    const hu = headsUp(brain) ?? '';
    expect(hu).toContain('AT-THRESHOLD');
    expect(hu).not.toContain('BELOW-THRESHOLD');
  });

  it('PRED-none: flag on but all predictions below threshold → no heads-up', async () => {
    process.env['SUDO_PREDICTOR_LOOP'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const fp = fakePredictor([pred({ prediction: 'meh', confidence: 0.4 })]);
    const loop = makeLoop(brain);
    loop.setPredictor(fp);
    await loop.run('test-session-id', 'hi');
    expect(fp.anticipate).toHaveBeenCalledTimes(1);
    expect(headsUp(brain)).toBeUndefined();
  });

  it('PRED-failopen: anticipate throwing does not break the turn', async () => {
    process.env['SUDO_PREDICTOR_LOOP'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const fp = { anticipate: vi.fn(async () => { throw new Error('mind.db unavailable'); }) };
    const loop = makeLoop(brain);
    loop.setPredictor(fp);
    await loop.run('test-session-id', 'hi'); // must not throw
    expect(fp.anticipate).toHaveBeenCalledTimes(1);
    expect(headsUp(brain)).toBeUndefined();
    expect(brain.call).toHaveBeenCalled(); // the turn still ran
  });
});
