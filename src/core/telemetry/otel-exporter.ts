/**
 * telemetry/otel-exporter.ts — OTEL-style telemetry export utilities.
 *
 * Provides two pure, stateless formatters:
 *   - digestToPrometheusText(snapshot) → Prometheus text exposition format
 *   - toOTLPMetrics(snapshot, resource) → OTLP/HTTP JSON format
 *
 * Both consume a DigestSnapshot (from admin-routes collectDigestSnapshot).
 * Neither performs I/O; fully testable in isolation.
 */

import { metrics } from '../health/metrics.js';

// ---------------------------------------------------------------------------
// DigestSnapshot — typed shape for all 11 telemetry subsystems.
// Each slice is nullable: null means the subsystem was unavailable.
// ---------------------------------------------------------------------------

export interface AlignmentSlice {
  overallScore?: number;
  score?: number;
  level?: string;
  status?: string;
}

export interface TrustSlice {
  tier: string;
  score: number;
  windowSizeDays: number;
  lastAdjustedAt: string;
}

export interface CalibrationSlice {
  totalSamples: number;
  brierScore: number;
  overallAvgPredicted: number;
  overallSuccessRate: number;
}

export interface CommitmentsSlice {
  expiringCount: number | null;
  expiredCount: number | null;
}

export interface EpistemicSlice {
  total: number;
  byTag: Record<string, number>;
  byDecision: Record<string, number>;
  blockRate: number;
  window: { sinceMs: number; untilMs: number };
}

export interface PatternsSlice {
  totalMistakes: number;
  uniquePatterns: number;
  recurringCount: number;
}

export interface DiagnosticsSlice {
  totalEventsScanned: number;
  correlationCount: number;
  topCorrelation: unknown;
}

export interface InjectionSlice {
  kind: string;
  count: number;
  score: number;
}

export interface ReanchorSlice {
  total: number;
  byTrigger: Record<string, number>;
  windowDays: number;
  computedAt: string;
  lastReAnchorAt?: number;
}

export interface ResolutionsSlice {
  total: number;
  honored: number;
  abandoned: number;
  expiredAcknowledged: number;
  honorRate: number;
  windowDays: number;
  computedAt: string;
}

export interface DigestSnapshot {
  windowDays: number;
  computedAt: string;
  alignment: AlignmentSlice | null;
  trust: TrustSlice | null;
  calibration: CalibrationSlice | null;
  commitments: CommitmentsSlice | null;
  epistemic: EpistemicSlice | null;
  patterns: PatternsSlice | null;
  diagnostics: DiagnosticsSlice | null;
  injection: InjectionSlice | null;
  reanchor: ReanchorSlice | null;
  resolutions: ResolutionsSlice | null;
}

// ---------------------------------------------------------------------------
// OTLP types (minimal subset for gauges + sums)
// ---------------------------------------------------------------------------

interface OTLPAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number };
}

interface OTLPDataPoint {
  attributes?: OTLPAttribute[];
  startTimeUnixNano?: string;
  timeUnixNano: string;
  asDouble?: number;
  asInt?: number;
}

interface OTLPGauge {
  dataPoints: OTLPDataPoint[];
}

interface OTLPSum {
  dataPoints: OTLPDataPoint[];
  aggregationTemporality: number;
  isMonotonic: boolean;
}

interface OTLPMetric {
  name: string;
  description?: string;
  unit?: string;
  gauge?: OTLPGauge;
  sum?: OTLPSum;
}

interface OTLPScopeMetrics {
  scope: { name: string; version: string };
  metrics: OTLPMetric[];
}

interface OTLPResourceMetrics {
  resource: { attributes: OTLPAttribute[] };
  scopeMetrics: OTLPScopeMetrics[];
}

export interface OTLPMetricsRequest {
  resourceMetrics: OTLPResourceMetrics[];
}

// ---------------------------------------------------------------------------
// Tier → numeric mapping
// ---------------------------------------------------------------------------

const TIER_MAP: Record<string, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  PROBATION: 0,
};

const STATUS_MAP: Record<string, number> = {
  GREEN: 2,
  YELLOW: 1,
  RED: 0,
};

// ---------------------------------------------------------------------------
// Prometheus text formatter
// ---------------------------------------------------------------------------

function promLine(name: string, labels: Record<string, string> | null, value: number): string {
  if (labels && Object.keys(labels).length > 0) {
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
      .join(',');
    return `${name}{${labelStr}} ${value}`;
  }
  return `${name} ${value}`;
}

function promBlock(
  name: string,
  help: string,
  type: 'gauge' | 'counter',
  lines: Array<{ labels: Record<string, string> | null; value: number }>,
): string {
  const header = `# HELP ${name} ${help}\n# TYPE ${name} ${type}`;
  const body = lines.map(l => promLine(name, l.labels, l.value)).join('\n');
  return `${header}\n${body}`;
}

/**
 * Convert a DigestSnapshot into Prometheus text exposition format.
 * Missing subsystems (null slices) emit an `up` gauge of 0 instead of
 * omitting the block entirely — keeps scrape configs always valid.
 */
export function digestToPrometheusText(snapshot: DigestSnapshot): string {
  const blocks: string[] = [];

  // --- alignment ---
  if (snapshot.alignment !== null) {
    const al = snapshot.alignment;
    const score = al.overallScore ?? al.score ?? 0;
    const statusStr = (al.level ?? al.status ?? '').toUpperCase();
    const statusNum = STATUS_MAP[statusStr] ?? -1;
    blocks.push(promBlock('sudo_alignment_score', 'Current alignment posture score', 'gauge', [{ labels: null, value: score }]));
    blocks.push(promBlock('sudo_alignment_status', 'Alignment status (GREEN=2, YELLOW=1, RED=0)', 'gauge', [{ labels: null, value: statusNum }]));
    blocks.push(promBlock('sudo_alignment_up', 'Alignment subsystem available', 'gauge', [{ labels: null, value: 1 }]));
  } else {
    blocks.push(promBlock('sudo_alignment_up', 'Alignment subsystem available', 'gauge', [{ labels: null, value: 0 }]));
  }

  // --- trust ---
  if (snapshot.trust !== null) {
    const tr = snapshot.trust;
    const tierNum = TIER_MAP[tr.tier.toUpperCase()] ?? -1;
    blocks.push(promBlock('sudo_trust_tier_numeric', 'Trust tier as numeric (HIGH=3, MEDIUM=2, LOW=1, PROBATION=0)', 'gauge', [{ labels: null, value: tierNum }]));
    blocks.push(promBlock('sudo_trust_score', 'Trust tier raw score', 'gauge', [{ labels: null, value: tr.score }]));
    blocks.push(promBlock('sudo_trust_up', 'Trust subsystem available', 'gauge', [{ labels: null, value: 1 }]));
  } else {
    blocks.push(promBlock('sudo_trust_up', 'Trust subsystem available', 'gauge', [{ labels: null, value: 0 }]));
  }

  // --- calibration ---
  if (snapshot.calibration !== null) {
    const cal = snapshot.calibration;
    blocks.push(promBlock('sudo_calibration_brier', 'Brier score from calibration tracker (lower is better)', 'gauge', [{ labels: null, value: cal.brierScore }]));
    blocks.push(promBlock('sudo_calibration_samples', 'Total calibration samples', 'counter', [{ labels: null, value: cal.totalSamples }]));
    blocks.push(promBlock('sudo_calibration_up', 'Calibration subsystem available', 'gauge', [{ labels: null, value: 1 }]));
  } else {
    blocks.push(promBlock('sudo_calibration_up', 'Calibration subsystem available', 'gauge', [{ labels: null, value: 0 }]));
  }

  // --- commitments ---
  if (snapshot.commitments !== null) {
    const cm = snapshot.commitments;
    blocks.push(promBlock('sudo_commitments_expiring_count', 'Commitments in expiring window', 'gauge', [{ labels: null, value: cm.expiringCount ?? 0 }]));
    blocks.push(promBlock('sudo_commitments_expired_count', 'Commitments expired', 'gauge', [{ labels: null, value: cm.expiredCount ?? 0 }]));
    blocks.push(promBlock('sudo_commitments_up', 'Commitments subsystem available', 'gauge', [{ labels: null, value: 1 }]));
  } else {
    blocks.push(promBlock('sudo_commitments_up', 'Commitments subsystem available', 'gauge', [{ labels: null, value: 0 }]));
  }

  // --- epistemic ---
  if (snapshot.epistemic !== null) {
    const ep = snapshot.epistemic;
    const verdicts = ep.byDecision ?? {};
    const verdictLines = Object.entries(verdicts).map(([verdict, count]) => ({
      labels: { verdict: verdict.toLowerCase() },
      value: count,
    }));
    if (verdictLines.length === 0) {
      verdictLines.push({ labels: { verdict: 'pass' }, value: 0 });
    }
    blocks.push(promBlock('sudo_epistemic_events_total', 'Total epistemic gate events by verdict', 'counter', verdictLines));
    blocks.push(promBlock('sudo_epistemic_up', 'Epistemic subsystem available', 'gauge', [{ labels: null, value: 1 }]));
  } else {
    blocks.push(promBlock('sudo_epistemic_up', 'Epistemic subsystem available', 'gauge', [{ labels: null, value: 0 }]));
  }

  // --- patterns ---
  if (snapshot.patterns !== null) {
    const pt = snapshot.patterns;
    blocks.push(promBlock('sudo_patterns_total_mistakes', 'Total mistake patterns recorded', 'counter', [{ labels: null, value: pt.totalMistakes }]));
    blocks.push(promBlock('sudo_patterns_recurring_count', 'Number of recurring patterns', 'gauge', [{ labels: null, value: pt.recurringCount }]));
    blocks.push(promBlock('sudo_patterns_unique', 'Unique patterns detected', 'gauge', [{ labels: null, value: pt.uniquePatterns }]));
    blocks.push(promBlock('sudo_patterns_up', 'Patterns subsystem available', 'gauge', [{ labels: null, value: 1 }]));
  } else {
    blocks.push(promBlock('sudo_patterns_up', 'Patterns subsystem available', 'gauge', [{ labels: null, value: 0 }]));
  }

  // --- diagnostics ---
  if (snapshot.diagnostics !== null) {
    const dg = snapshot.diagnostics;
    blocks.push(promBlock('sudo_diagnostics_events_scanned', 'Total events scanned by cross-signal diagnostics', 'counter', [{ labels: null, value: dg.totalEventsScanned }]));
    blocks.push(promBlock('sudo_diagnostics_correlations', 'Number of signal correlations detected', 'gauge', [{ labels: null, value: dg.correlationCount }]));
    blocks.push(promBlock('sudo_diagnostics_up', 'Diagnostics subsystem available', 'gauge', [{ labels: null, value: 1 }]));
  } else {
    blocks.push(promBlock('sudo_diagnostics_up', 'Diagnostics subsystem available', 'gauge', [{ labels: null, value: 0 }]));
  }

  // --- injection ---
  if (snapshot.injection !== null) {
    const inj = snapshot.injection;
    blocks.push(promBlock('sudo_injection_detections_total', 'Total injection detection events', 'counter', [{ labels: null, value: inj.count }]));
    blocks.push(promBlock('sudo_injection_up', 'Injection subsystem available', 'gauge', [{ labels: null, value: 1 }]));
  } else {
    blocks.push(promBlock('sudo_injection_up', 'Injection subsystem available', 'gauge', [{ labels: null, value: 0 }]));
  }

  // --- reanchor ---
  if (snapshot.reanchor !== null) {
    const ra = snapshot.reanchor;
    const triggerLines = Object.entries(ra.byTrigger).map(([trigger, count]) => ({
      labels: { trigger },
      value: count,
    }));
    if (triggerLines.length === 0) {
      triggerLines.push({ labels: { trigger: 'none' }, value: 0 });
    }
    blocks.push(promBlock('sudo_reanchor_total', 'Re-anchor events by trigger', 'counter', triggerLines));
    const lastTs = ra.lastReAnchorAt != null ? Math.floor(ra.lastReAnchorAt / 1000) : 0;
    blocks.push(promBlock('sudo_reanchor_last_ts_seconds', 'Unix epoch seconds of last re-anchor event', 'gauge', [{ labels: null, value: lastTs }]));
    blocks.push(promBlock('sudo_reanchor_up', 'Reanchor subsystem available', 'gauge', [{ labels: null, value: 1 }]));
  } else {
    blocks.push(promBlock('sudo_reanchor_up', 'Reanchor subsystem available', 'gauge', [{ labels: null, value: 0 }]));
  }

  // --- resolutions ---
  if (snapshot.resolutions !== null) {
    const rs = snapshot.resolutions;
    blocks.push(promBlock('sudo_resolutions_honor_rate', 'Commitment honor rate (0-1)', 'gauge', [{ labels: null, value: rs.honorRate }]));
    blocks.push(promBlock('sudo_resolutions_up', 'Resolutions subsystem available', 'gauge', [{ labels: null, value: 1 }]));
  } else {
    blocks.push(promBlock('sudo_resolutions_up', 'Resolutions subsystem available', 'gauge', [{ labels: null, value: 0 }]));
  }

  // LD_PRELOAD seal counters (always emitted; 0 if never fired)
  const sealInstall = metrics.getCounter('synth_seal_install_total');
  const sealMissing = metrics.getCounter('synth_seal_missing_so_total');
  const sealSigsys = metrics.getCounter('synth_seal_sigsys_total');
  blocks.push(promBlock('sudo_synth_seal_install_total', 'Wave 2.2h LD_PRELOAD seal successful installs', 'counter', [{ labels: null, value: sealInstall }]));
  blocks.push(promBlock('sudo_synth_seal_missing_so_total', 'Wave 2.2h missing .so fail-open events', 'counter', [{ labels: null, value: sealMissing }]));
  blocks.push(promBlock('sudo_synth_seal_sigsys_total', 'Wave 2.2h SIGSYS (execve-deny) events', 'counter', [{ labels: null, value: sealSigsys }]));
  blocks.push(promBlock('sudo_synth_seal_up', 'Wave 2.2h seal subsystem available', 'gauge', [{ labels: null, value: 1 }]));

  // Synth-probe counters (always emitted; 0 if never fired)
  const probeTotal   = metrics.getCounter('synth_probe_total');
  const probeSuccess = metrics.getCounter('synth_probe_success_total');
  const probeFailure = metrics.getCounter('synth_probe_failure_total');
  blocks.push(promBlock('sudo_synth_probe_total', 'Total POST /v1/admin/synth-probe calls', 'counter', [{ labels: null, value: probeTotal }]));
  blocks.push(promBlock('sudo_synth_probe_success_total', 'Successful synth-probe calls', 'counter', [{ labels: null, value: probeSuccess }]));
  blocks.push(promBlock('sudo_synth_probe_failure_total', 'Failed synth-probe calls', 'counter', [{ labels: null, value: probeFailure }]));

  // Well-known manifest request counters (always emitted; 0 if never fired)
  const wkRequests    = metrics.getCounter('wellknown_manifest_requests_total');
  const wkNotModified = metrics.getCounter('wellknown_manifest_not_modified_total');
  const wkNotFound    = metrics.getCounter('wellknown_manifest_not_found_total');
  blocks.push(promBlock('sudo_wellknown_manifest_requests_total', 'Successful 200 responses to /.well-known/agentskills.json', 'counter', [{ labels: null, value: wkRequests }]));
  blocks.push(promBlock('sudo_wellknown_manifest_not_modified_total', '304 not-modified responses to /.well-known/agentskills.json', 'counter', [{ labels: null, value: wkNotModified }]));
  blocks.push(promBlock('sudo_wellknown_manifest_not_found_total', '404 responses to /.well-known/* (non-agentskills paths)', 'counter', [{ labels: null, value: wkNotFound }]));

  return blocks.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// OTLP JSON formatter
// ---------------------------------------------------------------------------

const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;

function nowNanoString(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function makeGaugeMetric(name: string, description: string, value: number, attrs?: OTLPAttribute[]): OTLPMetric {
  const dp: OTLPDataPoint = {
    timeUnixNano: nowNanoString(),
    asDouble: value,
  };
  if (attrs && attrs.length > 0) dp.attributes = attrs;
  return { name, description, gauge: { dataPoints: [dp] } };
}

function makeSumMetric(name: string, description: string, value: number, attrs?: OTLPAttribute[]): OTLPMetric {
  const dp: OTLPDataPoint = {
    timeUnixNano: nowNanoString(),
    asDouble: value,
  };
  if (attrs && attrs.length > 0) dp.attributes = attrs;
  return {
    name,
    description,
    sum: {
      dataPoints: [dp],
      aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
      isMonotonic: true,
    },
  };
}

function strAttr(key: string, value: string): OTLPAttribute {
  return { key, value: { stringValue: value } };
}

/**
 * Convert a DigestSnapshot into an OTLP/HTTP JSON metrics payload.
 * Suitable for polling by OTEL collectors configured with the prometheus receiver
 * or direct OTLP HTTP receivers.
 */
export function toOTLPMetrics(
  snapshot: DigestSnapshot,
  resource: { serviceName: string; instanceId: string },
): OTLPMetricsRequest {
  const metrics: OTLPMetric[] = [];

  // alignment
  if (snapshot.alignment !== null) {
    const al = snapshot.alignment;
    const score = al.overallScore ?? al.score ?? 0;
    const statusStr = (al.level ?? al.status ?? '').toUpperCase();
    const statusNum = STATUS_MAP[statusStr] ?? -1;
    metrics.push(makeGaugeMetric('sudo.alignment.score', 'Current alignment posture score', score));
    metrics.push(makeGaugeMetric('sudo.alignment.status', 'Alignment status (GREEN=2, YELLOW=1, RED=0)', statusNum));
  }

  // trust
  if (snapshot.trust !== null) {
    const tr = snapshot.trust;
    const tierNum = TIER_MAP[tr.tier.toUpperCase()] ?? -1;
    metrics.push(makeGaugeMetric('sudo.trust.tier_numeric', 'Trust tier as numeric (HIGH=3, MEDIUM=2, LOW=1, PROBATION=0)', tierNum));
    metrics.push(makeGaugeMetric('sudo.trust.score', 'Trust tier raw score', tr.score));
  }

  // calibration
  if (snapshot.calibration !== null) {
    const cal = snapshot.calibration;
    metrics.push(makeGaugeMetric('sudo.calibration.brier', 'Brier score from calibration tracker (lower is better)', cal.brierScore));
    metrics.push(makeSumMetric('sudo.calibration.samples', 'Total calibration samples', cal.totalSamples));
  }

  // commitments
  if (snapshot.commitments !== null) {
    const cm = snapshot.commitments;
    metrics.push(makeGaugeMetric('sudo.commitments.expiring_count', 'Commitments in expiring window', cm.expiringCount ?? 0));
    metrics.push(makeGaugeMetric('sudo.commitments.expired_count', 'Commitments expired', cm.expiredCount ?? 0));
  }

  // epistemic — one data point per verdict
  if (snapshot.epistemic !== null) {
    const ep = snapshot.epistemic;
    const verdicts = ep.byDecision ?? {};
    for (const [verdict, count] of Object.entries(verdicts)) {
      metrics.push(makeSumMetric('sudo.epistemic.events_total', 'Epistemic gate events by verdict', count, [strAttr('verdict', verdict.toLowerCase())]));
    }
  }

  // patterns
  if (snapshot.patterns !== null) {
    const pt = snapshot.patterns;
    metrics.push(makeSumMetric('sudo.patterns.total_mistakes', 'Total mistake patterns recorded', pt.totalMistakes));
    metrics.push(makeGaugeMetric('sudo.patterns.recurring_count', 'Number of recurring patterns', pt.recurringCount));
    metrics.push(makeGaugeMetric('sudo.patterns.unique', 'Unique patterns detected', pt.uniquePatterns));
  }

  // diagnostics
  if (snapshot.diagnostics !== null) {
    const dg = snapshot.diagnostics;
    metrics.push(makeSumMetric('sudo.diagnostics.events_scanned', 'Total events scanned by cross-signal diagnostics', dg.totalEventsScanned));
    metrics.push(makeGaugeMetric('sudo.diagnostics.correlations', 'Number of signal correlations detected', dg.correlationCount));
  }

  // injection
  if (snapshot.injection !== null) {
    const inj = snapshot.injection;
    metrics.push(makeSumMetric('sudo.injection.detections_total', 'Total injection detection events', inj.count));
  }

  // reanchor — one sum per trigger
  if (snapshot.reanchor !== null) {
    const ra = snapshot.reanchor;
    for (const [trigger, count] of Object.entries(ra.byTrigger)) {
      metrics.push(makeSumMetric('sudo.reanchor.total', 'Re-anchor events by trigger', count, [strAttr('trigger', trigger)]));
    }
    const lastTs = ra.lastReAnchorAt != null ? Math.floor(ra.lastReAnchorAt / 1000) : 0;
    metrics.push(makeGaugeMetric('sudo.reanchor.last_ts_seconds', 'Unix epoch seconds of last re-anchor event', lastTs));
  }

  // resolutions
  if (snapshot.resolutions !== null) {
    const rs = snapshot.resolutions;
    metrics.push(makeGaugeMetric('sudo.resolutions.honor_rate', 'Commitment honor rate (0-1)', rs.honorRate));
  }

  const resourceAttrs: OTLPAttribute[] = [
    strAttr('service.name', resource.serviceName),
    strAttr('service.instance.id', resource.instanceId),
  ];

  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttrs },
        scopeMetrics: [
          {
            scope: { name: 'sudo-ai-alignment', version: '7F' },
            metrics,
          },
        ],
      },
    ],
  };
}
