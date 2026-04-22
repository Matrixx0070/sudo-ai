/**
 * @file mapper.ts
 * @description Pure mapping layer for the embodied-state subsystem of
 * SUDO-AI v4.
 *
 * Converts RawSystemMetrics into a normalised BodyState and provides a
 * concrete BodyStateModifier implementation.  No I/O, no side-effects —
 * every function is a pure transformation.
 *
 * Formulas:
 *   energy       = clamp(1 - cpuLoadAvg1m / cpuCount, 0, 1)
 *   clarity      = freeMemBytes / totalMemBytes
 *   fullness     = diskUsedBytes / diskTotalBytes
 *   connectivity = networkReachable ? clamp(1 - pingLatencyMs/1000, 0.5, 1) : 0
 *   continuity   = clamp(log(1 + uptimeSec/3600) / log(25), 0, 1)
 */

import type { BodyState } from '../types.js';
import type { RawSystemMetrics, BodyStateModifier } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a number to [lo, hi].
 *
 * @param value - The value to clamp.
 * @param lo    - Lower bound (inclusive).
 * @param hi    - Upper bound (inclusive).
 * @returns Clamped value.
 */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/** Natural log of 25 — pre-computed for the continuity formula. */
const LOG_25 = Math.log(25);

// ---------------------------------------------------------------------------
// mapToBodyState
// ---------------------------------------------------------------------------

/**
 * Map a `RawSystemMetrics` snapshot to a normalised `BodyState`.
 *
 * All output fields are in [0, 1]; `sampledAt` is an ISO-8601 UTC string
 * generated at call time.
 *
 * @param raw - Raw metrics from `sampleMetrics()`.
 * @returns A fully populated `BodyState`.
 */
export function mapToBodyState(raw: RawSystemMetrics): BodyState {
  // --- energy: inverse CPU pressure ---
  // Guard against cpuCount === 0 (should not happen, sampler clamps to 1).
  const cpuCount = raw.cpuCount > 0 ? raw.cpuCount : 1;
  const energy = clamp(1 - raw.cpuLoadAvg1m / cpuCount, 0, 1);

  // --- clarity: free-memory ratio ---
  const totalMem = raw.totalMemBytes > 0 ? raw.totalMemBytes : 1;
  const clarity = clamp(raw.freeMemBytes / totalMem, 0, 1);

  // --- fullness: disk utilisation ratio ---
  const diskTotal = raw.diskTotalBytes > 0 ? raw.diskTotalBytes : 1;
  const fullness = clamp(raw.diskUsedBytes / diskTotal, 0, 1);

  // --- connectivity: network presence scaled by latency ---
  let connectivity: number;
  if (!raw.networkReachable || raw.pingLatencyMs === null) {
    connectivity = 0;
  } else {
    connectivity = clamp(1 - raw.pingLatencyMs / 1_000, 0.5, 1);
  }

  // --- continuity: logarithmic uptime saturation (saturates at ~24 hours) ---
  const uptimeHours = raw.uptimeSeconds / 3_600;
  const continuity = clamp(Math.log(1 + uptimeHours) / LOG_25, 0, 1);

  return {
    energy,
    clarity,
    fullness,
    connectivity,
    continuity,
    sampledAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// BodyStateModifier implementation
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of `BodyStateModifier`.
 * Stateless — a single instance may be shared across the application.
 */
class DefaultBodyStateModifier implements BodyStateModifier {
  /**
   * Processing depth multiplier: average of energy and clarity, linearly
   * scaled from [0, 1] to [0.5, 1.5].
   *
   * avg = 0   → multiplier = 0.5  (minimal processing)
   * avg = 0.5 → multiplier = 1.0  (baseline)
   * avg = 1   → multiplier = 1.5  (maximum depth)
   */
  getProcessingDepthMultiplier(state: BodyState): number {
    const avg = (state.energy + state.clarity) / 2;
    return clamp(0.5 + avg, 0.5, 1.5);
  }

  /**
   * Temperature delta:
   *   energy < 0.3 → -0.1  (more focused/deterministic when resource-poor)
   *   energy > 0.7 → +0.1  (more creative when resource-rich)
   *   otherwise    →  0.0  (neutral)
   */
  getTemperatureDelta(state: BodyState): number {
    if (state.energy < 0.3) return -0.1;
    if (state.energy > 0.7) return 0.1;
    return 0;
  }

  /**
   * Thought interval multiplier: inverse of energy, scaled to [0.5, 3.0].
   *
   * energy = 0   → 3.0  (very slow thoughts when exhausted)
   * energy = 0.5 → 1.75 (moderate pace)
   * energy = 1   → 0.5  (rapid fire when fully energised)
   *
   * Formula: 3.0 - (energy * 2.5), then clamped.
   */
  getThoughtIntervalMultiplier(state: BodyState): number {
    return clamp(3.0 - state.energy * 2.5, 0.5, 3.0);
  }
}

/**
 * Factory that returns a shared `BodyStateModifier` instance.
 * The modifier is stateless so a singleton is sufficient.
 */
const _sharedModifier = new DefaultBodyStateModifier();

export function createBodyStateModifier(): BodyStateModifier {
  return _sharedModifier;
}
