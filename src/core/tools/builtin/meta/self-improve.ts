/**
 * meta.self-improve — SUDO-AI's autonomous self-improvement tool.
 *
 * Actions:
 *   run      — Full improvement cycle: detect patterns → analyse → apply → log
 *   status   — Show last 5 improvement runs and current health score
 *   patterns — Show detected patterns without applying anything
 *   history  — Full history of all improvement runs
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { runSelfImprovement, detectPatterns } from '../../../self-improvement/index.js';

const logger = createLogger('meta.self-improve');
const DB_PATH = path.resolve('data', 'mind.db');

export const selfImproveTool: ToolDefinition = {
  name: 'meta.self-improve',
  description:
    'Autonomously improve SUDO-AI by analysing feedback ratings, tool failure patterns, ' +
    'conversation gaps, and cron health. Generates behavioural rules saved to LEARNINGS.md ' +
    'which are injected into every system prompt. Run weekly or after bad feedback spikes. ' +
    'Actions: run (full cycle), status (last runs), patterns (show without applying), history.',
  category: 'meta' as const,
  timeout: 120_000,
  parameters: {
    action: {
      type: 'string',
      description: 'What to do: run | status | patterns | history',
      enum: ['run', 'status', 'patterns', 'history'],
      default: 'run',
    },
    window_days: {
      type: 'number',
      description: 'Days of history to analyse (default: 14)',
      default: 14,
    },
    trigger: {
      type: 'string',
      description: 'What triggered this run (for logging): manual | weekly-cron | bad-feedback | tool-failure',
      default: 'manual',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action     = (params['action'] as string | undefined) ?? 'run';
    const windowDays = Math.min(Number(params['window_days'] ?? 14), 90);
    const trigger    = (params['trigger'] as string | undefined) ?? 'manual';

    logger.info({ session: ctx.sessionId, action, windowDays, trigger }, 'meta.self-improve invoked');

    // ---- PATTERNS (read-only) ----
    if (action === 'patterns') {
      try {
        const p = detectPatterns(windowDays);
        const lines = [
          `📊 **Detected Patterns — last ${windowDays} days**`,
          ``,
          `Health Score: ${p.healthScore}/100`,
          ``,
          p.failingTools.length > 0
            ? `**Failing tools (≥20% fail rate):**\n${p.failingTools.map(t =>
                `  - ${t.name}: ${Math.round(t.failRate*100)}% fail (${t.failures}/${t.calls})`
              ).join('\n')}`
            : `**Tools:** All healthy ✅`,
          ``,
          p.badFeedbackTypes.length > 0
            ? `**Bad feedback patterns:**\n${p.badFeedbackTypes.map(f =>
                `  - ${f.taskType}: ${Math.round(f.badRate*100)}% bad rate`
              ).join('\n')}`
            : `**Feedback:** All positive ✅`,
          ``,
          p.unusedTools.length > 0
            ? `**Underutilised tools:** ${p.unusedTools.join(', ')}`
            : `**Tool coverage:** Good`,
          ``,
          p.routingGaps.length > 0
            ? `**Routing gaps (repeated queries):**\n${p.routingGaps.map(g =>
                `  - "${g.sample}" (${g.frequency}x)`
              ).join('\n')}`
            : `**Routing:** No gaps detected`,
          ``,
          p.cronIssues.length > 0
            ? `**Cron issues:**\n${p.cronIssues.map(c =>
                `  - ${c.jobName}: ${c.failures}/${c.runs} failed`
              ).join('\n')}`
            : `**Cron:** All jobs healthy ✅`,
        ];

        return {
          success: true,
          output: lines.filter(Boolean).join('\n'),
          data: p,
        };
      } catch (err) {
        return { success: false, output: `Pattern detection failed: ${String(err)}` };
      }
    }

    // ---- STATUS ----
    if (action === 'status') {
      const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
      try {
        const tableExists = db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='self_improvements'`
        ).get();

        if (!tableExists) {
          return { success: true, output: 'No improvement runs yet. Use action:"run" to start.' };
        }

        const runs = db.prepare(`
          SELECT run_at, trigger, health_score, status,
                 json_array_length(actions_json) as action_count
          FROM self_improvements
          ORDER BY run_at DESC
          LIMIT 5
        `).all() as { run_at: string; trigger: string; health_score: number; status: string; action_count: number }[];

        if (runs.length === 0) {
          return { success: true, output: 'No improvement runs yet. Use action:"run" to start.' };
        }

        const lines = runs.map(r =>
          `  ${r.run_at.slice(0,16)} | score:${r.health_score}/100 | trigger:${r.trigger} | ${r.action_count} actions | ${r.status}`
        );

        // Current patterns
        const current = detectPatterns(windowDays);

        return {
          success: true,
          output: [
            `🔄 **Self-Improvement Status**`,
            ``,
            `Current health score: ${current.healthScore}/100`,
            `Failing tools: ${current.failingTools.length}`,
            `Bad feedback types: ${current.badFeedbackTypes.length}`,
            ``,
            `**Recent runs (last 5):**`,
            ...lines,
          ].join('\n'),
        };
      } finally {
        db.close();
      }
    }

    // ---- HISTORY ----
    if (action === 'history') {
      const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
      try {
        const tableExists = db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='self_improvements'`
        ).get();

        if (!tableExists) {
          return { success: true, output: 'No history yet.' };
        }

        const runs = db.prepare(`
          SELECT run_at, trigger, health_score, learnings_patch, actions_json
          FROM self_improvements
          ORDER BY run_at DESC
          LIMIT 10
        `).all() as { run_at: string; trigger: string; health_score: number; learnings_patch: string | null; actions_json: string }[];

        const lines = runs.map(r => {
          const actions = JSON.parse(r.actions_json ?? '[]') as { type: string; description: string; applied: boolean }[];
          const applied = actions.filter(a => a.applied).map(a => `    ✅ ${a.description}`).join('\n');
          const pending = actions.filter(a => !a.applied).map(a => `    📝 ${a.description}`).join('\n');
          return [
            `### ${r.run_at.slice(0,16)} — score:${r.health_score}/100 (${r.trigger})`,
            applied || '    (no applied actions)',
            pending,
          ].join('\n');
        });

        return {
          success: true,
          output: [`**Self-Improvement History (last 10 runs)**`, '', ...lines].join('\n'),
        };
      } finally {
        db.close();
      }
    }

    // ---- RUN (full cycle) ----
    try {
      // No direct brain reference needed — pattern detector works standalone
      const brainInterface = undefined;

      const result = await runSelfImprovement({
        trigger,
        windowDays,
        brain: brainInterface,
      });

      return {
        success: true,
        output: result.summary,
        data: {
          healthScore: result.healthScore,
          actionsApplied: result.actions.filter(a => a.applied).length,
          actionsTotal: result.actions.length,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Self-improvement run failed');
      return { success: false, output: `Self-improvement failed: ${msg}` };
    }
  },
};
