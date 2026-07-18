/**
 * Earning toolkit — registers 3 earning tools into the ToolRegistry.
 *
 * Tools registered:
 *   earning.tracker    — Pull YouTube Analytics metrics for individual or all videos
 *   earning.optimizer  — Analyse video cohort performance for topic and timing insights
 *   earning.revenue    — Revenue milestone tracking, ROI reports, and period summaries
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('earning-builtin');

// ---------------------------------------------------------------------------
// earning.tracker
// ---------------------------------------------------------------------------

const trackerTool: ToolDefinition = {
  name: 'earning.tracker',
  description:
    'Pull YouTube Analytics data for videos. Track views, watch time, revenue, CTR, and subscriber gains. Stores results in SQLite for historical analysis. Requires YOUTUBE_ACCESS_TOKEN.',
  category: 'earning',
  timeout: 60_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['pull-video', 'pull-all', 'get-top', 'get-revenue'],
    },
    youtubeId: {
      type: 'string',
      description: 'YouTube video ID (11-char string). Required for pull-video.',
    },
    title: {
      type: 'string',
      description: 'Video title label for display purposes.',
    },
    limit: {
      type: 'number',
      description: 'Number of top videos to return for get-top (default: 10).',
      default: 10,
    },
    period: {
      type: 'string',
      description: 'Period for get-revenue: ISO date prefix like "2026-03", "2026", or "all".',
      default: 'all',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'earning.tracker invoked');

    try {
      const { EarningTracker } = await import('../../../earning/tracker.js');
      const tracker = new EarningTracker();

      switch (action) {
        case 'pull-video': {
          const youtubeId = params['youtubeId'] as string | undefined;
          if (!youtubeId?.trim()) return { success: false, output: 'youtubeId is required for pull-video.' };
          const title = (params['title'] as string | undefined) ?? '';
          const metrics = await tracker.pullMetrics(youtubeId, title);
          return {
            success: true,
            output: [
              `Video: ${metrics.title || youtubeId}`,
              `Views: ${metrics.views.toLocaleString()}`,
              `Revenue: $${metrics.estimatedRevenue.toFixed(2)}`,
              `Watch time: ${metrics.watchTimeHours.toFixed(1)}h`,
              `CTR: ${(metrics.ctr * 100).toFixed(2)}%`,
            ].join(' | '),
            data: metrics,
          };
        }

        case 'pull-all': {
          const allMetrics = await tracker.pullAllMetrics();
          const entries = [...allMetrics.entries()];
          return {
            success: true,
            output: `Pulled metrics for ${entries.length} video(s).`,
            data: Object.fromEntries(entries),
          };
        }

        case 'get-top': {
          const limit = Math.max(1, (params['limit'] as number | undefined) ?? 10);
          const top = tracker.getTopVideos(limit);
          const lines = top.map((v, i) =>
            `${i + 1}. ${v.title || v.youtubeId}: ${v.views.toLocaleString()} views, $${v.estimatedRevenue.toFixed(2)}`
          );
          return {
            success: true,
            output: lines.length > 0 ? `Top ${lines.length} video(s):\n${lines.join('\n')}` : 'No video data stored yet.',
            data: top,
          };
        }

        case 'get-revenue': {
          const period = (params['period'] as string | undefined) ?? 'all';
          const total = tracker.getRevenue(period);
          return {
            success: true,
            output: `Total revenue (${period}): $${total.toFixed(2)}`,
            data: { period, totalRevenue: total },
          };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'earning.tracker error');
      return { success: false, output: `Earning tracker error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// earning.optimizer
// ---------------------------------------------------------------------------

const optimizerTool: ToolDefinition = {
  name: 'earning.optimizer',
  description:
    'Analyse YouTube video performance patterns. Identify top-performing topics, optimal upload times, weak videos needing improvement, and cohort statistics.',
  category: 'earning',
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Analysis to run.',
      enum: ['cohort-analysis', 'best-topics', 'best-upload-time'],
    },
    lastN: {
      type: 'number',
      description: 'Analyse only the last N videos (omit for all).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'earning.optimizer invoked');

    try {
      const { EarningTracker } = await import('../../../earning/tracker.js');
      const { CohortOptimizer } = await import('../../../earning/optimizer.js');

      const tracker = new EarningTracker();
      const optimizer = new CohortOptimizer(tracker);
      const videos = tracker.getTopVideos(100);

      if (videos.length === 0) {
        return { success: false, output: 'No video data available. Pull metrics first with earning.tracker.' };
      }

      const lastN = params['lastN'] as number | undefined;

      switch (action) {
        case 'cohort-analysis': {
          const analysis = optimizer.analyzeCohort(videos, lastN);
          return {
            success: true,
            output: [
              `Cohort (${lastN ?? videos.length} videos):`,
              `Avg views: ${analysis.avgViews.toFixed(0)}`,
              `Avg revenue: $${analysis.avgRevenue.toFixed(2)}`,
              `Avg CTR: ${(analysis.avgCtr * 100).toFixed(2)}%`,
              `Top topics: ${analysis.topTopics.join(', ')}`,
              `Weakest videos: ${analysis.weakestVideos.map((v) => v.title || v.youtubeId).join(', ')}`,
            ].join('\n'),
            data: analysis,
          };
        }

        case 'best-topics': {
          const topics = optimizer.getBestTopics(videos);
          const top10 = Object.entries(topics).slice(0, 10);
          const lines = top10.map(([topic, score]) => `${topic}: ${score.toLocaleString()} views`);
          return {
            success: true,
            output: `Best performing topics:\n${lines.join('\n')}`,
            data: topics,
          };
        }

        case 'best-upload-time': {
          const time = optimizer.getBestUploadTime(videos);
          return {
            success: true,
            output: `Best upload time: ${time}`,
            data: { bestUploadTime: time },
          };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'earning.optimizer error');
      return { success: false, output: `Optimizer error: ${msg}` };
    }
  },
};

// (F102) earning.revenue tool retired 2026-07-18 — its RevenueTracker was
// constructed fresh per invocation (record-cost/check-milestones state died
// at call end); revenue reporting lives in earning.tracker get-revenue.

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const EARNING_TOOLS: ToolDefinition[] = [
  trackerTool,
  optimizerTool,
];

/**
 * Register all earning tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerEarningTools(registry: ToolRegistry): void {
  // Persona/business tools are quarantined by default (SUDO_ENABLE_PERSONA_TOOLS=1).
  if (process.env['SUDO_ENABLE_PERSONA_TOOLS'] !== '1') {
    logger.info('Earning tools quarantined — set SUDO_ENABLE_PERSONA_TOOLS=1 to enable');
    return;
  }
  logger.info({ count: EARNING_TOOLS.length }, 'Registering earning tools');
  for (const tool of EARNING_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: EARNING_TOOLS.length }, 'Earning tools registered');
}
