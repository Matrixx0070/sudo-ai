/**
 * @file types.ts
 * @description CW4 — bid-based context arbiter types (handoff CW4, binding).
 */

/** A bid from one consciousness source competing for prompt space. */
export interface ContextBid {
  /** Stable source name (deterministic tie-break key). */
  source: string;
  /** The text that would enter the prompt if this bid wins. */
  content: string;
  /** How valuable this content is right now, 0..1 — from REAL module state. */
  value: number;
  /** How confident the source is in that value, 0..1 — from REAL module state. */
  confidence: number;
  /** Estimated token cost of `content`. */
  tokenCost: number;
}

/** A bid annotated with its computed rank score and admission outcome. */
export interface ScoredBid extends ContextBid {
  /** value x confidence / max(tokenCost, 1). */
  score: number;
  admitted: boolean;
  /** Why a loser lost: 'budget' (did not fit) or 'scanner' (injection-flagged). */
  rejectReason?: 'budget' | 'scanner';
}

/** Result of one arbitration round. */
export interface ArbiterDecision {
  winners: ScoredBid[];
  losers: ScoredBid[];
  /** Composed winner block (deterministic source-name order), '' when no winners. */
  block: string;
  budgetTokens: number;
  spentTokens: number;
}

/** Optional injection scanner (loop passes security.detectInjection). */
export type InjectionScanner = (text: string) => { threat: boolean } | null | undefined;
