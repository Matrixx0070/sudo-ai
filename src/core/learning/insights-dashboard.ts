/**
 * @file learning/insights-dashboard.ts
 * @description Insights Dashboard & Analytics — aggregates session signals, cost data,
 * tool usage, and file change history into comprehensive analytics dashboards.
 *
 * Competitive context: Claude Code has a 115KB `/insights` command with usage
 * analytics, cost tracking, and session analysis. This module provides SUDO-AI's
 * equivalent insights dashboard with health scoring, anomaly detection, and
 * recommendations.
 *
 * @module insights-dashboard
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type {
  TimeRange,
  DateRange,
  SessionAnalytics,
  CostAnalytics,
  ModelCostEntry,
  ToolUsageAnalytics,
  ToolUsageEntry,
  FileChangeAnalytics,
  Anomaly,
  InsightsDashboard,
  InsightsConfig,
  InsightsFormat,
} from './insights-dashboard-types.js';
import { DEFAULT_INSIGHTS_CONFIG } from './insights-dashboard-types.js';
import type { SessionSignals } from './session-signals.js';
import { toSqliteTimestamp } from './trace-store.js';

const log = createLogger('learning:insights');

// SQL row shapes — assertions at the better-sqlite3 boundary name these
// contracts. ApiCallLogRow is pinned by cost-tracker.ts DDL; the file_changes
// aggregates by file-history.ts createTables(). SUM() returns NULL on an
// empty set, hence the nullable sum columns.
interface ApiCallLogRow {
  id: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  latency_ms: number;
  success: number;
  error: string | null;
  source: string;
  called_at: string;
}

// Pinned by the traces DDL in trace-store.ts (SCHEMA_TRACES). success is
// NOT NULL there; created_at is stored in SQLite datetime('now') space
// format, which is UTC.
interface TraceRow {
  tool_name: string | null;
  success: number;
  error_message: string | null;
  latency_ms: number | null;
  created_at: string;
}

interface CountRow {
  count: number;
}

interface LinesSumRow {
  added: number | null;
  deleted: number | null;
}

// ---------------------------------------------------------------------------
// Time Range Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a TimeRange string into start/end Date objects.
 */
export function parseTimeRange(range: TimeRange): DateRange {
  const end = new Date();
  const start = new Date();
  let label: string;

  switch (range) {
    case '1h':
      start.setHours(start.getHours() - 1);
      label = 'Last hour';
      break;
    case '6h':
      start.setHours(start.getHours() - 6);
      label = 'Last 6 hours';
      break;
    case '24h':
      start.setDate(start.getDate() - 1);
      label = 'Last 24 hours';
      break;
    case '7d':
      start.setDate(start.getDate() - 7);
      label = 'Last 7 days';
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      label = 'Last 30 days';
      break;
    case '90d':
      start.setDate(start.getDate() - 90);
      label = 'Last 90 days';
      break;
    case 'all':
      start.setTime(0); // Unix epoch
      label = 'All time';
      break;
    default:
      start.setDate(start.getDate() - 1);
      label = 'Last 24 hours';
  }

  return { start, end, label };
}

/**
 * Format a date as an ISO date string (YYYY-MM-DD).
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

/**
 * Format a number as USD.
 */
function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

/**
 * Format milliseconds as a human-readable duration.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Format large numbers with K/M suffixes.
 */
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

// ---------------------------------------------------------------------------
// Insights Dashboard Generator
// ---------------------------------------------------------------------------

/**
 * Aggregates session signals, cost data, tool usage, and file change history
 * into comprehensive analytics dashboards.
 *
 * Data sources:
 * - Session signals (from data/signals/)
 * - Cost data (from data/mind.db api_call_log or billing cost tracker)
 * - Tool traces (from data/traces.db)
 * - File change history (from data/file-history.db)
 */
export class InsightsDashboardGenerator {
  private config: InsightsConfig;
  private dataRoot: string;

  constructor(config?: Partial<InsightsConfig>, dataRoot?: string) {
    this.config = { ...DEFAULT_INSIGHTS_CONFIG, ...config };
    this.dataRoot = dataRoot ?? 'data';
  }

  // -------------------------------------------------------------------------
  // Main Dashboard Generation
  // -------------------------------------------------------------------------

  /**
   * Generate a complete insights dashboard.
   */
  async generateDashboard(timeRange?: TimeRange): Promise<InsightsDashboard> {
    const range = timeRange ?? this.config.defaultTimeRange;
    const { start, end } = parseTimeRange(range);

    log.info({ range, start: start.toISOString(), end: end.toISOString() }, 'Generating insights dashboard');

    const [sessions, costs, tools, fileChanges, anomalies] = await Promise.all([
      this.getSessionAnalytics(start, end),
      this.config.includeCosts ? this.getCostAnalytics(start, end) : Promise.resolve(this.emptyCostAnalytics()),
      this.getToolUsageAnalytics(start, end),
      this.config.includeFileChanges ? this.getFileChangeAnalytics(start, end) : Promise.resolve(this.emptyFileChangeAnalytics()),
      this.config.includeAnomalies ? this.detectAnomalies(start, end) : Promise.resolve([]),
    ]);

    const healthScore = this.calculateHealthScore(sessions, costs, tools);
    const recommendations = this.generateRecommendations(sessions, costs, tools, anomalies);

    return {
      generatedAt: new Date().toISOString(),
      timeRange: range,
      sessions,
      costs,
      tools,
      fileChanges,
      anomalies,
      healthScore,
      recommendations,
    };
  }

  // -------------------------------------------------------------------------
  // Session Analytics
  // -------------------------------------------------------------------------

  /**
   * Get session analytics by reading signal files.
   */
  private async getSessionAnalytics(start: Date, end: Date): Promise<SessionAnalytics> {
    const signalsDir = path.join(this.dataRoot, 'signals');
    const sessions: Array<Partial<SessionSignals>> = [];

    try {
      if (fs.existsSync(signalsDir)) {
        const files = fs.readdirSync(signalsDir).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(signalsDir, file), 'utf8');
            // Signal files on disk may predate fields added to SessionSignals.
            const signal = JSON.parse(content) as Partial<SessionSignals>;
            const signalTime = new Date(signal.startTime ?? signal.endTime ?? 0);
            if (signalTime >= start && signalTime <= end) {
              sessions.push(signal);
            }
          } catch {
            // Skip invalid signal files
          }
        }
      }
    } catch (err) {
      log.debug({ err: String(err) }, 'Failed to read signals directory');
    }

    // Calculate aggregates from signal data
    const totalSessions = sessions.length;
    let totalTurns = 0;
    let totalToolCalls = 0;
    let totalDuration = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTTFT = 0;
    let ttftCount = 0;
    let totalErrors = 0;
    let totalCancellations = 0;
    let doomLoops = 0;
    let completedCount = 0;
    const goalTypes: Record<string, number> = {};
    const sessionsByDay: Record<string, number> = {};
    const modelUsage: Record<string, number> = {};
    const feedbackTiers: Record<string, number> = {};
    const durations: number[] = [];
    const itlValues: number[] = [];

    for (const session of sessions) {
      totalTurns += session.turnCount ?? 0;
      totalToolCalls += session.toolCallCount ?? 0;
      totalDuration += session.totalDurationMs ?? 0;
      totalInputTokens += session.tokensUsed?.input ?? 0;
      totalOutputTokens += session.tokensUsed?.output ?? 0;
      totalErrors += session.errorCount ?? 0;
      totalCancellations += session.cancellationCount ?? 0;
      doomLoops += session.doomLoopDetections ?? 0;

      const ttft = session.avgTimeToFirstTokenMs ?? 0;
      if (ttft > 0) {
        totalTTFT += ttft;
        ttftCount++;
      }

      if (session.goalCompletionVerdict === 'completed') completedCount++;
      const goalType = session.goalClassificationType ?? 'unknown';
      goalTypes[goalType] = (goalTypes[goalType] ?? 0) + 1;

      const model = session.modelUsed ?? 'unknown';
      modelUsage[model] = (modelUsage[model] ?? 0) + 1;

      const tier = session.feedbackTier ?? 'unknown';
      feedbackTiers[tier] = (feedbackTiers[tier] ?? 0) + 1;

      const day = formatDate(new Date(session.startTime ?? Date.now()));
      sessionsByDay[day] = (sessionsByDay[day] ?? 0) + 1;

      const duration = session.totalDurationMs ?? 0;
      if (duration > 0) durations.push(duration);

      // Collect ITL values
      const p50 = session.itlP50Ms ?? 0;
      if (p50 > 0) itlValues.push(p50);
    }

    // Calculate median duration
    durations.sort((a, b) => a - b);
    const medianDuration = durations.length > 0
      ? durations[Math.floor(durations.length / 2)]!
      : 0;

    return {
      totalSessions,
      avgTurnsPerSession: totalSessions > 0 ? totalTurns / totalSessions : 0,
      avgToolCallsPerSession: totalSessions > 0 ? totalToolCalls / totalSessions : 0,
      avgDurationMs: totalSessions > 0 ? totalDuration / totalSessions : 0,
      medianDurationMs: medianDuration,
      totalInputTokens,
      totalOutputTokens,
      avgTTFTms: ttftCount > 0 ? totalTTFT / ttftCount : 0,
      p50ITLms: itlValues.length > 0 ? itlValues[Math.floor(itlValues.length * 0.5)] ?? 0 : 0,
      p95ITLms: itlValues.length > 0 ? itlValues[Math.floor(itlValues.length * 0.95)] ?? 0 : 0,
      p99ITLms: itlValues.length > 0 ? itlValues[Math.floor(itlValues.length * 0.99)] ?? 0 : 0,
      totalErrors,
      totalCancellations,
      errorRate: totalTurns > 0 ? totalErrors / totalTurns : 0,
      cancellationRate: totalSessions > 0 ? totalCancellations / totalSessions : 0,
      doomLoopDetections: doomLoops,
      goalCompletionRate: totalSessions > 0 ? completedCount / totalSessions : 0,
      goalTypes,
      sessionsByDay,
      modelUsage,
      feedbackTiers,
    };
  }

  // -------------------------------------------------------------------------
  // Cost Analytics
  // -------------------------------------------------------------------------

  /**
   * Get cost analytics by reading billing data.
   */
  private async getCostAnalytics(start: Date, end: Date): Promise<CostAnalytics> {
    // Try to read from billing cost tracker database
    const billingDbPath = path.resolve(this.dataRoot, 'mind.db');
    let totalCost = 0;
    let todayCost = 0;
    let weekCost = 0;
    let monthCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const byModelMap = new Map<string, ModelCostEntry>();
    const costByDay: Record<string, number> = {};

    try {
      const Database = await import('better-sqlite3');
      if (fs.existsSync(billingDbPath)) {
        const db = new Database.default(billingDbPath, { readonly: true });

        try {
          // Check if api_call_log table exists
          const tableExists = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='api_call_log'",
          ).get();

          if (tableExists) {
            const rows = db.prepare(
              'SELECT * FROM api_call_log WHERE called_at >= ? AND called_at <= ?',
            ).all(start.toISOString(), end.toISOString()) as ApiCallLogRow[];

            const today = formatDate(new Date());
            const weekAgo = new Date();
            weekAgo.setDate(weekAgo.getDate() - 7);
            const monthAgo = new Date();
            monthAgo.setDate(monthAgo.getDate() - 30);

            for (const row of rows) {
              const cost = row.estimated_cost_usd ?? 0;
              totalCost += cost;

              const rowDate = formatDate(new Date(row.called_at));
              costByDay[rowDate] = (costByDay[rowDate] ?? 0) + cost;

              if (rowDate === today) todayCost += cost;
              if (new Date(row.called_at) >= weekAgo) weekCost += cost;
              if (new Date(row.called_at) >= monthAgo) monthCost += cost;

              totalInputTokens += row.prompt_tokens ?? 0;
              totalOutputTokens += row.completion_tokens ?? 0;

              // Group by model
              const model = row.model ?? 'unknown';
              const entry = byModelMap.get(model) ?? {
                model,
                callCount: 0,
                inputTokens: 0,
                outputTokens: 0,
                estimatedCostUsd: 0,
                avgLatencyMs: 0,
                successRate: 0,
                _totalLatency: 0,
                _successCount: 0,
              };
              entry.callCount++;
              entry.inputTokens += row.prompt_tokens ?? 0;
              entry.outputTokens += row.completion_tokens ?? 0;
              entry.estimatedCostUsd += cost;
              entry._totalLatency += row.latency_ms ?? 0;
              if (row.success ?? 0) entry._successCount++;
              byModelMap.set(model, entry);
            }
          }
        } finally {
          db.close();
        }
      }
    } catch (err) {
      log.debug({ err: String(err) }, 'Failed to read billing data');
    }

    // Calculate model stats
    const byModel = Array.from(byModelMap.values()).map((entry) => ({
      model: entry.model,
      callCount: entry.callCount,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      estimatedCostUsd: entry.estimatedCostUsd,
      avgLatencyMs: entry.callCount > 0 ? entry._totalLatency / entry.callCount : 0,
      successRate: entry.callCount > 0 ? entry._successCount / entry.callCount : 0,
    }));

    // Remove internal fields
    const cleanByModel = byModel.map(({ avgLatencyMs, successRate, ...rest }) => ({
      ...rest,
      avgLatencyMs,
      successRate,
    }));

    const tokensPerDollar = totalCost > 0 ? (totalInputTokens + totalOutputTokens) / totalCost : 0;

    return {
      totalCostUsd: totalCost,
      todayCostUsd: todayCost,
      weekCostUsd: weekCost,
      monthCostUsd: monthCost,
      byModel: cleanByModel as ModelCostEntry[],
      costByDay,
      totalInputTokens,
      totalOutputTokens,
      tokensPerDollar,
      budgetLimitSet: this.config.budgetLimitUsd !== undefined,
      budgetLimitUsd: this.config.budgetLimitUsd,
      budgetRemainingUsd: this.config.budgetLimitUsd !== undefined
        ? Math.max(0, this.config.budgetLimitUsd - totalCost)
        : undefined,
      budgetUtilizationPercent: this.config.budgetLimitUsd !== undefined
        ? (totalCost / this.config.budgetLimitUsd) * 100
        : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Tool Usage Analytics
  // -------------------------------------------------------------------------

  /**
   * Get tool usage analytics by reading trace data.
   */
  private async getToolUsageAnalytics(start: Date, end: Date): Promise<ToolUsageAnalytics> {
    const tracesDbPath = path.resolve(this.dataRoot, 'traces.db');
    const toolMap = new Map<string, { calls: number; successes: number; errors: number; latencies: number[]; errorMessages: Map<string, number> }>();
    const callsByDay: Record<string, number> = {};

    try {
      const Database = await import('better-sqlite3');
      if (fs.existsSync(tracesDbPath)) {
        const db = new Database.default(tracesDbPath, { readonly: true });

        try {
          const tableExists = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='traces'",
          ).get();

          if (tableExists) {
            const rows = db.prepare(
              "SELECT tool_name, success, error_message, latency_ms, created_at FROM traces WHERE trace_type = 'tool_call' AND created_at >= ? AND created_at <= ?",
            ).all(toSqliteTimestamp(start.toISOString()), toSqliteTimestamp(end.toISOString())) as TraceRow[];

            for (const row of rows) {
              const toolName = row.tool_name ?? 'unknown';
              const success = row.success;
              const latency = row.latency_ms ?? 0;
              const error = row.error_message ?? '';
              // created_at is UTC in space format; parse explicitly as UTC so
              // the day bucket matches formatDate's toISOString.
              const day = formatDate(new Date(row.created_at.replace(' ', 'T') + 'Z'));

              callsByDay[day] = (callsByDay[day] ?? 0) + 1;

              const entry = toolMap.get(toolName) ?? {
                calls: 0, successes: 0, errors: 0, latencies: [], errorMessages: new Map<string, number>(),
              };
              entry.calls++;
              if (success) entry.successes++;
              else {
                entry.errors++;
                if (error) entry.errorMessages.set(error, (entry.errorMessages.get(error) ?? 0) + 1);
              }
              if (latency > 0) entry.latencies.push(latency);
              toolMap.set(toolName, entry);
            }
          }
        } finally {
          db.close();
        }
      }
    } catch (err) {
      log.debug({ err: String(err) }, 'Failed to read traces data');
    }

    // Build tool entries
    const topTools: ToolUsageEntry[] = Array.from(toolMap.entries())
      .map(([name, data]) => {
        const sortedLatencies = data.latencies.sort((a, b) => a - b);
        const p95Index = Math.floor(sortedLatencies.length * 0.95);
        const topErrors = Array.from(data.errorMessages.entries()).sort((a, b) => b[1] - a[1]);
        return {
          toolName: name,
          callCount: data.calls,
          successCount: data.successes,
          errorCount: data.errors,
          successRate: data.calls > 0 ? data.successes / data.calls : 0,
          avgLatencyMs: data.latencies.length > 0 ? data.latencies.reduce((a, b) => a + b, 0) / data.latencies.length : 0,
          p95LatencyMs: sortedLatencies.length > 0 ? sortedLatencies[p95Index] ?? 0 : 0,
          topError: topErrors.length > 0 ? topErrors[0]![0] : undefined,
        };
      })
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 10);

    const totalCalls = topTools.reduce((sum, t) => sum + t.callCount, 0);
    const totalSuccesses = topTools.reduce((sum, t) => sum + t.successCount, 0);
    const totalToolErrors = topTools.reduce((sum, t) => sum + t.errorCount, 0);
    const errorRates: Record<string, number> = {};
    for (const tool of topTools) {
      // Every entry in topTools has callCount >= 1, so successRate is well-defined
      // and errorRate is simply its complement (an all-failure tool must report 1, not 0).
      errorRates[tool.toolName] = 1 - tool.successRate;
    }

    return {
      totalCalls,
      totalSuccesses,
      totalErrors: totalToolErrors,
      overallSuccessRate: totalCalls > 0 ? totalSuccesses / totalCalls : 0,
      topTools,
      callsByDay,
      errorRates,
    };
  }

  // -------------------------------------------------------------------------
  // File Change Analytics
  // -------------------------------------------------------------------------

  /**
   * Get file change analytics from the file history store.
   */
  private async getFileChangeAnalytics(start: Date, end: Date): Promise<FileChangeAnalytics> {
    // Try to read from file-history.db
    const fileHistoryDbPath = path.resolve(this.dataRoot, 'file-history.db');

    let totalChanges = 0;
    let uniqueFiles = 0;
    let uniqueSessions = 0;
    let totalLinesAdded = 0;
    let totalLinesDeleted = 0;
    const changesByType: Record<string, number> = {};
    const changesByTool: Record<string, number> = {};
    const topFiles: Array<{ filePath: string; changeCount: number }> = [];
    const changesByDay: Record<string, number> = {};

    try {
      const Database = await import('better-sqlite3');
      if (fs.existsSync(fileHistoryDbPath)) {
        const db = new Database.default(fileHistoryDbPath, { readonly: true });

        try {
          const startTime = start.toISOString();
          const endTime = end.toISOString();

          // Total changes
          totalChanges = (db.prepare(
            'SELECT COUNT(*) as count FROM file_changes WHERE timestamp >= ? AND timestamp <= ?',
          ).get(startTime, endTime) as CountRow | undefined)?.count ?? 0;

          // Unique files
          uniqueFiles = (db.prepare(
            'SELECT COUNT(DISTINCT file_path) as count FROM file_changes WHERE timestamp >= ? AND timestamp <= ?',
          ).get(startTime, endTime) as CountRow | undefined)?.count ?? 0;

          // Unique sessions
          uniqueSessions = (db.prepare(
            'SELECT COUNT(DISTINCT session_id) as count FROM file_changes WHERE timestamp >= ? AND timestamp <= ?',
          ).get(startTime, endTime) as CountRow | undefined)?.count ?? 0;

          // Lines added/deleted
          const linesRow = db.prepare(
            'SELECT SUM(lines_added) as added, SUM(lines_deleted) as deleted FROM file_changes WHERE timestamp >= ? AND timestamp <= ?',
          ).get(startTime, endTime) as LinesSumRow | undefined;
          totalLinesAdded = linesRow?.added ?? 0;
          totalLinesDeleted = linesRow?.deleted ?? 0;

          // Changes by type
          const typeRows = db.prepare(
            'SELECT change_type, COUNT(*) as count FROM file_changes WHERE timestamp >= ? AND timestamp <= ? GROUP BY change_type',
          ).all(startTime, endTime) as Array<{ change_type: string; count: number }>;
          for (const row of typeRows) {
            changesByType[row.change_type] = row.count;
          }

          // Changes by tool
          const toolRows = db.prepare(
            'SELECT tool_name, COUNT(*) as count FROM file_changes WHERE timestamp >= ? AND timestamp <= ? GROUP BY tool_name ORDER BY count DESC',
          ).all(startTime, endTime) as Array<{ tool_name: string; count: number }>;
          for (const row of toolRows) {
            if (row.tool_name) changesByTool[row.tool_name] = row.count;
          }

          // Top files
          const fileRows = db.prepare(
            'SELECT file_path, COUNT(*) as count FROM file_changes WHERE timestamp >= ? AND timestamp <= ? GROUP BY file_path ORDER BY count DESC LIMIT 10',
          ).all(startTime, endTime) as Array<{ file_path: string; count: number }>;
          for (const row of fileRows) {
            topFiles.push({ filePath: row.file_path, changeCount: row.count });
          }

          // Changes by day
          const dayRows = db.prepare(
            "SELECT substr(timestamp, 1, 10) as day, COUNT(*) as count FROM file_changes WHERE timestamp >= ? AND timestamp <= ? GROUP BY day ORDER BY day",
          ).all(startTime, endTime) as Array<{ day: string; count: number }>;
          for (const row of dayRows) {
            changesByDay[row.day] = row.count;
          }
        } finally {
          db.close();
        }
      }
    } catch (err) {
      log.debug({ err: String(err) }, 'Failed to read file history data');
    }

    return {
      totalChanges,
      uniqueFiles,
      uniqueSessions,
      totalLinesAdded,
      totalLinesDeleted,
      netLines: totalLinesAdded - totalLinesDeleted,
      changesByType,
      changesByTool,
      topFiles,
      changesByDay,
    };
  }

  // -------------------------------------------------------------------------
  // Anomaly Detection
  // -------------------------------------------------------------------------

  /**
   * Detect anomalies in session signals, costs, and tool usage.
   */
  private async detectAnomalies(start: Date, end: Date): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];
    const now = new Date().toISOString();

    // Get session analytics for anomaly detection
    const sessions = await this.getSessionAnalytics(start, end);

    // 1. High error rate
    if (sessions.errorRate > 0.2) {
      anomalies.push({
        type: 'error_burst',
        severity: sessions.errorRate > 0.5 ? 'critical' : 'warning',
        description: `High error rate: ${(sessions.errorRate * 100).toFixed(1)}% of turns resulted in errors`,
        detectedAt: now,
        metric: 'errorRate',
        expectedValue: 0.05,
        actualValue: sessions.errorRate,
        suggestion: 'Review recent error patterns and consider switching to a more reliable model or adjusting tool parameters.',
      });
    }

    // 2. High cancellation rate
    if (sessions.cancellationRate > 0.3) {
      anomalies.push({
        type: 'unusual_pattern',
        severity: 'warning',
        description: `High cancellation rate: ${(sessions.cancellationRate * 100).toFixed(1)}% of sessions were cancelled`,
        detectedAt: now,
        metric: 'cancellationRate',
        expectedValue: 0.1,
        actualValue: sessions.cancellationRate,
        suggestion: 'Investigate why users are cancelling sessions. May indicate unclear goals or poor model performance.',
      });
    }

    // 3. High TTFT
    if (sessions.avgTTFTms > 10000) {
      anomalies.push({
        type: 'latency_spike',
        severity: sessions.avgTTFTms > 30000 ? 'critical' : 'warning',
        description: `High average time to first token: ${formatDuration(sessions.avgTTFTms)}`,
        detectedAt: now,
        metric: 'avgTTFTms',
        expectedValue: 3000,
        actualValue: sessions.avgTTFTms,
        suggestion: 'Consider using a faster model or enabling streaming to reduce perceived latency.',
      });
    }

    // 4. Doom loop detection
    if (sessions.doomLoopDetections > 0) {
      anomalies.push({
        type: 'error_burst',
        severity: sessions.doomLoopDetections > 3 ? 'critical' : 'warning',
        description: `${sessions.doomLoopDetections} doom loop(s) detected across sessions`,
        detectedAt: now,
        metric: 'doomLoopDetections',
        expectedValue: 0,
        actualValue: sessions.doomLoopDetections,
        suggestion: 'Review tool parameters and approval thresholds. Doom loops indicate repetitive failed actions.',
      });
    }

    // 5. Low goal completion
    if (sessions.totalSessions > 5 && sessions.goalCompletionRate < 0.5) {
      anomalies.push({
        type: 'success_drop',
        severity: 'warning',
        description: `Low goal completion rate: ${(sessions.goalCompletionRate * 100).toFixed(1)}%`,
        detectedAt: now,
        metric: 'goalCompletionRate',
        expectedValue: 0.7,
        actualValue: sessions.goalCompletionRate,
        suggestion: 'Review session goals and model capabilities. Low completion may indicate task-model mismatch.',
      });
    }

    return anomalies;
  }

  // -------------------------------------------------------------------------
  // Health Score
  // -------------------------------------------------------------------------

  /**
   * Calculate a health score (0-100) based on session analytics, costs, and tool usage.
   */
  private calculateHealthScore(
    sessions: SessionAnalytics,
    costs: CostAnalytics,
    tools: ToolUsageAnalytics,
  ): number {
    const weights = this.config.healthWeights;

    // Success rate component (0-100)
    const successScore = Math.min(100, tools.overallSuccessRate * 100);

    // Latency component (0-100, lower is better)
    const latencyScore = Math.max(0, 100 - Math.min(100, sessions.avgTTFTms / 500));

    // Error rate component (0-100, lower error rate is better)
    const errorScore = Math.max(0, 100 - sessions.errorRate * 500);

    // Cost efficiency (0-100, more tokens per dollar is better)
    const costEfficiency = costs.tokensPerDollar > 0
      ? Math.min(100, costs.tokensPerDollar / 1000)
      : 50; // Default to 50 if no cost data

    const healthScore = Math.round(
      successScore * weights.successRate +
      latencyScore * weights.latency +
      errorScore * weights.errorRate +
      costEfficiency * weights.costEfficiency,
    );

    return Math.max(0, Math.min(100, healthScore));
  }

  // -------------------------------------------------------------------------
  // Recommendations
  // -------------------------------------------------------------------------

  /**
   * Generate actionable recommendations based on analytics.
   */
  private generateRecommendations(
    sessions: SessionAnalytics,
    costs: CostAnalytics,
    tools: ToolUsageAnalytics,
    anomalies: Anomaly[],
  ): string[] {
    const recommendations: string[] = [];

    // Model recommendations
    if (sessions.modelUsage) {
      const models = Object.entries(sessions.modelUsage);
      if (models.length > 0) {
        const topModel = models.sort((a, b) => b[1] - a[1])[0]!;
        if (topModel[0] !== 'unknown') {
          recommendations.push(`Most used model: ${topModel[0]} (${topModel[1]} sessions). ${topModel[0].includes('opus') ? 'Consider Sonnet for faster responses on simpler tasks.' : topModel[0].includes('haiku') ? 'Consider upgrading to Sonnet for better quality on complex tasks.' : ''}`);
        }
      }
    }

    // Cost recommendations
    if (costs.totalCostUsd > 0 && costs.budgetLimitSet && costs.budgetUtilizationPercent !== undefined) {
      if (costs.budgetUtilizationPercent > 80) {
        recommendations.push(`Budget utilization at ${costs.budgetUtilizationPercent.toFixed(1)}%. Consider reducing token usage or switching to a more cost-effective model.`);
      }
    }

    // Tool recommendations
    const errorTools = tools.topTools.filter((t) => t.errorCount > 0 && t.successRate < 0.9);
    if (errorTools.length > 0) {
      for (const tool of errorTools.slice(0, 3)) {
        recommendations.push(`Tool "${tool.toolName}" has ${(1 - tool.successRate) * 100}% error rate. ${tool.topError ? `Most common error: ${tool.topError}` : 'Review tool parameters.'}`);
      }
    }

    // Latency recommendations
    if (sessions.avgTTFTms > 5000) {
      recommendations.push(`Average time to first token is ${formatDuration(sessions.avgTTFTms)}. Consider enabling streaming or using a faster model.`);
    }

    // Error recommendations
    if (sessions.errorRate > 0.1) {
      recommendations.push(`Error rate is ${(sessions.errorRate * 100).toFixed(1)}%. Review recent errors and consider adjusting approval thresholds.`);
    }

    // Completion recommendations
    if (sessions.totalSessions > 5 && sessions.goalCompletionRate < 0.7) {
      recommendations.push(`Goal completion rate is ${(sessions.goalCompletionRate * 100).toFixed(1)}%. Consider improving task decomposition or model selection.`);
    }

    // Anomaly recommendations
    for (const anomaly of anomalies) {
      if (anomaly.severity === 'critical') {
        recommendations.push(`CRITICAL: ${anomaly.suggestion}`);
      }
    }

    return recommendations;
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  /**
   * Format the dashboard as a Markdown report.
   */
  formatMarkdown(dashboard: InsightsDashboard): string {
    const lines: string[] = [];
    const s = dashboard.sessions;
    const c = dashboard.costs;
    const t = dashboard.tools;
    const f = dashboard.fileChanges;

    lines.push('# 📊 SUDO-AI Insights Dashboard');
    lines.push('');
    lines.push(`**Time Range:** ${parseTimeRange(dashboard.timeRange).label}`);
    lines.push(`**Generated:** ${dashboard.generatedAt}`);
    lines.push(`**Health Score:** ${dashboard.healthScore}/100`);
    lines.push('');

    // Session Analytics
    lines.push('## 📈 Session Analytics');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Sessions | ${s.totalSessions} |`);
    lines.push(`| Avg Turns/Session | ${s.avgTurnsPerSession.toFixed(1)} |`);
    lines.push(`| Avg Tool Calls/Session | ${s.avgToolCallsPerSession.toFixed(1)} |`);
    lines.push(`| Avg Duration | ${formatDuration(s.avgDurationMs)} |`);
    lines.push(`| Median Duration | ${formatDuration(s.medianDurationMs)} |`);
    lines.push(`| Total Input Tokens | ${formatNumber(s.totalInputTokens)} |`);
    lines.push(`| Total Output Tokens | ${formatNumber(s.totalOutputTokens)} |`);
    lines.push(`| Avg TTFT | ${formatDuration(s.avgTTFTms)} |`);
    lines.push(`| P50 ITL | ${formatDuration(s.p50ITLms)} |`);
    lines.push(`| P95 ITL | ${formatDuration(s.p95ITLms)} |`);
    lines.push(`| Error Rate | ${(s.errorRate * 100).toFixed(1)}% |`);
    lines.push(`| Goal Completion | ${(s.goalCompletionRate * 100).toFixed(1)}% |`);
    lines.push('');

    // Cost Analytics
    if (dashboard.costs.totalCostUsd > 0 || dashboard.costs.budgetLimitSet) {
      lines.push('## 💰 Cost Analytics');
      lines.push('');
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Total Cost | ${formatUsd(c.totalCostUsd)} |`);
      lines.push(`| Today | ${formatUsd(c.todayCostUsd)} |`);
      lines.push(`| This Week | ${formatUsd(c.weekCostUsd)} |`);
      lines.push(`| This Month | ${formatUsd(c.monthCostUsd)} |`);
      lines.push(`| Tokens/Dollar | ${c.tokensPerDollar.toFixed(0)} |`);
      if (c.budgetLimitSet) {
        lines.push(`| Budget Limit | ${formatUsd(c.budgetLimitUsd ?? 0)} |`);
        lines.push(`| Budget Used | ${c.budgetUtilizationPercent?.toFixed(1) ?? 0}% |`);
      }
      lines.push('');

      if (c.byModel.length > 0) {
        lines.push('### Cost by Model');
        lines.push('');
        lines.push(`| Model | Calls | Input Tokens | Output Tokens | Cost | Avg Latency | Success Rate |`);
        lines.push(`|-------|-------|-------------|--------------|------|-------------|-------------|`);
        for (const model of c.byModel) {
          lines.push(`| ${model.model} | ${model.callCount} | ${formatNumber(model.inputTokens)} | ${formatNumber(model.outputTokens)} | ${formatUsd(model.estimatedCostUsd)} | ${formatDuration(model.avgLatencyMs)} | ${(model.successRate * 100).toFixed(1)}% |`);
        }
        lines.push('');
      }
    }

    // Tool Usage
    if (t.topTools.length > 0) {
      lines.push('## 🔧 Tool Usage');
      lines.push('');
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Total Calls | ${t.totalCalls} |`);
      lines.push(`| Success Rate | ${(t.overallSuccessRate * 100).toFixed(1)}% |`);
      lines.push(`| Total Errors | ${t.totalErrors} |`);
      lines.push('');

      lines.push(`| Tool | Calls | Success Rate | Avg Latency | P95 Latency | Top Error |`);
      lines.push(`|------|-------|-------------|-------------|-------------|-----------|`);
      for (const tool of t.topTools) {
        lines.push(`| ${tool.toolName} | ${tool.callCount} | ${(tool.successRate * 100).toFixed(1)}% | ${formatDuration(tool.avgLatencyMs)} | ${formatDuration(tool.p95LatencyMs)} | ${tool.topError ?? '—'} |`);
      }
      lines.push('');
    }

    // File Changes
    if (f.totalChanges > 0) {
      lines.push('## 📝 File Changes');
      lines.push('');
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Total Changes | ${f.totalChanges} |`);
      lines.push(`| Unique Files | ${f.uniqueFiles} |`);
      lines.push(`| Lines Added | ${f.totalLinesAdded} |`);
      lines.push(`| Lines Deleted | ${f.totalLinesDeleted} |`);
      lines.push(`| Net Lines | ${f.netLines > 0 ? '+' : ''}${f.netLines} |`);
      lines.push('');

      if (f.topFiles.length > 0) {
        lines.push('### Most Changed Files');
        lines.push('');
        for (const file of f.topFiles) {
          lines.push(`- \`${file.filePath}\`: ${file.changeCount} changes`);
        }
        lines.push('');
      }
    }

    // Anomalies
    if (dashboard.anomalies.length > 0) {
      lines.push('## ⚠️ Anomalies');
      lines.push('');
      for (const anomaly of dashboard.anomalies) {
        const icon = anomaly.severity === 'critical' ? '🔴' : anomaly.severity === 'warning' ? '🟡' : 'ℹ️';
        lines.push(`${icon} **${anomaly.type}**: ${anomaly.description}`);
        if (anomaly.suggestion) {
          lines.push(`   → ${anomaly.suggestion}`);
        }
      }
      lines.push('');
    }

    // Recommendations
    if (dashboard.recommendations.length > 0) {
      lines.push('## 💡 Recommendations');
      lines.push('');
      for (let i = 0; i < dashboard.recommendations.length; i++) {
        lines.push(`${i + 1}. ${dashboard.recommendations[i]}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format the dashboard as JSON.
   */
  formatJson(dashboard: InsightsDashboard): string {
    return JSON.stringify(dashboard, null, 2);
  }

  /**
   * Format the dashboard as a brief summary.
   */
  formatSummary(dashboard: InsightsDashboard): string {
    const s = dashboard.sessions;
    const c = dashboard.costs;
    const health = dashboard.healthScore;
    const healthIcon = health >= 80 ? '🟢' : health >= 60 ? '🟡' : '🔴';

    const parts: string[] = [
      `${healthIcon} Health: ${health}/100`,
      `${s.totalSessions} sessions | ${formatDuration(s.avgDurationMs)} avg | ${(s.goalCompletionRate * 100).toFixed(0)}% completion`,
      `${(s.errorRate * 100).toFixed(1)}% error rate | ${s.totalErrors} errors`,
      `Tokens: ${formatNumber(s.totalInputTokens)} in / ${formatNumber(s.totalOutputTokens)} out`,
    ];

    if (c.totalCostUsd > 0) {
      parts.push(`Cost: ${formatUsd(c.totalCostUsd)} total | ${formatUsd(c.todayCostUsd)} today`);
    }

    if (dashboard.anomalies.length > 0) {
      const critical = dashboard.anomalies.filter((a) => a.severity === 'critical').length;
      const warnings = dashboard.anomalies.filter((a) => a.severity === 'warning').length;
      if (critical > 0) parts.push(`🔴 ${critical} critical issues`);
      if (warnings > 0) parts.push(`🟡 ${warnings} warnings`);
    }

    return parts.join('\n');
  }

  /**
   * Format the dashboard in the specified format.
   */
  format(dashboard: InsightsDashboard, format: InsightsFormat = 'markdown'): string {
    switch (format) {
      case 'json':
        return this.formatJson(dashboard);
      case 'summary':
        return this.formatSummary(dashboard);
      case 'markdown':
      default:
        return this.formatMarkdown(dashboard);
    }
  }

  // -------------------------------------------------------------------------
  // Empty Defaults
  // -------------------------------------------------------------------------

  private emptyCostAnalytics(): CostAnalytics {
    return {
      totalCostUsd: 0,
      todayCostUsd: 0,
      weekCostUsd: 0,
      monthCostUsd: 0,
      byModel: [],
      costByDay: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensPerDollar: 0,
      budgetLimitSet: this.config.budgetLimitUsd !== undefined,
      budgetLimitUsd: this.config.budgetLimitUsd,
      budgetRemainingUsd: this.config.budgetLimitUsd,
      budgetUtilizationPercent: undefined,
    };
  }

  private emptyFileChangeAnalytics(): FileChangeAnalytics {
    return {
      totalChanges: 0,
      uniqueFiles: 0,
      uniqueSessions: 0,
      totalLinesAdded: 0,
      totalLinesDeleted: 0,
      netLines: 0,
      changesByType: {},
      changesByTool: {},
      topFiles: [],
      changesByDay: {},
    };
  }
}

/** Singleton instance. */
export const insightsDashboard = new InsightsDashboardGenerator();