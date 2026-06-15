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

import { describe, it, expect } from 'vitest';
import {
  ConfidenceGate,
  isGateEnabled,
  readThreshold,
  readMinSamples,
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
