/**
 * Optimization module — closed-loop auto-optimization for SUDO-AI content production.
 *
 * Re-exports all public types and the AutoOptimizer class so downstream code
 * can import from 'src/core/optimization' without referencing internal paths.
 */

export {
  AutoOptimizer,
  type ContentDecision,
  type OptimizationRule,
  type ContentBlueprint,
} from './auto-optimizer.js';
