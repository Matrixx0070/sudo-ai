/**
 * @file tests/meta/synth-seal-metrics.test.ts
 * @description Wave 2.2h-obs: Prometheus counter verification for LD_PRELOAD seal metrics.
 *
 * Tests:
 *   SEAL-1  synth_seal_install_total increments correctly
 *   SEAL-2  synth_seal_missing_so_total accumulates to exact count
 *   SEAL-3  digestToPrometheusText emits all 4 seal metric names
 *   SEAL-4  seal counters always emit (0) even with no increments
 *   SEAL-5  seal Prom block has valid HELP, TYPE, and value lines
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { metrics } from '../../src/core/health/metrics.js';
import {
  digestToPrometheusText,
  type DigestSnapshot,
} from '../../src/core/telemetry/otel-exporter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNullSnapshot(): DigestSnapshot {
  return {
    windowDays: 7,
    computedAt: '2026-04-19T00:00:00.000Z',
    alignment: null,
    trust: null,
    calibration: null,
    commitments: null,
    epistemic: null,
    patterns: null,
    diagnostics: null,
    injection: null,
    reanchor: null,
    resolutions: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('synth-seal metrics', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('SEAL-1 synth_seal_install_total increments correctly', () => {
    metrics.increment('synth_seal_install_total');
    expect(metrics.getCounter('synth_seal_install_total')).toBeGreaterThanOrEqual(1);
  });

  it('SEAL-2 synth_seal_missing_so_total accumulates to exact count', () => {
    metrics.increment('synth_seal_missing_so_total');
    metrics.increment('synth_seal_missing_so_total');
    metrics.increment('synth_seal_missing_so_total');
    expect(metrics.getCounter('synth_seal_missing_so_total')).toBe(3);
  });

  it('SEAL-3 digestToPrometheusText emits all 4 seal metric names', () => {
    metrics.increment('synth_seal_install_total');
    metrics.increment('synth_seal_missing_so_total');
    metrics.increment('synth_seal_sigsys_total');
    const text = digestToPrometheusText(makeNullSnapshot());
    expect(text).toContain('sudo_synth_seal_install_total');
    expect(text).toContain('sudo_synth_seal_missing_so_total');
    expect(text).toContain('sudo_synth_seal_sigsys_total');
    expect(text).toContain('sudo_synth_seal_up 1');
  });

  it('SEAL-4 seal counters always emit 0 even with no increments', () => {
    const text = digestToPrometheusText(makeNullSnapshot());
    expect(text).toContain('sudo_synth_seal_install_total 0');
    expect(text).toContain('sudo_synth_seal_missing_so_total 0');
    expect(text).toContain('sudo_synth_seal_sigsys_total 0');
  });

  it('SEAL-5 seal Prom block has valid HELP, TYPE, and value lines per metric', () => {
    const text = digestToPrometheusText(makeNullSnapshot());
    // Each seal metric must have HELP, TYPE, and a value line
    for (const name of [
      'sudo_synth_seal_install_total',
      'sudo_synth_seal_missing_so_total',
      'sudo_synth_seal_sigsys_total',
      'sudo_synth_seal_up',
    ]) {
      expect(text).toContain(`# HELP ${name}`);
      expect(text).toContain(`# TYPE ${name}`);
      // value line: name followed by a space and a number
      expect(text).toMatch(new RegExp(`^${name} \\d`, 'm'));
    }
  });
});
