/**
 * Finance module shared types and period filter helper.
 *
 * Extracted to keep revenue-tracker.ts under 300 lines.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RevenueEntry {
  id: string;
  source: string;      // 'youtube_adsense' | 'youtube_memberships' | 'affiliate' | 'digital_product' | 'freelance' | 'other'
  amount: number;      // USD
  currency: string;
  description: string;
  date: string;        // ISO-8601 date string
}

export interface CostEntry {
  id: string;
  category: string;    // 'api' | 'hosting' | 'tools' | 'assets' | 'marketing' | 'other'
  amount: number;      // USD
  description: string;
  date: string;        // ISO-8601 date string
}

export interface BudgetLine {
  category: string;
  budget: number;
  spent: number;
  remaining: number;
  percentUsed: number;
}

export interface RevenueSummary {
  total: number;
  bySource: Record<string, number>;
  entries: RevenueEntry[];
}

export interface CostSummary {
  total: number;
  byCategory: Record<string, number>;
  entries: CostEntry[];
}

export interface ROIResult {
  revenue: number;
  costs: number;
  profit: number;
  roi: number; // percentage: (profit / costs) * 100, or 0 when costs = 0
}

export interface SelfFundingStatus {
  monthlyRevenue: number;
  monthlyCosts: number;
  selfFunding: boolean;
  deficit: number; // positive = shortfall, negative = surplus
}

// ---------------------------------------------------------------------------
// Internal row shapes returned by better-sqlite3
// ---------------------------------------------------------------------------

export interface RevenueRow {
  id: string;
  source: string;
  amount: number;
  currency: string;
  description: string;
  date: string;
}

export interface CostRow {
  id: string;
  category: string;
  amount: number;
  description: string;
  date: string;
}

export interface AggRow {
  key: string;
  total: number;
}

export interface BudgetRow {
  category: string;
  monthly_limit: number;
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

export type Period = 'today' | 'week' | 'month' | 'all';
export type RoiPeriod = 'week' | 'month' | 'all';

export function periodFilter(period: Period | RoiPeriod): string {
  switch (period) {
    case 'today': return "date(date) = date('now')";
    case 'week':  return "date(date) >= date('now', '-6 days')";
    case 'month': return "strftime('%Y-%m', date) = strftime('%Y-%m', 'now')";
    case 'all':   return '1=1';
    default:      return '1=1';
  }
}
