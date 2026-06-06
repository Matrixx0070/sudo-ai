/**
 * @file tests/brain/thinking-budget.test.ts
 * @description Tests for Adaptive Thinking Budget Manager.
 *
 * Covers: budget queries, effort-based scaling, model-specific budgets,
 * adaptive adjustment, state persistence, event system, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ThinkingBudgetManager,
} from '../../src/core/brain/thinking-budget.js';
import type {
  ThinkingBudgetAdjustment,
  PerformanceSignals,
  ThinkingBudgetConfig,
  AdjustmentStrategy,
} from '../../src/core/brain/thinking-budget-types.js';
import {
  DEFAULT_THINKING_BUDGET_CONFIG,
  EFFORT_TO_BUDGET,
  THINKING_LEVEL_TOKENS,
  REASONING_LEVEL_TOKENS,
} from '../../src/core/brain/thinking-budget-types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_STATE_PATH = path.join(os.tmpdir(), `thinking-budget-test-${Date.now()}.json`);

function createTestManager(config?: Partial<ThinkingBudgetConfig>): ThinkingBudgetManager {
  return new ThinkingBudgetManager({
    ...config,
    persistState: false, // Disable persistence for tests
    persistPath: TEST_STATE_PATH,
  });
}

function makeSignals(overrides: Partial<PerformanceSignals> = {}): PerformanceSignals {
  return {
    errorRate: 0.05,
    avgTTFTms: 3000,
    p95ITLms: 200,
    goalCompletionRate: 0.8,
    doomLoopCount: 0,
    cancellationRate: 0.05,
    feedbackTier: 'normal',
    turnCount: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Type Defaults
// ---------------------------------------------------------------------------

describe('Thinking Budget Types — defaults', () => {
  it('exports DEFAULT_THINKING_BUDGET_CONFIG with sensible values', () => {
    expect(DEFAULT_THINKING_BUDGET_CONFIG.defaultTokens).toBe(4096);
    expect(DEFAULT_THINKING_BUDGET_CONFIG.globalMaxTokens).toBe(65536);
    expect(DEFAULT_THINKING_BUDGET_CONFIG.globalMinTokens).toBe(0);
    expect(DEFAULT_THINKING_BUDGET_CONFIG.adaptiveEnabled).toBe(true);
    expect(DEFAULT_THINKING_BUDGET_CONFIG.adjustmentStrategy).toBe('balanced');
    expect(DEFAULT_THINKING_BUDGET_CONFIG.thresholds.errorRateIncreaseThreshold).toBe(0.15);
    expect(DEFAULT_THINKING_BUDGET_CONFIG.adjustments.conservative.increase).toBe(0.1);
    expect(DEFAULT_THINKING_BUDGET_CONFIG.adjustments.aggressive.increase).toBe(0.4);
  });

  it('exports EFFORT_TO_BUDGET mapping', () => {
    expect(EFFORT_TO_BUDGET.low.thinkingTokens).toBe(1024);
    expect(EFFORT_TO_BUDGET.medium.thinkingTokens).toBe(8192);
    expect(EFFORT_TO_BUDGET.high.thinkingTokens).toBe(32768);
    expect(EFFORT_TO_BUDGET.low.interleavedThinking).toBe(false);
    expect(EFFORT_TO_BUDGET.high.interleavedThinking).toBe(true);
  });

  it('exports THINKING_LEVEL_TOKENS mapping', () => {
    expect(THINKING_LEVEL_TOKENS.none).toBe(0);
    expect(THINKING_LEVEL_TOKENS.minimal).toBe(256);
    expect(THINKING_LEVEL_TOKENS.low).toBe(1024);
    expect(THINKING_LEVEL_TOKENS.medium).toBe(8192);
    expect(THINKING_LEVEL_TOKENS.high).toBe(16384);
    expect(THINKING_LEVEL_TOKENS.maximum).toBe(32768);
  });

  it('exports REASONING_LEVEL_TOKENS mapping', () => {
    expect(REASONING_LEVEL_TOKENS.low).toBe(1024);
    expect(REASONING_LEVEL_TOKENS.medium).toBe(4096);
    expect(REASONING_LEVEL_TOKENS.high).toBe(16384);
    expect(REASONING_LEVEL_TOKENS.xhigh).toBe(32768);
  });

  it('has model overrides for major providers', () => {
    expect(Object.keys(DEFAULT_THINKING_BUDGET_CONFIG.modelOverrides).length).toBeGreaterThan(0);
    const opus = DEFAULT_THINKING_BUDGET_CONFIG.modelOverrides['anthropic/claude-opus-4-8'];
    expect(opus).toBeDefined();
    expect(opus!.defaultTokens).toBe(16384);
    expect(opus!.maxTokens).toBe(65536);
    expect(opus!.supportsInterleaved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Budget Queries
// ---------------------------------------------------------------------------

describe('ThinkingBudgetManager — budget queries', () => {
  let manager: ThinkingBudgetManager;

  beforeEach(() => {
    manager = createTestManager();
  });

  it('returns default budget for known models', () => {
    expect(manager.getBudget('anthropic/claude-sonnet-4-6')).toBe(8192);
    expect(manager.getBudget('anthropic/claude-opus-4-8')).toBe(16384);
    expect(manager.getBudget('anthropic/claude-haiku-4-5')).toBe(2048);
  });

  it('returns global default for unknown models', () => {
    expect(manager.getBudget('unknown/model')).toBe(4096);
  });

  it('returns effort-based budgets', () => {
    expect(manager.getBudgetForEffort('low')).toBe(1024);
    expect(manager.getBudgetForEffort('medium')).toBe(8192);
    expect(manager.getBudgetForEffort('high')).toBe(32768);
  });

  it('returns thinking level budgets', () => {
    expect(manager.getBudgetForThinkingLevel('none')).toBe(0);
    expect(manager.getBudgetForThinkingLevel('medium')).toBe(8192);
    expect(manager.getBudgetForThinkingLevel('maximum')).toBe(32768);
  });

  it('returns reasoning level budgets', () => {
    expect(manager.getBudgetForReasoning('low')).toBe(1024);
    expect(manager.getBudgetForReasoning('medium')).toBe(4096);
    expect(manager.getBudgetForReasoning('high')).toBe(16384);
    expect(manager.getBudgetForReasoning('xhigh')).toBe(32768);
  });

  it('returns model budget configuration', () => {
    const budget = manager.getModelBudget('anthropic/claude-sonnet-4-6');
    expect(budget).not.toBeNull();
    expect(budget!.model).toBe('anthropic/claude-sonnet-4-6');
    expect(budget!.supportsInterleaved).toBe(true);
  });

  it('returns null for unknown model budget', () => {
    const budget = manager.getModelBudget('unknown/model');
    expect(budget).toBeNull();
  });

  it('checks interleaved thinking support', () => {
    expect(manager.supportsInterleavedThinking('anthropic/claude-opus-4-8')).toBe(true);
    expect(manager.supportsInterleavedThinking('anthropic/claude-haiku-4-5')).toBe(false);
    expect(manager.supportsInterleavedThinking('unknown/model')).toBe(false);
  });

  it('gets effective config for model and effort', () => {
    const config = manager.getEffectiveConfig('anthropic/claude-sonnet-4-6', 'high');
    expect(config.thinkingTokens).toBeGreaterThan(0);
    expect(config.reasoningLevel).toBe('high');
    expect(config.interleavedThinking).toBe(true);
    expect(config.verificationDepth).toBe('adversarial');
  });

  it('disables interleaved thinking for models that do not support it', () => {
    const config = manager.getEffectiveConfig('anthropic/claude-haiku-4-5', 'high');
    expect(config.interleavedThinking).toBe(false);
  });

  it('clamps budget to model max', () => {
    const config = manager.getEffectiveConfig('anthropic/claude-haiku-4-5', 'high');
    // Haiku max is 16384, effort high budget would be 32768, but clamped
    expect(config.thinkingTokens).toBeLessThanOrEqual(16384);
  });
});

// ---------------------------------------------------------------------------
// Budget Control
// ---------------------------------------------------------------------------

describe('ThinkingBudgetManager — budget control', () => {
  let manager: ThinkingBudgetManager;

  beforeEach(() => {
    manager = createTestManager();
  });

  it('sets budget for a model', () => {
    manager.setBudget('anthropic/claude-sonnet-4-6', 20000);
    expect(manager.getBudget('anthropic/claude-sonnet-4-6')).toBe(20000);
  });

  it('clamps budget to model max', () => {
    manager.setBudget('anthropic/claude-haiku-4-5', 100000);
    // Haiku max is 16384
    expect(manager.getBudget('anthropic/claude-haiku-4-5')).toBe(16384);
  });

  it('clamps budget to model min', () => {
    manager.setBudget('anthropic/claude-sonnet-4-6', -100);
    expect(manager.getBudget('anthropic/claude-sonnet-4-6')).toBeGreaterThanOrEqual(0);
  });

  it('resets budget to default', () => {
    manager.setBudget('anthropic/claude-sonnet-4-6', 20000);
    expect(manager.getBudget('anthropic/claude-sonnet-4-6')).toBe(20000);

    manager.resetBudget('anthropic/claude-sonnet-4-6');
    expect(manager.getBudget('anthropic/claude-sonnet-4-6')).toBe(8192); // default
  });

  it('resets all budgets', () => {
    manager.setBudget('anthropic/claude-sonnet-4-6', 20000);
    manager.setBudget('anthropic/claude-opus-4-8', 50000);

    manager.resetAllBudgets();

    expect(manager.getBudget('anthropic/claude-sonnet-4-6')).toBe(8192);
    expect(manager.getBudget('anthropic/claude-opus-4-8')).toBe(16384);
  });

  it('sets budget for unknown model', () => {
    manager.setBudget('custom/model', 5000);
    expect(manager.getBudget('custom/model')).toBe(5000);
  });

  it('emits budget_set event', () => {
    const handler = vi.fn();
    manager.on('budget_set', handler);

    manager.setBudget('anthropic/claude-sonnet-4-6', 20000);

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.type).toBe('budget_set');
    expect(event.model).toBe('anthropic/claude-sonnet-4-6');
    expect(event.tokens).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// Adaptive Adjustment
// ---------------------------------------------------------------------------

describe('ThinkingBudgetManager — adaptive adjustment', () => {
  let manager: ThinkingBudgetManager;

  beforeEach(() => {
    manager = createTestManager();
  });

  it('does not adjust when performance is good', () => {
    const result = manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals());
    expect(result).toBeNull();
  });

  it('increases budget when error rate is high', () => {
    const result = manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.3, // Above 0.15 threshold
    }));

    expect(result).not.toBeNull();
    expect(result!.increased).toBe(true);
    expect(result!.newTokens).toBeGreaterThan(result!.previousTokens);
    expect(result!.triggeredBy).toContainEqual(expect.stringContaining('errorRate'));
  });

  it('increases budget when TTFT is high', () => {
    const result = manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      avgTTFTms: 15000, // Above 10000ms threshold
    }));

    expect(result).not.toBeNull();
    expect(result!.increased).toBe(true);
    expect(result!.triggeredBy).toContainEqual(expect.stringContaining('ttft'));
  });

  it('increases budget when goal completion is low', () => {
    const result = manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      goalCompletionRate: 0.4, // Below 0.6 threshold
    }));

    expect(result).not.toBeNull();
    expect(result!.increased).toBe(true);
    expect(result!.triggeredBy).toContainEqual(expect.stringContaining('goalCompletion'));
  });

  it('increases budget when doom loops detected', () => {
    const result = manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      doomLoopCount: 3, // Above 2 threshold
    }));

    expect(result).not.toBeNull();
    expect(result!.increased).toBe(true);
    expect(result!.triggeredBy).toContainEqual(expect.stringContaining('doomLoops'));
  });

  it('increases budget when cancellation rate is high', () => {
    const result = manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      cancellationRate: 0.3, // Above 0.2 threshold
    }));

    expect(result).not.toBeNull();
    expect(result!.increased).toBe(true);
    expect(result!.triggeredBy).toContainEqual(expect.stringContaining('cancellationRate'));
  });

  it('decreases budget when error rate is very low', () => {
    // First set a higher budget
    manager.setBudget('anthropic/claude-sonnet-4-6', 20000);

    const result = manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.01, // Below 0.05 threshold
    }));

    expect(result).not.toBeNull();
    expect(result!.increased).toBe(false);
    expect(result!.newTokens).toBeLessThan(result!.previousTokens);
  });

  it('does not decrease below model minimum', () => {
    manager.setBudget('anthropic/claude-sonnet-4-6', 100); // Very low

    const result = manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.01, // Very low, should try to decrease
    }));

    // Result should be null since budget is already very low
    if (result !== null) {
      expect(result!.newTokens).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses conservative strategy for smaller increases', () => {
    const conservativeManager = createTestManager({
      adjustmentStrategy: 'conservative',
    });

    const result = conservativeManager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.3,
    }));

    expect(result).not.toBeNull();
    // Conservative increases by 10%: 8192 * 1.1 = 9011
    expect(result!.newTokens).toBe(Math.round(8192 * 1.1));
  });

  it('uses aggressive strategy for larger increases', () => {
    const aggressiveManager = createTestManager({
      adjustmentStrategy: 'aggressive',
    });

    const result = aggressiveManager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.3,
    }));

    expect(result).not.toBeNull();
    // Aggressive increases by 40%: 8192 * 1.4 = 11469
    expect(result!.newTokens).toBe(Math.round(8192 * 1.4));
  });

  it('returns null when adaptive is disabled', () => {
    const disabledManager = createTestManager({ adaptiveEnabled: false });
    const result = disabledManager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.5,
    }));
    expect(result).toBeNull();
  });

  it('records adjustment history', () => {
    manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.3,
    }));

    const state = manager.getState();
    expect(state.totalAdjustments).toBe(1);
    expect(state.increaseCount).toBe(1);
    expect(state.adjustmentHistory.length).toBe(1);
    expect(state.lastAdjustmentAt).toBeTruthy();
  });

  it('tracks increase and decrease counts', () => {
    manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.3,
    }));

    manager.setBudget('anthropic/claude-sonnet-4-6', 20000);
    manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.01,
    }));

    const stats = manager.getAdjustmentStats();
    expect(stats.totalAdjustments).toBe(2);
    expect(stats.increaseCount).toBe(1);
    expect(stats.decreaseCount).toBe(1);
  });

  it('limits adjustment history to 100 entries', () => {
    for (let i = 0; i < 110; i++) {
      manager.setBudget('anthropic/claude-sonnet-4-6', 8192 + i * 100);
      manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
        errorRate: 0.3 + (i % 10) * 0.01,
      }));
    }

    const state = manager.getState();
    expect(state.adjustmentHistory.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// State Persistence
// ---------------------------------------------------------------------------

describe('ThinkingBudgetManager — state persistence', () => {
  it('persists state to disk when enabled', () => {
    const persistPath = path.join(os.tmpdir(), `thinking-budget-persist-${Date.now()}.json`);
    const manager = new ThinkingBudgetManager({
      persistState: true,
      persistPath,
    });

    manager.setBudget('anthropic/claude-sonnet-4-6', 20000);

    expect(fs.existsSync(persistPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    expect(content.currentBudgets['anthropic/claude-sonnet-4-6']).toBe(20000);

    // Cleanup
    fs.unlinkSync(persistPath);
  });

  it('loads state from disk on construction', () => {
    const persistPath = path.join(os.tmpdir(), `thinking-budget-load-${Date.now()}.json`);
    const state = {
      currentBudgets: { 'anthropic/claude-sonnet-4-6': 15000 },
      adjustmentHistory: [],
      totalAdjustments: 5,
      increaseCount: 3,
      decreaseCount: 2,
      lastAdjustmentAt: new Date().toISOString(),
      currentSessionId: null,
    };
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    fs.writeFileSync(persistPath, JSON.stringify(state), 'utf8');

    const manager = new ThinkingBudgetManager({
      persistState: true,
      persistPath,
    });

    expect(manager.getBudget('anthropic/claude-sonnet-4-6')).toBe(15000);
    expect(manager.getState().totalAdjustments).toBe(5);

    // Cleanup
    fs.unlinkSync(persistPath);
  });
});

// ---------------------------------------------------------------------------
// Event System
// ---------------------------------------------------------------------------

describe('ThinkingBudgetManager — event system', () => {
  let manager: ThinkingBudgetManager;

  beforeEach(() => {
    manager = createTestManager();
  });

  it('emits budget_adjusted event', () => {
    const handler = vi.fn();
    manager.on('budget_adjusted', handler);

    manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.3,
    }));

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.type).toBe('budget_adjusted');
    expect(event.adjustment).toBeDefined();
    expect(event.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('emits budget_reset event', () => {
    const handler = vi.fn();
    manager.on('budget_reset', handler);

    manager.setBudget('anthropic/claude-sonnet-4-6', 20000);
    manager.resetBudget('anthropic/claude-sonnet-4-6');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emits adaptive_enabled event', () => {
    const handler = vi.fn();
    manager.on('adaptive_enabled', handler);

    manager.setAdaptiveEnabled(false);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].enabled).toBe(false);
  });

  it('allows removing event handlers', () => {
    const handler = vi.fn();
    manager.on('budget_set', handler);

    manager.setBudget('anthropic/claude-sonnet-4-6', 20000);
    expect(handler).toHaveBeenCalledTimes(1);

    manager.off('budget_set', handler);

    manager.setBudget('anthropic/claude-sonnet-4-6', 30000);
    expect(handler).toHaveBeenCalledTimes(1); // Not called again
  });
});

// ---------------------------------------------------------------------------
// Summary & Configuration
// ---------------------------------------------------------------------------

describe('ThinkingBudgetManager — summary & config', () => {
  let manager: ThinkingBudgetManager;

  beforeEach(() => {
    manager = createTestManager();
  });

  it('generates a human-readable summary', () => {
    manager.setBudget('anthropic/claude-sonnet-4-6', 20000);
    const summary = manager.getSummary();

    expect(summary).toContain('Thinking Budget Summary');
    expect(summary).toContain('anthropic/claude-sonnet-4-6');
    expect(summary).toContain('20,000');
    expect(summary).toContain('Adaptive');
  });

  it('returns config', () => {
    const config = manager.getConfig();
    expect(config.defaultTokens).toBe(4096);
    expect(config.adaptiveEnabled).toBe(true);
  });

  it('allows changing adjustment strategy', () => {
    manager.setAdjustmentStrategy('aggressive');
    const config = manager.getConfig();
    expect(config.adjustmentStrategy).toBe('aggressive');
  });

  it('allows toggling adaptive', () => {
    manager.setAdaptiveEnabled(false);
    const config = manager.getConfig();
    expect(config.adaptiveEnabled).toBe(false);
  });

  it('returns adjustment stats', () => {
    const stats = manager.getAdjustmentStats();
    expect(stats.totalAdjustments).toBe(0);
    expect(stats.increaseCount).toBe(0);
    expect(stats.decreaseCount).toBe(0);
    expect(stats.increaseRatio).toBe(0);
    expect(stats.lastAdjustmentAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe('ThinkingBudgetManager — edge cases', () => {
  it('handles multiple signals triggering increase', () => {
    const manager = createTestManager();
    const result = manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.3,
      avgTTFTms: 15000,
      goalCompletionRate: 0.4,
      doomLoopCount: 3,
      cancellationRate: 0.3,
    }));

    expect(result).not.toBeNull();
    expect(result!.increased).toBe(true);
    expect(result!.triggeredBy.length).toBeGreaterThanOrEqual(2);
  });

  it('handles conflicting signals (increase and decrease)', () => {
    const manager = createTestManager();
    // High error rate (increase) but very low TTFT (no signal)
    const result = manager.adaptBudget('anthropic/claude-sonnet-4-6', makeSignals({
      errorRate: 0.3, // Increase
      avgTTFTms: 500, // No signal (below threshold)
    }));

    expect(result).not.toBeNull();
    expect(result!.increased).toBe(true); // Increase wins
  });

  it('does not exceed global max when clamping', () => {
    const manager = createTestManager({
      globalMaxTokens: 10000,
    });

    // Try to set above global max
    manager.setBudget('unknown/model', 50000);
    expect(manager.getBudget('unknown/model')).toBeLessThanOrEqual(10000);
  });

  it('handles unknown models gracefully', () => {
    const manager = createTestManager();

    // Unknown model gets default budget
    expect(manager.getBudget('totally/unknown')).toBe(4096);

    // Can set budget for unknown model
    manager.setBudget('totally/unknown', 10000);
    expect(manager.getBudget('totally/unknown')).toBe(10000);

    // Can get effective config for unknown model
    const config = manager.getEffectiveConfig('totally/unknown', 'medium');
    expect(config.thinkingTokens).toBeGreaterThan(0);
  });

  it('getAllModelBudgets returns all budgets', () => {
    const manager = createTestManager();
    const budgets = manager.getAllModelBudgets();
    expect(budgets.size).toBeGreaterThan(0);
    expect(budgets.has('anthropic/claude-sonnet-4-6')).toBe(true);
  });
});