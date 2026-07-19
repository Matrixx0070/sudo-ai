/**
 * @file tests/health/cw6-homeostat.test.ts
 * @description CW6 — HomeostatCore (sensing only). Proves: (1) KAIROS
 * checkDiskSpace/checkMemory produce byte-identical HealthCheck outputs on the
 * same fixture sensor readings after the read-path refactor (their decision
 * logic + message strings are unchanged); (2) urgency math; (3) the
 * essential-variables vector shape with canonical setpoints; (4) gateway
 * sensors fail open to available:false when gateway.db is absent.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'cw6-data-'));
process.env['DATA_DIR'] = dataDir; // no gateway.db here -> sensors fail open

// Mock the homeostat SENSORS (not the module logic) so checks get fixtures.
vi.mock('../../src/core/health/homeostat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/health/homeostat.js')>();
  return { ...real, readDiskUsedPct: vi.fn(() => 42), readRamUsedPct: vi.fn(() => 42) };
});

import { checkDiskSpace, checkMemory } from '../../src/core/health/checks.js';
import * as homeostat from '../../src/core/health/homeostat.js';
import { computeUrgency, readEssentialVariables } from '../../src/core/health/homeostat.js';

const diskSensor = homeostat.readDiskUsedPct as ReturnType<typeof vi.fn>;
const ramSensor = homeostat.readRamUsedPct as ReturnType<typeof vi.fn>;

afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('CW6 — KAIROS reads sensors from HomeostatCore, decisions byte-identical', () => {
  let fixCalls: number;
  const fixFn = async (): Promise<void> => { fixCalls += 1; };
  beforeEach(() => { fixCalls = 0; });

  it('CW6-1: disk healthy fixture (75%) — exact legacy message, no fix', async () => {
    diskSensor.mockReturnValue(75);
    const r = await checkDiskSpace(fixFn);
    expect(r.status).toBe('healthy');
    expect(r.message).toBe('Disk 75% used'); // byte-identical legacy string
    expect(fixCalls).toBe(0);
  });

  it('CW6-2: disk degraded fixture (85%) — exact legacy message, no fix', async () => {
    diskSensor.mockReturnValue(85);
    const r = await checkDiskSpace(fixFn);
    expect(r.status).toBe('degraded');
    expect(r.message).toBe('Disk 85% full — approaching limit');
    expect(fixCalls).toBe(0);
  });

  it('CW6-3: disk critical fixture (95%) — exact legacy message + reflex fired', async () => {
    diskSensor.mockReturnValue(95);
    const r = await checkDiskSpace(fixFn);
    expect(r.status).toBe('critical');
    expect(r.message).toBe('Disk 95% full — cleanup attempted');
    expect(r.autoFix).toBe('Removed old log archives and temp files');
    expect(fixCalls).toBe(1);
  });

  it('CW6-4: disk sensor total failure — legacy degraded shape preserved', async () => {
    diskSensor.mockImplementation(() => { throw new Error('statfs down'); });
    const r = await checkDiskSpace(fixFn);
    expect(r.status).toBe('degraded');
    expect(r.message).toContain('Cannot read disk stats:');
    diskSensor.mockReturnValue(42);
  });

  it('CW6-5: memory fixtures — legacy status ladder + message prefix intact', async () => {
    ramSensor.mockReturnValue(50);
    expect((await checkMemory(fixFn)).status).toBe('healthy');
    ramSensor.mockReturnValue(85);
    expect((await checkMemory(fixFn)).status).toBe('degraded');
    ramSensor.mockReturnValue(95);
    const crit = await checkMemory(fixFn);
    expect(crit.status).toBe('critical');
    expect(crit.message).toMatch(/^System RAM 95% used; heap /); // legacy format
    expect(fixCalls).toBe(1); // only the critical reading fired the reflex
  });
});

describe('CW6 — urgency + vector', () => {
  it('CW6-6: urgency is 0 at/below setpoint, linear to 1 at the bound, clamped', () => {
    expect(computeUrgency(50, 80, 90)).toBe(0);
    expect(computeUrgency(80, 80, 90)).toBe(0);
    expect(computeUrgency(85, 80, 90)).toBeCloseTo(0.5, 6);
    expect(computeUrgency(90, 80, 90)).toBe(1);
    expect(computeUrgency(99, 80, 90)).toBe(1);
    expect(computeUrgency(85, 90, 90)).toBe(0); // degenerate bounds -> 0
  });

  it('CW6-7: vector has the six mandated variables with canonical setpoints; gateway sensors fail open', () => {
    const vars = readEssentialVariables();
    const names = vars.map((v) => v.name).sort();
    expect(names).toEqual(['disk_pct', 'error_rate', 'queue_depth', 'ram_mb', 'tokens_day', 'usd_day']);

    const disk = vars.find((v) => v.name === 'disk_pct')!;
    expect(disk.setpoint).toBe(80); // canonical DISK_DEGRADED_PCT from checks.ts
    expect(disk.bounds[1]).toBe(90); // DISK_CRITICAL_PCT

    // No gateway.db at this DATA_DIR -> spend sensors report unavailable, urgency 0.
    for (const name of ['usd_day', 'tokens_day', 'error_rate'] as const) {
      const v = vars.find((x) => x.name === name)!;
      expect(v.available).toBe(false);
      expect(v.value).toBeNull();
      expect(v.urgency).toBe(0);
    }
    // queue_depth honestly unavailable (no cheap accessor yet).
    expect(vars.find((v) => v.name === 'queue_depth')!.available).toBe(false);
    // Every urgency in [0,1].
    for (const v of vars) { expect(v.urgency).toBeGreaterThanOrEqual(0); expect(v.urgency).toBeLessThanOrEqual(1); }
  });
});
