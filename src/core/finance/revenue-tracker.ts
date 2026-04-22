/**
 * RevenueTracker — tracks revenue, costs, budgets and self-funding status.
 *
 * All data is persisted in mind.db using better-sqlite3 (synchronous API).
 * SQL uses named parameters exclusively — no string interpolation.
 *
 * Tables:
 *   revenue  — income entries by source
 *   costs    — expenditure entries by category
 *   budgets  — per-category monthly limits
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type {
  RevenueEntry, CostEntry, BudgetLine,
  RevenueSummary, CostSummary, ROIResult, SelfFundingStatus,
  RevenueRow, CostRow, AggRow, BudgetRow, Period, RoiPeriod,
} from './types.js';
import { periodFilter } from './types.js';

const logger = createLogger('revenue-tracker');

export class RevenueTracker {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    logger.info({ dbPath }, 'RevenueTracker initialising');

    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      logger.info({ dir }, 'Created database directory');
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();

    logger.info({ dbPath }, 'RevenueTracker ready');
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private _initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS revenue (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        amount      REAL NOT NULL CHECK(amount >= 0),
        currency    TEXT NOT NULL DEFAULT 'USD',
        description TEXT NOT NULL DEFAULT '',
        date        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS costs (
        id          TEXT PRIMARY KEY,
        category    TEXT NOT NULL,
        amount      REAL NOT NULL CHECK(amount >= 0),
        description TEXT NOT NULL DEFAULT '',
        date        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budgets (
        category      TEXT PRIMARY KEY,
        monthly_limit REAL NOT NULL CHECK(monthly_limit >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_revenue_date   ON revenue(date);
      CREATE INDEX IF NOT EXISTS idx_costs_date     ON costs(date);
      CREATE INDEX IF NOT EXISTS idx_revenue_source ON revenue(source);
      CREATE INDEX IF NOT EXISTS idx_costs_category ON costs(category);
    `);
    logger.debug('Finance schema initialised');
  }

  // ---------------------------------------------------------------------------
  // Revenue
  // ---------------------------------------------------------------------------

  addRevenue(entry: Omit<RevenueEntry, 'id'>): string {
    if (!entry.source?.trim()) throw new Error('revenue source is required');
    if (typeof entry.amount !== 'number' || entry.amount < 0) throw new Error('revenue amount must be a non-negative number');
    if (!entry.date?.trim()) throw new Error('revenue date is required');

    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO revenue (id, source, amount, currency, description, date)
       VALUES (@id, @source, @amount, @currency, @description, @date)`
    ).run({
      id,
      source: entry.source.trim(),
      amount: entry.amount,
      currency: (entry.currency ?? 'USD').trim().toUpperCase(),
      description: (entry.description ?? '').trim(),
      date: entry.date.trim(),
    });

    logger.info({ id, source: entry.source, amount: entry.amount }, 'Revenue entry added');
    return id;
  }

  getRevenue(period: Period): RevenueSummary {
    const filter = periodFilter(period);
    const entries = this.db
      .prepare(`SELECT id, source, amount, currency, description, date FROM revenue WHERE ${filter} ORDER BY date DESC`)
      .all() as RevenueRow[];

    const bySource: Record<string, number> = {};
    let total = 0;
    for (const e of entries) {
      total += e.amount;
      bySource[e.source] = (bySource[e.source] ?? 0) + e.amount;
    }

    logger.debug({ period, total, count: entries.length }, 'getRevenue');
    return { total, bySource, entries };
  }

  // ---------------------------------------------------------------------------
  // Costs
  // ---------------------------------------------------------------------------

  addCost(entry: Omit<CostEntry, 'id'>): string {
    if (!entry.category?.trim()) throw new Error('cost category is required');
    if (typeof entry.amount !== 'number' || entry.amount < 0) throw new Error('cost amount must be a non-negative number');
    if (!entry.date?.trim()) throw new Error('cost date is required');

    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO costs (id, category, amount, description, date)
       VALUES (@id, @category, @amount, @description, @date)`
    ).run({
      id,
      category: entry.category.trim(),
      amount: entry.amount,
      description: (entry.description ?? '').trim(),
      date: entry.date.trim(),
    });

    logger.info({ id, category: entry.category, amount: entry.amount }, 'Cost entry added');
    return id;
  }

  getCosts(period: Period): CostSummary {
    const filter = periodFilter(period);
    const entries = this.db
      .prepare(`SELECT id, category, amount, description, date FROM costs WHERE ${filter} ORDER BY date DESC`)
      .all() as CostRow[];

    const byCategory: Record<string, number> = {};
    let total = 0;
    for (const e of entries) {
      total += e.amount;
      byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amount;
    }

    logger.debug({ period, total, count: entries.length }, 'getCosts');
    return { total, byCategory, entries };
  }

  // ---------------------------------------------------------------------------
  // ROI
  // ---------------------------------------------------------------------------

  getROI(period: RoiPeriod): ROIResult {
    const filter = periodFilter(period);
    const revRow = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM revenue WHERE ${filter}`)
      .get() as { total: number };
    const costRow = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM costs WHERE ${filter}`)
      .get() as { total: number };

    const revenue = revRow.total;
    const costs = costRow.total;
    const profit = revenue - costs;
    const roi = costs > 0 ? (profit / costs) * 100 : 0;

    logger.debug({ period, revenue, costs, profit, roi }, 'getROI');
    return { revenue, costs, profit, roi };
  }

  // ---------------------------------------------------------------------------
  // Budgets
  // ---------------------------------------------------------------------------

  setBudget(category: string, monthly: number): void {
    if (!category?.trim()) throw new Error('budget category is required');
    if (typeof monthly !== 'number' || monthly < 0) throw new Error('budget monthly limit must be a non-negative number');

    this.db.prepare(
      `INSERT INTO budgets (category, monthly_limit) VALUES (@category, @monthly_limit)
       ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`
    ).run({ category: category.trim(), monthly_limit: monthly });

    logger.info({ category, monthly }, 'Budget set');
  }

  checkBudget(): BudgetLine[] {
    const budgets = this.db.prepare('SELECT category, monthly_limit FROM budgets').all() as BudgetRow[];
    if (budgets.length === 0) return [];

    const spentRows = this.db
      .prepare(
        `SELECT category AS key, COALESCE(SUM(amount), 0) AS total
         FROM costs
         WHERE strftime('%Y-%m', date) = strftime('%Y-%m', 'now')
         GROUP BY category`
      )
      .all() as AggRow[];

    const spentMap: Record<string, number> = {};
    for (const row of spentRows) spentMap[row.key] = row.total;

    return budgets.map(b => {
      const spent = spentMap[b.category] ?? 0;
      const remaining = Math.max(0, b.monthly_limit - spent);
      const percentUsed = b.monthly_limit > 0 ? (spent / b.monthly_limit) * 100 : 0;
      return { category: b.category, budget: b.monthly_limit, spent, remaining, percentUsed };
    });
  }

  // ---------------------------------------------------------------------------
  // Self-funding status
  // ---------------------------------------------------------------------------

  getSelfFundingStatus(): SelfFundingStatus {
    const roi = this.getROI('month');
    const selfFunding = roi.revenue >= roi.costs;
    const deficit = roi.costs - roi.revenue;

    logger.debug({ monthlyRevenue: roi.revenue, monthlyCosts: roi.costs, selfFunding }, 'getSelfFundingStatus');
    return { monthlyRevenue: roi.revenue, monthlyCosts: roi.costs, selfFunding, deficit };
  }

  // ---------------------------------------------------------------------------
  // Optimization suggestions
  // ---------------------------------------------------------------------------

  getOptimizationSuggestions(): string[] {
    const suggestions: string[] = [];
    const status = this.getSelfFundingStatus();
    const budget = this.checkBudget();
    const costSummary = this.getCosts('month');
    const revSummary = this.getRevenue('month');

    if (!status.selfFunding) {
      suggestions.push(
        `Not yet self-funding: monthly deficit of $${status.deficit.toFixed(2)}. ` +
        `Revenue ($${status.monthlyRevenue.toFixed(2)}) needs to increase by $${status.deficit.toFixed(2)}.`
      );
    } else {
      suggestions.push(`Self-funding: monthly surplus of $${(-status.deficit).toFixed(2)}. Consider reinvesting.`);
    }

    for (const line of budget) {
      if (line.percentUsed >= 90) {
        suggestions.push(
          `Budget warning: '${line.category}' is at ${line.percentUsed.toFixed(0)}% ` +
          `($${line.spent.toFixed(2)} / $${line.budget.toFixed(2)}). Review or increase limit.`
        );
      }
    }

    const sortedCosts = Object.entries(costSummary.byCategory).sort((a, b) => b[1] - a[1]);
    if (sortedCosts.length > 0 && costSummary.total > 0) {
      const [topCat, topAmt] = sortedCosts[0]!;
      const pct = (topAmt / costSummary.total) * 100;
      if (pct > 50) {
        suggestions.push(
          `Cost concentration: '${topCat}' is ${pct.toFixed(0)}% of monthly costs ($${topAmt.toFixed(2)}). ` +
          `Review for optimisation.`
        );
      }
    }

    const sourceCount = Object.keys(revSummary.bySource).length;
    if (sourceCount === 0) {
      suggestions.push('No revenue recorded this month. Add revenue streams (YouTube, affiliate, products).');
    } else if (sourceCount === 1) {
      suggestions.push('Revenue from only 1 source. Diversify to reduce single-source risk.');
    }

    if (costSummary.total === 0) {
      suggestions.push('No costs recorded this month. Track API, hosting, and tool costs for accurate ROI.');
    }

    if (suggestions.length === 0) {
      suggestions.push('Financial health looks good. No immediate actions required.');
    }

    return suggestions;
  }
}
