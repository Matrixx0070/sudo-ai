/**
 * Durable offline queue + pipeline (Spec 6 PR2).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { enqueueForTarget, drainQueueForSession, __resetQueueForTests, __resetSessionBusForTests } from '../../src/core/agents/session-bus.js';
import { sessionsSendTool } from '../../src/core/tools/builtin/meta/sessions-send.js';
import { sessionsPipelineTool } from '../../src/core/tools/builtin/meta/sessions-pipeline.js';
import { injectMetaToolDeps } from '../../src/core/tools/builtin/meta/index.js';
import type { ToolContext } from '../../src/core/tools/types.js';

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ sessionId: 'A', workingDir: '/tmp', config: null, logger: console, isOwner: true, channel: 'web', ...over } as unknown as ToolContext);

let run: ReturnType<typeof vi.fn>;
beforeEach(() => {
  __resetSessionBusForTests();
  __resetQueueForTests();
  run = vi.fn(async (_sid: string, _msg: string) => ({ text: `out(${_msg.slice(-8)})` }));
  injectMetaToolDeps({
    sessionManager: { get: async (id: string) => (['B', 'C'].includes(id) ? { id } : undefined) },
    agentLoop: { run },
  });
});

describe('durable offline queue', () => {
  it('enqueue then drain returns + clears', () => {
    enqueueForTarget('B', 'A', 'env-1');
    enqueueForTarget('B', 'A', 'env-2');
    const drained = drainQueueForSession('B');
    expect(drained.map((d) => d.envelope)).toEqual(['env-1', 'env-2']);
    expect(drainQueueForSession('B')).toEqual([]); // cleared
  });

  it('sessions.send deliverMode:queue persists instead of running', async () => {
    const r = await sessionsSendTool.execute({ targetSessionId: 'B', message: 'later', deliverMode: 'queue' }, ctx());
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/queued/i);
    expect(run).not.toHaveBeenCalled();
    const drained = drainQueueForSession('B');
    expect(drained).toHaveLength(1);
    expect(drained[0]!.envelope).toContain('later');
  });
});

describe('sessions.pipeline', () => {
  it('threads output through each step in order', async () => {
    const r = await sessionsPipelineTool.execute({ steps: ['B', 'C'], input: 'seed' }, ctx());
    expect(r.success).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    // step 1 gets the seed; step 2 gets step 1's output threaded in.
    expect(run.mock.calls[0]![0]).toBe('B');
    expect(run.mock.calls[0]![1]).toContain('seed');
    expect(run.mock.calls[1]![0]).toBe('C');
    const data = r.data as { steps: Array<{ ok: boolean }>; final: string };
    expect(data.steps.every((s) => s.ok)).toBe(true);
  });

  it('stops on an unknown step session', async () => {
    const r = await sessionsPipelineTool.execute({ steps: ['B', 'ghost', 'C'], input: 'seed' }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/stopped after/i);
  });

  it('refuses a non-owner session', async () => {
    const r = await sessionsPipelineTool.execute({ steps: ['B'], input: 'x' }, ctx({ isOwner: false }));
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/owner-tier/i);
  });
});
