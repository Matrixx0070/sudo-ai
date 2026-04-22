/**
 * meta.memory.search — Full-text / semantic search across the agent's memory engine.
 *
 * Delegates to the injected memoryEngine dependency. Returns a graceful
 * not-initialised message when the engine has not been injected.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { getMemoryEngine } from './index.js';

const logger = createLogger('meta.memory.search');

// ---------------------------------------------------------------------------
// MemoryEngine interface (duck-typed)
// ---------------------------------------------------------------------------

interface MemorySearchResult {
  key: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

interface MemoryEngineLike {
  // The engine may return a raw string (e.g. RAGEngine.retrieveContext),
  // a bare array, an object with a .rows array, or null/undefined.
  // The execute() handler normalises all of these before calling .map().
  search(query: string, limit: number): Promise<MemorySearchResult[] | MemorySearchResult | string | null | undefined | { rows: MemorySearchResult[] }>;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const memorySearchTool: ToolDefinition = {
  name: 'memory.search',
  description:
    'Search the agent memory engine using a natural-language query. ' +
    'Returns ranked results with matching content snippets. ' +
    'Use to recall past conversations, stored facts, decisions, or notes.',
  category: 'meta',
  timeout: 30_000,
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'Natural-language search query describing what to find in memory.',
    },
    limit: {
      type: 'number',
      required: false,
      default: 10,
      description: 'Maximum number of results to return (default: 10, max: 100).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = params['query'] as string | undefined;
    const rawLimit = params['limit'] as number | undefined;
    const limit = Math.min(100, Math.max(1, rawLimit ?? 10));

    logger.info({ session: ctx.sessionId, query, limit }, 'memory.search invoked');

    if (!query?.trim()) {
      return { success: false, output: 'memory.search: "query" parameter is required and must be non-empty.' };
    }

    const memoryEngine = getMemoryEngine() as MemoryEngineLike | null;
    if (!memoryEngine) {
      logger.warn({ session: ctx.sessionId }, 'memory.search: memoryEngine not initialised');
      return {
        success: false,
        output: 'memory.search: memory engine has not been initialised. Call injectMetaToolDeps() with a memoryEngine before using this tool.',
      };
    }

    try {
      const raw = await memoryEngine.search(query, limit);

      // Normalise whatever the engine returns to a MemorySearchResult array.
      // The default production engine (RAGEngine.retrieveContext) returns a
      // plain markdown string, not an array — calling .map() on it throws.
      // Guard all known shapes: string, array, {rows:[...]}, null/undefined.
      const results: MemorySearchResult[] =
        typeof raw === 'string'
          ? raw.trim()
            ? [{ key: 'rag-context', content: raw, score: 1.0 }]
            : []
          : Array.isArray(raw)
          ? (raw as MemorySearchResult[])
          : Array.isArray((raw as { rows?: unknown })?.rows)
          ? ((raw as { rows: MemorySearchResult[] }).rows)
          : [];

      if (results.length === 0) {
        return {
          success: true,
          output: `No memory results found for query: "${query}"`,
          data: { query, limit, results: [] },
        };
      }

      const lines = results.map((r, i) => {
        const score = r.score !== undefined ? ` (score: ${r.score.toFixed(3)})` : '';
        return `${i + 1}. [${r.key}]${score}\n   ${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}`;
      });

      return {
        success: true,
        output: `Found ${results.length} result(s) for "${query}":\n\n${lines.join('\n\n')}`,
        data: { query, limit, results },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ session: ctx.sessionId, query, err: msg }, 'memory.search error');
      return { success: false, output: `memory.search error: ${msg}` };
    }
  },
};
