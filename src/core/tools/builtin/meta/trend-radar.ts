/**
 * meta.trend-radar — Real-Time World Awareness tool for SUDO-AI.
 *
 * Actions:
 *   scan-now       — Run an immediate scan across all sources, return new trends + alerts
 *   recent-trends  — Return trends detected in the last N hours
 *   alerts         — Return the most recent trend alerts (niche-matched only)
 *   niche-matches  — Return only trends that match the owner's content niches
 *   stats          — Return aggregate counts: total, by-source, niche matches, alerts
 */

import { TrendRadar } from '../../../awareness/trend-radar.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-trend-radar');

const DB_PATH = MIND_DB;

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _radar: TrendRadar | null = null;

function getRadar(): TrendRadar {
  if (!_radar) {
    _radar = new TrendRadar(DB_PATH);
    logger.info({ dbPath: DB_PATH }, 'TrendRadar singleton created');
  }
  return _radar;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTrend(t: {
  id: string; title: string; source: string; score: number;
  category?: string; url?: string; detectedAt: string; matchesNiche: boolean;
}): string {
  const src = t.source === 'hackernews' ? 'HN'
    : t.source === 'reddit' ? `r/${t.category ?? 'reddit'}`
    : 'GTrends';
  const niche = t.matchesNiche ? ' [NICHE]' : '';
  return `[${src}] ${t.title} (score: ${t.score})${niche}`;
}

function formatAlert(a: {
  id?: number; urgency: string; reason: string; suggestedAction: string;
  trend: { title: string; source: string; score: number; category?: string; matchesNiche: boolean; url?: string; detectedAt: string; id: string };
  createdAt?: string;
}): string {
  return [
    `[${a.urgency.toUpperCase()}] ${a.trend.title}`,
    `  Source: ${a.trend.source} | Score: ${a.trend.score}`,
    `  Reason: ${a.reason}`,
    `  Action: ${a.suggestedAction}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const trendRadarTool: ToolDefinition = {
  name: 'meta.trend-radar',
  description:
    'Real-time world awareness: monitor Hacker News, Reddit, and Google Trends for trending topics. '
    + 'Detects and alerts on topics matching your content niches (AI, tech, India, Pakistan, YouTube). '
    + 'Actions: scan-now (immediate scan), recent-trends (past N hours), alerts (niche alerts), '
    + 'niche-matches (filter to relevant trends), stats (aggregate counts).',
  category: 'meta',
  timeout: 60_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['scan-now', 'recent-trends', 'alerts', 'niche-matches', 'stats'],
    },
    hours: {
      type: 'number',
      description: '[recent-trends, niche-matches] Look-back window in hours (default: 24, max: 168).',
      default: 24,
    },
    limit: {
      type: 'number',
      description: '[recent-trends, alerts, niche-matches] Maximum rows to return (default: 20, max: 200).',
      default: 20,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = (params['action'] as string | undefined)?.trim();
    logger.info({ session: ctx.sessionId, action }, 'meta.trend-radar invoked');

    if (!action) {
      return {
        success: false,
        output: 'action is required. Choose one of: scan-now, recent-trends, alerts, niche-matches, stats.',
      };
    }

    try {
      const radar = getRadar();

      switch (action) {

        // -------------------------------------------------------------------
        case 'scan-now': {
          logger.info({ session: ctx.sessionId }, 'Running immediate trend scan');
          const trends = await radar.scanAll();
          const alerts = radar.generateAlerts(trends);

          const nicheCount  = trends.filter(t => t.matchesNiche).length;
          const hnCount     = trends.filter(t => t.source === 'hackernews').length;
          const redditCount = trends.filter(t => t.source === 'reddit').length;
          const gtCount     = trends.filter(t => t.source === 'google_trends').length;

          const topNiche = alerts.slice(0, 5).map(a => formatAlert(a)).join('\n\n');

          const output = [
            `Scan complete: ${trends.length} trends found (HN: ${hnCount}, Reddit: ${redditCount}, GTrends: ${gtCount})`,
            `Niche matches: ${nicheCount} | Alerts generated: ${alerts.length}`,
            '',
            alerts.length > 0 ? `Top alerts:\n${topNiche}` : 'No niche-matching trends found.',
          ].join('\n');

          logger.info({
            trends: trends.length,
            niche: nicheCount,
            alerts: alerts.length,
          }, 'scan-now complete');

          return { success: true, output, data: { trends, alerts } };
        }

        // -------------------------------------------------------------------
        case 'recent-trends': {
          const rawHours = params['hours'];
          const hours = typeof rawHours === 'number'
            ? Math.min(168, Math.max(1, Math.floor(rawHours)))
            : 24;
          const rawLimit = params['limit'];
          const limit = typeof rawLimit === 'number'
            ? Math.min(200, Math.max(1, Math.floor(rawLimit)))
            : 20;

          const trends = radar.getRecentTrends(hours, limit);

          if (trends.length === 0) {
            return {
              success: true,
              output: `No trends found in the last ${hours}h. Run scan-now first to populate data.`,
              data: { trends: [] },
            };
          }

          const lines = trends.map(t => formatTrend(t));
          const output = `${trends.length} trend(s) in the last ${hours}h:\n${lines.join('\n')}`;
          logger.info({ count: trends.length, hours }, 'recent-trends returned');
          return { success: true, output, data: { trends } };
        }

        // -------------------------------------------------------------------
        case 'alerts': {
          const rawLimit = params['limit'];
          const limit = typeof rawLimit === 'number'
            ? Math.min(200, Math.max(1, Math.floor(rawLimit)))
            : 20;

          const alerts = radar.getAlerts(limit);

          if (alerts.length === 0) {
            return {
              success: true,
              output: 'No alerts found. Run scan-now to generate alerts from current trends.',
              data: { alerts: [] },
            };
          }

          const lines = alerts.map(a => formatAlert(a));
          const output = `${alerts.length} alert(s):\n\n${lines.join('\n\n')}`;
          logger.info({ count: alerts.length }, 'alerts returned');
          return { success: true, output, data: { alerts } };
        }

        // -------------------------------------------------------------------
        case 'niche-matches': {
          const rawHours = params['hours'];
          const hours = typeof rawHours === 'number'
            ? Math.min(168, Math.max(1, Math.floor(rawHours)))
            : 24;
          const rawLimit = params['limit'];
          const limit = typeof rawLimit === 'number'
            ? Math.min(200, Math.max(1, Math.floor(rawLimit)))
            : 20;

          const all = radar.getRecentTrends(hours, 1000);
          const niche = all.filter(t => t.matchesNiche).slice(0, limit);

          if (niche.length === 0) {
            return {
              success: true,
              output: `No niche-matching trends in the last ${hours}h. Run scan-now first.`,
              data: { trends: [] },
            };
          }

          const lines = niche.map(t => formatTrend(t));
          const output = `${niche.length} niche-matching trend(s) in the last ${hours}h:\n${lines.join('\n')}`;
          logger.info({ count: niche.length, hours }, 'niche-matches returned');
          return { success: true, output, data: { trends: niche } };
        }

        // -------------------------------------------------------------------
        case 'stats': {
          const stats = radar.getStats();
          const bySource = stats['bySource'] as Record<string, number>;
          const srcLines = Object.entries(bySource)
            .sort((a, b) => b[1] - a[1])
            .map(([src, n]) => `  ${src}: ${n}`)
            .join('\n') || '  (no data)';

          const output = [
            'Trend Radar Statistics',
            `  Total trends stored: ${stats['total'] as number}`,
            `  Niche matches:       ${stats['nicheMatches'] as number}`,
            `  Total alerts:        ${stats['totalAlerts'] as number}`,
            `  Scanner running:     ${stats['running'] ? 'yes' : 'no'}`,
            'By source:',
            srcLines,
          ].join('\n');

          logger.info(stats, 'stats returned');
          return { success: true, output, data: stats };
        }

        // -------------------------------------------------------------------
        default:
          return {
            success: false,
            output: `Unknown action: "${action}". Valid actions: scan-now, recent-trends, alerts, niche-matches, stats.`,
          };
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg, session: ctx.sessionId }, 'meta.trend-radar error');
      return { success: false, output: `Trend radar error: ${msg}` };
    }
  },
};
