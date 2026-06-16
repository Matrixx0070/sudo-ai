/**
 * @file verify-gate.test.ts
 * Tests for the slice-1 ConfidenceGate dispatcher.
 *
 * Covers the eight branches called out in DONE MEANS:
 *   1. gate disabled → allow (gate-off)
 *   2. gate on, readonly tool → allow (readonly)
 *   3. gate on, absent safety → allow (readonly)  ← slice-1 narrow scope
 *   4. gate on, no calibration history → unknown (no-history)
 *   5. gate on, sparse history (< minSamples) → unknown (low-samples)
 *   6. gate on, confidence >= threshold → allow (above-threshold)
 *   7. gate on, confidence < threshold → escalate (below-threshold)
 *   8. gate on, unknown tool → allow (no-tool-def)
 *
 * Plus: env-var threshold override, env-var min-samples override, lookup throw
 * fail-open. No DB I/O; calibration lookup is injected.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import DatabaseConstructor from 'better-sqlite3';
import {
  ConfidenceGate,
  isGateEnabled,
  readThreshold,
  readMinSamples,
  computeBrierConfidence,
  computeCompositeConfidence,
  computeLiveConfidence,
  type ToolDefForGate,
  type ToolRegistryForGate,
} from '../../src/core/agent/verify-gate.js';

function makeRegistry(defs: Record<string, ToolDefForGate>): ToolRegistryForGate {
  return {
    get(name: string) {
      return defs[name];
    },
  };
}

describe('ConfidenceGate (slice 1: dispatcher)', () => {
  const destructiveTool: ToolDefForGate = { name: 'system.exec', safety: 'destructive' };
  const readonlyTool: ToolDefForGate = { name: 'fs.list', safety: 'readonly' };
  const unmarkedTool: ToolDefForGate = { name: 'meta.something' };
  const registry = makeRegistry({
    'system.exec': destructiveTool,
    'fs.list': readonlyTool,
    'meta.something': unmarkedTool,
  });

  it('VG-01 gate disabled → allow with reason gate-off', () => {
    const gate = new ConfidenceGate(registry, { enabled: false });
    const result = gate.evaluate('system.exec');
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('gate-off');
    expect(result.confidence).toBeNull();
  });

  it('VG-02 readonly tool bypasses (gate on)', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      confidenceLookup: () => ({ confidence: 0.1, samples: 50 }), // would normally escalate
    });
    const result = gate.evaluate('fs.list');
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('readonly');
  });

  it('VG-03 absent safety field bypasses (slice-1 narrow scope)', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      confidenceLookup: () => ({ confidence: 0.1, samples: 50 }),
    });
    const result = gate.evaluate('meta.something');
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('readonly');
  });

  it('VG-04 destructive tool, no history → unknown (no-history, fail-open)', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      confidenceLookup: () => null,
    });
    const result = gate.evaluate('system.exec');
    expect(result.decision).toBe('unknown');
    expect(result.reason).toBe('no-history');
    expect(result.samples).toBe(0);
  });

  it('VG-05 destructive tool, sparse history → unknown (low-samples, fail-open)', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      minSamples: 5,
      confidenceLookup: () => ({ confidence: 0.2, samples: 3 }),
    });
    const result = gate.evaluate('system.exec');
    expect(result.decision).toBe('unknown');
    expect(result.reason).toBe('low-samples');
    expect(result.samples).toBe(3);
  });

  it('VG-06 confidence >= threshold → allow (above-threshold)', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      threshold: 0.55,
      minSamples: 5,
      confidenceLookup: () => ({ confidence: 0.80, samples: 50 }),
    });
    const result = gate.evaluate('system.exec');
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('above-threshold');
    expect(result.confidence).toBeCloseTo(0.80);
  });

  it('VG-07 confidence < threshold → escalate (below-threshold)', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      threshold: 0.55,
      minSamples: 5,
      confidenceLookup: () => ({ confidence: 0.40, samples: 50 }),
    });
    const result = gate.evaluate('system.exec');
    expect(result.decision).toBe('escalate');
    expect(result.reason).toBe('below-threshold');
    expect(result.confidence).toBeCloseTo(0.40);
  });

  it('VG-08 unknown tool name → allow (no-tool-def)', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      confidenceLookup: () => ({ confidence: 0.1, samples: 50 }),
    });
    const result = gate.evaluate('nonexistent.tool');
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('no-tool-def');
  });

  it('VG-09 confidence lookup throws → allow (error, fail-open)', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      confidenceLookup: () => { throw new Error('disk full'); },
    });
    const result = gate.evaluate('system.exec');
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('error');
  });

  it('VG-10 registry.get throws → allow (error, fail-open)', () => {
    const throwingRegistry: ToolRegistryForGate = {
      get() { throw new Error('registry corrupt'); },
    };
    const gate = new ConfidenceGate(throwingRegistry, {
      enabled: true,
      confidenceLookup: () => ({ confidence: 0.1, samples: 50 }),
    });
    const result = gate.evaluate('system.exec');
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('error');
  });

  it('VG-12 non-finite confidence (NaN) → unknown (fail-open, not escalate)', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      threshold: 0.55,
      minSamples: 5,
      confidenceLookup: () => ({ confidence: NaN, samples: 50 }),
    });
    const result = gate.evaluate('system.exec');
    // Crucially NOT 'escalate' — NaN comparisons would false-out the >= check
    // and silently route to escalate without this guard.
    expect(result.decision).toBe('unknown');
    expect(result.confidence).toBeNull();
  });

  it('VG-13 non-finite confidence (Infinity) → unknown', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      threshold: 0.55,
      minSamples: 5,
      confidenceLookup: () => ({ confidence: Infinity, samples: 50 }),
    });
    const result = gate.evaluate('system.exec');
    expect(result.decision).toBe('unknown');
  });

  it('VG-11 threshold boundary (=) is allow, not escalate', () => {
    const gate = new ConfidenceGate(registry, {
      enabled: true,
      threshold: 0.55,
      minSamples: 5,
      confidenceLookup: () => ({ confidence: 0.55, samples: 50 }),
    });
    const result = gate.evaluate('system.exec');
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('above-threshold');
  });
});

describe('env helpers', () => {
  it('VG-ENV-01 isGateEnabled is OFF by default', () => {
    expect(isGateEnabled({})).toBe(false);
  });

  it('VG-ENV-02 isGateEnabled is ON only on exact "1"', () => {
    expect(isGateEnabled({ SUDO_VERIFY_GATE: '1' })).toBe(true);
    expect(isGateEnabled({ SUDO_VERIFY_GATE: 'true' })).toBe(false);
    expect(isGateEnabled({ SUDO_VERIFY_GATE: '0' })).toBe(false);
    expect(isGateEnabled({ SUDO_VERIFY_GATE: '' })).toBe(false);
  });

  it('VG-ENV-03 readThreshold falls back on invalid input', () => {
    expect(readThreshold({})).toBe(0.55);
    expect(readThreshold({ SUDO_VERIFY_GATE_THRESHOLD: 'nope' })).toBe(0.55);
    expect(readThreshold({ SUDO_VERIFY_GATE_THRESHOLD: '-1' })).toBe(0.55);
    expect(readThreshold({ SUDO_VERIFY_GATE_THRESHOLD: '1.5' })).toBe(0.55);
    expect(readThreshold({ SUDO_VERIFY_GATE_THRESHOLD: '0.8' })).toBe(0.8);
    expect(readThreshold({ SUDO_VERIFY_GATE_THRESHOLD: '0' })).toBe(0);
    expect(readThreshold({ SUDO_VERIFY_GATE_THRESHOLD: '1' })).toBe(1);
  });

  it('VG-ENV-04 readMinSamples falls back on invalid input', () => {
    expect(readMinSamples({})).toBe(5);
    expect(readMinSamples({ SUDO_VERIFY_GATE_MIN_SAMPLES: 'nope' })).toBe(5);
    expect(readMinSamples({ SUDO_VERIFY_GATE_MIN_SAMPLES: '0' })).toBe(5);
    expect(readMinSamples({ SUDO_VERIFY_GATE_MIN_SAMPLES: '10' })).toBe(10);
    expect(readMinSamples({ SUDO_VERIFY_GATE_MIN_SAMPLES: '3.9' })).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeBrierConfidence + computeCompositeConfidence (calibration-pivot)
//
// Real on-disk better-sqlite3 files because the readers open by path. Each
// test seeds a minimal calibration.db / audit.db schema with known rows then
// asserts the math + composite fallback policy.
// ---------------------------------------------------------------------------

describe('computeBrierConfidence + composite (calibration pivot)', () => {
  let tmpDir: string;
  let calibrationDbPath: string;
  let auditDbPath: string;

  function seedCalibration(
    rows: Array<{ predicted: number; outcome: 0 | 1; toolName: string | null; tsOffsetMs?: number }>,
  ): void {
    const db = new DatabaseConstructor(calibrationDbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS confidence_calibration (
        id        TEXT PRIMARY KEY,
        predicted REAL NOT NULL,
        outcome   INTEGER NOT NULL CHECK(outcome IN (0,1)),
        tag       TEXT,
        tool_name TEXT,
        ts        INTEGER NOT NULL
      )
    `);
    const ins = db.prepare(
      `INSERT INTO confidence_calibration (id, predicted, outcome, tag, tool_name, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const baseTs = Date.now();
    rows.forEach((r, i) => {
      ins.run(`row-${i}`, r.predicted, r.outcome, null, r.toolName, baseTs - (r.tsOffsetMs ?? i));
    });
    db.close();
  }

  function seedAudit(rows: Array<{ resource: string; outcome: string }>): void {
    const db = new DatabaseConstructor(auditDbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id        TEXT PRIMARY KEY,
        action    TEXT,
        resource  TEXT,
        outcome   TEXT,
        timestamp INTEGER NOT NULL
      )
    `);
    const ins = db.prepare(
      `INSERT INTO audit_log (id, action, resource, outcome, timestamp) VALUES (?, ?, ?, ?, ?)`,
    );
    rows.forEach((r, i) => ins.run(`a-${i}`, 'tool_call', r.resource, r.outcome, Date.now() - i));
    db.close();
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-gate-calib-'));
    calibrationDbPath = path.join(tmpDir, 'calibration.db');
    auditDbPath = path.join(tmpDir, 'audit.db');
  });

  beforeEach(() => {
    // Pure hermetic test: wipe both DB files so a previously-seeded row
    // from another test cannot bleed in. Verifier MED-1 on this slice.
    try { fs.rmSync(calibrationDbPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(auditDbPath, { force: true }); } catch { /* ignore */ }
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns null when calibration.db does not exist', () => {
    const missing = path.join(tmpDir, 'nonexistent.db');
    expect(computeBrierConfidence('system.exec', missing)).toBeNull();
  });

  it('returns null when no rows match the tool', () => {
    seedCalibration([
      { predicted: 0.9, outcome: 1, toolName: 'fs.write' },
    ]);
    expect(computeBrierConfidence('system.exec', calibrationDbPath)).toBeNull();
  });

  it('computes 1 - Brier for perfect predictor (predicted=1, outcome=1)', () => {
    seedCalibration([
      { predicted: 1, outcome: 1, toolName: 'system.exec' },
      { predicted: 1, outcome: 1, toolName: 'system.exec' },
      { predicted: 1, outcome: 1, toolName: 'system.exec' },
    ]);
    const r = computeBrierConfidence('system.exec', calibrationDbPath);
    expect(r).not.toBeNull();
    expect(r!.samples).toBe(3);
    expect(r!.confidence).toBeCloseTo(1.0, 9);
  });

  it('penalizes overconfidence (predicted=1, outcome=0) → confidence=0', () => {
    seedCalibration([
      { predicted: 1, outcome: 0, toolName: 'system.exec' },
      { predicted: 1, outcome: 0, toolName: 'system.exec' },
    ]);
    const r = computeBrierConfidence('system.exec', calibrationDbPath);
    expect(r).not.toBeNull();
    expect(r!.confidence).toBeCloseTo(0, 9);
  });

  it('mixed: predicted=0.8 vs outcome=1 + predicted=0.6 vs outcome=0 → 1 - 0.20 = 0.80', () => {
    seedCalibration([
      { predicted: 0.8, outcome: 1, toolName: 'system.exec' },
      { predicted: 0.6, outcome: 0, toolName: 'system.exec' },
    ]);
    const r = computeBrierConfidence('system.exec', calibrationDbPath);
    expect(r!.confidence).toBeCloseTo(0.80, 5);
    expect(r!.samples).toBe(2);
  });

  it('skips non-numeric predicted rows', () => {
    seedCalibration([
      { predicted: 1, outcome: 1, toolName: 'system.exec' },
    ]);
    // Sneak a text-typed predicted into the REAL column directly. SQLite's
    // loose typing accepts it; the reader's typeof-guard must then skip it.
    const db = new DatabaseConstructor(calibrationDbPath);
    db.prepare(
      `INSERT INTO confidence_calibration (id, predicted, outcome, tag, tool_name, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('row-bad', 'not-a-number', 0, null, 'system.exec', Date.now() - 1);
    db.close();

    const r = computeBrierConfidence('system.exec', calibrationDbPath);
    expect(r!.samples).toBe(1);
    expect(r!.confidence).toBeCloseTo(1.0, 9);
  });

  it('composite: Brier wins when samples ≥ minSamples', () => {
    seedCalibration(Array.from({ length: 5 }, () => ({
      predicted: 0.9, outcome: 1 as 0 | 1, toolName: 'system.exec',
    })));
    // Audit would say 0% success — composite must NOT see it.
    seedAudit(Array.from({ length: 50 }, () => ({ resource: 'system.exec', outcome: 'failure' })));

    const r = computeCompositeConfidence('system.exec', {
      minSamples: 5,
      brierDbPath: calibrationDbPath,
      auditDbPath,
    });
    expect(r!.samples).toBe(5);
    expect(r!.confidence).toBeCloseTo(0.99, 2); // Brier ≈ 0.01
  });

  it('composite: falls back to audit when Brier has < minSamples rows', () => {
    seedCalibration([
      { predicted: 0.9, outcome: 1, toolName: 'system.exec' }, // only 1 row
    ]);
    seedAudit(Array.from({ length: 10 }, (_, i) => ({
      resource: 'system.exec',
      outcome: i < 8 ? 'success' : 'failure', // 80% success
    })));

    const r = computeCompositeConfidence('system.exec', {
      minSamples: 5,
      brierDbPath: calibrationDbPath,
      auditDbPath,
    });
    expect(r!.samples).toBe(10);
    expect(r!.confidence).toBeCloseTo(0.8, 5);
  });

  it('composite: falls back to audit when calibration.db is missing', () => {
    seedAudit([{ resource: 'system.exec', outcome: 'success' }]);

    const r = computeCompositeConfidence('system.exec', {
      minSamples: 5,
      brierDbPath: path.join(tmpDir, 'definitely-missing.db'),
      auditDbPath,
    });
    // computeLiveConfidence returns the audit result.
    const audit = computeLiveConfidence('system.exec', auditDbPath);
    expect(r).toEqual(audit);
  });

  it('composite: returns null when both sources have no rows for the tool', () => {
    seedCalibration([{ predicted: 0.9, outcome: 1, toolName: 'fs.write' }]);
    seedAudit([{ resource: 'fs.write', outcome: 'success' }]);

    const r = computeCompositeConfidence('system.exec', {
      minSamples: 5,
      brierDbPath: calibrationDbPath,
      auditDbPath,
    });
    expect(r).toBeNull();
  });
});
