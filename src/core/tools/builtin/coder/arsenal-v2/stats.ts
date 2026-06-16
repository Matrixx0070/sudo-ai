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
/** Default half-life for slice-10 decay weighting (3 days). */
const DEFAULT_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
/** Wilson z (slice 10). 1.0 = 84% CI — calibrated for small-sample ranking. */
const DEFAULT_WILSON_Z = 1.0;

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
  /**
   * Slice 10 — decay-weighted attempt sum. Each row contributes
   * exp(-(now - row.ts) / halfLifeMs) to this total. Recent rows dominate.
   */
  weightedAttempts: number;
  /** Slice 10 — same weighting as weightedAttempts, but only approvals. */
  weightedApprovals: number;
}

export interface LoadStatsOptions {
  /** Absolute path to the JSONL log. */
  path: string;
  /** Window size in ms. Default 7 days. */
  windowMs?: number;
  /** Injected clock (ms). Default Date.now(). */
  now?: number;
  /**
   * Slice 10 — half-life for the exponential row weighting (ms). Default 3
   * days. A row at age 0 has weight 1; at age = halfLife, weight 0.5; at
   * age = 2 × halfLife, weight 0.25; etc.
   */
  halfLifeMs?: number;
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
  walkRows(opts, (row, weight) => {
    accumulate(out, durationSums, row.model, row, weight);
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
  walkRows(opts, (row, weight) => {
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
    accumulate(modelMap, durMap, row.model, row, weight);
  });
  for (const [mode, modelMap] of out) {
    finalizeAverages(modelMap, durationSums.get(mode) ?? new Map());
  }
  return out;
}

/**
 * Shared row iterator — reads the JSONL, filters by window + required
 * fields, computes the slice-10 decay weight per row, then hands the
 * (row, weight) pair to the caller. Centralizes the read/parse/skip/
 * weight logic so {@link loadRecentStats} and {@link loadRecentStatsByMode}
 * stay in lockstep.
 */
function walkRows(
  opts: LoadStatsOptions,
  onRow: (row: TelemetryRow, weight: number) => void,
): void {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.windowMs ?? SEVEN_DAYS_MS);
  const halfLifeMs = opts.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;

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
    const age = Math.max(0, now - row.ts);
    const weight = halfLifeMs > 0 ? Math.exp(-(age * Math.LN2) / halfLifeMs) : 1;
    onRow(row as TelemetryRow, weight);
  }
}

function accumulate(
  modelMap: Map<string, ModelStats>,
  durationSums: Map<string, number>,
  model: string,
  row: TelemetryRow,
  weight: number,
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
      weightedAttempts: 0,
      weightedApprovals: 0,
    };
    modelMap.set(model, s);
    durationSums.set(model, 0);
  }
  s.attempts += 1;
  s.weightedAttempts += weight;
  if (row.criticVerdict === 'approve') {
    s.approvals += 1;
    s.weightedApprovals += weight;
  } else if (row.criticVerdict === 'needs_revision') {
    s.rejections += 1;
  } else {
    s.errors += 1; // 'error' or null
  }
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

/**
 * Slice 12 — a mode similarity matrix.
 *
 *   simMatrix[currentMode][otherMode] = weight in [0, 1]
 *
 * Used by {@link weightedCollapseByMode} to blend the current mode's
 * cross-mode evidence with a recency that reflects relatedness rather
 * than the flat global average from slice 11. Missing entries are
 * treated as 0 (no contribution). Self-similarity is irrelevant — the
 * current mode's own data already feeds the mode-specific score, so
 * the weighted collapse explicitly skips it.
 */
export type ModeSimilarityMatrix = Record<string, Record<string, number>>;

/**
 * Hand-crafted similarity prior. Two clusters:
 *   - Code-writing modes (fix / build / refactor / test) — mutually
 *     similar at ≥ 0.4. A model that writes good code under one of
 *     these will probably write good code under another.
 *   - Read-only modes (review / analyze / explain) — mutually similar
 *     at ≥ 0.5.
 *   - Cross-cluster pairs cap at 0.3 — different jobs, different
 *     model strengths.
 *
 * Override at runtime via {@link parseModeSimilarityEnv} fed from
 * `SUDO_ARSENAL_V2_MODE_SIMILARITY` (JSON).
 */
export const DEFAULT_MODE_SIMILARITY: ModeSimilarityMatrix = {
  fix:      { build: 0.6, refactor: 0.7, test: 0.4, review: 0.2, analyze: 0.2, explain: 0.1 },
  build:    { fix: 0.6, refactor: 0.5, test: 0.5, review: 0.2, analyze: 0.2, explain: 0.1 },
  refactor: { fix: 0.7, build: 0.5, test: 0.4, review: 0.3, analyze: 0.3, explain: 0.1 },
  test:     { fix: 0.4, build: 0.5, refactor: 0.4, review: 0.2, analyze: 0.2, explain: 0.1 },
  review:   { fix: 0.2, build: 0.2, refactor: 0.3, test: 0.2, analyze: 0.7, explain: 0.5 },
  analyze:  { fix: 0.2, build: 0.2, refactor: 0.3, test: 0.2, review: 0.7, explain: 0.6 },
  explain:  { fix: 0.1, build: 0.1, refactor: 0.1, test: 0.1, review: 0.5, analyze: 0.6 },
};

/**
 * Parse a `SUDO_ARSENAL_V2_MODE_SIMILARITY` JSON string into a matrix.
 * Returns `null` on missing / empty / malformed input — callers fall
 * back to {@link DEFAULT_MODE_SIMILARITY} when this returns `null`.
 *
 * Validation is permissive: any non-string-keyed entry or non-numeric
 * weight is dropped from that row. An entry with no valid weights
 * after filtering is also dropped.
 */
export function parseModeSimilarityEnv(raw: string | undefined): ModeSimilarityMatrix | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'mode similarity env parse failed');
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: ModeSimilarityMatrix = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const row: Record<string, number> = {};
    for (const [otherMode, weight] of Object.entries(v as Record<string, unknown>)) {
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) continue;
      row[otherMode] = Math.min(1, weight); // cap at 1 — weights >1 are noise
    }
    if (Object.keys(row).length > 0) out[k] = row;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Collapse the slice-9 per-mode stats into a single all-modes-summed
 * map. Slice 11 uses this as the "global" signal that `rankCascade`
 * blends with the mode-specific signal when a model is sparse in the
 * active mode but well-attested elsewhere.
 *
 * Counts and decay-weighted sums add directly. `avgDurationMs` becomes
 * the attempt-weighted mean across modes. `lastSeen` is the max
 * across modes.
 */
export function collapseByMode(
  byMode: Map<string, Map<string, ModelStats>>,
): Map<string, ModelStats> {
  const out = new Map<string, ModelStats>();
  for (const modelMap of byMode.values()) {
    for (const [model, s] of modelMap) {
      const agg = out.get(model);
      if (!agg) {
        // Defensive copy so callers can't mutate per-mode stats by reference.
        out.set(model, { ...s });
        continue;
      }
      // Attempt-weighted average of the durations BEFORE the counts merge,
      // so the denominator below reflects the post-merge attempts total.
      const sumDuration = agg.avgDurationMs * agg.attempts + s.avgDurationMs * s.attempts;
      agg.attempts += s.attempts;
      agg.approvals += s.approvals;
      agg.rejections += s.rejections;
      agg.errors += s.errors;
      agg.successes += s.successes;
      agg.weightedAttempts += s.weightedAttempts;
      agg.weightedApprovals += s.weightedApprovals;
      agg.avgDurationMs = agg.attempts > 0 ? Math.round(sumDuration / agg.attempts) : 0;
      if (s.lastSeen > agg.lastSeen) agg.lastSeen = s.lastSeen;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slice 13 — data-driven mode similarity
// ---------------------------------------------------------------------------

/** Default minimum per-model samples in a mode for it to contribute to Pearson. */
const DEFAULT_EMPIRICAL_MIN_SAMPLES = 3;
/** Default shrinkage constant for the empirical vs hand-crafted blend. */
const DEFAULT_SIM_BLEND_K = 5;

export interface EmpiricalSimilarityOptions {
  /**
   * Minimum (raw integer) attempts a model needs in BOTH modes of a pair
   * before its (rate, rate) point contributes to Pearson. Default 3.
   */
  minPerModelSamples?: number;
  /**
   * Slice 14 — Fisher z-score for the Pearson CI lower bound. Default
   * 1.0 (~84% CI), matching slice 10's Wilson calibration. Pass 1.96
   * for the textbook 95% CI if you want a heavier penalty on low-n
   * mode pairs.
   */
  z?: number;
}

export interface EmpiricalSimilarityResult {
  /** Pearson correlation per mode pair, clamped to [0, 1]. */
  matrix: ModeSimilarityMatrix;
  /** Per mode-pair, the number of models that contributed to the correlation. */
  sharedCounts: Map<string, Map<string, number>>;
}

/**
 * Compute Pearson correlation of per-model approval rates across every
 * pair of modes seen in `byMode`. Rates are the decay-weighted
 * `weightedApprovals / weightedAttempts` so slice-10's recency bias
 * flows through.
 *
 * For each (m1, m2) pair (m1 ≠ m2):
 *   - Walk models with `attempts >= minPerModelSamples` in both modes.
 *   - Build rate vectors v1 and v2 indexed by model.
 *   - similarity = max(0, Pearson(v1, v2)). Negative correlations
 *     are clamped to 0 because the matrix is defined on [0, 1].
 *   - When fewer than 2 models qualify, or when either mode's variance
 *     is zero, similarity is 0 (no signal).
 *
 * The result also includes `sharedCounts` — the per-pair number of
 * contributing models — which {@link blendSimilarity} uses as the
 * confidence weight when mixing empirical with the hand-crafted prior.
 */
export function computeEmpiricalSimilarity(
  byMode: Map<string, Map<string, ModelStats>>,
  opts: EmpiricalSimilarityOptions = {},
): EmpiricalSimilarityResult {
  const minPerModel = opts.minPerModelSamples ?? DEFAULT_EMPIRICAL_MIN_SAMPLES;
  const z = opts.z ?? DEFAULT_WILSON_Z;
  const matrix: ModeSimilarityMatrix = {};
  const sharedCounts = new Map<string, Map<string, number>>();
  const modes = Array.from(byMode.keys());

  for (const m1 of modes) {
    const row: Record<string, number> = {};
    const sharedRow = new Map<string, number>();
    matrix[m1] = row;
    sharedCounts.set(m1, sharedRow);

    for (const m2 of modes) {
      if (m1 === m2) continue;
      const stats1 = byMode.get(m1)!;
      const stats2 = byMode.get(m2)!;

      const rates1: number[] = [];
      const rates2: number[] = [];
      for (const [model, s1] of stats1) {
        if (s1.attempts < minPerModel || s1.weightedAttempts <= 0) continue;
        const s2 = stats2.get(model);
        if (!s2 || s2.attempts < minPerModel || s2.weightedAttempts <= 0) continue;
        rates1.push(s1.weightedApprovals / s1.weightedAttempts);
        rates2.push(s2.weightedApprovals / s2.weightedAttempts);
      }
      sharedRow.set(m2, rates1.length);
      // Slice 14: pearsonLowerBound enforces n >= 4; below that it
      // returns 0 and the entry is omitted, leaving the blend to fall
      // back to the slice-12 prior.
      const rLower = pearsonLowerBound(rates1, rates2, z);
      if (rLower > 0) row[m2] = rLower;
    }
  }
  return { matrix, sharedCounts };
}

export interface BlendSimilarityOptions {
  /**
   * Shrinkage constant for the empirical vs default blend. With `k`
   * shared models, w_empirical = k / (k + shrinkageK). Default 5: at
   * 5 shared models the empirical and default each weigh 50%. Higher
   * shrinkageK = trust empirical more slowly.
   */
  shrinkageK?: number;
}

/**
 * Per-pair blend of the empirical matrix with the hand-crafted prior.
 * Confidence weight grows with `sharedCounts[m1][m2]` (the number of
 * models that produced the empirical correlation for that pair).
 *
 * Result coverage is the UNION of pairs in either input — missing values
 * default to 0, so a pair present only in `defaults` keeps its prior
 * weight, and a pair present only in `empirical` (rare) starts from a
 * 0 prior and shrinks toward 0 with low shared-model counts.
 */
export function blendSimilarity(
  empirical: ModeSimilarityMatrix,
  defaults: ModeSimilarityMatrix,
  sharedCounts: Map<string, Map<string, number>>,
  opts: BlendSimilarityOptions = {},
): ModeSimilarityMatrix {
  const k = opts.shrinkageK ?? DEFAULT_SIM_BLEND_K;
  const out: ModeSimilarityMatrix = {};
  const modes = new Set([...Object.keys(empirical), ...Object.keys(defaults)]);
  for (const m1 of modes) {
    const row: Record<string, number> = {};
    const empRow = empirical[m1] ?? {};
    const defRow = defaults[m1] ?? {};
    const sharedRow = sharedCounts.get(m1) ?? new Map<string, number>();
    const otherModes = new Set([...Object.keys(empRow), ...Object.keys(defRow)]);
    for (const m2 of otherModes) {
      const empVal = empRow[m2] ?? 0;
      const defVal = defRow[m2] ?? 0;
      const shared = sharedRow.get(m2) ?? 0;
      const denom = shared + k;
      const wData = denom > 0 ? shared / denom : 0;
      row[m2] = wData * empVal + (1 - wData) * defVal;
    }
    if (Object.keys(row).length > 0) out[m1] = row;
  }
  return out;
}

/**
 * Convenience: compute the empirical matrix and blend it with the
 * provided defaults in one call. The typical production path —
 * `index.ts` calls this once per invocation.
 */
export function effectiveSimilarity(
  byMode: Map<string, Map<string, ModelStats>>,
  defaults: ModeSimilarityMatrix = DEFAULT_MODE_SIMILARITY,
  opts: EmpiricalSimilarityOptions & BlendSimilarityOptions = {},
): ModeSimilarityMatrix {
  const { matrix: empirical, sharedCounts } = computeEmpiricalSimilarity(byMode, opts);
  return blendSimilarity(empirical, defaults, sharedCounts, opts);
}

/**
 * Slice 14 — Fisher-z lower bound of the 1-sided CI on a Pearson
 * correlation. Stops "r = 0.9 from 3 shared models" contributing the
 * same weight as "r = 0.9 from 30" in the slice-13 blend.
 *
 * Method:
 *   1. Compute the raw point estimate r via {@link pearson}.
 *   2. Apply Fisher z-transform: z_r = atanh(r) = ½·ln((1+r)/(1-r)).
 *   3. Standard error: SE = 1 / √(n - 3). Requires n ≥ 4.
 *   4. Lower bound on z: z_lower = z_r - z · SE  (z parameter, default 1.0).
 *   5. Back-transform: r_lower = tanh(z_lower). Clamped to [0, 1].
 *
 * Edge cases:
 *   - n < 4 → 0. Fisher SE diverges at n = 3; falling back to the
 *     slice-12 hand-crafted prior via the blend is honest.
 *   - r ≤ 0 → 0. The matrix is defined on [0, 1]; anti-correlation
 *     carries no positive evidence.
 *   - r ≥ 1 → 1. Perfect correlation: tanh(∞) = 1.
 *
 * Worked example (z = 1.0):
 *   r = 0.9, n = 5    → r_lower ≈ 0.64    (large haircut)
 *   r = 0.9, n = 100  → r_lower ≈ 0.88    (small haircut)
 */
export function pearsonLowerBound(xs: number[], ys: number[], z = DEFAULT_WILSON_Z): number {
  if (xs.length < 4 || ys.length < 4) return 0;
  const r = pearson(xs, ys);
  if (!Number.isFinite(r) || r <= 0) return 0;
  if (r >= 1) return 1;
  const n = xs.length;
  const zr = 0.5 * Math.log((1 + r) / (1 - r)); // atanh
  const se = 1 / Math.sqrt(n - 3);
  const zLower = zr - z * se;
  const rLower = Math.tanh(zLower);
  return Math.max(0, Math.min(1, rLower));
}

/**
 * Pearson correlation of two equal-length numeric vectors. Returns 0
 * when n < 2 or when either vector has zero variance. Used internally
 * by {@link computeEmpiricalSimilarity}; exported for direct testing.
 */
export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i]!;
    sumY += ys[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return 0;
  return cov / Math.sqrt(varX * varY);
}

/**
 * Slice 12 — similarity-weighted collapse. Replaces slice-11's flat
 * `collapseByMode` average. For each non-current mode `M`, we add its
 * counts and weighted sums scaled by `simMatrix[currentMode][M]`.
 * Modes with weight 0 or missing from the matrix contribute nothing.
 *
 * The current mode is explicitly skipped — that data already feeds the
 * mode-specific score path in {@link rankCascade}. Mixing it back into
 * the "global" signal would double-weight the current mode.
 *
 * Fallbacks:
 *   - `currentMode` not in the matrix at all  → fall back to
 *     {@link collapseByMode} (flat slice-11 behavior).
 *   - Otherwise, fractional `attempts` are produced when 0 < weight <
 *     1. The gate in `rankCascade` runs on these fractional totals;
 *     Wilson's formula already tolerates real-valued inputs.
 */
export function weightedCollapseByMode(
  byMode: Map<string, Map<string, ModelStats>>,
  currentMode: string,
  simMatrix: ModeSimilarityMatrix = DEFAULT_MODE_SIMILARITY,
): Map<string, ModelStats> {
  const row = simMatrix[currentMode];
  if (!row) return collapseByMode(byMode);

  const out = new Map<string, ModelStats>();
  for (const [mode, modelMap] of byMode) {
    if (mode === currentMode) continue;
    const w = row[mode];
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) continue;
    for (const [model, s] of modelMap) {
      const agg = out.get(model);
      if (!agg) {
        out.set(model, {
          model,
          attempts: s.attempts * w,
          approvals: s.approvals * w,
          rejections: s.rejections * w,
          errors: s.errors * w,
          successes: s.successes * w,
          weightedAttempts: s.weightedAttempts * w,
          weightedApprovals: s.weightedApprovals * w,
          avgDurationMs: s.avgDurationMs,
          lastSeen: s.lastSeen,
        });
        continue;
      }
      const sumDur = agg.avgDurationMs * agg.attempts + s.avgDurationMs * s.attempts * w;
      agg.attempts += s.attempts * w;
      agg.approvals += s.approvals * w;
      agg.rejections += s.rejections * w;
      agg.errors += s.errors * w;
      agg.successes += s.successes * w;
      agg.weightedAttempts += s.weightedAttempts * w;
      agg.weightedApprovals += s.weightedApprovals * w;
      agg.avgDurationMs = agg.attempts > 0 ? Math.round(sumDur / agg.attempts) : 0;
      if (s.lastSeen > agg.lastSeen) agg.lastSeen = s.lastSeen;
    }
  }
  return out;
}

export interface RankOptions {
  /** Minimum (raw integer) attempts before a model's score is used. Default 3. */
  minSamples?: number;
  /** Score assigned to unknown / under-sampled models. Default 0.5. */
  defaultScore?: number;
  /**
   * Slice 10 — Wilson z-score for the confidence interval. Default 1.0
   * (~84% CI) — calibrated for small-sample ranking. Pass 1.96 for the
   * textbook 95% CI if you want a heavier penalty on low-n models.
   */
  z?: number;
  /**
   * Slice 11 — optional collapsed-across-modes stats. When provided, the
   * score blends the mode-specific Wilson lower bound with the global
   * Wilson lower bound, weighted by mode-specific sample count. Stops a
   * model with strong fix-mode history from being treated as fully
   * unknown for its first few refactor invocations.
   */
  globalStats?: Map<string, ModelStats>;
  /**
   * Slice 11 — shrinkage constant for the mode/global blend. With m
   * mode samples, mode weight = m / (m + modeShrinkageK). Default 10:
   * 0 mode samples → 100% global; 10 mode samples → 50/50; 30 mode
   * samples → 75% mode-weighted.
   */
  modeShrinkageK?: number;
}

/**
 * Reorder the cascade so models with the best lower-bound approval rate
 * (over the given stats) go first. Cascades of length ≤ 1 are returned
 * unchanged. Sort is stable on original-cascade-index — equal-score and
 * unknown models preserve the caller's order.
 *
 * Slice 10 — the score is now the Wilson lower-bound of approvals over
 * attempts using the slice-10 decay-WEIGHTED counts. This stops "100%
 * of 3 attempts" from outranking "95% of 100", and stops "approved 6
 * days ago" from counting equally with "approved this hour". The
 * raw-integer `attempts` is still the gate for known-vs-unknown.
 */
export function rankCascade(
  cascade: string[],
  stats: Map<string, ModelStats>,
  opts: RankOptions = {},
): string[] {
  if (cascade.length <= 1) return cascade.slice();

  const minSamples = opts.minSamples ?? 3;
  const defaultScore = opts.defaultScore ?? 0.5;
  const z = opts.z ?? DEFAULT_WILSON_Z;
  const globalStats = opts.globalStats;
  const k = opts.modeShrinkageK ?? 10;

  const scored = cascade.map((model, index) => {
    const sMode = stats.get(model);
    const sGlobal = globalStats?.get(model);
    // Total attempts seen anywhere — when global is provided that's the
    // sum across all modes; otherwise fall back to the mode-only count
    // (slice-10 semantics).
    const totalAttempts = sGlobal?.attempts ?? sMode?.attempts ?? 0;
    if (totalAttempts < minSamples) {
      return { model, index, score: defaultScore };
    }
    const modeScore = sMode && sMode.weightedAttempts > 0
      ? wilsonLowerBound(sMode.weightedApprovals, sMode.weightedAttempts, z)
      : null;
    const globalScore = sGlobal && sGlobal.weightedAttempts > 0
      ? wilsonLowerBound(sGlobal.weightedApprovals, sGlobal.weightedAttempts, z)
      : null;
    const score = blendScores(modeScore, globalScore, sMode?.attempts ?? 0, k, defaultScore);
    return { model, index, score };
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

/**
 * Slice 11 — combine the mode-specific Wilson score with the global
 * (collapsed-across-modes) Wilson score using a shrinkage weight.
 *
 *   w_mode = modeAttempts / (modeAttempts + k)
 *   score  = w_mode * modeScore + (1 - w_mode) * globalScore
 *
 * Cases:
 *   - both null         → defaultScore (caller should also have gated this)
 *   - only modeScore    → modeScore   (no global signal available)
 *   - only globalScore  → globalScore (no mode data — pure global)
 *   - both present      → linear blend
 *
 * Exported for direct testing; production callers use it through
 * {@link rankCascade}.
 */
export function blendScores(
  modeScore: number | null,
  globalScore: number | null,
  modeAttempts: number,
  k: number,
  defaultScore: number,
): number {
  if (modeScore === null && globalScore === null) return defaultScore;
  if (modeScore === null) return globalScore!;
  if (globalScore === null) return modeScore;
  const denom = modeAttempts + k;
  if (denom <= 0) return globalScore; // pathological k — fall back to global
  const wMode = modeAttempts / denom;
  return wMode * modeScore + (1 - wMode) * globalScore;
}

/**
 * Lower bound of the Wilson score interval for the proportion
 * `approvals / attempts`. Returns 0 when `attempts <= 0`. Tolerates the
 * slice-10 fractional (decay-weighted) inputs — the Wilson formula is
 * defined for real-valued `n` as well as integer counts.
 *
 * Reference: Wilson, E. B. (1927). "Probable inference, the law of
 * succession, and statistical inference." JASA 22(158): 209–212.
 */
export function wilsonLowerBound(approvals: number, attempts: number, z = DEFAULT_WILSON_Z): number {
  if (!Number.isFinite(attempts) || attempts <= 0) return 0;
  const n = attempts;
  const p = approvals / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
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
