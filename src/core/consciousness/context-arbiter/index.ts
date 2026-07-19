/**
 * @file index.ts
 * @description Barrel for the CW4 bid-based context arbiter.
 */

export type { ContextBid, ScoredBid, ArbiterDecision, InjectionScanner } from './types.js';
export {
  arbitrate,
  sanitizeBidContent,
  resolveArbiterBudget,
  estimateTokens,
  DEFAULT_ARBITER_BUDGET,
  BID_CONTENT_MAX_CHARS,
} from './arbiter.js';
export { collectBids, type BriefContextLike } from './sources.js';
export { recordDecision, closeArbiterStore } from './store.js';
export { runArbiterForBrief } from './apply.js';
