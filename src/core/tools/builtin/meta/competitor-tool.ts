/**
 * meta.competitor — Competitor Channel Monitor tool.
 *
 * Wraps CompetitorMonitor to track rival YouTube channels, generate
 * activity alerts via brain analysis, compare metrics, and manage alerts.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta.competitor');

// ---------------------------------------------------------------------------
// Brain helper
// ---------------------------------------------------------------------------

interface BrainLike {
  // Brain.chat() resolves to a STRING; must match CompetitorMonitor's BrainLike (was { content }).
  chat(messages: Array<{ role: string; content: string }>): Promise<string>;
}

interface ConfigLike {
  brain?: BrainLike;
}

function extractBrain(ctx: ToolContext): BrainLike | undefined {
  return (ctx.config as ConfigLike | undefined)?.brain;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const competitorTool: ToolDefinition = {
  name: 'meta.competitor',
  description:
    'Monitor competitor YouTube channels: add/remove channels to watchlist, run AI-powered activity checks to detect new uploads/viral videos/format changes, manage alerts, compare metrics with your own channel, and view overall stats.',
  category: 'meta',
  timeout: 60_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['add', 'list', 'remove', 'check-activity', 'check-all', 'alerts', 'acknowledge', 'compare', 'stats'],
    },
    channelName: {
      type: 'string',
      description: 'Competitor channel display name (required for add).',
    },
    channelUrl: {
      type: 'string',
      description: 'Full YouTube channel URL (required for add).',
    },
    channelId: {
      type: 'string',
      description: 'YouTube channel ID starting with UC... (optional for add).',
    },
    niche: {
      type: 'string',
      description: 'Channel content niche / vertical (required for add).',
    },
    competitorId: {
      type: 'string',
      description: 'Competitor ID (required for remove, check-activity, compare).',
    },
    alertId: {
      type: 'string',
      description: 'Alert ID to acknowledge (required for acknowledge).',
    },
    limit: {
      type: 'number',
      description: 'Max number of alerts to return (default: 20).',
      default: 20,
    },
    unacknowledgedOnly: {
      type: 'boolean',
      description: 'Return only unacknowledged alerts (default: false).',
      default: false,
    },
    selfSubscribers: {
      type: 'number',
      description: 'Your channel subscriber count (required for compare).',
    },
    selfAvgViews: {
      type: 'number',
      description: 'Your channel average views per video (required for compare).',
    },
    selfUploadFrequency: {
      type: 'number',
      description: 'Your channel upload frequency per week (required for compare).',
      default: 1,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.competitor invoked');

    try {
      const { CompetitorMonitor } = await import('../../../competitive/competitor-monitor.js');
      const brain = extractBrain(ctx);
      const monitor = new CompetitorMonitor(undefined, brain);

      try {
        switch (action) {
          // ------------------------------------------------------------------
          case 'add': {
            const channelName = params['channelName'] as string | undefined;
            const channelUrl = params['channelUrl'] as string | undefined;
            const niche = params['niche'] as string | undefined;
            if (!channelName?.trim()) return { success: false, output: 'channelName is required for add.' };
            if (!channelUrl?.trim()) return { success: false, output: 'channelUrl is required for add.' };
            if (!niche?.trim()) return { success: false, output: 'niche is required for add.' };

            const id = monitor.addCompetitor(
              channelName,
              channelUrl,
              niche,
              params['channelId'] as string | undefined,
            );
            return {
              success: true,
              output: `Competitor added: "${channelName}" (id: ${id})`,
              data: { id, channelName, channelUrl, niche },
            };
          }

          // ------------------------------------------------------------------
          case 'list': {
            const competitors = monitor.listCompetitors();
            if (competitors.length === 0) return { success: true, output: 'No competitors tracked.', data: [] };
            const lines = competitors.map(
              (c) => `[${c.id.slice(0, 8)}] ${c.channelName} — ${c.niche}${c.subscriberCount ? ` (${c.subscriberCount.toLocaleString()} subs)` : ''}`,
            );
            return {
              success: true,
              output: `${competitors.length} competitor(s):\n${lines.join('\n')}`,
              data: competitors,
            };
          }

          // ------------------------------------------------------------------
          case 'remove': {
            const competitorId = params['competitorId'] as string | undefined;
            if (!competitorId?.trim()) return { success: false, output: 'competitorId is required for remove.' };
            monitor.removeCompetitor(competitorId);
            return { success: true, output: `Competitor ${competitorId} removed.` };
          }

          // ------------------------------------------------------------------
          case 'check-activity': {
            const competitorId = params['competitorId'] as string | undefined;
            if (!competitorId?.trim()) return { success: false, output: 'competitorId is required for check-activity.' };

            const alerts = await monitor.checkActivity(competitorId);
            const lines = alerts.map((a) => `[${a.type}] ${a.description}`);
            return {
              success: true,
              output: `${alerts.length} alert(s) generated:\n${lines.join('\n')}`,
              data: alerts,
            };
          }

          // ------------------------------------------------------------------
          case 'check-all': {
            const alerts = await monitor.checkAll();
            const lines = alerts.map((a) => `[${a.competitorId.slice(0, 8)}] [${a.type}] ${a.description}`);
            return {
              success: true,
              output: `${alerts.length} alert(s) across all competitors:\n${lines.join('\n')}`,
              data: alerts,
            };
          }

          // ------------------------------------------------------------------
          case 'alerts': {
            const limit = Math.max(1, Math.min(500, (params['limit'] as number | undefined) ?? 20));
            const unacknowledgedOnly = Boolean(params['unacknowledgedOnly']);
            const alerts = monitor.getAlerts(limit, unacknowledgedOnly);
            if (alerts.length === 0) {
              return { success: true, output: unacknowledgedOnly ? 'No unacknowledged alerts.' : 'No alerts recorded yet.', data: [] };
            }
            const lines = alerts.map(
              (a) => `[${a.id.slice(0, 8)}] ${a.acknowledged ? '[ACK]' : '[NEW]'} [${a.type}] ${a.description}`,
            );
            return {
              success: true,
              output: `${alerts.length} alert(s):\n${lines.join('\n')}`,
              data: alerts,
            };
          }

          // ------------------------------------------------------------------
          case 'acknowledge': {
            const alertId = params['alertId'] as string | undefined;
            if (!alertId?.trim()) return { success: false, output: 'alertId is required for acknowledge.' };
            monitor.acknowledgeAlert(alertId);
            return { success: true, output: `Alert ${alertId} acknowledged.` };
          }

          // ------------------------------------------------------------------
          case 'compare': {
            const competitorId = params['competitorId'] as string | undefined;
            const selfSubscribers = params['selfSubscribers'] as number | undefined;
            const selfAvgViews = params['selfAvgViews'] as number | undefined;
            if (!competitorId?.trim()) return { success: false, output: 'competitorId is required for compare.' };
            if (!selfSubscribers || selfSubscribers <= 0) return { success: false, output: 'selfSubscribers must be a positive number.' };
            if (!selfAvgViews || selfAvgViews <= 0) return { success: false, output: 'selfAvgViews must be a positive number.' };

            const selfUploadFrequency = (params['selfUploadFrequency'] as number | undefined) ?? 1;
            const rows = monitor.compareWithSelf(competitorId, {
              subscribers: selfSubscribers,
              avgViews: selfAvgViews,
              uploadFrequencyPerWeek: selfUploadFrequency,
            });

            const lines = rows.map(
              (r) => `${r.metric}: You=${r.self.toLocaleString()} | Competitor=${r.competitor.toLocaleString()} | ${r.gap}`,
            );
            return {
              success: true,
              output: `Comparison:\n${lines.join('\n')}`,
              data: rows,
            };
          }

          // ------------------------------------------------------------------
          case 'stats': {
            const stats = monitor.getStats();
            return {
              success: true,
              output: `Competitor monitor — tracked: ${stats.competitors} | alerts: ${stats.alerts} | unacknowledged: ${stats.unacknowledged}`,
              data: stats,
            };
          }

          // ------------------------------------------------------------------
          default:
            return { success: false, output: `Unknown action: ${action}` };
        }
      } finally {
        monitor.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.competitor error');
      return { success: false, output: `Competitor monitor error: ${msg}` };
    }
  },
};
