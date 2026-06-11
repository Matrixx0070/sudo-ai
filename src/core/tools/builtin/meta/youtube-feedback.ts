/**
 * meta.youtube-feedback — registered SUDO-AI tool
 *
 * Lets SUDO pull its own YouTube analytics, analyze patterns,
 * and generate actionable content recommendations stored in mind.db.
 *
 * Environment variables (all optional — graceful degradation without them):
 *   YOUTUBE_API_KEY      — YouTube Data API v3 key (public stats)
 *   YOUTUBE_CHANNEL_ID   — Channel ID (e.g. UCxxxxxx)
 *   YOUTUBE_OAUTH_TOKEN  — OAuth 2.0 bearer token (for CTR / impressions)
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { YouTubeAnalytics } from '../../../feedback/youtube-analytics.js';
import { LearningEngine } from '../../../feedback/learning-engine.js';
import { DATA_DIR } from '../../../shared/paths.js';

const logger = createLogger('meta.youtube-feedback');

const DB_PATH = path.join(DATA_DIR, 'mind.db');

// ---------------------------------------------------------------------------
// Factory helpers — instantiated lazily per call so env vars are read fresh
// ---------------------------------------------------------------------------

function makeAnalytics(): YouTubeAnalytics {
  const apiKey = process.env['YOUTUBE_API_KEY'] ?? '';
  const channelId = process.env['YOUTUBE_CHANNEL_ID'] ?? '';
  return new YouTubeAnalytics(apiKey, channelId, DB_PATH);
}

function makeEngine(): LearningEngine {
  return new LearningEngine(DB_PATH);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ALLOWED_METRICS = ['views', 'likes', 'comments', 'ctr', 'impressions', 'watch_time', 'retention', 'subs'];

function validateMetric(metric: unknown): string {
  const m = String(metric ?? 'views');
  if (!ALLOWED_METRICS.includes(m)) {
    throw new Error(`Invalid metric "${m}". Allowed: ${ALLOWED_METRICS.join(', ')}`);
  }
  return m;
}

function validateLimit(limit: unknown, defaultVal = 5): number {
  const n = Number(limit ?? defaultVal);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error('limit must be an integer between 1 and 50');
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const youtubeFeedbackTool: ToolDefinition = {
  name: 'meta.youtube-feedback',
  description:
    'YouTube Analytics Feedback Loop. Fetch real video performance data from YouTube, ' +
    'store it in mind.db, analyse patterns across hook types / thumbnails / topics / duration, ' +
    'and generate actionable content recommendations. Requires YOUTUBE_API_KEY and ' +
    'YOUTUBE_CHANNEL_ID env vars for live data; works with stored data if absent.',
  category: 'meta',
  timeout: 60_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description:
        'Operation to perform. ' +
        '"fetch-analytics": pull latest data from YouTube API and store it. ' +
        '"analyze": run pattern analysis and store insights in mind.db. ' +
        '"report": generate a full performance report. ' +
        '"top-performers": list top N videos by a metric. ' +
        '"bottom-performers": list bottom N videos by a metric. ' +
        '"recommendations": output learning-engine recommendations.',
      enum: ['fetch-analytics', 'analyze', 'report', 'top-performers', 'bottom-performers', 'recommendations'],
    },
    videoId: {
      type: 'string',
      description: 'Optional single video ID to fetch (fetch-analytics only). If omitted, fetches all channel videos.',
    },
    metric: {
      type: 'string',
      description: `Metric to sort by for top/bottom-performers. One of: ${ALLOWED_METRICS.join(', ')}. Default: views.`,
      enum: ALLOWED_METRICS,
    },
    limit: {
      type: 'number',
      description: 'Number of results for top/bottom-performers (1–50, default 5).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(params['action'] ?? '');
    logger.info({ session: ctx.sessionId, action }, 'meta.youtube-feedback invoked');

    const apiKey = process.env['YOUTUBE_API_KEY'];
    const channelId = process.env['YOUTUBE_CHANNEL_ID'];

    if (!apiKey || !channelId) {
      if (action === 'fetch-analytics') {
        logger.warn('YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID not set — cannot fetch live data');
        return {
          success: false,
          output:
            'YOUTUBE_API_KEY and YOUTUBE_CHANNEL_ID environment variables are required to fetch live analytics. ' +
            'Add them to your .env file. Other actions (analyze, report, recommendations) work on stored data.',
        };
      }
      logger.info('No API key — running on stored data only');
    }

    try {
      switch (action) {
        case 'fetch-analytics': {
          const analytics = makeAnalytics();
          const videoId = params['videoId'] ? String(params['videoId']) : undefined;
          logger.info({ videoId: videoId ?? 'all' }, 'Fetching analytics');
          const data = await analytics.fetchPerformance(videoId);
          await analytics.storePerformance(data);
          return {
            success: true,
            output: `Fetched and stored ${data.length} video record(s).\n` +
              data.slice(0, 5).map(v => `  - "${v.title}" (${v.views.toLocaleString()} views, CTR ${(v.clickThroughRate * 100).toFixed(2)}%)`).join('\n') +
              (data.length > 5 ? `\n  ... and ${data.length - 5} more` : ''),
            data: { count: data.length, sample: data.slice(0, 5) },
          };
        }

        case 'analyze': {
          const analytics = makeAnalytics();
          const engine = makeEngine();
          const insights = await analytics.analyzePatterns();
          if (insights.length > 0) {
            engine.storeInsights(insights);
          }
          return {
            success: true,
            output: insights.length > 0
              ? `Generated and stored ${insights.length} insight(s):\n` +
                insights.map(i =>
                  `  [${i.category.toUpperCase()} | ${(i.confidence * 100).toFixed(0)}% conf]\n` +
                  `  ${i.pattern}\n  => ${i.actionable}`,
                ).join('\n\n')
              : 'No patterns found yet. Fetch more video analytics first with action=fetch-analytics.',
            data: { insightCount: insights.length, insights },
          };
        }

        case 'report': {
          const analytics = makeAnalytics();
          const report = await analytics.generateReport();
          return { success: true, output: report };
        }

        case 'top-performers': {
          const analytics = makeAnalytics();
          const metric = validateMetric(params['metric']);
          const limit = validateLimit(params['limit'], 5);
          const videos = await analytics.getTopPerformers(metric, limit);
          if (videos.length === 0) {
            return { success: true, output: 'No data available. Run fetch-analytics first.' };
          }
          const lines = videos.map((v, i) =>
            `${i + 1}. "${v.title}"\n` +
            `   Views: ${v.views.toLocaleString()} | CTR: ${(v.clickThroughRate * 100).toFixed(2)}% | Retention: ${(v.averageViewPercentage * 100).toFixed(1)}%` +
            (v.hookType ? ` | Hook: ${v.hookType}` : '') +
            (v.topic ? ` | Topic: ${v.topic}` : ''),
          );
          return {
            success: true,
            output: `Top ${videos.length} video(s) by ${metric}:\n${lines.join('\n')}`,
            data: { metric, videos },
          };
        }

        case 'bottom-performers': {
          const analytics = makeAnalytics();
          const metric = validateMetric(params['metric']);
          const limit = validateLimit(params['limit'], 5);
          const videos = await analytics.getBottomPerformers(metric, limit);
          if (videos.length === 0) {
            return { success: true, output: 'No data available. Run fetch-analytics first.' };
          }
          const lines = videos.map((v, i) =>
            `${i + 1}. "${v.title}"\n` +
            `   Views: ${v.views.toLocaleString()} | CTR: ${(v.clickThroughRate * 100).toFixed(2)}% | Retention: ${(v.averageViewPercentage * 100).toFixed(1)}%` +
            (v.hookType ? ` | Hook: ${v.hookType}` : '') +
            (v.topic ? ` | Topic: ${v.topic}` : ''),
          );
          return {
            success: true,
            output: `Bottom ${videos.length} video(s) by ${metric}:\n${lines.join('\n')}`,
            data: { metric, videos },
          };
        }

        case 'recommendations': {
          const engine = makeEngine();
          const summary = engine.formatRecommendationsSummary();
          return { success: true, output: summary };
        }

        default:
          return { success: false, output: `Unknown action: "${action}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.youtube-feedback error');
      return { success: false, output: `YouTube feedback error: ${msg}` };
    }
  },
};
