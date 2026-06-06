/**
 * @file builtin/budget.ts
 * @description /budget — show API cost summary for today, this week, this month.
 *
 * Schema resilience: the live production db uses the older column names
 * `estimated_usd` and `called_at` in api_costs, while fresh installs created
 * from schema.ts use `cost_usd` and `created_at`.  We detect which names are
 * present once via PRAGMA table_info, cache the result for the module lifetime,
 * and build the SELECT string from the detected names.  Only the four known
 * column names are ever interpolated — this is NOT an injection path.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:budget');

// ---------------------------------------------------------------------------
// Known column names (allowlists — nothing else is ever interpolated into SQL)
// ---------------------------------------------------------------------------

const AMOUNT_COLUMNS    = ['cost_usd', 'estimated_usd'] as const;
const TIMESTAMP_COLUMNS = ['created_at', 'called_at']   as const;

type AmountCol    = typeof AMOUNT_COLUMNS[number]    | null;
type TimestampCol = typeof TIMESTAMP_COLUMNS[number] | null;

// ---------------------------------------------------------------------------
// Module-level column-name cache
// Populated on first successful PRAGMA introspection; survives across calls.
// Exported _resetColumnCache() exists only for test isolation — do NOT call
// it from application code.
// ---------------------------------------------------------------------------

let amountColumn:    AmountCol    = null;
let timestampColumn: TimestampCol = null;
let cachePopulated = false;

/** Reset cached column detection — FOR TESTS ONLY. */
export function _resetColumnCache(): void {
  amountColumn    = null;
  timestampColumn = null;
  cachePopulated  = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RawDb {
  prepare: (sql: string) => { all: () => unknown[] };
}

interface PragmaRow {
  name: string;
}

/**
 * Detect and cache the amount and timestamp column names for api_costs.
 * Returns false when the table is absent or uses an unrecognised schema.
 */
function detectColumns(rawDb: RawDb): boolean {
  if (cachePopulated) return amountColumn !== null && timestampColumn !== null;

  try {
    const rows = rawDb.prepare('PRAGMA table_info(api_costs)').all() as PragmaRow[];
    const names = rows.map((r) => r.name);

    amountColumn = AMOUNT_COLUMNS.find((c) => names.includes(c)) ?? null;
    timestampColumn = TIMESTAMP_COLUMNS.find((c) => names.includes(c)) ?? null;
    cachePopulated = true;

    log.debug(
      { amountColumn, timestampColumn },
      'api_costs column detection complete',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'PRAGMA table_info(api_costs) failed');
    cachePopulated = true; // prevent repeated failing attempts
  }

  return amountColumn !== null && timestampColumn !== null;
}

interface CostRow {
  amount:     number;
  created_at: string;
}

interface CostTracker {
  getTodayCost?: () => number;
  getWeekCost?:  () => number;
  getMonthCost?: () => number;
  getTotal?:     () => number;
}

function fmt(n: number): string {
  return `$${n.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Budget command
// ---------------------------------------------------------------------------

export const budgetCommand: SlashCommand = {
  name: 'budget',
  description: 'Show API cost summary: today, this week, this month.',
  usage: '/budget',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    log.debug({ peerId: ctx.peerId }, '/budget executed');

    const config = ctx.config as { costTracker?: CostTracker } | null;
    const tracker = config?.costTracker;

    // ------------------------------------------------------------------
    // Fast path: delegate to the injected cost tracker when available
    // ------------------------------------------------------------------
    if (tracker) {
      const today = tracker.getTodayCost?.() ?? 0;
      const week  = tracker.getWeekCost?.()  ?? 0;
      const month = tracker.getMonthCost?.() ?? 0;

      return [
        'API BUDGET',
        '──────────',
        `Today:      ${fmt(today)}`,
        `This week:  ${fmt(week)}`,
        `This month: ${fmt(month)}`,
      ].join('\n');
    }

    // ------------------------------------------------------------------
    // Fallback path: read raw rows from DB with schema-resilient column
    // detection.
    // ------------------------------------------------------------------
    const dbWrapper = ctx.db as { db?: RawDb } | null;
    const rawDb = dbWrapper?.db;

    if (!rawDb) {
      return 'Budget tracking not available or no costs recorded yet.';
    }

    try {
      // Detect (and cache) which column names this DB instance uses
      const columnsOk = detectColumns(rawDb);

      if (!columnsOk) {
        log.warn({ amountColumn, timestampColumn }, 'api_costs schema mismatch');
        return 'Budget data unavailable — schema mismatch (unrecognised api_costs columns).';
      }

      // Safety assertion: only our four known names ever reach SQL
      if (!AMOUNT_COLUMNS.includes(amountColumn as typeof AMOUNT_COLUMNS[number])) {
        log.error({ amountColumn }, 'Unexpected amount column — refusing to build SQL');
        return 'Budget data unavailable — internal schema detection error.';
      }
      if (!TIMESTAMP_COLUMNS.includes(timestampColumn as typeof TIMESTAMP_COLUMNS[number])) {
        log.error({ timestampColumn }, 'Unexpected timestamp column — refusing to build SQL');
        return 'Budget data unavailable — internal schema detection error.';
      }

      const now   = Date.now();
      const DAY   = 86_400_000;
      const WEEK  = 7  * DAY;
      const MONTH = 30 * DAY;

      // Restrict the scan to the widest window we report (the 30-day month).
      // created_at/called_at are stored as ISO-8601 strings (…Z), which are
      // lexicographically ordered, so a string comparison on the cutoff is
      // correct. Filtering by date (instead of LIMIT 500) ensures the month
      // and week totals are not silently truncated on busy installs. The
      // cutoff is a self-generated ISO timestamp — not an injection path.
      const monthCutoff = new Date(now - MONTH).toISOString();

      // Both aliases (amount, created_at) are fixed — the rest of the function
      // body never needs to know which physical column was used.
      const sql =
        `SELECT ${amountColumn} AS amount, ${timestampColumn} AS created_at ` +
        `FROM api_costs WHERE ${timestampColumn} >= '${monthCutoff}'`;

      const rows = rawDb.prepare(sql).all() as CostRow[];

      // Empty-check must consider ALL recorded costs, not just the last 30 days:
      // a DB holding only older rows still has data and should report $0.0000
      // totals rather than "no costs recorded yet" (rows — the 30-day window —
      // may be empty while the table is non-empty).
      const countRows = rawDb.prepare('SELECT COUNT(*) AS c FROM api_costs').all() as Array<{ c: number }>;
      const totalRecorded = countRows[0]?.c ?? 0;
      if (totalRecorded === 0) {
        return 'Budget tracking not available or no costs recorded yet.';
      }

      let today = 0, week = 0, month = 0;
      for (const row of rows) {
        const ts = row.created_at;
        if (!ts) continue;
        const age = now - new Date(ts).getTime();
        if (age <= DAY)   today += row.amount;
        if (age <= WEEK)  week  += row.amount;
        if (age <= MONTH) month += row.amount;
      }

      return [
        'API BUDGET',
        '──────────',
        `Today:      ${fmt(today)}`,
        `This week:  ${fmt(week)}`,
        `This month: ${fmt(month)}`,
      ].join('\n');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, '/budget DB query failed');
      return 'Budget data unavailable (DB query failed).';
    }
  },
};
