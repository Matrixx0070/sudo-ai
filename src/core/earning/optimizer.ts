/**
 * CohortOptimizer — analyses video performance patterns to surface
 * the best topics, upload times, and actionable recommendations.
 */

import { createLogger } from '../shared/logger.js';
import { PipelineError } from '../shared/errors.js';
import type { VideoMetrics, OptimizationResult, CohortAnalysis } from './types.js';
import { EarningTracker } from './tracker.js';

const log = createLogger('earning:optimizer');

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((a, v) => a + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

// Upload-hour → day-of-week label extraction from recordedAt ISO string.
function extractUploadHour(isoDate: string): number {
  const date = new Date(isoDate);
  return isNaN(date.getTime()) ? 12 : date.getUTCHours();
}

// ---------------------------------------------------------------------------
// Topic extraction — naive keyword clustering
// ---------------------------------------------------------------------------

function extractTopics(videos: VideoMetrics[]): Record<string, number> {
  const scores: Record<string, number> = {};

  for (const v of videos) {
    const words = v.title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4);

    for (const word of words) {
      const existing = scores[word] ?? 0;
      scores[word] = existing + v.views;
    }
  }

  return scores;
}

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

export class CohortOptimizer {
  private readonly tracker: EarningTracker;

  constructor(tracker?: EarningTracker) {
    this.tracker = tracker ?? new EarningTracker();
  }

  /**
   * Analyse the last N videos' performance.
   */
  analyzeCohort(videos: VideoMetrics[], _lastN?: number): CohortAnalysis {
    if (!Array.isArray(videos)) {
      throw new PipelineError('videos must be an array', 'pipeline_optimizer_invalid_input');
    }

    const cohort = _lastN !== undefined ? videos.slice(-_lastN) : videos;

    if (cohort.length === 0) {
      log.warn('analyzeCohort called with empty video list');
      return {
        avgViews: 0,
        avgWatchTimeHours: 0,
        avgCtr: 0,
        avgRevenue: 0,
        topTopics: [],
        weakestVideos: [],
      };
    }

    const avgViews = mean(cohort.map((v) => v.views));
    const avgWatchTimeHours = mean(cohort.map((v) => v.watchTimeHours));
    const avgCtr = mean(cohort.map((v) => v.ctr));
    const avgRevenue = mean(cohort.map((v) => v.estimatedRevenue));

    const topicScores = extractTopics(cohort);
    const topTopics = Object.entries(topicScores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([k]) => k);

    const viewStd = stddev(cohort.map((v) => v.views));
    const weakestVideos = cohort
      .filter((v) => v.views < avgViews - viewStd)
      .sort((a, b) => a.views - b.views)
      .slice(0, 3);

    log.info(
      { cohortSize: cohort.length, avgViews, avgRevenue },
      'Cohort analysis complete',
    );

    return { avgViews, avgWatchTimeHours, avgCtr, avgRevenue, topTopics, weakestVideos };
  }

  /**
   * Return topic keyword → cumulative view score sorted by performance.
   */
  getBestTopics(videos: VideoMetrics[]): Record<string, number> {
    if (videos.length === 0) {
      log.warn('getBestTopics called with empty list');
      return {};
    }
    const scores = extractTopics(videos);
    const sorted = Object.entries(scores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20);

    return Object.fromEntries(sorted);
  }

  /**
   * Find the upload hour (UTC) that correlates with highest view counts.
   */
  getBestUploadTime(videos: VideoMetrics[]): string {
    if (videos.length === 0) {
      return '18:00 UTC'; // sensible default
    }

    const hourMap: Record<number, number[]> = {};
    for (const v of videos) {
      const hour = extractUploadHour(v.recordedAt);
      if (!hourMap[hour]) hourMap[hour] = [];
      hourMap[hour].push(v.views);
    }

    let bestHour = 18;
    let bestAvg = 0;
    for (const [hourStr, views] of Object.entries(hourMap)) {
      const avg = mean(views);
      if (avg > bestAvg) {
        bestAvg = avg;
        bestHour = Number(hourStr);
      }
    }

    return `${String(bestHour).padStart(2, '0')}:00 UTC`;
  }

  /**
   * Generate human-readable recommendations based on cohort analysis.
   */
  getRecommendations(videos: VideoMetrics[]): OptimizationResult {
    const analysis = this.analyzeCohort(videos);
    const topicScores = this.getBestTopics(videos);
    const bestUploadTime = this.getBestUploadTime(videos);
    const recommendations: string[] = [];

    if (analysis.avgCtr < 0.04) {
      recommendations.push('CTR below 4% — A/B test new thumbnail styles and hook lines');
    }
    if (analysis.avgWatchTimeHours > 0) {
      // Watch time per view proxy
      const avgSecondsPerView = (analysis.avgWatchTimeHours * 3600) / Math.max(1, analysis.avgViews);
      if (avgSecondsPerView < 15) {
        recommendations.push('Average view duration under 15s — strengthen the 2s and 14s algorithm gates');
      }
    }
    if (analysis.weakestVideos.length > 0) {
      recommendations.push(
        `Bottom performers: ${analysis.weakestVideos.map((v) => `"${v.title}"`).join(', ')} — analyse hooks`,
      );
    }
    if (analysis.topTopics.length > 0) {
      recommendations.push(`Top-performing topics: ${analysis.topTopics.slice(0, 3).join(', ')} — produce more`);
    }
    recommendations.push(`Optimal upload window: ${bestUploadTime}`);

    log.info(
      { recommendationCount: recommendations.length, bestUploadTime },
      'Recommendations generated',
    );

    return { recommendations, topicScores, bestUploadTime };
  }
}
