/**
 * @file self-diagnostic.test.ts
 * @description system.self-diagnostic API-cost check. The check previously
 * summed the legacy `api_costs` table, which is never populated, so it reported
 * `$0.0000 today / pass` on every run while real spend (recorded in
 * `api_call_log` by the cost-tracker) ran well over budget — a fabricated
 * all-clear from the agent's own health check. These tests pin the corrected
 * query (reads api_call_log), the today-boundary cutoff, and the
 * SUDO_DAILY_BUDGET_USD operator override.
 *
 * Pattern: DATA_DIR is pointed at a temp dir holding a seeded mind.db, then the
 * skill is dynamically imported after vi.resetModules() so shared/paths.ts
 * re-captures DATA_DIR at module load.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ToolContext } from '../../src/core/tools/types.js';
import type { SelfDiagnosticOutput, DiagnosticCheck } from '../../src/core/skills/system/self-diagnostic/index.js';

let dir: string;
let savedDataDir: string | undefined;
let savedBudget: string | undefined;

const TODAY = `${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`;
const OLD = '2020-01-01T00:00:00.000Z';
const TOMORROW = `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;

function seedDb(rows: Array<{ cost: number; calledAt: string }>): void {
  const db = new Database(join(dir, 'mind.db'));
  db.exec(`CREATE TABLE api_call_log (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1,
    error TEXT, source TEXT NOT NULL DEFAULT 'chat', called_at TEXT NOT NULL
  )`);
  const ins = db.prepare(
    `INSERT INTO api_call_log (id, provider, model, estimated_cost_usd, called_at)
     VALUES (?, 'anthropic', 'claude', ?, ?)`,
  );
  rows.forEach((r, i) => ins.run(`row-${i}`, r.cost, r.calledAt));
  db.close();
}

async function apiCostCheck(): Promise<DiagnosticCheck> {
  // IMPORTANT: import dynamically AFTER beforeEach sets DATA_DIR. A static
  // top-of-file import would bake the real DATA_DIR into shared/paths.ts at
  // suite load (it is captured at module load) and the temp-dir substitution
  // would silently miss. resetModules forces a fresh paths.ts evaluation.
  vi.resetModules();
  const mod = await import('../../src/core/skills/system/self-diagnostic/index.js');
  const ctx: ToolContext = { sessionId: 'test', workingDir: dir, config: {}, logger: {} };
  const res = await mod.skillTool.execute({}, ctx);
  const data = res.data as SelfDiagnosticOutput;
  const check = data.checks.find((c) => c.name === 'api_costs');
  if (!check) throw new Error('api_costs check missing from diagnostic output');
  return check;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'self-diag-'));
  savedDataDir = process.env['DATA_DIR'];
  savedBudget = process.env['SUDO_DAILY_BUDGET_USD'];
  process.env['DATA_DIR'] = dir;
  delete process.env['SUDO_DAILY_BUDGET_USD'];
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = savedDataDir;
  if (savedBudget === undefined) delete process.env['SUDO_DAILY_BUDGET_USD'];
  else process.env['SUDO_DAILY_BUDGET_USD'] = savedBudget;
  rmSync(dir, { recursive: true, force: true });
});

describe('system.self-diagnostic — API cost check', () => {
  it('SD-1: sums today spend from api_call_log, excludes other days, fails over budget', async () => {
    seedDb([
      { cost: 6.0, calledAt: TODAY },
      { cost: 99.0, calledAt: OLD },
      { cost: 50.0, calledAt: TOMORROW },
    ]);
    const check = await apiCostCheck();
    // Only the today row counts: $6.00. The half-open [today, tomorrow) window
    // excludes both yesterday ($99) and tomorrow ($50).
    expect(check.value).toContain('$6.0000');
    expect(check.value).not.toContain('$105'); // would include OLD
    expect(check.value).not.toContain('$56'); // would include TOMORROW
    // $6 > the default $5 budget → honest fail (the prior code reported pass).
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('Daily budget exceeded');
  });

  it('SD-2: genuine zero-spend day still passes at $0.0000', async () => {
    seedDb([]);
    const check = await apiCostCheck();
    expect(check.status).toBe('pass');
    expect(check.value).toContain('$0.0000');
  });

  it('SD-3: SUDO_DAILY_BUDGET_USD override is honored at call time', async () => {
    process.env['SUDO_DAILY_BUDGET_USD'] = '10';
    seedDb([{ cost: 6.0, calledAt: TODAY }]);
    const check = await apiCostCheck();
    // $6 < the overridden $10 budget → pass, and the budget is reflected.
    expect(check.status).toBe('pass');
    expect(check.value).toContain('of $10.00 budget');
  });

  it('SD-4: spend between 80% and 100% of budget warns', async () => {
    seedDb([{ cost: 4.5, calledAt: TODAY }]);
    const check = await apiCostCheck();
    // $4.50 is over 0.8 * $5 but under $5.
    expect(check.status).toBe('warn');
    expect(check.detail).toBe('>80% budget used');
  });
});
