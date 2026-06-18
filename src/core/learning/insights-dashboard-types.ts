/**
 * @file learning/insights-dashboard-types.ts
 * @description Type definitions for the Insights Dashboard & Analytics module.
 *
 * Aggregates session signals, cost data, tool usage, and file change history
 * into comprehensive analytics dashboards and reports. Provides a `/insights`
 * slash command for terminal access.
 *
 * Competitive context: Claude Code has a 115KB `/insights` command with usage
 * analytics, cost tracking, and session analysis. This module provides
 * SUDO-AI's equivalent analytics dashboard.
 *
 * @module insights-dashboard-types
 */

// ---------------------------------------------------------------------------
// Time Ranges
// ---------------------------------------------------------------------------

/** Time range for analytics queries. */
export type TimeRange = '1h' | '6h' | '24h' | '7d' | '30d' | '90d' | 'all';

/** Parsed date range. */
export interface DateRange {
  start: Date;
  end: Date;
  label: string;
}

// ---------------------------------------------------------------------------
// Session Analytics
// ---------------------------------------------------------------------------

/** Session analytics summary. */
export interface SessionAnalytics {
  /** Total number of sessions in the time range. */
  totalSessions: number;
  /** Average turns per session. */
  avgTurnsPerSession: number;
  /** Average tool calls per session. */
  avgToolCallsPerSession: number;
  /** Average session duration in ms. */
  avgDurationMs: number;
  /** Median session duration in ms. */
  medianDurationMs: number;
  /** Total tokens used (input). */
  totalInputTokens: number;
  /** Total tokens used (output). */
  totalOutputTokens: number;
  /** Average time to first token in ms. */
  avgTTFTms: number;
  /** P50 inter-token latency in ms. */
  p50ITLms: number;
  /** P95 inter-token latency in ms. */
  p95ITLms: number;
  /** P99 inter-token latency in ms. */
  p99ITLms: number;
  /** Total errors across all sessions. */
  totalErrors: number;
  /** Total cancellations across all sessions. */
  totalCancellations: number;
  /** Error rate (errors / total turns). */
  errorRate: number;
  /** Cancellation rate (cancellations / total sessions). */
  cancellationRate: number;
  /** Doom loop detections. */
  doomLoopDetections: number;
  /** Goal completion rate. */
  goalCompletionRate: number;
  /** Most common goal classification types. */
  goalTypes: Record<string, number>;
  /** Sessions per day. */
  sessionsByDay: Record<string, number>;
  /** Model usage distribution. */
  modelUsage: Record<string, number>;
  /** Feedback tier distribution. */
  feedbackTiers: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Cost Analytics
// ---------------------------------------------------------------------------

/** Cost breakdown by model. */
export interface ModelCostEntry {
  /** Model name. */
  model: string;
  /** Number of calls. */
  callCount: number;
  /** Total input tokens. */
  inputTokens: number;
  /** Total output tokens. */
  outputTokens: number;
  /** Estimated cost in USD. */
  estimatedCostUsd: number;
  /** Average latency in ms. */
  avgLatencyMs: number;
  /** Success rate (0-1). */
  successRate: number;
  /** Internal accumulator: total latency in ms across calls (used to compute avgLatencyMs). */
  _totalLatency: number;
  /** Internal accumulator: number of successful calls (used to compute successRate). */
  _successCount: number;
}

/** Cost breakdown by caller source (consciousness, agent, api, …). */
export interface SourceCostEntry {
  /** Caller source tag. */
  source: string;
  /** Number of calls. */
  callCount: number;
  /** Estimated cost in USD. */
  estimatedCostUsd: number;
}

/** Cost analytics summary. */
export interface CostAnalytics {
  /** Total estimated cost in USD. */
  totalCostUsd: number;
  /** Cost today in USD. */
  todayCostUsd: number;
  /** Cost this week in USD. */
  weekCostUsd: number;
  /** Cost this month in USD. */
  monthCostUsd: number;
  /** Cost breakdown by model. */
  byModel: ModelCostEntry[];
  /** Cost breakdown by caller source. */
  bySource: SourceCostEntry[];
  /** Cost per day. */
  costByDay: Record<string, number>;
  /** Total input tokens. */
  totalInputTokens: number;
  /** Total output tokens. */
  totalOutputTokens: number;
  /** Tokens per dollar. */
  tokensPerDollar: number;
  /** Whether budget limit is set. */
  budgetLimitSet: boolean;
  /** Budget limit in USD (if set). */
  budgetLimitUsd?: number;
  /** Budget remaining in USD (if set). */
  budgetRemainingUsd?: number;
  /** Budget utilization percentage (0-100). */
  budgetUtilizationPercent?: number;
}

// ---------------------------------------------------------------------------
// Tool Usage Analytics
// ---------------------------------------------------------------------------

/** Tool usage statistics entry. */
export interface ToolUsageEntry {
  /** Tool name. */
  toolName: string;
  /** Number of calls. */
  callCount: number;
  /** Number of successful calls. */
  successCount: number;
  /** Number of failed calls. */
  errorCount: number;
  /** Success rate (0-1). */
  successRate: number;
  /** Average latency in ms. */
  avgLatencyMs: number;
  /** P95 latency in ms. */
  p95LatencyMs: number;
  /** Most common error (if any). */
  topError?: string;
}

/** Tool usage analytics. */
export interface ToolUsageAnalytics {
  /** Total tool calls. */
  totalCalls: number;
  /** Total successful calls. */
  totalSuccesses: number;
  /** Total errors. */
  totalErrors: number;
  /** Overall success rate. */
  overallSuccessRate: number;
  /** Top 10 most used tools. */
  topTools: ToolUsageEntry[];
  /** Tool calls by day. */
  callsByDay: Record<string, number>;
  /** Error rate by tool. */
  errorRates: Record<string, number>;
}

// ---------------------------------------------------------------------------
// File Change Analytics
// ---------------------------------------------------------------------------

/** File change analytics. */
export interface FileChangeAnalytics {
  /** Total number of file changes. */
  totalChanges: number;
  /** Number of unique files changed. */
  uniqueFiles: number;
  /** Number of unique sessions that made changes. */
  uniqueSessions: number;
  /** Lines added across all changes. */
  totalLinesAdded: number;
  /** Lines deleted across all changes. */
  totalLinesDeleted: number;
  /** Net lines changed (added - deleted). */
  netLines: number;
  /** Changes by type. */
  changesByType: Record<string, number>;
  /** Changes by tool. */
  changesByTool: Record<string, number>;
  /** Top 10 most changed files. */
  topFiles: Array<{ filePath: string; changeCount: number }>;
  /** Changes per day. */
  changesByDay: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------

/** Detected anomaly. */
export interface Anomaly {
  /** Anomaly type. */
  type: 'latency_spike' | 'success_drop' | 'error_burst' | 'cost_spike' | 'unusual_pattern';
  /** Severity. */
  severity: 'info' | 'warning' | 'critical';
  /** Description. */
  description: string;
  /** When it was detected. */
  detectedAt: string;
  /** Related metric. */
  metric: string;
  /** Expected value. */
  expectedValue: number;
  /** Actual value. */
  actualValue: number;
  /** Suggested action. */
  suggestion: string;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Complete insights dashboard. */
export interface InsightsDashboard {
  /** When this dashboard was generated. */
  generatedAt: string;
  /** Time range covered. */
  timeRange: TimeRange;
  /** Session analytics. */
  sessions: SessionAnalytics;
  /** Cost analytics. */
  costs: CostAnalytics;
  /** Tool usage analytics. */
  tools: ToolUsageAnalytics;
  /** File change analytics. */
  fileChanges: FileChangeAnalytics;
  /** Detected anomalies. */
  anomalies: Anomaly[];
  /** Health score (0-100). */
  healthScore: number;
  /** Recommendations. */
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Insights Command
// ---------------------------------------------------------------------------

/** Output format for the insights command. */
export type InsightsFormat = 'markdown' | 'json' | 'summary';

/** Configuration for the insights dashboard. */
export interface InsightsConfig {
  /** Time range for analytics (default: '24h'). */
  defaultTimeRange: TimeRange;
  /** Whether to include cost data (default: true). */
  includeCosts: boolean;
  /** Whether to include file change history (default: true). */
  includeFileChanges: boolean;
  /** Whether to include anomaly detection (default: true). */
  includeAnomalies: boolean;
  /** Health score weights. */
  healthWeights: {
    successRate: number;
    latency: number;
    errorRate: number;
    costEfficiency: number;
  };
  /** Budget limit in USD (optional). */
  budgetLimitUsd?: number;
  /** Pricing per 1K tokens by model. */
  pricingPerModel: Record<string, { input: number; output: number }>;
}

/** Default insights configuration. */
export const DEFAULT_INSIGHTS_CONFIG: InsightsConfig = {
  defaultTimeRange: '24h',
  includeCosts: true,
  includeFileChanges: true,
  includeAnomalies: true,
  healthWeights: {
    successRate: 0.3,
    latency: 0.2,
    errorRate: 0.3,
    costEfficiency: 0.2,
  },
  pricingPerModel: {
    'claude-opus-4-8': { input: 0.015, output: 0.075 },
    'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
    'claude-haiku-4-5': { input: 0.0008, output: 0.004 },
    'gpt-4o': { input: 0.0025, output: 0.01 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gemini-2.5-pro': { input: 0.00125, output: 0.005 },
    'gemini-2.5-flash': { input: 0.00015, output: 0.0006 },
    'deepseek-r1': { input: 0.00055, output: 0.00219 },
    'deepseek-v3': { input: 0.00014, output: 0.00028 },
  },
};