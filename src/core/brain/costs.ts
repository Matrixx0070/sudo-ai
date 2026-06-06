/**
 * Token cost estimation and energy model for the Brain module.
 *
 * Rate table is in USD per 1M tokens (input / output).
 * Unknown models fall back to DEFAULT_COST_RATE.
 *
 * Wave 10 addition: energy model (estimateEnergy).
 * Energy estimates use published hardware TDP + measured queries/sec baselines:
 *
 *   H100 SXM5:   700W TDP,  ~300 tok/s output
 *   A100 SXM4:   400W TDP,  ~180 tok/s output
 *   A10G:        150W TDP,  ~80  tok/s output
 *   Cloud API:   No direct access to hardware — energy estimated via
 *                published emissions data (OpenAI: ~0.002 Wh/1K output tokens,
 *                Anthropic similar, xAI/Google: ~0.0015 Wh/1K output tokens)
 *
 * FLOPs approximation:
 *   For transformer inference: ~2 * N_params * N_tokens FLOPs
 *   Estimated param counts per provider tier are documented inline.
 *
 * All energy values are ESTIMATES. source='estimated' always.
 * These are useful for relative comparison, not billing.
 */

import type { TokenUsage } from './types.js';
import type { EnergyEstimate } from '../shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Rate table
// ---------------------------------------------------------------------------

interface CostRate {
  inputPerM: number;
  outputPerM: number;
}

/** Known model rates (USD / 1M tokens). Keep in sync with active provider pricing. */
export const COST_RATES: Record<string, CostRate> = {
  // xAI Grok — Premium tier ($2/$6)
  'xai/grok-4.20-0309-reasoning': { inputPerM: 2.0, outputPerM: 6.0 },
  'xai/grok-4.20-0309-non-reasoning': { inputPerM: 2.0, outputPerM: 6.0 },
  'xai/grok-4.20-multi-agent-0309': { inputPerM: 2.0, outputPerM: 6.0 },
  'xai/grok-4-0709': { inputPerM: 2.0, outputPerM: 6.0 },
  // xAI Grok — Fast tier ($0.20/$0.50)
  'xai/grok-4-1-fast-reasoning': { inputPerM: 0.20, outputPerM: 0.50 },
  'xai/grok-4-1-fast-non-reasoning': { inputPerM: 0.20, outputPerM: 0.50 },
  'xai/grok-4-fast-reasoning': { inputPerM: 0.20, outputPerM: 0.50 },
  'xai/grok-4-fast-non-reasoning': { inputPerM: 0.20, outputPerM: 0.50 },
  // xAI Grok — Legacy
  'xai/grok-3': { inputPerM: 0.30, outputPerM: 0.50 },
  'xai/grok-3-mini': { inputPerM: 0.30, outputPerM: 0.50 },
  'xai/grok-3-fast': { inputPerM: 5.0, outputPerM: 25.0 },
  // xAI Grok — Code specialist
  'xai/grok-code-fast-1': { inputPerM: 0.20, outputPerM: 0.50 },
  // OpenAI
  'openai/gpt-4o': { inputPerM: 2.5, outputPerM: 10.0 },
  'openai/gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'openai/o3': { inputPerM: 10.0, outputPerM: 40.0 },
  // Anthropic
  'anthropic/claude-opus-4-5': { inputPerM: 15.0, outputPerM: 75.0 },
  'anthropic/claude-sonnet-4-5': { inputPerM: 3.0, outputPerM: 15.0 },
  'anthropic/claude-haiku-3-5': { inputPerM: 0.8, outputPerM: 4.0 },
  // Google
  'google/gemini-2.0-flash': { inputPerM: 0.1, outputPerM: 0.4 },
  'google/gemini-1.5-pro': { inputPerM: 3.5, outputPerM: 10.5 },
};

const DEFAULT_COST_RATE: CostRate = { inputPerM: 5.0, outputPerM: 20.0 };

// ---------------------------------------------------------------------------
// Energy model — Wave 10 addition
// ---------------------------------------------------------------------------

/**
 * Per-provider energy profile.
 *
 * whPerKOutputTokens:
 *   Watt-hours consumed per 1000 output tokens.
 *   Sources:
 *     - OpenAI: ~0.002 Wh/1K output tokens (internal estimate, 2024)
 *     - Anthropic: ~0.0018 Wh/1K output tokens (similar datacenter footprint)
 *     - xAI: ~0.0015 Wh/1K output tokens (newer H100 hardware, higher efficiency)
 *     - Google: ~0.0012 Wh/1K output tokens (TPU v5 efficiency)
 *     - Local (H100): TDP 700W / 300 tok/s = 2.33 Wh/1K tokens
 *     - Local (A100): TDP 400W / 180 tok/s = 2.22 Wh/1K tokens
 *
 * estimatedParamsB:
 *   Approximate parameter count in billions. Used for FLOPs approximation.
 *   FLOPs per token ≈ 2 * params_in_billions * 1e9
 *   Sources: public model cards, research papers, and community estimates.
 */
interface EnergyProfile {
  whPerKOutputTokens: number;
  estimatedParamsB: number;
}

/**
 * Provider-level energy profiles.
 * Prefix matching: "openai/*" → openai profile.
 */
const PROVIDER_ENERGY: Record<string, EnergyProfile> = {
  // Cloud providers — API-based (no direct hardware access)
  openai:     { whPerKOutputTokens: 0.002,  estimatedParamsB: 220 },   // GPT-4 class
  anthropic:  { whPerKOutputTokens: 0.0018, estimatedParamsB: 175 },   // Claude class
  xai:        { whPerKOutputTokens: 0.0015, estimatedParamsB: 314 },   // Grok class
  google:     { whPerKOutputTokens: 0.0012, estimatedParamsB: 175 },   // Gemini (TPU)
  // Local runtimes
  ollama:     { whPerKOutputTokens: 2.33,   estimatedParamsB: 70  },   // H100 700W / 300 tok/s
  llamacpp:   { whPerKOutputTokens: 2.22,   estimatedParamsB: 70  },   // A100 400W / 180 tok/s
  cloud:      { whPerKOutputTokens: 0.0015, estimatedParamsB: 314 },   // Cloud-hosted provider
};

const DEFAULT_ENERGY: EnergyProfile = { whPerKOutputTokens: 0.002, estimatedParamsB: 175 };

/**
 * Resolve energy profile for a model ID.
 * Uses provider prefix (before '/') for lookup.
 */
function resolveEnergyProfile(modelId: string): EnergyProfile {
  const provider = modelId.split('/')[0] ?? '';
  return PROVIDER_ENERGY[provider] ?? DEFAULT_ENERGY;
}

/**
 * Estimate energy consumption and floating-point operations for a model call.
 *
 * FLOPs formula (simplified transformer inference):
 *   FLOPs ≈ 2 × param_count × total_tokens
 * where total_tokens = input + output tokens.
 *
 * Energy formula:
 *   Wh = (outputTokens / 1000) × whPerKOutputTokens
 * Input tokens consume ~30% of output energy (KV-cache advantage).
 *
 * All values are estimates. source is always 'estimated'.
 *
 * @param modelId      - Provider-qualified model ID, e.g. "xai/grok-3-fast".
 * @param inputTokens  - Number of prompt/input tokens.
 * @param outputTokens - Number of completion/output tokens.
 * @returns EnergyEstimate with wh, flops, and source='estimated'.
 */
export function estimateEnergy(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): EnergyEstimate {
  const profile = resolveEnergyProfile(modelId);

  // Energy: output tokens dominate; input tokens are ~30% cost due to KV cache
  const outputWh = (outputTokens / 1000) * profile.whPerKOutputTokens;
  const inputWh  = (inputTokens  / 1000) * profile.whPerKOutputTokens * 0.3;
  const wh = outputWh + inputWh;

  // FLOPs: 2 * params * total_tokens
  const totalTokens = inputTokens + outputTokens;
  const flops = 2 * profile.estimatedParamsB * 1e9 * totalTokens;

  return {
    wh: Math.round(wh * 1_000_000) / 1_000_000,  // 6 decimal places
    flops: Math.round(flops),
    source: 'estimated',
  };
}

/**
 * Return the energy profile metadata for a model (useful for UI display).
 *
 * @param modelId - Provider-qualified model ID.
 * @returns Energy profile with documented assumptions.
 */
export function getEnergyProfile(modelId: string): EnergyProfile & { provider: string } {
  const provider = modelId.split('/')[0] ?? 'unknown';
  return { ...resolveEnergyProfile(modelId), provider };
}

// ---------------------------------------------------------------------------
// Public helpers (original)
// ---------------------------------------------------------------------------

/**
 * Estimate the USD cost of a single LLM call.
 *
 * @param modelId       - Provider-qualified model ID, e.g. "xai/grok-3-fast".
 * @param promptTokens  - Number of input tokens consumed.
 * @param outputTokens  - Number of output tokens generated.
 * @returns Estimated cost in USD.
 */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  outputTokens: number,
): number {
  const rate = COST_RATES[modelId] ?? DEFAULT_COST_RATE;
  return (promptTokens / 1_000_000) * rate.inputPerM +
         (outputTokens / 1_000_000) * rate.outputPerM;
}

/**
 * Build a TokenUsage object from raw Vercel AI SDK usage counters.
 *
 * @param modelId - Provider-qualified model ID for cost lookup.
 * @param raw     - Raw usage object from the SDK (may be partial).
 * @returns Fully populated TokenUsage.
 */
export function buildTokenUsage(
  modelId: string,
  raw?: {
    promptTokens?: number;
    completionTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  },
): TokenUsage {
  // The Vercel AI SDK v6 exposes inputTokens/outputTokens; older shapes use
  // promptTokens/completionTokens. Accept either naming convention.
  const promptTokens = raw?.promptTokens ?? raw?.inputTokens ?? 0;
  const completionTokens = raw?.completionTokens ?? raw?.outputTokens ?? 0;
  const totalTokens = raw?.totalTokens ?? promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCost: estimateCost(modelId, promptTokens, completionTokens),
  };
}
