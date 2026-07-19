/**
 * @file sessions/sessions-rollup.ts
 * @description BO9 / scorecard-S8 — pure roll-up that turns raw session records
 * into the display rows rendered by the inline admin dashboard's sessions table.
 *
 * These are PURE functions: records in, rows out. No SQLite, no I/O, no clock
 * except the injectable `now`. The admin handler
 * (`src/core/api/admin/system-sessions.handler.ts`) is the only place that
 * touches the database (read-only); it hands records here.
 *
 * Per-row we compute the OpenClaw-parity columns: key/id, kind (channel), state,
 * model, message count, last-activity age, and — the headline S8 column —
 * context fill (used tokens / window + %). Tokens are estimated from total
 * message characters (~4 chars/token) when an explicit token count is not
 * carried on the record; the estimate is clearly flagged in the payload.
 */

/** Session lifecycle state (mirrors sessions/types.ts SessionState). */
export type SessionRollupState = 'active' | 'compacted' | 'archived';

/** Raw per-session record handed to the roll-up (DB-shaped, but plain data). */
export interface SessionUsageRecord {
  id: string;
  /** Channel — also the group-by-kind dimension (web/telegram/cron/subagent/…). */
  kind: string;
  peerId?: string;
  state: SessionRollupState;
  model?: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-activity timestamp. */
  updatedAt: string;
  /** Total characters across the session's messages (drives the token estimate). */
  chars?: number | null;
  /** Explicit context-window tokens in use; overrides the char-based estimate. */
  usedTokens?: number | null;
  /** Number of persisted messages. */
  messageCount?: number | null;
  /** Per-session context window override (tokens). */
  contextWindow?: number | null;
}

/** One rendered row of the sessions table. */
export interface SessionRow {
  id: string;
  /** Display key: `${kind}:${peerId}` when a peer is known, else the id. */
  key: string;
  kind: string;
  peerId: string;
  state: SessionRollupState;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  /** Context tokens in use (explicit, or estimated from chars). */
  usedTokens: number;
  /** True when `usedTokens` was estimated from characters rather than measured. */
  tokensEstimated: boolean;
  /** Context window this session is measured against (tokens). */
  contextWindow: number;
  /** used / window * 100, rounded to 1 dp, floored at 0 (not clamped above). */
  contextPct: number;
  messageCount: number;
  /** Age of last activity in ms relative to the roll-up `now` (>= 0). */
  ageMs: number;
}

export type SessionSort = 'updated' | 'tokens' | 'messages' | 'key';
export type SessionGroupBy = 'none' | 'kind';

export interface SessionGroup {
  kind: string;
  count: number;
  usedTokens: number;
  rows: SessionRow[];
}

export interface SessionRollupTotals {
  count: number;
  active: number;
  compacted: number;
  archived: number;
  usedTokens: number;
  contextWindow: number;
  /** Mean context-fill % across rows (0 when empty). */
  avgContextPct: number;
}

export interface SessionRollup {
  generatedAt: string;
  sort: SessionSort;
  groupBy: SessionGroupBy;
  stateFilter: 'active' | 'compacted' | 'archived' | 'all';
  contextWindow: number;
  count: number;
  rows: SessionRow[];
  /** Populated only when groupBy === 'kind'; empty array otherwise. */
  groups: SessionGroup[];
  totals: SessionRollupTotals;
}

export interface SessionRollupOptions {
  sort?: SessionSort;
  groupBy?: SessionGroupBy;
  stateFilter?: 'active' | 'compacted' | 'archived' | 'all';
  /** Reference "now" for age math; defaults to current time. */
  now?: Date;
  /** Default context window (tokens) when a record carries no override. */
  contextWindow?: number;
}

/**
 * Default context window (tokens). Matches OpenClaw's 1,000,000-token display
 * and grok-4.x's window. Override via SUDO_SESSION_CONTEXT_WINDOW.
 */
export const DEFAULT_CONTEXT_WINDOW: number = (() => {
  const raw = Number(process.env['SUDO_SESSION_CONTEXT_WINDOW']);
  return Number.isInteger(raw) && raw >= 1000 ? raw : 1_000_000;
})();

/** Average chars per token for the char→token estimate. */
const CHARS_PER_TOKEN = 4;

/** Finite non-negative number or 0. */
function nonNeg(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Estimate context tokens from a character count (~4 chars/token). Pure. */
export function estimateTokens(chars: number): number {
  return Math.ceil(nonNeg(chars) / CHARS_PER_TOKEN);
}

/** Parse an ISO timestamp to epoch ms; NaN-safe (bad input → 0). */
function toMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Round to 1 decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Build a single display row from a raw record. Pure. */
function toRow(rec: SessionUsageRecord, defaultWindow: number, nowMs: number): SessionRow {
  const contextWindow = nonNeg(rec.contextWindow) || defaultWindow;
  const explicit = rec.usedTokens != null && Number.isFinite(rec.usedTokens) && rec.usedTokens >= 0;
  const usedTokens = explicit ? Math.round(rec.usedTokens as number) : estimateTokens(nonNeg(rec.chars));
  const contextPct = contextWindow > 0 ? Math.max(0, round1((usedTokens / contextWindow) * 100)) : 0;
  const peerId = (rec.peerId ?? '').toString();
  const key = peerId.length > 0 ? `${rec.kind}:${peerId}` : rec.id;
  const updatedMs = toMs(rec.updatedAt);

  return {
    id: rec.id,
    key,
    kind: (rec.kind ?? '').toString().trim() || 'unknown',
    peerId,
    state: rec.state,
    model: rec.model ?? null,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    usedTokens,
    tokensEstimated: !explicit,
    contextWindow,
    contextPct,
    messageCount: Math.round(nonNeg(rec.messageCount)),
    ageMs: Math.max(0, nowMs - updatedMs),
  };
}

/** Comparator for the requested sort. Ties break on key (stable, deterministic). */
function comparator(sort: SessionSort): (a: SessionRow, b: SessionRow) => number {
  switch (sort) {
    case 'tokens':
      return (a, b) => b.usedTokens - a.usedTokens || a.key.localeCompare(b.key);
    case 'messages':
      return (a, b) => b.messageCount - a.messageCount || a.key.localeCompare(b.key);
    case 'key':
      return (a, b) => a.key.localeCompare(b.key);
    case 'updated':
    default:
      // Most-recently-updated first (smallest age first).
      return (a, b) => a.ageMs - b.ageMs || a.key.localeCompare(b.key);
  }
}

/**
 * Roll up raw session records into sorted display rows, optionally grouped by
 * kind, with per-row context-fill and window-wide totals.
 *
 * `stateFilter` is applied here so the same builder can serve the "active only"
 * default and the "archived only" / "all" views without a second query shape.
 */
export function buildSessionRows(
  records: readonly SessionUsageRecord[],
  opts: SessionRollupOptions = {},
): SessionRollup {
  const sort = opts.sort ?? 'updated';
  const groupBy = opts.groupBy ?? 'none';
  const stateFilter = opts.stateFilter ?? 'active';
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const defaultWindow = nonNeg(opts.contextWindow) || DEFAULT_CONTEXT_WINDOW;

  const filtered = (records ?? []).filter(
    (r) => stateFilter === 'all' || r.state === stateFilter,
  );

  const rows = filtered.map((r) => toRow(r, defaultWindow, nowMs));
  rows.sort(comparator(sort));

  // Totals.
  const totals: SessionRollupTotals = {
    count: rows.length,
    active: 0,
    compacted: 0,
    archived: 0,
    usedTokens: 0,
    contextWindow: defaultWindow,
    avgContextPct: 0,
  };
  let pctSum = 0;
  for (const r of rows) {
    if (r.state === 'active') totals.active += 1;
    else if (r.state === 'compacted') totals.compacted += 1;
    else if (r.state === 'archived') totals.archived += 1;
    totals.usedTokens += r.usedTokens;
    pctSum += r.contextPct;
  }
  totals.avgContextPct = rows.length > 0 ? round1(pctSum / rows.length) : 0;

  // Group-by-kind: preserve the sorted row order within each group; groups
  // ordered by total tokens desc, then kind asc (deterministic).
  const groups: SessionGroup[] = [];
  if (groupBy === 'kind') {
    const byKind = new Map<string, SessionGroup>();
    for (const r of rows) {
      let g = byKind.get(r.kind);
      if (!g) {
        g = { kind: r.kind, count: 0, usedTokens: 0, rows: [] };
        byKind.set(r.kind, g);
      }
      g.count += 1;
      g.usedTokens += r.usedTokens;
      g.rows.push(r);
    }
    groups.push(
      ...[...byKind.values()].sort(
        (a, b) => b.usedTokens - a.usedTokens || a.kind.localeCompare(b.kind),
      ),
    );
  }

  return {
    generatedAt: now.toISOString(),
    sort,
    groupBy,
    stateFilter,
    contextWindow: defaultWindow,
    count: rows.length,
    rows,
    groups,
    totals,
  };
}
