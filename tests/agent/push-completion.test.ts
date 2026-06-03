/**
 * Tests for push-completion.ts — PushCompletionBus.
 *
 * Tests cover:
 * - subscribe + complete fires event
 * - subscribe + fail fires error event
 * - one-shot cleanup after event
 * - spawnAsync returns agentId immediately
 * - backward compat spawn() still works
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PushCompletionBus, pushCompletionBus } from '../../src/core/agent/push-completion.js';
import { AgentSwarm } from '../../src/core/agent/swarm.js';
import type { SubAgentCompleteEvent, SubAgentFailedEvent } from '../../src/core/agent/push-completion.js';

// ---------------------------------------------------------------------------
// Helper: Create mock dependencies for AgentSwarm
// ---------------------------------------------------------------------------

function createMockBrain() {
  return {
    call: vi.fn().mockResolvedValue({ text: 'mock result' }),
  };
}

function createMockToolRegistry() {
  return {
    execute: vi.fn().mockResolvedValue({ result: {} }),
    getSchemaForLLM: vi.fn().mockReturnValue([
      {
        name: 'mockTool',
        description: 'A mock tool',
        parameters: { type: 'object', properties: {} },
      },
    ]),
    getAllTools: vi.fn().mockReturnValue([]),
  };
}

function createMockSessionManager() {
  return {
    getOrCreate: vi.fn().mockResolvedValue({ id: 'mock-session-id' }),
    get: vi.fn().mockResolvedValue({ messages: [] }),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// PushCompletionBus unit tests
// ---------------------------------------------------------------------------

describe('PushCompletionBus', () => {
  let bus: PushCompletionBus;

  beforeEach(() => {
    bus = new PushCompletionBus();
  });

  afterEach(() => {
    bus.removeAllListeners();
  });

  describe('subscribe', () => {
    it('registers a parent session for a sub-agent', () => {
      bus.subscribe('parent-1', 'agent-1');
      expect(bus.getSubscribers('agent-1')).toEqual(['parent-1']);
      expect(bus.hasSubscribers('agent-1')).toBe(true);
    });

    it('allows multiple parents to subscribe to the same agent', () => {
      bus.subscribe('parent-1', 'agent-1');
      bus.subscribe('parent-2', 'agent-1');
      const subscribers = bus.getSubscribers('agent-1');
      expect(subscribers).toHaveLength(2);
      expect(subscribers).toContain('parent-1');
      expect(subscribers).toContain('parent-2');
    });

    it('throws on empty parentSessionId', () => {
      expect(() => bus.subscribe('', 'agent-1')).toThrow('parentSessionId must be a non-empty string');
    });

    it('throws on empty agentId', () => {
      expect(() => bus.subscribe('parent-1', '')).toThrow('agentId must be a non-empty string');
    });
  });

  describe('complete', () => {
    it('emits subagent:complete event with correct payload', async () => {
      const completeHandler = vi.fn();
      bus.on('subagent:complete', completeHandler);

      const event: SubAgentCompleteEvent = {
        agentId: 'agent-1',
        task: 'test task',
        result: 'test result',
        duration: 1000,
      };

      bus.complete('agent-1', event);

      expect(completeHandler).toHaveBeenCalledTimes(1);
      expect(completeHandler).toHaveBeenCalledWith(event);
    });

    it('throws on empty agentId', () => {
      expect(() => bus.complete('', { agentId: '', task: '', result: '', duration: 0 })).toThrow('agentId must be a non-empty string');
    });
  });

  describe('fail', () => {
    it('emits subagent:failed event with correct payload', async () => {
      const failHandler = vi.fn();
      bus.on('subagent:failed', failHandler);

      const event: SubAgentFailedEvent = {
        agentId: 'agent-1',
        task: 'test task',
        error: 'test error',
      };

      bus.fail('agent-1', event);

      expect(failHandler).toHaveBeenCalledTimes(1);
      expect(failHandler).toHaveBeenCalledWith(event);
    });

    it('throws on empty agentId', () => {
      expect(() => bus.fail('', { agentId: '', task: '', error: '' })).toThrow('agentId must be a non-empty string');
    });
  });

  describe('one-shot cleanup', () => {
    it('removes subscriptions after complete event', () => {
      bus.subscribe('parent-1', 'agent-1');
      expect(bus.hasSubscribers('agent-1')).toBe(true);

      bus.complete('agent-1', {
        agentId: 'agent-1',
        task: 'test',
        result: 'done',
        duration: 100,
      });

      expect(bus.hasSubscribers('agent-1')).toBe(false);
      expect(bus.subscriptionCount).toBe(0);
    });

    it('removes subscriptions after fail event', () => {
      bus.subscribe('parent-1', 'agent-1');
      expect(bus.hasSubscribers('agent-1')).toBe(true);

      bus.fail('agent-1', {
        agentId: 'agent-1',
        task: 'test',
        error: 'failed',
      });

      expect(bus.hasSubscribers('agent-1')).toBe(false);
      expect(bus.subscriptionCount).toBe(0);
    });

    it('listeners are NOT auto-removed (EventEmitter behavior), only subscriptions', () => {
      const completeHandler = vi.fn();
      bus.on('subagent:complete', completeHandler);

      bus.subscribe('parent-1', 'agent-1');
      bus.complete('agent-1', {
        agentId: 'agent-1',
        task: 'test',
        result: 'done',
        duration: 100,
      });

      // Subscription is cleaned up
      expect(bus.hasSubscribers('agent-1')).toBe(false);

      // But EventEmitter listeners remain (this is expected behavior)
      // The subscription cleanup is for the internal Map, not EventEmitter listeners
      expect(bus.listenerCount('subagent:complete')).toBe(1);
    });
  });

  describe('subscriptionCount', () => {
    it('returns total number of subscriptions', () => {
      bus.subscribe('parent-1', 'agent-1');
      bus.subscribe('parent-2', 'agent-1');
      bus.subscribe('parent-1', 'agent-2');

      expect(bus.subscriptionCount).toBe(3);
    });

    it('returns 0 when no subscriptions', () => {
      expect(bus.subscriptionCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Global singleton tests
// ---------------------------------------------------------------------------

describe('pushCompletionBus singleton', () => {
  it('exports a shared singleton instance', () => {
    expect(pushCompletionBus).toBeInstanceOf(PushCompletionBus);
    expect(pushCompletionBus).toBeInstanceOf(EventEmitter);
  });
});

// ---------------------------------------------------------------------------
// AgentSwarm integration tests
// ---------------------------------------------------------------------------

describe('AgentSwarm spawnAsync', () => {
  it('returns agentId immediately without waiting for completion', async () => {
    const brain = createMockBrain();
    const toolRegistry = createMockToolRegistry();
    const sessionManager = createMockSessionManager();
    const swarm = new AgentSwarm(brain, toolRegistry, sessionManager);

    // spawnAsync should return immediately
    const agentIdPromise = swarm.spawnAsync('test task');

    // The promise should resolve quickly with an ID
    const agentId = await agentIdPromise;
    expect(agentId).toBeDefined();
    expect(typeof agentId).toBe('string');
    expect(agentId.length).toBeGreaterThan(0);
  });

  it('emits failure event via pushCompletionBus when session creation fails', async () => {
    const brain = createMockBrain();
    const toolRegistry = createMockToolRegistry();
    const sessionManager = {
      ...createMockSessionManager(),
      getOrCreate: vi.fn().mockRejectedValue(new Error('session creation failed')),
    };
    const swarm = new AgentSwarm(brain, toolRegistry, sessionManager);

    const failHandler = vi.fn();
    pushCompletionBus.on('subagent:failed', failHandler);

    try {
      const agentId = await swarm.spawnAsync('test task');

      // Wait for the failure event
      await new Promise<void>((resolve) => {
        const checkFail = () => {
          if (failHandler.mock.calls.length > 0) {
            resolve();
          } else {
            setTimeout(checkFail, 50);
          }
        };
        setTimeout(checkFail, 500);
      });

      expect(failHandler).toHaveBeenCalled();
      const call = failHandler.mock.calls[0][0] as SubAgentFailedEvent;
      expect(call.agentId).toBe(agentId);
      expect(call.error).toContain('session creation failed');
    } finally {
      pushCompletionBus.off('subagent:failed', failHandler);
    }
  });
});

describe('AgentSwarm spawn backward compatibility', () => {
  it('spawn() emits failure event via pushCompletionBus on session creation failure', async () => {
    const brain = createMockBrain();
    const toolRegistry = createMockToolRegistry();
    const sessionManager = {
      ...createMockSessionManager(),
      getOrCreate: vi.fn().mockRejectedValue(new Error('session unavailable')),
    };
    const swarm = new AgentSwarm(brain, toolRegistry, sessionManager);

    // Subscribe BEFORE spawning to ensure we catch the event
    const failHandler = vi.fn();
    pushCompletionBus.on('subagent:failed', failHandler);

    try {
      // spawn() should reject when session creation fails
      await expect(swarm.spawn('test task')).rejects.toThrow('session unavailable');

      // The event should have been fired synchronously in this case
      // because the error happens before the async queue operation
      expect(failHandler).toHaveBeenCalled();
    } finally {
      pushCompletionBus.off('subagent:failed', failHandler);
    }
  });

  it('spawnMany() rejects when session creation fails', async () => {
    const brain = createMockBrain();
    const toolRegistry = createMockToolRegistry();
    const sessionManager = {
      ...createMockSessionManager(),
      getOrCreate: vi.fn().mockRejectedValue(new Error('session unavailable')),
    };
    const swarm = new AgentSwarm(brain, toolRegistry, sessionManager);

    await expect(swarm.spawnMany(['task 1', 'task 2'])).rejects.toThrow('session unavailable');
  });
});
