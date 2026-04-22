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

// SUDOAPI provider utilities
export { getSudoAPIModel, isSudoAPIReady, SUDOAPI_URL, SUDOAPI_MODEL_MAP } from './sudoapi-provider.js';

// Upgrade 28: Template Engine
export { renderTemplate } from './template-engine.js';
export type { TemplateVars } from './template-engine.js';

// Upgrade 55: Multi-Model Consensus
export { queryAllModels, raceModels, formatComparison } from './model-consensus.js';
export type { ModelAnswer, ConsensusResult } from './model-consensus.js';

// Upgrade 63: Model Cost Optimizer
export { pickOptimalModel, estimateTaskComplexity, getModelCosts } from './cost-optimizer.js';
export type { ModelCost, OptimizationGoal } from './cost-optimizer.js';
