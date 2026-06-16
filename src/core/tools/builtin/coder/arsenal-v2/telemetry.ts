/**
 * @file arsenal-v2/telemetry.ts
 * @description Append-only JSONL telemetry for arsenal-v2 retry attempts.
 *
 * One JSON object per line, one line per attempt. Designed for the slice-6
 * cascade work and the slice-7 "rank models by recent success rate"
 * follow-up — the file is small, append-only, and trivially `tail -f`-able.
 *
 * Why JSONL not SQLite:
 *   - Zero new dependencies (no better-sqlite3 / sqlite3).
 *   - Append-only writes are crash-safe-ish: a partial last line is
 *     discardable; everything before it stays intact.
 *   - Easy to test against a tmpdir with the same primitives as the rest
 *     of the slice (fs / readFile / split).
 *
 * Read paths (queries for slice 7) deliberately not implemented yet —
 * this slice just lays the data.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('coder.arsenal-v2.telemetry');

export interface TelemetryRecord {
  /** Epoch milliseconds at attempt completion. */
  ts: number;
  /** Tool-context session id (optional — undefined in unit tests). */
  sessionId?: string;
  /** arsenal-v2 mode (fix / build / refactor / test / ...). */
  mode: string;
  /** 1-based attempt index within this invocation. */
  attemptIndex: number;
  /** maxAttempts budget at invocation time. */
  maxAttempts: number;
  /** Model id used for THIS attempt's patcher call. */
  model: string;
  /** Patch op outcome counts for this attempt. */
  applied: number;
  skipped: number;
  failed: number;
  /** tsc result post-patch. */
  tscClean: boolean;
  tscErrorCount: number;
  /**
   * Tests result. `null` when tests were skipped (no files / disabled /
   * binary missing) or weren't run because zero ops applied.
   */
  testsPassed: boolean | null;
  /** Critic verdict for this attempt; null when critic didn't run. */
  criticVerdict: 'approve' | 'needs_revision' | 'error' | null;
  /** Per-attempt success — same shape as the tool's final success bool. */
  success: boolean;
  /** Wall-clock duration of this attempt (ms) — caller measures it. */
  durationMs: number;
}

export interface RecordOptions {
  /** Absolute path to the JSONL log file. */
  path: string;
  /** Override for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Append a single attempt record to the JSONL log. Never throws — any
 * filesystem failure is logged and silently swallowed, on the principle
 * that telemetry is observability infrastructure and must not break the
 * thing it's observing.
 *
 * Opt-out: `SUDO_ARSENAL_V2_TELEMETRY=0` short-circuits without writing.
 */
export function recordAttempt(record: TelemetryRecord, opts: RecordOptions): void {
  const env = opts.env ?? process.env;
  if (env['SUDO_ARSENAL_V2_TELEMETRY'] === '0') return;
  try {
    mkdirSync(path.dirname(opts.path), { recursive: true });
    appendFileSync(opts.path, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ path: opts.path, err: detail }, 'telemetry write failed');
  }
}
