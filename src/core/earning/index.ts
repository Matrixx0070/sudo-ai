/**
 * Barrel export for src/core/earning.
 */

export { EarningTracker } from './tracker.js';
export { CohortOptimizer } from './optimizer.js';
// (F102) RevenueTracker retired — non-persistent duplicate; billing api_call_log is the ledger.

export type {
  VideoMetrics,
  RevenueReport,
  OptimizationResult,
  RevenueMilestone,
  ROIReport,
  CohortAnalysis,
  YouTubeAnalyticsResponse,
  YouTubeAnalyticsRow,
} from './types.js';
