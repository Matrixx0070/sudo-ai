/**
 * @file cost-reporter.ts
 * @description Community-Driven Cost Transparency Reporter for SUDO-AI v4.
 *
 * Extends the existing CostTracker with community-requested features:
 *   - Competitor cost comparison data (the #1 Reddit engagement driver)
 *   - Cost transparency report generation for sharing
 *   - Budget alert system with configurable thresholds
 *   - Token efficiency metrics (output tokens per dollar)
 *   - Cost trend analysis
 *
 * The Hermes vs OpenClaw cost debate ($3/day vs $100/day) drives more
 * Reddit engagement than any feature comparison. SUDO-AI's cost profile
 * with model routing and local fallback is a strong story that needs data.
 *
 * Design principle: Truth wins. Publish honest data.
 */

import { createLogger } from '../shared/logger.js';
import { CostTracker, getCostTracker } from './cost-tracker.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const log = createLogger('billing:cost-reporter');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Competitor cost comparison data. */
export interface CompetitorCostComparison {
  platform: string;
  dailyCostUsd: number;
  monthlyCostUsd: number;
  tokensPerDollar: number;
  source: 'measured' | 'claimed' | 'community_reported';
  notes: string;
}

/** Budget alert configuration. */
export interface BudgetAlert {
  id: string;
  type: 'daily' | 'weekly' | 'monthly';
  thresholdUsd: number;
  action: 'warn' | 'block' | 'switch_to_cheaper';
  enabled: boolean;
  lastTriggered?: string;
}

/** Cost trend direction. */
export type CostTrend = 'up' | 'down' | 'stable';

/** Full transparency report. */
export interface TransparencyReport {
  generatedAt: string;
  sudoAi: {
    dailyCost: number;
    weeklyCost: number;
    monthlyCost: number;
    totalCalls: number;
    avgLatencyMs: number;
    topModel: string;
    topTool: string;
    tokensPerDollar: number;
  };
  competitors: CompetitorCostComparison[];
  budgetStatus: {
    dailySpend: number;
    monthlySpend: number;
    alerts: BudgetAlert[];
  };
  trend: {
    direction: CostTrend;
    percentChange: number;
  };
}

// ---------------------------------------------------------------------------
// Competitor cost data (from community research)
// ---------------------------------------------------------------------------

const COMPETITOR_COSTS: CompetitorCostComparison[] = [
  {
    platform: 'OpenClaw',
    dailyCostUsd: 100.00,
    monthlyCostUsd: 3000.00,
    tokensPerDollar: 50000,
    source: 'community_reported',
    notes: '$100/day average from Reddit reports. Uses Claude API primarily. 4,200+ phantom completion complaints.',
  },
  {
    platform: 'Hermes Agent',
    dailyCostUsd: 3.00,
    monthlyCostUsd: 90.00,
    tokensPerDollar: 800000,
    source: 'community_reported',
    notes: '$3/day with local models; can use cloud APIs for more. 30x cheaper claim from Reddit debates.',
  },
  {
    platform: 'OpenJarvis',
    dailyCostUsd: 0.10,
    monthlyCostUsd: 3.00,
    tokensPerDollar: 5000000,
    source: 'claimed',
    notes: 'Local-first, ~800x lower cost than cloud. Zero API cost when fully offline.',
  },
];

// ---------------------------------------------------------------------------
// Default budget alerts
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_ALERTS: BudgetAlert[] = [
  { id: 'daily-warn',  type: 'daily',   thresholdUsd: 5.00,   action: 'warn',              enabled: true },
  { id: 'daily-block', type: 'daily',   thresholdUsd: 25.00,  action: 'block',             enabled: true },
  { id: 'monthly-warn', type: 'monthly', thresholdUsd: 100.00, action: 'warn',              enabled: true },
  { id: 'weekly-trend', type: 'weekly', thresholdUsd: 50.00,  action: 'switch_to_cheaper',  enabled: false },
];

// ---------------------------------------------------------------------------
// CostReporter
// ---------------------------------------------------------------------------

/**
 * Community-driven cost transparency reporter.
 *
 * Generates the cost comparison data that drives Reddit engagement.
 * The $3/day vs $100/day debate is the single most shared statistic
 * in the agent community. SUDO-AI's model routing + local fallback
 * means we can offer compelling cost data — but only if we measure it.
 */
export class CostReporter {
  private readonly tracker: CostTracker;
  private readonly dataDir: string;
  private readonly budgetAlerts: BudgetAlert[];

  constructor(dataDir: string = 'data/costs', budgetAlerts?: BudgetAlert[]) {
    this.tracker = getCostTracker();
    this.dataDir = dataDir;
    this.budgetAlerts = budgetAlerts ?? DEFAULT_BUDGET_ALERTS;

    try {
      mkdirSync(this.dataDir, { recursive: true });
    } catch {
      log.warn({ dir: this.dataDir }, 'Cannot create cost data directory');
    }

    log.info('CostReporter initialized');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generate a full transparency report with competitor comparisons.
   * This is the data that drives community engagement.
   */
  generateReport(): TransparencyReport {
    const todayCost = this.tracker.getTodayCost();
    const weeklyCost = this.tracker.getWeeklyCost();
    const monthlyCost = this.tracker.getMonthlyCost();
    const recentCalls = this.tracker.getRecentCalls(100);
    const modelStats = this.tracker.getCostByModel();

    // Calculate SUDO-AI metrics
    const totalDailyCost = todayCost.total;
    const totalWeeklyCost = weeklyCost.total;
    const totalMonthlyCost = monthlyCost.total;
    const totalCalls = recentCalls.length;
    const avgLatencyMs = totalCalls > 0
      ? Math.round(recentCalls.reduce((s, c) => s + c.latencyMs, 0) / totalCalls)
      : 0;
    const topModel = modelStats.length > 0 ? modelStats[0].model : 'none';
    const tokensPerDollar = totalDailyCost > 0
      ? Math.round(recentCalls.reduce((s, c) => s + c.completionTokens, 0) / totalDailyCost)
      : 0;

    // Trend analysis
    const trend = this._calculateTrend(weeklyCost);

    // Budget status
    const budgetStatus = this._checkBudgetAlerts(todayCost.total, monthlyCost.total);

    const report: TransparencyReport = {
      generatedAt: new Date().toISOString(),
      sudoAi: {
        dailyCost: Math.round(totalDailyCost * 100) / 100,
        weeklyCost: Math.round(totalWeeklyCost * 100) / 100,
        monthlyCost: Math.round(totalMonthlyCost * 100) / 100,
        totalCalls,
        avgLatencyMs,
        topModel,
        topTool: recentCalls.length > 0 ? recentCalls[0].source : 'none',
        tokensPerDollar,
      },
      competitors: COMPETITOR_COSTS,
      budgetStatus,
      trend,
    };

    // Write to disk
    try {
      const reportPath = join(this.dataDir, 'transparency-report.json');
      writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
      log.info({ path: reportPath }, 'Transparency report generated');
    } catch (err) {
      log.warn({ err }, 'Failed to write transparency report');
    }

    return report;
  }

  /**
   * Generate a markdown cost report suitable for sharing.
   */
  generateMarkdownReport(): string {
    const report = this.generateReport();
    const lines: string[] = [];

    lines.push('# 💰 SUDO-AI Cost Transparency Report');
    lines.push('');
    lines.push(`_Generated: ${report.generatedAt}_`);
    lines.push('');

    // Current spend
    lines.push('## Current Spend');
    lines.push('');
    lines.push('| Period | Cost | Requests | Avg Latency |');
    lines.push('|--------|------|----------|-------------|');
    lines.push(`| Today | $${report.sudoAi.dailyCost.toFixed(2)} | ${report.sudoAi.totalCalls} | ${report.sudoAi.avgLatencyMs}ms |`);
    lines.push(`| This Week | $${report.sudoAi.weeklyCost.toFixed(2)} | — | — |`);
    lines.push(`| This Month | $${report.sudoAi.monthlyCost.toFixed(2)} | — | — |`);
    lines.push('');

    // Trend
    const trendIcon = report.trend.direction === 'up' ? '📈' : report.trend.direction === 'down' ? '📉' : '➡️';
    lines.push(`**Trend:** ${trendIcon} ${report.trend.direction} (${report.trend.percentChange}% change)`);
    lines.push('');

    // Competitor comparison — THE key table for Reddit engagement
    lines.push('## 🏆 Cost Comparison vs Competitors');
    lines.push('');
    lines.push('| Platform | Daily | Monthly | Tokens/$ | Source |');
    lines.push('|----------|-------|---------|----------|--------|');
    const allPlatforms = [
      { platform: 'SUDO-AI', daily: report.sudoAi.dailyCost, monthly: report.sudoAi.monthlyCost, tpD: report.sudoAi.tokensPerDollar, source: 'measured' as const },
      ...report.competitors.map(c => ({
        platform: c.platform, daily: c.dailyCostUsd, monthly: c.monthlyCostUsd,
        tpD: c.tokensPerDollar, source: c.source,
      })),
    ];
    for (const p of allPlatforms) {
      const tpD = p.tpD === Infinity ? '∞' : this._fmtTokens(p.tpD);
      lines.push(`| ${p.platform} | $${p.daily.toFixed(2)} | $${p.monthly.toFixed(2)} | ${tpD} | ${p.source} |`);
    }
    lines.push('');
    lines.push('> _Community-reported costs vary. SUDO-AI data is measured from real usage._');
    lines.push('');

    // Budget
    lines.push('## 🛡️ Budget Status');
    lines.push('');
    lines.push(`- Daily spend: $${report.budgetStatus.dailySpend.toFixed(2)}`);
    lines.push(`- Monthly spend: $${report.budgetStatus.monthlySpend.toFixed(2)}`);
    for (const alert of report.budgetStatus.alerts) {
      const icon = alert.enabled ? '🟢' : '⚪';
      lines.push(`- ${icon} ${alert.type} alert: $${alert.thresholdUsd.toFixed(2)} → ${alert.action}`);
    }
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Get competitor cost comparison data.
   */
  getCompetitorComparison(): CompetitorCostComparison[] {
    return [...COMPETITOR_COSTS];
  }

  /**
   * Check budget alerts against current spend.
   */
  checkBudget(dailyLimit?: number): { exceeded: boolean; current: number; limit: number } {
    const todayCost = this.tracker.getTodayCost();
    return {
      exceeded: todayCost.total > (dailyLimit ?? 25),
      current: todayCost.total,
      limit: dailyLimit ?? 25,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _calculateTrend(weeklyCost: { byDay: Record<string, number> }): {
    direction: CostTrend;
    percentChange: number;
  } {
    const days = Object.keys(weeklyCost.byDay).sort();
    if (days.length < 2) return { direction: 'stable', percentChange: 0 };

    const recentDays = days.slice(-3);
    const olderDays = days.slice(-6, -3);

    if (olderDays.length === 0 || recentDays.length === 0) {
      return { direction: 'stable', percentChange: 0 };
    }

    const recentAvg = recentDays.reduce((s, d) => s + (weeklyCost.byDay[d] ?? 0), 0) / recentDays.length;
    const olderAvg = olderDays.reduce((s, d) => s + (weeklyCost.byDay[d] ?? 0), 0) / olderDays.length;

    if (olderAvg === 0) return { direction: 'stable', percentChange: 0 };

    const change = ((recentAvg - olderAvg) / olderAvg) * 100;
    return {
      direction: change > 10 ? 'up' : change < -10 ? 'down' : 'stable',
      percentChange: Math.round(Math.abs(change)),
    };
  }

  private _checkBudgetAlerts(dailySpend: number, monthlySpend: number): {
    dailySpend: number;
    monthlySpend: number;
    alerts: BudgetAlert[];
  } {
    // Update lastTriggered on alerts that are triggered
    for (const alert of this.budgetAlerts) {
      if (!alert.enabled) continue;

      let currentSpend = 0;
      switch (alert.type) {
        case 'daily': currentSpend = dailySpend; break;
        case 'monthly': currentSpend = monthlySpend; break;
        case 'weekly': currentSpend = dailySpend * 7; break;
      }

      if (currentSpend >= alert.thresholdUsd) {
        alert.lastTriggered = new Date().toISOString();
        log.warn(
          { alert: alert.id, type: alert.type, spend: currentSpend, threshold: alert.thresholdUsd },
          'Budget alert triggered',
        );
      }
    }

    return {
      dailySpend: Math.round(dailySpend * 100) / 100,
      monthlySpend: Math.round(monthlySpend * 100) / 100,
      alerts: this.budgetAlerts,
    };
  }

  private _fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  }
}