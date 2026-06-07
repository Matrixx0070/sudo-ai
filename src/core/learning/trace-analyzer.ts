/**
 * @file trace-analyzer.ts
 * @description Trace analysis engine for SUDO-AI v4.
 * Computes statistical summaries from the TraceStore to identify patterns,
 * optimize routing, and detect anomalies.
 */

import { TraceStore, type TraceRecord, type ErrorType } from './trace-store.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('learning:trace-analyzer');

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ModelToolStats {
  model: string;
  toolName: string;
  totalCalls: number;
  successRate: number;
  avgLatencyMs: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  errorBreakdown: Record<string, number>;
}

export interface ModelCategoryStats {
  model: string;
  category: string;
  totalCalls: number;
  successRate: number;
  avgLatencyMs: number;
  avgConfidence: number;
}

export interface ToolErrorCluster {
  toolName: string;
  errorType: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sampleMessages: string[];
}

export interface AnomalyReport {
  type: 'latency_spike' | 'success_drop' | 'error_burst' | 'model_drift';
  severity: 'info' | 'warning' | 'critical';
  details: string;
  detectedAt: string;
}

export interface AnalysisWindow {
  since: string;
  until: string;
  label: string;
}

export interface AnalyzerResult {
  modelToolStats: ModelToolStats[];
  modelCategoryStats: ModelCategoryStats[];
  errorClusters: ToolErrorCluster[];
  anomalies: AnomalyReport[];
  window: AnalysisWindow;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Percentile from a pre-sorted numeric array. */
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const now = (): string => new Date().toISOString();

const defaultWindow = (): AnalysisWindow => ({
  since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  until: now(),
  label: 'last_24h',
});

// ---------------------------------------------------------------------------
// TraceAnalyzer
// ---------------------------------------------------------------------------

/**
 * Statistical analysis engine over the TraceStore.
 * Computes percentile latencies, clusters errors, detects anomalies, and
 * generates routing recommendations.
 */
export class TraceAnalyzer {
  private traceStore: TraceStore;
  private analysesRun = 0;
  private lastAnalyzedAt: string | null = null;

  constructor(traceStore: TraceStore) {
    this.traceStore = traceStore;
  }

  // -- Full analysis ---------------------------------------------------------

  /** Run a complete analysis: refresh aggregates, compute stats, detect anomalies. */
  analyze(window?: AnalysisWindow): AnalyzerResult {
    const w = window ?? defaultWindow();
    log.info({ window: w.label }, 'Starting trace analysis');

    this.traceStore.refreshAggregates();

    const result: AnalyzerResult = {
      modelToolStats: this.getModelToolStats(undefined, undefined, w),
      modelCategoryStats: this.getModelCategoryStats(undefined, undefined, w),
      errorClusters: this.getErrorClusters(w.since),
      anomalies: this.detectAnomalies(w),
      window: w,
    };

    this.analysesRun++;
    this.lastAnalyzedAt = now();
    log.info({ window: w.label, stats: result.modelToolStats.length, anomalies: result.anomalies.length }, 'Analysis complete');
    return result;
  }

  // -- Per-model+tool stats --------------------------------------------------

  /** Compute per-model+tool stats with percentile latencies and error breakdowns. */
  getModelToolStats(model?: string, toolName?: string, window?: AnalysisWindow): ModelToolStats[] {
    const w = window ?? defaultWindow();
    const traces = this.traceStore.query({ type: 'tool_call', model, toolName, since: w.since, until: w.until, limit: 10000 });

    // Group by (model, toolName)
    const groups = new Map<string, TraceRecord[]>();
    for (const t of traces) {
      const key = `${t.model ?? 'unknown'}\0${t.toolName ?? 'unknown'}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }

    const results: ModelToolStats[] = [];
    for (const [key, recs] of groups) {
      const [m, tool] = key.split('\0');
      const successes = recs.filter(r => r.success).length;
      const latencies = recs.map(r => r.latencyMs ?? 0).sort((a, b) => a - b);

      // Error type breakdown from failed records
      const errorBreakdown: Record<string, number> = {};
      for (const r of recs) {
        if (!r.success && r.errorType) errorBreakdown[r.errorType] = (errorBreakdown[r.errorType] ?? 0) + 1;
      }

      results.push({
        model: m, toolName: tool, totalCalls: recs.length,
        successRate: recs.length > 0 ? successes / recs.length : 0,
        avgLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
        p50Latency: pct(latencies, 50), p95Latency: pct(latencies, 95), p99Latency: pct(latencies, 99),
        errorBreakdown,
      });
    }
    return results;
  }

  // -- Per-model+category stats ----------------------------------------------

  /** Compute per-model+category aggregates for routing optimization. */
  getModelCategoryStats(model?: string, category?: string, window?: AnalysisWindow): ModelCategoryStats[] {
    const w = window ?? defaultWindow();
    const traces = this.traceStore.query({ model, since: w.since, until: w.until, limit: 10000 })
      .filter(t => t.category != null && (category == null || t.category === category));

    const groups = new Map<string, TraceRecord[]>();
    for (const t of traces) {
      const key = `${t.model ?? 'unknown'}\0${t.category}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }

    const results: ModelCategoryStats[] = [];
    for (const [key, recs] of groups) {
      const [m, cat] = key.split('\0');
      const successes = recs.filter(r => r.success).length;
      const confs = recs.map(r => r.routingConfidence).filter((c): c is number => c != null);
      const lats = recs.map(r => r.latencyMs ?? 0);

      results.push({
        model: m, category: cat, totalCalls: recs.length,
        successRate: recs.length > 0 ? successes / recs.length : 0,
        avgLatencyMs: lats.length > 0 ? lats.reduce((a, b) => a + b, 0) / lats.length : 0,
        avgConfidence: confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0,
      });
    }
    return results;
  }

  // -- Error clusters --------------------------------------------------------

  /** Enriched error clusters with first/last seen and sample messages. */
  getErrorClusters(since?: string): ToolErrorCluster[] {
    const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const raw = this.traceStore.getErrorClusters(cutoff);

    return raw.map(cluster => {
      const errorTraces = this.traceStore.query({
        toolName: cluster.toolName, errorType: cluster.errorType as ErrorType,
        success: false, since: cutoff, limit: 200,
      });
      const timestamps = errorTraces.map(t => t.createdAt).filter((t): t is string => t != null).sort();

      return {
        toolName: cluster.toolName, errorType: cluster.errorType, count: cluster.count,
        firstSeen: timestamps[0] ?? cutoff, lastSeen: timestamps[timestamps.length - 1] ?? cutoff,
        sampleMessages: cluster.recentErrors,
      };
    });
  }

  // -- Anomaly detection -----------------------------------------------------

  /**
   * Rule-based anomaly detection:
   *  1. Latency spike: P95 > 2x avg -> warning, > 5x -> critical
   *  2. Success drop: rate < 80% -> warning, < 50% -> critical
   *  3. Error burst: >10 errors in 5 min for same tool -> critical
   *  4. Model drift: success rate changes >20% vs previous window -> info
   */
  detectAnomalies(window?: AnalysisWindow): AnomalyReport[] {
    const w = window ?? defaultWindow();
    const anomalies: AnomalyReport[] = [];
    const detectedAt = now();

    const toolStats = this.getModelToolStats(undefined, undefined, w);

    // Rule 1: Latency spikes
    for (const s of toolStats) {
      if (s.totalCalls < 5) continue;
      if (s.p95Latency > 5 * s.avgLatencyMs) {
        anomalies.push({ type: 'latency_spike', severity: 'critical',
          details: `P95 (${s.p95Latency.toFixed(0)}ms) >5x avg (${s.avgLatencyMs.toFixed(0)}ms) for ${s.model}/${s.toolName}`, detectedAt });
      } else if (s.p95Latency > 2 * s.avgLatencyMs) {
        anomalies.push({ type: 'latency_spike', severity: 'warning',
          details: `P95 (${s.p95Latency.toFixed(0)}ms) >2x avg (${s.avgLatencyMs.toFixed(0)}ms) for ${s.model}/${s.toolName}`, detectedAt });
      }
    }

    // Rule 2: Success rate drops
    for (const s of toolStats) {
      if (s.totalCalls < 3) continue;
      if (s.successRate < 0.5) {
        anomalies.push({ type: 'success_drop', severity: 'critical',
          details: `Success ${(s.successRate * 100).toFixed(1)}% (<50%) for ${s.model}/${s.toolName}`, detectedAt });
      } else if (s.successRate < 0.8) {
        anomalies.push({ type: 'success_drop', severity: 'warning',
          details: `Success ${(s.successRate * 100).toFixed(1)}% (<80%) for ${s.model}/${s.toolName}`, detectedAt });
      }
    }

    // Rule 3: Error bursts — >10 errors in 5-min window for same tool
    const errorTraces = this.traceStore.query({ success: false, since: w.since, until: w.until, limit: 10000 });
    const burstMap = new Map<string, number>();
    for (const t of errorTraces) {
      if (!t.createdAt) continue;
      const bucket = new Date(t.createdAt);
      bucket.setMinutes(Math.floor(bucket.getMinutes() / 5) * 5, 0, 0);
      const bk = `${t.toolName ?? 'unknown'}\0${bucket.toISOString()}`;
      burstMap.set(bk, (burstMap.get(bk) ?? 0) + 1);
    }
    for (const [key, count] of burstMap) {
      if (count > 10) {
        const [tool, bucket] = key.split('\0');
        anomalies.push({ type: 'error_burst', severity: 'critical',
          details: `${count} errors in 5-min window starting ${bucket} for tool ${tool}`, detectedAt });
      }
    }

    // Rule 4: Model drift — compare current vs previous window success rate
    const windowDur = new Date(w.until).getTime() - new Date(w.since).getTime();
    const prevStats = this.getModelToolStats(undefined, undefined, {
      since: new Date(new Date(w.since).getTime() - windowDur).toISOString(),
      until: w.since, label: 'previous',
    });
    const prevMap = new Map(prevStats.map(s => [`${s.model}\0${s.toolName}`, s.successRate] as const));

    for (const s of toolStats) {
      const prev = prevMap.get(`${s.model}\0${s.toolName}`);
      if (prev == null) continue;
      const drift = s.successRate - prev;
      if (Math.abs(drift) > 0.2) {
        const dir = drift > 0 ? 'improved' : 'degraded';
        anomalies.push({ type: 'model_drift', severity: 'info',
          details: `${s.model}/${s.toolName} success ${dir} by ${(Math.abs(drift) * 100).toFixed(1)}% (was ${(prev * 100).toFixed(1)}%, now ${(s.successRate * 100).toFixed(1)}%)`, detectedAt });
      }
    }

    return anomalies;
  }

  // -- Recommendations --------------------------------------------------------

  /** Generate routing recommendations: identify better model+tool pairings. */
  getRecommendations(): { model: string; tool: string; reason: string; expectedImprovement: string }[] {
    const recs: { model: string; tool: string; reason: string; expectedImprovement: string }[] = [];
    const stats = this.getModelToolStats(undefined, undefined, defaultWindow());

    const toolMap = new Map<string, ModelToolStats[]>();
    for (const s of stats) {
      if (!toolMap.has(s.toolName)) toolMap.set(s.toolName, []);
      toolMap.get(s.toolName)!.push(s);
    }

    for (const [tool, ms] of toolMap) {
      if (ms.length < 2) continue;
      ms.sort((a, b) => a.successRate !== b.successRate ? b.successRate - a.successRate : a.avgLatencyMs - b.avgLatencyMs);
      const [best, worst] = [ms[0], ms[ms.length - 1]];

      if (worst.successRate < best.successRate - 0.1 || worst.avgLatencyMs > best.avgLatencyMs * 1.5) {
        recs.push({
          model: best.model, tool,
          reason: `${worst.model}: ${(worst.successRate * 100).toFixed(0)}% success, ${worst.avgLatencyMs.toFixed(0)}ms avg underperforms`,
          expectedImprovement: `+${((best.successRate - worst.successRate) * 100).toFixed(0)}% success, ${(worst.avgLatencyMs - best.avgLatencyMs).toFixed(0)}ms faster`,
        });
      }
    }
    return recs;
  }

  // -- Metadata --------------------------------------------------------------

  getStats(): { analysesRun: number; lastAnalyzedAt: string | null } {
    return { analysesRun: this.analysesRun, lastAnalyzedAt: this.lastAnalyzedAt };
  }
}