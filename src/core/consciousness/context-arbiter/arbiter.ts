/**
 * @file arbiter.ts
 * @description CW4 — pure arbitration core. Rank bids by
 * value x confidence / max(tokenCost, 1), admit greedily under a hard token
 * budget, deterministic tie-break by source name. No LLM calls, no I/O.
 *
 * Cache discipline: the composed block orders winners by SOURCE NAME (not
 * score) so identical winner sets yield byte-identical blocks — stable content
 * for the ephemeral (non-cached-prefix) region.
 */

import { createLogger } from '../../shared/logger.js';
import type { ArbiterDecision, ContextBid, InjectionScanner, ScoredBid } from './types.js';

const log = createLogger('consciousness:context-arbiter');

/** Default budget (tokens) when SUDO_CAS_ARBITER_BUDGET is unset/invalid. */
export const DEFAULT_ARBITER_BUDGET = 1200;

/** Per-bid content length cap (chars) applied during sanitization. */
export const BID_CONTENT_MAX_CHARS = 2000;

/** ~4 chars/token — same estimator convention as context-pressure/brief. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

/**
 * Security note (handoff CW4): bid content can carry user-influenced text
 * (episode summaries, procedure names). Strip control chars (keep newline/tab)
 * and cap length — the same pattern the drives line used.
 */
export function sanitizeBidContent(text: string): string {
  if (!text) return '';
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (stripped.length <= BID_CONTENT_MAX_CHARS) return stripped;
  // Code-point-safe cap (never split surrogate pairs; budget in UTF-16 units).
  let out = '';
  for (const cp of stripped) {
    if (out.length + cp.length > BID_CONTENT_MAX_CHARS) break;
    out += cp;
  }
  return out;
}

/** Resolve the arbiter budget: env override, else default. */
export function resolveArbiterBudget(): number {
  const raw = process.env['SUDO_CAS_ARBITER_BUDGET'];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_ARBITER_BUDGET;
}

/**
 * Arbitrate: sanitize -> (optional) injection-scan -> score -> greedy admit
 * under budget -> compose winner block in deterministic source-name order.
 *
 * Losers are first-class output — they are the measurement gold.
 */
export function arbitrate(
  bids: ContextBid[],
  budgetTokens: number,
  scanner?: InjectionScanner,
): ArbiterDecision {
  const budget = Number.isFinite(budgetTokens) && budgetTokens > 0 ? Math.floor(budgetTokens) : 0;
  const winners: ScoredBid[] = [];
  const losers: ScoredBid[] = [];

  // Sanitize + score every valid bid; drop empty-content bids silently.
  const scored: ScoredBid[] = [];
  for (const bid of bids) {
    const content = sanitizeBidContent(bid.content);
    if (!content) continue;
    const value = Math.max(0, Math.min(1, bid.value));
    const confidence = Math.max(0, Math.min(1, bid.confidence));
    const tokenCost = estimateTokens(content);
    const score = (value * confidence) / Math.max(tokenCost, 1);
    scored.push({ ...bid, content, value, confidence, tokenCost, score, admitted: false });
  }

  // Injection scanner: flagged content NEVER enters the prompt.
  const clean: ScoredBid[] = [];
  for (const b of scored) {
    let flagged = false;
    if (scanner) {
      try { flagged = scanner(b.content)?.threat === true; } catch { /* fail-open on scanner error */ }
    }
    if (flagged) { b.rejectReason = 'scanner'; losers.push(b); }
    else clean.push(b);
  }

  // Rank: score desc, deterministic tie-break by source name asc.
  clean.sort((a, b) => (b.score - a.score) || a.source.localeCompare(b.source));

  // Greedy admission under the hard budget.
  let spent = 0;
  for (const b of clean) {
    if (spent + b.tokenCost <= budget) { b.admitted = true; winners.push(b); spent += b.tokenCost; }
    else { b.rejectReason = 'budget'; losers.push(b); }
  }

  // Compose: deterministic source-name order (cache discipline), not score order.
  const ordered = [...winners].sort((a, b) => a.source.localeCompare(b.source));
  const block = ordered.length
    ? '## Consciousness (arbitrated)\n' + ordered.map((b) => b.content).join('\n')
    : '';

  log.debug({ budget, spent, winners: winners.length, losers: losers.length }, 'CW4: arbitration done');
  return { winners, losers, block, budgetTokens: budget, spentTokens: spent };
}
