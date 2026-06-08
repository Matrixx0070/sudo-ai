/**
 * meta.cost-tracker — SUDO-AI API cost reporting tool.
 *
 * Exposes the CostTracker singleton to the agent loop so SUDO-AI can inspect
 * its own API spending at any time.
 *
 * Actions:
 *   today         — today's total spend with per-provider breakdown
 *   weekly        — last 7 days spend with per-provider + per-day breakdown
 *   monthly       — current calendar month spend with per-provider breakdown
 *   recent        — last N API call records (default 20, max 500)
 *   by-model      — aggregated calls + cost grouped by model
 *   check-budget  — compare today's spend against a daily USD limit
 */

import path from 'node:path';
import { getCostTracker } from '../../../billing/cost-tracker.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-cost-tracker');

const DB_PATH = MIND_DB;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function usd(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

function formatByProvider(byProvider: Record<string, number>): string {
  const entries = Object.entries(byProvider).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '  (no data)';
  return entries.map(([p, c]) => `  ${p}: ${usd(c)}`).join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const costTrackerTool: ToolDefinition = {
  name: 'meta.cost-tracker',
  description:
    'Inspect SUDO-AI API spending. Reports today/weekly/monthly costs by provider, '
    + 'shows recent call history, aggregates spend by model, and checks a daily budget limit. '
    + 'Use this to monitor API costs and detect unexpected spending spikes.',
  category: 'meta',
  timeout: 15_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Report type.',
      enum: ['today', 'weekly', 'monthly', 'recent', 'by-model', 'check-budget'],
    },
    limit: {
      type: 'number',
      description: 'For action=recent: number of records to return (default 20, max 500).',
      default: 20,
    },
    dailyLimit: {
      type: 'number',
      description: 'For action=check-budget: daily USD budget to compare against (e.g. 5.00).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string | undefined;
    logger.info({ session: ctx.sessionId, action }, 'meta.cost-tracker invoked');

    if (!action?.trim()) {
      return { success: false, output: 'action is required. Choose one of: today, weekly, monthly, recent, by-model, check-budget.' };
    }

    try {
      const tracker = getCostTracker(DB_PATH);

      switch (action) {

        case 'today': {
          const summary = tracker.getTodayCost();
          const output = [
            `Today's API spend: ${usd(summary.total)}`,
            'By provider:',
            formatByProvider(summary.byProvider),
          ].join('\n');
          logger.info({ total: summary.total }, 'cost-tracker today report');
          return { success: true, output, data: summary };
        }

        case 'weekly': {
          const summary = tracker.getWeeklyCost();
          const dayLines = Object.entries(summary.byDay)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([day, cost]) => `  ${day}: ${usd(cost)}`)
            .join('\n') || '  (no data)';

          const output = [
            `Last 7 days API spend: ${usd(summary.total)}`,
            'By provider:',
            formatByProvider(summary.byProvider),
            'By day:',
            dayLines,
          ].join('\n');
          logger.info({ total: summary.total }, 'cost-tracker weekly report');
          return { success: true, output, data: summary };
        }

        case 'monthly': {
          const summary = tracker.getMonthlyCost();
          const output = [
            `This month's API spend: ${usd(summary.total)}`,
            'By provider:',
            formatByProvider(summary.byProvider),
          ].join('\n');
          logger.info({ total: summary.total }, 'cost-tracker monthly report');
          return { success: true, output, data: summary };
        }

        case 'recent': {
          const rawLimit = params['limit'];
          const limit = typeof rawLimit === 'number'
            ? Math.min(Math.max(1, Math.floor(rawLimit)), 500)
            : 20;

          const calls = tracker.getRecentCalls(limit);

          if (calls.length === 0) {
            return { success: true, output: 'No API calls recorded yet.', data: { calls: [] } };
          }

          const lines = calls.map(c => {
            const status = c.success ? 'OK' : 'ERR';
            const cost   = usd(c.estimatedCostUsd);
            const tokens = `${c.totalTokens} tokens`;
            const ms     = `${c.latencyMs}ms`;
            return `[${c.calledAt.slice(0, 19)}] ${status} ${c.provider}/${c.model} — ${tokens} ${cost} ${ms} (${c.source})`;
          });

          const output = `Recent ${calls.length} API call(s):\n${lines.join('\n')}`;
          logger.info({ count: calls.length }, 'cost-tracker recent report');
          return { success: true, output, data: { calls } };
        }

        case 'by-model': {
          const stats = tracker.getCostByModel();

          if (stats.length === 0) {
            return { success: true, output: 'No API calls recorded yet.', data: { stats: [] } };
          }

          const lines = stats.map(s =>
            `  ${s.model}: ${s.calls} call(s), total ${usd(s.totalCost)}`
          );
          const output = `API cost by model:\n${lines.join('\n')}`;
          logger.info({ modelCount: stats.length }, 'cost-tracker by-model report');
          return { success: true, output, data: { stats } };
        }

        case 'check-budget': {
          const rawLimit = params['dailyLimit'];
          if (rawLimit === undefined || rawLimit === null) {
            return { success: false, output: 'dailyLimit is required for check-budget (e.g. dailyLimit: 5.00).' };
          }
          if (typeof rawLimit !== 'number' || rawLimit < 0) {
            return { success: false, output: `dailyLimit must be a non-negative number. Got: ${String(rawLimit)}` };
          }

          const status = tracker.checkBudget(rawLimit);
          const verb   = status.exceeded ? 'EXCEEDED' : 'within limit';
          const output = [
            `Daily budget: ${verb}`,
            `  Spent today: ${usd(status.current)}`,
            `  Daily limit: ${usd(status.limit)}`,
            status.exceeded
              ? `  Over by: ${usd(status.current - status.limit)}`
              : `  Remaining: ${usd(status.limit - status.current)}`,
          ].join('\n');

          logger.info({ exceeded: status.exceeded, current: status.current, limit: status.limit }, 'cost-tracker budget check');
          return { success: true, output, data: status };
        }

        default:
          return { success: false, output: `Unknown action: "${action}". Valid actions: today, weekly, monthly, recent, by-model, check-budget.` };
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg, session: ctx.sessionId }, 'meta.cost-tracker error');
      return { success: false, output: `Cost tracker error: ${msg}` };
    }
  },
};
