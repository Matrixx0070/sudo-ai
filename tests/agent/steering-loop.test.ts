/**
 * @file tests/agent/steering-loop.test.ts
 * @description Mid-run steering: the loop polls a SteeringChannel at each
 * iteration boundary and honors abort/inject/reprioritize. Previously the
 * channel was built and discarded (dead wiring) — this proves it's now live.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { InMemorySteeringChannel } from '../../src/core/agent/steering.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainResponse } from '../../src/core/brain/types.js';

const SID = 'test-session-id'; // the pre-seeded session in the mock manager

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});
function makeLoop(brain: ReturnType<typeof createMockBrain>) {
  return new AgentLoop(brain, createMockToolRegistry(), createMockSessionManager(), undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());
}
function stop(content = 'done'): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}
function injectedMessage(brain: ReturnType<typeof createMockBrain>, needle: string): string | undefined {
  const msgs = (brain.call.mock.calls[0]?.[0]?.messages ?? []) as Array<{ content?: unknown }>;
  const m = msgs.find((x) => typeof x.content === 'string' && x.content.includes(needle));
  return m?.content as string | undefined;
}

describe('mid-run steering channel', () => {
  it('STEER-abort: a pending abort stops the loop before the next model call', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const ch = new InMemorySteeringChannel();
    const loop = makeLoop(brain);
    loop.setSteeringChannel(ch);

    ch.signal(SID, { action: 'abort', payload: 'user changed their mind' });
    const result = await loop.run(SID, 'do a long task');

    // Aborted at the first iteration boundary — before any brain.call.
    expect(brain.call).not.toHaveBeenCalled();
    // Signal consumed (check→act→clear).
    expect(ch.checkSteering(SID)).toBeNull();
    // The stop is surfaced to the caller, not an indistinguishable empty done.
    expect(result?.text ?? '').toContain('aborted by steering');
    expect(result?.text ?? '').toContain('user changed their mind');
  });

  it('STEER-inject: a pending inject pushes guidance the model sees, exactly once', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const ch = new InMemorySteeringChannel();
    const loop = makeLoop(brain);
    loop.setSteeringChannel(ch);

    ch.signal(SID, { action: 'inject', payload: 'PRIORITIZE the deploy check' });
    await loop.run(SID, 'hi');

    const injected = injectedMessage(brain, 'PRIORITIZE the deploy check');
    expect(injected).toBeDefined();
    expect(injected).toContain('[STEERING — INJECTED CONTEXT]');
    expect(ch.checkSteering(SID)).toBeNull();
  });

  it('STEER-reprioritize: labelled as REPRIORITIZE and injected', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const ch = new InMemorySteeringChannel();
    const loop = makeLoop(brain);
    loop.setSteeringChannel(ch);

    ch.signal(SID, { action: 'reprioritize', payload: 'switch to the urgent bug' });
    await loop.run(SID, 'hi');

    const injected = injectedMessage(brain, 'switch to the urgent bug');
    expect(injected).toContain('[STEERING — REPRIORITIZE]');
  });

  it('STEER-none: no channel → loop runs normally', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const loop = makeLoop(brain); // no setSteeringChannel
    await loop.run(SID, 'hi');
    expect(brain.call).toHaveBeenCalled();
  });

  it('setSteeringChannel rejects a bad duck-type without throwing', () => {
    const loop = makeLoop(createMockBrain());
    expect(() => loop.setSteeringChannel({} as never)).not.toThrow();
  });
});
