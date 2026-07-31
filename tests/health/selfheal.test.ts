/**
 * ADR-0004 self-heal engine tests.
 *
 * Contract under test:
 *  - flag OFF → guarded fix is a pure passthrough (no ledger, no notify)
 *  - flag ON + allowed category → fix runs, ledger discloses, owner notified
 *  - flag ON + non-allowed category → fix does NOT run, skip disclosed
 *  - daily budget exhaustion → fix skipped, one halt alert per day
 *  - fix throws → outcome recorded as failed, notify fired, error swallowed
 *  - frozen-surface guard rejects targets outside DATA_DIR
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SelfHealEngine,
  assertHealTargetAllowed,
  DEFAULT_CATEGORIES,
  type HealRecord,
} from '../../src/core/health/selfheal.js';

function tmpLedger(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-')), 'ledger.jsonl');
}

function readLedger(p: string): HealRecord[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as HealRecord);
}

function makeEngine(env: Record<string, string | undefined>, ledgerPath: string) {
  const notices: Array<{ title: string; message: string }> = [];
  const engine = new SelfHealEngine({
    ledgerPath,
    env,
    notify: (title, message) => notices.push({ title, message }),
  });
  return { engine, notices };
}

describe('SelfHealEngine (ADR-0004)', () => {
  it('flag OFF: passthrough — fix runs, no ledger, no notify (legacy capability kept)', async () => {
    const ledger = tmpLedger();
    const { engine, notices } = makeEngine({}, ledger);
    let ran = 0;
    await engine.guard('disk-gc', 'fixDiskSpace', async () => void ran++)();
    expect(ran).toBe(1);
    expect(readLedger(ledger)).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it('flag ON + allowed category: fix runs, ledger discloses success, owner notified', async () => {
    const ledger = tmpLedger();
    const { engine, notices } = makeEngine({ SUDO_SELF_HEAL: '1' }, ledger);
    let ran = 0;
    await engine.guard('log-rotation', 'fixLogRotation', async () => void ran++)();
    expect(ran).toBe(1);
    const recs = readLedger(ledger);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ category: 'log-rotation', action: 'fixLogRotation', outcome: 'success' });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toContain('SELF-HEAL');
  });

  it('flag ON + category not pre-approved: fix does NOT run, skip is disclosed, no owner ping', async () => {
    const ledger = tmpLedger();
    const { engine, notices } = makeEngine(
      { SUDO_SELF_HEAL: '1', SUDO_SELF_HEAL_CATEGORIES: 'log-rotation' },
      ledger,
    );
    let ran = 0;
    await engine.guard('disk-gc', 'fixDiskSpace', async () => void ran++)();
    expect(ran).toBe(0);
    const recs = readLedger(ledger);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.outcome).toBe('skipped-category');
    expect(notices).toHaveLength(0);
  });

  it('daily budget: heals stop at cap, halt alert fires exactly once per day', async () => {
    const ledger = tmpLedger();
    const { engine, notices } = makeEngine(
      { SUDO_SELF_HEAL: '1', SUDO_SELF_HEAL_MAX_PER_DAY: '2' },
      ledger,
    );
    let ran = 0;
    const heal = engine.guard('memory-gc', 'fixMemory', async () => void ran++);
    await heal();
    await heal();
    await heal(); // over budget
    await heal(); // over budget again — must not re-alert
    expect(ran).toBe(2);
    const recs = readLedger(ledger);
    expect(recs.filter((r) => r.outcome === 'success')).toHaveLength(2);
    expect(recs.filter((r) => r.outcome === 'skipped-budget')).toHaveLength(2);
    const halts = notices.filter((n) => n.title.includes('HALTED'));
    expect(halts).toHaveLength(1);
  });

  it('fix throws: outcome failed is disclosed, notify fires, error is not rethrown', async () => {
    const ledger = tmpLedger();
    const { engine, notices } = makeEngine({ SUDO_SELF_HEAL: '1' }, ledger);
    await expect(
      engine.guard('disk-gc', 'fixDiskSpace', async () => {
        throw new Error('boom');
      })(),
    ).resolves.toBeUndefined();
    const recs = readLedger(ledger);
    expect(recs[0]).toMatchObject({ outcome: 'failed' });
    expect(recs[0]!.detail).toContain('boom');
    expect(notices[0]!.title).toContain('FAILED');
  });

  it('default categories are exactly the three legacy watchdog fixes', () => {
    expect([...DEFAULT_CATEGORIES].sort()).toEqual(['disk-gc', 'log-rotation', 'memory-gc']);
  });

  it('frozen-surface guard: targets outside DATA_DIR are rejected, inside pass', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-data-'));
    expect(() => assertHealTargetAllowed(path.join(dataDir, 'logs', 'x.log'), dataDir)).not.toThrow();
    expect(() => assertHealTargetAllowed('/etc/passwd', dataDir)).toThrow(/forbidden/);
    // Path traversal out of DATA_DIR must also be rejected.
    expect(() => assertHealTargetAllowed(path.join(dataDir, '..', 'escape.txt'), dataDir)).toThrow(/forbidden/);
  });
});
