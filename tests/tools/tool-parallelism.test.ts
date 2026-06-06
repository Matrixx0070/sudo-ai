import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolParallelism, type ToolCallGroup } from '../../src/core/tools/tool-parallelism.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolCallRequest, ToolContext, ToolResult } from '../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: '/tmp',
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function makeCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCallRequest {
  return { id, name, arguments: args };
}

function makeTool(name: string, delay = 0): () => Promise<ToolResult> {
  return async () => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return { success: true, output: `${name} result` };
  };
}

function setupRegistry(...toolNames: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of toolNames) {
    registry.register({
      name,
      description: `${name} tool`,
      category: 'coder',
      parameters: {},
      execute: makeTool(name),
    });
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolParallelism', () => {
  let parallelism: ToolParallelism;

  beforeEach(() => {
    parallelism = new ToolParallelism();
  });

  it('no dependencies runs parallel', async () => {
    const registry = setupRegistry('tool.a', 'tool.b');
    const ctx = makeContext();
    const calls = [makeCall('1', 'tool.a'), makeCall('2', 'tool.b')];

    const group = parallelism.analyzeDependencies(calls);
    expect(group.independent).toHaveLength(2);
    expect(group.dependent.size).toBe(0);
  });

  it('with dependencies waits', async () => {
    const calls = [
      makeCall('1', 'tool.a'),
      makeCall('2', 'tool.b', { tool_call_id: '1' }),
    ];

    const group = parallelism.analyzeDependencies(calls);
    expect(group.independent).toHaveLength(1);
    expect(group.dependent.has('1')).toBe(true);
    expect(group.dependent.get('1')).toHaveLength(1);
  });

  it('empty calls returns empty result', async () => {
    const registry = setupRegistry('tool.a');
    const ctx = makeContext();
    const result = await parallelism.executeParallel([], registry, ctx);

    expect(result.results.size).toBe(0);
    expect(result.totalTimeMs).toBe(0);
    expect(result.parallelism).toBe(0);
  });

  it('single call executes directly', async () => {
    const registry = setupRegistry('tool.a');
    const ctx = makeContext();
    const calls = [makeCall('1', 'tool.a')];

    const result = await parallelism.executeParallel(calls, registry, ctx);
    expect(result.results.size).toBe(1);
    expect(result.parallelism).toBe(1);
  });

  it('stats accumulate after executions', async () => {
    const registry = setupRegistry('tool.a', 'tool.b');
    const ctx = makeContext();

    await parallelism.executeParallel([makeCall('1', 'tool.a')], registry, ctx);
    await parallelism.executeParallel([makeCall('2', 'tool.a'), makeCall('3', 'tool.b')], registry, ctx);

    const stats = parallelism.getStats();
    expect(stats.totalExecutions).toBe(2);
    expect(stats.avgParallelism).toBeGreaterThan(0);
    expect(stats.timeSavedMs).toBeGreaterThanOrEqual(0);
  });

  it('concurrency limit is respected', async () => {
    const registry = new ToolRegistry();
    for (let i = 0; i < 12; i++) {
      registry.register({
        name: `tool.${i}`,
        description: `tool ${i}`,
        category: 'coder',
        parameters: {},
        execute: makeTool(`tool.${i}`, 5),
      });
    }
    const ctx = makeContext();
    const calls = Array.from({ length: 12 }, (_, i) => makeCall(`c${i}`, `tool.${i}`));

    const result = await parallelism.executeParallel(calls, registry, ctx);
    // All 12 calls should complete
    expect(result.results.size).toBe(12);
    // Parallelism capped at MAX_CONCURRENCY (8)
    expect(result.parallelism).toBeLessThanOrEqual(8);
  });

  it('dependency via ${result_X} template', () => {
    const calls = [
      makeCall('abc', 'tool.a'),
      makeCall('def', 'tool.b', { input: '${result_abc}' }),
    ];

    const group = parallelism.analyzeDependencies(calls);
    expect(group.independent).toHaveLength(1);
    expect(group.dependent.has('abc')).toBe(true);
  });
});