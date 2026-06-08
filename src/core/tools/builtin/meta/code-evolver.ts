/**
 * meta.code-evolver — SUDO-AI self-evolving codebase tool.
 *
 * Exposes the CodeEvolver class to the agent loop so SUDO-AI can analyze,
 * refactor, and improve its own code on demand.
 *
 * Actions:
 *   analyze     — Scan all .ts files, return per-file analysis (lines, complexity, issues)
 *   issues      — Return a flat list of all detected code issues across the codebase
 *   propose     — Generate and persist evolution proposals based on detected issues
 *   discover    — Log and retrieve capability discovery records for tool combinations
 *   stats       — Return aggregate codebase stats (file count, total lines, largest files)
 *   performance — Track or retrieve a named numeric performance metric timeseries
 */

import path from 'node:path';
import { CodeEvolver } from '../../../evolution/code-evolver.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { PROJECT_ROOT, MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-code-evolver');

const ROOT_DIR = PROJECT_ROOT;
const DB_PATH  = MIND_DB;

// ---------------------------------------------------------------------------
// Lazy singleton — one DB connection per process
// ---------------------------------------------------------------------------

let _evolver: CodeEvolver | null = null;

function getEvolver(): CodeEvolver {
  if (!_evolver) {
    _evolver = new CodeEvolver(ROOT_DIR, DB_PATH);
  }
  return _evolver;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function severityIcon(s: 'low' | 'medium' | 'high'): string {
  return s === 'high' ? '[HIGH]' : s === 'medium' ? '[MED]' : '[LOW]';
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const codeEvolverTool: ToolDefinition = {
  name: 'meta.code-evolver',
  description:
    'Self-evolving codebase: SUDO-AI analyzes its own TypeScript source, detects code smells, generates refactoring proposals, tracks performance metrics, and discovers novel tool combinations. ' +
    'Actions: analyze | issues | propose | discover | stats | performance.',
  category: 'meta',
  timeout: 120_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['analyze', 'issues', 'propose', 'discover', 'stats', 'performance'],
    },
    metric: {
      type: 'string',
      description: 'Metric name (required for performance action with sub-action=track or history).',
    },
    metricValue: {
      type: 'number',
      description: 'Numeric value to record (required for performance sub-action=track).',
    },
    subAction: {
      type: 'string',
      description: 'For performance action: "track" to record a value, "history" to retrieve past values.',
      enum: ['track', 'history'],
    },
    severityFilter: {
      type: 'string',
      description: 'Filter issues by severity (optional, for issues action).',
      enum: ['low', 'medium', 'high'],
    },
    limit: {
      type: 'number',
      description: 'Max number of results to return (default: 50).',
      default: 50,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string | undefined;
    logger.info({ session: ctx.sessionId, action }, 'meta.code-evolver invoked');

    if (!action?.trim()) {
      return { success: false, output: 'action is required.' };
    }

    try {
      const evolver = getEvolver();
      const limit = Math.min(500, Math.max(1, (params['limit'] as number | undefined) ?? 50));

      switch (action) {

        // -------------------------------------------------------------------
        case 'analyze': {
          const analyses = await evolver.analyzeCodebase();
          const shown = analyses.slice(0, limit);
          const lines = shown.map(a =>
            `${a.file} — ${a.lines} lines, complexity ${a.complexity}, ${a.issues.length} issue(s)`,
          );
          const summary = `Analyzed ${analyses.length} file(s). Showing ${shown.length}:\n\n${lines.join('\n')}`;
          logger.info({ fileCount: analyses.length }, 'analyze complete');
          return { success: true, output: summary, data: shown };
        }

        // -------------------------------------------------------------------
        case 'issues': {
          const allIssues = await evolver.findIssues();
          const severityFilter = params['severityFilter'] as string | undefined;
          const filtered = severityFilter
            ? allIssues.filter(i => i.severity === severityFilter)
            : allIssues;
          const shown = filtered.slice(0, limit);
          const lines = shown.map(i =>
            `${severityIcon(i.severity)} [${i.type}] ${i.file}${i.line ? `:${i.line}` : ''} — ${i.description}`,
          );
          const summary = `Found ${allIssues.length} total issue(s)${severityFilter ? ` (filter: ${severityFilter})` : ''}. Showing ${shown.length}:\n\n${lines.join('\n')}`;
          logger.info({ total: allIssues.length, shown: shown.length }, 'issues complete');
          return { success: true, output: summary, data: shown };
        }

        // -------------------------------------------------------------------
        case 'propose': {
          const proposals = await evolver.proposeEvolution();
          const shown = proposals.slice(0, limit);
          const lines = shown.map(p =>
            `[${p.status.toUpperCase()}] "${p.title}"\n  Impact: ${p.impact}  Effort: ${p.effort}  Files: ${p.files.length}\n  ${p.description}`,
          );
          const summary = `${proposals.length} evolution proposal(s). Showing ${shown.length}:\n\n${lines.join('\n\n')}`;
          logger.info({ count: proposals.length }, 'propose complete');
          return { success: true, output: summary, data: shown };
        }

        // -------------------------------------------------------------------
        case 'discover': {
          const discoveries = await evolver.discoverCapabilities();
          const shown = discoveries.slice(0, limit);
          const lines = shown.map(d =>
            `[${d.useful ? 'USEFUL' : 'logged'}] Tools: ${d.tools.slice(0, 3).join(', ')}${d.tools.length > 3 ? '...' : ''}\n  ${d.result}\n  Discovered: ${d.discoveredAt}`,
          );
          const summary = `${discoveries.length} capability discovery record(s). Showing ${shown.length}:\n\n${lines.join('\n\n')}`;
          logger.info({ count: discoveries.length }, 'discover complete');
          return { success: true, output: summary, data: shown };
        }

        // -------------------------------------------------------------------
        case 'stats': {
          const stats = await evolver.getStats();
          const topFiles = stats.largestFiles.slice(0, 5)
            .map(f => `  ${f.file} (${f.lines} lines)`)
            .join('\n');
          const summary =
            `Codebase stats:\n` +
            `  Total files   : ${stats.totalFiles}\n` +
            `  Total lines   : ${stats.totalLines}\n` +
            `  Avg file size : ${stats.avgFileSize} lines\n` +
            `  Modules       : ${stats.moduleCount}\n` +
            `  Total issues  : ${stats.issueCount}\n` +
            `\nLargest files:\n${topFiles}`;
          logger.info(stats, 'stats complete');
          return { success: true, output: summary, data: stats };
        }

        // -------------------------------------------------------------------
        case 'performance': {
          const subAction = params['subAction'] as string | undefined;
          const metric = (params['metric'] as string | undefined)?.trim();

          if (!subAction) {
            return { success: false, output: 'subAction is required for performance action. Use "track" or "history".' };
          }
          if (!metric) {
            return { success: false, output: 'metric name is required for performance action.' };
          }

          if (subAction === 'track') {
            const metricValue = params['metricValue'] as number | undefined;
            if (metricValue === undefined || !Number.isFinite(metricValue)) {
              return { success: false, output: 'metricValue must be a finite number for performance track.' };
            }
            await evolver.trackPerformance(metric, metricValue);
            logger.info({ metric, metricValue }, 'performance track complete');
            return { success: true, output: `Recorded metric "${metric}" = ${metricValue}`, data: { metric, value: metricValue } };
          }

          if (subAction === 'history') {
            const history = await evolver.getPerformanceHistory(metric);
            const shown = history.slice(0, limit);
            const lines = shown.map(h => `  ${h.timestamp} → ${h.value}`);
            const summary = `Performance history for "${metric}" (${history.length} records, showing ${shown.length}):\n${lines.join('\n')}`;
            logger.info({ metric, count: history.length }, 'performance history complete');
            return { success: true, output: summary, data: shown };
          }

          return { success: false, output: `Unknown subAction: ${subAction}. Use "track" or "history".` };
        }

        // -------------------------------------------------------------------
        default:
          return { success: false, output: `Unknown action: ${action}. Valid: analyze | issues | propose | discover | stats | performance.` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.code-evolver error');
      return { success: false, output: `code-evolver error: ${msg}` };
    }
  },
};
