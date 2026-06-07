/**
 * Tests for SessionSignalsCollector — unified per-session metrics / signals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SessionSignalsCollector,
  formatSignalsAsMarkdown,
  persistSignals,
  type SessionSignals,
} from '../../src/core/learning/session-signals.js';
import path from 'path';
import os from 'os';
import { rmSync, existsSync, readFileSync, mkdirSync } from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a collector with a fixed start time for deterministic duration tests. */
function fixedCollector(opts: { model?: string } = {}): SessionSignalsCollector {
  return new SessionSignalsCollector({
    model: opts.model ?? 'test-model',
    startTime: '2026-01-01T00:00:00.000Z',
  });
}

/** Temp directory for persistSignals tests. */
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `ss-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Counter recording methods
// ---------------------------------------------------------------------------

describe('SessionSignalsCollector — counter methods', () => {
  it('recordTurn increments turnCount', () => {
    const c = new SessionSignalsCollector();
    c.recordTurn();
    c.recordTurn();
    c.recordTurn();
    expect(c.getSnapshot().turnCount).toBe(3);
  });

  it('recordToolCall increments toolCallCount', () => {
    const c = new SessionSignalsCollector();
    c.recordToolCall();
    c.recordToolCall();
    expect(c.getSnapshot().toolCallCount).toBe(2);
  });

  it('recordDoomLoop increments doomLoopDetections', () => {
    const c = new SessionSignalsCollector();
    c.recordDoomLoop();
    c.recordDoomLoop();
    c.recordDoomLoop();
    expect(c.getSnapshot().doomLoopDetections).toBe(3);
  });

  it('recordError increments errorCount', () => {
    const c = new SessionSignalsCollector();
    c.recordError();
    expect(c.getSnapshot().errorCount).toBe(1);
  });

  it('recordCancellation increments cancellationCount', () => {
    const c = new SessionSignalsCollector();
    c.recordCancellation();
    c.recordCancellation();
    expect(c.getSnapshot().cancellationCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Time-to-first-token EMA
// ---------------------------------------------------------------------------

describe('SessionSignalsCollector — TTFT EMA', () => {
  it('first TTFT sample seeds the EMA directly', () => {
    const c = new SessionSignalsCollector();
    c.recordTimeToFirstToken(200);
    expect(c.getSnapshot().avgTimeToFirstTokenMs).toBe(200);
  });

  it('subsequent TTFT samples blend with EMA alpha=0.3', () => {
    const c = new SessionSignalsCollector();
    c.recordTimeToFirstToken(100);   // seed = 100
    c.recordTimeToFirstToken(200);   // 0.3*200 + 0.7*100 = 60+70 = 130
    expect(c.getSnapshot().avgTimeToFirstTokenMs).toBe(130);
  });

  it('TTFT EMA converges toward recent values', () => {
    const c = new SessionSignalsCollector();
    c.recordTimeToFirstToken(1000);
    // Feed many samples at 100 to pull the average down
    for (let i = 0; i < 20; i++) {
      c.recordTimeToFirstToken(100);
    }
    // After many 100ms samples the EMA should be well below 500
    expect(c.getSnapshot().avgTimeToFirstTokenMs).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Inter-token latency percentiles
// ---------------------------------------------------------------------------

describe('SessionSignalsCollector — ITL percentiles', () => {
  it('returns 0 for all percentiles when no samples recorded', () => {
    const c = new SessionSignalsCollector();
    const snap = c.getSnapshot();
    expect(snap.itlP50Ms).toBe(0);
    expect(snap.itlP95Ms).toBe(0);
    expect(snap.itlP99Ms).toBe(0);
  });

  it('computes p50 correctly for a single sample', () => {
    const c = new SessionSignalsCollector();
    c.recordInterTokenLatency(50);
    expect(c.getSnapshot().itlP50Ms).toBe(50);
  });

  it('computes p50, p95, p99 for 100 samples', () => {
    const c = new SessionSignalsCollector();
    // Record samples 1..100
    for (let i = 1; i <= 100; i++) {
      c.recordInterTokenLatency(i);
    }
    const snap = c.getSnapshot();
    // p50 ~ 50, p95 ~ 95, p99 ~ 99
    expect(snap.itlP50Ms).toBe(50);
    expect(snap.itlP95Ms).toBe(95);
    expect(snap.itlP99Ms).toBe(99);
  });

  it('sliding window caps at 100 samples and evicts oldest', () => {
    const c = new SessionSignalsCollector();
    // Fill with low values 1..100
    for (let i = 1; i <= 100; i++) {
      c.recordInterTokenLatency(i);
    }
    // Now add 50 more high values — should push low ones out
    for (let i = 101; i <= 150; i++) {
      c.recordInterTokenLatency(i);
    }
    const snap = c.getSnapshot();
    // With 51..150 in the window, p50 should be around 100
    expect(snap.itlP50Ms).toBeGreaterThanOrEqual(90);
    // p99 at index 98 of sorted [51..150] → 51+98 = 149
    expect(snap.itlP99Ms).toBeGreaterThanOrEqual(149);
  });

  it('maintains sorted order even with out-of-order inserts', () => {
    const c = new SessionSignalsCollector();
    c.recordInterTokenLatency(30);
    c.recordInterTokenLatency(10);
    c.recordInterTokenLatency(20);
    // p50 of [10,20,30] = 20
    expect(c.getSnapshot().itlP50Ms).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Memory peak tracking
// ---------------------------------------------------------------------------

describe('SessionSignalsCollector — memory tracking', () => {
  it('sampleMemory updates peakRssBytes when RSS increases', () => {
    const c = new SessionSignalsCollector();
    const before = c.getSnapshot().peakRssBytes;
    // Force a small allocation to potentially bump RSS
    const _buf = Buffer.alloc(1024 * 1024); // 1 MB
    c.sampleMemory();
    const after = c.getSnapshot().peakRssBytes;
    // Peak should be >= before (it either stayed same or went up)
    expect(after).toBeGreaterThanOrEqual(before);
    _buf.fill(0); // allow GC
  });

  it('peakRssBytes never decreases across samples', () => {
    const c = new SessionSignalsCollector();
    c.sampleMemory();
    const peak1 = c.getSnapshot().peakRssBytes;
    c.sampleMemory();
    const peak2 = c.getSnapshot().peakRssBytes;
    expect(peak2).toBeGreaterThanOrEqual(peak1);
  });

  it('initializes peakRssBytes from process.memoryUsage() in constructor', () => {
    const c = new SessionSignalsCollector();
    // In Node.js this should be a positive number
    if (typeof process !== 'undefined' && typeof process.memoryUsage === 'function') {
      expect(c.getSnapshot().peakRssBytes).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

describe('SessionSignalsCollector — token usage', () => {
  it('recordTokenUsage accumulates input and output tokens', () => {
    const c = new SessionSignalsCollector();
    c.recordTokenUsage(100, 50);
    c.recordTokenUsage(200, 75);
    const snap = c.getSnapshot();
    expect(snap.tokensUsed.input).toBe(300);
    expect(snap.tokensUsed.output).toBe(125);
  });

  it('tokensUsed starts at zero', () => {
    const c = new SessionSignalsCollector();
    const snap = c.getSnapshot();
    expect(snap.tokensUsed.input).toBe(0);
    expect(snap.tokensUsed.output).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Setter methods
// ---------------------------------------------------------------------------

describe('SessionSignalsCollector — setters', () => {
  it('setGoalClassification stores the type', () => {
    const c = new SessionSignalsCollector();
    c.setGoalClassification('code_gen');
    expect(c.getSnapshot().goalClassificationType).toBe('code_gen');
  });

  it('setGoalCompletionVerdict stores the verdict', () => {
    const c = new SessionSignalsCollector();
    c.setGoalCompletionVerdict('complete');
    expect(c.getSnapshot().goalCompletionVerdict).toBe('complete');
  });

  it('setFeedbackTier stores the tier', () => {
    const c = new SessionSignalsCollector();
    c.setFeedbackTier('positive');
    expect(c.getSnapshot().feedbackTier).toBe('positive');
  });

  it('setZDR stores the boolean', () => {
    const c = new SessionSignalsCollector();
    c.setZDR(true);
    expect(c.getSnapshot().zdrActive).toBe(true);
    c.setZDR(false);
    expect(c.getSnapshot().zdrActive).toBe(false);
  });

  it('setModel updates the model identifier', () => {
    const c = new SessionSignalsCollector({ model: 'v1' });
    expect(c.getSnapshot().modelUsed).toBe('v1');
    c.setModel('v2-opus');
    expect(c.getSnapshot().modelUsed).toBe('v2-opus');
  });
});

// ---------------------------------------------------------------------------
// Session end timing
// ---------------------------------------------------------------------------

describe('SessionSignalsCollector — session end', () => {
  it('endSession sets endTime and totalDurationMs', () => {
    const c = new SessionSignalsCollector();
    c.endSession();
    const snap = c.getSnapshot();
    expect(snap.endTime).not.toBeNull();
    expect(snap.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('endSession is idempotent — second call is a no-op', () => {
    const c = new SessionSignalsCollector();
    c.endSession();
    const first = c.getSnapshot().endTime;
    // Small sleep to ensure time would differ if we re-wrote
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    c.endSession();
    expect(c.getSnapshot().endTime).toBe(first);
  });

  it('endTime is null before endSession is called', () => {
    const c = new SessionSignalsCollector();
    expect(c.getSnapshot().endTime).toBeNull();
  });

  it('totalDurationMs is 0 before endSession', () => {
    const c = new SessionSignalsCollector();
    expect(c.getSnapshot().totalDurationMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Snapshot isolation
// ---------------------------------------------------------------------------

describe('SessionSignalsCollector — snapshot isolation', () => {
  it('getSnapshot returns a deep copy — mutating it does not affect the collector', () => {
    const c = new SessionSignalsCollector();
    c.recordTurn();
    const snap = c.getSnapshot();
    snap.turnCount = 999;
    snap.tokensUsed.input = 9999;
    // Original should be unchanged
    expect(c.getSnapshot().turnCount).toBe(1);
    expect(c.getSnapshot().tokensUsed.input).toBe(0);
  });

  it('two snapshots from the same collector are independent copies', () => {
    const c = new SessionSignalsCollector();
    c.recordTurn();
    const a = c.getSnapshot();
    const b = c.getSnapshot();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.tokensUsed).not.toBe(b.tokensUsed);
  });
});

// ---------------------------------------------------------------------------
// JSON serialisation
// ---------------------------------------------------------------------------

describe('SessionSignalsCollector — JSON serialisation', () => {
  it('toJSON produces valid parseable JSON', () => {
    const c = new SessionSignalsCollector({ model: 'test' });
    c.recordTurn();
    c.recordToolCall();
    c.endSession();
    const json = c.toJSON();
    const parsed = JSON.parse(json);
    expect(parsed.turnCount).toBe(1);
    expect(parsed.toolCallCount).toBe(1);
    expect(parsed.modelUsed).toBe('test');
    expect(parsed.endTime).not.toBeNull();
  });

  it('toJSON is pretty-printed (2-space indent)', () => {
    const c = new SessionSignalsCollector();
    const json = c.toJSON();
    // Pretty-printed JSON contains newline + 2-space indent for inner keys
    expect(json).toContain('\n  ');
  });
});

// ---------------------------------------------------------------------------
// Markdown formatting
// ---------------------------------------------------------------------------

describe('formatSignalsAsMarkdown', () => {
  it('produces a Markdown table with all fields', () => {
    const signals: SessionSignals = {
      turnCount: 5,
      toolCallCount: 12,
      doomLoopDetections: 1,
      avgTimeToFirstTokenMs: 150.5,
      peakRssBytes: 1024000,
      itlP50Ms: 20,
      itlP95Ms: 45,
      itlP99Ms: 80,
      errorCount: 2,
      cancellationCount: 0,
      goalClassificationType: 'code_gen',
      goalCompletionVerdict: 'complete',
      feedbackTier: 'positive',
      zdrActive: true,
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:05:00.000Z',
      totalDurationMs: 300000,
      modelUsed: 'claude-opus-4',
      tokensUsed: { input: 5000, output: 2000 },
    };
    const md = formatSignalsAsMarkdown(signals);
    expect(md).toContain('# Session Signals');
    expect(md).toContain('| Turn Count | 5 |');
    expect(md).toContain('| Tool Call Count | 12 |');
    expect(md).toContain('| Doom Loop Detections | 1 |');
    expect(md).toContain('| Avg TTFT (ms) | 150.5 |');
    expect(md).toContain('| Peak RSS (bytes) | 1024000 |');
    expect(md).toContain('| ITL p50 (ms) | 20 |');
    expect(md).toContain('| ITL p95 (ms) | 45 |');
    expect(md).toContain('| ITL p99 (ms) | 80 |');
    expect(md).toContain('| Error Count | 2 |');
    expect(md).toContain('| Goal Classification | code_gen |');
    expect(md).toContain('| Goal Completion Verdict | complete |');
    expect(md).toContain('| Feedback Tier | positive |');
    expect(md).toContain('| ZDR Active | true |');
    expect(md).toContain('| Model | claude-opus-4 |');
    expect(md).toContain('| Tokens In | 5000 |');
    expect(md).toContain('| Tokens Out | 2000 |');
  });

  it('renders em-dash for empty classification fields', () => {
    const signals: SessionSignals = {
      turnCount: 0,
      toolCallCount: 0,
      doomLoopDetections: 0,
      avgTimeToFirstTokenMs: 0,
      peakRssBytes: 0,
      itlP50Ms: 0,
      itlP95Ms: 0,
      itlP99Ms: 0,
      errorCount: 0,
      cancellationCount: 0,
      goalClassificationType: '',
      goalCompletionVerdict: '',
      feedbackTier: '',
      zdrActive: false,
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: null,
      totalDurationMs: 0,
      modelUsed: 'unknown',
      tokensUsed: { input: 0, output: 0 },
    };
    const md = formatSignalsAsMarkdown(signals);
    expect(md).toContain('| Goal Classification | — |');
    expect(md).toContain('| Goal Completion Verdict | — |');
    expect(md).toContain('| Feedback Tier | — |');
    expect(md).toContain('| End Time | — |');
  });
});

// ---------------------------------------------------------------------------
// persistSignals
// ---------------------------------------------------------------------------

describe('persistSignals', () => {
  it('writes a JSON file to data/signals/{sessionId}.json', () => {
    const signals: SessionSignals = {
      turnCount: 1,
      toolCallCount: 2,
      doomLoopDetections: 0,
      avgTimeToFirstTokenMs: 100,
      peakRssBytes: 0,
      itlP50Ms: 0,
      itlP95Ms: 0,
      itlP99Ms: 0,
      errorCount: 0,
      cancellationCount: 0,
      goalClassificationType: '',
      goalCompletionVerdict: '',
      feedbackTier: '',
      zdrActive: false,
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: null,
      totalDurationMs: 0,
      modelUsed: 'test',
      tokensUsed: { input: 0, output: 0 },
    };
    persistSignals('sess-001', signals, tmpDir);
    const filePath = path.join(tmpDir, 'signals', 'sess-001.json');
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.turnCount).toBe(1);
    expect(content.modelUsed).toBe('test');
  });

  it('creates the signals directory if it does not exist', () => {
    const nestedTmp = path.join(tmpDir, 'deep', 'nested');
    const signals: SessionSignals = {
      turnCount: 0, toolCallCount: 0, doomLoopDetections: 0,
      avgTimeToFirstTokenMs: 0, peakRssBytes: 0,
      itlP50Ms: 0, itlP95Ms: 0, itlP99Ms: 0,
      errorCount: 0, cancellationCount: 0,
      goalClassificationType: '', goalCompletionVerdict: '', feedbackTier: '',
      zdrActive: false, startTime: '', endTime: null, totalDurationMs: 0,
      modelUsed: '', tokensUsed: { input: 0, output: 0 },
    };
    persistSignals('sess-dir-test', signals, nestedTmp);
    expect(existsSync(path.join(nestedTmp, 'signals', 'sess-dir-test.json'))).toBe(true);
  });

  it('overwrites an existing file on subsequent calls', () => {
    const signals1: SessionSignals = {
      turnCount: 1, toolCallCount: 0, doomLoopDetections: 0,
      avgTimeToFirstTokenMs: 0, peakRssBytes: 0,
      itlP50Ms: 0, itlP95Ms: 0, itlP99Ms: 0,
      errorCount: 0, cancellationCount: 0,
      goalClassificationType: '', goalCompletionVerdict: '', feedbackTier: '',
      zdrActive: false, startTime: '', endTime: null, totalDurationMs: 0,
      modelUsed: '', tokensUsed: { input: 0, output: 0 },
    };
    const signals2: SessionSignals = { ...signals1, turnCount: 99 };
    persistSignals('sess-ow', signals1, tmpDir);
    persistSignals('sess-ow', signals2, tmpDir);
    const content = JSON.parse(
      readFileSync(path.join(tmpDir, 'signals', 'sess-ow.json'), 'utf-8'),
    );
    expect(content.turnCount).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

describe('SessionSignalsCollector — constructor options', () => {
  it('defaults modelUsed to "unknown" when no model is provided', () => {
    const c = new SessionSignalsCollector();
    expect(c.getSnapshot().modelUsed).toBe('unknown');
  });

  it('accepts a custom startTime', () => {
    const c = new SessionSignalsCollector({ startTime: '2025-06-15T12:00:00.000Z' });
    expect(c.getSnapshot().startTime).toBe('2025-06-15T12:00:00.000Z');
  });
});