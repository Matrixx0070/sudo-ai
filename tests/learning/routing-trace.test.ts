/**
 * P0 #6 — the routing trace must reflect the real message, not a constant.
 *
 * Before, the agent loop recorded category:'fast'/tier:'keyword'/confidence:0.5
 * on every brain call regardless of input, so the learning flywheel saw
 * identical routing rows. deriveRoutingTrace derives all three from the real
 * keyword classifier.
 */

import { describe, it, expect } from 'vitest';
import { deriveRoutingTrace } from '../../src/core/learning/routing-trace.js';

describe('deriveRoutingTrace (P0 #6)', () => {
  it('classifies casual conversation as the fast lane', () => {
    const t = deriveRoutingTrace('hey, how are you?');
    expect(t.category).toBe('fast');
    expect(t.tier).toBe('keyword');
  });

  it('classifies a team-spawn build request as coding with high confidence', () => {
    const t = deriveRoutingTrace('build an app that tracks my expenses');
    expect(t.category).toBe('coding');
    expect(t.confidence).toBeGreaterThan(0.8);
  });

  it('produces DIFFERENT traces for different inputs (not a constant)', () => {
    const chat = deriveRoutingTrace('hi');
    const build = deriveRoutingTrace('build a website');
    // The whole bug was every row being identical; assert they diverge.
    expect(chat).not.toEqual(build);
    expect(chat.category).not.toBe(build.category);
  });

  it('always returns a valid IntentCategory / RoutingTier / numeric confidence', () => {
    for (const text of ['', 'analyze this dataset and write a report', 'run the tests', 'x'.repeat(300)]) {
      const t = deriveRoutingTrace(text);
      expect(['coding', 'analysis', 'research', 'fast', 'blocked']).toContain(t.category);
      expect(['dfa', 'keyword', 'llm']).toContain(t.tier);
      expect(t.confidence).toBeGreaterThan(0);
      expect(t.confidence).toBeLessThanOrEqual(1);
    }
  });
});
