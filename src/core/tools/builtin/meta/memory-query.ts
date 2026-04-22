/**
 * @file memory-query.ts
 * @description meta.memory-query — lets the SUDO-AI brain search its own memory.
 *
 * Wraps UnifiedMemory to provide four actions:
 *   search   — keyword search across all stores
 *   recent   — most recent items from all stores
 *   summary  — row counts across all stores
 *   sessions — recent session history with message counts
 *
 * The tool is stateless: it opens DB connections per-call via UnifiedMemory
 * (which uses readonly connections) so no cleanup is needed.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { UnifiedMemory } from '../../../memory/unified.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('meta:memory-query');

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const memoryQueryTool: ToolDefinition = {
  name:        'meta.memory-query',
  description: 'Search across all SUDO-AI memory stores (mind.db, consciousness.db, knowledge.db, workspace files). Actions: search (keyword lookup), recent (latest items), summary (row counts), sessions (session history).',
  category:    'meta',
  timeout:     30_000,
  requiresConfirmation: false,

  parameters: {
    action: {
      type:        'string',
      required:    true,
      description: 'Action to perform: search | recent | summary | sessions',
      enum:        ['search', 'recent', 'summary', 'sessions'],
    },
    query: {
      type:        'string',
      description: 'Search query string (required for action=search)',
    },
    sources: {
      type:        'array',
      description: 'Filter to specific stores: mind, consciousness, knowledge, workspace, tasks (empty = all)',
      items:       { type: 'string', description: 'Store name' },
    },
    limit: {
      type:        'number',
      description: 'Maximum results to return (default: 20)',
      default:     20,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action  = params['action'] as string | undefined;
    const query   = params['query']  as string | undefined;
    const sources = params['sources'] as string[] | undefined;
    const limit   = Math.min(100, Math.max(1, (params['limit'] as number | undefined) ?? 20));

    log.info({ session: ctx.sessionId, action, query, limit }, 'meta.memory-query invoked');

    if (!action) {
      return { success: false, output: 'action is required. Valid values: search | recent | summary | sessions' };
    }

    const mem = new UnifiedMemory();

    try {
      switch (action) {
        // ---- search --------------------------------------------------------
        case 'search': {
          if (!query?.trim()) {
            return { success: false, output: 'query is required for action=search' };
          }
          const results = mem.search({ query, sources, limit });
          if (results.length === 0) {
            return { success: true, output: `No results found for: "${query}"`, data: { results: [] } };
          }
          const lines = results.map((r, i) =>
            `[${i + 1}] [${r.source}/${r.table ?? '?'}] (score ${r.relevance.toFixed(2)}) ${r.content.slice(0, 200).replace(/\n/g, ' ')}`,
          );
          return {
            success: true,
            output:  `Found ${results.length} result(s) for "${query}":\n\n${lines.join('\n\n')}`,
            data:    { query, count: results.length, results },
          };
        }

        // ---- recent --------------------------------------------------------
        case 'recent': {
          const results = mem.getRecent(limit);
          if (results.length === 0) {
            return { success: true, output: 'No recent memory items found.', data: { results: [] } };
          }
          const lines = results.map((r, i) =>
            `[${i + 1}] [${r.source}] ${r.timestamp?.slice(0, 19) ?? 'unknown'} — ${r.content.slice(0, 150).replace(/\n/g, ' ')}`,
          );
          return {
            success: true,
            output:  `${results.length} most recent memory item(s):\n\n${lines.join('\n')}`,
            data:    { count: results.length, results },
          };
        }

        // ---- summary -------------------------------------------------------
        case 'summary': {
          const summary = mem.summarize();
          const output = [
            'Memory store summary:',
            `  Sessions:        ${summary.sessions}`,
            `  Messages:        ${summary.messages}`,
            `  Thoughts:        ${summary.thoughts}`,
            `  Concepts:        ${summary.concepts}`,
            `  Episodes:        ${summary.episodes}`,
            `  Skills:          ${summary.skills}`,
            `  Error records:   ${summary.errors}`,
            `  Workspace files: ${summary.workspaceFiles}`,
          ].join('\n');
          return { success: true, output, data: { summary } };
        }

        // ---- sessions ------------------------------------------------------
        case 'sessions': {
          const sessions = mem.getSessionHistory(limit);
          if (sessions.length === 0) {
            return { success: true, output: 'No sessions found.', data: { sessions: [] } };
          }
          const lines = sessions.map((s, i) =>
            `[${i + 1}] ${s.created_at?.slice(0, 19) ?? 'unknown'} | ${s.model} | msgs: ${s.message_count} | ${s.title ?? s.id}`,
          );
          return {
            success: true,
            output:  `${sessions.length} recent session(s):\n\n${lines.join('\n')}`,
            data:    { count: sessions.length, sessions },
          };
        }

        default:
          return { success: false, output: `Unknown action: "${action}". Valid: search | recent | summary | sessions` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ action, err: msg }, 'meta.memory-query execution error');
      return { success: false, output: `memory-query error: ${msg}` };
    }
  },
};
