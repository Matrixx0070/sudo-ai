/**
 * @file cost-optimizer.ts
 * @description Upgrade 63 — Model Cost Optimizer.
 *
 * Automatically selects the cheapest / fastest / smartest model
 * that can satisfy the task's required capability level.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:cost-optimizer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelCost {
  model: string;
  inputPer1k: number;
  outputPer1k: number;
  avgLatencyMs: number;
  capability: number; // 1-10
}

export type OptimizationGoal = 'cheapest' | 'fastest' | 'smartest' | 'balanced';

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

const MODEL_COSTS: ModelCost[] = [
  { model: 'ollama/deepseek-v4-pro:cloud', inputPer1k: 0, outputPer1k: 0, avgLatencyMs: 1000, capability: 7  },
  { model: 'xai/grok-4-0709',             inputPer1k: 2.0, outputPer1k: 6.0, avgLatencyMs: 1500, capability: 10 },
  { model: 'anthropic/claude-sonnet-4-5',  inputPer1k: 3.0, outputPer1k: 15.0, avgLatencyMs: 1800, capability: 9  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pick the optimal model based on task complexity and goal.
 *
 * @param taskComplexity - 1-10 estimate produced by `estimateTaskComplexity`
 * @param goal           - optimisation strategy
 * @returns model string suitable for passing to the Brain
 */
export function pickOptimalModel(
  taskComplexity: number,
  goal: OptimizationGoal = 'balanced',
): string {
  if (typeof taskComplexity !== 'number' || taskComplexity < 1 || taskComplexity > 10) {
    throw new RangeError(`taskComplexity must be 1-10, got: ${taskComplexity}`);
  }

  const costs = [...MODEL_COSTS]; // avoid mutating the source array

  let chosen: string;

  switch (goal) {
    case 'cheapest':
      chosen = costs.sort((a, b) =>
        (a.inputPer1k + a.outputPer1k) - (b.inputPer1k + b.outputPer1k),
      )[0].model;
      break;

    case 'fastest':
      chosen = costs.sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)[0].model;
      break;

    case 'smartest':
      chosen = costs.sort((a, b) => b.capability - a.capability)[0].model;
      break;

    case 'balanced':
    default: {
      const minCapability = Math.min(taskComplexity, 10);
      const viable = costs.filter(m => m.capability >= minCapability);
      if (viable.length === 0) {
        chosen = costs.sort((a, b) => b.capability - a.capability)[0].model;
      } else {
        chosen = viable.sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)[0].model;
      }
      break;
    }
  }

  log.info({ goal, taskComplexity, chosen }, 'Model selected by cost-optimizer');
  return chosen;
}

/**
 * Heuristic complexity estimator — maps a raw message to a 1-10 score.
 */
export function estimateTaskComplexity(message: string): number {
  if (typeof message !== 'string') throw new TypeError('message must be a string');

  const hasSimple    = /^(hi|hello|hey|thanks|ok|yes|no|what time)/i.test(message.trim());
  const hasCode      = /```|function|class|import|const|let|var/.test(message);
  const hasAnalysis  = /analyze|explain|compare|evaluate|review/.test(message.toLowerCase());
  const isLong       = message.length > 500;

  if (hasSimple)                 return 2;
  if (hasCode && hasAnalysis)    return 9;
  if (hasCode)                   return 7;
  if (hasAnalysis)               return 6;
  if (isLong)                    return 7;
  return 4;
}

/** Return a shallow copy of the model cost table (safe for external mutation). */
export function getModelCosts(): ModelCost[] {
  return MODEL_COSTS.map(m => ({ ...m }));
}
