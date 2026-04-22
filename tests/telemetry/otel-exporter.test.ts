/**
 * @file tests/telemetry/otel-exporter.test.ts
 * @description Wave 7F: Pure function tests for otel-exporter.ts.
 *
 * Tests:
 *   OTEL-1  digestToPrometheusText emits alignment metrics when slice present
 *   OTEL-2  digestToPrometheusText emits sudo_alignment_up 0 when alignment null
 *   OTEL-3  digestToPrometheusText emits trust metrics including tier_numeric
 *   OTEL-4  digestToPrometheusText emits sudo_trust_up 0 when trust null
 *   OTEL-5  digestToPrometheusText emits labeled reanchor_total lines per trigger
 *   OTEL-6  digestToPrometheusText emits labeled epistemic_events_total by verdict
 *   OTEL-7  digestToPrometheusText emits up=0 for all null slices
 *   OTEL-8  toOTLPMetrics returns valid resourceMetrics shape
 *   OTEL-9  toOTLPMetrics emits gauge for alignment.score
 *   OTEL-10 toOTLPMetrics emits sum for calibration samples
 *   OTEL-11 toOTLPMetrics emits labeled sum for reanchor triggers
 *   OTEL-12 toOTLPMetrics skips metrics when slices are null (no throw)
 *   OTEL-13 digestToPrometheusText outputs correct label escaping for special chars
 */

import { describe, it, expect } from 'vitest';
import {
  digestToPrometheusText,
  toOTLPMetrics,
  type DigestSnapshot,
} from '../../src/core/telemetry/otel-exporter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFullSnapshot(): DigestSnapshot {
  return {
    windowDays: 7,
    computedAt: '2026-04-13T00:00:00.000Z',
    alignment: {
      overallScore: 0.823,
      score: 0.823,
      level: 'GREEN',
    },
    trust: {
      tier: 'HIGH',
      score: 0.91,
      windowSizeDays: 30,
      lastAdjustedAt: '2026-04-13T00:00:00.000Z',
    },
    calibration: {
      totalSamples: 42,
      brierScore: 0.337,
      overallAvgPredicted: 0.75,
      overallSuccessRate: 0.80,
    },
    commitments: {
      expiringCount: 3,
      expiredCount: 1,
    },
    epistemic: {
      total: 45,
      byTag: {},
      byDecision: { PASS: 40, BLOCK: 4, UNCERTAIN: 1 },
      blockRate: 0.09,
      window: { sinceMs: 0, untilMs: 1 },
    },
    patterns: {
      totalMistakes: 10,
      uniquePatterns: 4,
      recurringCount: 2,
    },
    diagnostics: {
      totalEventsScanned: 100,
      correlationCount: 3,
      topCorrelation: null,
    },
    injection: {
      kind: 'injection-detected',
      count: 5,
      score: -2.5,
    },
    reanchor: {
      total: 7,
      byTrigger: { startup: 5, 'post-veto': 2 },
      windowDays: 7,
      computedAt: '2026-04-13T00:00:00.000Z',
      lastReAnchorAt: 1744502400000,
    },
    resolutions: {
      total: 8,
      honored: 6,
      abandoned: 1,
      expiredAcknowledged: 1,
      honorRate: 0.75,
      windowDays: 7,
      computedAt: '2026-04-13T00:00:00.000Z',
    },
  };
}

function makeNullSnapshot(): DigestSnapshot {
  return {
    windowDays: 7,
    computedAt: '2026-04-13T00:00:00.000Z',
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
// Prometheus formatter tests
// ---------------------------------------------------------------------------

describe('digestToPrometheusText', () => {
  it('OTEL-1 emits alignment metrics when slice present', () => {
    const snapshot = makeFullSnapshot();
    const text = digestToPrometheusText(snapshot);
    expect(text).toContain('sudo_alignment_score 0.823');
    expect(text).toContain('# TYPE sudo_alignment_score gauge');
    expect(text).toContain('# HELP sudo_alignment_score');
    expect(text).toContain('sudo_alignment_status 2'); // GREEN=2
    expect(text).toContain('sudo_alignment_up 1');
  });

  it('OTEL-2 emits sudo_alignment_up 0 when alignment is null', () => {
    const snapshot = makeNullSnapshot();
    const text = digestToPrometheusText(snapshot);
    expect(text).toContain('sudo_alignment_up 0');
    expect(text).not.toContain('sudo_alignment_score');
  });

  it('OTEL-3 emits trust metrics including tier_numeric', () => {
    const snapshot = makeFullSnapshot();
    const text = digestToPrometheusText(snapshot);
    expect(text).toContain('sudo_trust_tier_numeric 3'); // HIGH=3
    expect(text).toContain('sudo_trust_score 0.91');
    expect(text).toContain('sudo_trust_up 1');
  });

  it('OTEL-4 emits sudo_trust_up 0 when trust is null', () => {
    const snapshot = makeNullSnapshot();
    const text = digestToPrometheusText(snapshot);
    expect(text).toContain('sudo_trust_up 0');
    expect(text).not.toContain('sudo_trust_tier_numeric');
  });

  it('OTEL-5 emits labeled reanchor_total lines per trigger', () => {
    const snapshot = makeFullSnapshot();
    const text = digestToPrometheusText(snapshot);
    expect(text).toContain('sudo_reanchor_total{trigger="startup"} 5');
    expect(text).toContain('sudo_reanchor_total{trigger="post-veto"} 2');
    expect(text).toContain('# TYPE sudo_reanchor_total counter');
  });

  it('OTEL-6 emits labeled epistemic_events_total by verdict', () => {
    const snapshot = makeFullSnapshot();
    const text = digestToPrometheusText(snapshot);
    // PASS → pass, BLOCK → block, UNCERTAIN → uncertain
    expect(text).toContain('sudo_epistemic_events_total{verdict="pass"} 40');
    expect(text).toContain('sudo_epistemic_events_total{verdict="block"} 4');
    expect(text).toContain('sudo_epistemic_events_total{verdict="uncertain"} 1');
  });

  it('OTEL-7 emits up=0 for all null slices', () => {
    const snapshot = makeNullSnapshot();
    const text = digestToPrometheusText(snapshot);
    const subsystems = ['alignment', 'trust', 'calibration', 'commitments', 'epistemic', 'patterns', 'diagnostics', 'injection', 'reanchor', 'resolutions'];
    for (const name of subsystems) {
      expect(text).toContain(`sudo_${name}_up 0`);
    }
  });

  it('OTEL-13 escapes double-quotes in label values', () => {
    const snapshot = makeFullSnapshot();
    snapshot.reanchor!.byTrigger = { 'say "hi"': 1 };
    const text = digestToPrometheusText(snapshot);
    expect(text).toContain('trigger="say \\"hi\\""');
  });

  it('emits calibration metrics correctly', () => {
    const snapshot = makeFullSnapshot();
    const text = digestToPrometheusText(snapshot);
    expect(text).toContain('sudo_calibration_brier 0.337');
    expect(text).toContain('sudo_calibration_samples 42');
    expect(text).toContain('# TYPE sudo_calibration_samples counter');
    expect(text).toContain('sudo_calibration_up 1');
  });

  it('emits resolutions honor rate', () => {
    const snapshot = makeFullSnapshot();
    const text = digestToPrometheusText(snapshot);
    expect(text).toContain('sudo_resolutions_honor_rate 0.75');
  });

  it('emits injection total', () => {
    const snapshot = makeFullSnapshot();
    const text = digestToPrometheusText(snapshot);
    expect(text).toContain('sudo_injection_detections_total 5');
  });

  it('emits reanchor_last_ts_seconds as unix epoch', () => {
    const snapshot = makeFullSnapshot();
    // lastReAnchorAt = 1744502400000 ms => 1744502400 s
    const text = digestToPrometheusText(snapshot);
    expect(text).toContain('sudo_reanchor_last_ts_seconds 1744502400');
  });
});

// ---------------------------------------------------------------------------
// OTLP formatter tests
// ---------------------------------------------------------------------------

describe('toOTLPMetrics', () => {
  it('OTEL-8 returns valid resourceMetrics shape', () => {
    const snapshot = makeFullSnapshot();
    const result = toOTLPMetrics(snapshot, { serviceName: 'sudo-ai-v5', instanceId: 'test-1' });
    expect(result).toHaveProperty('resourceMetrics');
    expect(Array.isArray(result.resourceMetrics)).toBe(true);
    expect(result.resourceMetrics.length).toBe(1);
    const rm = result.resourceMetrics[0]!;
    expect(rm).toHaveProperty('resource');
    expect(rm).toHaveProperty('scopeMetrics');
    expect(rm.resource.attributes.find(a => a.key === 'service.name')?.value.stringValue).toBe('sudo-ai-v5');
    expect(rm.resource.attributes.find(a => a.key === 'service.instance.id')?.value.stringValue).toBe('test-1');
  });

  it('OTEL-9 emits gauge for alignment.score', () => {
    const snapshot = makeFullSnapshot();
    const result = toOTLPMetrics(snapshot, { serviceName: 'sudo-ai-v5', instanceId: 'x' });
    const metrics = result.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    const scoreMetric = metrics.find(m => m.name === 'sudo.alignment.score');
    expect(scoreMetric).toBeDefined();
    expect(scoreMetric!.gauge).toBeDefined();
    expect(scoreMetric!.gauge!.dataPoints[0]!.asDouble).toBeCloseTo(0.823);
  });

  it('OTEL-10 emits sum (counter) for calibration samples', () => {
    const snapshot = makeFullSnapshot();
    const result = toOTLPMetrics(snapshot, { serviceName: 'sudo-ai-v5', instanceId: 'x' });
    const metrics = result.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    const samplesMetric = metrics.find(m => m.name === 'sudo.calibration.samples');
    expect(samplesMetric).toBeDefined();
    expect(samplesMetric!.sum).toBeDefined();
    expect(samplesMetric!.sum!.isMonotonic).toBe(true);
    expect(samplesMetric!.sum!.dataPoints[0]!.asDouble).toBe(42);
  });

  it('OTEL-11 emits labeled sum for reanchor triggers', () => {
    const snapshot = makeFullSnapshot();
    const result = toOTLPMetrics(snapshot, { serviceName: 'sudo-ai-v5', instanceId: 'x' });
    const metrics = result.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    const raMetrics = metrics.filter(m => m.name === 'sudo.reanchor.total');
    expect(raMetrics.length).toBe(2); // startup + post-veto
    const startupMetric = raMetrics.find(m =>
      m.sum?.dataPoints[0]?.attributes?.some(a => a.key === 'trigger' && a.value.stringValue === 'startup')
    );
    expect(startupMetric).toBeDefined();
    expect(startupMetric!.sum!.dataPoints[0]!.asDouble).toBe(5);
  });

  it('OTEL-12 does not throw when all slices are null', () => {
    const snapshot = makeNullSnapshot();
    expect(() => toOTLPMetrics(snapshot, { serviceName: 'sudo-ai-v5', instanceId: 'x' })).not.toThrow();
    const result = toOTLPMetrics(snapshot, { serviceName: 'sudo-ai-v5', instanceId: 'x' });
    const metrics = result.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    expect(metrics.length).toBe(0);
  });

  it('scope has correct name and version', () => {
    const snapshot = makeNullSnapshot();
    const result = toOTLPMetrics(snapshot, { serviceName: 'sudo-ai-v5', instanceId: 'x' });
    const scope = result.resourceMetrics[0]!.scopeMetrics[0]!.scope;
    expect(scope.name).toBe('sudo-ai-alignment');
    expect(scope.version).toBe('7F');
  });

  it('OTLP dataPoints have timeUnixNano string', () => {
    const snapshot = makeFullSnapshot();
    const result = toOTLPMetrics(snapshot, { serviceName: 'sudo-ai-v5', instanceId: 'x' });
    const metrics = result.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    for (const m of metrics) {
      const dp = m.gauge?.dataPoints[0] ?? m.sum?.dataPoints[0];
      expect(dp).toBeDefined();
      expect(typeof dp!.timeUnixNano).toBe('string');
      expect(dp!.timeUnixNano.length).toBeGreaterThan(0);
    }
  });
});
