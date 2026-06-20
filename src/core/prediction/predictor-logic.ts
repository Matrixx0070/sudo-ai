/**
 * predictor-logic.ts — async prediction logic extracted from Predictor.
 *
 * Contains the three heavyweight methods that would push predictor.ts over
 * the 300-line boundary: anticipate(), predictViralTopic(), detectAnomalies().
 * Each function receives the Database instance directly and returns plain values.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { istHour, utcDow, type Prediction, type Anomaly, type ApiCostRow, type VideoRow } from './predictor-schema.js';

const logger = createLogger('predictor-logic');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const POSITIVE_SIGNALS = ['optimize', 'improve', 'increase', 'grow', 'fast', 'best', 'top', 'viral', 'peak'];
const NEGATIVE_SIGNALS = ['reduce', 'decrease', 'slow', 'worst', 'delay', 'pause', 'stop', 'cancel'];

// ---------------------------------------------------------------------------
// Shared builder — creates an un-stored Prediction value object
// ---------------------------------------------------------------------------

function buildPrediction(
  type: Prediction['type'], prediction: string, confidence: number,
  reasoning: string, suggestedAction: string, now: Date, expiresInHours: number
): Prediction {
  return {
    id: randomUUID(), type, prediction, confidence, reasoning, suggestedAction,
    expiresAt: new Date(now.getTime() + expiresInHours * 3_600_000).toISOString(),
    outcome: 'pending', createdAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// anticipate
// ---------------------------------------------------------------------------

export async function runAnticipate(db: Database.Database): Promise<Prediction[]> {
  const predictions: Prediction[] = [];
  const now = new Date();
  const hour = istHour();
  const dow = utcDow();
  logger.info({ istHour: hour, dow }, 'Running anticipation scan');

  // Monday morning weekly report
  if (dow === 1 && hour >= 7 && hour < 10) {
    predictions.push(buildPrediction('action',
      'The owner will want a weekly performance summary this Monday morning', 0.88,
      'Pattern: weekly review always requested on Monday mornings (IST 07:00-10:00)',
      'Run meta.youtube-feedback action=report + meta.cost-tracker action=weekly', now, 6));
  }

  // Content gap detection. predictions.created_at is ISO-8601 (strftime
  // default) — a space-format datetime('now') cutoff mis-compares (see ~L230).
  const rc = db.prepare(`
    SELECT COUNT(*) AS cnt FROM predictions
    WHERE type = 'content' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')
  `).get() as { cnt: number };
  if (rc.cnt === 0) {
    predictions.push(buildPrediction('content',
      'No content topics predicted in the last 48 hours — a content gap may be forming', 0.75,
      'No content-type predictions stored in 2 days, indicating a potential pipeline stall',
      'Run meta.predictor action=predict-viral to generate fresh topic ideas', now, 4));
  }

  // Elevated API cost
  try {
    // api_call_log.called_at is ISO-8601; use strftime, not space-format datetime('now').
    const costRow = db.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM api_call_log
      WHERE called_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')
    `).get() as ApiCostRow;
    const lastHourCost = costRow?.total ?? 0;
    if (lastHourCost > 0.5) {
      predictions.push(buildPrediction('revenue',
        `API spend in the last hour is $${lastHourCost.toFixed(4)} — elevated rate detected`, 0.80,
        `Last-hour API cost ($${lastHourCost.toFixed(4)}) exceeds normal threshold of $0.50/hr`,
        'Run meta.cost-tracker action=check-budget to review daily limit status', now, 2));
    }
  } catch { logger.debug('api_call_log not available, skipping cost anticipation'); }

  // Upcoming upload window
  if (hour >= 6 && hour < 8) {
    predictions.push(buildPrediction('schedule',
      `Optimal IST upload window approaches (08:00-09:00 IST, ${DAY_NAMES[dow]})`, 0.82,
      'IST peak engagement window 08:00-09:00 is within 2 hours — renders should be verified',
      'Verify scheduled renders are complete before the upload window opens', now, 3));
  }

  logger.info({ count: predictions.length }, 'Anticipation scan complete');
  return predictions;
}

// ---------------------------------------------------------------------------
// predictViralTopic
// ---------------------------------------------------------------------------

export async function runPredictViralTopic(db: Database.Database): Promise<Prediction> {
  logger.info('Predicting viral topic from video performance data');
  let topicHint = 'trending AI tools comparison';
  let confidence = 0.60;
  let reasoning = 'Default prediction — no historical performance data available yet';

  try {
    const rows = db.prepare(`
      SELECT title, views, hook_type, topic, avg_view_percentage
      FROM video_performance WHERE views > 0
      ORDER BY views DESC, avg_view_percentage DESC LIMIT 10
    `).all() as VideoRow[];

    if (rows.length > 0) {
      // Tally views by topic
      const topicMap = new Map<string, number>();
      for (const r of rows) {
        const t = r.topic ?? 'general';
        topicMap.set(t, (topicMap.get(t) ?? 0) + (r.views ?? 0));
      }
      const sorted = [...topicMap.entries()].sort((a, b) => b[1] - a[1]);
      const bestTopic = sorted[0]?.[0] ?? 'AI tools';

      // Best hook by avg retention
      const hookMap = new Map<string, number[]>();
      for (const r of rows) {
        const h = r.hook_type ?? 'unknown';
        if (!hookMap.has(h)) hookMap.set(h, []);
        if (r.avg_view_percentage != null) hookMap.get(h)!.push(r.avg_view_percentage);
      }
      let bestHook = 'unknown', bestHookAvg = 0;
      for (const [hook, vals] of hookMap) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        if (avg > bestHookAvg) { bestHookAvg = avg; bestHook = hook; }
      }

      topicHint = `${bestTopic} video with "${bestHook}" hook style`;
      confidence = Math.min(0.92, 0.55 + rows.length * 0.04);
      reasoning = `Analysed top ${rows.length} videos. Best topic: "${bestTopic}" `
        + `(${sorted[0]?.[1]?.toLocaleString() ?? 0} views). `
        + `Best hook: "${bestHook}" (${bestHookAvg.toFixed(1)}% avg retention)`;
    }
  } catch { logger.debug('video_performance table not available, using defaults'); }

  logger.info({ topic: topicHint, confidence }, 'Viral topic prediction built');
  return buildPrediction('content', `Predicted viral topic: ${topicHint}`,
    confidence, reasoning,
    `Draft a script around "${topicHint}" for the next upload slot`,
    new Date(), 24);
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

export async function runSimulate(
  scenario: string,
  options: string[]
): Promise<Array<{ option: string; projectedOutcome: string; confidence: number }>> {
  logger.info({ scenario, optionCount: options.length }, 'Running decision simulation');

  const results = options.map((option, idx) => {
    const lc = option.toLowerCase();
    const posScore = POSITIVE_SIGNALS.filter(s => lc.includes(s)).length;
    const negScore = NEGATIVE_SIGNALS.filter(s => lc.includes(s)).length;
    const adjusted = Math.min(0.90, Math.max(0.15, 0.50 - idx * 0.03 + posScore * 0.08 - negScore * 0.10));
    const projectedOutcome = adjusted >= 0.75
      ? `High probability of success. Aligns with growth indicators for "${scenario}".`
      : adjusted >= 0.50
        ? `Moderate probability. Viable for "${scenario}" but carries execution risk.`
        : `Lower probability. May underperform relative to alternatives for "${scenario}".`;
    return { option, projectedOutcome, confidence: Math.round(adjusted * 100) / 100 };
  });

  results.sort((a, b) => b.confidence - a.confidence);
  logger.info({ scenario, topOption: results[0]?.option }, 'Simulation complete');
  return results;
}

// ---------------------------------------------------------------------------
// detectAnomalies
// ---------------------------------------------------------------------------

export async function runDetectAnomalies(
  db: Database.Database,
  getAccuracy: () => { total: number; correct: number; rate: number },
  storeAnomaly: (a: Anomaly) => Anomaly
): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];
  logger.info('Running anomaly detection');

  // API cost anomaly
  try {
    // api_call_log.called_at is ISO-8601; use strftime, not space-format datetime('now').
    const costData = db.prepare(`
      SELECT date(called_at) AS day, SUM(estimated_cost_usd) AS daily_cost
      FROM api_call_log WHERE called_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days')
      GROUP BY date(called_at) ORDER BY day ASC
    `).all() as Array<{ day: string; daily_cost: number }>;

    if (costData.length >= 3) {
      const historicCosts = costData.slice(0, -1).map(r => r.daily_cost);
      const todayCost = costData.at(-1)?.daily_cost ?? 0;
      const avg = historicCosts.reduce((a, b) => a + b, 0) / historicCosts.length;
      if (avg > 0) {
        const deviation = ((todayCost - avg) / avg) * 100;
        if (Math.abs(deviation) > 50) {
          anomalies.push(storeAnomaly({
            metric: 'api_daily_cost',
            expected: Math.round(avg * 10000) / 10000,
            actual: Math.round(todayCost * 10000) / 10000,
            deviation: Math.round(deviation * 100) / 100,
            severity: Math.abs(deviation) > 150 ? 'critical' : 'warning',
            description: `Today's API cost ($${todayCost.toFixed(4)}) deviates ${deviation.toFixed(1)}% from 7-day avg ($${avg.toFixed(4)})`,
          }));
        }
      }
    }
  } catch { logger.debug('api_call_log unavailable for cost anomaly check'); }

  // Prediction accuracy anomaly
  const accuracy = getAccuracy();
  if (accuracy.total >= 5 && accuracy.rate < 40) {
    anomalies.push(storeAnomaly({
      metric: 'prediction_accuracy', expected: 60, actual: accuracy.rate,
      deviation: Math.round(((accuracy.rate - 60) / 60) * 100),
      severity: accuracy.rate < 25 ? 'critical' : 'warning',
      description: `Prediction accuracy at ${accuracy.rate}% (${accuracy.correct}/${accuracy.total}) — below 40% threshold`,
    }));
  }

  // Stale pending predictions
  // created_at/expires_at are ISO-8601 with 'T'/'Z' (toISOString / strftime DDL
  // default); datetime('now') returns the space format and mis-compares
  // lexicographically (PR #18 class bug), so both sides must use strftime here.
  const stale = db.prepare(`
    SELECT COUNT(*) AS cnt FROM predictions
    WHERE outcome = 'pending' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days')
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).get() as { cnt: number };
  if (stale.cnt > 10) {
    anomalies.push(storeAnomaly({
      metric: 'stale_pending_predictions', expected: 5, actual: stale.cnt,
      deviation: Math.round(((stale.cnt - 5) / 5) * 100), severity: 'info',
      description: `${stale.cnt} predictions remain pending for >3 days — outcomes not being recorded`,
    }));
  }

  // Low video views
  try {
    // video_performance.published_at is ISO-8601 (YouTube API publishedAt); use strftime.
    const vidData = db.prepare(`
      SELECT AVG(views) AS avg_views, COUNT(*) AS cnt
      FROM video_performance WHERE published_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
    `).get() as { avg_views: number | null; cnt: number };
    if ((vidData.cnt ?? 0) > 0 && (vidData.avg_views ?? 0) < 500) {
      anomalies.push(storeAnomaly({
        metric: 'video_avg_views_30d', expected: 1000,
        actual: Math.round(vidData.avg_views ?? 0),
        deviation: Math.round((((vidData.avg_views ?? 0) - 1000) / 1000) * 100),
        severity: 'warning',
        description: `Average video views over last 30 days: ${Math.round(vidData.avg_views ?? 0)} — below 500 threshold`,
      }));
    }
  } catch { logger.debug('video_performance unavailable for view anomaly check'); }

  logger.info({ count: anomalies.length }, 'Anomaly detection complete');
  return anomalies;
}
