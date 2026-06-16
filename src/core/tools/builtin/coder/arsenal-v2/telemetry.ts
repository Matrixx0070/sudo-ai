/**
 * @file arsenal-v2/telemetry.ts
 * @description Append-only JSONL telemetry for arsenal-v2 retry attempts.
 *
 * One JSON object per line, one line per attempt. Designed for the slice-6
 * cascade work and the slice-7 "rank models by recent success rate"
 * follow-up — the file is small, append-only, and trivially `tail -f`-able.
 *
 * Slice 8 added a size cap: after every append the file is statted, and
 * if it exceeds DEFAULT_MAX_BYTES (default 10MB) the oldest rows are
 * dropped to leave a tail of DEFAULT_RETAIN_BYTES (~7MB) — line-aligned,
 * so we never keep a half-row at the head. Truncate uses atomic
 * temp-write + rename so a crash mid-truncate leaves the original
 * intact.
 *
 * Why JSONL not SQLite:
 *   - Zero new dependencies (no better-sqlite3 / sqlite3).
 *   - Append-only writes are crash-safe-ish: a partial last line is
 *     discardable; everything before it stays intact.
 *   - Easy to test against a tmpdir with the same primitives as the rest
 *     of the slice (fs / readFile / split).
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('coder.arsenal-v2.telemetry');

/** Default upper bound on the JSONL file size before truncation kicks in. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** Bytes to retain after a truncate (line-aligned head). */
const DEFAULT_RETAIN_BYTES = 7 * 1024 * 1024;

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
  /** Override the slice-8 size cap. Default: DEFAULT_MAX_BYTES (10MB). */
  maxBytes?: number;
  /** Override the post-truncate tail size. Default: DEFAULT_RETAIN_BYTES (7MB). */
  retainBytes?: number;
}

/**
 * Append a single attempt record to the JSONL log. Never throws — any
 * filesystem failure is logged and silently swallowed, on the principle
 * that telemetry is observability infrastructure and must not break the
 * thing it's observing.
 *
 * Opt-out: `SUDO_ARSENAL_V2_TELEMETRY=0` short-circuits without writing.
 * Cap override: `SUDO_ARSENAL_V2_TELEMETRY_MAX_BYTES` (number) or per-
 * call `maxBytes` in {@link RecordOptions}.
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
    return;
  }

  // Slice 8: enforce the file size cap. Cheap stat → no read unless over.
  const maxBytes = resolveCap(opts.maxBytes, env['SUDO_ARSENAL_V2_TELEMETRY_MAX_BYTES'], DEFAULT_MAX_BYTES);
  const retainBytes = opts.retainBytes ?? Math.floor(maxBytes * 0.7);
  try {
    const size = statSync(opts.path).size;
    if (size > maxBytes) {
      truncateToTail(opts.path, retainBytes);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ path: opts.path, err: detail }, 'telemetry cap check failed');
  }
}

/**
 * Trim a JSONL file to its trailing `retainBytes` (line-aligned).
 *
 * Reads the last `retainBytes` of the file directly via `read()` to avoid
 * loading the full content into memory, finds the first newline boundary
 * in that window, and atomically rewrites the file with the post-newline
 * slice. The dropped prefix is discarded — `loadRecentStats` already
 * filters by `ts` within a window, so old rows beyond that window were
 * dead weight anyway.
 *
 * Safe on small files: returns without rewriting if the file is at or
 * below `retainBytes`. Idempotent: calling on an already-tail-sized
 * file is a no-op.
 *
 * Never throws — fs errors are logged. Atomic via temp + fsync + rename
 * so a crash mid-truncate leaves the original intact.
 */
export function truncateToTail(filePath: string, retainBytes: number): void {
  if (retainBytes <= 0) return;
  if (!existsSync(filePath)) return;

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (err) {
    logger.warn({ path: filePath, err: errMessage(err) }, 'truncate: stat failed');
    return;
  }
  if (size <= retainBytes) return;

  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(retainBytes);
    const start = size - retainBytes;
    const bytesRead = readSync(fd, buf, 0, retainBytes, start);
    closeSync(fd);
    fd = null;

    // Find the first newline inside the kept window so we don't keep a
    // partial leading line. We drop everything UP TO and including that
    // newline — what remains is guaranteed to be complete lines.
    // If there's no newline (one giant partial line) or the only
    // newline is at the very end (one partial line then EOL), the
    // result is empty. The next append will re-seed the file cleanly.
    const slice = buf.subarray(0, bytesRead);
    const nl = slice.indexOf(0x0a); // '\n'
    const trimmed = nl === -1 ? Buffer.alloc(0) : slice.subarray(nl + 1);

    // Atomic temp-write + rename — same pattern as the patch-applier.
    const tmp = `${filePath}.cap-tmp`;
    writeFileSync(tmp, trimmed);
    const tmpFd = openSync(tmp, 'r+');
    try { fsyncSync(tmpFd); } finally { closeSync(tmpFd); }
    renameSync(tmp, filePath);
  } catch (err) {
    logger.warn({ path: filePath, err: errMessage(err) }, 'truncate failed');
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* swallow */ }
    }
  }
}

function resolveCap(opt: number | undefined, envValue: string | undefined, fallback: number): number {
  if (typeof opt === 'number' && Number.isFinite(opt) && opt > 0) return opt;
  if (envValue) {
    const n = Number(envValue);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
