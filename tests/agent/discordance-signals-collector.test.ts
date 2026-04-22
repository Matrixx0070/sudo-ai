/**
 * Tests for discordance-signals-collector — Wave 6E Builder A.
 *
 * Covers the collector happy path, empty state, and malformed input scenarios.
 */

import { describe, it, expect } from 'vitest';
import {
  collectDiscordanceSignals,
  type LoopState,
} from '../../src/core/agent/discordance-signals-collector.js';
import type { DiscordanceSignals } from '../../src/core/security/discordance-detector.js';

// ---------------------------------------------------------------------------
// Collector: happy path (all fields populated)
// ---------------------------------------------------------------------------

describe('Collector happy path — all fields provided', () => {
  it('maps iteration to callsInWindow and baseline to 10', () => {
    const state: LoopState = {
      iteration: 5,
      activeToolNames: ['bash', 'read', 'bash'],
      recentOutcomeTypes: ['success', 'error'],
      lastAssistantText: 'I will proceed with the task.',
    };
    const signals: DiscordanceSignals = collectDiscordanceSignals(state);

    expect(signals.cadence.callsInWindow).toBe(5);
    expect(signals.cadence.baselineCallsPerWindow).toBe(10);
    expect(signals.toolGraph.recentToolNames).toEqual(['bash', 'read', 'bash']);
    expect(signals.outcomeTrend.recentOutcomeTypes).toEqual(['success', 'error']);
    expect(signals.selfReport.text).toBe('I will proceed with the task.');
  });

  it('returns a pure value without mutating input state', () => {
    const state: LoopState = {
      iteration: 3,
      activeToolNames: ['write'],
      recentOutcomeTypes: [],
      lastAssistantText: 'done',
    };
    const originalNames = state.activeToolNames!.slice();
    collectDiscordanceSignals(state);
    expect(state.activeToolNames).toEqual(originalNames);
  });
});

// ---------------------------------------------------------------------------
// Collector: empty state → neutral zeros
// ---------------------------------------------------------------------------

describe('Collector empty state — optional fields absent', () => {
  it('returns neutral zeros when only iteration is provided', () => {
    const state: LoopState = { iteration: 2 };
    const signals = collectDiscordanceSignals(state);

    expect(signals.cadence.callsInWindow).toBe(2);
    expect(signals.cadence.baselineCallsPerWindow).toBe(10);
    expect(signals.toolGraph.recentToolNames).toEqual([]);
    expect(signals.outcomeTrend.recentOutcomeTypes).toEqual([]);
    expect(signals.selfReport.text).toBe('');
  });

  it('returns neutral zeros for iteration=0', () => {
    const state: LoopState = { iteration: 0 };
    const signals = collectDiscordanceSignals(state);

    expect(signals.cadence.callsInWindow).toBe(0);
    expect(signals.toolGraph.recentToolNames).toEqual([]);
    expect(signals.selfReport.text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Collector: malformed input → neutral zeros
// ---------------------------------------------------------------------------

describe('Collector malformed input — graceful fail-open', () => {
  it('undefined state → neutral zeros, no throw', () => {
    let signals: DiscordanceSignals;
    expect(() => {
      signals = collectDiscordanceSignals(undefined as unknown as LoopState);
    }).not.toThrow();
    // @ts-expect-error — assigned in callback
    expect(signals.cadence.callsInWindow).toBe(0);
    // @ts-expect-error
    expect(signals.toolGraph.recentToolNames).toEqual([]);
    // @ts-expect-error
    expect(signals.selfReport.text).toBe('');
  });

  it('null state → neutral zeros, no throw', () => {
    let signals: DiscordanceSignals;
    expect(() => {
      signals = collectDiscordanceSignals(null as unknown as LoopState);
    }).not.toThrow();
    // @ts-expect-error
    expect(signals.cadence.callsInWindow).toBe(0);
  });

  it('non-finite iteration (NaN) → callsInWindow=0', () => {
    const state: LoopState = { iteration: NaN };
    const signals = collectDiscordanceSignals(state);
    expect(signals.cadence.callsInWindow).toBe(0);
  });

  it('non-finite iteration (Infinity) → callsInWindow=0', () => {
    const state: LoopState = { iteration: Infinity };
    const signals = collectDiscordanceSignals(state);
    expect(signals.cadence.callsInWindow).toBe(0);
  });

  it('activeToolNames with non-string entries → filtered out', () => {
    const state = {
      iteration: 1,
      activeToolNames: ['bash', null, 42, 'read', undefined] as unknown as string[],
    } as LoopState;
    const signals = collectDiscordanceSignals(state);
    expect(signals.toolGraph.recentToolNames).toEqual(['bash', 'read']);
  });

  it('lastAssistantText non-string → empty string', () => {
    const state = {
      iteration: 1,
      lastAssistantText: 42 as unknown as string,
    } as LoopState;
    const signals = collectDiscordanceSignals(state);
    expect(signals.selfReport.text).toBe('');
  });

  it('recentOutcomeTypes not an array → empty array', () => {
    const state = {
      iteration: 1,
      recentOutcomeTypes: 'not-an-array' as unknown as string[],
    } as LoopState;
    const signals = collectDiscordanceSignals(state);
    expect(signals.outcomeTrend.recentOutcomeTypes).toEqual([]);
  });
});
