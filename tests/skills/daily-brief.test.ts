/**
 * @file daily-brief.test.ts
 * @description intelligence.daily-brief system-health cost line. The brief
 * summed the legacy `api_costs` table (never populated), so the "API cost today"
 * line always read $0.0000 and the "API costs high" action item never fired.
 * These tests pin the corrected query (reads api_call_log) via the public
 * `execute` with focus:'system' (which skips the HN/GitHub network fetches).
 *
 * Pattern: DATA_DIR points at a temp dir holding a seeded mind.db; the skill is
 * dynamically imported after vi.resetModules() so shared/paths.ts re-captures
 * DATA_DIR (MIND_DB = DATA_DIR/mind.db) at module load.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ToolContext } from '../../src/core/tools/types.js';
import type { DailyBriefOutput } from '../../src/core/skills/intelligence/daily-brief/index.js';

let dir: string;
let savedDataDir: string | undefined;

const TODAY = `${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`;
const TOMORROW = `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** Seeds the three tables fetchSystemHealth reads, in one mind.db. */
function seedDb(costRows: Array<{ cost: number; calledAt: string }>): void {
  const db = new Database(join(dir, 'mind.db'));
  // fetchSystemHealth opens the db readonly and sets journal_mode=WAL; that
  // pragma only succeeds when the file is already WAL (as the live daemon
  // leaves it), so seed in WAL to exercise the real read path.
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE cron_runs (job_name TEXT, status TEXT, error TEXT, ran_at TEXT)`);
  db.exec(`CREATE TABLE content_ideas (status TEXT)`);
  db.exec(`CREATE TABLE api_call_log (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
    estimated_cost_usd REAL NOT NULL DEFAULT 0, called_at TEXT NOT NULL
  )`);
  const ins = db.prepare(
    `INSERT INTO api_call_log (id, provider, model, estimated_cost_usd, called_at)
     VALUES (?, 'anthropic', 'claude', ?, ?)`,
  );
  costRows.forEach((r, i) => ins.run(`row-${i}`, r.cost, r.calledAt));
  db.close();
}

async function buildBrief(): Promise<DailyBriefOutput> {
  // IMPORTANT: import dynamically AFTER beforeEach sets DATA_DIR. A static
  // top-of-file import would bake the real DATA_DIR (MIND_DB) into
  // shared/paths.ts at suite load and the temp-dir substitution would silently
  // miss. resetModules forces a fresh paths.ts evaluation.
  vi.resetModules();
  const mod = await import('../../src/core/skills/intelligence/daily-brief/index.js');
  const ctx: ToolContext = { sessionId: 'test', workingDir: dir, config: {}, logger: {} };
  const res = await mod.skillTool.execute({ focus: 'system' }, ctx);
  return res.data as DailyBriefOutput;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daily-brief-'));
  savedDataDir = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = dir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = savedDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('intelligence.daily-brief — system health cost line', () => {
  it('DB-1: reports today spend from api_call_log and fires the high-cost action item', async () => {
    seedDb([{ cost: 6.0, calledAt: TODAY }, { cost: 50.0, calledAt: TOMORROW }]);
    const brief = await buildBrief();
    // Half-open [today, tomorrow) window excludes the $50 tomorrow row.
    expect(brief.brief).toContain('API cost today: $6.0000');
    expect(brief.brief).not.toContain('$56');
    // > 80% of the default $5 budget → dormant action item now correctly fires.
    expect(brief.actionItems.some((a) => a.includes('API costs high today ($6.000)'))).toBe(true);
  });

  it('DB-2: genuine zero-spend day reads $0.0000 and omits the high-cost item', async () => {
    seedDb([]);
    const brief = await buildBrief();
    expect(brief.brief).toContain('API cost today: $0.0000');
    expect(brief.actionItems.some((a) => a.includes('API costs high'))).toBe(false);
  });
});
