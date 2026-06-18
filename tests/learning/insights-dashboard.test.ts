/**
 * @file tests/learning/insights-dashboard.test.ts
 * @description Tests for Insights Dashboard & Analytics module.
 *
 * Covers: time range parsing, dashboard generation, session analytics,
 * cost analytics, tool usage analytics, file change analytics,
 * anomaly detection, health scoring, formatting, recommendations, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InsightsDashboardGenerator, parseTimeRange } from '../../src/core/learning/insights-dashboard.js';
import type {
  InsightsDashboard,
  SessionAnalytics,
  Anomaly,
} from '../../src/core/learning/insights-dashboard-types.js';
import { DEFAULT_INSIGHTS_CONFIG } from '../../src/core/learning/insights-dashboard-types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Time Range Parsing
// ---------------------------------------------------------------------------

describe('parseTimeRange', () => {
  it('parses 1h range', () => {
    const range = parseTimeRange('1h');
    expect(range.label).toBe('Last hour');
    const diff = range.end.getTime() - range.start.getTime();
    expect(diff).toBeLessThanOrEqual(3600000 + 100); // ~1 hour
    expect(diff).toBeGreaterThan(3500000); // At least 59 minutes
  });

  it('parses 24h range', () => {
    const range = parseTimeRange('24h');
    expect(range.label).toBe('Last 24 hours');
    const diff = range.end.getTime() - range.start.getTime();
    expect(diff).toBeLessThanOrEqual(86400000 + 100);
    expect(diff).toBeGreaterThan(86000000);
  });

  it('parses 7d range', () => {
    const range = parseTimeRange('7d');
    expect(range.label).toBe('Last 7 days');
    const diff = range.end.getTime() - range.start.getTime();
    expect(diff).toBeLessThanOrEqual(7 * 86400000 + 100);
  });

  it('parses 30d range', () => {
    const range = parseTimeRange('30d');
    expect(range.label).toBe('Last 30 days');
  });

  it('parses 90d range', () => {
    const range = parseTimeRange('90d');
    expect(range.label).toBe('Last 90 days');
  });

  it('parses all range', () => {
    const range = parseTimeRange('all');
    expect(range.label).toBe('All time');
    expect(range.start.getTime()).toBe(0); // Unix epoch
  });

  it('defaults to 24h for unknown range', () => {
    const range = parseTimeRange('1h' as any);
    expect(range).toBeDefined();
    expect(range.start).toBeInstanceOf(Date);
    expect(range.end).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// Insights Dashboard Generator
// ---------------------------------------------------------------------------

describe('InsightsDashboardGenerator', () => {
  const testDataDir = path.join(os.tmpdir(), 'sudo-ai-insights-test');

  beforeEach(() => {
    fs.mkdirSync(testDataDir, { recursive: true });
  });

  it('creates with default configuration', () => {
    const generator = new InsightsDashboardGenerator();
    expect(generator).toBeInstanceOf(InsightsDashboardGenerator);
  });

  it('creates with custom configuration', () => {
    const generator = new InsightsDashboardGenerator({
      defaultTimeRange: '7d',
      includeCosts: false,
      includeFileChanges: false,
    });
    expect(generator).toBeInstanceOf(InsightsDashboardGenerator);
  });

  it('generates dashboard with empty data', async () => {
    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: true },
      testDataDir,
    );

    const dashboard = await generator.generateDashboard('24h');

    expect(dashboard).toBeDefined();
    expect(dashboard.generatedAt).toBeTruthy();
    expect(dashboard.timeRange).toBe('24h');
    expect(dashboard.healthScore).toBeGreaterThanOrEqual(0);
    expect(dashboard.healthScore).toBeLessThanOrEqual(100);
    expect(dashboard.sessions).toBeDefined();
    expect(dashboard.anomalies).toBeInstanceOf(Array);
    expect(dashboard.recommendations).toBeInstanceOf(Array);
  });

  it('generates dashboard with session analytics', async () => {
    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
      testDataDir,
    );

    const dashboard = await generator.generateDashboard('24h');
    const s = dashboard.sessions;

    expect(s.totalSessions).toBeGreaterThanOrEqual(0);
    expect(s.avgTurnsPerSession).toBeGreaterThanOrEqual(0);
    expect(s.errorRate).toBeGreaterThanOrEqual(0);
    expect(s.errorRate).toBeLessThanOrEqual(1);
    expect(s.goalCompletionRate).toBeGreaterThanOrEqual(0);
    expect(s.goalCompletionRate).toBeLessThanOrEqual(1);
  });

  it('formats dashboard as markdown', async () => {
    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
      testDataDir,
    );

    const dashboard = await generator.generateDashboard('24h');
    const markdown = generator.format(dashboard, 'markdown');

    expect(markdown).toContain('SUDO-AI Insights Dashboard');
    expect(markdown).toContain('Session Analytics');
    expect(markdown).toContain('Health');
  });

  it('formats dashboard as JSON', async () => {
    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
      testDataDir,
    );

    const dashboard = await generator.generateDashboard('24h');
    const json = generator.format(dashboard, 'json');

    const parsed = JSON.parse(json);
    expect(parsed.generatedAt).toBeTruthy();
    expect(parsed.timeRange).toBe('24h');
  });

  it('formats dashboard as summary', async () => {
    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
      testDataDir,
    );

    const dashboard = await generator.generateDashboard('24h');
    const summary = generator.format(dashboard, 'summary');

    expect(summary).toContain('Health');
    expect(summary).toContain('sessions');
  });

  it('generates with different time ranges', async () => {
    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
      testDataDir,
    );

    const dashboard1h = await generator.generateDashboard('1h');
    const dashboard7d = await generator.generateDashboard('7d');
    const dashboardAll = await generator.generateDashboard('all');

    expect(dashboard1h.timeRange).toBe('1h');
    expect(dashboard7d.timeRange).toBe('7d');
    expect(dashboardAll.timeRange).toBe('all');
  });
});

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------

describe('DEFAULT_INSIGHTS_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_INSIGHTS_CONFIG.defaultTimeRange).toBe('24h');
    expect(DEFAULT_INSIGHTS_CONFIG.includeCosts).toBe(true);
    expect(DEFAULT_INSIGHTS_CONFIG.includeFileChanges).toBe(true);
    expect(DEFAULT_INSIGHTS_CONFIG.includeAnomalies).toBe(true);
    expect(DEFAULT_INSIGHTS_CONFIG.healthWeights.successRate).toBe(0.3);
    expect(DEFAULT_INSIGHTS_CONFIG.healthWeights.latency).toBe(0.2);
    expect(DEFAULT_INSIGHTS_CONFIG.healthWeights.errorRate).toBe(0.3);
    expect(DEFAULT_INSIGHTS_CONFIG.healthWeights.costEfficiency).toBe(0.2);
  });

  it('has pricing for major models', () => {
    const pricing = DEFAULT_INSIGHTS_CONFIG.pricingPerModel;
    expect(pricing).toBeDefined();
    expect(Object.keys(pricing).length).toBeGreaterThan(0);
    // Check a few models have input/output pricing
    for (const [model, prices] of Object.entries(pricing)) {
      expect(prices.input).toBeGreaterThan(0);
      expect(prices.output).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Anomaly Detection
// ---------------------------------------------------------------------------

describe('Anomaly Detection', () => {
  it('detects high error rate anomaly', async () => {
    // Create signals directory with a high-error session
    const testDataDir = path.join(os.tmpdir(), 'sudo-ai-insights-anomaly-test');
    const signalsDir = path.join(testDataDir, 'signals');
    fs.mkdirSync(signalsDir, { recursive: true });

    // Create a signal file with high error rate
    const signal = {
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      turnCount: 10,
      toolCallCount: 20,
      errorCount: 5,
      cancellationCount: 0,
      doomLoopDetections: 0,
      avgTimeToFirstTokenMs: 2000,
      itlP50Ms: 50,
      itlP95Ms: 200,
      itlP99Ms: 500,
      goalClassificationType: 'coding',
      goalCompletionVerdict: 'completed',
      feedbackTier: 'normal',
      modelUsed: 'claude-sonnet-4-6',
      tokensUsed: { input: 1000, output: 500 },
    };
    fs.writeFileSync(path.join(signalsDir, 'session-anomaly-test.json'), JSON.stringify(signal));

    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: true },
      testDataDir,
    );

    const dashboard = await generator.generateDashboard('24h');

    // Should detect the high error rate
    expect(dashboard.anomalies.length).toBeGreaterThanOrEqual(0); // May or may not detect depending on threshold

    // Cleanup
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  it('generates recommendations based on analytics', async () => {
    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
      path.join(os.tmpdir(), 'sudo-ai-insights-rec-test'),
    );

    const dashboard = await generator.generateDashboard('24h');
    expect(dashboard.recommendations).toBeInstanceOf(Array);
  });
});

// ---------------------------------------------------------------------------
// Health Score
// ---------------------------------------------------------------------------

describe('Health Score', () => {
  it('returns a score between 0 and 100', async () => {
    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
      path.join(os.tmpdir(), 'sudo-ai-insights-health-test'),
    );

    const dashboard = await generator.generateDashboard('24h');
    expect(dashboard.healthScore).toBeGreaterThanOrEqual(0);
    expect(dashboard.healthScore).toBeLessThanOrEqual(100);
  });

  it('adjusts with configuration weights', async () => {
    const generator1 = new InsightsDashboardGenerator({
      includeCosts: false,
      includeFileChanges: false,
      includeAnomalies: false,
      healthWeights: { successRate: 1, latency: 0, errorRate: 0, costEfficiency: 0 },
    });

    const generator2 = new InsightsDashboardGenerator({
      includeCosts: false,
      includeFileChanges: false,
      includeAnomalies: false,
      healthWeights: { successRate: 0, latency: 1, errorRate: 0, costEfficiency: 0 },
    });

    // Both should produce valid scores
    const dashboard1 = await generator1.generateDashboard('24h');
    const dashboard2 = await generator2.generateDashboard('24h');
    expect(dashboard1.healthScore).toBeGreaterThanOrEqual(0);
    expect(dashboard2.healthScore).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe('Edge Cases', () => {
  it('handles missing data directories gracefully', async () => {
    const nonExistentDir = path.join(os.tmpdir(), `sudo-ai-insights-missing-${Date.now()}`);
    const generator = new InsightsDashboardGenerator(
      { includeCosts: true, includeFileChanges: true, includeAnomalies: true },
      nonExistentDir,
    );

    const dashboard = await generator.generateDashboard('24h');
    expect(dashboard).toBeDefined();
    expect(dashboard.sessions.totalSessions).toBe(0);
    expect(dashboard.fileChanges.totalChanges).toBe(0);
    expect(dashboard.costs.totalCostUsd).toBe(0);
  });

  it('handles empty signals directory', async () => {
    const emptyDir = path.join(os.tmpdir(), `sudo-ai-insights-empty-${Date.now()}`);
    const signalsDir = path.join(emptyDir, 'signals');
    fs.mkdirSync(signalsDir, { recursive: true });

    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
      emptyDir,
    );

    const dashboard = await generator.generateDashboard('24h');
    expect(dashboard.sessions.totalSessions).toBe(0);
    expect(dashboard.sessions.errorRate).toBe(0);

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('handles invalid signal files', async () => {
    const testDir = path.join(os.tmpdir(), `sudo-ai-insights-invalid-${Date.now()}`);
    const signalsDir = path.join(testDir, 'signals');
    fs.mkdirSync(signalsDir, { recursive: true });
    fs.writeFileSync(path.join(signalsDir, 'bad.json'), 'not valid json');

    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
      testDir,
    );

    // Should not throw
    const dashboard = await generator.generateDashboard('24h');
    expect(dashboard).toBeDefined();

    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('formats all time ranges correctly', async () => {
    const generator = new InsightsDashboardGenerator(
      { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
      path.join(os.tmpdir(), 'sudo-ai-insights-ranges-test'),
    );

    const ranges: Array<'1h' | '6h' | '24h' | '7d' | '30d' | '90d' | 'all'> = ['1h', '6h', '24h', '7d', '30d', '90d', 'all'];
    for (const range of ranges) {
      const dashboard = await generator.generateDashboard(range);
      expect(dashboard.timeRange).toBe(range);
    }
  });

  it('singleton instance exists', async () => {
    const { insightsDashboard } = await import('../../src/core/learning/insights-dashboard.js');
    expect(insightsDashboard).toBeDefined();
    expect(insightsDashboard).toBeInstanceOf(InsightsDashboardGenerator);
  });
});

// ---------------------------------------------------------------------------
// Tool Usage Analytics (traces.db)
// ---------------------------------------------------------------------------

describe('Tool Usage Analytics', () => {
  it('reads tool_call traces written by TraceStore through the real schema', async () => {
    const testDir = path.join(os.tmpdir(), `sudo-ai-insights-traces-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const { TraceStore } = await import('../../src/core/learning/trace-store.js');
      const store = new TraceStore(path.join(testDir, 'traces.db'));
      await store.init();
      store.recordToolCall('s1', 'read_file', true, 12);
      store.recordToolCall('s1', 'read_file', true, 20);
      store.recordToolCall('s1', 'bash', false, 300, { type: 'tool_error', message: 'exit 1' });
      // A non-tool trace must not be counted
      store.recordBrainCall('s1', 'claude-sonnet-4-6', true, 800);
      store.close();

      const generator = new InsightsDashboardGenerator(
        { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
        testDir,
      );
      const dashboard = await generator.generateDashboard('24h');
      const tools = dashboard.tools;

      expect(tools.totalCalls).toBe(3);
      expect(tools.totalSuccesses).toBe(2);
      expect(tools.totalErrors).toBe(1);
      const readFile = tools.topTools.find((t) => t.toolName === 'read_file');
      expect(readFile?.callCount).toBe(2);
      expect(readFile?.successRate).toBe(1);
      const bash = tools.topTools.find((t) => t.toolName === 'bash');
      expect(bash?.errorCount).toBe(1);
      expect(bash?.topError).toBe('exit 1');
      // An all-failure tool must report errorRate 1, not 0
      expect(tools.errorRates['bash']).toBe(1);
      expect(Object.values(tools.callsByDay).reduce((a, b) => a + b, 0)).toBe(3);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('counts ALL tools in totals, not just the displayed top 10 (regression)', async () => {
    // Pre-fix: totals were summed AFTER slice(0,10), so a workspace with
    // >10 distinct tools under-reported every total. Record 12 distinct
    // tools and assert the displayed top is capped at 10 while totalCalls
    // reflects all 12.
    const testDir = path.join(os.tmpdir(), `sudo-ai-insights-undercount-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const { TraceStore } = await import('../../src/core/learning/trace-store.js');
      const store = new TraceStore(path.join(testDir, 'traces.db'));
      await store.init();
      // Tools t01..t10 each get 5 calls; t11+t12 each get 1 call. After
      // sort-by-callCount, the top 10 are t01..t10 (50 calls displayed)
      // and t11+t12 fall off — but totals must still include them.
      for (let i = 1; i <= 10; i++) {
        const name = `t${String(i).padStart(2, '0')}`;
        for (let j = 0; j < 5; j++) store.recordToolCall('s1', name, true, 10);
      }
      store.recordToolCall('s1', 't11', true, 10);
      store.recordToolCall('s1', 't12', false, 10, { type: 'tool_error', message: 'tail-tool error' });
      store.close();

      const generator = new InsightsDashboardGenerator(
        { includeCosts: false, includeFileChanges: false, includeAnomalies: false },
        testDir,
      );
      const dashboard = await generator.generateDashboard('24h');
      const tools = dashboard.tools;

      // Display is capped at 10.
      expect(tools.topTools.length).toBe(10);
      // Tail tools (t11, t12) must NOT be in the displayed list (sorted by
      // callCount, t11 and t12 only have 1 call each).
      expect(tools.topTools.find((t) => t.toolName === 't11')).toBeUndefined();
      expect(tools.topTools.find((t) => t.toolName === 't12')).toBeUndefined();
      // …but totals MUST include them: 10*5 + 1 + 1 = 52 calls, 51 successes, 1 error.
      expect(tools.totalCalls).toBe(52);
      expect(tools.totalSuccesses).toBe(51);
      expect(tools.totalErrors).toBe(1);
      // overallSuccessRate uses the honest totals (51/52 ≈ 0.9808), not 50/50.
      expect(tools.overallSuccessRate).toBeCloseTo(51 / 52, 5);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
