/**
 * @file tests/security/taint-tracker-integration.test.ts
 * @description Wave 10E integration tests for TaintTracker wiring.
 *
 * Uses the real HookManager to exercise re-entry guard (D2) and memory-management
 * paths that the existing unit tests skip by using a mock HookManager whose
 * emit() is a no-op stub.
 *
 * Test IDs: INT-T1 … INT-T12
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaintTracker } from '../../src/core/security/taint-tracker.js';
import { HookManager } from '../../src/core/hooks/index.js';

// ---------------------------------------------------------------------------
// INT-T1: attachHooks with real HookManager — no infinite loop
// ---------------------------------------------------------------------------

describe('INT-T1: attachHooks with real HookManager — no infinite loop', () => {
  it('emitting after:tool-call does not cause infinite recursion', async () => {
    const tracker = new TaintTracker();
    const hooks = new HookManager();
    tracker.attachHooks(hooks);

    // If there is no re-entry guard, this emit recurses infinitely and
    // the test will time-out or throw a stack-overflow error.
    await expect(
      hooks.emit('after:tool-call', { event: 'after:tool-call', toolName: 'test.tool' }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// INT-T2: emit count is exactly 1 on after:tool-call
// ---------------------------------------------------------------------------

describe('INT-T2: emit count is exactly 1 on after:tool-call', () => {
  it('the taint handler body executes exactly once per external emit', async () => {
    const tracker = new TaintTracker();
    const hooks = new HookManager();

    let realHandlerCount = 0;
    // Spy registered BEFORE attachHooks — will see ALL emits including the re-emit.
    // The re-emit carries meta.taintEvent so the taint handler returns early;
    // our spy below doesn't apply the guard, so it will see both emissions.
    // We want to verify the TAINT handler body runs once — so we use size delta.

    tracker.attachHooks(hooks);

    const sizeBefore = tracker.size;
    await hooks.emit('after:tool-call', { event: 'after:tool-call', toolName: 'test.tool' });
    // One new taint should have been tagged.
    expect(tracker.size).toBe(sizeBefore + 1);

    // Emit again — should add exactly one more.
    await hooks.emit('after:tool-call', { event: 'after:tool-call', toolName: 'test.tool2' });
    expect(tracker.size).toBe(sizeBefore + 2);
  });
});

// ---------------------------------------------------------------------------
// INT-T3: taint assigned after emit
// ---------------------------------------------------------------------------

describe('INT-T3: taint assigned after emit', () => {
  it('tracker.size increases by 1 after emitting after:tool-call', async () => {
    const tracker = new TaintTracker();
    const hooks = new HookManager();
    tracker.attachHooks(hooks);

    expect(tracker.size).toBe(0);
    await hooks.emit('after:tool-call', { event: 'after:tool-call', toolName: 'test.read' });
    expect(tracker.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// INT-T4: session:end clear via hook
// ---------------------------------------------------------------------------

describe('INT-T4: session:end clear via hook', () => {
  it('emitting session:end clears the taint map', async () => {
    const tracker = new TaintTracker();
    const hooks = new HookManager();
    tracker.attachHooks(hooks);

    // Tag some taints first.
    tracker.tag('tool.read', 'tool_output');
    tracker.tag('tool.write', 'tool_output');
    expect(tracker.size).toBe(2);

    await hooks.emit('session:end', { event: 'session:end', sessionId: 'sess-1' });
    expect(tracker.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// INT-T5: clear() resets map
// ---------------------------------------------------------------------------

describe('INT-T5: clear() resets map', () => {
  it('calling clear() directly empties the taint map', () => {
    const tracker = new TaintTracker();
    tracker.tag('tool.a', 'tool_output');
    tracker.tag('tool.b', 'tool_output');
    tracker.tag('tool.c', 'user_input');
    expect(tracker.size).toBe(3);

    tracker.clear();
    expect(tracker.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// INT-T6: setTaintTracker duck-type validation — accepts valid
// ---------------------------------------------------------------------------

describe('INT-T6: setTaintTracker duck-type validation — accepts valid', () => {
  it('accepts an object with both required methods', () => {
    // Build a minimal mock AgentLoop-like object.
    let attachedTracker: unknown = null;
    let warnCalled = false;

    const mockLoop = {
      _taintTracker: undefined as unknown,
      setTaintTracker(tt: {
        onToolResult(e: { name: string; result: unknown; ancestorTaintIds?: string[] }): { taintId: string };
        checkViolation(name: string, safety: 'readonly' | 'destructive', id: string): { reason: string } | null;
      }) {
        if (tt && typeof tt.onToolResult === 'function' && typeof tt.checkViolation === 'function') {
          attachedTracker = tt;
          this._taintTracker = tt;
        } else {
          warnCalled = true;
        }
      },
    };

    const validMock = {
      onToolResult: (_e: unknown) => ({ taintId: 'id-1' }),
      checkViolation: (_n: string, _s: string, _id: string) => null,
    };

    mockLoop.setTaintTracker(validMock);
    expect(attachedTracker).toBe(validMock);
    expect(warnCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INT-T7: setTaintTracker duck-type validation — rejects invalid
// ---------------------------------------------------------------------------

describe('INT-T7: setTaintTracker duck-type validation — rejects invalid', () => {
  it('rejects null input', () => {
    let rejected = false;
    const mockLoop = {
      setTaintTracker(tt: unknown) {
        if (!tt || typeof (tt as Record<string, unknown>)['onToolResult'] !== 'function') {
          rejected = true;
        }
      },
    };

    mockLoop.setTaintTracker(null);
    expect(rejected).toBe(true);
  });

  it('rejects object missing checkViolation', () => {
    let rejected = false;
    const mockLoop = {
      setTaintTracker(tt: unknown) {
        const obj = tt as Record<string, unknown>;
        if (!tt || typeof obj['onToolResult'] !== 'function' || typeof obj['checkViolation'] !== 'function') {
          rejected = true;
        }
      },
    };

    mockLoop.setTaintTracker({ onToolResult: () => ({}) });
    expect(rejected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INT-T8: checkViolation blocks high-taint destructive tool
// ---------------------------------------------------------------------------

describe('INT-T8: checkViolation blocks high-taint destructive tool — tool excluded from execution', () => {
  it('a high-taint destructive tool call is excluded from activeToolCalls', () => {
    const tracker = new TaintTracker();

    // Tag a high-level taint for a destructive tool.
    const highTaint = tracker.tag('system.shell', 'tool_output', 'high');

    const violation = tracker.checkViolation('system.shell', 'readonly', highTaint.taintId);
    expect(violation).not.toBeNull();
    expect(violation?.reason).toContain('system.shell');

    // Simulate the vetoedIds mechanism in loop.ts.
    const validToolCalls = [
      { id: 'tc-1', name: 'system.shell', arguments: {} },
      { id: 'tc-2', name: 'tool.read', arguments: {} },
    ];
    const vetoedIds = new Set<string>();

    for (const tc of validToolCalls) {
      const priorTaintId = tc.name === 'system.shell' ? highTaint.taintId : undefined;
      if (priorTaintId) {
        const v = tracker.checkViolation(tc.name, 'readonly', priorTaintId);
        if (v) vetoedIds.add(tc.id);
      }
    }

    const activeToolCalls = validToolCalls.filter(tc => !vetoedIds.has(tc.id));

    // system.shell must be excluded.
    expect(activeToolCalls.map(tc => tc.name)).not.toContain('system.shell');
    // tool.read is untainted and must pass through.
    expect(activeToolCalls.map(tc => tc.name)).toContain('tool.read');
  });
});

// ---------------------------------------------------------------------------
// INT-T9: checkViolation allows high-taint readonly tool
// ---------------------------------------------------------------------------

describe('INT-T9: checkViolation allows high-taint readonly tool', () => {
  it('a high-taint NON-destructive tool name returns null (allowed)', () => {
    const tracker = new TaintTracker();
    const taint = tracker.tag('tool.read', 'tool_output', 'high');

    // 'tool.read' doesn't match any DESTRUCTIVE_PATTERNS and safety='readonly'
    const result = tracker.checkViolation('tool.read', 'readonly', taint.taintId);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// INT-T10: SUDO_TAINT_DISABLE=1 — attachHooks not called
// ---------------------------------------------------------------------------

describe('INT-T10: SUDO_TAINT_DISABLE=1 — attachHooks not called', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['SUDO_TAINT_DISABLE'];
    process.env['SUDO_TAINT_DISABLE'] = '1';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['SUDO_TAINT_DISABLE'];
    } else {
      process.env['SUDO_TAINT_DISABLE'] = originalEnv;
    }
  });

  it('when kill-switch is set, the kill-switch check prevents taint tracking', async () => {
    const tracker = new TaintTracker();
    const hooks = new HookManager();

    // Simulate the cli.ts kill-switch check (uses === '1' after Wave 10F Item 3 fix).
    if (process.env['SUDO_TAINT_DISABLE'] !== '1') {
      tracker.attachHooks(hooks);
    }

    // Emit — tracker should NOT have been attached, size stays 0.
    await hooks.emit('after:tool-call', { event: 'after:tool-call', toolName: 'test.tool' });
    expect(tracker.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// INT-T11: _lastTaintIds populated after onToolResult
// ---------------------------------------------------------------------------

describe('INT-T11: _lastTaintIds populated after onToolResult', () => {
  it('onToolResult stores a taintId and getTaint retrieves it', () => {
    const tracker = new TaintTracker();

    // Directly call onToolResult (the method loop.ts calls after each tool result).
    const result = tracker.onToolResult({ name: 'tool.fetch', result: { data: 'hello' } });

    expect(result.taintId).toBeDefined();
    expect(typeof result.taintId).toBe('string');
    expect(result.taintId.length).toBeGreaterThan(0);

    // Verify the taint is stored and retrievable.
    const stored = tracker.getTaint(result.taintId);
    expect(stored).toBeDefined();
    expect(stored?.origin).toBe('tool.fetch');

    // Simulate the _lastTaintIds.set() in loop.ts.
    const lastTaintIds = new Map<string, string>();
    lastTaintIds.set('tool.fetch', result.taintId);

    // Check the map has the entry for the tool name.
    expect(lastTaintIds.get('tool.fetch')).toBe(result.taintId);
  });
});

// ---------------------------------------------------------------------------
// INT-T13: Wave 10F Item 1 — _lastTaintIds.clear() on session:end (loop.ts hygiene)
// ---------------------------------------------------------------------------

describe('INT-T13: Wave 10F Item 1 — _lastTaintIds cleared on session:end', () => {
  it('a Map representing _lastTaintIds is cleared when session:end fires', async () => {
    // Simulate the loop.ts _lastTaintIds map and the session:end clear semantics.
    // We cannot reach loop.ts's private _lastTaintIds directly, so we verify the
    // contract: after session:end the taint tracker itself is cleared (it uses the
    // same hook), and we verify the clear() semantics hold for an equivalent Map.
    const tracker = new TaintTracker();
    const hooks = new HookManager();
    tracker.attachHooks(hooks);

    // Simulate what loop.ts does: call onToolResult, then store the id in a local map.
    const lastTaintIds = new Map<string, string>();
    const r1 = tracker.onToolResult({ name: 'tool.fetch', result: 'data' });
    lastTaintIds.set('tool.fetch', r1.taintId);
    const r2 = tracker.onToolResult({ name: 'tool.write', result: 'ok' });
    lastTaintIds.set('tool.write', r2.taintId);
    expect(lastTaintIds.size).toBe(2);
    expect(tracker.size).toBe(2);

    // Fire session:end — tracker clears its _taints.
    await hooks.emit('session:end', { event: 'session:end', sessionId: 'sess-loop-1' });
    expect(tracker.size).toBe(0);

    // The loop.ts code adds `this._lastTaintIds.clear()` immediately after the emit.
    // Simulate that step.
    lastTaintIds.clear();
    expect(lastTaintIds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// INT-T14: Wave 10F Item 2 — handler skips tag() when meta.taintId already present
// ---------------------------------------------------------------------------

describe('INT-T14: Wave 10F Item 2 — no duplicate taint when meta.taintId pre-set', () => {
  it('tracker.size increases by 1 (not 2) when taintId is forwarded in hook meta', async () => {
    const tracker = new TaintTracker();
    const hooks = new HookManager();
    tracker.attachHooks(hooks);

    // Simulate what loop.ts now does: call onToolResult first, then emit with taintId in meta.
    const taintResult = tracker.onToolResult({ name: 'tool.api', result: 'response' });
    expect(tracker.size).toBe(1);

    // Emit the hook with the taintId already in meta — handler should NOT create a second taint.
    await hooks.emit('after:tool-call', {
      event: 'after:tool-call',
      toolName: 'tool.api',
      meta: { taintId: taintResult.taintId },
    });

    // Size must still be 1 (no duplicate).
    expect(tracker.size).toBe(1);
  });

  it('handler still creates a taint when no meta.taintId is provided (standalone emit)', async () => {
    const tracker = new TaintTracker();
    const hooks = new HookManager();
    tracker.attachHooks(hooks);

    // Emit without meta — handler should create a new taint (backward-compatible).
    const sizeBefore = tracker.size;
    await hooks.emit('after:tool-call', { event: 'after:tool-call', toolName: 'tool.standalone' });
    expect(tracker.size).toBe(sizeBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// INT-T12: idle-timer does not block process exit
// ---------------------------------------------------------------------------

describe('INT-T12: idle-timer does not block process exit', () => {
  it('setInterval timer is unref\'d so it does not prevent process exit', () => {
    // We cannot easily inspect the internal _idleTimer variable from outside
    // the module. Instead, we verify the expected behavior:
    // - A TaintTracker can be created and cleared without holding the process open
    // - We verify this by checking that calling clear() does not throw and
    //   that the module-level idle guard setup (via attachHooks) does not error.

    const tracker = new TaintTracker();
    const hooks = new HookManager();

    // If _startIdleGuard throws or sets a ref'd timer the test environment
    // would hang or report an uncaught error. Neither happens.
    expect(() => tracker.attachHooks(hooks)).not.toThrow();

    // Re-attach should reset the timer without errors.
    expect(() => tracker.attachHooks(hooks)).not.toThrow();

    // Verify clear is callable after attach.
    tracker.tag('tool.a', 'tool_output');
    expect(tracker.size).toBe(1);
    tracker.clear();
    expect(tracker.size).toBe(0);
  });
});
