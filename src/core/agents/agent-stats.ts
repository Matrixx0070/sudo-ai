/**
 * @file agent-stats.ts
 * @description AL5.5 salvage (merge-salvage DECIDED 2026-07-28 under Frank's
 * delegated design authority): the ONE proven idea inside the quarantined
 * SwarmManager — success-rate agent selection (swarm-manager.ts getBestAgent,
 * ORDER BY success_rate DESC, tasks_completed DESC) — lifted into the live
 * agents/ layer. The swarm module itself stays quarantined untouched
 * (never-drop rule); its swarm_knowledge memory-API bypass remains the
 * blocker to any future revive.
 *
 * Design constraints:
 *   - IN-MEMORY ONLY, pipeline-lifetime (like AgentMessenger). The swarm's
 *     private sqlite table was an invariant-5 hazard; durable per-agent
 *     stats must ride the memory API with tier+category, not a side table.
 *   - Laplace-smoothed rates ((successes+1)/(attempts+2)) so an unknown
 *     agent scores a neutral 0.5 prior instead of 0 or NaN — new agents are
 *     neither favored nor starved.
 *   - Feeds two seams: the AL5.3 award function (proven agents win ties and
 *     weight their confidence) and AL6's PolicySignals.recentFailureRate.
 */

import type { AgentRoleName } from './types.js';

interface Tally {
  attempts: number;
  successes: number;
  role?: AgentRoleName;
}

export interface AgentOutcome {
  agentId: string;
  role?: AgentRoleName;
  success: boolean;
}

export class AgentPerfTracker {
  private readonly byAgent = new Map<string, Tally>();

  record(outcome: AgentOutcome): void {
    const t = this.byAgent.get(outcome.agentId) ?? { attempts: 0, successes: 0 };
    t.attempts += 1;
    if (outcome.success) t.successes += 1;
    if (outcome.role) t.role = outcome.role;
    this.byAgent.set(outcome.agentId, t);
  }

  attempts(agentId: string): number {
    return this.byAgent.get(agentId)?.attempts ?? 0;
  }

  /** Laplace-smoothed success rate; unknown agents get the neutral 0.5 prior. */
  successRate(agentId: string): number {
    const t = this.byAgent.get(agentId);
    if (!t) return 0.5;
    return (t.successes + 1) / (t.attempts + 2);
  }

  /**
   * The salvaged getBestAgent ordering: highest smoothed success rate, ties
   * broken by MORE completed attempts (the swarm's tasks_completed DESC),
   * then agentId for determinism. Null on an empty candidate list.
   */
  bestAgent(candidateIds: string[]): string | null {
    if (candidateIds.length === 0) return null;
    return [...candidateIds].sort(
      (a, b) =>
        this.successRate(b) - this.successRate(a) ||
        this.attempts(b) - this.attempts(a) ||
        a.localeCompare(b),
    )[0]!;
  }

  /**
   * AL6 signal feed: observed failure rate (UNsmoothed — a signal, not a
   * ranking) across all agents, or one role's agents. 0 when nothing
   * recorded — calm by default, matching PolicySignals semantics.
   */
  failureRate(role?: AgentRoleName): number {
    let attempts = 0;
    let successes = 0;
    for (const t of this.byAgent.values()) {
      if (role && t.role !== role) continue;
      attempts += t.attempts;
      successes += t.successes;
    }
    if (attempts === 0) return 0;
    return (attempts - successes) / attempts;
  }
}
