/**
 * @file grok-seat-check.test.ts
 * @description The watchdog check that makes grok-seat failures loud.
 *
 * Five seat failures in one week were all SILENT — a dead OAuth token, a statsig
 * algorithm drift, an absent warm browser, an env var that never reached the
 * process, and a revoked free model that turned a free lane metered. The
 * detector existed; nothing called it. These tests pin the properties that make
 * the check safe to run every 60s.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'seatchk-'));
  process.env['DATA_DIR'] = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
  delete process.env['SUDO_GROK_WEBSESSION'];
  delete process.env['SUDO_GROK_WEB_BRAIN'];
  delete process.env['SUDO_GROK_STATSIG_BROWSERLESS'];
});

describe('checkGrokSeat', () => {
  it('is a no-op when both seat lanes are disabled (costs nothing on other deployments)', async () => {
    const { checkGrokSeat } = await import('../../src/core/health/grok-seat-check.js');
    const r = await checkGrokSeat();
    expect(r.status).toBe('healthy');
    expect(r.message).toMatch(/disabled/i);
  });

  it('returns a HealthCheck shape the watchdog can consume', async () => {
    process.env['SUDO_GROK_WEB_BRAIN'] = '1';
    const { checkGrokSeat } = await import('../../src/core/health/grok-seat-check.js');
    const r = await checkGrokSeat();
    expect(r.name).toBe('grok_seat');
    expect(['healthy', 'degraded', 'critical']).toContain(r.status);
    expect(typeof r.message).toBe('string');
    expect(() => new Date(r.lastCheck).toISOString()).not.toThrow();
  });

  it('never throws, even when the seat modules blow up', async () => {
    process.env['SUDO_GROK_WEB_BRAIN'] = '1';
    // No session/credentials exist under the temp DATA_DIR, so the seat modules
    // will fail internally. A watchdog check that dies tells you nothing.
    const { checkGrokSeat } = await import('../../src/core/health/grok-seat-check.js');
    await expect(checkGrokSeat()).resolves.toBeDefined();
  });
});

describe('deep-tier cadence latch', () => {
  it('persists to disk, so a restart cannot re-trigger the expensive tier', async () => {
    process.env['SUDO_GROK_WEB_BRAIN'] = '1';
    const { checkGrokSeat } = await import('../../src/core/health/grok-seat-check.js');
    await checkGrokSeat(Date.now(), path.join(dir, 'grok-seat-check-latch.json'));

    const latch = path.join(dir, 'grok-seat-check-latch.json');
    // The kairos repair loop kept an in-memory latch and re-ran ~80k tokens of
    // work on every restart — six times in one morning. Disk, not memory.
    expect(fs.existsSync(latch)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(latch, 'utf8')) as { lastDeep: number };
    expect(typeof raw.lastDeep).toBe('number');
  });

  it('does not re-run the deep tier within 24h', async () => {
    process.env['SUDO_GROK_WEB_BRAIN'] = '1';
    const { checkGrokSeat } = await import('../../src/core/health/grok-seat-check.js');
    const t0 = Date.now();
    const latchP = path.join(dir, 'grok-seat-check-latch.json');
    await checkGrokSeat(t0, latchP);
    const latch = path.join(dir, 'grok-seat-check-latch.json');
    const first = JSON.parse(fs.readFileSync(latch, 'utf8')) as { lastDeep: number };

    await checkGrokSeat(t0 + 60_000, latchP); // one tick later
    const second = JSON.parse(fs.readFileSync(latch, 'utf8')) as { lastDeep: number };
    expect(second.lastDeep).toBe(first.lastDeep);

    await checkGrokSeat(t0 + 25 * 60 * 60 * 1000, latchP); // past the interval
    const third = JSON.parse(fs.readFileSync(latch, 'utf8')) as { lastDeep: number };
    expect(third.lastDeep).toBeGreaterThan(first.lastDeep);
  });
});
