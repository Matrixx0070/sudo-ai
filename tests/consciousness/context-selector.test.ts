/**
 * Tests for ContextSelector — intent-based consciousness module selector.
 *
 * Covers: category mapping, max-module budget, formatted output,
 * selection stats, and graceful handling of missing modules.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextSelector, type ContextSelection } from '../../src/core/consciousness/context-selector.js';
import type { ConsciousnessOrchestrator } from '../../src/core/consciousness/orchestrator.js';

// ---------------------------------------------------------------------------
// Mock orchestrator
// ---------------------------------------------------------------------------

function makeMockOrchestrator(overrides: Partial<ConsciousnessOrchestrator> = {}): ConsciousnessOrchestrator {
  return {
    getConsciousnessContext: vi.fn().mockReturnValue('SelfModel: capability summary'),
    getState: vi.fn().mockReturnValue({
      isBooted: true,
      bodyState: { energy: 0.8, clarity: 0.6, sampledAt: '2026-01-01T00:00:00Z' },
      emotionalState: { dominantEmotion: 'curiosity', intensity: 0.5, tags: ['curiosity'] },
      dominantDrive: 'explore',
      thoughtCount: 3,
      isStreaming: false,
      isSleeping: false,
      lastInteraction: '2026-01-01T00:00:00Z',
    }),
    getDriveInfluenceForAgent: vi.fn().mockReturnValue({
      promptAddition: 'curiosity, mastery',
      temperatureDelta: 0.1,
    }),
    ...overrides,
  } as unknown as ConsciousnessOrchestrator;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextSelector', () => {
  let orchestrator: ConsciousnessOrchestrator;

  beforeEach(() => {
    orchestrator = makeMockOrchestrator();
  });

  // 1. Select for coding
  it('selects SelfModel, ProceduralMemory, Metacognition for coding', () => {
    const selector = new ContextSelector(orchestrator);
    const result = selector.select('coding', 'implement auth module');

    const primaryNames = result.primaryModules.map((m) => m.moduleName);
    expect(primaryNames).toContain('SelfModel');
    expect(primaryNames).toContain('ProceduralMemory');
    expect(primaryNames).toContain('Metacognition');
    const codingModules = result.primaryModules.filter((m) =>
      ['SelfModel', 'ProceduralMemory', 'Metacognition'].includes(m.moduleName),
    );
    expect(codingModules.every((m) => m.relevance === 1.0)).toBe(true);
  });

  // 2. Select for analysis
  it('selects WorldModel, EpisodicMemory, InternalDialogue for analysis', () => {
    const selector = new ContextSelector(orchestrator);
    const result = selector.select('analysis', 'evaluate market data');

    const primaryNames = result.primaryModules.map((m) => m.moduleName);
    expect(primaryNames).toContain('WorldModel');
    expect(primaryNames).toContain('EpisodicMemory');
    expect(primaryNames).toContain('InternalDialogue');
  });

  // 3. Select for research
  it('selects AttentionManager, SpreadingActivation, ProspectiveMemory for research', () => {
    const selector = new ContextSelector(orchestrator);
    const result = selector.select('research', 'investigate competitor stack');

    const primaryNames = result.primaryModules.map((m) => m.moduleName);
    expect(primaryNames).toContain('AttentionManager');
    expect(primaryNames).toContain('SpreadingActivation');
    expect(primaryNames).toContain('ProspectiveMemory');
  });

  // 4. Select for blocked
  it('selects security/trust modules for blocked', () => {
    const selector = new ContextSelector(orchestrator);
    const result = selector.select('blocked', 'access denied to resource');

    const primaryNames = result.primaryModules.map((m) => m.moduleName);
    expect(primaryNames).toContain('SecuritySignals');
    expect(primaryNames).toContain('TrustTier');
    expect(primaryNames).toContain('VetoGate');
  });

  // 5. Max modules — never exceeds configured max
  it('never exceeds configured max primary and secondary modules', () => {
    const selector = new ContextSelector(orchestrator, { maxPrimaryModules: 2, maxSecondaryModules: 1 });
    const result = selector.select('coding', 'write code');

    expect(result.primaryModules.length).toBeLessThanOrEqual(2);
    expect(result.secondaryModules.length).toBeLessThanOrEqual(1);
  });

  // 6. Format context — produces structured string with module details
  it('formats context as a structured string with body, primary, secondary, drives lines', () => {
    const selector = new ContextSelector(orchestrator);
    const selection = selector.select('coding', 'implement feature');
    const formatted = selector.formatContext(selection, orchestrator);

    expect(formatted).toContain('[Consciousness Context — coding]');
    expect(formatted).toContain('Body:');
    expect(formatted).toContain('energy');
    expect(formatted).toContain('clarity');
    expect(formatted).toMatch(/Mood:\s+curiosity/);
    expect(formatted).toContain('Primary:');
    expect(formatted).toContain('Secondary:');
    expect(formatted).toContain('Drives:');
  });

  // 7. Stats — tracks selection counts by category
  it('tracks selection counts by category', () => {
    const selector = new ContextSelector(orchestrator);
    selector.select('coding', 'a');
    selector.select('coding', 'b');
    selector.select('analysis', 'c');

    const stats = selector.getStats();
    expect(stats.totalSelections).toBe(3);
    expect(stats.byCategory.coding).toBe(2);
    expect(stats.byCategory.analysis).toBe(1);
    expect(stats.avgModulesSelected).toBeGreaterThan(0);
  });

  // 8. Empty orchestrator — handles missing modules gracefully
  it('throws TypeError when orchestrator is missing', () => {
    expect(() => new ContextSelector(null as unknown as ConsciousnessOrchestrator))
      .toThrow(TypeError);
  });

  it('handles orchestrator whose methods throw errors', () => {
    const brokenOrch = makeMockOrchestrator({
      getConsciousnessContext: vi.fn().mockImplementation(() => { throw new Error('not booted'); }),
      getState: vi.fn().mockReturnValue({
        isBooted: false,
        bodyState: null,
        emotionalState: null,
        dominantDrive: null,
        thoughtCount: 0,
        isStreaming: false,
        isSleeping: false,
        lastInteraction: null,
      }),
      getDriveInfluenceForAgent: vi.fn().mockImplementation(() => { throw new Error('no drives'); }),
    });

    const selector = new ContextSelector(brokenOrch);
    const selection = selector.select('coding', 'test');

    // Should still produce a selection
    expect(selection.primaryModules.length).toBeGreaterThan(0);

    // formatContext should not throw despite broken orchestrator methods
    const formatted = selector.formatContext(selection, brokenOrch);
    expect(formatted).toContain('[Consciousness Context');
    expect(formatted).toContain('Primary:');
  });

  it('falls back to default modules for unknown category', () => {
    const selector = new ContextSelector(orchestrator);
    const result = selector.select('unknown_cat', 'something');

    const primaryNames = result.primaryModules.map((m) => m.moduleName);
    // Default modules: BodyState, EmotionalState, DriveManager
    expect(primaryNames).toContain('BodyState');
    expect(primaryNames).toContain('EmotionalState');
    expect(primaryNames).toContain('DriveManager');
  });
});