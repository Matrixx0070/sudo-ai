/**
 * @file types.ts
 * @description Local types for the embodied-state subsystem of SUDO-AI v4.
 *
 * `RawSystemMetrics` captures the raw OS/hardware readings collected by
 * sampler.ts before any normalisation.  `BodyStateModifier` is a strategy
 * interface that downstream consumers use to adjust behaviour parameters
 * (processing depth, LLM temperature, thought interval) based on the current
 * BodyState.
 *
 * Neither interface carries logic — all computation lives in mapper.ts.
 */

import type { BodyState } from '../types.js';

// ---------------------------------------------------------------------------
// RawSystemMetrics
// ---------------------------------------------------------------------------

/**
 * Unprocessed hardware and OS metrics collected at a single sampling instant.
 * All byte values are in bytes; all timestamps/durations are in SI units as
 * noted per field.
 */
export interface RawSystemMetrics {
  /** 1-minute CPU load average (from os.loadavg()[0]). */
  cpuLoadAvg1m: number;
  /** Logical CPU count (from os.cpus().length). */
  cpuCount: number;
  /** Total installed RAM in bytes. */
  totalMemBytes: number;
  /** Available (free) RAM in bytes. */
  freeMemBytes: number;
  /** Total disk capacity for the root filesystem in bytes. */
  diskTotalBytes: number;
  /** Disk space currently in use on the root filesystem in bytes. */
  diskUsedBytes: number;
  /**
   * Whether an external DNS query to 1.1.1.1 succeeded within 3 s.
   * false means the system is offline or DNS is unreachable.
   */
  networkReachable: boolean;
  /**
   * Round-trip latency for the DNS probe in milliseconds.
   * null when networkReachable is false.
   */
  pingLatencyMs: number | null;
  /** System uptime in seconds (from os.uptime()). */
  uptimeSeconds: number;
}

// ---------------------------------------------------------------------------
// BodyStateModifier
// ---------------------------------------------------------------------------

/**
 * Strategy interface for translating a BodyState into scalar adjustments that
 * downstream subsystems apply to their runtime parameters.
 *
 * All return values are bounded; callers may rely on the stated ranges without
 * further clamping.
 */
export interface BodyStateModifier {
  /**
   * Multiplier for how deeply the system should process a thought.
   * Range: [0.5, 1.5] — 1.0 is baseline, >1.0 is deeper, <1.0 is shallower.
   */
  getProcessingDepthMultiplier(state: BodyState): number;

  /**
   * Delta to add to the LLM temperature setting.
   * Range: [-0.2, 0.2] — negative means more focused, positive more creative.
   */
  getTemperatureDelta(state: BodyState): number;

  /**
   * Multiplier applied to the base thought-generation interval.
   * Range: [0.5, 3.0] — low energy stretches intervals, high energy compresses.
   */
  getThoughtIntervalMultiplier(state: BodyState): number;
}
