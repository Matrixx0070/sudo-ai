/**
 * Brain module — public barrel export.
 *
 * Import from this file for all brain functionality:
 *   import { Brain, ModelFailover, getPersona, getMood } from '@core/brain';
 */

// Main class
export { Brain } from './brain.js';

// Failover system
export { ModelFailover } from './failover.js';

// Provider utilities
export {
  getProvider,
  getModel,
  listAvailableProviders,
  getEnvKeyForProvider,
} from './providers.js';
export type { ProviderName } from './providers.js';

// System prompt
export { assembleSystemPrompt, readWorkspaceFile } from './system-prompt.js';

// Personas
export {
  getPersona,
  listPersonas,
  getPersonaSystemBlock,
  getPersonaTemperature,
} from './personas.js';
export type { PersonaDescriptor } from './personas.js';

// Moods
export {
  getMood,
  listMoods,
  getMoodSystemBlock,
  getMoodTemperatureDelta,
} from './moods.js';
export type { MoodDescriptor } from './moods.js';

// Cost utilities
export { estimateCost, buildTokenUsage, COST_RATES } from './costs.js';

// Types
export type {
  PersonaType,
  MoodType,
  ReasoningLevel,
  BrainRequest,
  BrainResponse,
  BrainMessage,
  ToolCallFromLLM,
  TokenUsage,
  ModelProfile,
  SystemPromptOptions,
  ErrorCategory,
} from './types.js';

// Model routing
export { routeModel, isAutoModel } from './model-router.js';
export type { RoutingDecision, RouterCategory } from './model-router.js';

// Upgrade 28: Template Engine
export { renderTemplate } from './template-engine.js';
export type { TemplateVars } from './template-engine.js';

// Upgrade 55: Multi-Model Consensus
export { queryAllModels, raceModels, formatComparison } from './model-consensus.js';
export type { ModelAnswer, ConsensusResult } from './model-consensus.js';

// Upgrade 63: Model Cost Optimizer
export { pickOptimalModel, estimateTaskComplexity, getModelCosts } from './cost-optimizer.js';
export type { ModelCost, OptimizationGoal } from './cost-optimizer.js';

// Negative Router — 3-tier DFA routing engine
export { NegativeRouter, getDefaultRouter } from './negative-router.js';
export type { NegativeRouterConfig, NegativeRule, RoutingResult, RoutingTier } from './negative-router.js';

// Context Compressor — graduated 4-stage compression
export { ContextCompressor } from './context-compressor.js';
export type { CompressionStage, CompressionResult, CompressionConfig } from './context-compressor.js';

// Adaptive Thinking Budget — model-specific thinking token control
export { ThinkingBudgetManager, thinkingBudgetManager } from './thinking-budget.js';
export type {
  ThinkingLevel,
  EffortDialLevel,
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
export {
  DEFAULT_THINKING_BUDGET_CONFIG,
  EFFORT_TO_BUDGET,
  THINKING_LEVEL_TOKENS,
  REASONING_LEVEL_TOKENS,
} from './thinking-budget-types.js';
