/**
 * @file tick.ts
 * @description Pure tick execution logic for the CognitiveStream.
 *
 * Extracted from stream.ts to keep each file under 300 lines.
 * Takes a TickContext bag (no class references) and returns the generated
 * thought or null on skip.
 */

import { createLogger } from '../../shared/logger.js';
import { genId } from '../../shared/utils.js';
import { analyzeEmotionalContent } from '../emotional-memory/analyzer.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { ThoughtTier } from '../types.js';
import { saveThought } from './store.js';
import { generateThought } from './thought-generator.js';
import type {
  ThoughtConfig,
  ThoughtContext,
  StreamBrainLike,
  BodyStateLike,
  SpreadingActivationLike,
  EmotionalStateLike,
  StreamThought,
} from './types.js';

const log = createLogger('consciousness:cognitive-stream:tick');

// ---------------------------------------------------------------------------
// TickContext — passed in by CognitiveStream on each tick
// ---------------------------------------------------------------------------

export interface TickContext {
  tickCount: number;
  cache: StreamThought[];         // reference to the stream's live cache
  cdb: ConsciousnessDB;
  brain: StreamBrainLike;
  embodied: BodyStateLike;
  spreading: SpreadingActivationLike;
  emotional: EmotionalStateLike;
  config: ThoughtConfig;
  currentThought: StreamThought | null;
  /**
   * Mutable differential-gate state, owned by the stream and carried across
   * ticks. When present, micro ticks whose cognitive state is unchanged since
   * the last generated thought are skipped (no brain call). Omit to disable.
   */
  gate?: GateState;
}

/** Cross-tick state for the differential gate. Lives on the CognitiveStream. */
export interface GateState {
  /** Signature of the last state that actually produced a brain call. */
  lastSignature: string | null;
  /** Consecutive ticks skipped since the last brain call. */
  skipStreak: number;
}

// ---------------------------------------------------------------------------
// Differential gate
// ---------------------------------------------------------------------------

/**
 * After this many consecutive skips the gate forces one tick through, so an
 * idle daemon still emits a periodic "heartbeat" thought and never goes
 * permanently silent.
 */
const GATE_FORCE_AFTER_SKIPS = 20;

/** Differential gate is on by default; `SUDO_CONSCIOUSNESS_GATE=0|false|off|no` disables it. */
function gateEnabled(): boolean {
  const v = process.env['SUDO_CONSCIOUSNESS_GATE'];
  if (v === undefined) return true;
  const s = v.trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
}

/**
 * Stable signature of the *external* cognitive state that drives a thought.
 *
 * Intentionally excludes `recentThoughts` (the stream's own output — always
 * changes after a thought) and raw `bodyState` floats like energy (which decay
 * continuously and would defeat the gate). Intensity is bucketed to one decimal
 * so micro float drift doesn't count as a change.
 */
export function computeStateSignature(ctx: ThoughtContext): string {
  const concepts = ctx.activeConcepts.join(',');
  const emotion = `${ctx.emotionalState.dominantEmotion}:${ctx.emotionalState.intensity.toFixed(1)}`;
  return `${concepts}|${emotion}`;
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

/**
 * Decide which processing depth this tick should use.
 * deepEveryN takes priority over mediumEveryN.
 */
export function resolveTier(tick: number, config: ThoughtConfig): ThoughtTier {
  const { deepEveryN, mediumEveryN } = config;
  if (deepEveryN > 0 && tick % deepEveryN === 0) return 'deep';
  if (mediumEveryN > 0 && tick % mediumEveryN === 0) return 'medium';
  return 'micro';
}

// ---------------------------------------------------------------------------
// Tier params
// ---------------------------------------------------------------------------

/** Return the model and maxTokens for a given tier from config. */
export function tierParams(
  tier: ThoughtTier,
  config: ThoughtConfig,
): { model: string; maxTokens: number } {
  switch (tier) {
    case 'micro':
      return { model: config.microModel, maxTokens: config.maxMicroTokens };
    case 'medium':
      return { model: config.mediumModel, maxTokens: config.maxMediumTokens };
    case 'deep':
      return { model: config.deepModel, maxTokens: config.maxDeepTokens };
    default: {
      const _exhaustive: never = tier;
      log.warn({ tier: String(_exhaustive) }, 'tierParams: unknown tier — defaulting to micro');
      return { model: config.microModel, maxTokens: config.maxMicroTokens };
    }
  }
}

// ---------------------------------------------------------------------------
// executeTick
// ---------------------------------------------------------------------------

/**
 * Execute one thought-generation cycle.
 *
 * @returns The newly created StreamThought, or null if the tick was skipped.
 */
export async function executeTick(ctx: TickContext): Promise<StreamThought | null> {
  const { tickCount, cache, cdb, brain, embodied, spreading, emotional, config, currentThought, gate } = ctx;

  // --- 1. Get body state ---
  const bodyState = embodied.getState();

  // --- 2. Determine tier ---
  const tier = resolveTier(tickCount, config);

  // --- 3. Active concepts ---
  const topNodes = spreading.getTopActive(10);
  const activeConcepts = topNodes.map((n) => n.id);

  // --- 4. Emotional state ---
  const emotionalState = emotional.getCurrentState();

  // --- 5. Build context ---
  const context = {
    tier,
    bodyState,
    activeConcepts,
    emotionalState,
    recentThoughts: cache.slice(-8),
  };

  // --- 5b. Differential gate (cost lever) ---
  // Skip the brain call when the external cognitive state is unchanged since
  // the last generated thought — a background thought rebuilt from an identical
  // state is wasted tokens. Only micro ticks are gated; medium/deep ticks are
  // infrequent, scheduled reflections and always run. A force-tick ceiling
  // guarantees a heartbeat so the stream never goes permanently silent. Keeps
  // the model fixed — this reduces calls, it does not downgrade cognition.
  if (gate && tier === 'micro' && gateEnabled()) {
    const signature = computeStateSignature(context);
    if (signature === gate.lastSignature && gate.skipStreak < GATE_FORCE_AFTER_SKIPS) {
      gate.skipStreak += 1;
      log.debug({ tick: tickCount, skipStreak: gate.skipStreak },
        'differential gate: state unchanged — tick skipped, no brain call');
      return null;
    }
    gate.lastSignature = signature;
    gate.skipStreak = 0;
  }

  // --- 6. Tier params ---
  const { model: configModel, maxTokens } = tierParams(tier, config);

  // Phase-1 cost lever (consciousness-tiering design): opt-in env override so
  // operators can route the cognitive-stream tier to a cheaper model (Haiku,
  // local Ollama, etc.) without editing config. Default behaviour unchanged
  // when the env is unset — `model` falls back to whatever tierParams picked.
  // Empty string is intentional: brain falls back to its own default.
  const envModel = process.env['SUDO_CONSCIOUSNESS_MODEL'];
  const model = envModel && envModel.trim().length > 0 ? envModel.trim() : configModel;

  // --- 7. Temperature: 0.9 + energy * 0.3, clamped [0.1, 1.2] ---
  const temperature = Math.max(0.1, Math.min(1.2, 0.9 + bodyState.energy * 0.3));

  // --- 8. Generate thought ---
  const generated = await generateThought(brain, tier, context, model, maxTokens, temperature);

  if (!generated.content || generated.content.trim().length === 0) {
    log.warn({ tick: tickCount, tier }, 'Empty content returned — tick skipped');
    return null;
  }

  // --- 9. Analyze emotion ---
  const newValence = analyzeEmotionalContent(generated.content, emotionalState);

  // --- 10. Build StreamThought ---
  const thought: StreamThought = {
    id: genId(),
    tier,
    content: generated.content,
    timestamp: new Date().toISOString(),
    source: 'stream',
    activatedConcepts: generated.concepts,
    emotionalValence: newValence,
    bodyStateSnapshot: bodyState,
    parentThoughtId: currentThought?.id ?? null,
    depth: currentThought ? currentThought.depth + 1 : 0,
  };

  // --- 11. Persist to DB ---
  saveThought(cdb, thought);

  // --- 12. Activate concepts in spreading network ---
  if (generated.concepts.length > 0) {
    try {
      spreading.activate(generated.concepts, 0.6);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg }, 'Failed to activate concepts');
    }
  }

  // --- 13. Update emotional state ---
  try {
    emotional.updateFromThought(thought);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ error: msg }, 'Failed to update emotional state from thought');
  }

  log.info(
    {
      tick: tickCount,
      tier,
      id: thought.id,
      contentPreview: thought.content.slice(0, 60),
      concepts: generated.concepts.length,
      emotion: newValence.dominantEmotion,
      temperature: temperature.toFixed(2),
    },
    'Thought generated',
  );

  return thought;
}
