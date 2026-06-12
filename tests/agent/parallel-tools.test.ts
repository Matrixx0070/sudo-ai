/**
 * @file tests/agent/parallel-tools.test.ts
 * @description Concurrent tool execution (gap #8) — _isParallelSafe,
 * _partitionToolCalls, the SUDO_TOOL_CONCURRENCY cap, the
 * SUDO_PARALLEL_TOOLS_DISABLE kill switch, and the tool_batch_complete hook.
 *
 * Regression context: the original SEQUENTIAL_TOOL_PREFIXES blocklist used
 * names that no registered tool carries (file.write, shell.run …), so real
 * mutating tools (coder.write-file, system.exec, code.python-exec) passed as
 * parallel-safe. Registry safety metadata was never consulted, there was no
 * concurrency cap, and none of this had tests.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  _isParallelSafe,
  _partitionToolCalls,
  executeToolCalls,
} from '../../src/core/agent/loop-helpers.js';
import type { ToolRegistryLike, SessionLike, ToolDescriptor } from '../../src/core/agent/loop-helpers.js';
import type { AgentState } from '../../src/core/agent/types.js';

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

let idSeq = 0;
function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `tc-${++idSeq}`, name, arguments: args };
}

function makeState(): AgentState {
  return {
    sessionId: 'test-session',
    isCompacting: false,
    pendingToolCalls: 0,
    iterationCount: 0,
    maxIterations: 50,
    consecutiveReplans: 0,
  } as AgentState;
}

function makeSession(): SessionLike {
  return { id: 'test-session', messages: [] };
}

beforeEach(() => {
  idSeq = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// _isParallelSafe
// ---------------------------------------------------------------------------

describe('_isParallelSafe', () => {
  it('blocks real registered mutating tool names (regression: old blocklist missed them)', () => {
    for (const name of [
      'coder.write-file',
      'coder.edit-file',
      'coder.multi-edit',
      'coder.apply-patch',
      'coder.git',
      'system.exec',
      'system.shell',
      'code.python-exec',
      'code.js-exec',
      'sandbox.js',
    ]) {
      expect(_isParallelSafe(call(name), []), name).toBe(false);
    }
  });

  it('blocks the whole browser namespace (shared stateful session)', () => {
    for (const name of ['browser.navigate', 'browser.screenshot', 'browser.scroll', 'browser.fill-form']) {
      expect(_isParallelSafe(call(name), []), name).toBe(false);
    }
  });

  it('treats read-only tools as parallel-safe', () => {
    for (const name of ['coder.read-file', 'coder.grep', 'coder.glob', 'fs.stat', 'memory.search']) {
      expect(_isParallelSafe(call(name), []), name).toBe(true);
    }
  });

  it('consults registry safety metadata', () => {
    const registry: Pick<ToolRegistryLike, 'get'> = {
      get: (name: string): ToolDescriptor | undefined => {
        if (name === 'custom.nuke') return { name, description: '', category: 'meta', parameters: {}, safety: 'destructive' };
        if (name === 'custom.confirm') return { name, description: '', category: 'meta', parameters: {}, requiresConfirmation: true };
        if (name === 'custom.read') return { name, description: '', category: 'meta', parameters: {}, safety: 'readonly' };
        return undefined;
      },
    };
    expect(_isParallelSafe(call('custom.nuke'), [], registry)).toBe(false);
    expect(_isParallelSafe(call('custom.confirm'), [], registry)).toBe(false);
    expect(_isParallelSafe(call('custom.read'), [], registry)).toBe(true);
    expect(_isParallelSafe(call('custom.unknown'), [], registry)).toBe(true);
  });

  it('blocks calls sharing a path argument and allows distinct paths', () => {
    const a = call('coder.read-file', { path: '/tmp/same.txt' });
    const b = call('coder.read-file', { path: '/tmp/same.txt' });
    const c = call('coder.read-file', { path: '/tmp/other.txt' });
    expect(_isParallelSafe(a, [a, b, c])).toBe(false);
    expect(_isParallelSafe(c, [a, b, c])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _partitionToolCalls
// ---------------------------------------------------------------------------

describe('_partitionToolCalls', () => {
  it('partitions mixed calls into leading sequential, parallel window, trailing sequential', () => {
    const calls = [
      call('system.exec', { command: 'ls' }),
      call('coder.read-file', { path: '/a' }),
      call('coder.read-file', { path: '/b' }),
      call('coder.write-file', { path: '/c' }),
    ];
    const { leadingSequential, parallel, trailingSequential } = _partitionToolCalls(calls);
    expect(leadingSequential.map(t => t.name)).toEqual(['system.exec']);
    expect(parallel.map(t => t.arguments['path'])).toEqual(['/a', '/b']);
    expect(trailingSequential.map(t => t.name)).toEqual(['coder.write-file']);
  });

  it('returns everything sequential when no call is safe', () => {
    const calls = [call('system.exec'), call('coder.write-file', { path: '/x' })];
    const result = _partitionToolCalls(calls);
    expect(result.leadingSequential).toHaveLength(2);
    expect(result.parallel).toHaveLength(0);
  });

  it('keeps a single call sequential', () => {
    const calls = [call('coder.read-file', { path: '/a' })];
    const result = _partitionToolCalls(calls);
    expect(result.leadingSequential).toHaveLength(1);
    expect(result.parallel).toHaveLength(0);
  });

  it('SUDO_PARALLEL_TOOLS_DISABLE=1 forces everything sequential', () => {
    vi.stubEnv('SUDO_PARALLEL_TOOLS_DISABLE', '1');
    const calls = [call('coder.read-file', { path: '/a' }), call('coder.read-file', { path: '/b' })];
    const result = _partitionToolCalls(calls);
    expect(result.leadingSequential).toHaveLength(2);
    expect(result.parallel).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// executeToolCalls — concurrency cap + batch hook integration
// ---------------------------------------------------------------------------

function makeTrackingRegistry(): { registry: ToolRegistryLike; maxInFlight: () => number } {
  let inFlight = 0;
  let peak = 0;
  const registry: ToolRegistryLike = {
    execute: vi.fn(async (name: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { success: true, output: `ok:${name}` };
    }),
    getSchemaForLLM: vi.fn(() => []),
  };
  return { registry, maxInFlight: () => peak };
}

describe('executeToolCalls concurrency', () => {
  it('runs safe calls in parallel but never above SUDO_TOOL_CONCURRENCY', async () => {
    vi.stubEnv('SUDO_TOOL_CONCURRENCY', '2');
    const { registry, maxInFlight } = makeTrackingRegistry();
    const session = makeSession();
    const calls = ['/a', '/b', '/c', '/d', '/e'].map((p) => call('probe.read', { path: p }));

    // Pre-condition: all five calls land in the parallel window, so the peak
    // assertions below measure the cap rather than partition behaviour.
    expect(_partitionToolCalls(calls).parallel).toHaveLength(5);

    await executeToolCalls(calls, session, makeState(), () => undefined, registry);

    expect(maxInFlight()).toBeGreaterThan(1); // actually parallel
    expect(maxInFlight()).toBeLessThanOrEqual(2); // capped
    // Results appended in original order with correct linkage.
    expect(session.messages.map((m) => m.toolCallId)).toEqual(calls.map((c) => c.id));
    expect(session.messages.every((m) => m.role === 'tool' && m.toolName === 'probe.read')).toBe(true);
  });

  it('emits tool_batch_complete once after the whole batch settles', async () => {
    const { registry } = makeTrackingRegistry();
    const events: Array<Record<string, unknown>> = [];
    const hooks = { emit: async (_e: string, ctx: Record<string, unknown>) => { events.push(ctx); } };
    const calls = [call('probe.read', { path: '/a' }), call('probe.read', { path: '/b' })];

    await executeToolCalls(calls, makeSession(), makeState(), () => undefined, registry, undefined, undefined, hooks);
    // The emission is fire-and-forget (void safeEmit) — drain a full macrotask
    // turn so the test stays correct even if safeEmit gains awaits internally.
    await new Promise((r) => setTimeout(r, 0));

    const batch = events.filter((e) => e['event'] === 'tool_batch_complete');
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ toolCount: 2, parallelCount: 2 });
  });
});
