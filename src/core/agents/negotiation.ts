/**
 * @file negotiation.ts
 * @description AL5.3 contract-net negotiation primitive — the minimal
 * offer/bid/award protocol over the EXISTING AgentMessenger (no new bus):
 *
 *   1. an agent posts a `task-offer` broadcast (optionally restricted to
 *      eligible roles),
 *   2. eligible roles bid `{confidence, estimatedCost}` back to the offerer,
 *   3. the offerer awards the best bid (highest confidence, ties broken by
 *      lower cost then agent id) and broadcasts the `award`.
 *
 * Payloads travel as JSON in message.content. Author-side inputs are
 * validated fail-loud (a malformed bid you WRITE throws); peer messages are
 * untrusted runtime signals, so malformed/ineligible bids are skipped with a
 * warn and surfaced in the collect result — never a crash, never silent.
 *
 * This is the seam AL6 uses for adaptive routing between agents: award
 * history is the signal, the messenger log is the audit trail.
 */

import { createLogger } from '../shared/index.js';
import type { AgentMessenger } from './messenger.js';
import type { AgentRoleName } from './types.js';

const log = createLogger('agents:negotiation');

export interface TaskOffer {
  taskId: string;
  /** Natural-language task description. */
  task: string;
  /** Offerer agent id — bids are addressed here. */
  from: string;
  /** When set, bids from other roles are rejected at collection time. */
  eligibleRoles?: AgentRoleName[];
}

export interface TaskBid {
  taskId: string;
  agentId: string;
  role: AgentRoleName;
  /** Self-assessed fit, 0..1. */
  confidence: number;
  /** Estimated cost in tokens (comparable across bidders). */
  estimatedCost: number;
}

export interface TaskAward {
  taskId: string;
  winnerAgentId: string;
  winnerRole: AgentRoleName;
  /** Human-readable audit line: why this bid won. */
  reason: string;
}

/** Post a task offer as a broadcast. Returns the full offer (id assigned). */
export function postOffer(
  messenger: AgentMessenger,
  offer: Omit<TaskOffer, 'taskId'> & { taskId?: string },
): TaskOffer {
  const full: TaskOffer = { taskId: offer.taskId ?? `task-${Date.now().toString(36)}-${messenger.size}`, ...offer };
  messenger.send({ from: full.from, to: 'all', type: 'task-offer', content: JSON.stringify(full) });
  log.info({ taskId: full.taskId, from: full.from, eligibleRoles: full.eligibleRoles }, 'Task offer posted');
  return full;
}

/** Submit a bid to an offer. Author-side validation is fail-loud. */
export function submitBid(messenger: AgentMessenger, offer: TaskOffer, bid: TaskBid): void {
  if (bid.taskId !== offer.taskId) {
    throw new Error(`Bid taskId "${bid.taskId}" does not match offer "${offer.taskId}"`);
  }
  if (typeof bid.confidence !== 'number' || bid.confidence < 0 || bid.confidence > 1) {
    throw new Error(`Bid confidence must be 0..1 (got ${bid.confidence})`);
  }
  if (typeof bid.estimatedCost !== 'number' || !Number.isFinite(bid.estimatedCost) || bid.estimatedCost < 0) {
    throw new Error(`Bid estimatedCost must be a non-negative number (got ${bid.estimatedCost})`);
  }
  messenger.send({ from: bid.agentId, to: offer.from, type: 'bid', content: JSON.stringify(bid) });
}

export interface CollectedBids {
  bids: TaskBid[];
  /** Count of malformed or role-ineligible bid messages skipped (warned, never silent). */
  rejected: number;
}

/** Collect this offer's bids from the messenger — untrusted peer input. */
export function collectBids(messenger: AgentMessenger, offer: TaskOffer): CollectedBids {
  const bids: TaskBid[] = [];
  let rejected = 0;
  for (const m of messenger.getFor(offer.from)) {
    if (m.type !== 'bid') continue;
    let bid: TaskBid;
    try {
      bid = JSON.parse(m.content) as TaskBid;
    } catch {
      rejected++;
      log.warn({ taskId: offer.taskId, from: m.from }, 'Malformed bid payload skipped');
      continue;
    }
    if (bid.taskId !== offer.taskId) continue; // another negotiation's bid
    const valid =
      typeof bid.agentId === 'string' &&
      typeof bid.confidence === 'number' && bid.confidence >= 0 && bid.confidence <= 1 &&
      typeof bid.estimatedCost === 'number' && bid.estimatedCost >= 0;
    if (!valid) {
      rejected++;
      log.warn({ taskId: offer.taskId, from: m.from }, 'Invalid bid fields — skipped');
      continue;
    }
    if (offer.eligibleRoles && !offer.eligibleRoles.includes(bid.role)) {
      rejected++;
      log.warn({ taskId: offer.taskId, from: m.from, role: bid.role }, 'Bid from ineligible role — skipped');
      continue;
    }
    bids.push(bid);
  }
  return { bids, rejected };
}

/**
 * Award the offer to the best collected bid: highest confidence, ties broken
 * by lower estimatedCost, then agentId (deterministic). Broadcasts the award
 * and logs it. Returns null when no eligible bids exist — the offerer
 * decides the fallback (do it itself, re-offer, or escalate).
 */
export function awardTask(messenger: AgentMessenger, offer: TaskOffer): TaskAward | null {
  const { bids, rejected } = collectBids(messenger, offer);
  if (bids.length === 0) {
    log.warn({ taskId: offer.taskId, rejected }, 'No eligible bids — nothing to award');
    return null;
  }
  const best = [...bids].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.estimatedCost - b.estimatedCost ||
      a.agentId.localeCompare(b.agentId),
  )[0]!;
  const award: TaskAward = {
    taskId: offer.taskId,
    winnerAgentId: best.agentId,
    winnerRole: best.role,
    reason:
      `confidence ${best.confidence} @ ~${best.estimatedCost} tokens ` +
      `(beat ${bids.length - 1} other bid(s); ${rejected} rejected)`,
  };
  messenger.send({ from: offer.from, to: 'all', type: 'award', content: JSON.stringify(award) });
  log.info({ ...award }, 'Task awarded');
  return award;
}
