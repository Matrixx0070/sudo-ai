/**
 * @file model-tier.ts
 * @description Classifies the active backing model into a capability tier, and
 * derives the amplification profile the harness should apply for it. This is the
 * foundation of "Mythos with any LLM": a weaker model needs the harness's
 * scaffolding (explicit operating rules, verification, debate on hard calls)
 * MOST, yet today it gets the same thin defaults as a frontier model. The tier
 * lets each amplifier scale itself to how much help the model actually needs.
 *
 * Pure, dependency-free, and CONSERVATIVE by design: an unknown model classifies
 * as 'strong' (no extra amplification) so we never surprise or degrade a capable
 * or unrecognized model. Only models we positively recognize as small/local/
 * cheap get the 'weak' treatment. Operators can force a tier with
 * SUDO_MODEL_TIER_OVERRIDE=frontier|strong|weak.
 *
 * Model ids here are SUDO's "provider/model" refs (e.g. "claude-oauth/opus",
 * "ollama/llama3.2", "openrouter/z-ai/glm-4.6"); matching is substring-based on
 * the whole ref, lower-cased, so provider prefixes don't matter.
 */

export type ModelTier = 'frontier' | 'strong' | 'weak';

/**
 * The amplifiers the harness should raise for a given tier. Slice 1 (this PR)
 * consumes `promptScaffolding`; `forceVerifyGate` and `preferDebateOnHighStakes`
 * are the stable contract that later Tier-B slices wire in. Keeping them here
 * means the tier→behavior policy lives in ONE place.
 */
export interface AmplificationProfile {
  tier: ModelTier;
  /** Inject the explicit weak-model operating addendum into the system prompt. */
  promptScaffolding: boolean;
  /** Auto-enable the verify-gate even when SUDO_VERIFY_GATE is unset. */
  forceVerifyGate: boolean;
  /** Auto-upgrade single→debate/tree-search on high-stakes requests. */
  preferDebateOnHighStakes: boolean;
}

// Positive markers for the TOP tier — these models rarely need scaffolding.
const FRONTIER_MARKERS = [
  'opus',
  'fable',
  'mythos',
  'gpt-5',
  'o3',
  'o1-pro',
  'gemini-2.5-pro',
  'gemini-3',
  'grok-4',
];

// Positive markers for the WEAK tier — small, local, distilled, or "fast/cheap"
// variants that benefit most from explicit harness scaffolding. Ordered/scoped
// to avoid catching large models (e.g. "405b", "kimi-k2", "glm-4.6" are NOT here).
const WEAK_MARKERS = [
  'haiku',
  '-mini', // bounded so it doesn't match "geMINI" / "miniMAX"
  'flash',
  'lite',
  'tiny',
  'small',
  'gemma',
  'phi-',
  'phi3',
  'phi4',
  'llama-3.2',
  'llama3.2',
  'llama-3.1-8b',
  'llama3.1:8b',
  ':8b',
  ':7b',
  ':3b',
  ':1b',
  '-7b',
  '-8b',
  '-3b',
  '-1b',
  '-2b',
  '1.5b',
  'qwen2.5:7',
  'qwen2.5-7',
  'mistral-7',
  'mistral:7',
  'glm-4-flash',
  'glm-4-air',
  'glm-4v-flash',
  'deepseek-r1:7',
  'deepseek-r1:8',
];

function readOverride(): ModelTier | null {
  const raw = (process.env['SUDO_MODEL_TIER_OVERRIDE'] ?? '').trim().toLowerCase();
  if (raw === 'frontier' || raw === 'strong' || raw === 'weak') return raw;
  return null;
}

/**
 * Classify a model ref into a capability tier. Unknown/unspecified → 'strong'
 * (the safe, no-amplification default). An env override wins over detection.
 */
export function classifyModelTier(modelId: string | undefined | null): ModelTier {
  const override = readOverride();
  if (override) return override;

  if (!modelId || typeof modelId !== 'string') return 'strong';
  const id = modelId.toLowerCase();

  // Weak markers win over frontier markers: a name like "gpt-5-mini" is the
  // small variant and should be treated as weak, not frontier.
  if (WEAK_MARKERS.some((m) => id.includes(m))) return 'weak';
  if (FRONTIER_MARKERS.some((m) => id.includes(m))) return 'frontier';
  return 'strong';
}

/** Derive the amplification profile for a model ref. */
export function getAmplificationProfile(modelId: string | undefined | null): AmplificationProfile {
  const tier = classifyModelTier(modelId);
  const weak = tier === 'weak';
  return {
    tier,
    promptScaffolding: weak,
    forceVerifyGate: weak,
    preferDebateOnHighStakes: weak,
  };
}

/** Kill-switch: adaptive amplification is on by default; =0 disables it. */
export function isAdaptiveAmplifyEnabled(): boolean {
  return process.env['SUDO_ADAPTIVE_AMPLIFY'] !== '0';
}
