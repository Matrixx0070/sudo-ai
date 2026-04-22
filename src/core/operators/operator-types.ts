/**
 * @file operators/operator-types.ts
 * @description Re-exports OperatorManifest and related types from wave10-types.
 *
 * Wave 10 — Builder 3 (Config + Ops + UX)
 * Import from this file for all operator-related type usage.
 */

export type {
  OperatorManifest,
  OperatorSchedule,
  OperatorAgentConfig,
} from '../shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Runtime helper types (not in shared spec, needed by loader + scheduler)
// ---------------------------------------------------------------------------

/** Result of loading a single operator TOML file. */
export interface OperatorLoadResult {
  /** Absolute path to the TOML file. */
  filePath: string;
  /** Parsed manifest, or null if parsing failed. */
  manifest: import('../shared/wave10-types.js').OperatorManifest | null;
  /** Error message if parsing failed. */
  error?: string;
}

/** Registered scheduled operator with its interval/timer handle. */
export interface ScheduledOperator {
  manifest: import('../shared/wave10-types.js').OperatorManifest;
  /** Node.js timer handle (from setInterval or from cron wrapper). */
  handle: ReturnType<typeof setInterval>;
}

/** Callback invoked when an operator fires. */
export type OperatorFireCallback = (manifest: import('../shared/wave10-types.js').OperatorManifest) => Promise<void> | void;
