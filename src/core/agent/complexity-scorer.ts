/**
 * @file complexity-scorer.ts
 * @description Heuristic prompt complexity scorer for SUDO-AI Wave 10.
 *
 * Evaluates a prompt + tool context and returns a ComplexityResult with:
 *   - score: 0..1 normalised composite
 *   - tier: simple | moderate | complex | very_complex
 *   - signals: string[] of contributing signal names
 *   - suggested_max_tokens: 2048 | 4096 | 8192 | 16384
 *   - thinking_model: true if x2 multiplier applied (model contains "think"/"reason")
 *
 * No I/O — pure synchronous function, < 2 ms on typical inputs.
 */

import { createLogger } from '../shared/logger.js';
import type { ComplexityResult, ComplexityTier } from '../shared/wave10-types.js';

const log = createLogger('agent:complexity-scorer');

// ---------------------------------------------------------------------------
// Signal thresholds
// ---------------------------------------------------------------------------

const CODE_FENCE_RE = /```/g;
const MULTI_STEP_KEYWORDS = ['plan', 'then', 'next', 'step', 'pipeline'] as const;
const JSON_DEPTH_RE = /\{[^{}]*\{[^{}]*\{/; // 3-level nesting heuristic

// ---------------------------------------------------------------------------
// Tier lookup table
// ---------------------------------------------------------------------------

const TIER_TOKEN_MAP: Record<ComplexityTier, number> = {
  simple:      2048,
  moderate:    4096,
  complex:     8192,
  very_complex: 16384,
};

// ---------------------------------------------------------------------------
// score → tier
// ---------------------------------------------------------------------------

function scoreTier(score: number): ComplexityTier {
  if (score < 0.25) return 'simple';
  if (score < 0.5)  return 'moderate';
  if (score < 0.75) return 'complex';
  return 'very_complex';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScorerInput {
  /** The full prompt / user message text. */
  prompt: string;
  /** Number of tools available in the current context. */
  toolCount?: number;
  /** Model name — used to detect thinking-model multiplier. */
  modelName?: string;
}

/**
 * Score a prompt for complexity and return budget recommendations.
 *
 * All signals are additive and clamped to [0, 1] before tier assignment.
 * The thinking-model multiplier doubles suggested_max_tokens without affecting
 * the normalised score or tier label.
 */
export function scoreComplexity(input: ScorerInput): ComplexityResult {
  const { prompt = '', toolCount = 0, modelName = '' } = input;
  const signals: string[] = [];
  let raw = 0;

  // Signal: code_blocks — fenced code present (+0.2)
  const fenceCount = (prompt.match(CODE_FENCE_RE) ?? []).length;
  if (fenceCount >= 2) {
    raw += 0.2;
    signals.push('code_blocks');
  }

  // Signal: tool_count — >5 tools available (+0.1)
  if (toolCount > 5) {
    raw += 0.1;
    signals.push('tool_count');
  }

  // Signal: message_length — prompt >2000 chars (+0.15)
  if (prompt.length > 2000) {
    raw += 0.15;
    signals.push('message_length');
  }

  // Signal: multi_step_keywords — each matching keyword (+0.05, max contribution 0.25)
  for (const kw of MULTI_STEP_KEYWORDS) {
    if (prompt.toLowerCase().includes(kw)) {
      raw += 0.05;
      signals.push(`multi_step_keyword:${kw}`);
    }
  }

  // Signal: json_depth — estimated nesting >2 (+0.1)
  if (JSON_DEPTH_RE.test(prompt)) {
    raw += 0.1;
    signals.push('json_depth');
  }

  // Clamp score to [0, 1]
  const score = Math.min(1, Math.max(0, raw));
  const tier  = scoreTier(score);

  // Thinking-model multiplier x2: model name contains "think" or "reason"
  const modelLower = modelName.toLowerCase();
  const thinking_model = modelLower.includes('think') || modelLower.includes('reason');

  const base_tokens = TIER_TOKEN_MAP[tier];
  const suggested_max_tokens = thinking_model
    ? Math.min(32768, base_tokens * 2)
    : base_tokens;

  const result: ComplexityResult = { score, tier, signals, suggested_max_tokens, thinking_model };

  log.debug(
    { score, tier, signals, suggested_max_tokens, thinking_model },
    'ComplexityScorer result',
  );

  return result;
}
