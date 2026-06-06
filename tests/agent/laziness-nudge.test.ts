/**
 * @file laziness-nudge.test.ts
 * @description Tests for LazinessNudge.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LazinessNudge, LAZINESS_CADENCE, type LazinessClassification } from '../../src/core/agent/laziness-nudge.js';

describe('LazinessNudge', () => {
  let nudge: LazinessNudge;

  beforeEach(() => {
    nudge = new LazinessNudge(null);
  });

  it('should classify active turns with tool calls', () => {
    const result = nudge.classify(3, 'I made progress by editing the files.');
    expect(result.level).toBe('active');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.nudgeInjected).toBe(false);
  });

  it('should classify idle turns with no tool calls', () => {
    const result = nudge.classify(0, 'I think we should consider the approach...');
    expect(result.level).not.toBe('active');
    expect(result.idleTurnCount).toBe(1);
  });

  it('should escalate idle level with consecutive idle turns', () => {
    // Turn 1: idle
    let result = nudge.classify(0, 'Thinking about it...');
    expect(result.level).toBe('mild_idle');

    // Turn 2: still idle
    result = nudge.classify(0, 'Still thinking...');
    expect(result.idleTurnCount).toBe(2);

    // Turn 3: reaches cadence threshold
    result = nudge.classify(0, 'More thinking...');
    expect(['idle', 'mild_idle']).toContain(result.level);

    // More idle turns → very_idle
    for (let i = 0; i < LAZINESS_CADENCE * 2; i++) {
      nudge.classify(0, 'Just talking...');
    }
    result = nudge.classify(0, 'Still just talking...');
    expect(result.level).toBe('very_idle');
  });

  it('should reset idle counter when agent takes action', () => {
    nudge.classify(0, 'Idle turn');
    nudge.classify(0, 'Another idle turn');
    const result = nudge.classify(3, 'Now I\'m doing something!');
    expect(result.level).toBe('active');
    expect(result.idleTurnCount).toBe(0);
  });

  it('should inject nudge at high idle levels with sufficient confidence', () => {
    // Generate enough idle turns to reach threshold
    for (let i = 0; i < LAZINESS_CADENCE * 2; i++) {
      nudge.classify(0, 'Just text, no action');
    }
    const result = nudge.classify(0, 'Still just text...');
    expect(result.nudgeInjected).toBe(true);
  });

  it('should not inject nudge for active turns', () => {
    const result = nudge.classify(5, 'Making progress');
    expect(result.nudgeInjected).toBe(false);
  });

  it('should emit telemetry events via hooks', () => {
    const mockHooks = { emit: vi.fn() };
    const testNudge = new LazinessNudge(mockHooks);

    // Generate idle turns to trigger nudge
    for (let i = 0; i < LAZINESS_CADENCE * 2; i++) {
      testNudge.classify(0, 'Idle');
    }

    expect(mockHooks.emit).toHaveBeenCalledWith(
      'laziness_classifier_fired',
      expect.objectContaining({ event: 'laziness_classifier_fired' }),
    );
    expect(mockHooks.emit).toHaveBeenCalledWith(
      'laziness_nudge_fired',
      expect.objectContaining({ event: 'laziness_nudge_fired' }),
    );
  });

  it('should provide nudge messages for idle levels', () => {
    expect(nudge.getNudgeMessage('active')).toBe('');
    expect(nudge.getNudgeMessage('mild_idle')).toBeTruthy();
    expect(nudge.getNudgeMessage('idle')).toBeTruthy();
    expect(nudge.getNudgeMessage('very_idle')).toContain('CRITICAL');
  });

  it('should track stats', () => {
    nudge.classify(0, 'Idle');
    nudge.classify(0, 'Still idle');
    const stats = nudge.getStats();
    expect(stats.consecutiveIdleTurns).toBe(2);
  });

  it('should reset properly', () => {
    nudge.classify(0, 'Idle');
    nudge.reset();
    const stats = nudge.getStats();
    expect(stats.consecutiveIdleTurns).toBe(0);
  });
});