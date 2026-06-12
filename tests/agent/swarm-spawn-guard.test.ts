/**
 * @file tests/agent/swarm-spawn-guard.test.ts
 * @description AgentSwarm spawn pipeline (gap #10) — RAII slot guard and
 * fork-mode history seeding. AgentLoop and isolation are mocked so the
 * tests are hermetic: no LLM, no filesystem isolation.
 *
 * Leak regressions covered: before the guard, a throw from the swarm:spawn
 * hook or the AgentLoop constructor leaked the active record, skipped
 * isolation cleanup, and never notified pushCompletionBus subscribers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const control = vi.hoisted(() => ({
  loopCtorThrows: false,
  runResult: { text: 'sub-agent answer' },
  isolationCleanup: vi.fn(async () => undefined),
}));

vi.mock('../../src/core/agent/loop.js', () => ({
  AgentLoop: class {
    constructor() {
      if (control.loopCtorThrows) throw new Error('AgentLoop ctor exploded');
    }
    async run(_sessionId: string, _task: string): Promise<{ text: string }> {
      return control.runResult;
    }
  },
}));

vi.mock('../../src/core/agent/isolation.js', () => ({
  createIsolatedAgent: vi.fn(async () => ({
    workdir: '/tmp/iso-test',
    cleanup: control.isolationCleanup,
  })),
}));

import { AgentSwarm } from '../../src/core/agent/swarm.js';
import { pushCompletionBus } from '../../src/core/agent/push-completion.js';
import type { SubAgentFailedEvent, SubAgentCompleteEvent } from '../../src/core/agent/push-completion.js';
import type { ForkableMessage } from '../../src/core/agent/fork-history.js';

interface FakeSession {
  id: string;
  messages: ForkableMessage[];
}

function makeDeps() {
  const sessions = new Map<string, FakeSession>();
  const sessionManager = {
    get: vi.fn(async (id: string) => sessions.get(id) ?? null),
    getOrCreate: vi.fn(async (_channel: string, peerId: string) => {
      const s: FakeSession = { id: `sess-${peerId}`, messages: [] };
      sessions.set(s.id, s);
      return s;
    }),
    save: vi.fn(async () => undefined),
  };
  return {
    brain: { call: vi.fn() },
    toolRegistry: { execute: vi.fn() },
    sessionManager,
    sessions,
  };
}

function onceFailed(): Promise<SubAgentFailedEvent> {
  return new Promise((r) => pushCompletionBus.once('subagent:failed', r));
}

function onceComplete(): Promise<SubAgentCompleteEvent> {
  return new Promise((r) => pushCompletionBus.once('subagent:complete', r));
}

beforeEach(() => {
  control.loopCtorThrows = false;
  control.runResult = { text: 'sub-agent answer' };
  control.isolationCleanup = vi.fn(async () => undefined);
});

describe('AgentSwarm spawn — success path', () => {
  it('returns the result, emits completion, and clears the active record', async () => {
    const deps = makeDeps();
    const swarm = new AgentSwarm(deps.brain, deps.toolRegistry, deps.sessionManager);

    const completed = onceComplete();
    const result = await swarm.spawn('do the thing');

    expect(result).toBe('sub-agent answer');
    expect((await completed).result).toBe('sub-agent answer');
    expect(swarm.getActive()).toEqual([]);
  });

  it('seeds filtered fork history into the ephemeral session and persists it', async () => {
    const deps = makeDeps();
    const swarm = new AgentSwarm(deps.brain, deps.toolRegistry, deps.sessionManager);

    const forkHistory: ForkableMessage[] = [
      { role: 'user', content: 'parent request' },
      { role: 'assistant', content: 'calling a tool', toolCalls: [{ id: 't1' }] },
      { role: 'tool', content: 'tool output' },
      { role: 'assistant', content: 'parent final answer' },
    ];

    await swarm.spawn('sub task', { forkHistory });

    const session = [...deps.sessions.values()][0]!;
    expect(session.messages.map((m) => m.content)).toEqual(['parent request', 'parent final answer']);
    expect(deps.sessionManager.save).toHaveBeenCalledTimes(1);
  });

  it('does not touch the session when forkHistory is omitted (default unchanged)', async () => {
    const deps = makeDeps();
    const swarm = new AgentSwarm(deps.brain, deps.toolRegistry, deps.sessionManager);

    await swarm.spawn('sub task');

    const session = [...deps.sessions.values()][0]!;
    expect(session.messages).toEqual([]);
    expect(deps.sessionManager.save).not.toHaveBeenCalled();
  });
});

describe('AgentSwarm spawn — RAII guard on early failures', () => {
  it('a throwing swarm:spawn hook no longer leaks the slot or starves subscribers', async () => {
    const deps = makeDeps();
    const hookManager = {
      emit: vi.fn(async () => { throw new Error('hook exploded'); }),
    };
    const swarm = new AgentSwarm(
      deps.brain, deps.toolRegistry, deps.sessionManager,
      hookManager as unknown as ConstructorParameters<typeof AgentSwarm>[3],
    );

    const failed = onceFailed();
    await expect(swarm.spawn('task')).rejects.toThrow('hook exploded');
    expect((await failed).error).toContain('hook exploded');
    expect(swarm.getActive()).toEqual([]);
  });

  it('an AgentLoop constructor throw cleans up the isolation environment', async () => {
    const deps = makeDeps();
    const swarm = new AgentSwarm(deps.brain, deps.toolRegistry, deps.sessionManager);
    control.loopCtorThrows = true;

    const failed = onceFailed();
    await expect(swarm.spawn('task', { isolationMode: 'sandboxed' })).rejects.toThrow('AgentLoop ctor exploded');
    await failed;
    expect(control.isolationCleanup).toHaveBeenCalledTimes(1);
    expect(swarm.getActive()).toEqual([]);
  });

  it('a session-creation failure rejects with PipelineError and notifies subscribers', async () => {
    const deps = makeDeps();
    deps.sessionManager.getOrCreate.mockRejectedValueOnce(new Error('db locked'));
    const swarm = new AgentSwarm(deps.brain, deps.toolRegistry, deps.sessionManager);

    const failed = onceFailed();
    await expect(swarm.spawn('task')).rejects.toThrow('failed to create session');
    expect((await failed).error).toContain('db locked');
    expect(swarm.getActive()).toEqual([]);
  });

  it('the swarm stays usable after an early failure (no slot leak)', async () => {
    const deps = makeDeps();
    deps.sessionManager.getOrCreate.mockRejectedValueOnce(new Error('transient'));
    const swarm = new AgentSwarm(deps.brain, deps.toolRegistry, deps.sessionManager);

    await expect(swarm.spawn('first')).rejects.toThrow();
    await expect(swarm.spawn('second')).resolves.toBe('sub-agent answer');
    expect(swarm.getActive()).toEqual([]);
  });
});

describe('AgentSwarm spawnAsync — RAII guard', () => {
  it('a throwing swarm:spawn hook notifies subscribers and clears the slot', async () => {
    const deps = makeDeps();
    const hookManager = {
      emit: vi.fn(async () => { throw new Error('async hook exploded'); }),
    };
    const swarm = new AgentSwarm(
      deps.brain, deps.toolRegistry, deps.sessionManager,
      hookManager as unknown as ConstructorParameters<typeof AgentSwarm>[3],
    );

    const failed = onceFailed();
    const id = await swarm.spawnAsync('task');
    const evt = await failed;
    expect(evt.agentId).toBe(id);
    expect(evt.error).toContain('async hook exploded');
    expect(swarm.getActive()).toEqual([]);
  });

  it('notifies failure for early throws instead of hanging subscribers', async () => {
    const deps = makeDeps();
    deps.sessionManager.getOrCreate.mockRejectedValueOnce(new Error('no session for you'));
    const swarm = new AgentSwarm(deps.brain, deps.toolRegistry, deps.sessionManager);

    const failed = onceFailed();
    const id = await swarm.spawnAsync('task');
    const evt = await failed;
    expect(evt.agentId).toBe(id);
    expect(evt.error).toContain('no session for you');
    expect(swarm.getActive()).toEqual([]);
  });

  it('completes normally and seeds fork history', async () => {
    const deps = makeDeps();
    const swarm = new AgentSwarm(deps.brain, deps.toolRegistry, deps.sessionManager);

    const completed = onceComplete();
    const id = await swarm.spawnAsync('task', {
      forkHistory: [
        { role: 'tool', content: 'noise' },
        { role: 'user', content: 'context' },
      ],
    });
    const evt = await completed;
    expect(evt.agentId).toBe(id);

    const session = [...deps.sessions.values()][0]!;
    expect(session.messages.map((m) => m.content)).toEqual(['context']);
  });
});
