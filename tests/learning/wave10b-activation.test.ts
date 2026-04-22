/**
 * Wave 10B-Activation integration tests — Builder B (registry.ts + test file).
 *
 * Tests the wiring pattern for SkillDiscovery and AgentConfigEvolver feeds,
 * the ToolRegistry.skillIdForTool() stub, and the trace-meta skillId absence rule.
 *
 * Spec reference: docs/wave10b-activation-spec.md §8
 * Builder B owns this file — no imports from loop.ts or cli.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillDiscovery } from '../../src/core/learning/skill-discovery.js';
import { ToolRegistry } from '../../src/core/tools/registry.ts';
import type { TraceInput } from '../../src/core/learning/agent-config-evolver.js';

// ---------------------------------------------------------------------------
// Minimal AgentLoop-shaped mock
// Replicates the Wave 10B wiring pattern from spec §4.2, §4.5, §4.6, §4.7
// without importing loop.ts (Builder A owns that file).
// ---------------------------------------------------------------------------

interface SkillDiscoveryLike {
  recordToolCall(sessionId: string, toolName: string, success: boolean): void;
}

interface AgentConfigEvolverLike {
  recordTrace(trace: TraceInput): void;
}

interface TraceMeta {
  type: 'trace-meta';
  complexity?: number;
  skillId?: string;
}

/**
 * MockAgentLoop replicates the exact emit-closure logic from spec §4.5 and
 * the session-end flush from §4.7 and the setters from §4.2.
 * Used for Tests 1, 3, 4, 5, 7.
 */
class MockAgentLoop {
  private _skillDiscovery?: SkillDiscoveryLike;
  private _agentConfigEvolver?: AgentConfigEvolverLike;

  // Captured events for assertions
  readonly emittedEvents: TraceMeta[] = [];

  /** Matches spec §4.2 exactly */
  setSkillDiscovery(sd: SkillDiscoveryLike): void {
    if (sd && typeof sd.recordToolCall === 'function') {
      this._skillDiscovery = sd;
    } else {
      // fail-open: warn and return
      console.warn('MockAgentLoop: setSkillDiscovery: invalid duck-type — ignoring');
    }
  }

  /** Matches spec §4.2 exactly */
  setAgentConfigEvolver(ace: AgentConfigEvolverLike): void {
    if (ace && typeof ace.recordTrace === 'function') {
      this._agentConfigEvolver = ace;
    } else {
      console.warn('MockAgentLoop: setAgentConfigEvolver: invalid duck-type — ignoring');
    }
  }

  get skillDiscovery(): SkillDiscoveryLike | undefined {
    return this._skillDiscovery;
  }

  get agentConfigEvolver(): AgentConfigEvolverLike | undefined {
    return this._agentConfigEvolver;
  }

  /**
   * Simulate a run() call that processes tool-result events.
   * Replicates spec §4.4, §4.5, §4.6, §4.7.
   *
   * @param sessionId - Session ID for this run
   * @param toolResults - Array of {name, success} for tool-result events to emit
   * @param finishReason - 'stop' or other; 'stop' triggers trace-meta emit
   */
  simulateRun(
    sessionId: string,
    toolResults: Array<{ name: string; success: boolean }>,
    finishReason: 'stop' | 'max_iterations' = 'stop',
  ): void {
    // Spec §4.4 per-run accumulators
    let _w10bToolCallCount = 0;
    let _w10bToolSuccessCount = 0;
    const _w10bToolSequence: string[] = [];

    // Process tool-result events (spec §4.5 emit closure behavior)
    for (const tr of toolResults) {
      // Simulate emit({ type: 'tool-result', name, result })
      // Wave 10B feed — mirrors spec §4.5 exactly:
      // accumulators updated INSIDE the SkillDiscovery guard
      try {
        if (this._skillDiscovery) {
          this._skillDiscovery.recordToolCall(sessionId, tr.name, tr.success);
          _w10bToolCallCount++;
          if (tr.success) _w10bToolSuccessCount++;
          _w10bToolSequence.push(tr.name);
        }
      } catch { /* fail-open */ }
    }

    // Simulate trace-meta emit at finishReason=stop (spec §4.6)
    if (finishReason === 'stop') {
      try {
        const _traceMeta: TraceMeta = { type: 'trace-meta', complexity: 0.5 };
        if (_w10bToolSequence.length > 0) {
          const _lastTool = _w10bToolSequence.at(-1);
          if (_lastTool) {
            // Uses ToolRegistry.skillIdForTool (returns null always in Wave 10B)
            // Replicate spec §4.6 exact pattern:
            // const _sid = registry.skillIdForTool?.(_lastTool) ?? undefined;
            // if (_sid !== undefined) _traceMeta.skillId = _sid;
            const _sid: string | null | undefined = null; // Wave 10B: always null
            const _resolved = _sid ?? undefined;
            if (_resolved !== undefined) {
              _traceMeta.skillId = _resolved;
            }
          }
        }
        this.emittedEvents.push(_traceMeta);
      } catch { /* fail-open */ }
    }

    // Simulate session:end flush (spec §4.7)
    try {
      if (this._agentConfigEvolver && _w10bToolCallCount > 0) {
        const _quality = _w10bToolSuccessCount / _w10bToolCallCount;
        this._agentConfigEvolver.recordTrace({
          sessionId,
          agentId: sessionId,
          toolSequence: [..._w10bToolSequence],
          quality: _quality,
          timestamp: new Date().toISOString(),
        });
      }
    } catch { /* fail-open */ }
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Wave 10B Activation', () => {
  // -------------------------------------------------------------------------
  // Test 1 — recordToolCall called N times for N tool-result events
  // -------------------------------------------------------------------------

  it('recordToolCall is called for each tool-result in a run', () => {
    const loop = new MockAgentLoop();
    const mockSD: SkillDiscoveryLike = {
      recordToolCall: vi.fn(),
    };

    loop.setSkillDiscovery(mockSD);

    const toolResults = [
      { name: 'coder.read-file', success: true },
      { name: 'coder.write-file', success: true },
      { name: 'system.shell', success: false },
    ];

    loop.simulateRun('session-abc', toolResults);

    expect(mockSD.recordToolCall).toHaveBeenCalledTimes(3);
    expect(mockSD.recordToolCall).toHaveBeenNthCalledWith(1, 'session-abc', 'coder.read-file', true);
    expect(mockSD.recordToolCall).toHaveBeenNthCalledWith(2, 'session-abc', 'coder.write-file', true);
    expect(mockSD.recordToolCall).toHaveBeenNthCalledWith(3, 'session-abc', 'system.shell', false);
  });

  // -------------------------------------------------------------------------
  // Test 2 — mine() returns patterns after sufficient tool calls across sessions
  // -------------------------------------------------------------------------

  it('mine() returns patterns after sufficient tool calls across sessions', () => {
    const discovery = new SkillDiscovery();

    const sequence = ['coder.read-file', 'coder.write-file', 'system.shell'];

    // Session A: 5 calls (same sequence)
    for (const toolName of sequence) {
      discovery.recordToolCall('sessionA', toolName, true);
    }

    // Session B: 5 calls (same sequence)
    for (const toolName of sequence) {
      discovery.recordToolCall('sessionB', toolName, true);
    }

    const patterns = discovery.mine(undefined, 2);

    expect(patterns.length).toBeGreaterThanOrEqual(1);
    // At least one pattern must have occurrences >= 2
    const repeating = patterns.filter((p) => p.occurrenceCount >= 2);
    expect(repeating.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Test 3 — recordTrace called once per run with correct quality
  // -------------------------------------------------------------------------

  it('recordTrace called once per run with correct quality', () => {
    const loop = new MockAgentLoop();
    const mockACE: AgentConfigEvolverLike = {
      recordTrace: vi.fn(),
    };
    // Per spec §4.5 the accumulators are inside the _skillDiscovery guard,
    // so SD must also be wired for _w10bToolCallCount to be non-zero.
    loop.setSkillDiscovery({ recordToolCall: vi.fn() });
    loop.setAgentConfigEvolver(mockACE);

    // 4 tool calls: 3 success + 1 failure → quality = 0.75
    const toolResults = [
      { name: 'coder.read-file', success: true },
      { name: 'coder.write-file', success: true },
      { name: 'system.shell', success: true },
      { name: 'data.query', success: false },
    ];

    loop.simulateRun('session-xyz', toolResults);

    expect(mockACE.recordTrace).toHaveBeenCalledTimes(1);

    const callArg = (mockACE.recordTrace as ReturnType<typeof vi.fn>).mock.calls[0][0] as TraceInput;
    expect(callArg.quality).toBeCloseTo(0.75, 2);
    expect(callArg.toolSequence.length).toBe(4);
    // ISO-8601 timestamp check
    expect(callArg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // -------------------------------------------------------------------------
  // Test 4 — recordTrace skipped when zero tool calls in run
  // -------------------------------------------------------------------------

  it('recordTrace skipped when zero tool calls in run', () => {
    const loop = new MockAgentLoop();
    const mockACE: AgentConfigEvolverLike = {
      recordTrace: vi.fn(),
    };

    loop.setAgentConfigEvolver(mockACE);

    // No tool results — pure text response turn
    loop.simulateRun('session-empty', []);

    expect(mockACE.recordTrace).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 5 — trace-meta event skillId absent when no skill mapping
  // -------------------------------------------------------------------------

  it('trace-meta event skillId absent when no skill mapping', () => {
    const loop = new MockAgentLoop();

    // Must wire SD so accumulators run (spec §4.5 guard) and _w10bToolSequence gets populated.
    // Sequence presence is required for the §4.6 skillId lookup branch to be exercised.
    loop.setSkillDiscovery({ recordToolCall: vi.fn() });

    // Run with one tool call — _w10bToolSequence will have an entry
    // but skillIdForTool returns null → undefined → key absent
    loop.simulateRun('session-trace', [{ name: 'coder.read-file', success: true }], 'stop');

    const traceMetaEvents = loop.emittedEvents.filter((e) => e.type === 'trace-meta');
    expect(traceMetaEvents.length).toBeGreaterThanOrEqual(1);

    const event = traceMetaEvents[0]!;
    expect(event.type).toBe('trace-meta');
    // Key must be ABSENT — not present as undefined
    expect('skillId' in event).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 6 — ToolRegistry.skillIdForTool: null before index, then real lookup
  // Wave 10C extension: adds setSkillIndex coverage while preserving Wave 10B
  // null-before-index assertion as the first subcase.
  // -------------------------------------------------------------------------

  it('ToolRegistry.skillIdForTool returns null before index, then resolves after setSkillIndex', () => {
    const registry = new ToolRegistry();

    // Register a dummy tool to prove registry is functional
    registry.register({
      name: 'dummy.tool',
      description: 'Test dummy tool',
      category: 'coder',
      parameters: {},
      execute: async () => ({ content: 'ok' }),
    });

    // Subcase 1 (Wave 10B backward-compatible): null before setSkillIndex called
    expect(registry.skillIdForTool('dummy.tool')).toBeNull();
    expect(registry.skillIdForTool('')).toBeNull();
    expect(registry.skillIdForTool('nonexistent')).toBeNull();

    // Subcase 2: mapped value returned after setSkillIndex with a single-claim map
    const singleClaimIndex = new Map<string, string>([
      ['dummy.tool', 'my-skill'],
    ]);
    registry.setSkillIndex(singleClaimIndex);
    expect(registry.skillIdForTool('dummy.tool')).toBe('my-skill');

    // Subcase 3: null for a tool absent from map (simulates ambiguous claim — tool not in map)
    expect(registry.skillIdForTool('ambiguous.tool')).toBeNull();

    // Subcase 4: null for an unrecognised tool (key not in index at all)
    expect(registry.skillIdForTool('completely.unknown')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 7 — setSkillDiscovery and setAgentConfigEvolver duck-type validation
  // -------------------------------------------------------------------------

  it('setSkillDiscovery and setAgentConfigEvolver duck-type validation', () => {
    const loop = new MockAgentLoop();

    // Valid duck-typed SkillDiscovery → attached silently
    const validSD: SkillDiscoveryLike = { recordToolCall: vi.fn() };
    expect(() => loop.setSkillDiscovery(validSD)).not.toThrow();
    expect(loop.skillDiscovery).toBe(validSD);

    // Valid duck-typed AgentConfigEvolver → attached silently
    const validACE: AgentConfigEvolverLike = { recordTrace: vi.fn() };
    expect(() => loop.setAgentConfigEvolver(validACE)).not.toThrow();
    expect(loop.agentConfigEvolver).toBe(validACE);

    // null → does not throw, logs warn, field stays as previous value (or undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loop2 = new MockAgentLoop();
    expect(() => loop2.setSkillDiscovery(null as unknown as SkillDiscoveryLike)).not.toThrow();
    expect(loop2.skillDiscovery).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockClear();

    // {} (missing recordTrace) → does not throw, logs warn
    const loop3 = new MockAgentLoop();
    expect(() => loop3.setAgentConfigEvolver({} as unknown as AgentConfigEvolverLike)).not.toThrow();
    expect(loop3.agentConfigEvolver).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
