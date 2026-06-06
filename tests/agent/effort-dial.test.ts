/**
 * @file tests/agent/effort-dial.test.ts
 * @description Tests for the EffortDial effort-level controller.
 *
 * Tests:
 *   ED-1  Default level is medium
 *   ED-2  setLevel('low') returns low preset values
 *   ED-3  setLevel('high') returns high preset values
 *   ED-4  Custom overrides supersede preset values
 *   ED-5  override() merges with existing overrides
 *   ED-6  resetOverrides() clears overrides, keeps level
 *   ED-7  getConfig returns a unique id on each call after mutation
 *   ED-8  State persists across EffortDial instances sharing session settings
 *   ED-9  setLevel with invalid level throws TypeError
 *   ED-10 Negative thinkingTokens override throws RangeError
 *   ED-11 Invalid verificationDepth override throws TypeError
 *   ED-12 Standalone convenience functions work on default singleton
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  EffortDial,
  setLevel,
  getLevel,
  getThinkingTokens,
  getMaxToolTurns,
  getVerificationDepth,
  getSubagentCount,
  getPricing,
  type EffortDialOverrides,
} from '../../src/core/agent/effort-dial.js';

// ---------------------------------------------------------------------------
// Instance tests (fresh Map per test)
// ---------------------------------------------------------------------------

describe('EffortDial', () => {
  let settings: Map<string, unknown>;
  let dial: EffortDial;

  beforeEach(() => {
    settings = new Map();
    dial = new EffortDial(settings);
  });

  // ED-1: Default level is medium
  it('ED-1: defaults to medium level', () => {
    expect(dial.getLevel()).toBe('medium');
    expect(dial.getThinkingTokens()).toBe(10_000);
    expect(dial.getMaxToolTurns()).toBe(15);
    expect(dial.getVerificationDepth()).toBe('basic');
    expect(dial.getSubagentCount()).toBe(3);
    expect(dial.getPricing()).toBe(1.0);
  });

  // ED-2: setLevel('low') returns low preset values
  it('ED-2: low level returns low preset values', () => {
    dial.setLevel('low');
    expect(dial.getLevel()).toBe('low');
    expect(dial.getThinkingTokens()).toBe(1_000);
    expect(dial.getMaxToolTurns()).toBe(5);
    expect(dial.getVerificationDepth()).toBe('none');
    expect(dial.getSubagentCount()).toBe(1);
    expect(dial.getPricing()).toBe(0.5);
  });

  // ED-3: setLevel('high') returns high preset values
  it('ED-3: high level returns high preset values', () => {
    dial.setLevel('high');
    expect(dial.getLevel()).toBe('high');
    expect(dial.getThinkingTokens()).toBe(50_000);
    expect(dial.getMaxToolTurns()).toBe(50);
    expect(dial.getVerificationDepth()).toBe('adversarial');
    expect(dial.getSubagentCount()).toBe(10);
    expect(dial.getPricing()).toBe(2.0);
  });

  // ED-4: Custom overrides supersede preset values
  it('ED-4: custom overrides supersede preset values', () => {
    dial.setLevel('medium', { thinkingTokens: 25_000, subagentCount: 5 });
    expect(dial.getThinkingTokens()).toBe(25_000);
    expect(dial.getSubagentCount()).toBe(5);
    // Non-overridden fields come from medium preset
    expect(dial.getMaxToolTurns()).toBe(15);
    expect(dial.getVerificationDepth()).toBe('basic');
    expect(dial.getPricing()).toBe(1.0);
  });

  // ED-5: override() merges with existing overrides
  it('ED-5: override() merges with existing overrides', () => {
    dial.setLevel('low', { thinkingTokens: 2_000 });
    dial.override({ subagentCount: 4 });
    expect(dial.getThinkingTokens()).toBe(2_000); // from initial override
    expect(dial.getSubagentCount()).toBe(4);      // from merged override
    // Non-overridden fields from low preset
    expect(dial.getMaxToolTurns()).toBe(5);
    expect(dial.getVerificationDepth()).toBe('none');
  });

  // ED-6: resetOverrides() clears overrides, keeps level
  it('ED-6: resetOverrides() clears overrides but keeps the current level', () => {
    dial.setLevel('high', { thinkingTokens: 99_000, maxToolTurns: 99 });
    expect(dial.getThinkingTokens()).toBe(99_000);
    dial.resetOverrides();
    // Back to pure high preset
    expect(dial.getLevel()).toBe('high');
    expect(dial.getThinkingTokens()).toBe(50_000);
    expect(dial.getMaxToolTurns()).toBe(50);
  });

  // ED-7: getConfig returns a unique id on each call after mutation
  it('ED-7: getConfig returns unique id after each level change', () => {
    const config1 = dial.getConfig();
    dial.setLevel('low');
    const config2 = dial.getConfig();
    expect(config1.id).not.toBe(config2.id);
    // Calling getConfig again without mutation returns cached id
    const config3 = dial.getConfig();
    expect(config2.id).toBe(config3.id);
  });

  // ED-8: State persists across EffortDial instances sharing session settings
  it('ED-8: state persists across instances sharing the same session settings Map', () => {
    dial.setLevel('high', { subagentCount: 7 });
    // Create a new EffortDial from the same settings map
    const dial2 = new EffortDial(settings);
    expect(dial2.getLevel()).toBe('high');
    expect(dial2.getSubagentCount()).toBe(7);
    expect(dial2.getThinkingTokens()).toBe(50_000);
  });

  // ED-9: setLevel with invalid level throws TypeError
  it('ED-9: setLevel with invalid level throws TypeError', () => {
    expect(() => dial.setLevel('ultra' as any)).toThrow(TypeError);
    expect(() => dial.setLevel('' as any)).toThrow(TypeError);
  });

  // ED-10: Negative thinkingTokens override throws RangeError
  it('ED-10: negative thinkingTokens override throws RangeError', () => {
    expect(() => dial.setLevel('medium', { thinkingTokens: -1 })).toThrow(RangeError);
    expect(() => dial.override({ thinkingTokens: -100 })).toThrow(RangeError);
  });

  // ED-11: Invalid verificationDepth override throws TypeError
  it('ED-11: invalid verificationDepth override throws TypeError', () => {
    expect(() =>
      dial.setLevel('medium', { verificationDepth: 'extreme' as any })
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Standalone convenience function tests
// ---------------------------------------------------------------------------

describe('EffortDial standalone functions', () => {
  beforeEach(() => {
    // Reset the default singleton to a known state
    setLevel('medium');
  });

  // ED-12: Standalone convenience functions work on default singleton
  it('ED-12: standalone functions operate on the default singleton', () => {
    expect(getLevel()).toBe('medium');
    setLevel('low');
    expect(getLevel()).toBe('low');
    expect(getThinkingTokens()).toBe(1_000);
    expect(getMaxToolTurns()).toBe(5);
    expect(getVerificationDepth()).toBe('none');
    expect(getSubagentCount()).toBe(1);
    expect(getPricing()).toBe(0.5);

    // Switch to high and verify all fields
    setLevel('high');
    expect(getThinkingTokens()).toBe(50_000);
    expect(getMaxToolTurns()).toBe(50);
    expect(getVerificationDepth()).toBe('adversarial');
    expect(getSubagentCount()).toBe(10);
    expect(getPricing()).toBe(2.0);
  });
});