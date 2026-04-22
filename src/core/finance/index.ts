/**
 * Finance module — public API surface.
 *
 * Re-exports all types and the RevenueTracker class from revenue-tracker.ts
 * so consumers can import from the module root without knowing internal paths.
 */

export { RevenueTracker } from './revenue-tracker.js';

export type {
  RevenueEntry,
  CostEntry,
  BudgetLine,
  RevenueSummary,
  CostSummary,
  ROIResult,
  SelfFundingStatus,
  Period,
  RoiPeriod,
} from './types.js';
