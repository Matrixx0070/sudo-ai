/**
 * Unit tests for AgentLoop.
 * Brain, ToolRegistry, and SessionManager are all mocked.
 * No real LLM calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../../../src/core/agent/loop.js';
import { PipelineError } from '../../../src/core/shared/errors.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
  createMockConsciousnessOrchestrator,
} from '../../helpers/mocks.js';
import type { BrainResponse } from '../../../src/core/brain/types.js';
import type { Session } from '../../../src/core/sessions/types.js';

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStopResponse(content = 'done'): BrainResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast',
    finishReason: 'stop',
  };
}

function makeToolCallResponse(toolName = 'system.hello'): BrainResponse {
  return {
    content: '',
    toolCalls: [{ id: 'call-123', name: toolName, arguments: {} }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast',
    finishReason: 'tool-calls',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop — construction', () => {
  it('constructs successfully with valid dependencies', () => {
    const brain = createMockBrain();
    const tools = createMockToolRegistry();
    const sessions = createMockSessionManager();

    const sandboxManager = createMockSandboxManager();

    expect(() => new AgentLoop(brain, tools, sessions, {}, undefined, undefined, undefined, undefined, sandboxManager)).not.toThrow();
  });

  it('throws PipelineError when brain is null', () => {
    const tools = createMockToolRegistry();
    const sessions = createMockSessionManager();
    const sandboxManager = createMockSandboxManager();

    expect(() => new AgentLoop(null, tools, sessions, {}, undefined, undefined, undefined, undefined, sandboxManager)).toThrow(PipelineError);
  });

  it('throws PipelineError when brain has no call() method', () => {
    const tools = createMockToolRegistry();
    const sessions = createMockSessionManager();
    const sandboxManager = createMockSandboxManager();

    expect(() => new AgentLoop({}, tools, sessions, {}, undefined, undefined, undefined, undefined, sandboxManager)).toThrow(PipelineError);
  });

  it('throws PipelineError when toolRegistry is null', () => {
    const brain = createMockBrain();
    const sessions = createMockSessionManager();
    const sandboxManager = createMockSandboxManager();

    expect(() => new AgentLoop(brain, null, sessions, {}, undefined, undefined, undefined, undefined, sandboxManager)).toThrow(PipelineError);
  });

  it('throws PipelineError when toolRegistry has no execute() method', () => {
    const brain = createMockBrain();
    const sessions = createMockSessionManager();
    const sandboxManager = createMockSandboxManager();

    expect(() => new AgentLoop(brain, {}, sessions, {}, undefined, undefined, undefined, undefined, sandboxManager)).toThrow(PipelineError);
  });

  it('throws PipelineError when sessionManager is null', () => {
    const brain = createMockBrain();
    const tools = createMockToolRegistry();
    expect(() => new AgentLoop(brain, tools, null)).toThrow(PipelineError);
  });

  it('resolvedConfig reflects default maxIterations', () => {
    const brain = createMockBrain();
    const tools = createMockToolRegistry();
    const sessions = createMockSessionManager();
    const sandboxManager = createMockSandboxManager();
    const loop = new AgentLoop(brain, tools, sessions, {}, undefined, undefined, undefined, undefined, sandboxManager);
    expect(loop.resolvedConfig.maxIterations).toBeGreaterThan(0);
  });

  it('resolvedConfig uses provided config override', () => {
    const brain = createMockBrain();
    const tools = createMockToolRegistry();
    const sessions = createMockSessionManager();
    const sandboxManager = createMockSandboxManager();
    const loop = new AgentLoop(brain, tools, sessions, { maxIterations: 5 }, undefined, undefined, undefined, undefined, sandboxManager);
    expect(loop.resolvedConfig.maxIterations).toBe(5);
  });

  it('accepts consciousness argument conforming to ConsciousnessLike', () => {
    const brain = createMockBrain();
    const tools = createMockToolRegistry();
    const sessions = createMockSessionManager();
    const consciousness = createMockConsciousnessOrchestrator();
    const sandboxManager = createMockSandboxManager();
    expect(() => new AgentLoop(brain, tools, sessions, {}, consciousness, undefined, undefined, undefined, sandboxManager)).not.toThrow();
  });
});

describe('AgentLoop — run() validation', () => {
  let loop: AgentLoop;
  let mockBrain: ReturnType<typeof createMockBrain>;
  let mockSessions: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    mockBrain = createMockBrain();
    const tools = createMockToolRegistry();
    mockSessions = createMockSessionManager();
    const sandboxManager = createMockSandboxManager();
    loop = new AgentLoop(mockBrain, tools, mockSessions, { maxIterations: 10 }, undefined, undefined, undefined, undefined, sandboxManager);
  });

  it('throws PipelineError when sessionId is empty', async () => {
    await expect(loop.run('', 'hello')).rejects.toThrow(PipelineError);
  });

  it('throws PipelineError when message is empty', async () => {
    await expect(loop.run('test-session-id', '')).rejects.toThrow(PipelineError);
  });

  it('throws PipelineError when session is not found', async () => {
    mockSessions.get.mockResolvedValue(undefined);
    await expect(loop.run('ghost-session', 'hello')).rejects.toThrow(PipelineError);
  });

  it('throws PipelineError with code pipeline_session_not_found when session missing', async () => {
    mockSessions.get.mockResolvedValue(undefined);
    try {
      await loop.run('ghost-session', 'hello');
    } catch (e) {
      expect((e as PipelineError).code).toBe('pipeline_session_not_found');
    }
  });
});

describe('AgentLoop — run() success', () => {
  let loop: AgentLoop;
  let mockBrain: ReturnType<typeof createMockBrain>;
  let mockSessions: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    mockBrain = createMockBrain();
    const tools = createMockToolRegistry();
    mockSessions = createMockSessionManager();
    const sandboxManager = createMockSandboxManager();
    loop = new AgentLoop(mockBrain, tools, mockSessions, { maxIterations: 10 }, undefined, undefined, undefined, undefined, sandboxManager);
  });

  it('returns the brain response content on a simple stop response', async () => {
    mockBrain.call.mockResolvedValue(makeStopResponse('Hello world'));
    const result = await loop.run('test-session-id', 'Say hello');
    expect(result.text).toBe('Hello world');
  });

  it('appends user message to session messages', async () => {
    mockBrain.call.mockResolvedValue(makeStopResponse('ok'));
    const session = await mockSessions.getOrCreate('telegram', 'u1');
    mockSessions.get.mockResolvedValue(session);

    await loop.run(session.id, 'Test message');
    const userMsg = session.messages.find((m) => m.role === 'user' && m.content === 'Test message');
    expect(userMsg).toBeDefined();
  });

  it('appends assistant response to session messages', async () => {
    mockBrain.call.mockResolvedValue(makeStopResponse('I am the response'));
    const session = await mockSessions.getOrCreate('telegram', 'u2');
    mockSessions.get.mockResolvedValue(session);

    await loop.run(session.id, 'hello');
    const assistantMsg = session.messages.find(
      (m) => m.role === 'assistant' && m.content === 'I am the response',
    );
    expect(assistantMsg).toBeDefined();
  });

  it('saves the session after a successful run', async () => {
    mockBrain.call.mockResolvedValue(makeStopResponse('done'));
    await loop.run('test-session-id', 'hello');
    expect(mockSessions.save).toHaveBeenCalled();
  });

  it('emits a done event via onEvent callback', async () => {
    mockBrain.call.mockResolvedValue(makeStopResponse('done'));
    const events: string[] = [];
    await loop.run('test-session-id', 'hello', (e) => { events.push(e.type); });
    expect(events).toContain('done');
  });

  it('emits a message event with user content', async () => {
    mockBrain.call.mockResolvedValue(makeStopResponse('done'));
    const events: Array<{ type: string; content?: string }> = [];
    await loop.run('test-session-id', 'user input here', (e) => {
      events.push(e as typeof events[0]);
    });
    const msgEvent = events.find((e) => e.type === 'message' && e.content === 'user input here');
    expect(msgEvent).toBeDefined();
  });
});

describe('AgentLoop — tool-call handling', () => {
  it('executes a tool call and continues to stop', async () => {
    const mockBrain = createMockBrain();
    const mockTools = createMockToolRegistry();
    const mockSessions = createMockSessionManager();

    // First call returns tool-calls, second returns stop
    mockBrain.call
      .mockResolvedValueOnce(makeToolCallResponse('system.hello'))
      .mockResolvedValueOnce(makeStopResponse('all done'));

    mockTools.execute.mockResolvedValue({ success: true, output: 'tool ran' });

    const sandboxManager = createMockSandboxManager();
    const loop = new AgentLoop(mockBrain, mockTools, mockSessions, { maxIterations: 10 }, undefined, undefined, undefined, undefined, sandboxManager);
    const result = await loop.run('test-session-id', 'run a tool');
    expect(result.text).toBe('all done');
  });

  it('handles content-filter finish reason without throwing', async () => {
    const mockBrain = createMockBrain();
    const mockTools = createMockToolRegistry();
    const mockSessions = createMockSessionManager();

    mockBrain.call.mockResolvedValue({
      content: '',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, estimatedCost: 0 },
      model: 'xai/grok-3-fast',
      finishReason: 'content-filter',
    });

    const sandboxManager = createMockSandboxManager();
    const loop = new AgentLoop(mockBrain, mockTools, mockSessions, { maxIterations: 10 }, undefined, undefined, undefined, undefined, sandboxManager);
    const errors: string[] = [];
    await loop.run('test-session-id', 'test', (e) => {
      if (e.type === 'error') errors.push(e.error);
    });
    expect(errors).toContain('Response blocked by content filter');
  });
});

describe('AgentLoop — max iterations guard', () => {
  it('throws PipelineError when max iterations is reached', async () => {
    const mockBrain = createMockBrain();
    const mockTools = createMockToolRegistry();
    const mockSessions = createMockSessionManager();

    // Always return tool-calls to exhaust iterations
    mockBrain.call.mockResolvedValue(makeToolCallResponse('system.loop'));
    mockTools.execute.mockResolvedValue({ success: true, output: 'looped' });

    const sandboxManager = createMockSandboxManager();
    const loop = new AgentLoop(mockBrain, mockTools, mockSessions, { maxIterations: 3 }, undefined, undefined, undefined, undefined, sandboxManager);

    await expect(loop.run('test-session-id', 'loop forever')).rejects.toThrow(PipelineError);
  });

  it('throws PipelineError with code pipeline_max_iterations when limit reached', async () => {
    const mockBrain = createMockBrain();
    const mockTools = createMockToolRegistry();
    const mockSessions = createMockSessionManager();

    mockBrain.call.mockResolvedValue(makeToolCallResponse('system.loop'));
    mockTools.execute.mockResolvedValue({ success: true, output: 'looped' });

    const sandboxManager = createMockSandboxManager();
    const loop = new AgentLoop(mockBrain, mockTools, mockSessions, { maxIterations: 2 }, undefined, undefined, undefined, undefined, sandboxManager);

    try {
      await loop.run('test-session-id', 'loop');
    } catch (e) {
      expect((e as PipelineError).code).toBe('pipeline_max_iterations');
    }
  });
});

describe('AgentLoop — consciousness integration', () => {
  it('calls onInteractionStart when consciousness is attached', async () => {
    const mockBrain = createMockBrain();
    const mockTools = createMockToolRegistry();
    const mockSessions = createMockSessionManager();
    const consciousness = createMockConsciousnessOrchestrator();
    const sandboxManager = createMockSandboxManager();

    mockBrain.call.mockResolvedValue(makeStopResponse('done'));

    const loop = new AgentLoop(mockBrain, mockTools, mockSessions, {}, consciousness, undefined, undefined, undefined, sandboxManager);
    await loop.run('test-session-id', 'hello');

    expect(consciousness.onInteractionStart).toHaveBeenCalledWith('test-session-id', 'hello');
  });

  it('calls onInteractionEnd when consciousness is attached', async () => {
    const mockBrain = createMockBrain();
    const mockTools = createMockToolRegistry();
    const mockSessions = createMockSessionManager();
    const consciousness = createMockConsciousnessOrchestrator();
    const sandboxManager = createMockSandboxManager();

    mockBrain.call.mockResolvedValue(makeStopResponse('done'));

    const loop = new AgentLoop(mockBrain, mockTools, mockSessions, {}, consciousness, undefined, undefined, undefined, sandboxManager);
    await loop.run('test-session-id', 'hello');

    expect(consciousness.onInteractionEnd).toHaveBeenCalled();
  });
});
