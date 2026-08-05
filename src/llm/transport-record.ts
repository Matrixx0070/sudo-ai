/**
 * @file transport-record.ts
 * @description Fail-open call-recording + cost-estimation choke point, split out
 * of transport.ts (max-lines ratchet). `recordCall` is the single per-call point
 * where an llm_calls row is written (mirroring client.ts recordGatewayCall) and
 * the asymmetric budget counter accrues. Kept verbatim from transport.ts — no
 * behaviour change.
 */

import { recordGatewayCall } from './client.js';
import { classifyThrown, type LLMErrorClass } from './errors.js';
import { recordSpend } from './policy.js';
import { estimateCostUsd } from './limits.js';
import { withProviderCost } from './transport-stream.js';
import { type LLMCallRecord } from './logging.js';
import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm:transport-record');

/** classifyThrown that can never itself throw (logging is fail-open). */
export function classifyThrownSafe(err: unknown): LLMErrorClass {
  try {
    return classifyThrown(err);
  } catch {
    return 'unknown';
  }
}

/** Fail-open llm_calls row — mirrors client.ts recordGatewayCall contract. */
export function recordCall(entry: LLMCallRecord): void {
  try {
    // GW-1: enrich with an ESTIMATED USD cost from token counts when the
    // provider didn't hand us a real cost, so (a) gateway.db has a cost floor
    // for boot-time day-spend derivation and (b) the in-memory budget counter
    // in policy.ts actually accrues. Real provider cost, when present, wins.
    const enriched = withEstimatedCost(withProviderCost(entry));
    recordGatewayCall(enriched);
    // Feed the asymmetric budget counter. Guard on >0 so error rows (no tokens)
    // never move the needle; recordCall is the single per-call choke point
    // (streaming writeRow is idempotent), so this counts each call exactly once.
    if (typeof enriched.costUsd === 'number' && enriched.costUsd > 0) {
      recordSpend(enriched.caller, enriched.costUsd);
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'llm_calls record failed (fail-open)');
  }
}

/**
 * GW-1: attach an estimated USD cost to a call record when one isn't already
 * set and token counts are available. Uses the resolved route (or alias) as the
 * pricing key. Never throws — a bad estimate must not block recording.
 */
export function withEstimatedCost(entry: LLMCallRecord): LLMCallRecord {
  if (typeof entry.costUsd === 'number' && entry.costUsd > 0) return entry;
  const tin = entry.tokensIn ?? 0;
  const tout = entry.tokensOut ?? 0;
  if (tin <= 0 && tout <= 0) return entry;
  try {
    const model = entry.route ?? entry.alias ?? '';
    const usd = estimateCostUsd(model, tin, tout);
    if (usd > 0) return { ...entry, costUsd: usd };
  } catch {
    /* estimation is best-effort */
  }
  return entry;
}
