/**
 * @file no-gate-fail-closed.test.ts
 * @description Invariant 8 on the self-improvement apply path, split by action
 * class:
 *
 *   • LOG / OBSERVATION writes (LEARNINGS.md journal, the unused-tool note)
 *     record what pattern detection saw. They apply UNCONDITIONALLY — the
 *     HeldOutGate is a non-regression bench over held-out traces, and in
 *     production it holds whenever traces.db has no held-out data, which used
 *     to silently erase every self-improvement log. Observability is never
 *     gated.
 *
 *   • SOURCE-AFFECTING applies (AutoResearch draft patches consumed by
 *     meta.self-modify) stay fail-CLOSED through evaluateDraftGate(): an
 *     absent, rejecting, or throwing gate blocks the apply. A passing gate
 *     lets it through (capability preserved).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpData: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpData = mkdtempSync(join(tmpdir(), 'selfimprove-gate-'));
  saved['DATA_DIR'] = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = tmpData; // no mind.db inside → pattern detection skipped
  vi.resetModules(); // paths.ts captures DATA_DIR at import time
});

afterEach(() => {
  rmSync(tmpData, { recursive: true, force: true });
  if (saved['DATA_DIR'] === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = saved['DATA_DIR'];
  vi.resetModules();
});

/**
 * Seed a minimal mind.db with a genuinely failing tool so pattern detection
 * yields CONTENT. Since 2026-08-05 (autonomy audit blocker #7) an empty
 * detection writes nothing at all, so a fixture with no data can no longer
 * demonstrate the apply path — it would pass for the wrong reason.
 */
function seedMindDb(dir: string): void {
  const db = new Database(join(dir, 'mind.db'));
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY, role TEXT, content TEXT,
    tool_name TEXT, tool_output TEXT, created_at TEXT
  )`);
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO messages (role, content, tool_name, tool_output, created_at) VALUES ('tool','',?,?,?)`,
  );
  for (let i = 0; i < 4; i++) ins.run('flaky.tool', '{"success":false}', now);
  db.close();
}

async function importEngine() {
  return await import('../../src/core/self-improvement/engine.js');
}

/** A complete GateEvaluation stub with the given verdict (all required fields). */
function verdict(passed: boolean) {
  return (proposalId: string) => ({
    proposalId,
    passed,
    passRate: passed ? 1 : 0.2,
    tolerance: 0.05,
    totalTests: 10,
    passedTests: passed ? 10 : 2,
    failedTests: passed ? 0 : 8,
    regressionDetails: passed ? [] : ['regressed intent x'],
  });
}

describe('runSelfImprovement — logs ungated, source patches fail-closed', () => {
  it('NOGATE-1: LOG writes (LEARNINGS.md) apply WITHOUT a gate; no source patch, no rollback', async () => {
    seedMindDb(tmpData);
    const { runSelfImprovement } = await importEngine();
    const result = await runSelfImprovement({ trigger: 'test-no-gate' });
    // Observability is never gated: the journal write applies even with no gate.
    const learnings = result.actions.find((a) => a.type === 'learnings_update');
    expect(learnings?.applied).toBe(true);
    // But no source-affecting (draft_patch) apply happened, so no rollback.
    expect(result.rollbacks).toHaveLength(0);
    expect(result.actions.filter((a) => a.type === 'draft_patch').every((a) => !a.applied)).toBe(true);
  });

  it('NOGATE-2: a THROWING/holding gate does NOT block the LEARNINGS log', async () => {
    seedMindDb(tmpData);
    const { runSelfImprovement } = await importEngine();
    const gate = {
      evaluate: async () => {
        throw new Error('bench data unavailable');
      },
    };
    const result = await runSelfImprovement({
      trigger: 'test-gate-throw',
      heldOutGate: gate as unknown as import('../../src/core/learning/held-out-gate.js').HeldOutGate,
    });
    // Gate state is irrelevant to observability — the journal still records.
    const learnings = result.actions.find((a) => a.type === 'learnings_update');
    expect(learnings?.applied).toBe(true);
  });

  it('NOGATE-3: source-patch gate — a PASSING gate allows the apply (capability preserved)', async () => {
    const { evaluateDraftGate } = await importEngine();
    const ok = await evaluateDraftGate(
      { evaluate: async (p: string) => verdict(true)(p) },
      'p-ok',
      { params: { description: 'd' } },
      'tool-x',
    );
    expect(ok).toBe(true);
  });

  it('NOGATE-4: source-patch gate — a REJECTING gate blocks the apply', async () => {
    const { evaluateDraftGate } = await importEngine();
    const blocked = await evaluateDraftGate(
      { evaluate: async (p: string) => verdict(false)(p) },
      'p-bad',
      { params: { description: 'd' } },
      'tool-x',
    );
    expect(blocked).toBe(false);
  });

  it('NOGATE-5: source-patch gate — a THROWING gate blocks (fail-closed)', async () => {
    const { evaluateDraftGate } = await importEngine();
    const blocked = await evaluateDraftGate(
      { evaluate: async () => { throw new Error('down'); } },
      'p-1',
      { params: { description: 'd' } },
      'tool-x',
    );
    expect(blocked).toBe(false);
  });
});
