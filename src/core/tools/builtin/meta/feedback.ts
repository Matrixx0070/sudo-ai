/**
 * meta.feedback — Query and display the owner's task feedback ratings.
 *
 * Actions:
 *   stats    — Summary: total rated, good%, bad tasks by type
 *   recent   — Last 10 feedback entries
 *   bad      — All bad-rated tasks in the last 30 days
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta.feedback');
const DB_PATH = path.resolve('data', 'mind.db');

function getDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

export const feedbackTool: ToolDefinition = {
  name: 'meta.feedback',
  description:
    'Query the owner\'s task feedback ratings (👍/👎). Use to understand what the owner likes/dislikes, ' +
    'identify patterns in bad ratings, and improve future task execution. ' +
    'Actions: stats (overall summary), recent (last 10 ratings), bad (all bad-rated tasks).',
  category: 'meta' as const,
  timeout: 10_000,
  parameters: {
    action: {
      type: 'string',
      description: 'What to retrieve: stats | recent | bad',
      enum: ['stats', 'recent', 'bad'],
      default: 'stats',
    },
    days: {
      type: 'number',
      description: 'How many days back to look (default: 30)',
      default: 30,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = (params['action'] as string | undefined) ?? 'stats';
    const days   = Math.min(Number(params['days'] ?? 30), 365);
    const since  = new Date(Date.now() - days * 86_400_000).toISOString();

    logger.info({ session: ctx.sessionId, action, days }, 'meta.feedback invoked');

    let db: Database.Database | undefined;
    try {
      db = getDb();

      // Ensure table exists (read-only so just check)
      const tableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'`
      ).get();

      if (!tableExists) {
        return { success: true, output: 'No feedback data yet — the owner has not rated any tasks.' };
      }

      if (action === 'stats') {
        const rows = db.prepare(
          `SELECT rating, task_type FROM feedback WHERE created_at >= ?`
        ).all(since) as { rating: string; task_type: string }[];

        if (rows.length === 0) {
          return { success: true, output: `No feedback in the last ${days} days.` };
        }

        let good = 0, bad = 0, skip = 0;
        const byType: Record<string, { good: number; bad: number }> = {};

        for (const r of rows) {
          if (r.rating === 'good') good++;
          else if (r.rating === 'bad') bad++;
          else skip++;

          if (!byType[r.task_type]) byType[r.task_type] = { good: 0, bad: 0 };
          if (r.rating === 'good') byType[r.task_type]!.good++;
          if (r.rating === 'bad')  byType[r.task_type]!.bad++;
        }

        const rated  = good + bad;
        const goodPct = rated > 0 ? Math.round((good / rated) * 100) : 100;

        const typeLines = Object.entries(byType)
          .sort(([, a], [, b]) => b.bad - a.bad)
          .map(([type, counts]) => {
            const r = counts.good + counts.bad;
            const pct = r > 0 ? Math.round((counts.good / r) * 100) : 100;
            return `  ${type.padEnd(14)} ${pct}% good  (${counts.good}👍 ${counts.bad}👎)`;
          });

        const output = [
          `📊 Feedback Stats — last ${days} days`,
          ``,
          `  Total rated : ${rated} tasks  (${skip} skipped)`,
          `  Good rate   : ${goodPct}%  (${good}👍 ${bad}👎)`,
          ``,
          `By task type:`,
          ...typeLines,
          ``,
          good + bad < 5 ? `ℹ️  Rate is low — the owner should use 👍/👎 more to help SUDO learn.` : '',
        ].filter(l => l !== undefined).join('\n');

        return { success: true, output, data: { good, bad, skip, goodPct, byType } };
      }

      if (action === 'recent') {
        const rows = db.prepare(`
          SELECT rating, task_type, task_summary, notes, created_at
          FROM feedback
          WHERE created_at >= ?
          ORDER BY created_at DESC
          LIMIT 10
        `).all(since) as { rating: string; task_type: string; task_summary: string; notes: string | null; created_at: string }[];

        if (rows.length === 0) {
          return { success: true, output: `No feedback in the last ${days} days.` };
        }

        const lines = rows.map((r) => {
          const icon = r.rating === 'good' ? '👍' : r.rating === 'bad' ? '👎' : '⏭️';
          const date = r.created_at.slice(0, 10);
          const notes = r.notes ? ` — "${r.notes.slice(0, 60)}"` : '';
          return `${icon} [${r.task_type}] ${r.task_summary.slice(0, 70)}${notes} (${date})`;
        });

        return { success: true, output: `Recent feedback:\n${lines.join('\n')}`, data: { rows } };
      }

      if (action === 'bad') {
        const rows = db.prepare(`
          SELECT task_type, task_summary, notes, created_at
          FROM feedback
          WHERE rating = 'bad' AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT 20
        `).all(since) as { task_type: string; task_summary: string; notes: string | null; created_at: string }[];

        if (rows.length === 0) {
          return { success: true, output: `No bad-rated tasks in the last ${days} days. 🎉` };
        }

        const lines = rows.map((r) => {
          const date  = r.created_at.slice(0, 10);
          const notes = r.notes ? `\n     Notes: "${r.notes.slice(0, 100)}"` : '';
          return `👎 [${r.task_type}] ${r.task_summary.slice(0, 100)}${notes} (${date})`;
        });

        return {
          success: true,
          output: `Bad-rated tasks (last ${days} days) — ${rows.length} total:\n\n${lines.join('\n\n')}`,
          data: { rows },
        };
      }

      return { success: false, output: `Unknown action: ${action}` };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'meta.feedback error');
      return { success: false, output: `Feedback query error: ${msg}` };
    } finally {
      db?.close();
    }
  },
};
