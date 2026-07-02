/**
 * @file learning/routing-trace.ts
 * @description Derive a real routing trace (category / tier / confidence) from
 * the keyword intent classifier, for TraceStore.recordRouting.
 *
 * Previously the agent loop recorded a CONSTANT routing trace on every brain
 * call — `category:'fast'`, `tier:'keyword'`, `confidence:0.5` — regardless of
 * the message. Every routing row was identical, so the learning flywheel
 * (TraceAnalyzer → trace-driven policy) learned nothing from routing (P0 #6 in
 * docs/REVIEW-2026-07-02-vs-openclaw.md).
 *
 * This derives the trace deterministically from the real `classifyIntent`
 * output so rows vary with the input:
 *  - tier is genuinely `keyword` — this classifier is regex/keyword-based, not
 *    a DFA or an LLM.
 *  - category maps the intent taxonomy onto TraceStore's IntentCategory.
 *  - confidence reflects the classifier's own complexity estimate.
 * These are derivations of real signal, not the previous fixed placeholders.
 */

import { classifyIntent, type TaskIntent } from '../agent/intent-classifier.js';
import type { IntentCategory, RoutingTier } from './trace-store.js';

export interface RoutingTrace {
  category: IntentCategory;
  tier: RoutingTier;
  confidence: number;
}

/** Map the intent taxonomy (conversation/single-tool/…) onto IntentCategory. */
function categoryForIntent(intent: TaskIntent): IntentCategory {
  switch (intent.intentType) {
    case 'conversation':
      return 'fast';
    case 'spawn-team':
      // Team spawns are the heavy build/produce path.
      return 'coding';
    case 'single-tool':
    case 'multi-tool':
      return 'analysis';
    default:
      return 'fast';
  }
}

/** Confidence from the classifier's own complexity estimate (higher = surer). */
function confidenceForComplexity(complexity: TaskIntent['complexity']): number {
  switch (complexity) {
    case 'high':
      return 0.85;
    case 'medium':
      return 0.7;
    case 'low':
    default:
      return 0.55;
  }
}

/**
 * Derive the routing trace for a user message. Deterministic and side-effect
 * free — safe to call on the brain-call hot path.
 */
export function deriveRoutingTrace(userText: string): RoutingTrace {
  const intent = classifyIntent(userText ?? '');
  return {
    category: categoryForIntent(intent),
    tier: 'keyword',
    confidence: confidenceForComplexity(intent.complexity),
  };
}
