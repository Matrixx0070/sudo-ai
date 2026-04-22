/**
 * @file budget.test.ts
 * @description Unit tests for /budget command.
 *
 * Covers:
 *  1. New schema  — api_costs with `cost_usd`    + `created_at`
 *  2. Old/live schema — api_costs with `estimated_usd` + `called_at`
 *  3. Unknown schema  — api_costs exists but with neither known column name
 *  4. Missing tracker + empty table
 *  5. Injected costTracker fast-path
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../src/core/memory/schema.js';
import { budgetCommand, _resetColumnCache } from '../../../src/core/commands/builtin/budget.js';
import type { CommandContext } from '../../../src/core/commands/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** New-schema DB (cost_usd + created_at) via the canonical initializeSchema. */
function makeNewSchemaDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

/**
 * Old/live-schema DB — api_costs uses `estimated_usd` + `called_at`.
 * Intentionally does NOT call initializeSchema so none of the new column
 * names are present.
 */
function makeOldSchemaDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE api_costs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      provider      TEXT    NOT NULL DEFAULT 'anthropic',
      model         TEXT    NOT NULL DEFAULT 'claude-sonnet-4-6',
      operation     TEXT    NOT NULL DEFAULT 'completion',
      estimated_usd REAL    NOT NULL DEFAULT 0,
      called_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  return db;
}

/**
 * Unknown-schema DB — api_costs exists but has neither known amount column
 * nor a known timestamp column.
 */
function makeUnknownSchemaDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE api_costs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      provider   TEXT NOT NULL DEFAULT 'anthropic',
      model      TEXT NOT NULL DEFAULT 'test',
      some_cost  REAL NOT NULL DEFAULT 0,
      logged_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  return db;
}

/** Insert using new schema columns (cost_usd + created_at). */
function insertCostNew(
  db: Database.Database,
  costUsd: number,
  ageMs: number,
): void {
  const ts = new Date(Date.now() - ageMs).toISOString();
  db.prepare(
    `INSERT INTO api_costs (provider, model, operation, cost_usd, created_at)
     VALUES ('anthropic', 'claude-sonnet-4-6', 'completion', ?, ?)`,
  ).run(costUsd, ts);
}

/** Insert using old schema columns (estimated_usd + called_at). */
function insertCostOld(
  db: Database.Database,
  estimatedUsd: number,
  ageMs: number,
): void {
  const ts = new Date(Date.now() - ageMs).toISOString();
  db.prepare(
    `INSERT INTO api_costs (provider, model, operation, estimated_usd, called_at)
     VALUES ('anthropic', 'claude-sonnet-4-6', 'completion', ?, ?)`,
  ).run(estimatedUsd, ts);
}

/**
 * Build a minimal CommandContext whose db.db is the real better-sqlite3 instance.
 * config has no costTracker so the DB fallback path executes.
 */
function makeCtx(db: Database.Database): CommandContext {
  return {
    channel:      'test',
    peerId:       'user-test',
    sessionId:    'sess-test',
    agentLoop:    null,
    toolRegistry: null,
    config:       {},   // no costTracker → triggers DB path
    db:           { db }, // budget.ts does ctx.db?.db?.prepare(...)
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY  = 86_400_000;

// ---------------------------------------------------------------------------
// Suite 1 — New schema (cost_usd + created_at)
// ---------------------------------------------------------------------------

describe('budgetCommand — new schema (cost_usd + created_at)', () => {
  let db: Database.Database;
  let ctx: CommandContext;

  beforeEach(() => {
    _resetColumnCache();
    db  = makeNewSchemaDb();
    ctx = makeCtx(db);
  });

  it('returns "no costs recorded" message when table is empty', async () => {
    const result = await budgetCommand.execute('', ctx);
    expect(result).toBe('Budget tracking not available or no costs recorded yet.');
  });

  it('correctly sums cost_usd (via alias) for today bucket', async () => {
    insertCostNew(db, 0.0050, 1 * HOUR);
    insertCostNew(db, 0.0030, 2 * HOUR);

    const result = await budgetCommand.execute('', ctx);

    expect(result).toContain('Today:');
    expect(result).toContain('$0.0080');
  });

  it('correctly buckets costs across day/week/month windows', async () => {
    insertCostNew(db, 0.0100,  1 * HOUR);   // today + week + month
    insertCostNew(db, 0.0200,  2 * DAY);    // week + month only
    insertCostNew(db, 0.0400, 15 * DAY);    // month only

    const result = await budgetCommand.execute('', ctx);

    expect(result).toContain('$0.0100');   // today
    expect(result).toContain('$0.0300');   // week  (0.0100 + 0.0200)
    expect(result).toContain('$0.0700');   // month (0.0100 + 0.0200 + 0.0400)
  });

  it('excludes rows older than 30 days from all buckets', async () => {
    insertCostNew(db, 1.0000, 31 * DAY);

    const result = await budgetCommand.execute('', ctx);

    // Row exists so the empty-check passes, but all totals should be $0.0000
    expect(result).toContain('$0.0000');
  });

  it('output includes the API BUDGET header and separator', async () => {
    insertCostNew(db, 0.0010, 1 * HOUR);

    const result = await budgetCommand.execute('', ctx);

    expect(result).toContain('API BUDGET');
    expect(result).toContain('──────────');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Old/live schema (estimated_usd + called_at)
// ---------------------------------------------------------------------------

describe('budgetCommand — old/live schema (estimated_usd + called_at)', () => {
  let db: Database.Database;
  let ctx: CommandContext;

  beforeEach(() => {
    _resetColumnCache();
    db  = makeOldSchemaDb();
    ctx = makeCtx(db);
  });

  it('returns "no costs recorded" message when table is empty', async () => {
    const result = await budgetCommand.execute('', ctx);
    expect(result).toBe('Budget tracking not available or no costs recorded yet.');
  });

  it('correctly reads estimated_usd via column detection', async () => {
    insertCostOld(db, 0.0050, 1 * HOUR);
    insertCostOld(db, 0.0030, 2 * HOUR);

    const result = await budgetCommand.execute('', ctx);

    expect(result).toContain('Today:');
    expect(result).toContain('$0.0080');
  });

  it('correctly buckets old-schema costs across day/week/month windows', async () => {
    insertCostOld(db, 0.0100,  1 * HOUR);   // today + week + month
    insertCostOld(db, 0.0200,  2 * DAY);    // week + month only
    insertCostOld(db, 0.0400, 15 * DAY);    // month only

    const result = await budgetCommand.execute('', ctx);

    expect(result).toContain('$0.0100');   // today
    expect(result).toContain('$0.0300');   // week
    expect(result).toContain('$0.0700');   // month
  });

  it('uses called_at for time bucketing (not hardcoded created_at)', async () => {
    // One row well within the day window
    insertCostOld(db, 0.0200, 30 * 60 * 1000); // 30 minutes ago

    const result = await budgetCommand.execute('', ctx);

    expect(result).toContain('$0.0200');   // must appear in today bucket
    expect(result).toContain('API BUDGET');
  });

  it('output includes header and separator', async () => {
    insertCostOld(db, 0.0010, 1 * HOUR);

    const result = await budgetCommand.execute('', ctx);

    expect(result).toContain('API BUDGET');
    expect(result).toContain('──────────');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Unknown schema (neither column family known)
// ---------------------------------------------------------------------------

describe('budgetCommand — unknown schema (neither cost_usd nor estimated_usd)', () => {
  let db: Database.Database;
  let ctx: CommandContext;

  beforeEach(() => {
    _resetColumnCache();
    db  = makeUnknownSchemaDb();
    ctx = makeCtx(db);
  });

  it('returns a graceful schema-mismatch message and does not throw', async () => {
    const result = await budgetCommand.execute('', ctx);

    expect(result).toContain('schema mismatch');
    // Must not contain any $ values (i.e. not silently returning $0)
    expect(result).not.toContain('$');
  });

  it('does not throw even with rows present using unknown columns', async () => {
    // Insert a row using the unrecognised column names
    db.prepare(
      `INSERT INTO api_costs (provider, model, some_cost, logged_at)
       VALUES ('anthropic', 'test', 1.5, '2026-04-12T00:00:00Z')`,
    ).run();

    let threw = false;
    try {
      await budgetCommand.execute('', ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Injected costTracker fast-path
// ---------------------------------------------------------------------------

describe('budgetCommand — injected costTracker fast-path', () => {
  beforeEach(() => {
    _resetColumnCache();
  });

  it('delegates to costTracker methods when present in config', async () => {
    const tracker = {
      getTodayCost:  () => 0.1234,
      getWeekCost:   () => 0.5678,
      getMonthCost:  () => 1.2345,
    };

    const ctx: CommandContext = {
      channel:      'test',
      peerId:       'user-test',
      sessionId:    'sess-test',
      agentLoop:    null,
      toolRegistry: null,
      config:       { costTracker: tracker },
      db:           null,
    };

    const result = await budgetCommand.execute('', ctx);

    expect(result).toContain('$0.1234');
    expect(result).toContain('$0.5678');
    expect(result).toContain('$1.2345');
    expect(result).toContain('API BUDGET');
  });

  it('returns $0.0000 when costTracker methods return undefined', async () => {
    const ctx: CommandContext = {
      channel:      'test',
      peerId:       'user-test',
      sessionId:    'sess-test',
      agentLoop:    null,
      toolRegistry: null,
      config:       { costTracker: {} }, // methods not implemented
      db:           null,
    };

    const result = await budgetCommand.execute('', ctx);

    expect(result).toContain('$0.0000');
    expect(result).toContain('API BUDGET');
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — No DB handle at all
// ---------------------------------------------------------------------------

describe('budgetCommand — no DB handle', () => {
  beforeEach(() => {
    _resetColumnCache();
  });

  it('returns "not available" message when db is null', async () => {
    const ctx: CommandContext = {
      channel:      'test',
      peerId:       'user-test',
      sessionId:    'sess-test',
      agentLoop:    null,
      toolRegistry: null,
      config:       {},
      db:           null,
    };

    const result = await budgetCommand.execute('', ctx);
    expect(result).toBe('Budget tracking not available or no costs recorded yet.');
  });
});
