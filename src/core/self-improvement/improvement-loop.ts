/**
 * @file improvement-loop.ts
 * @description Upgrade 64 — Self-Improvement Loop.
 *
 * Records insights (weaknesses, strengths, opportunities, patterns) derived
 * from analysing recent tool-use sequences and exposes a self-report summary.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('self-improvement:loop');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImprovementInsight {
  id: string;
  type: 'weakness' | 'strength' | 'opportunity' | 'pattern';
  description: string;
  source: string;
  actionTaken?: string;
  createdAt: string;
}

export interface ActionRecord {
  tool: string;
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// In-memory store (capped at 1000 entries)
// ---------------------------------------------------------------------------

const MAX_INSIGHTS = 1000;
const TRIM_TO      = 500;

const insights: ImprovementInsight[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a single improvement insight.
 * The in-memory buffer is automatically trimmed when it exceeds MAX_INSIGHTS.
 */
export function recordInsight(
  type: ImprovementInsight['type'],
  description: string,
  source: string,
): ImprovementInsight {
  if (!description || !source) throw new TypeError('description and source are required');

  const insight: ImprovementInsight = {
    id: `insight-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    description,
    source,
    createdAt: new Date().toISOString(),
  };

  insights.push(insight);
  if (insights.length > MAX_INSIGHTS) insights.splice(0, MAX_INSIGHTS - TRIM_TO);

  log.info({ type, source }, description.substring(0, 80));
  return insight;
}

/** All recorded weaknesses. */
export function getWeaknesses(): ImprovementInsight[] {
  return insights.filter(i => i.type === 'weakness');
}

/** All recorded strengths. */
export function getStrengths(): ImprovementInsight[] {
  return insights.filter(i => i.type === 'strength');
}

/** All recorded patterns. */
export function getPatterns(): ImprovementInsight[] {
  return insights.filter(i => i.type === 'pattern');
}

/**
 * Analyse a sequence of tool-use actions and derive new insights.
 *
 * Rules:
 *  - Any tool that failed >= 2 times → weakness
 *  - If >= 5 successes, the most-used successful tool → strength
 *
 * @returns Newly created insights (does NOT include pre-existing ones).
 */
export function analyzeForImprovement(actions: ActionRecord[]): ImprovementInsight[] {
  if (!Array.isArray(actions)) throw new TypeError('actions must be an array');

  const newInsights: ImprovementInsight[] = [];

  // ---- Repeated failures → weakness ----------------------------------------
  const failureCounts = new Map<string, number>();
  for (const a of actions.filter(a => !a.success)) {
    failureCounts.set(a.tool, (failureCounts.get(a.tool) ?? 0) + 1);
  }
  for (const [tool, count] of failureCounts) {
    if (count >= 2) {
      newInsights.push(
        recordInsight(
          'weakness',
          `Tool "${tool}" failed ${count} times. Need better error handling or alternative approach.`,
          'self-analysis',
        ),
      );
    }
  }

  // ---- Dominant successes → strength ----------------------------------------
  const successes = actions.filter(a => a.success);
  if (successes.length > 5) {
    const commonTools = new Map<string, number>();
    for (const s of successes) {
      commonTools.set(s.tool, (commonTools.get(s.tool) ?? 0) + 1);
    }
    const topTool = [...commonTools.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topTool) {
      newInsights.push(
        recordInsight(
          'strength',
          `Tool "${topTool[0]}" is highly effective (${topTool[1]} successes).`,
          'self-analysis',
        ),
      );
    }
  }

  return newInsights;
}

/** Human-readable summary of the current insight store. */
export function getSelfReport(): string {
  const w = getWeaknesses().length;
  const s = getStrengths().length;
  const p = getPatterns().length;
  return (
    `Self-improvement: ${w} weaknesses identified, ${s} strengths confirmed, ` +
    `${p} patterns learned. Total insights: ${insights.length}`
  );
}
