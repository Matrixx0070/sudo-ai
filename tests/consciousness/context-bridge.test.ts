/**
 * Tests for ConsciousnessBridge — budget-aware consciousness context injection.
 *
 * Covers: detail tiers at different context-window occupancies, prompt injection
 * positioning, token estimation, bridge history tracking, and aggregate stats.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsciousnessBridge, type BridgeInjection } from '../../src/core/consciousness/context-bridge.js';
import type { ContextSelector, ContextSelection } from '../../src/core/consciousness/context-selector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSelection(overrides: Partial<ContextSelection> = {}): ContextSelection {
  return {
    primaryModules: [
      { moduleName: 'SelfModel', relevance: 1.0, reason: 'core self-knowledge' },
      { moduleName: 'ProceduralMemory', relevance: 0.9, reason: 'skill recall' },
      { moduleName: 'Metacognition', relevance: 0.8, reason: 'self-reflection' },
    ],
    secondaryModules: [
      { moduleName: 'EpisodicMemory', relevance: 0.5, reason: 'past context' },
    ],
    budget: 2000,
    ...overrides,
  };
}

function makeMockSelector(selection?: ContextSelection): ContextSelector {
  const sel = selection ?? makeSelection();
  return {
    select: vi.fn().mockReturnValue(sel),
    formatContext: vi.fn(),
    getStats: vi.fn(),
  } as unknown as ContextSelector;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsciousnessBridge', () => {
  let selector: ContextSelector;

  beforeEach(() => {
    selector = makeMockSelector();
  });

  // 1. Bridge at 30% context: Full detail injection
  it('injects full detail when context window is at 30%', () => {
    const bridge = new ConsciousnessBridge(selector);
    const injection = bridge.bridge('coding', 'implement auth', 30);

    expect(injection.context).toContain('[Consciousness Context]');
    expect(injection.context).toContain('Primary modules (full detail):');
    expect(injection.context).toContain('SelfModel: core self-knowledge');
    expect(injection.context).toContain('ProceduralMemory: skill recall');
    expect(injection.context).toContain('Metacognition: self-reflection');
    expect(injection.context).toContain('EpisodicMemory: past context (summary)');
    expect(injection.category).toBe('coding');
  });

  // 2. Bridge at 60% context: Partial detail (moderate)
  it('injects moderate detail when context window is at 60%', () => {
    const bridge = new ConsciousnessBridge(selector);
    const injection = bridge.bridge('analysis', 'evaluate data', 60);

    expect(injection.context).toContain('[Consciousness Context — moderate]');
    // Top 2 primary modules at full detail
    expect(injection.context).toContain('SelfModel: core self-knowledge');
    expect(injection.context).toContain('ProceduralMemory: skill recall');
    // Third primary module is summarized
    expect(injection.context).toContain('Metacognition: self-reflection (summary)');
    // Secondary compressed to single line
    expect(injection.context).toContain('Secondary: EpisodicMemory');
    expect(injection.category).toBe('analysis');
  });

  // 3. Bridge at 75% context: Summary mode (concise)
  it('injects concise summary when context window is at 75%', () => {
    const bridge = new ConsciousnessBridge(selector);
    const injection = bridge.bridge('coding', 'debug crash', 75);

    expect(injection.context).toContain('[Consciousness Context — concise]');
    expect(injection.context).toContain('SelfModel (core self-knowledge)');
    expect(injection.context).toContain('ProceduralMemory (skill recall)');
    expect(injection.context).toContain('Metacognition (self-reflection)');
    expect(injection.context).toContain('Secondary: EpisodicMemory');
  });

  // 4. Bridge at 90% context: Compressed mode
  it('injects compressed context when context window is at 90%', () => {
    const bridge = new ConsciousnessBridge(selector);
    const injection = bridge.bridge('blocked', 'access denied', 90);

    expect(injection.context).toContain('[Consciousness Context — compressed]');
    expect(injection.context).toContain('Pri: SelfModel, ProceduralMemory, Metacognition');
    expect(injection.context).toContain('Sec: EpisodicMemory');
    expect(injection.context).toContain('Budget: high pressure');
    expect(injection.context.split('\n').length).toBeLessThanOrEqual(3);
  });

  // 5. Inject into prompt: Correct position insertion
  it('inserts context at the after_system marker in the system prompt', () => {
    const bridge = new ConsciousnessBridge(selector);
    const injection = bridge.bridge('coding', 'write code', 30);
    const prompt = 'You are a helpful assistant.\n[SYSTEM_END]\n[TOOLS_BEGIN]\nTool definitions here.';

    const result = bridge.injectIntoPrompt(prompt, injection);

    // 'after_system' must place the context AFTER the [SYSTEM_END] marker — after the
    // system block, not spliced inside it (between [SYSTEM_END] and [TOOLS_BEGIN]).
    const ctxIndex = result.indexOf(injection.context);
    const markerIndex = result.indexOf('[SYSTEM_END]');
    const toolsIndex = result.indexOf('[TOOLS_BEGIN]');
    expect(ctxIndex).toBeGreaterThan(markerIndex);
    expect(ctxIndex).toBeLessThan(toolsIndex);
    expect(result).toContain(injection.context);
  });

  it('appends to end when marker is not found in system prompt', () => {
    const bridge = new ConsciousnessBridge(selector);
    const injection = bridge.bridge('coding', 'write code', 30);
    const prompt = 'You are a helpful assistant with no markers.';

    const result = bridge.injectIntoPrompt(prompt, injection);

    expect(result).toContain(injection.context);
    // Should appear after the original prompt text
    expect(result.indexOf(injection.context)).toBeGreaterThan(prompt.length / 2);
  });

  it('returns injection context when system prompt is empty', () => {
    const bridge = new ConsciousnessBridge(selector);
    const injection = bridge.bridge('coding', 'task', 30);

    const result = bridge.injectIntoPrompt('', injection);
    expect(result).toBe(injection.context);
  });

  // 6. Token estimation: Reasonable token estimates
  it('produces reasonable token estimates that correlate with string length', () => {
    const bridge = new ConsciousnessBridge(selector);

    const fullInjection = bridge.bridge('coding', 'task', 30);
    const compressedInjection = bridge.bridge('coding', 'task', 90);

    // Full detail should require more tokens than compressed
    expect(fullInjection.tokenEstimate).toBeGreaterThan(compressedInjection.tokenEstimate);

    // Estimates should be roughly length/4 (the estimateTokens heuristic)
    const expectedFull = Math.ceil(fullInjection.context.length / 4);
    expect(fullInjection.tokenEstimate).toBe(expectedFull);

    // Both should be positive
    expect(fullInjection.tokenEstimate).toBeGreaterThan(0);
    expect(compressedInjection.tokenEstimate).toBeGreaterThan(0);
  });

  // 7. History tracking: Bridge history is recorded
  it('records bridge history in reverse-chronological order', () => {
    const bridge = new ConsciousnessBridge(selector);

    const inj1 = bridge.bridge('coding', 'task a', 30);
    const inj2 = bridge.bridge('analysis', 'task b', 60);

    const history = bridge.getBridgeHistory();
    expect(history).toHaveLength(2);
    // Newest first
    expect(history[0].category).toBe('analysis');
    expect(history[1].category).toBe('coding');
    expect(history[0].injectedAt).toBeTruthy();
    expect(history[1].injectedAt).toBeTruthy();
  });

  it('respects the history limit parameter', () => {
    const bridge = new ConsciousnessBridge(selector);

    for (let i = 0; i < 5; i++) {
      bridge.bridge('coding', `task ${i}`, 30);
    }

    const limited = bridge.getBridgeHistory(2);
    expect(limited).toHaveLength(2);
  });

  // 8. Stats: Tracks average tokens injected
  it('tracks average tokens injected across multiple bridges', () => {
    const bridge = new ConsciousnessBridge(selector);

    bridge.bridge('coding', 'task', 30);
    bridge.bridge('coding', 'task', 60);
    bridge.bridge('analysis', 'task', 75);

    const stats = bridge.getStats();
    expect(stats.totalBridges).toBe(3);
    expect(stats.avgTokensInjected).toBeGreaterThan(0);
    expect(stats.byCategory.coding).toBe(2);
    expect(stats.byCategory.analysis).toBe(1);
    expect(stats.contextSaved).toBeGreaterThanOrEqual(0);
  });

  it('returns zero stats before any bridges are called', () => {
    const bridge = new ConsciousnessBridge(selector);
    const stats = bridge.getStats();

    expect(stats.totalBridges).toBe(0);
    expect(stats.avgTokensInjected).toBe(0);
    expect(Object.keys(stats.byCategory)).toHaveLength(0);
  });

  // Guard: constructor validation
  it('throws TypeError when contextSelector is missing', () => {
    expect(() => new ConsciousnessBridge(null as unknown as ContextSelector))
      .toThrow(TypeError);
  });
});