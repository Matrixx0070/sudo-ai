/**
 * meta.auto-optimizer — Closed-Loop Auto-Optimization tool for SUDO-AI.
 *
 * Feeds YouTube performance data back into production decisions so each video
 * is better than the last — with no human glue required.
 *
 * Actions:
 *   learn        — scan video_performance, derive OptimizationRules per dimension
 *   blueprint    — generate an optimised ContentBlueprint for a given topic
 *   decide       — make a single dimension decision given a list of options
 *   rules        — list all active optimization rules
 *   disable-rule — deactivate a rule by ID (override bad learning)
 *   enable-rule  — reactivate a previously disabled rule
 *   history      — recent ContentDecisions (last N, default 20)
 *   improvement  — CTR before vs after optimization was first applied
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { AutoOptimizer } from '../../../optimization/auto-optimizer.js';
import type { ContentDecision, OptimizationRule } from '../../../optimization/auto-optimizer.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta-auto-optimizer');

const DB_PATH = path.resolve('/root/sudo-ai-v4/data/mind.db');

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _optimizer: AutoOptimizer | null = null;

function getOptimizer(): AutoOptimizer {
  if (!_optimizer) {
    _optimizer = new AutoOptimizer(DB_PATH);
  }
  return _optimizer;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatRule(r: OptimizationRule): string {
  const status = r.active ? 'ACTIVE' : 'DISABLED';
  const strength = `${Math.round(r.strength * 100)}%`;
  return (
    `[${r.id}] [${status}] ${r.dimension} — strength: ${strength}\n` +
    `  Rule: ${r.rule}\n` +
    `  Evidence: ${r.evidence}`
  );
}

function formatDecision(d: ContentDecision): string {
  const confidence = `${Math.round(d.confidence * 100)}%`;
  const alts = d.alternatives.length > 0 ? ` (alt: ${d.alternatives.join(', ')})` : '';
  return (
    `[${d.id}] ${d.dimension} → "${d.chosenValue}"${alts}\n` +
    `  Confidence: ${confidence} | Based on ${d.basedOnVideos} video(s)\n` +
    `  Reasoning: ${d.reasoning}\n` +
    `  At: ${d.createdAt}`
  );
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const autoOptimizerTool: ToolDefinition = {
  name: 'meta.auto-optimizer',
  description:
    'Closed-Loop Auto-Optimizer: automatically adjusts next video direction based on what performed. ' +
    'Learns rules from YouTube performance data (hook types, thumbnails, topics, durations, posting times), ' +
    'generates optimised ContentBlueprints, makes dimension-specific decisions, ' +
    'and measures how much CTR has improved since optimization began. ' +
    'Run "learn" after fetching analytics, then "blueprint" before producing each video.',
  category: 'meta',
  timeout: 30_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description:
        'Operation to perform. ' +
        '"learn": scan video_performance and derive/update optimization rules. ' +
        '"blueprint": generate a fully optimized ContentBlueprint for a topic. ' +
        '"decide": make an optimized choice for a single dimension. ' +
        '"rules": list all active optimization rules. ' +
        '"disable-rule": deactivate a rule by ID. ' +
        '"enable-rule": reactivate a rule by ID. ' +
        '"history": list recent ContentDecisions. ' +
        '"improvement": show CTR improvement since optimization started.',
      enum: ['learn', 'blueprint', 'decide', 'rules', 'disable-rule', 'enable-rule', 'history', 'improvement'],
    },
    topic: {
      type: 'string',
      description: 'Video topic (required for blueprint).',
    },
    dimension: {
      type: 'string',
      description:
        'Content dimension to optimize (required for decide). ' +
        'Examples: hook_type, thumbnail_style, topic, duration_bucket, posting_time, music_mood.',
    },
    options: {
      type: 'array',
      description: 'List of candidate values to choose from (required for decide).',
      items: { type: 'string', description: 'A candidate value.' },
    },
    ruleId: {
      type: 'string',
      description: 'Rule ID (required for disable-rule and enable-rule).',
    },
    limit: {
      type: 'number',
      description: 'Number of history records to return (default 20, max 200).',
      default: 20,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(params['action'] ?? '');
    logger.info({ session: ctx.sessionId, action }, 'meta.auto-optimizer invoked');

    try {
      const optimizer = getOptimizer();

      switch (action) {

        // -----------------------------------------------------------------------
        case 'learn': {
          const rules = await optimizer.learnFromHistory();
          if (rules.length === 0) {
            return {
              success: true,
              output:
                'No new rules derived. Ensure video_performance has data with at least ' +
                '3 rows per dimension value. Run meta.youtube-feedback action=fetch-analytics first.',
              data: { rules: [] },
            };
          }
          const lines = rules.map(formatRule);
          logger.info({ ruleCount: rules.length }, 'Learning complete');
          return {
            success: true,
            output: `Derived ${rules.length} optimization rule(s):\n\n${lines.join('\n\n')}`,
            data: { ruleCount: rules.length, rules },
          };
        }

        // -----------------------------------------------------------------------
        case 'blueprint': {
          const topic = String(params['topic'] ?? '').trim();
          if (!topic) {
            return { success: false, output: 'topic is required for blueprint.' };
          }
          const blueprint = await optimizer.generateBlueprint(topic);
          const decisionLines = blueprint.decisions.map(d =>
            `  ${d.dimension}: "${d.chosenValue}" (${Math.round(d.confidence * 100)}% confidence)`,
          );
          const perf = blueprint.expectedPerformance;
          const output =
            `Content Blueprint for: "${topic}"\n` +
            `${'─'.repeat(50)}\n` +
            `Hook type:      ${blueprint.hookType}\n` +
            `Thumbnail:      ${blueprint.thumbnailStyle}\n` +
            `Duration:       ~${blueprint.targetDuration} minutes\n` +
            `Post time:      ${blueprint.postingTime}\n` +
            `Music mood:     ${blueprint.musicMood}\n` +
            `\nDecision breakdown:\n${decisionLines.join('\n')}\n` +
            `\nExpected performance:\n` +
            `  Views:     ~${perf.views.toLocaleString()}\n` +
            `  CTR:       ${(perf.ctr * 100).toFixed(2)}%\n` +
            `  Retention: ${(perf.retention * 100).toFixed(1)}%`;
          logger.info({ topic }, 'Blueprint generated');
          return { success: true, output, data: blueprint };
        }

        // -----------------------------------------------------------------------
        case 'decide': {
          const dimension = String(params['dimension'] ?? '').trim();
          if (!dimension) {
            return { success: false, output: 'dimension is required for decide.' };
          }
          const rawOptions = params['options'];
          if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
            return { success: false, output: 'options must be a non-empty array for decide.' };
          }
          const options = rawOptions.map(String);
          const decision = await optimizer.decide(dimension, options);
          return {
            success: true,
            output: `Decision for "${dimension}":\n${formatDecision(decision)}`,
            data: decision,
          };
        }

        // -----------------------------------------------------------------------
        case 'rules': {
          const rules = optimizer.getActiveRules();
          if (rules.length === 0) {
            return {
              success: true,
              output: 'No active optimization rules. Run action=learn to derive rules from performance data.',
              data: { rules: [] },
            };
          }
          const lines = rules.map(formatRule);
          return {
            success: true,
            output: `${rules.length} active rule(s):\n\n${lines.join('\n\n')}`,
            data: { ruleCount: rules.length, rules },
          };
        }

        // -----------------------------------------------------------------------
        case 'disable-rule': {
          const ruleId = String(params['ruleId'] ?? '').trim();
          if (!ruleId) return { success: false, output: 'ruleId is required for disable-rule.' };
          optimizer.disableRule(ruleId);
          return { success: true, output: `Rule disabled: ${ruleId}`, data: { ruleId } };
        }

        // -----------------------------------------------------------------------
        case 'enable-rule': {
          const ruleId = String(params['ruleId'] ?? '').trim();
          if (!ruleId) return { success: false, output: 'ruleId is required for enable-rule.' };
          optimizer.enableRule(ruleId);
          return { success: true, output: `Rule enabled: ${ruleId}`, data: { ruleId } };
        }

        // -----------------------------------------------------------------------
        case 'history': {
          const rawLimit = params['limit'];
          const limit = typeof rawLimit === 'number'
            ? Math.min(200, Math.max(1, Math.floor(rawLimit)))
            : 20;
          const decisions = optimizer.getHistory(limit);
          if (decisions.length === 0) {
            return {
              success: true,
              output: 'No decisions recorded yet. Run action=blueprint or action=decide first.',
              data: { decisions: [] },
            };
          }
          const lines = decisions.map(formatDecision);
          return {
            success: true,
            output: `Last ${decisions.length} decision(s):\n\n${lines.join('\n\n')}`,
            data: { count: decisions.length, decisions },
          };
        }

        // -----------------------------------------------------------------------
        case 'improvement': {
          const metrics = optimizer.getImprovementMetrics();
          const sign = metrics.improvementPercent >= 0 ? '+' : '';
          const output =
            `Optimization Impact Report\n` +
            `${'─'.repeat(40)}\n` +
            `Before optimization: CTR ${(metrics.beforeOptimization * 100).toFixed(3)}%\n` +
            `After optimization:  CTR ${(metrics.afterOptimization * 100).toFixed(3)}%\n` +
            `Improvement:         ${sign}${metrics.improvementPercent}%\n` +
            (metrics.beforeOptimization === 0
              ? '\nNote: no pre-optimization data yet (run learn + blueprint first).'
              : '');
          logger.info({ improvementPercent: metrics.improvementPercent }, 'Improvement report generated');
          return { success: true, output, data: metrics };
        }

        // -----------------------------------------------------------------------
        default:
          return {
            success: false,
            output: `Unknown action: "${action}". Valid: learn, blueprint, decide, rules, disable-rule, enable-rule, history, improvement.`,
          };
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg, session: ctx.sessionId }, 'meta.auto-optimizer error');
      return { success: false, output: `Auto-optimizer error: ${msg}` };
    }
  },
};
