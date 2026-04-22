/**
 * @file cost-tracker.ts
 * @description In-memory cost tracker for SUDO-AI brain calls.
 *
 * Records per-session token usage and derives USD cost using the
 * rate table from costs.ts. Exposes a human-readable report for
 * the /cost slash command.
 */

import { createLogger } from '../shared/logger.js';
import { estimateCost } from './costs.js';

const log = createLogger('brain:cost-tracker');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionCostRecord {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

/**
 * Singleton-friendly in-memory tracker.
 * Create one instance in cli.ts and share it with the brain and /cost command.
 *
 * @example
 * ```ts
 * const tracker = new CostTracker();
 * tracker.recordCall('sess-abc', 1200, 300, 'xai/grok-3');
 * console.log(tracker.formatReport('sess-abc'));
 * ```
 */
export class CostTracker {
  private readonly sessions: Map<string, SessionCostRecord> = new Map();

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  /**
   * Record a completed LLM call for the given session.
   *
   * @param sessionId    - Active session ID.
   * @param inputTokens  - Prompt token count.
   * @param outputTokens - Completion token count.
   * @param model        - Provider-qualified model ID used for this call.
   */
  recordCall(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    model: string,
  ): void {
    if (!sessionId) {
      log.warn('recordCall: sessionId is empty — skipping');
      return;
    }

    const usd = estimateCost(model, inputTokens, outputTokens);
    const existing = this.sessions.get(sessionId) ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: 0,
    };

    this.sessions.set(sessionId, {
      calls: existing.calls + 1,
      inputTokens: existing.inputTokens + inputTokens,
      outputTokens: existing.outputTokens + outputTokens,
      estimatedUsd: existing.estimatedUsd + usd,
    });

    log.debug(
      { sessionId, inputTokens, outputTokens, model, usd: usd.toFixed(6) },
      'Cost recorded',
    );
  }

  // -------------------------------------------------------------------------
  // Querying
  // -------------------------------------------------------------------------

  /**
   * Return cost data for a single session.
   * Returns zeroed record if the session has no calls yet.
   */
  getSessionCost(sessionId: string): SessionCostRecord {
    return this.sessions.get(sessionId) ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: 0,
    };
  }

  /**
   * Return aggregate totals across all sessions.
   */
  getTotalCost(): { calls: number; estimatedUsd: number } {
    let calls = 0;
    let estimatedUsd = 0;
    for (const rec of this.sessions.values()) {
      calls += rec.calls;
      estimatedUsd += rec.estimatedUsd;
    }
    return { calls, estimatedUsd };
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  /**
   * Build a human-readable cost report.
   *
   * @param sessionId - When provided, include per-session breakdown.
   *                    When omitted, show only totals.
   */
  formatReport(sessionId?: string): string {
    const total = this.getTotalCost();
    const lines: string[] = [
      'Cost Report',
      '===========',
      `Total calls : ${total.calls}`,
      `Estimated   : $${total.estimatedUsd.toFixed(4)} USD`,
    ];

    if (sessionId) {
      const rec = this.getSessionCost(sessionId);
      lines.push('');
      lines.push(`Session: ${sessionId}`);
      lines.push(`  Calls       : ${rec.calls}`);
      lines.push(`  Input tok   : ${rec.inputTokens.toLocaleString()}`);
      lines.push(`  Output tok  : ${rec.outputTokens.toLocaleString()}`);
      lines.push(`  Session cost: $${rec.estimatedUsd.toFixed(4)} USD`);
    }

    return lines.join('\n');
  }

  /** Number of distinct sessions tracked. */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
