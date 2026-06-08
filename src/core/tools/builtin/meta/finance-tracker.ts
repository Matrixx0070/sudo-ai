/**
 * meta.finance — Financial autonomy tool for SUDO-AI.
 *
 * Actions: add-revenue, add-cost, roi, budget-check,
 *          self-funding-status, optimize, revenue-report, cost-report.
 */

import { RevenueTracker } from '../../../finance/index.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-finance-tracker');
const DB_PATH = MIND_DB;

let _tracker: RevenueTracker | null = null;
function getTracker(): RevenueTracker {
  if (!_tracker) _tracker = new RevenueTracker(DB_PATH);
  return _tracker;
}

function usd(n: number): string { return `$${n.toFixed(2)}`; }

function formatRecord(obj: Record<string, number>): string {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '  (none)';
  return entries.map(([k, v]) => `  ${k}: ${usd(v)}`).join('\n');
}

const VALID_PERIODS = ['today', 'week', 'month', 'all'] as const;
const VALID_ROI_PERIODS = ['week', 'month', 'all'] as const;

export const financeTrackerTool: ToolDefinition = {
  name: 'meta.finance',
  description:
    'SUDO-AI financial autonomy: track revenue and costs, analyse ROI, manage budgets, '
    + 'monitor self-funding progress, and get optimisation suggestions. Data in mind.db.',
  category: 'meta',
  timeout: 15_000,

  parameters: {
    action: {
      type: 'string', required: true,
      description: 'Operation: add-revenue, add-cost, roi, budget-check, self-funding-status, optimize, revenue-report, cost-report.',
      enum: ['add-revenue', 'add-cost', 'roi', 'budget-check', 'self-funding-status', 'optimize', 'revenue-report', 'cost-report'],
    },
    amount: { type: 'number', description: 'Amount in USD (required for add-revenue and add-cost).' },
    description: { type: 'string', description: 'Human-readable note for the entry.', default: '' },
    date: { type: 'string', description: 'ISO-8601 date (YYYY-MM-DD). Defaults to today.' },
    source: { type: 'string', description: 'Revenue source: youtube_adsense, youtube_memberships, affiliate, digital_product, freelance, other.' },
    currency: { type: 'string', description: 'ISO-4217 currency code (default: USD).', default: 'USD' },
    category: { type: 'string', description: 'Cost category: api, hosting, tools, assets, marketing, other.' },
    budgetCategory: { type: 'string', description: 'Category to set a monthly budget for (use with monthlyLimit).' },
    monthlyLimit: { type: 'number', description: 'Monthly spend limit in USD for the given budgetCategory.' },
    period: {
      type: 'string',
      description: 'Time window: today, week, month, all (default: month).',
      enum: ['today', 'week', 'month', 'all'],
      default: 'month',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string | undefined;
    logger.info({ session: ctx.sessionId, action }, 'meta.finance invoked');

    if (!action?.trim()) return { success: false, output: 'action is required.' };

    try {
      const tracker = getTracker();
      const today = new Date().toISOString().slice(0, 10);

      switch (action) {

        case 'add-revenue': {
          const source = params['source'] as string | undefined;
          const amount = params['amount'] as number | undefined;
          if (!source?.trim()) return { success: false, output: 'source is required for add-revenue.' };
          if (amount === undefined) return { success: false, output: 'amount is required for add-revenue.' };
          if (typeof amount !== 'number' || amount < 0) return { success: false, output: `amount must be a non-negative number. Got: ${String(amount)}` };

          const entryDate = (params['date'] as string | undefined) ?? today;
          const id = tracker.addRevenue({
            source, amount,
            currency: (params['currency'] as string | undefined) ?? 'USD',
            description: (params['description'] as string | undefined) ?? '',
            date: entryDate,
          });
          logger.info({ id, source, amount }, 'Revenue recorded');
          return { success: true, output: `Revenue recorded: ${usd(amount)} from '${source}' on ${entryDate} (id: ${id})`, data: { id, source, amount, date: entryDate } };
        }

        case 'add-cost': {
          const category = params['category'] as string | undefined;
          const amount = params['amount'] as number | undefined;
          if (!category?.trim()) return { success: false, output: 'category is required for add-cost.' };
          if (amount === undefined) return { success: false, output: 'amount is required for add-cost.' };
          if (typeof amount !== 'number' || amount < 0) return { success: false, output: `amount must be a non-negative number. Got: ${String(amount)}` };

          const entryDate = (params['date'] as string | undefined) ?? today;
          const id = tracker.addCost({
            category, amount,
            description: (params['description'] as string | undefined) ?? '',
            date: entryDate,
          });
          logger.info({ id, category, amount }, 'Cost recorded');
          return { success: true, output: `Cost recorded: ${usd(amount)} in '${category}' on ${entryDate} (id: ${id})`, data: { id, category, amount, date: entryDate } };
        }

        case 'roi': {
          const rawPeriod = (params['period'] as string | undefined) ?? 'month';
          if (!(VALID_ROI_PERIODS as readonly string[]).includes(rawPeriod)) {
            return { success: false, output: `period for roi must be one of: ${VALID_ROI_PERIODS.join(', ')}. Got: ${rawPeriod}` };
          }
          const roi = tracker.getROI(rawPeriod as 'week' | 'month' | 'all');
          const output = [
            `ROI report (${rawPeriod}):`,
            `  Revenue: ${usd(roi.revenue)}`,
            `  Costs:   ${usd(roi.costs)}`,
            `  Profit:  ${usd(roi.profit)}`,
            `  ROI:     ${roi.roi.toFixed(1)}%`,
          ].join('\n');
          logger.info({ period: rawPeriod, roi: roi.roi }, 'meta.finance roi');
          return { success: true, output, data: roi };
        }

        case 'budget-check': {
          const budgetCategory = params['budgetCategory'] as string | undefined;
          const monthlyLimit = params['monthlyLimit'] as number | undefined;
          if (budgetCategory?.trim() && monthlyLimit !== undefined) {
            if (typeof monthlyLimit !== 'number' || monthlyLimit < 0) {
              return { success: false, output: `monthlyLimit must be a non-negative number. Got: ${String(monthlyLimit)}` };
            }
            tracker.setBudget(budgetCategory.trim(), monthlyLimit);
            logger.info({ category: budgetCategory, limit: monthlyLimit }, 'Budget set');
          }
          const lines = tracker.checkBudget();
          if (lines.length === 0) {
            return { success: true, output: 'No budgets configured. Pass budgetCategory + monthlyLimit to set one.', data: { budgets: [] } };
          }
          const rows = lines.map(l => {
            const s = l.percentUsed >= 100 ? 'OVER BUDGET' : l.percentUsed >= 80 ? 'WARNING' : 'OK';
            return `  [${s}] ${l.category}: ${usd(l.spent)} / ${usd(l.budget)} (${l.percentUsed.toFixed(0)}%) — ${usd(l.remaining)} remaining`;
          });
          logger.info({ categories: lines.length }, 'meta.finance budget-check');
          return { success: true, output: `Budget check (this month):\n${rows.join('\n')}`, data: { budgets: lines } };
        }

        case 'self-funding-status': {
          const status = tracker.getSelfFundingStatus();
          const verdict = status.selfFunding
            ? `SELF-FUNDING (surplus: ${usd(-status.deficit)})`
            : `NOT SELF-FUNDING (deficit: ${usd(status.deficit)})`;
          const output = [
            `Self-funding status: ${verdict}`,
            `  Monthly revenue: ${usd(status.monthlyRevenue)}`,
            `  Monthly costs:   ${usd(status.monthlyCosts)}`,
          ].join('\n');
          logger.info({ selfFunding: status.selfFunding }, 'meta.finance self-funding-status');
          return { success: true, output, data: status };
        }

        case 'optimize': {
          const suggestions = tracker.getOptimizationSuggestions();
          const output = `Optimisation suggestions (${suggestions.length}):\n` +
            suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n');
          logger.info({ count: suggestions.length }, 'meta.finance optimize');
          return { success: true, output, data: { suggestions } };
        }

        case 'revenue-report': {
          const rawPeriod = (params['period'] as string | undefined) ?? 'month';
          if (!(VALID_PERIODS as readonly string[]).includes(rawPeriod)) {
            return { success: false, output: `period must be one of: ${VALID_PERIODS.join(', ')}. Got: ${rawPeriod}` };
          }
          const summary = tracker.getRevenue(rawPeriod as 'today' | 'week' | 'month' | 'all');
          const output = [`Revenue report (${rawPeriod}):`, `  Total: ${usd(summary.total)}`, `  Entries: ${summary.entries.length}`, 'By source:', formatRecord(summary.bySource)].join('\n');
          logger.info({ period: rawPeriod, total: summary.total }, 'meta.finance revenue-report');
          return { success: true, output, data: summary };
        }

        case 'cost-report': {
          const rawPeriod = (params['period'] as string | undefined) ?? 'month';
          if (!(VALID_PERIODS as readonly string[]).includes(rawPeriod)) {
            return { success: false, output: `period must be one of: ${VALID_PERIODS.join(', ')}. Got: ${rawPeriod}` };
          }
          const summary = tracker.getCosts(rawPeriod as 'today' | 'week' | 'month' | 'all');
          const output = [`Cost report (${rawPeriod}):`, `  Total: ${usd(summary.total)}`, `  Entries: ${summary.entries.length}`, 'By category:', formatRecord(summary.byCategory)].join('\n');
          logger.info({ period: rawPeriod, total: summary.total }, 'meta.finance cost-report');
          return { success: true, output, data: summary };
        }

        default:
          return { success: false, output: `Unknown action: "${action}". Valid: add-revenue, add-cost, roi, budget-check, self-funding-status, optimize, revenue-report, cost-report.` };
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg, session: ctx.sessionId }, 'meta.finance error');
      return { success: false, output: `Finance tracker error: ${msg}` };
    }
  },
};
