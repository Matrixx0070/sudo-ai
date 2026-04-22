/**
 * @file optimizer.ts
 * Analyses historical video performance data and generates topic-weight adjustments
 * plus best-upload-hour recommendations.
 *
 * All failures are NON-FATAL: when data is missing the module returns neutral weights.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../core/shared/logger.js';
import { PipelineError } from '../core/shared/errors.js';
import { PATHS } from '../core/shared/constants.js';
import type { OptimizationResult, VideoPerformance } from './types.js';

const log = createLogger('pipeline:optimizer');

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

const PERFORMANCE_FILE = path.join(PATHS.DATA, 'pipeline', 'performance.json');
const OPTIMIZATION_FILE = path.join(PATHS.DATA, 'pipeline', 'optimization.json');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOOKBACK_DAYS = 30;
const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 2.0;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000; // UTC+5:30

// ---------------------------------------------------------------------------
// Helpers: file I/O
// ---------------------------------------------------------------------------

/**
 * Read JSON from a file, returning a typed fallback if missing or malformed.
 */
function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write JSON to a file, creating parent directories as needed.
 * Throws PipelineError on write failure.
 */
function writeJsonFile(filePath: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    throw new PipelineError(
      `Failed to write ${filePath}: ${String(err)}`,
      'pipeline_optimizer_write_error',
      { filePath, cause: String(err) },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers: statistics
// ---------------------------------------------------------------------------

/**
 * Clamp a number to [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Average an array of numbers; returns 0 for empty arrays.
 */
function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Convert a UTC ISO timestamp to its IST hour (0–23).
 */
function toISTHour(isoTimestamp: string): number {
  const utcMs = new Date(isoTimestamp).getTime();
  const istMs = utcMs + IST_OFFSET_MS;
  return new Date(istMs).getUTCHours();
}

/**
 * Return a neutral OptimizationResult with all weights set to 1.0.
 */
function neutralResult(): OptimizationResult {
  return {
    topicWeightAdjustments: {},
    bestUploadHours: [8, 12, 18], // default IST hours with high engagement
    bestThumbnailStyle: 'default',
    recommendations: ['Insufficient data — using neutral defaults'],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse the last 30 days of video performance data and compute:
 * - Per-category topic weight adjustments (relative to overall avg CTR)
 * - Top-3 best upload hours in IST
 * - Recommendations text
 *
 * Results are persisted to data/pipeline/optimization.json.
 * Returns neutral weights when no performance data exists.
 */
export async function runOptimization(): Promise<OptimizationResult> {
  log.info('Optimizer: starting analysis');

  const allPerformance = readJsonFile<VideoPerformance[]>(PERFORMANCE_FILE, []);

  if (allPerformance.length === 0) {
    log.warn('Optimizer: no performance data found — returning neutral weights');
    const neutral = neutralResult();
    try {
      writeJsonFile(OPTIMIZATION_FILE, neutral);
    } catch (err) {
      log.error({ err }, 'Optimizer: failed to persist neutral result');
    }
    return neutral;
  }

  // Filter to LOOKBACK_DAYS window
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1_000;
  const recent = allPerformance.filter((p) => {
    const ts = new Date(p.publishedAt).getTime();
    return !isNaN(ts) && ts >= cutoff;
  });

  log.info(
    { total: allPerformance.length, recent: recent.length, lookbackDays: LOOKBACK_DAYS },
    'Optimizer: data window applied',
  );

  if (recent.length === 0) {
    log.warn('Optimizer: no data within lookback window — returning neutral weights');
    return neutralResult();
  }

  // Overall average CTR
  const overallAvgCTR = average(recent.map((p) => p.ctr));

  // Group by category
  const byCategory = new Map<string, VideoPerformance[]>();
  for (const p of recent) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  // Compute per-category weight
  const topicWeightAdjustments: Record<string, number> = {};
  const recommendations: string[] = [];

  for (const [category, videos] of byCategory) {
    const catAvgCTR = average(videos.map((v) => v.ctr));
    const catAvgViews = average(videos.map((v) => v.views));
    const catAvgRetention = average(videos.map((v) => v.avgRetention));

    const rawWeight = overallAvgCTR > 0 ? catAvgCTR / overallAvgCTR : 1.0;
    const weight = clamp(rawWeight, WEIGHT_MIN, WEIGHT_MAX);
    topicWeightAdjustments[category] = weight;

    log.debug(
      { category, catAvgCTR, overallAvgCTR, rawWeight, weight, catAvgViews, catAvgRetention },
      'Optimizer: category weight computed',
    );

    if (weight >= 1.5) {
      recommendations.push(
        `Increase "${category}" topics — CTR ${(catAvgCTR * 100).toFixed(1)}% (above avg)`,
      );
    } else if (weight <= 0.7) {
      recommendations.push(
        `Reduce "${category}" topics — CTR ${(catAvgCTR * 100).toFixed(1)}% (below avg)`,
      );
    }
  }

  // Best upload hours — bin by IST hour and average views per bin
  const hourBins = new Map<number, number[]>();
  for (const p of recent) {
    const hour = toISTHour(p.publishedAt);
    const bin = hourBins.get(hour) ?? [];
    bin.push(p.views);
    hourBins.set(hour, bin);
  }

  const hourAverages: Array<{ hour: number; avgViews: number }> = [];
  for (const [hour, views] of hourBins) {
    hourAverages.push({ hour, avgViews: average(views) });
  }
  hourAverages.sort((a, b) => b.avgViews - a.avgViews);
  const bestUploadHours = hourAverages.slice(0, 3).map((h) => h.hour);

  // Ensure we always return exactly 3 hours
  const defaultHours = [8, 12, 18];
  while (bestUploadHours.length < 3) {
    const next = defaultHours.find((h) => !bestUploadHours.includes(h)) ?? 0;
    bestUploadHours.push(next);
  }

  if (bestUploadHours.length > 0) {
    recommendations.push(
      `Best upload hours (IST): ${bestUploadHours.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')}`,
    );
  }

  const result: OptimizationResult = {
    topicWeightAdjustments,
    bestUploadHours,
    bestThumbnailStyle: 'default',
    recommendations,
  };

  try {
    writeJsonFile(OPTIMIZATION_FILE, result);
    log.info(
      { categories: Object.keys(topicWeightAdjustments).length, bestUploadHours },
      'Optimizer: analysis complete — results persisted',
    );
  } catch (err) {
    log.error({ err }, 'Optimizer: failed to persist optimization result');
    // Non-fatal: return the in-memory result anyway
  }

  return result;
}

/**
 * Read the last optimization result from disk without recomputing.
 * Returns null if no optimization has been run yet.
 */
export async function getOptimizationHints(): Promise<OptimizationResult | null> {
  try {
    const raw = fs.readFileSync(OPTIMIZATION_FILE, 'utf8');
    const data = JSON.parse(raw) as OptimizationResult;
    log.debug('Optimizer: loaded cached optimization hints from disk');
    return data;
  } catch {
    log.debug('Optimizer: no cached optimization file found');
    return null;
  }
}

/**
 * Append a single VideoPerformance record to the persistent performance log.
 * Creates the file (and parent directories) if they do not exist.
 *
 * @param perf - Performance record to persist.
 */
export async function recordVideoPerformance(perf: VideoPerformance): Promise<void> {
  if (!perf.youtubeVideoId || !perf.category) {
    throw new PipelineError(
      'recordVideoPerformance: youtubeVideoId and category are required',
      'pipeline_optimizer_write_error',
      { perf: perf as unknown as Record<string, unknown> },
    );
  }

  const existing = readJsonFile<VideoPerformance[]>(PERFORMANCE_FILE, []);
  existing.push({ ...perf, collectedAt: perf.collectedAt ?? new Date().toISOString() });

  try {
    writeJsonFile(PERFORMANCE_FILE, existing);
    log.info(
      { videoId: perf.youtubeVideoId, category: perf.category, views: perf.views },
      'Optimizer: performance record saved',
    );
  } catch (err) {
    // Non-fatal log: do not block caller
    log.error({ err, videoId: perf.youtubeVideoId }, 'Optimizer: failed to save performance record');
  }
}
