/**
 * RevenueTracker — monitors revenue milestones and computes ROI
 * against API production costs stored in the pipeline runs.
 */

import { createLogger } from '../shared/logger.js';
import { PipelineError } from '../shared/errors.js';
import { todayISO } from '../shared/utils.js';
import { EarningTracker } from './tracker.js';
import type { RevenueMilestone, ROIReport, RevenueReport, VideoMetrics } from './types.js';

const log = createLogger('earning:revenue');

// ---------------------------------------------------------------------------
// Milestone definitions
// ---------------------------------------------------------------------------

const MILESTONES: Omit<RevenueMilestone, 'reachedAt'>[] = [
  { amount: 10, label: 'First $10' },
  { amount: 50, label: 'First $50' },
  { amount: 100, label: 'First $100' },
  { amount: 250, label: '$250 milestone' },
  { amount: 500, label: '$500 milestone' },
  { amount: 1000, label: '$1K milestone' },
  { amount: 5000, label: '$5K milestone' },
];

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

export class RevenueTracker {
  private readonly tracker: EarningTracker;
  private readonly reachedMilestones = new Set<number>();
  private totalApiCost = 0;

  constructor(tracker?: EarningTracker) {
    this.tracker = tracker ?? new EarningTracker();
  }

  /**
   * Record API spending from a pipeline run so ROI can be calculated.
   */
  recordApiCost(costUsd: number): void {
    if (typeof costUsd !== 'number' || costUsd < 0) {
      throw new PipelineError(
        'costUsd must be a non-negative number',
        'pipeline_revenue_invalid_cost',
      );
    }
    this.totalApiCost += costUsd;
    log.debug({ costUsd, totalApiCost: this.totalApiCost }, 'API cost recorded');
  }

  /**
   * Build a RevenueReport for a given period string (YYYY, YYYY-MM, or 'all').
   */
  getReport(period: string, topVideos: VideoMetrics[]): RevenueReport {
    if (!period || typeof period !== 'string') {
      throw new PipelineError('period must be a non-empty string', 'pipeline_revenue_invalid_period');
    }

    const totalRevenue = this.tracker.getRevenue(period);
    const totalViews = topVideos.reduce((a, v) => a + v.views, 0);
    const costVsRevenue = totalRevenue - this.totalApiCost;

    const filtered = period === 'all'
      ? topVideos
      : topVideos.filter((v) => v.recordedAt.startsWith(period));

    const top = [...filtered]
      .sort((a, b) => b.estimatedRevenue - a.estimatedRevenue)
      .slice(0, 10);

    log.info({ period, totalRevenue, totalViews, costVsRevenue }, 'Revenue report generated');

    return { period, totalRevenue, totalViews, topVideos: top, costVsRevenue };
  }

  /**
   * Check if any new revenue milestones have been reached.
   * Returns the milestones newly hit on this call.
   */
  checkMilestones(): RevenueMilestone[] {
    const currentRevenue = this.tracker.getRevenue('all');
    const newlyReached: RevenueMilestone[] = [];

    for (const milestone of MILESTONES) {
      if (currentRevenue >= milestone.amount && !this.reachedMilestones.has(milestone.amount)) {
        this.reachedMilestones.add(milestone.amount);
        const reached: RevenueMilestone = { ...milestone, reachedAt: todayISO() };
        newlyReached.push(reached);
        log.info(
          { milestone: milestone.label, amount: milestone.amount, currentRevenue },
          'Revenue milestone reached!',
        );
      }
    }

    if (newlyReached.length === 0) {
      log.debug({ currentRevenue }, 'No new milestones reached');
    }

    return newlyReached;
  }

  /**
   * Calculate return on investment: (revenue - cost) / cost * 100.
   * Returns full ROI breakdown.
   */
  getROI(allVideos: VideoMetrics[]): ROIReport {
    const totalRevenue = this.tracker.getRevenue('all');
    const roi =
      this.totalApiCost > 0
        ? ((totalRevenue - this.totalApiCost) / this.totalApiCost) * 100
        : totalRevenue > 0
        ? Infinity
        : 0;

    const profitableVideos = allVideos.filter((v) => v.estimatedRevenue > 0).length;

    const report: ROIReport = {
      totalRevenue,
      totalApiCost: this.totalApiCost,
      roi,
      profitableVideos,
      totalVideos: allVideos.length,
    };

    log.info(
      { totalRevenue, totalApiCost: this.totalApiCost, roi, profitableVideos },
      'ROI report generated',
    );

    return report;
  }
}
