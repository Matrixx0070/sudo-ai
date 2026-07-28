/**
 * @file al6-policy-resolver.test.ts
 * @description AL6.2-6.5 adaptive policy seam (docs/OPUS_HANDOFF_AGENTIC_LADDER.md):
 *   - every decision logged with its inputs through the sink;
 *   - AL6.3 workload adaptation with HYSTERESIS — the flap test walks queue
 *     depth across the enter/exit band and asserts the latch never flaps;
 *   - AL6.4 intent routing (heuristic classification extracted from the
 *     cheap-model-router with behavior preserved — its 21 existing tests
 *     stay green);
 *   - AL6.5 shadow mode: decisions computed + logged, marked not-applied.
 */

import { describe, it, expect } from 'vitest';
import {
  PolicyResolver,
  type PolicyDecisionEntry,
} from '../../src/core/agent/policy-resolver.js';
import { chooseModel, classifyIntent } from '../../src/core/agent/cheap-model-router.js';

const collect = () => {
  const entries: PolicyDecisionEntry[] = [];
  return { entries, sink: (e: PolicyDecisionEntry) => entries.push(e) };
};

describe('AL6.2 policy resolver — one seam, every decision logged', () => {
  it('routes by intent and logs decision + inputs through the sink', () => {
    const { entries, sink } = collect();
    const r = new PolicyResolver({ onDecision: sink, shadow: false });

    const agentic = r.resolve({ intent: 'agentic' });
    expect(agentic).toMatchObject({ route: 'reasoning', reasoningDepth: 'deep', maxRetries: 3, concurrency: 4 });
    const chat = r.resolve({ intent: 'conversational' });
    expect(chat).toMatchObject({ route: 'cheap', reasoningDepth: 'standard' });
    const unknown = r.resolve({});
    expect(unknown.route).toBe('reasoning'); // conservative default

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ signals: { intent: 'agentic' }, shedding: false });
    expect(entries[0]!.decision.reasons.join(' ')).toContain('intent "agentic" → route reasoning');
    expect(entries[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('a hard-failing route stops burning retries', () => {
    const r = new PolicyResolver({ shadow: false });
    expect(r.resolve({ intent: 'agentic', recentFailureRate: 0.6 }).maxRetries).toBe(1);
    expect(r.resolve({ intent: 'agentic', recentFailureRate: 0.2 }).maxRetries).toBe(3);
  });

  it('rejects inverted hysteresis thresholds at construction (fail-loud)', () => {
    expect(() => new PolicyResolver({ loadHigh: 3, loadLow: 8 })).toThrow(/low < high/);
  });
});

describe('AL6.3 workload adaptation — hysteresis, no flapping', () => {
  it('sheds under load: cheap-routes eligible steps, lowers concurrency, defers background', () => {
    const r = new PolicyResolver({ loadHigh: 8, loadLow: 3, shadow: false });
    const shed = r.resolve({ intent: 'conversational', queueDepth: 9 });
    expect(shed).toMatchObject({
      route: 'cheap',
      concurrency: 2,
      maxRetries: 1,
      deferBackground: true,
      reasoningDepth: 'shallow',
    });
    // Agentic work keeps the strong route even while shedding.
    const agenticShed = r.resolve({ intent: 'agentic', queueDepth: 9 });
    expect(agenticShed.route).toBe('reasoning');
    expect(agenticShed.reasoningDepth).toBe('standard'); // depth trimmed, route kept
  });

  it('FLAP TEST: the latch enters at high, holds through the band, exits at low — never flaps', () => {
    const r = new PolicyResolver({ loadHigh: 8, loadLow: 3, shadow: false });
    const latchAt = (queueDepth: number): boolean => {
      r.resolve({ intent: 'conversational', queueDepth });
      return r.isShedding();
    };

    expect(latchAt(7)).toBe(false); // below high — calm
    expect(latchAt(8)).toBe(true);  // enter
    expect(latchAt(5)).toBe(true);  // inside the band — HOLDS (no flap)
    expect(latchAt(4)).toBe(true);  // still inside — HOLDS
    expect(latchAt(3)).toBe(false); // exit at low
    expect(latchAt(5)).toBe(false); // back inside the band from below — STAYS calm
    expect(latchAt(7)).toBe(false); // still calm below high
    expect(latchAt(9)).toBe(true);  // re-enter only at/above high
  });

  it('budget pressure trips the same latch', () => {
    const r = new PolicyResolver({ budgetHigh: 0.9, budgetLow: 0.7, shadow: false });
    r.resolve({ budgetPressure: 0.95 });
    expect(r.isShedding()).toBe(true);
    r.resolve({ budgetPressure: 0.8 }); // inside band — holds
    expect(r.isShedding()).toBe(true);
    r.resolve({ budgetPressure: 0.6 });
    expect(r.isShedding()).toBe(false);
  });
});

describe('AL6.4 intent adaptation — classification is data, logged, evaluable', () => {
  it('classifyIntent mirrors the router guards exactly and chooseModel carries the intent', () => {
    expect(classifyIntent({ userText: 'thanks!', history: [] })).toEqual({
      intent: 'conversational',
      reason: 'simple conversational turn',
    });
    expect(classifyIntent({ userText: 'please debug the deploy pipeline', history: [] }).intent).toBe('agentic');
    expect(classifyIntent({ userText: '', history: [] }).intent).toBe('unknown');
    expect(
      classifyIntent({ userText: 'ok', history: [{ role: 'assistant', toolCalls: [{}] }] }).intent,
    ).toBe('agentic');

    const routed = chooseModel({
      userText: 'thanks!',
      history: [],
      primaryModel: 'primary-x',
      cheapModel: 'cheap-x',
    });
    expect(routed).toMatchObject({ model: 'cheap-x', cheapUsed: true, intent: 'conversational' });
  });
});

describe('AL6.5 shadow mode — computed and logged, never applied', () => {
  it('marks decisions shadow via option and via env, and still logs them', () => {
    const { entries, sink } = collect();
    const r = new PolicyResolver({ onDecision: sink, shadow: true });
    const d = r.resolve({ intent: 'conversational', queueDepth: 9 });
    expect(d.shadow).toBe(true);
    expect(d.route).toBe('cheap'); // fully computed — the shadow log is real data
    expect(entries).toHaveLength(1);

    const prev = process.env['SUDO_AL_POLICY_SHADOW'];
    process.env['SUDO_AL_POLICY_SHADOW'] = '1';
    try {
      expect(new PolicyResolver().resolve({}).shadow).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['SUDO_AL_POLICY_SHADOW'];
      else process.env['SUDO_AL_POLICY_SHADOW'] = prev;
    }
  });

  it('a sink that throws never breaks the decision path', () => {
    const r = new PolicyResolver({
      onDecision: () => {
        throw new Error('sink down');
      },
      shadow: false,
    });
    expect(() => r.resolve({ intent: 'agentic' })).not.toThrow();
  });
});
