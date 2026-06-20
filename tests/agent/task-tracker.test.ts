/**
 * @file tests/agent/task-tracker.test.ts
 * @description TaskTracker — class lifecycle unit tests + the agent-loop wiring
 * (orphan-wiring follow-up). The class was previously orphaned (only exported,
 * never used). It now backs auto-plan subgoals under SUDO_TASK_TRACKER=1 and
 * re-presents open subgoals to the agent across turns.
 *
 *   Class:  create/start/complete/fail lifecycle, getProgress, list/get/clear.
 *   Wiring: TTW-1 cross-turn re-presentation of open subgoals,
 *           TTW-2 flag OFF → no re-presentation (default behavior unchanged),
 *           TTW-3 tracker only populated when auto-plan produced a plan.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskTracker } from '../../src/core/agent/task-tracker.js';
import { AgentLoop } from '../../src/core/agent/loop.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainResponse } from '../../src/core/brain/types.js';

// ---------------------------------------------------------------------------
// Class unit tests
// ---------------------------------------------------------------------------

describe('TaskTracker class', () => {
  it('creates pending tasks and transitions through the lifecycle', () => {
    const t = new TaskTracker();
    const a = t.create('build the CLI');
    expect(a.status).toBe('pending');
    t.start(a.id);
    expect(t.get(a.id)?.status).toBe('in_progress');
    t.complete(a.id);
    expect(t.get(a.id)?.status).toBe('completed');
    expect(t.get(a.id)?.completedAt).toBeDefined();
  });

  it('records failures with an error message', () => {
    const t = new TaskTracker();
    const a = t.create('flaky step');
    t.fail(a.id, 'network down');
    expect(t.get(a.id)?.status).toBe('failed');
    expect(t.get(a.id)?.error).toBe('network down');
  });

  it('getProgress summarizes done/total and surfaces failures', () => {
    const t = new TaskTracker();
    expect(t.getProgress()).toBe('No tasks tracked');
    const a = t.create('a'); const b = t.create('b'); const c = t.create('c');
    t.complete(a.id);
    expect(t.getProgress()).toBe('1/3 tasks completed');
    t.fail(b.id, 'boom');
    expect(t.getProgress()).toBe('1/3 tasks completed (1 failed)');
    expect(t.list()).toHaveLength(3);
    expect(c.status).toBe('pending');
  });

  it('mutating an unknown id is a no-op (loop resilience)', () => {
    const t = new TaskTracker();
    expect(() => t.complete('nope')).not.toThrow();
    expect(() => t.fail('nope', 'x')).not.toThrow();
    expect(() => t.start('nope')).not.toThrow();
  });

  it('clear empties the registry', () => {
    const t = new TaskTracker();
    t.create('x'); t.create('y');
    t.clear();
    expect(t.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Agent-loop wiring
// ---------------------------------------------------------------------------

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});

function makeLoop(brain: ReturnType<typeof createMockBrain>): AgentLoop {
  return new AgentLoop(
    brain,
    createMockToolRegistry(),
    createMockSessionManager(),
    undefined, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
}

function resp(content: string): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}

const COMPLEX = 'build a CLI tool, then test all the modules, and finally write the docs';
const PLAN = '1. Build the CLI\n2. Test all modules\n3. Write the docs';

/** True when any brain.call() carried a message (any role) containing `needle`. */
function inMessages(brain: ReturnType<typeof createMockBrain>, needle: string): boolean {
  return brain.call.mock.calls.some((c: unknown[]) => {
    const first = c[0] as { messages?: Array<{ role: string; content: string }> } | undefined;
    return (first?.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes(needle));
  });
}

describe('TaskTracker wiring into the agent loop', () => {
  let savedPlan: string | undefined;
  let savedTracker: string | undefined;
  beforeEach(() => {
    savedPlan = process.env['SUDO_AUTO_PLAN'];
    savedTracker = process.env['SUDO_TASK_TRACKER'];
    delete process.env['SUDO_AUTO_PLAN'];
    delete process.env['SUDO_TASK_TRACKER'];
  });
  afterEach(() => {
    if (savedPlan === undefined) delete process.env['SUDO_AUTO_PLAN']; else process.env['SUDO_AUTO_PLAN'] = savedPlan;
    if (savedTracker === undefined) delete process.env['SUDO_TASK_TRACKER']; else process.env['SUDO_TASK_TRACKER'] = savedTracker;
  });

  it('TTW-1: re-presents open subgoals to the agent on the next turn (same session)', async () => {
    process.env['SUDO_AUTO_PLAN'] = '1';
    process.env['SUDO_TASK_TRACKER'] = '1';
    const brain = createMockBrain();
    brain.call
      .mockResolvedValueOnce(resp(PLAN))   // turn 1 decomposition
      .mockResolvedValueOnce(resp('done')) // turn 1 main
      .mockResolvedValueOnce(resp(PLAN))   // turn 2 decomposition
      .mockResolvedValue(resp('done'));    // turn 2 main
    const loop = makeLoop(brain);

    await loop.run('test-session-id', COMPLEX); // turn 1 — plan injected, 3 tasks created, none addressed by the no-op mock
    await loop.run('test-session-id', COMPLEX); // turn 2 — prior progress rides this turn's user message

    // Rides the user message (the channel that survives the sliding window
    // cross-turn). None addressed by the no-op mock → progress is 0/3.
    expect(inMessages(brain, 'Session progress')).toBe(true);
    expect(inMessages(brain, '0/3 tasks completed')).toBe(true);
    expect(inMessages(brain, 'Still open from earlier')).toBe(true);
    expect(inMessages(brain, 'Build the CLI')).toBe(true);
  });

  it('TTW-2: flag OFF → no re-presentation even across turns (default unchanged)', async () => {
    process.env['SUDO_AUTO_PLAN'] = '1'; // plan on, tracker OFF
    const brain = createMockBrain();
    brain.call
      .mockResolvedValueOnce(resp(PLAN))
      .mockResolvedValueOnce(resp('done'))
      .mockResolvedValueOnce(resp(PLAN))
      .mockResolvedValue(resp('done'));
    const loop = makeLoop(brain);

    await loop.run('test-session-id', COMPLEX);
    await loop.run('test-session-id', COMPLEX);

    expect(inMessages(brain, 'Session progress')).toBe(false);
  });

  it('TTW-3: tracker flag on but no plan (auto-plan off) → nothing re-presented', async () => {
    process.env['SUDO_TASK_TRACKER'] = '1'; // tracker on, auto-plan OFF → no steps produced
    const brain = createMockBrain();
    brain.call.mockResolvedValue(resp('done'));
    const loop = makeLoop(brain);

    await loop.run('test-session-id', COMPLEX);
    await loop.run('test-session-id', COMPLEX);

    expect(inMessages(brain, 'Session progress')).toBe(false);
  });
});
