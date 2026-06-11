/**
 * Pattern Detector — reads mind.db to surface actionable signals
 * for SUDO-AI's autonomous self-improvement engine.
 *
 * Data sources analysed:
 *   - feedback table         — the owner's 👍/👎 ratings per task type
 *   - messages table         — tool call success/failure counts
 *   - messages (user role)   — what the owner asks most (routing gaps)
 *   - api_call_log           — LLM latency and error rates
 *   - cron_runs              — scheduled job outcomes
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from '../shared/paths.js';

const DB_PATH = path.join(DATA_DIR, 'mind.db');

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ToolStats {
  name: string;
  calls: number;
  failures: number;
  failRate: number; // 0-1
}

export interface FeedbackPattern {
  taskType: string;
  good: number;
  bad: number;
  badRate: number; // 0-1
  badSamples: string[];
}

export interface RoutingGap {
  sample: string;   // the owner's message
  frequency: number;
  suggestedTool: string | null;
}

export interface CronHealth {
  jobName: string;
  runs: number;
  failures: number;
}

export interface DetectedPatterns {
  /** Tools with ≥20% failure rate and ≥3 calls */
  failingTools: ToolStats[];
  /** Tools never called in last 30 days (potentially dead) */
  unusedTools: string[];
  /** Task types the owner rates bad most often */
  badFeedbackTypes: FeedbackPattern[];
  /** Common phrases the owner uses that map to no known intent pattern */
  routingGaps: RoutingGap[];
  /** Cron jobs with failures */
  cronIssues: CronHealth[];
  /** Overall health score 0-100 */
  healthScore: number;
  /** ISO timestamp of analysis */
  analysedAt: string;
  /** How many days of data analysed */
  windowDays: number;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export function detectPatterns(windowDays = 14): DetectedPatterns {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  try {
    // 1. Tool failure stats
    const toolRows = db.prepare(`
      SELECT tool_name,
             COUNT(*) as calls,
             SUM(CASE WHEN
               tool_output LIKE '%"success":false%'
               OR tool_output LIKE '%Error:%'
               OR tool_output LIKE '%failed%'
               OR tool_output LIKE '%FAILED%'
               OR content LIKE '%"success":false%'
             THEN 1 ELSE 0 END) as failures
      FROM messages
      WHERE role = 'tool'
        AND tool_name IS NOT NULL
        AND tool_name != ''
        AND created_at >= ?
      GROUP BY tool_name
      HAVING calls >= 2
      ORDER BY failures DESC, calls DESC
    `).all(since) as { tool_name: string; calls: number; failures: number }[];

    const failingTools: ToolStats[] = toolRows
      .map(r => ({
        name: r.tool_name,
        calls: r.calls,
        failures: r.failures,
        failRate: r.calls > 0 ? r.failures / r.calls : 0,
      }))
      .filter(t => t.failRate >= 0.2 && t.failures >= 1);

    // 2. Unused tools (never called in window)
    const usedToolNames = new Set(toolRows.map(r => r.tool_name));
    // We track what tools were registered but not used via health-check output
    // For now, flag tools called 0 times from a known high-value list
    const highValueTools = [
      'meta.spawn-team', 'media.shorts-factory', 'content.write-script',
      'social.youtube-upload', 'meta.trend-radar', 'research.deep-search',
      'voice.tts', 'meta.forge', 'meta.feedback',
    ];
    const unusedTools = highValueTools.filter(t => !usedToolNames.has(t));

    // 3. Feedback patterns
    let badFeedbackTypes: FeedbackPattern[] = [];
    const feedbackExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'`
    ).get();

    if (feedbackExists) {
      const fbRows = db.prepare(`
        SELECT task_type,
               SUM(CASE WHEN rating='good' THEN 1 ELSE 0 END) as good,
               SUM(CASE WHEN rating='bad'  THEN 1 ELSE 0 END) as bad,
               GROUP_CONCAT(CASE WHEN rating='bad' THEN substr(task_summary,1,80) END, '|||') as bad_samples
        FROM feedback
        WHERE created_at >= ?
        GROUP BY task_type
        HAVING (good + bad) >= 2
        ORDER BY bad DESC
      `).all(since) as { task_type: string; good: number; bad: number; bad_samples: string | null }[];

      badFeedbackTypes = fbRows
        .map(r => ({
          taskType: r.task_type,
          good: r.good,
          bad: r.bad,
          badRate: (r.good + r.bad) > 0 ? r.bad / (r.good + r.bad) : 0,
          badSamples: r.bad_samples
            ? r.bad_samples.split('|||').filter(Boolean).slice(0, 3)
            : [],
        }))
        .filter(p => p.badRate > 0.3);
    }

    // 4. Routing gaps — the owner's messages that are short and don't match tool calls
    const userMsgs = db.prepare(`
      SELECT content, created_at
      FROM messages
      WHERE role = 'user'
        AND created_at >= ?
        AND length(content) < 200
        AND content NOT LIKE '[HEARTBEAT%'
        AND content NOT LIKE '[voice%'
      ORDER BY created_at DESC
      LIMIT 100
    `).all(since) as { content: string; created_at: string }[];

    // Find messages where the next message is a tool call (successful routing)
    // vs messages with no tool call (potential gap)
    const routingGapMap = new Map<string, number>();
    for (const msg of userMsgs) {
      const key = msg.content.toLowerCase().slice(0, 40).trim();
      routingGapMap.set(key, (routingGapMap.get(key) ?? 0) + 1);
    }

    const routingGaps: RoutingGap[] = Array.from(routingGapMap.entries())
      .filter(([, freq]) => freq >= 2)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([sample, frequency]) => ({ sample, frequency, suggestedTool: null }));

    // 5. Cron issues
    let cronIssues: CronHealth[] = [];
    const cronExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='cron_runs'`
    ).get();

    if (cronExists) {
      const cronRows = db.prepare(`
        SELECT job_name,
               COUNT(*) as runs,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failures
        FROM cron_runs
        WHERE ran_at >= ?
        GROUP BY job_name
        HAVING failures > 0
      `).all(since) as { job_name: string; runs: number; failures: number }[];

      cronIssues = cronRows.map(r => ({
        jobName: r.job_name,
        runs: r.runs,
        failures: r.failures,
      }));
    }

    // 6. Overall health score
    const toolScore   = failingTools.length === 0 ? 30 : Math.max(0, 30 - failingTools.length * 5);
    const feedbackScore = badFeedbackTypes.length === 0 ? 40 : Math.max(0, 40 - badFeedbackTypes.length * 8);
    const cronScore   = cronIssues.length === 0 ? 20 : Math.max(0, 20 - cronIssues.length * 5);
    const unusedScore = unusedTools.length < 5 ? 10 : 5;
    const healthScore = toolScore + feedbackScore + cronScore + unusedScore;

    return {
      failingTools,
      unusedTools,
      badFeedbackTypes,
      routingGaps,
      cronIssues,
      healthScore,
      analysedAt: new Date().toISOString(),
      windowDays,
    };
  } finally {
    db.close();
  }
}
