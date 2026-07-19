/**
 * @file telemetry/usage-rollup.ts
 * @description BO8 / scorecard-S7 — per-day / per-type usage roll-up over the
 * LLM ledger (`gateway.db` `llm_calls`), plus a self-checking drift guard.
 *
 * These are PURE functions: rows in, aggregates out. No SQLite, no I/O, no
 * clock except the injectable `now`. The admin handler
 * (`src/core/api/admin/usage.handler.ts`) is the only place that touches the
 * database, read-only; it hands rows here.
 *
 * The drift guard re-sums the finished roll-up (per-day totals) and compares it
 * to a *direct* sum over the very same rows. On a correct roll-up the two agree
 * to within floating-point epsilon; we assert ≤1% so a partition/grouping bug
 * can never silently ship wrong numbers to the dashboard.
 *
 * Ledger columns consumed: ts (ISO-8601), caller, purpose, route, tokens_in,
 * tokens_out, tokens_cached, cost_usd. NULL numerics contribute 0 (a floor,
 * never a throw), mirroring `GatewayCallLog.daySpend`.
 */

/** One ledger row, exactly as SELECTed from `llm_calls` (snake_case columns). */
export interface UsageLedgerRow {
  ts: string;
  caller?: string | null;
  purpose?: string | null;
  route?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  tokens_cached?: number | null;
  cost_usd?: number | null;
}

/** Rolling window selector. `all` disables the lower time bound. */
export type UsageWindow = '30d' | '90d' | 'all';

/** Which column names the "type" dimension for the by-type breakdown. */
export type UsageDimension = 'caller' | 'purpose' | 'route';

/** Per-type slice within a single day (drill-down cell). */
export interface UsageTypeCell {
  key: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokens: number;
  cost: number;
}

/** One UTC day of usage, with its per-type drill-down. */
export interface UsageDay {
  date: string; // YYYY-MM-DD (UTC)
  calls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokens: number; // tokensIn + tokensOut
  cost: number;
  byType: UsageTypeCell[]; // sorted by cost desc, then key
}

/** Window-wide totals. */
export interface UsageTotals {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokens: number;
  cost: number;
}

/** Self-check: roll-up sums vs a direct sum over the same rows. */
export interface UsageDrift {
  rollupCost: number;
  directCost: number;
  costDriftPct: number;
  rollupTokens: number;
  directTokens: number;
  tokenDriftPct: number;
  /** true when BOTH drifts are ≤ `tolerancePct` (default 1%). */
  ok: boolean;
  tolerancePct: number;
}

/** Full roll-up payload returned to the admin endpoint / dashboard. */
export interface UsageRollup {
  window: UsageWindow;
  by: UsageDimension;
  sinceIso: string | null; // lower bound applied (null for 'all')
  generatedAt: string;
  days: UsageDay[]; // ascending by date
  byType: UsageTypeCell[]; // window-wide per-type, cost desc
  totals: UsageTotals;
  drift: UsageDrift;
}

export interface RollupOptions {
  window?: UsageWindow;
  by?: UsageDimension;
  /** Reference "now" for window math; defaults to current time. */
  now?: Date;
  /** Drift tolerance as a fraction (0.01 = 1%). */
  tolerancePct?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Finite number or 0 — the ledger floor convention. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Lower-bound ISO timestamp for a window, or null for `all`. 30d/90d count back
 * `n` whole days from `now` (inclusive of today's partial day).
 */
export function windowStartIso(window: UsageWindow, now: Date = new Date()): string | null {
  if (window === 'all') return null;
  const days = window === '90d' ? 90 : 30;
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/** The type-dimension key for a row, normalised. Missing → 'unknown'. */
function typeKey(row: UsageLedgerRow, by: UsageDimension): string {
  const raw = by === 'caller' ? row.caller : by === 'purpose' ? row.purpose : row.route;
  const s = (raw ?? '').toString().trim();
  return s.length > 0 ? s : 'unknown';
}

/** UTC date key (YYYY-MM-DD) from an ISO-8601 ts. Non-ISO → '' (dropped). */
function dayKey(ts: string): string {
  // ts is ISO-8601; the first 10 chars are the UTC calendar day.
  if (typeof ts !== 'string' || ts.length < 10) return '';
  const d = ts.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

function emptyCell(key: string): UsageTypeCell {
  return { key, calls: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, tokens: 0, cost: 0 };
}

function addToCell(cell: UsageTypeCell, row: UsageLedgerRow): void {
  const ti = num(row.tokens_in);
  const to = num(row.tokens_out);
  cell.calls += 1;
  cell.tokensIn += ti;
  cell.tokensOut += to;
  cell.tokensCached += num(row.tokens_cached);
  cell.tokens += ti + to;
  cell.cost += num(row.cost_usd);
}

function sortCells(cells: UsageTypeCell[]): UsageTypeCell[] {
  return cells.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.key.localeCompare(b.key));
}

/** Percent drift of `value` from `truth`; 0 when both are ~0. */
function driftPct(value: number, truth: number): number {
  const denom = Math.abs(truth);
  if (denom < 1e-12) return Math.abs(value) < 1e-9 ? 0 : 100;
  return (Math.abs(value - truth) / denom) * 100;
}

/**
 * Roll up ledger rows into per-day and per-type totals over a window, then
 * self-check the result against a direct sum of the same (windowed) rows.
 *
 * Rows are filtered to the window here (caller may also pre-filter in SQL —
 * doing it again is cheap and makes the drift check honest end-to-end).
 */
export function rollupUsage(rows: readonly UsageLedgerRow[], opts: RollupOptions = {}): UsageRollup {
  const window = opts.window ?? '30d';
  const by = opts.by ?? 'caller';
  const now = opts.now ?? new Date();
  const tolerancePct = opts.tolerancePct ?? 1;
  const sinceIso = windowStartIso(window, now);

  const dayMap = new Map<string, UsageDay>();
  const typeMap = new Map<string, UsageTypeCell>();
  const totals: UsageTotals = {
    calls: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, tokens: 0, cost: 0,
  };
  // Independent direct accumulators — NOT derived from the maps above, so the
  // drift check exercises a genuinely separate summation path.
  let directCost = 0;
  let directTokens = 0;

  for (const row of rows ?? []) {
    const date = dayKey(row.ts);
    if (!date) continue;
    if (sinceIso !== null && row.ts < sinceIso) continue;

    const ti = num(row.tokens_in);
    const to = num(row.tokens_out);
    const cost = num(row.cost_usd);
    directCost += cost;
    directTokens += ti + to;

    let day = dayMap.get(date);
    if (!day) {
      day = { date, calls: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, tokens: 0, cost: 0, byType: [] };
      dayMap.set(date, day);
    }
    day.calls += 1;
    day.tokensIn += ti;
    day.tokensOut += to;
    day.tokensCached += num(row.tokens_cached);
    day.tokens += ti + to;
    day.cost += cost;

    const key = typeKey(row, by);
    // Per-day-per-type cell (drill-down). Reuse a transient map on the day via
    // a parallel structure keyed in dayTypeMaps.
    let dayCell = day.byType.find((c) => c.key === key);
    if (!dayCell) {
      dayCell = emptyCell(key);
      day.byType.push(dayCell);
    }
    addToCell(dayCell, row);

    let typeCell = typeMap.get(key);
    if (!typeCell) {
      typeCell = emptyCell(key);
      typeMap.set(key, typeCell);
    }
    addToCell(typeCell, row);

    totals.calls += 1;
    totals.tokensIn += ti;
    totals.tokensOut += to;
    totals.tokensCached += num(row.tokens_cached);
    totals.tokens += ti + to;
    totals.cost += cost;
  }

  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of days) sortCells(d.byType);
  const byType = sortCells([...typeMap.values()]);

  // Drift: re-sum the FINISHED per-day roll-up and compare to the direct sums.
  let rollupCost = 0;
  let rollupTokens = 0;
  for (const d of days) {
    rollupCost += d.cost;
    rollupTokens += d.tokens;
  }
  const costDriftPct = driftPct(rollupCost, directCost);
  const tokenDriftPct = driftPct(rollupTokens, directTokens);

  return {
    window,
    by,
    sinceIso,
    generatedAt: now.toISOString(),
    days,
    byType,
    totals,
    drift: {
      rollupCost,
      directCost,
      costDriftPct,
      rollupTokens,
      directTokens,
      tokenDriftPct,
      ok: costDriftPct <= tolerancePct && tokenDriftPct <= tolerancePct,
      tolerancePct,
    },
  };
}
