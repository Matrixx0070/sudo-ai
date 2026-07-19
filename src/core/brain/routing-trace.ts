/**
 * routing-trace.ts
 *
 * Observability for the brain's routing layer. Every Brain.call() attaches a
 * RoutingTrace describing which decision path produced the answer, which model
 * actually ran vs. what was selected, the consensus/failover metadata, and the
 * estimated cost — so UIs, channels, and logs can surface it (cost transparency
 * + an "active model ≠ selected" notice).
 */

/** Which decision path produced the answer. */
export type RoutingPath =
  | 'reasoning-tier'
  | 'cheap'
  | 'category'
  | 'affinity'
  | 'consensus'
  | 'failover'
  | 'blocked';

/** A human-readable trace of the routing decision for a single Brain.call(). */
export interface RoutingTrace {
  /** Which decision path produced the answer. */
  path: RoutingPath;
  /** Human-readable reason (smart-route reason, consensus method, failover attempt, …). */
  reason: string;
  /** The model the caller asked for / would have defaulted to. */
  selectedModel: string;
  /** The model that actually answered. */
  activeModel: string;
  /** True when activeModel differs from selectedModel — the "active ≠ selected" notice. */
  switched: boolean;
  /** Estimated USD cost of this call. */
  costUSD: number;
  /** Consensus metadata (present on the consensus path). */
  consensus?: { agreement: number; method: 'fastest' | 'most-detailed' };
  /** Number of failover profiles attempted (present on the failover path). */
  failoverAttempts?: number;
}

/** Format a routing trace as a compact, user-facing one-liner. */
export function describeRouting(t: RoutingTrace): string {
  const cost = `$${(Number.isFinite(t.costUSD) ? t.costUSD : 0).toFixed(4)}`;
  const switched = t.switched ? ` (selected ${t.selectedModel} → active ${t.activeModel})` : '';

  switch (t.path) {
    case 'reasoning-tier':
      return `🧠 reasoning-tier → ${t.activeModel} ${cost}${switched}`;
    case 'cheap':
      return `⚡ cheap-route → ${t.activeModel} ${cost}${switched}`;
    case 'category':
      return `🎯 ${t.reason} → ${t.activeModel} ${cost}${switched}`;
    case 'affinity':
      return `📌 cache-affinity → ${t.activeModel} ${cost}${switched}`;
    case 'consensus': {
      const c = t.consensus;
      const pct = c ? `${Math.round(c.agreement * 100)}%` : '';
      return `🤝 consensus(${c?.method ?? '?'} ${pct}) → ${t.activeModel} ${cost}`;
    }
    case 'failover':
      return `↪ failover(#${t.failoverAttempts ?? 1}) → ${t.activeModel} ${cost}${switched}`;
    case 'blocked':
      return `⛔ blocked: ${t.reason}`;
    default:
      return `→ ${t.activeModel} ${cost}`;
  }
}
