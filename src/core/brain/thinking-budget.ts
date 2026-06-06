/**
 * @file brain/thinking-budget.ts
 * @description Adaptive Thinking Budget Manager — controls model thinking/reasoning
 * token budgets with effort-based scaling and adaptive adjustment from session signals.
 *
 * Competitive context: Claude Code has `alwaysThinkingEnabled` setting,
 * `MAX_THINKING_TOKENS` env var, and `CLAUDE_CODE_EFFORT_LEVEL` that controls
 * subagent concurrency and output token budget. This module provides SUDO-AI's
 * equivalent with adaptive adjustment based on session performance signals.
 *
 * @module thinking-budget
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type {
  ThinkingLevel,
  EffortDialLevel,
  ReasoningLevel,
  ModelThinkingBudget,
  ModelBudgetOverrides,
  PerformanceSignals,
  ThinkingBudgetAdjustment,
  AdjustmentStrategy,
  ThinkingBudgetConfig,
  ThinkingBudgetState,
  ThinkingBudgetEvent,
  ThinkingBudgetEventHandler,
} from './thinking-budget-types.js';
import {
  DEFAULT_THINKING_BUDGET_CONFIG,
  EFFORT_TO_BUDGET,
  THINKING_LEVEL_TOKENS,
  REASONING_LEVEL_TOKENS,
} from './thinking-budget-types.js';

const log = createLogger('brain:thinking-budget');

// ---------------------------------------------------------------------------
// Default Model Budgets
// ---------------------------------------------------------------------------

/** Default thinking budgets for known models. */
const DEFAULT_MODEL_BUDGETS: Record<string, ModelThinkingBudget> = {
  'anthropic/claude-opus-4-8': {
    model: 'anthropic/claude-opus-4-8',
    minTokens: 0,
    maxTokens: 65536,
    defaultTokens: 16384,
    supportsInterleaved: true,
    supportsExtended: true,
    costMultiplier: 1.0,
  },
  'anthropic/claude-sonnet-4-6': {
    model: 'anthropic/claude-sonnet-4-6',
    minTokens: 0,
    maxTokens: 32768,
    defaultTokens: 8192,
    supportsInterleaved: true,
    supportsExtended: true,
    costMultiplier: 1.0,
  },
  'anthropic/claude-haiku-4-5': {
    model: 'anthropic/claude-haiku-4-5',
    minTokens: 0,
    maxTokens: 16384,
    defaultTokens: 2048,
    supportsInterleaved: false,
    supportsExtended: true,
    costMultiplier: 0.5,
  },
  'xai/grok-4-0709': {
    model: 'xai/grok-4-0709',
    minTokens: 0,
    maxTokens: 32768,
    defaultTokens: 8192,
    supportsInterleaved: true,
    supportsExtended: true,
    costMultiplier: 1.0,
  },
  'openai/gpt-4o': {
    model: 'openai/gpt-4o',
    minTokens: 0,
    maxTokens: 16384,
    defaultTokens: 2048,
    supportsInterleaved: false,
    supportsExtended: true,
    costMultiplier: 0.5,
  },
  'google/gemini-2.5-pro': {
    model: 'google/gemini-2.5-pro',
    minTokens: 0,
    maxTokens: 32768,
    defaultTokens: 8192,
    supportsInterleaved: true,
    supportsExtended: true,
    costMultiplier: 0.75,
  },
  'deepseek/deepseek-r1': {
    model: 'deepseek/deepseek-r1',
    minTokens: 0,
    maxTokens: 65536,
    defaultTokens: 16384,
    supportsInterleaved: true,
    supportsExtended: true,
    costMultiplier: 1.0,
  },
  'ollama/deepseek-v4-pro': {
    model: 'ollama/deepseek-v4-pro',
    minTokens: 0,
    maxTokens: 16384,
    defaultTokens: 4096,
    supportsInterleaved: false,
    supportsExtended: false,
    costMultiplier: 0.25,
  },
};

// ---------------------------------------------------------------------------
// Thinking Budget Manager
// ---------------------------------------------------------------------------

/**
 * Manages adaptive thinking token budgets for LLM calls.
 *
 * Provides model-specific budgets, effort-based scaling, and adaptive
 * adjustment based on session performance signals. Integrates with the
 * existing EffortDial and interleaved thinking systems.
 */
export class ThinkingBudgetManager {
  private config: ThinkingBudgetConfig;
  private state: ThinkingBudgetState;
  private modelBudgets: Map<string, ModelThinkingBudget> = new Map();
  private eventHandlers = new Map<string, Set<ThinkingBudgetEventHandler>>();

  constructor(config?: Partial<ThinkingBudgetConfig>) {
    this.config = { ...DEFAULT_THINKING_BUDGET_CONFIG, ...config };

    // Initialize model budgets from defaults
    for (const [model, budget] of Object.entries(DEFAULT_MODEL_BUDGETS)) {
      this.modelBudgets.set(model, { ...budget });
    }

    // Apply model overrides from config
    for (const [model, overrides] of Object.entries(this.config.modelOverrides)) {
      const existing = this.modelBudgets.get(model);
      if (existing) {
        Object.assign(existing, overrides);
      } else {
        this.modelBudgets.set(model, {
          model,
          minTokens: overrides.minTokens ?? this.config.globalMinTokens,
          maxTokens: overrides.maxTokens ?? this.config.globalMaxTokens,
          defaultTokens: overrides.defaultTokens ?? this.config.defaultTokens,
          supportsInterleaved: overrides.supportsInterleaved ?? false,
          supportsExtended: true,
          costMultiplier: overrides.costMultiplier ?? 1.0,
        });
      }
    }

    // Initialize state
    this.state = {
      currentBudgets: {},
      adjustmentHistory: [],
      totalAdjustments: 0,
      increaseCount: 0,
      decreaseCount: 0,
      lastAdjustmentAt: null,
      currentSessionId: null,
    };

    // Load persisted state
    if (this.config.persistState) {
      this.loadState();
    }
  }

  // -------------------------------------------------------------------------
  // Budget Queries
  // -------------------------------------------------------------------------

  /**
   * Get the thinking token budget for a model.
   */
  getBudget(model: string): number {
    // Check current state first (may have been adjusted)
    if (this.state.currentBudgets[model] !== undefined) {
      return this.state.currentBudgets[model]!;
    }

    // Fall back to model default
    const budget = this.modelBudgets.get(model);
    if (budget) {
      return budget.defaultTokens;
    }

    // Check model overrides in config
    const override = this.config.modelOverrides[model];
    if (override?.defaultTokens) {
      return override.defaultTokens;
    }

    // Global default
    return this.config.defaultTokens;
  }

  /**
   * Get the full model budget configuration.
   */
  getModelBudget(model: string): ModelThinkingBudget | null {
    return this.modelBudgets.get(model) ?? null;
  }

  /**
   * Get all model budgets.
   */
  getAllModelBudgets(): Map<string, ModelThinkingBudget> {
    return new Map(this.modelBudgets);
  }

  /**
   * Get the thinking budget for an effort level.
   */
  getBudgetForEffort(effort: EffortDialLevel): number {
    return EFFORT_TO_BUDGET[effort].thinkingTokens;
  }

  /**
   * Get the thinking budget for a thinking level.
   */
  getBudgetForThinkingLevel(level: ThinkingLevel): number {
    return THINKING_LEVEL_TOKENS[level];
  }

  /**
   * Get the thinking budget for a reasoning level.
   */
  getBudgetForReasoning(level: ReasoningLevel): number {
    return REASONING_LEVEL_TOKENS[level];
  }

  /**
   * Check if a model supports interleaved thinking.
   */
  supportsInterleavedThinking(model: string): boolean {
    const budget = this.modelBudgets.get(model);
    return budget?.supportsInterleaved ?? false;
  }

  /**
   * Check if a model supports extended thinking.
   */
  supportsExtendedThinking(model: string): boolean {
    const budget = this.modelBudgets.get(model);
    return budget?.supportsExtended ?? true;
  }

  /**
   * Get the effective thinking configuration for a model at an effort level.
   */
  getEffectiveConfig(model: string, effort: EffortDialLevel): {
    thinkingTokens: number;
    reasoningLevel: ReasoningLevel;
    interleavedThinking: boolean;
    verificationDepth: 'none' | 'basic' | 'adversarial';
  } {
    const effortConfig = EFFORT_TO_BUDGET[effort];
    const modelBudget = this.getBudget(model);
    const modelSupportsInterleaved = this.supportsInterleavedThinking(model);

    // Use the minimum of effort-based budget and model max budget
    const modelMax = this.modelBudgets.get(model)?.maxTokens ?? this.config.globalMaxTokens;
    const thinkingTokens = Math.min(
      this.getBudget(model),
      modelMax,
    );

    return {
      thinkingTokens,
      reasoningLevel: effortConfig.reasoningLevel,
      interleavedThinking: effortConfig.interleavedThinking && modelSupportsInterleaved,
      verificationDepth: effortConfig.verificationDepth,
    };
  }

  // -------------------------------------------------------------------------
  // Budget Control
  // -------------------------------------------------------------------------

  /**
   * Set the thinking token budget for a model.
   */
  setBudget(model: string, tokens: number): void {
    const previousTokens = this.getBudget(model);
    const modelBudget = this.modelBudgets.get(model);

    const minTokens = modelBudget?.minTokens ?? this.config.globalMinTokens;
    const maxTokens = modelBudget?.maxTokens ?? this.config.globalMaxTokens;

    // Clamp to model limits
    const clampedTokens = Math.max(minTokens, Math.min(maxTokens, tokens));

    this.state.currentBudgets[model] = clampedTokens;

    this.emit({
      type: 'budget_set',
      model,
      tokens: clampedTokens,
      previousTokens,
    });

    log.info(
      { model, tokens: clampedTokens, previousTokens },
      'Thinking budget set',
    );

    // Persist state
    if (this.config.persistState) {
      this.persistState();
    }
  }

  /**
   * Reset the thinking budget for a model to its default.
   */
  resetBudget(model: string): void {
    const modelBudget = this.modelBudgets.get(model);
    const defaultTokens = modelBudget?.defaultTokens ?? this.config.defaultTokens;

    delete this.state.currentBudgets[model];

    this.emit({ type: 'budget_reset', model });

    log.info({ model, defaultTokens }, 'Thinking budget reset to default');

    if (this.config.persistState) {
      this.persistState();
    }
  }

  /**
   * Reset all budgets to defaults.
   */
  resetAllBudgets(): void {
    this.state.currentBudgets = {};
    this.state.adjustmentHistory = [];
    this.state.totalAdjustments = 0;
    this.state.increaseCount = 0;
    this.state.decreaseCount = 0;

    log.info('All thinking budgets reset to defaults');

    if (this.config.persistState) {
      this.persistState();
    }
  }

  // -------------------------------------------------------------------------
  // Adaptive Adjustment
  // -------------------------------------------------------------------------

  /**
   * Adaptively adjust the thinking budget based on session performance signals.
   *
   * Analyzes error rate, TTFT, goal completion, doom loops, and cancellations
   * to determine whether to increase or decrease the thinking budget.
   */
  adaptBudget(model: string, signals: PerformanceSignals): ThinkingBudgetAdjustment | null {
    if (!this.config.adaptiveEnabled) {
      log.debug('Adaptive thinking budget is disabled');
      return null;
    }

    const currentTokens = this.getBudget(model);
    const modelBudget = this.modelBudgets.get(model);
    const maxTokens = modelBudget?.maxTokens ?? this.config.globalMaxTokens;
    const minTokens = modelBudget?.minTokens ?? this.config.globalMinTokens;
    const thresholds = this.config.thresholds;
    const strategy = this.config.adjustments[this.config.adjustmentStrategy];

    const triggeredBy: string[] = [];
    let shouldIncrease = false;
    let shouldDecrease = false;

    // Check error rate
    if (signals.errorRate > thresholds.errorRateIncreaseThreshold) {
      shouldIncrease = true;
      triggeredBy.push(`errorRate=${signals.errorRate.toFixed(2)}>${thresholds.errorRateIncreaseThreshold}`);
    } else if (signals.errorRate < thresholds.errorRateDecreaseThreshold && currentTokens > this.config.defaultTokens) {
      shouldDecrease = true;
      triggeredBy.push(`errorRate=${signals.errorRate.toFixed(2)}<${thresholds.errorRateDecreaseThreshold}`);
    }

    // Check TTFT
    if (signals.avgTTFTms > thresholds.ttftIncreaseThresholdMs) {
      shouldIncrease = true;
      triggeredBy.push(`ttft=${signals.avgTTFTms.toFixed(0)}ms>${thresholds.ttftIncreaseThresholdMs}ms`);
    }

    // Check goal completion rate
    if (signals.goalCompletionRate < thresholds.goalCompletionIncreaseThreshold) {
      shouldIncrease = true;
      triggeredBy.push(`goalCompletion=${signals.goalCompletionRate.toFixed(2)}<${thresholds.goalCompletionIncreaseThreshold}`);
    }

    // Check doom loops
    if (signals.doomLoopCount > thresholds.doomLoopIncreaseThreshold) {
      shouldIncrease = true;
      triggeredBy.push(`doomLoops=${signals.doomLoopCount}>${thresholds.doomLoopIncreaseThreshold}`);
    }

    // Check cancellation rate
    if (signals.cancellationRate > thresholds.cancellationIncreaseThreshold) {
      shouldIncrease = true;
      triggeredBy.push(`cancellationRate=${signals.cancellationRate.toFixed(2)}>${thresholds.cancellationIncreaseThreshold}`);
    }

    // Calculate adjustment
    let newTokens = currentTokens;
    let reason: string;

    if (shouldIncrease) {
      const increaseFactor = strategy.increase;
      newTokens = Math.min(maxTokens, Math.round(currentTokens * (1 + increaseFactor)));
      reason = `Increased thinking budget: ${triggeredBy.join(', ')}`;
    } else if (shouldDecrease) {
      const decreaseFactor = strategy.decrease;
      newTokens = Math.max(minTokens, Math.round(currentTokens * (1 - decreaseFactor)));
      reason = `Decreased thinking budget: ${triggeredBy.join(', ')}`;
    } else {
      // No adjustment needed
      return null;
    }

    // No change if clamped
    if (newTokens === currentTokens) {
      return null;
    }

    const adjustment: ThinkingBudgetAdjustment = {
      previousTokens: currentTokens,
      newTokens,
      reason,
      increased: newTokens > currentTokens,
      confidence: Math.min(1, triggeredBy.length * 0.3),
      triggeredBy,
    };

    // Apply the adjustment
    this.state.currentBudgets[model] = newTokens;
    this.state.adjustmentHistory.unshift(adjustment);
    if (this.state.adjustmentHistory.length > 100) {
      this.state.adjustmentHistory = this.state.adjustmentHistory.slice(0, 100);
    }
    this.state.totalAdjustments++;
    if (adjustment.increased) this.state.increaseCount++;
    else this.state.decreaseCount++;
    this.state.lastAdjustmentAt = new Date().toISOString();

    this.emit({ type: 'budget_adjusted', adjustment, model });

    log.info(
      {
        model,
        previousTokens: currentTokens,
        newTokens,
        increased: adjustment.increased,
        triggeredBy,
      },
      'Thinking budget adapted',
    );

    if (this.config.persistState) {
      this.persistState();
    }

    return adjustment;
  }

  // -------------------------------------------------------------------------
  // State Persistence
  // -------------------------------------------------------------------------

  /**
   * Persist state to disk.
   */
  private persistState(): void {
    try {
      const statePath = path.resolve(this.config.persistPath);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(this.state, null, 2), 'utf8');

      this.emit({ type: 'state_persisted', path: statePath });
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to persist thinking budget state');
    }
  }

  /**
   * Load state from disk.
   */
  private loadState(): void {
    try {
      const statePath = path.resolve(this.config.persistPath);
      if (fs.existsSync(statePath)) {
        const content = fs.readFileSync(statePath, 'utf8');
        const loaded = JSON.parse(content) as ThinkingBudgetState;
        this.state = { ...this.state, ...loaded };
        log.info({ budgets: Object.keys(this.state.currentBudgets).length }, 'Thinking budget state loaded');
      }
    } catch (err) {
      log.debug({ err: String(err) }, 'Failed to load thinking budget state, using defaults');
    }
  }

  // -------------------------------------------------------------------------
  // Event System
  // -------------------------------------------------------------------------

  /**
   * Register an event handler.
   */
  on(event: string, handler: ThinkingBudgetEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Remove an event handler.
   */
  off(event: string, handler: ThinkingBudgetEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit(event: ThinkingBudgetEvent): void {
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          log.error({ err: String(err), eventType: event.type }, 'Thinking budget event handler error');
        }
      }
    }
    // Also call global handlers
    const allHandlers = this.eventHandlers.get('*');
    if (allHandlers) {
      for (const handler of allHandlers) {
        try {
          handler(event);
        } catch (err) {
          log.error({ err: String(err) }, 'Thinking budget event handler error');
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  /**
   * Get the current state.
   */
  getState(): ThinkingBudgetState {
    return { ...this.state };
  }

  /**
   * Get the configuration.
   */
  getConfig(): ThinkingBudgetConfig {
    return { ...this.config };
  }

  /**
   * Enable or disable adaptive adjustment.
   */
  setAdaptiveEnabled(enabled: boolean): void {
    this.config.adaptiveEnabled = enabled;
    this.emit({ type: 'adaptive_enabled', enabled });
    log.info({ enabled }, 'Adaptive thinking budget ' + (enabled ? 'enabled' : 'disabled'));
  }

  /**
   * Set the adjustment strategy.
   */
  setAdjustmentStrategy(strategy: AdjustmentStrategy): void {
    this.config.adjustmentStrategy = strategy;
    log.info({ strategy }, 'Adjustment strategy changed');
  }

  /**
   * Get adjustment statistics.
   */
  getAdjustmentStats(): {
    totalAdjustments: number;
    increaseCount: number;
    decreaseCount: number;
    lastAdjustmentAt: string | null;
    increaseRatio: number;
  } {
    return {
      totalAdjustments: this.state.totalAdjustments,
      increaseCount: this.state.increaseCount,
      decreaseCount: this.state.decreaseCount,
      lastAdjustmentAt: this.state.lastAdjustmentAt,
      increaseRatio: this.state.totalAdjustments > 0
        ? this.state.increaseCount / this.state.totalAdjustments
        : 0,
    };
  }

  /**
   * Get a summary of current budget state.
   */
  getSummary(): string {
    const lines: string[] = [
      '🧠 Thinking Budget Summary',
      '========================',
      '',
    ];

    // Current budgets
    const budgetEntries = Object.entries(this.state.currentBudgets);
    if (budgetEntries.length > 0) {
      lines.push('Current Budgets:');
      for (const [model, tokens] of budgetEntries) {
        const budget = this.modelBudgets.get(model);
        const maxTokens = budget?.maxTokens ?? this.config.globalMaxTokens;
        const pct = ((tokens / maxTokens) * 100).toFixed(0);
        lines.push(`  ${model}: ${tokens.toLocaleString()} tokens (${pct}% of max ${maxTokens.toLocaleString()})`);
      }
    } else {
      lines.push('No budget overrides (using defaults)');
    }

    lines.push('');

    // Default budgets
    lines.push('Default Budgets:');
    for (const [model, budget] of this.modelBudgets.entries()) {
      lines.push(`  ${model}: ${budget.defaultTokens.toLocaleString()} tokens (max: ${budget.maxTokens.toLocaleString()}, interleaved: ${budget.supportsInterleaved})`);
    }

    // Adjustment stats
    const stats = this.getAdjustmentStats();
    lines.push('');
    lines.push('Adaptive Stats:');
    lines.push(`  Total adjustments: ${stats.totalAdjustments}`);
    lines.push(`  Increases: ${stats.increaseCount}, Decreases: ${stats.decreaseCount}`);
    lines.push(`  Increase ratio: ${(stats.increaseRatio * 100).toFixed(1)}%`);
    lines.push(`  Strategy: ${this.config.adjustmentStrategy}`);
    lines.push(`  Adaptive: ${this.config.adaptiveEnabled ? 'enabled' : 'disabled'}`);

    return lines.join('\n');
  }
}

/** Singleton instance. */
export const thinkingBudgetManager = new ThinkingBudgetManager();