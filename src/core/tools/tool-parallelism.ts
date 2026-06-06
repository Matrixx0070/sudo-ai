/**
 * @file tools/tool-parallelism.ts
 * @description Concurrent dispatch of independent tool calls for SUDO-AI v4.
 *
 * When the LLM returns multiple tool calls that have no data dependencies
 * between them, they can be executed in parallel instead of sequentially.
 * This dramatically reduces latency for multi-step operations.
 *
 * Inspired by Hermes Agent's concurrent tool dispatch.
 *
 * Dependency detection:
 *   - If tool B's arguments reference tool A's call ID → B depends on A
 *   - If tool B's arguments contain a ${resultRef} pattern → B depends on A
 *   - Otherwise → independent (safe to run in parallel)
 */

import type { ToolCallRequest, ToolCallResult, ToolContext } from './types.js';
import type { ToolRegistry } from './registry.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('tools:parallelism');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Grouping of tool calls by independence. */
export interface ToolCallGroup {
  /** Calls with no dependencies — safe to execute concurrently. */
  independent: ToolCallRequest[];
  /** Calls that depend on other calls' results, keyed by the dependency call ID. */
  dependent: Map<string, ToolCallRequest[]>;
}

/** Result of a parallel tool execution. */
export interface ParallelResult {
  /** Results keyed by call ID. */
  results: Map<string, ToolCallResult>;
  /** Total wall-clock time in ms. */
  totalTimeMs: number;
  /** How many calls ran concurrently at peak. */
  parallelism: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum concurrent tool executions. */
const MAX_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Dependency analysis
// ---------------------------------------------------------------------------

/**
 * Check if a tool call's arguments reference another call's ID.
 * Patterns: direct ID reference, ${result_X} template, or tool_call_id field.
 */
function referencesCallId(
  call: ToolCallRequest,
  otherCallIds: Set<string>,
): string | null {
  const argsStr = JSON.stringify(call.arguments ?? {});

  // Check for direct call ID references
  for (const id of otherCallIds) {
    if (argsStr.includes(id)) {
      return id;
    }
  }

  // Check for ${result_...} template patterns
  const templateMatch = argsStr.match(/\$\{result_([^}]+)\}/);
  if (templateMatch) {
    const refId = templateMatch[1];
    if (otherCallIds.has(refId)) {
      return refId;
    }
  }

  // Check for tool_call_id fields
  const args = call.arguments as Record<string, unknown> | undefined;
  if (args?.tool_call_id && typeof args.tool_call_id === 'string') {
    const refId = args.tool_call_id;
    if (otherCallIds.has(refId)) {
      return refId;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// ToolParallelism
// ---------------------------------------------------------------------------

export class ToolParallelism {
  private totalExecutions = 0;
  private totalParallelism = 0;
  private totalTimeSavedMs = 0;

  /**
   * Analyze dependencies between tool calls.
   *
   * @param calls - Tool calls to analyze.
   * @returns Grouping of independent and dependent calls.
   */
  analyzeDependencies(calls: ToolCallRequest[]): ToolCallGroup {
    if (calls.length <= 1) {
      return {
        independent: calls,
        dependent: new Map(),
      };
    }

    const callIds = new Set(calls.map(c => c.id));
    const independent: ToolCallRequest[] = [];
    const dependent: Map<string, ToolCallRequest[]> = new Map();

    for (const call of calls) {
      const depId = referencesCallId(call, callIds);
      if (depId) {
        const list = dependent.get(depId) ?? [];
        list.push(call);
        dependent.set(depId, list);
      } else {
        independent.push(call);
      }
    }

    log.debug(
      {
        total: calls.length,
        independent: independent.length,
        dependent: dependent.size,
      },
      'Dependency analysis complete',
    );

    return { independent, dependent };
  }

  /**
   * Execute tool calls with automatic parallelism for independent calls.
   *
   * @param calls   - Tool calls to execute.
   * @param registry - Tool registry for execution.
   * @param ctx      - Tool execution context.
   * @returns ParallelResult with all call results.
   */
  async executeParallel(
    calls: ToolCallRequest[],
    registry: ToolRegistry,
    ctx: ToolContext,
  ): Promise<ParallelResult> {
    const startTime = Date.now();
    const results = new Map<string, ToolCallResult>();

    if (calls.length === 0) {
      return { results, totalTimeMs: 0, parallelism: 0 };
    }

    // Single call — no parallelism needed
    if (calls.length === 1) {
      const call = calls[0]!;
      const result = await registry.executeCall(call, ctx);
      results.set(call.id, result);
      this.totalExecutions++;
      return { results, totalTimeMs: Date.now() - startTime, parallelism: 1 };
    }

    // Analyze dependencies
    const group = this.analyzeDependencies(calls);

    // Execute independent calls concurrently (capped)
    const independentResults = await this.executeBatch(group.independent, registry, ctx);
    for (const r of independentResults) {
      results.set(r.toolCallId, r);
    }

    // Execute dependent calls sequentially after their dependencies complete
    for (const [, depCalls] of group.dependent) {
      for (const call of depCalls) {
        try {
          const result = await registry.executeCall(call, ctx);
          results.set(call.id, result);
        } catch (err) {
          const durationMs = Date.now() - startTime;
          results.set(call.id, {
            toolCallId: call.id,
            name: call.name,
            result: { success: false, output: `Parallel execution error: ${String(err)}` },
            durationMs,
          });
        }
      }
    }

    const totalTimeMs = Date.now() - startTime;
    const sequentialTimeMs = Array.from(results.values())
      .reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
    const timeSaved = Math.max(0, sequentialTimeMs - totalTimeMs);
    const parallelism = group.independent.length > 0
      ? Math.min(group.independent.length, MAX_CONCURRENCY)
      : 1;

    this.totalExecutions++;
    this.totalParallelism += parallelism;
    this.totalTimeSavedMs += timeSaved;

    log.debug(
      {
        totalCalls: calls.length,
        independentCount: group.independent.length,
        dependentCount: group.dependent.size,
        parallelism,
        totalTimeMs,
        timeSavedMs: timeSaved,
      },
      'Parallel execution complete',
    );

    return { results, totalTimeMs, parallelism };
  }

  /**
   * Execute a batch of calls concurrently with a concurrency limit.
   */
  private async executeBatch(
    calls: ToolCallRequest[],
    registry: ToolRegistry,
    ctx: ToolContext,
  ): Promise<ToolCallResult[]> {
    if (calls.length === 0) return [];

    // Simple concurrency limiter: process in chunks of MAX_CONCURRENCY
    const chunks: ToolCallRequest[][] = [];
    for (let i = 0; i < calls.length; i += MAX_CONCURRENCY) {
      chunks.push(calls.slice(i, i + MAX_CONCURRENCY));
    }

    const allResults: ToolCallResult[] = [];
    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(call =>
          registry.executeCall(call, ctx).catch(err => ({
            toolCallId: call.id,
            name: call.name,
            result: { success: false, output: `Batch error: ${String(err)}` },
            durationMs: 0,
          })),
        ),
      );
      allResults.push(...chunkResults);
    }

    return allResults;
  }

  /**
   * Get execution statistics.
   */
  getStats(): { totalExecutions: number; avgParallelism: number; timeSavedMs: number } {
    return {
      totalExecutions: this.totalExecutions,
      avgParallelism: this.totalExecutions > 0
        ? Math.round(this.totalParallelism / this.totalExecutions * 100) / 100
        : 0,
      timeSavedMs: this.totalTimeSavedMs,
    };
  }
}