/**
 * @file tests/security/taint-tracker.test.ts
 * @description Tests for TaintTracker — taint propagation and violation detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaintTracker } from '../../src/core/security/taint-tracker.js';
import type { TaintLevel, TaintSource } from '../../src/core/shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockHooks() {
  const registered: Array<{ event: string; handler: (ctx: Record<string, unknown>) => Promise<void>; desc: string }> = [];
  return {
    register: vi.fn((event: string, handler: (ctx: Record<string, unknown>) => Promise<void>, desc = '') => {
      registered.push({ event, handler, desc });
      return 'mock-hook-id';
    }),
    emit: vi.fn(async () => {}),
    _registered: registered,
  };
}

// ---------------------------------------------------------------------------
// Tests: tag()
// ---------------------------------------------------------------------------

describe('TaintTracker.tag()', () => {
  let tracker: TaintTracker;

  beforeEach(() => {
    tracker = new TaintTracker();
  });

  it('assigns a taint with default level medium', () => {
    const taint = tracker.tag('tool.fetch', 'tool_output');
    expect(taint.level).toBe('medium');
    expect(taint.source).toBe('tool_output');
    expect(taint.origin).toBe('tool.fetch');
  });

  it('assigns specified level', () => {
    const taint = tracker.tag('coder.write', 'user_input', 'high');
    expect(taint.level).toBe('high');
  });

  it('assigns a unique taintId (UUID format)', () => {
    const t1 = tracker.tag('a', 'tool_output');
    const t2 = tracker.tag('b', 'tool_output');
    expect(t1.taintId).not.toBe(t2.taintId);
    expect(t1.taintId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores taint in internal set', () => {
    const taint = tracker.tag('tool.a', 'external_fetch');
    expect(tracker.getTaint(taint.taintId)).toEqual(taint);
    expect(tracker.size).toBe(1);
  });

  it('assignedAt is a valid ISO-8601 timestamp', () => {
    const taint = tracker.tag('tool.b', 'tool_output');
    expect(new Date(taint.assignedAt).toISOString()).toBe(taint.assignedAt);
  });
});

// ---------------------------------------------------------------------------
// Tests: propagate()
// ---------------------------------------------------------------------------

describe('TaintTracker.propagate()', () => {
  let tracker: TaintTracker;

  beforeEach(() => {
    tracker = new TaintTracker();
  });

  it('propagates MAX level from ancestors (Rule 2)', () => {
    const t1 = tracker.tag('tool.a', 'tool_output', 'low');
    const t2 = tracker.tag('tool.b', 'tool_output', 'high');
    const derived = tracker.propagate([t1.taintId, t2.taintId], 'tool.c');
    expect(derived.level).toBe('high');
  });

  it('baseline is medium when ancestors are all lower', () => {
    const t1 = tracker.tag('tool.a', 'tool_output', 'low');
    const derived = tracker.propagate([t1.taintId], 'tool.b');
    expect(derived.level).toBe('medium'); // Rule 1 baseline
  });

  it('inherits external_fetch source from ancestors', () => {
    const t1 = tracker.tag('browser.fetch', 'external_fetch', 'medium');
    const derived = tracker.propagate([t1.taintId], 'tool.process');
    expect(derived.source).toBe('external_fetch');
  });

  it('includes valid ancestorIds in derived taint', () => {
    const t1 = tracker.tag('tool.x', 'tool_output', 'medium');
    const derived = tracker.propagate([t1.taintId, 'nonexistent-id'], 'tool.y');
    expect(derived.ancestors).toContain(t1.taintId);
    expect(derived.ancestors).not.toContain('nonexistent-id');
  });

  it('handles empty ancestor list (Rule 1 baseline)', () => {
    const derived = tracker.propagate([], 'tool.z');
    expect(derived.level).toBe('medium');
    expect(derived.ancestors).toHaveLength(0);
  });

  it('stores derived taint in set', () => {
    const t1 = tracker.tag('a', 'tool_output');
    const derived = tracker.propagate([t1.taintId], 'b');
    expect(tracker.getTaint(derived.taintId)).toBeDefined();
  });

  it('critical level is preserved through chain', () => {
    const t1 = tracker.tag('attack.tool', 'channel_message', 'critical');
    const t2 = tracker.tag('step.two', 'tool_output', 'low');
    const derived = tracker.propagate([t1.taintId, t2.taintId], 'final.tool');
    expect(derived.level).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// Tests: checkViolation()
// ---------------------------------------------------------------------------

describe('TaintTracker.checkViolation()', () => {
  let tracker: TaintTracker;

  beforeEach(() => {
    tracker = new TaintTracker();
  });

  it('returns null for medium taint on destructive tool (Rule 4 threshold is high)', () => {
    const taint = tracker.tag('fetch', 'tool_output', 'medium');
    const violation = tracker.checkViolation('coder.write', 'destructive', taint.taintId);
    expect(violation).toBeNull();
  });

  it('blocks high taint on destructive tool (Rule 4)', () => {
    const taint = tracker.tag('external.fetch', 'external_fetch', 'high');
    const violation = tracker.checkViolation('system.shell', 'destructive', taint.taintId);
    expect(violation).not.toBeNull();
    expect(violation!.toolName).toBe('system.shell');
    expect(violation!.taint.level).toBe('high');
    expect(violation!.reason).toContain('destructive');
  });

  it('blocks critical taint on destructive tool', () => {
    const taint = tracker.tag('channel', 'channel_message', 'critical');
    const violation = tracker.checkViolation('coder.write', 'destructive', taint.taintId);
    expect(violation).not.toBeNull();
  });

  it('allows high taint on readonly tool', () => {
    const taint = tracker.tag('fetch', 'external_fetch', 'high');
    const violation = tracker.checkViolation('coder.read-file', 'readonly', taint.taintId);
    expect(violation).toBeNull();
  });

  it('blocks high taint on tool with .write suffix even when safety=readonly', () => {
    const taint = tracker.tag('attacker', 'external_fetch', 'high');
    const violation = tracker.checkViolation('fs.write', 'readonly', taint.taintId);
    expect(violation).not.toBeNull();
  });

  it('blocks high taint on system.shell (destructive pattern match)', () => {
    const taint = tracker.tag('fetch', 'external_fetch', 'high');
    const violation = tracker.checkViolation('system.shell', 'readonly', taint.taintId);
    expect(violation).not.toBeNull();
  });

  it('returns null when taintId not found', () => {
    const violation = tracker.checkViolation('tool.x', 'destructive', 'nonexistent-id');
    expect(violation).toBeNull();
  });

  it('violation contains ISO-8601 timestamp', () => {
    const taint = tracker.tag('evil', 'channel_message', 'critical');
    const violation = tracker.checkViolation('coder.write', 'destructive', taint.taintId);
    expect(violation).not.toBeNull();
    expect(new Date(violation!.timestamp).toISOString()).toBe(violation!.timestamp);
  });

  it('low taint never blocks destructive tools', () => {
    const taint = tracker.tag('safe', 'tool_output', 'low');
    const violation = tracker.checkViolation('system.shell', 'destructive', taint.taintId);
    expect(violation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: onToolResult()
// ---------------------------------------------------------------------------

describe('TaintTracker.onToolResult()', () => {
  let tracker: TaintTracker;

  beforeEach(() => {
    tracker = new TaintTracker();
  });

  it('creates a new taint when no ancestors', () => {
    const taint = tracker.onToolResult({ name: 'tool.fetch', result: { data: 'test' } });
    expect(taint.level).toBe('medium');
    expect(tracker.size).toBe(1);
  });

  it('propagates from ancestorTaintIds when provided', () => {
    const parent = tracker.tag('parent', 'external_fetch', 'high');
    const taint = tracker.onToolResult({
      name: 'child',
      result: {},
      ancestorTaintIds: [parent.taintId],
    });
    expect(taint.level).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Tests: attachHooks()
// ---------------------------------------------------------------------------

describe('TaintTracker.attachHooks()', () => {
  it('registers handler on after:tool-call event', () => {
    const tracker = new TaintTracker();
    const hooks = makeMockHooks();
    tracker.attachHooks(hooks as unknown as Parameters<typeof tracker.attachHooks>[0]);

    expect(hooks.register).toHaveBeenCalledWith(
      'after:tool-call',
      expect.any(Function),
      expect.any(String),
    );
  });

  it('hook handler creates taint when toolName is provided', async () => {
    const tracker = new TaintTracker();
    const hooks = makeMockHooks();
    tracker.attachHooks(hooks as unknown as Parameters<typeof tracker.attachHooks>[0]);

    // Find the registered handler
    const registration = hooks._registered.find(r => r.event === 'after:tool-call');
    expect(registration).toBeDefined();

    await registration!.handler({
      event: 'after:tool-call',
      toolName: 'test.tool',
      result: {},
      meta: {},
    } as unknown as Record<string, unknown>);

    expect(tracker.size).toBe(1);
  });

  it('hook handler skips when toolName is absent', async () => {
    const tracker = new TaintTracker();
    const hooks = makeMockHooks();
    tracker.attachHooks(hooks as unknown as Parameters<typeof tracker.attachHooks>[0]);

    const registration = hooks._registered.find(r => r.event === 'after:tool-call');
    await registration!.handler({
      event: 'after:tool-call',
      // no toolName
    } as unknown as Record<string, unknown>);

    expect(tracker.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: clear()
// ---------------------------------------------------------------------------

describe('TaintTracker.clear()', () => {
  it('empties the taint set', () => {
    const tracker = new TaintTracker();
    tracker.tag('a', 'tool_output');
    tracker.tag('b', 'tool_output');
    expect(tracker.size).toBe(2);

    tracker.clear();
    expect(tracker.size).toBe(0);
  });
});
