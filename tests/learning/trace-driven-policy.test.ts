/**
 * Tests for TraceDrivenPolicy — policy engine that learns from trace data.
 *
 * Covers: evaluate with no rules, matching rules, manual rule priority,
 * refreshPolicies, recordOutcome, block/cooldown actions, kill switch,
 * rule ordering by confidence, and low-confidence discard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TraceDrivenPolicy } from '../../src/core/learning/trace-driven-policy.js';
import type { TraceStore } from '../../src/core/learning/trace-store.js';
import type { TraceAnalyzer, ModelToolStats, AnalyzerResult } from '../../src/core/learning/trace-analyzer.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockTraceStore(): TraceStore {
  return {
    record: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    refreshAggregates: vi.fn(),
    getAggregates: vi.fn().mockReturnValue([]),
    getErrorClusters: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0),
    close: vi.fn(),
  } as unknown as TraceStore;
}

function createMockTraceAnalyzer(overrides?: Partial<AnalyzerResult>): TraceAnalyzer {
  const base: AnalyzerResult = {
    modelToolStats: [],
    modelCategoryStats: [],
    errorClusters: [],
    anomalies: [],
    window: { since: new Date(Date.now() - 86400000).toISOString(), until: new Date().toISOString(), label: 'last_24h' },
  };
  return { analyze: vi.fn().mockReturnValue({ ...base, ...overrides }) } as unknown as TraceAnalyzer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TraceDrivenPolicy', () => {
  let traceStore: TraceStore;
  let traceAnalyzer: TraceAnalyzer;
  let policy: TraceDrivenPolicy;

  beforeEach(() => {
    traceStore = createMockTraceStore();
    traceAnalyzer = createMockTraceAnalyzer();
    policy = new TraceDrivenPolicy(traceStore, traceAnalyzer);
    delete process.env.SUDO_POLICY_DISABLE;
  });

  afterEach(() => {
    delete process.env.SUDO_POLICY_DISABLE;
  });

  // 1. evaluate with no rules: Returns null-effect (default passthrough) decision
  it('evaluate with no rules returns default passthrough decision', () => {
    const result = policy.evaluate('write a function');
    expect(result.decision).not.toBeNull();
    expect(result.decision!.source).toBe('default');
    expect(result.decision!.ruleId).toBe('default:passthrough');
    expect(result.decision!.confidence).toBe(0);
    expect(result.decision!.action).toEqual({});
  });

  // 2. evaluate with matching rule: Returns correct decision
  it('evaluate with matching rule returns correct decision', () => {
    policy.addManualRule({ toolName: 'deploy' }, { preferredModel: 'claude-3-opus' });
    const result = policy.evaluate('deploy to prod', 'deploy');
    expect(result.decision!.source).toBe('manual');
    expect(result.decision!.action.preferredModel).toBe('claude-3-opus');
    expect(result.decision!.ruleId).toMatch(/^manual:/);
  });

  it('matches by intentPattern substring and regex', () => {
    policy.addManualRule({ intentPattern: 'database' }, { preferredModel: 'gpt-4' });
    expect(policy.evaluate('query the database').decision!.action.preferredModel).toBe('gpt-4');

    policy.addManualRule({ intentPattern: '^fix\\s+bug' }, { preferredTool: 'debugger' });
    expect(policy.evaluate('fix bug #42').decision!.action.preferredTool).toBe('debugger');
  });

  it('does not match when condition fields differ', () => {
    policy.addManualRule({ toolName: 'deploy', category: 'coding' }, { block: true });
    expect(policy.evaluate('deploy app', 'deploy', 'analysis').decision!.source).toBe('default');
  });

  // 3. addManualRule: Manual rule has highest priority
  it('addManualRule has highest priority over trace rules', () => {
    // confidence = successRate * sqrt(totalCalls) / 100; need >= 0.3
    // 0.95 * sqrt(10000) / 100 = 0.95
    const highPerfStats: ModelToolStats[] = [
      { model: 'trace-model', toolName: 'search', totalCalls: 10000, successRate: 0.95,
        avgLatencyMs: 100, p50Latency: 90, p95Latency: 200, p99Latency: 300, errorBreakdown: {} },
    ];
    traceAnalyzer = createMockTraceAnalyzer({ modelToolStats: highPerfStats });
    policy = new TraceDrivenPolicy(traceStore, traceAnalyzer);
    policy.addManualRule({ toolName: 'search' }, { preferredModel: 'manual-model' });
    policy.refreshPolicies();

    const result = policy.evaluate('search the web', 'search');
    expect(result.decision!.action.preferredModel).toBe('manual-model');
    expect(result.decision!.source).toBe('manual');
  });

  // 4. refreshPolicies: Generates rules from trace data
  it('refreshPolicies generates prefer rules for high-performing combos', () => {
    // 0.95 * sqrt(10000) / 100 = 0.95 (above 0.3 threshold)
    const stats: ModelToolStats[] = [
      { model: 'claude-3-opus', toolName: 'write-code', totalCalls: 10000, successRate: 0.95,
        avgLatencyMs: 200, p50Latency: 180, p95Latency: 300, p99Latency: 500, errorBreakdown: {} },
      { model: 'gpt-4', toolName: 'write-code', totalCalls: 10000, successRate: 0.80,
        avgLatencyMs: 400, p50Latency: 350, p95Latency: 600, p99Latency: 800, errorBreakdown: {} },
    ];
    traceAnalyzer = createMockTraceAnalyzer({ modelToolStats: stats });
    policy = new TraceDrivenPolicy(traceStore, traceAnalyzer);
    policy.refreshPolicies();

    const prefer = policy.getRules().find(r => r.id.includes('prefer'));
    expect(prefer).toBeDefined();
    expect(prefer!.action.preferredModel).toBe('claude-3-opus');
    expect(prefer!.condition.toolName).toBe('write-code');
  });

  // 5. recordOutcome: Updates rule confidence (feeds into next refresh)
  it('recordOutcome records trace data that feeds future policy refreshes', () => {
    policy.recordOutcome('build project', 'compile', 'coding', 'gpt-4', true, 1200);
    expect(traceStore.record).toHaveBeenCalledWith(
      expect.objectContaining({
        traceType: 'tool_call', intent: 'build project',
        toolName: 'compile', model: 'gpt-4', success: true, latencyMs: 1200,
      }),
    );
  });

  // 6. block rule: Block action prevents execution
  it('block rule returns block action when matched', () => {
    policy.addManualRule({ toolName: 'dangerous-tool' }, { block: true });
    const result = policy.evaluate('do something risky', 'dangerous-tool');
    expect(result.decision!.action.block).toBe(true);
    expect(result.decision!.source).toBe('manual');
  });

  // 7. cooldown rule: Cooldown action applies delay
  it('cooldown rule applies delay for moderately failing combos', () => {
    // 0.45 * sqrt(5000) / 100 = 0.318 (above 0.3); 0.25 <= 0.45 < 0.50 triggers cooldown
    const failStats: ModelToolStats[] = [
      { model: 'flaky-model', toolName: 'search', totalCalls: 5000, successRate: 0.45,
        avgLatencyMs: 3000, p50Latency: 2500, p95Latency: 5000, p99Latency: 7000,
        errorBreakdown: { rate_limit: 2750 } },
    ];
    traceAnalyzer = createMockTraceAnalyzer({ modelToolStats: failStats });
    policy = new TraceDrivenPolicy(traceStore, traceAnalyzer);
    policy.refreshPolicies();

    const cooldown = policy.getRules().find(r => r.action.cooldownSeconds !== undefined);
    expect(cooldown).toBeDefined();
    expect(cooldown!.action.cooldownSeconds).toBe(30);
  });

  // 8. kill switch: SUDO_POLICY_DISABLE disables evaluation
  it('SUDO_POLICY_DISABLE returns null decision', () => {
    process.env.SUDO_POLICY_DISABLE = '1';
    policy.addManualRule({ toolName: 'any' }, { block: true });
    const result = policy.evaluate('test intent', 'any');
    expect(result.decision).toBeNull();
    expect(result.reason).toContain('SUDO_POLICY_DISABLE');
  });

  it('SUDO_POLICY_DISABLE skips refreshPolicies', () => {
    process.env.SUDO_POLICY_DISABLE = '1';
    policy.refreshPolicies();
    expect(policy.getStats().traceRules).toBe(0);
  });

  // 9. rule ordering: Higher confidence rules evaluated first
  it('higher confidence trace rules are evaluated before lower confidence', () => {
    // low-conf: 0.92 * sqrt(10000) / 100 = 0.92
    // high-conf: 0.95 * sqrt(1000000) / 100 = 9.5
    const stats: ModelToolStats[] = [
      { model: 'low-conf-model', toolName: 'analyze', totalCalls: 10000, successRate: 0.92,
        avgLatencyMs: 300, p50Latency: 280, p95Latency: 400, p99Latency: 500, errorBreakdown: {} },
      { model: 'high-conf-model', toolName: 'analyze', totalCalls: 1000000, successRate: 0.95,
        avgLatencyMs: 150, p50Latency: 140, p95Latency: 250, p99Latency: 350, errorBreakdown: {} },
    ];
    traceAnalyzer = createMockTraceAnalyzer({ modelToolStats: stats });
    policy = new TraceDrivenPolicy(traceStore, traceAnalyzer);
    policy.refreshPolicies();

    const rules = policy.getRules().filter(r => r.id.includes('prefer'));
    expect(rules.length).toBeGreaterThanOrEqual(2);
    expect(rules[0].confidence).toBeGreaterThanOrEqual(rules[1].confidence);
    const result = policy.evaluate('run analysis', 'analyze');
    expect(result.decision!.action.preferredModel).toBe('high-conf-model');
  });

  // 10. low confidence discard: Rules below threshold are discarded
  it('rules below confidence 0.3 threshold are discarded', () => {
    // successRate=0.5, totalCalls=4 => confidence = 0.5 * sqrt(4) / 100 = 0.01
    const lowConfStats: ModelToolStats[] = [
      { model: 'weak-model', toolName: 'failing-tool', totalCalls: 4, successRate: 0.5,
        avgLatencyMs: 200, p50Latency: 180, p95Latency: 300, p99Latency: 400, errorBreakdown: {} },
    ];
    traceAnalyzer = createMockTraceAnalyzer({ modelToolStats: lowConfStats });
    policy = new TraceDrivenPolicy(traceStore, traceAnalyzer);
    policy.refreshPolicies();

    expect(policy.getStats().traceRules).toBe(0);
  });
});