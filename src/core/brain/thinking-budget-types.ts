/**
 * @file brain/thinking-budget-types.ts
 * @description Type definitions for Adaptive Thinking Control.
 *
 * Provides model-specific thinking token budgets, effort-based scaling,
 * and adaptive adjustment based on session performance signals.
 *
 * Competitive context: Claude Code has `alwaysThinkingEnabled` setting and
 * `MAX_THINKING_TOKENS` env var (189 feature flags include
 * `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` and `CLAUDE_CODE_EFFORT_LEVEL`).
 * This module provides SUDO-AI's equivalent with adaptive adjustment.
 *
 * @module thinking-budget-types
 */

// ---------------------------------------------------------------------------
// Thinking Budget Levels
// ---------------------------------------------------------------------------

/** Thinking budget level. */
export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'maximum';

/** Effort level from the effort dial. */
export type EffortDialLevel = 'low' | 'medium' | 'high';

/** Reasoning level from brain types. */
export type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh';

// ---------------------------------------------------------------------------
// Model-Specific Budgets
// ---------------------------------------------------------------------------

/** Thinking budget configuration for a specific model. */
export interface ModelThinkingBudget {
  /** Model identifier (e.g., 'anthropic/claude-sonnet-4-6'). */
  model: string;
  /** Minimum thinking tokens allowed. */
  minTokens: number;
  /** Maximum thinking tokens allowed. */
  maxTokens: number;
  /** Default thinking tokens. */
  defaultTokens: number;
  /** Whether interleaved thinking is supported. */
  supportsInterleaved: boolean;
  /** Whether extended thinking is supported at all. */
  supportsExtended: boolean;
  /** Cost multiplier for thinking tokens (relative to output tokens). */
  costMultiplier: number;
}

/** Per-model thinking budget overrides. */
export type ModelBudgetOverrides = Partial<Pick<ModelThinkingBudget,
  'minTokens' | 'maxTokens' | 'defaultTokens' | 'supportsInterleaved' | 'costMultiplier'
>>;

// ---------------------------------------------------------------------------
// Adaptive Adjustment
// ---------------------------------------------------------------------------

/** Session performance signals used for adaptive adjustment. */
export interface PerformanceSignals {
  /** Error rate (0-1). */
  errorRate: number;
  /** Average time to first token in ms. */
  avgTTFTms: number;
  /** P95 inter-token latency in ms. */
  p95ITLms: number;
  /** Goal completion rate (0-1). */
  goalCompletionRate: number;
  /** Doom loop detection count. */
  doomLoopCount: number;
  /** Cancellation rate (0-1). */
  cancellationRate: number;
  /** Current feedback tier. */
  feedbackTier: string;
  /** Number of turns in the session. */
  turnCount: number;
}

/** Adjustment strategy for adapting thinking budget. */
export type AdjustmentStrategy =
  | 'conservative'   // Increase budget slowly, decrease quickly
  | 'balanced'       // Increase and decrease at similar rates
  | 'aggressive';    // Increase quickly for complex tasks, decrease slowly

/** Result of an adaptive thinking budget adjustment. */
export interface ThinkingBudgetAdjustment {
  /** Previous thinking token budget. */
  previousTokens: number;
  /** New thinking token budget. */
  newTokens: number;
  /** Reason for the adjustment. */
  reason: string;
  /** Whether the budget was increased. */
  increased: boolean;
  /** Confidence of the adjustment (0-1). */
  confidence: number;
  /** Which signals triggered the adjustment. */
  triggeredBy: string[];
}

// ---------------------------------------------------------------------------
// Thinking Budget Configuration
// ---------------------------------------------------------------------------

/** Configuration for the adaptive thinking budget manager. */
export interface ThinkingBudgetConfig {
  /** Global default thinking tokens (used when no model-specific budget). */
  defaultTokens: number;
  /** Maximum thinking tokens across all models. */
  globalMaxTokens: number;
  /** Minimum thinking tokens across all models. */
  globalMinTokens: number;
  /** Whether to enable adaptive adjustment (default: true). */
  adaptiveEnabled: boolean;
  /** Adjustment strategy (default: 'balanced'). */
  adjustmentStrategy: AdjustmentStrategy;
  /** Whether to persist budget state across sessions (default: true). */
  persistState: boolean;
  /** Path to persist budget state (default: 'data/thinking-budget-state.json'). */
  persistPath: string;
  /** Per-model budget overrides. */
  modelOverrides: Record<string, ModelBudgetOverrides>;
  /** Performance thresholds for adaptive adjustment. */
  thresholds: {
    /** Error rate above which to increase thinking budget. */
    errorRateIncreaseThreshold: number;
    /** Error rate below which to decrease thinking budget. */
    errorRateDecreaseThreshold: number;
    /** TTFT above which to increase thinking budget (ms). */
    ttftIncreaseThresholdMs: number;
    /** Goal completion rate below which to increase thinking budget. */
    goalCompletionIncreaseThreshold: number;
    /** Doom loop count above which to increase thinking budget. */
    doomLoopIncreaseThreshold: number;
    /** Cancellation rate above which to increase thinking budget. */
    cancellationIncreaseThreshold: number;
  };
  /** Adjustment amounts by strategy. */
  adjustments: {
    conservative: { increase: number; decrease: number };
    balanced: { increase: number; decrease: number };
    aggressive: { increase: number; decrease: number };
  };
}

/** Default thinking budget configuration. */
export const DEFAULT_THINKING_BUDGET_CONFIG: ThinkingBudgetConfig = {
  defaultTokens: 4096,
  globalMaxTokens: 65536,
  globalMinTokens: 0,
  adaptiveEnabled: true,
  adjustmentStrategy: 'balanced',
  persistState: true,
  persistPath: 'data/thinking-budget-state.json',
  modelOverrides: {
    'anthropic/claude-opus-4-8': { defaultTokens: 16384, maxTokens: 65536, supportsInterleaved: true },
    'anthropic/claude-sonnet-4-6': { defaultTokens: 8192, maxTokens: 32768, supportsInterleaved: true },
    'anthropic/claude-haiku-4-5': { defaultTokens: 2048, maxTokens: 16384, supportsInterleaved: false },
    'xai/grok-4-0709': { defaultTokens: 8192, maxTokens: 32768, supportsInterleaved: true },
    'openai/gpt-4o': { defaultTokens: 2048, maxTokens: 16384, supportsInterleaved: false },
    'google/gemini-2.5-pro': { defaultTokens: 8192, maxTokens: 32768, supportsInterleaved: true },
    'deepseek/deepseek-r1': { defaultTokens: 16384, maxTokens: 65536, supportsInterleaved: true },
    'ollama/deepseek-v4-pro': { defaultTokens: 4096, maxTokens: 16384, supportsInterleaved: false },
  },
  thresholds: {
    errorRateIncreaseThreshold: 0.15,
    errorRateDecreaseThreshold: 0.05,
    ttftIncreaseThresholdMs: 10000,
    goalCompletionIncreaseThreshold: 0.6,
    doomLoopIncreaseThreshold: 2,
    cancellationIncreaseThreshold: 0.2,
  },
  adjustments: {
    conservative: { increase: 0.1, decrease: 0.25 },
    balanced: { increase: 0.2, decrease: 0.15 },
    aggressive: { increase: 0.4, decrease: 0.1 },
  },
};

// ---------------------------------------------------------------------------
// Thinking Budget State
// ---------------------------------------------------------------------------

/** Persistent state for the thinking budget manager. */
export interface ThinkingBudgetState {
  /** Current thinking token budget for each model. */
  currentBudgets: Record<string, number>;
  /** Adjustment history (most recent first). */
  adjustmentHistory: ThinkingBudgetAdjustment[];
  /** Total number of adjustments made. */
  totalAdjustments: number;
  /** Total budget increase count. */
  increaseCount: number;
  /** Total budget decrease count. */
  decreaseCount: number;
  /** Last adjustment timestamp. */
  lastAdjustmentAt: string | null;
  /** Session ID for the current session. */
  currentSessionId: string | null;
}

// ---------------------------------------------------------------------------
// Thinking Budget Events
// ---------------------------------------------------------------------------

/** Events emitted by the thinking budget manager. */
export type ThinkingBudgetEvent =
  | { type: 'budget_adjusted'; adjustment: ThinkingBudgetAdjustment; model: string }
  | { type: 'budget_set'; model: string; tokens: number; previousTokens: number }
  | { type: 'budget_reset'; model: string }
  | { type: 'adaptive_enabled'; enabled: boolean }
  | { type: 'state_persisted'; path: string };

/** Event handler callback. */
export type ThinkingBudgetEventHandler = (event: ThinkingBudgetEvent) => void;

// ---------------------------------------------------------------------------
// Effort-to-Budget Mapping
// ---------------------------------------------------------------------------

/** Mapping from effort dial level to thinking token budget. */
export const EFFORT_TO_BUDGET: Record<EffortDialLevel, {
  thinkingTokens: number;
  reasoningLevel: ReasoningLevel;
  interleavedThinking: boolean;
  verificationDepth: 'none' | 'basic' | 'adversarial';
}> = {
  low: {
    thinkingTokens: 1024,
    reasoningLevel: 'low',
    interleavedThinking: false,
    verificationDepth: 'none',
  },
  medium: {
    thinkingTokens: 8192,
    reasoningLevel: 'medium',
    interleavedThinking: false,
    verificationDepth: 'basic',
  },
  high: {
    thinkingTokens: 32768,
    reasoningLevel: 'high',
    interleavedThinking: true,
    verificationDepth: 'adversarial',
  },
};

/** Mapping from thinking level to token budget. */
export const THINKING_LEVEL_TOKENS: Record<ThinkingLevel, number> = {
  none: 0,
  minimal: 256,
  low: 1024,
  medium: 8192,
  high: 16384,
  maximum: 32768,
};

/** Mapping from reasoning level to token budget. */
export const REASONING_LEVEL_TOKENS: Record<ReasoningLevel, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
};