/**
 * @file arsenal-v2/stats.ts
 * @description Read the slice-6 telemetry JSONL and compute per-model
 * stats; use those stats to reorder the active cascade at invocation
 * time so historically-better models go first.
 *
 * Scoring (slice 7 — deliberately simple):
 *   score = approvals / attempts   when attempts >= minSamples
 *   score = defaultScore           otherwise (unknown — neither boost
 *                                  nor penalize)
 *
 * Sort is stable on the original cascade index, so equal-score models
 * and unknowns preserve the order the caller declared. This matters
 * when a user explicitly puts a preferred model first; if it has no
 * history we don't randomly shuffle it.
 *
 * Out of scope (slice 8+): Wilson lower bound / beta-distribution
 * smoothing, per-mode stats, JSONL rotation, multi-day decay.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('coder.arsenal-v2.stats');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ModelStats {
  model: string;
  attempts: number;
  /** criticVerdict === 'approve' count. */
  approvals: number;
  /** criticVerdict === 'needs_revision' count. */
  rejections: number;
  /** criticVerdict === 'error' or null count. */
  errors: number;
  /** record.success === true count. */
  successes: number;
  /** Mean wall-clock per attempt (ms) across the window. */
  avgDurationMs: number;
  /** Max ts across the window — newest attempt observation. */
  lastSeen: number;
}

export interface LoadStatsOptions {
  /** Absolute path to the JSONL log. */
  path: string;
  /** Window size in ms. Default 7 days. */
  windowMs?: number;
  /** Injected clock (ms). Default Date.now(). */
  now?: number;
}

/**
 * Walk the JSONL file, parse line-by-line, aggregate per-model stats for
 * the trailing window. Tolerant of malformed lines (skipped, no throw)
 * and missing files (returns empty Map).
 *
 * Collapsed view — all modes are summed together. For per-mode ranking
 * (slice 9), use {@link loadRecentStatsByMode}.
 */
export function loadRecentStats(opts: LoadStatsOptions): Map<string, ModelStats> {
  const out = new Map<string, ModelStats>();
  const durationSums = new Map<string, number>();
  walkRows(opts, (row) => {
    accumulate(out, durationSums, row.model, row);
  });
  finalizeAverages(out, durationSums);
  return out;
}

/**
 * Same walk + aggregation as {@link loadRecentStats}, but bucketed by
 * `mode` first, then `model`. The slice-9 reorder uses this to keep a
 * model's `refactor` performance from dragging its `fix` ranking.
 *
 * Rows without a `mode` field are skipped (defensive — slice-6 writers
 * always include it).
 */
export function loadRecentStatsByMode(
  opts: LoadStatsOptions,
): Map<string, Map<string, ModelStats>> {
  const out = new Map<string, Map<string, ModelStats>>();
  const durationSums = new Map<string, Map<string, number>>(); // mode -> model -> sum
  walkRows(opts, (row) => {
    if (typeof row.mode !== 'string' || !row.mode) return;
    let modelMap = out.get(row.mode);
    let durMap = durationSums.get(row.mode);
    if (!modelMap) {
      modelMap = new Map();
      out.set(row.mode, modelMap);
    }
    if (!durMap) {
      durMap = new Map();
      durationSums.set(row.mode, durMap);
    }
    accumulate(modelMap, durMap, row.model, row);
  });
  for (const [mode, modelMap] of out) {
    finalizeAverages(modelMap, durationSums.get(mode) ?? new Map());
  }
  return out;
}

/**
 * Shared row iterator — reads the JSONL, filters by window + required
 * fields, hands each surviving row to the caller. Centralizes the
 * read/parse/skip logic so {@link loadRecentStats} and
 * {@link loadRecentStatsByMode} stay in lockstep.
 */
function walkRows(opts: LoadStatsOptions, onRow: (row: TelemetryRow) => void): void {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.windowMs ?? SEVEN_DAYS_MS);

  if (!existsSync(opts.path)) return;

  let raw: string;
  try {
    raw = readFileSync(opts.path, 'utf-8');
  } catch (err) {
    logger.warn({ path: opts.path, err: err instanceof Error ? err.message : String(err) }, 'telemetry read failed');
    return;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Partial<TelemetryRow> | null = null;
    try {
      row = JSON.parse(trimmed) as Partial<TelemetryRow>;
    } catch {
      // Skip malformed lines.
      continue;
    }
    if (!row || typeof row.model !== 'string' || typeof row.ts !== 'number') continue;
    if (row.ts < cutoff) continue;
    onRow(row as TelemetryRow);
  }
}

function accumulate(
  modelMap: Map<string, ModelStats>,
  durationSums: Map<string, number>,
  model: string,
  row: TelemetryRow,
): void {
  let s = modelMap.get(model);
  if (!s) {
    s = {
      model,
      attempts: 0,
      approvals: 0,
      rejections: 0,
      errors: 0,
      successes: 0,
      avgDurationMs: 0,
      lastSeen: 0,
    };
    modelMap.set(model, s);
    durationSums.set(model, 0);
  }
  s.attempts += 1;
  if (row.criticVerdict === 'approve') s.approvals += 1;
  else if (row.criticVerdict === 'needs_revision') s.rejections += 1;
  else s.errors += 1; // 'error' or null
  if (row.success === true) s.successes += 1;
  if (typeof row.durationMs === 'number' && Number.isFinite(row.durationMs)) {
    durationSums.set(model, (durationSums.get(model) ?? 0) + row.durationMs);
  }
  if (row.ts > s.lastSeen) s.lastSeen = row.ts;
}

function finalizeAverages(
  modelMap: Map<string, ModelStats>,
  durationSums: Map<string, number>,
): void {
  for (const [model, s] of modelMap) {
    const sum = durationSums.get(model) ?? 0;
    s.avgDurationMs = s.attempts > 0 ? Math.round(sum / s.attempts) : 0;
  }
}

export interface RankOptions {
  /** Minimum attempts before a model's score is used. Default 3. */
  minSamples?: number;
  /** Score assigned to unknown / under-sampled models. Default 0.5. */
  defaultScore?: number;
}

/**
 * Reorder the cascade so models with the best approval rate (over the
 * given stats) go first. Cascades of length ≤ 1 are returned unchanged.
 * Sort is stable on original-cascade-index — equal-score and unknown
 * models preserve the caller's order.
 */
export function rankCascade(
  cascade: string[],
  stats: Map<string, ModelStats>,
  opts: RankOptions = {},
): string[] {
  if (cascade.length <= 1) return cascade.slice();

  const minSamples = opts.minSamples ?? 3;
  const defaultScore = opts.defaultScore ?? 0.5;

  const scored = cascade.map((model, index) => {
    const s = stats.get(model);
    const isKnown = !!s && s.attempts >= minSamples;
    const score = isKnown && s!.attempts > 0 ? s!.approvals / s!.attempts : defaultScore;
    return { model, index, score, isKnown };
  });

  // Stable sort by score desc, original index asc as tiebreaker. JS's
  // Array.prototype.sort is stable as of ES2019; we still pass the
  // tiebreaker explicitly so behavior is obvious to readers.
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored.map((s) => s.model);
}

/** Subset of slice-6 TelemetryRecord we actually inspect. */
interface TelemetryRow {
  ts: number;
  /** arsenal-v2 mode — added to the walker in slice 9 for per-mode bucketing. */
  mode: string;
  model: string;
  criticVerdict: 'approve' | 'needs_revision' | 'error' | null;
  success: boolean;
  durationMs: number;
}
