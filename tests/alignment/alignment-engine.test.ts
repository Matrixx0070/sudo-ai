/**
 * Tests for AlignmentEngine — 7-signal alignment engine.
 * Covers signals, overall score, thresholds, recommendations, history, stats.
 */
import { describe, it, expect } from 'vitest';
import { AlignmentEngine } from '../../src/core/alignment/alignment-engine.js';
import type { BrainMessage } from '../../src/core/brain/types.js';

const msg = (role: BrainMessage['role'], content: string, tc?: any): BrainMessage =>
  ({ role, content, ...(tc ? { toolCalls: tc } : {}) });
const ctx = { recentMessages: [] as BrainMessage[], sessionId: 's1', category: 'general' };

const failTraces = Array.from({ length: 50 }, () => ({
  traceType: 'brain_call' as const, model: 'm-a', success: false,
}));
const redDeps = {
  securityGuard: { detectInjection: () => ({ safe: false, threat: 'high', score: 1.0 }), getReport: () => ({ totalEvents: 100 }) } as any,
  taintTracker: { size: 200 } as any,
  traceStore: { getAggregates: () => [{ key: 'test', totalCalls: 100, successCount: 5, avgLatencyMs: 5000 }], query: () => failTraces } as any,
};
const redCfg = { harmfulnessPatterns: [/kill/i, /murder/i, /suicide/i, /bomb/i], coherenceCheckInterval: 0 };
const redMsgs = [msg('user', 'kill murder suicide bomb'), msg('assistant', 'The sky is flat and water is dry.')];

// 1. Coherence
describe('computeCoherence', () => {
  it('returns 0-1 score', async () => {
    const v = await new AlignmentEngine({ brain: { chat: () => Promise.resolve('7') } as any })
      .computeCoherence([msg('assistant', 'Hello')]);
    expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
  });
  it('returns 0.7 heuristic when no brain', async () => {
    expect(await new AlignmentEngine().computeCoherence([msg('assistant', 'Test')])).toBe(0.7);
  });
});

// 2. Harmfulness
describe('computeHarmfulness', () => {
  it('returns 1.0 for clean input', () => {
    expect(new AlignmentEngine().computeHarmfulness([msg('user', 'Weather?')])).toBe(1.0);
  });
  it('penalizes harmful patterns', () => {
    expect(new AlignmentEngine().computeHarmfulness([msg('user', 'illegal drug manufacturing')])).toBeLessThan(1.0);
  });
  it('returns 1.0 for empty input', () => {
    expect(new AlignmentEngine().computeHarmfulness([])).toBe(1.0);
  });
});

// 3. Truthfulness
describe('computeTruthfulness', () => {
  it('returns 1.0 with no assistant messages', async () => {
    expect(await new AlignmentEngine().computeTruthfulness([msg('user', 'Hi')])).toBe(1.0);
  });
  it('falls back to 0.7 without brain', async () => {
    expect(await new AlignmentEngine().computeTruthfulness([msg('assistant', 'Pop is 8 billion.')])).toBe(0.7);
  });
  it('returns 0-1 from brain verification', async () => {
    const brain = { chat: () => Promise.resolve('{"verified": 3, "total": 5}') } as any;
    const v = await new AlignmentEngine({ brain }).computeTruthfulness([msg('assistant', 'Earth is 4.5B years old.')]);
    expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
  });
});

// 4. Helpfulness
describe('computeHelpfulness', () => {
  it('returns 0.7 without trace store', async () => {
    expect(await new AlignmentEngine().computeHelpfulness('s1', 'gen')).toBe(0.7);
  });
  it('computes weighted success rate', async () => {
    const ts = { getAggregates: () => [
      { key: 'general', totalCalls: 100, successCount: 80, avgLatencyMs: 50 },
      { key: 'general-v2', totalCalls: 50, successCount: 45, avgLatencyMs: 40 },
    ] } as any;
    expect(await new AlignmentEngine({ traceStore: ts }).computeHelpfulness('s1', 'general')).toBeCloseTo(0.833, 2);
  });
  it('returns 0.7 with no matching category', async () => {
    const ts = { getAggregates: () => [{ key: 'coding', totalCalls: 10, successCount: 8, avgLatencyMs: 100 }] } as any;
    expect(await new AlignmentEngine({ traceStore: ts }).computeHelpfulness('s1', 'medical')).toBe(0.7);
  });
});

// 5. Safety
describe('computeSafety', () => {
  it('returns 0.8 baseline with no deps', () => {
    expect(new AlignmentEngine().computeSafety()).toBe(0.8);
  });
  it('penalizes SecurityGuard events', () => {
    const sg = { detectInjection: () => ({ safe: true, threat: null, score: 0 }), getReport: () => ({ totalEvents: 50 }) } as any;
    expect(new AlignmentEngine({ securityGuard: sg }).computeSafety()).toBeLessThan(1.0);
  });
  it('penalizes TaintTracker size', () => {
    expect(new AlignmentEngine({ taintTracker: { size: 80 } as any }).computeSafety()).toBeLessThan(1.0);
  });
});

// 6. Stability
describe('computeStability', () => {
  it('returns 0.8 without trace store', () => {
    expect(new AlignmentEngine().computeStability()).toBe(0.8);
  });
  it('returns 0.9 with no recent traces', () => {
    expect(new AlignmentEngine({ traceStore: { query: () => [] } as any }).computeStability()).toBe(0.9);
  });
  it('is low when errors frequent', () => {
    const traces = Array.from({ length: 10 }, (_, i) => ({ traceType: 'tool_call', model: null, success: i < 3 }));
    expect(new AlignmentEngine({ traceStore: { query: () => traces } as any }).computeStability()).toBeLessThan(0.5);
  });
});

// 7. Alignment
describe('computeAlignment', () => {
  it('returns 1.0 with no assistant messages', () => {
    expect(new AlignmentEngine().computeAlignment([msg('user', 'Go')])).toBe(1.0);
  });
  it('scores goal-aligned messages higher', () => {
    expect(new AlignmentEngine().computeAlignment([msg('assistant', 'I have completed the task. Here is the result:')])).toBeGreaterThan(0);
  });
  it('scores tool-carrying messages as aligned', () => {
    const v = new AlignmentEngine().computeAlignment([
      msg('assistant', 'Working.', [{ id: '1', type: 'function', function: { name: 't', arguments: '{}' } }] as any),
    ]);
    expect(v).toBe(1.0);
  });
});

// 8. Overall score
describe('overall weighted score', () => {
  it('computes weighted sum from all 7 signals', async () => {
    const r = await new AlignmentEngine({ config: { coherenceCheckInterval: 0 } })
      .computeSignals({ ...ctx, recentMessages: [msg('user', 'Hello')] });
    const e = 0.23 * 0.7 + 0.23 * 1.0 + 0.14 * 1.0 + 0.14 * 0.7 + 0.13 * 0.8 + 0.08 * 0.8 + 0.05 * 1.0;
    expect(r.overall).toBeCloseTo(e, 3);
  });
  it('returns exactly 7 signals', async () => {
    const r = await new AlignmentEngine().computeSignals({ ...ctx, recentMessages: [msg('user', 'Hi')] });
    expect(r.signals).toHaveLength(7);
  });
});

// 9. Level thresholds
describe('level thresholds', () => {
  it('maps >= 0.70 to GREEN', async () => {
    const r = await new AlignmentEngine({ brain: { chat: () => Promise.resolve('10') } as any, config: { coherenceCheckInterval: 0 } })
      .computeSignals({ ...ctx, recentMessages: [msg('user', 'Good')] });
    expect(r.level).toBe('GREEN');
  });
  it('maps 0.45-0.69 to YELLOW', async () => {
    const r = await new AlignmentEngine({ config: redCfg })
      .computeSignals({ ...ctx, recentMessages: [msg('user', 'kill murder suicide bomb')] });
    expect(r.level).toBe('YELLOW');
  });
  it('maps < 0.45 to RED', async () => {
    const r = await new AlignmentEngine({ ...redDeps, config: redCfg })
      .computeSignals({ recentMessages: redMsgs, sessionId: 's1', category: 'test' });
    expect(r.level).toBe('RED');
  });
});

// 10. RED recommendation
describe('RED recommendation', () => {
  it('includes actionable text when RED', async () => {
    const r = await new AlignmentEngine({ ...redDeps, config: redCfg })
      .computeSignals({ recentMessages: redMsgs, sessionId: 's1', category: 'test' });
    expect(r.level).toBe('RED');
    expect(r.recommendation).toBeDefined();
    expect(r.recommendation).toContain('RED');
    expect(r.recommendation).toContain('Recommend');
  });
  it('omits recommendation when not RED', async () => {
    const r = await new AlignmentEngine().computeSignals({ ...ctx, recentMessages: [msg('user', 'Hello')] });
    expect(r.recommendation).toBeUndefined();
  });
});

// 11. History tracking
describe('history tracking', () => {
  it('stores computed scores', async () => {
    const e = new AlignmentEngine();
    await e.computeSignals({ ...ctx, recentMessages: [msg('user', 'A')] });
    await e.computeSignals({ ...ctx, recentMessages: [msg('user', 'B')] });
    expect(e.getSignalHistory()).toHaveLength(2);
  });
  it('respects limit parameter', async () => {
    const e = new AlignmentEngine();
    for (let i = 0; i < 5; i++) await e.computeSignals({ ...ctx, recentMessages: [msg('user', `${i}`)] });
    expect(e.getSignalHistory(2)).toHaveLength(2);
  });
});

// 12. Stats
describe('stats', () => {
  it('tracks totalComputations and byLevel', async () => {
    const e = new AlignmentEngine();
    await e.computeSignals({ ...ctx, recentMessages: [msg('user', 'X')] });
    await e.computeSignals({ ...ctx, recentMessages: [msg('user', 'Y')] });
    const s = e.getStats();
    expect(s.totalComputations).toBe(2);
    expect(s.avgScore).toBeGreaterThanOrEqual(0); expect(s.avgScore).toBeLessThanOrEqual(1);
    expect(s.byLevel.GREEN + s.byLevel.YELLOW + s.byLevel.RED).toBe(2);
  });
  it('computes avgScore correctly', async () => {
    const e = new AlignmentEngine();
    const r1 = await e.computeSignals({ ...ctx, recentMessages: [msg('user', '1')] });
    const r2 = await e.computeSignals({ ...ctx, recentMessages: [msg('user', '2')] });
    expect(e.getStats().avgScore).toBeCloseTo((r1.overall + r2.overall) / 2, 5);
  });
});