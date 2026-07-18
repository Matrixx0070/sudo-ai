/**
 * @file tests/health/restart-sentinel.test.ts
 * @description GW-9 — verified restart handoff. Covers the intent→ready
 * lifecycle, stale-intent detection, the watchdog timeout + stale-ready
 * rejection, and the Kairos failed-handoff cooldown.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  writeRestartIntent,
  readRestartIntent,
  completeBootHandoff,
  readReady,
  isStaleIntent,
  waitForReady,
  DEFAULT_STALE_MS,
} from '../../src/core/health/restart-sentinel.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'restart-sentinel-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('GW-9 restart-sentinel — intent/ready lifecycle', () => {
  it('intent → ready: completeBootHandoff writes ready.json and clears intent', () => {
    writeRestartIntent(dir, { reason: 'test restart', initiator: 'kairos', gitSha: 'abc123', now: 1000 });
    expect(readRestartIntent(dir)?.reason).toBe('test restart');

    const res = completeBootHandoff(dir, { port: 18900, gitSha: 'def456', now: 2000 });
    expect(res.resumed).toBe(true);
    expect(res.staleHandoff).toBe(false);
    expect(res.intent?.initiator).toBe('kairos');

    // intent cleared, ready written
    expect(readRestartIntent(dir)).toBeNull();
    const ready = readReady(dir);
    expect(ready?.bootTs).toBe(2000);
    expect(ready?.port).toBe(18900);
    expect(ready?.gitSha).toBe('def456');
  });

  it('boot with NO intent → resumed=false, still writes ready.json', () => {
    const res = completeBootHandoff(dir, { port: 18900, gitSha: 'x', now: 5000 });
    expect(res.resumed).toBe(false);
    expect(res.staleHandoff).toBe(false);
    expect(readReady(dir)?.bootTs).toBe(5000);
  });

  it('isStaleIntent: fresh intent is not stale, aged intent is', () => {
    const intent = writeRestartIntent(dir, { reason: 'r', initiator: 'updater', gitSha: 's', now: 0 });
    expect(isStaleIntent(intent, DEFAULT_STALE_MS - 1)).toBe(false);
    expect(isStaleIntent(intent, DEFAULT_STALE_MS + 1)).toBe(true);
  });

  it('stale intent at boot → staleHandoff=true (possible failed handoff)', () => {
    writeRestartIntent(dir, { reason: 'crashy', initiator: 'kairos', gitSha: 's', now: 0 });
    const res = completeBootHandoff(dir, { port: 18900, gitSha: 's2', now: DEFAULT_STALE_MS + 10_000 });
    expect(res.resumed).toBe(true);
    expect(res.staleHandoff).toBe(true);
    expect(readRestartIntent(dir)).toBeNull(); // still cleared
  });
});

describe('GW-9 restart-sentinel — waitForReady watchdog', () => {
  it('returns the ready record once written after sinceMs', async () => {
    completeBootHandoff(dir, { port: 18900, gitSha: 's', now: 10_000 });
    const ready = await waitForReady(dir, { sinceMs: 5_000, timeoutMs: 1_000, pollMs: 10 });
    expect(ready?.bootTs).toBe(10_000);
  });

  it('ignores a STALE ready.json written BEFORE the restart was triggered', async () => {
    // ready from a prior boot (bootTs=1000) must not satisfy a restart triggered at sinceMs=9000
    completeBootHandoff(dir, { port: 18900, gitSha: 's', now: 1_000 });
    let clock = 9_000;
    const ready = await waitForReady(dir, {
      sinceMs: 9_000,
      timeoutMs: 100,
      pollMs: 10,
      now: () => clock,
      sleep: async () => { clock += 20; },
    });
    expect(ready).toBeNull(); // timed out — the old ready was rejected
  });

  it('times out to null when no ready appears (mocked clock)', async () => {
    let clock = 0;
    const ready = await waitForReady(dir, {
      sinceMs: 0,
      timeoutMs: 120_000,
      pollMs: 1_000,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    expect(ready).toBeNull();
  });
});

describe('GW-9 — Kairos failed-handoff cooldown', () => {
  const KAIROS_ENV = ['DATA_DIR'] as const;
  let saved: Record<string, string | undefined>;
  let projectDataDir: string;

  beforeEach(() => {
    saved = {};
    for (const k of KAIROS_ENV) { saved[k] = process.env[k]; }
    // kairos.ts writes its cooldown under PROJECT_ROOT/data — isolate by cwd-independent path check
    projectDataDir = path.join(process.cwd(), 'data');
    mkdirSync(projectDataDir, { recursive: true });
  });
  afterEach(() => {
    for (const k of KAIROS_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try { rmSync(path.join(projectDataDir, 'kairos-restart-cooldown.json'), { force: true }); } catch { /* noop */ }
  });

  it('applyFailedHandoffCooldown suppresses restarts for ~1h; expiry re-enables', async () => {
    const kairos = await import('../../src/core/consciousness/kairos.js');
    kairos.__resetRestartCooldownForTest();
    expect(kairos.isKairosRestartOnCooldown(1_000)).toBe(false);

    kairos.applyFailedHandoffCooldown(1_000);
    expect(kairos.isKairosRestartOnCooldown(1_000)).toBe(true);
    expect(kairos.isKairosRestartOnCooldown(1_000 + kairos.KAIROS_RESTART_BACKOFF_MS - 1)).toBe(true);
    expect(kairos.isKairosRestartOnCooldown(1_000 + kairos.KAIROS_RESTART_BACKOFF_MS + 1)).toBe(false);

    kairos.__resetRestartCooldownForTest();
    expect(kairos.isKairosRestartOnCooldown(1_000)).toBe(false);
  });
});
