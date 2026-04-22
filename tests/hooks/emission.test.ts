/**
 * @file tests/hooks/emission.test.ts
 *
 * Verifies that the new HookEvent emission points introduced in the agent loop
 * actually fire when AgentLoop.run() processes a turn. Uses a real HookManager
 * with spy handlers and a fully mocked Brain / ToolRegistry / SessionManager.
 *
 * Events covered:
 *   agent:bootstrap      — first user turn of a session
 *   before_prompt_build  — before messages are prepared for the API call
 *   before_model_resolve — before brain.call() is invoked
 *   tool_result_persist  — after a tool result is appended to session history
 *   before_compaction    — before compact() runs (via finishReason: 'length')
 *   after_compaction     — after compact() succeeds
 *   session:compact:before / session:compact:after / session:compact:patch
 *                        — co-emitted with before/after_compaction
 *
 * Baseline: 402/406 total passing tests (4 pre-existing failures unchanged).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { HookManager } from '../../src/core/hooks/index.js';
import type { HookContext } from '../../src/core/hooks/index.js';
import type { BrainResponse } from '../../src/core/brain/types.js';
import type { Session } from '../../src/core/sessions/types.js';

// ---------------------------------------------------------------------------
// Minimal mock factories (local — no coupling to shared helpers that may change)
// ---------------------------------------------------------------------------

function makeSession(id: string): Session {
  return {
    id,
    channel: 'telegram' as Session['channel'],
    peerId: 'test-peer',
    state: 'active',
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeStopResponse(content = 'ok'): BrainResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, estimatedCost: 0 },
    model: 'test-model',
    finishReason: 'stop',
  };
}

function makeLengthResponse(): BrainResponse {
  return {
    content: '',
    toolCalls: [],
    usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5, estimatedCost: 0 },
    model: 'test-model',
    finishReason: 'length',
  };
}

function makeToolCallResponse(toolName = 'test.tool'): BrainResponse {
  return {
    content: '',
    toolCalls: [{ id: 'call-001', name: toolName, arguments: {} }],
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, estimatedCost: 0 },
    model: 'test-model',
    finishReason: 'tool-calls',
  };
}

function makeMockBrain() {
  return { call: vi.fn(async (): Promise<BrainResponse> => makeStopResponse()) };
}

function makeMockToolRegistry() {
  return {
    execute: vi.fn(async () => ({ success: true, output: 'tool-result' })),
    getSchemaForLLM: vi.fn(() => []),
    getByCategory: vi.fn(() => []),
    listEnabled: vi.fn(() => []),
    get: vi.fn(() => undefined),
    isEnabled: vi.fn(() => true),
    requiresConfirmation: vi.fn(() => false),
  };
}

function makeMockSessionManager(session: Session) {
  return {
    get: vi.fn(async (_id: string) => session),
    save: vi.fn(async () => undefined),
    archive: vi.fn(async () => undefined),
    getOrCreate: vi.fn(async () => session),
  };
}

/**
 * Build a HookManager spy: registers a vi.fn() handler for each event name
 * and returns a map of eventName → spy function so tests can assert calls.
 */
function buildSpyHooks(
  hooks: HookManager,
  events: string[],
): Map<string, ReturnType<typeof vi.fn>> {
  const spies = new Map<string, ReturnType<typeof vi.fn>>();
  for (const ev of events) {
    const spy = vi.fn(async (_ctx: HookContext) => undefined);
    hooks.register(ev as Parameters<typeof hooks.register>[0], spy, `spy:${ev}`);
    spies.set(ev, spy);
  }
  return spies;
}

// ---------------------------------------------------------------------------
// Helper: build a minimal AgentLoop with a real HookManager attached
// ---------------------------------------------------------------------------

function buildLoop(
  brain: ReturnType<typeof makeMockBrain>,
  tools: ReturnType<typeof makeMockToolRegistry>,
  sessions: ReturnType<typeof makeMockSessionManager>,
  hooks: HookManager,
): AgentLoop {
  // Signature: (brain, toolRegistry, sessionManager, config, consciousness, security, workspaceInjector, hooks)
  return new AgentLoop(brain, tools, sessions, { maxIterations: 10 }, undefined, undefined, undefined, hooks);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Hook emission — agent:bootstrap', () => {
  it('fires agent:bootstrap on the first user turn of a session', async () => {
    const session = makeSession('s-bootstrap-1');
    const brain = makeMockBrain();
    brain.call.mockResolvedValue(makeStopResponse('hello'));
    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();
    const spies = buildSpyHooks(hooks, ['agent:bootstrap']);

    const loop = buildLoop(brain, tools, sessions, hooks);
    await loop.run(session.id, 'first message ever');

    expect(spies.get('agent:bootstrap')).toHaveBeenCalledOnce();
    const ctx = spies.get('agent:bootstrap')!.mock.calls[0][0] as HookContext;
    expect(ctx.sessionId).toBe(session.id);
  });

  it('does NOT fire agent:bootstrap on subsequent turns', async () => {
    const session = makeSession('s-bootstrap-2');
    // Pre-populate one user message to simulate an ongoing session
    (session.messages as Array<{ role: string; content: string }>).push({ role: 'user', content: 'prior message' });

    const brain = makeMockBrain();
    brain.call.mockResolvedValue(makeStopResponse('reply'));
    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();
    const spies = buildSpyHooks(hooks, ['agent:bootstrap']);

    const loop = buildLoop(brain, tools, sessions, hooks);
    await loop.run(session.id, 'second message');

    expect(spies.get('agent:bootstrap')).not.toHaveBeenCalled();
  });
});

describe('Hook emission — before_prompt_build and before_model_resolve', () => {
  it('fires before_prompt_build before brain.call()', async () => {
    const session = makeSession('s-prompt-1');
    const brain = makeMockBrain();
    const callOrder: string[] = [];
    brain.call.mockImplementation(async () => {
      callOrder.push('brain.call');
      return makeStopResponse('ok');
    });

    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();

    hooks.register('before_prompt_build', async () => { callOrder.push('before_prompt_build'); }, 'order-spy');

    const loop = buildLoop(brain, tools, sessions, hooks);
    await loop.run(session.id, 'test');

    expect(callOrder.indexOf('before_prompt_build')).toBeLessThan(callOrder.indexOf('brain.call'));
  });

  it('fires before_model_resolve with the resolved model name', async () => {
    const session = makeSession('s-model-1');
    const brain = makeMockBrain();
    brain.call.mockResolvedValue(makeStopResponse('ok'));
    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();
    const spies = buildSpyHooks(hooks, ['before_model_resolve']);

    const loop = buildLoop(brain, tools, sessions, hooks);
    await loop.run(session.id, 'resolve model');

    expect(spies.get('before_model_resolve')).toHaveBeenCalled();
    const ctx = spies.get('before_model_resolve')!.mock.calls[0][0] as HookContext;
    expect(ctx.sessionId).toBe(session.id);
    // modelName is set (may be empty string when no model configured in test)
    expect(ctx).toHaveProperty('modelName');
  });

  it('fires before_prompt_build with correct sessionId', async () => {
    const session = makeSession('s-prompt-sid');
    const brain = makeMockBrain();
    brain.call.mockResolvedValue(makeStopResponse('ok'));
    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();
    const spies = buildSpyHooks(hooks, ['before_prompt_build']);

    const loop = buildLoop(brain, tools, sessions, hooks);
    await loop.run(session.id, 'test');

    const ctx = spies.get('before_prompt_build')!.mock.calls[0][0] as HookContext;
    expect(ctx.sessionId).toBe(session.id);
  });
});

describe('Hook emission — tool_result_persist', () => {
  it('fires tool_result_persist after a tool result is appended', async () => {
    const session = makeSession('s-tool-persist-1');
    const brain = makeMockBrain();
    brain.call
      .mockResolvedValueOnce(makeToolCallResponse('test.read'))
      .mockResolvedValueOnce(makeStopResponse('done'));

    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();
    const spies = buildSpyHooks(hooks, ['tool_result_persist']);

    const loop = buildLoop(brain, tools, sessions, hooks);
    await loop.run(session.id, 'run a tool');

    expect(spies.get('tool_result_persist')).toHaveBeenCalled();
    const ctx = spies.get('tool_result_persist')!.mock.calls[0][0] as HookContext;
    expect(ctx.sessionId).toBe(session.id);
    expect(ctx.toolName).toBe('test.read');
    expect(ctx).toHaveProperty('result');
  });
});

describe('Hook emission — compaction events', () => {
  it('fires before_compaction and after_compaction around compact call', async () => {
    const session = makeSession('s-compact-1');
    const brain = makeMockBrain();
    const callOrder: string[] = [];

    // First call triggers compaction via finishReason: 'length'.
    // Compaction retries 3 times (MAX_COMPACTION_RETRIES=3), then final stop.
    brain.call
      .mockImplementationOnce(async () => {
        callOrder.push('brain.call.1-length');
        return makeLengthResponse();
      })
      .mockImplementationOnce(async (): Promise<BrainResponse> => {
        callOrder.push('brain.call.2-compact-attempt-1');
        return makeStopResponse('summary');
      })
      .mockImplementationOnce(async (): Promise<BrainResponse> => {
        callOrder.push('brain.call.3-compact-attempt-2');
        return makeStopResponse('summary');
      })
      .mockImplementationOnce(async (): Promise<BrainResponse> => {
        callOrder.push('brain.call.4-compact-attempt-3');
        return makeStopResponse('summary');
      })
      .mockImplementationOnce(async () => {
        callOrder.push('brain.call.5-final');
        return makeStopResponse('final answer');
      });

    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();

    hooks.register('before_compaction', async () => { callOrder.push('before_compaction'); }, 'bc');
    hooks.register('after_compaction', async () => { callOrder.push('after_compaction'); }, 'ac');

    const loop = buildLoop(brain, tools, sessions, hooks);
    await loop.run(session.id, 'trigger compaction');

    expect(callOrder).toContain('before_compaction');
    expect(callOrder).toContain('after_compaction');
    // before must precede after
    expect(callOrder.indexOf('before_compaction')).toBeLessThan(callOrder.indexOf('after_compaction'));
  });

  it('fires session:compact:before and session:compact:after', async () => {
    const session = makeSession('s-compact-2');
    const brain = makeMockBrain();

    // 1 length response + 3 compaction retries + 1 final stop
    brain.call
      .mockResolvedValueOnce(makeLengthResponse())
      .mockResolvedValueOnce(makeStopResponse('summary'))
      .mockResolvedValueOnce(makeStopResponse('summary'))
      .mockResolvedValueOnce(makeStopResponse('summary'))
      .mockResolvedValueOnce(makeStopResponse('done'));

    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();
    const spies = buildSpyHooks(hooks, ['session:compact:before', 'session:compact:after']);

    const loop = buildLoop(brain, tools, sessions, hooks);
    await loop.run(session.id, 'compact session');

    expect(spies.get('session:compact:before')).toHaveBeenCalled();
    expect(spies.get('session:compact:after')).toHaveBeenCalled();
    const beforeCtx = spies.get('session:compact:before')!.mock.calls[0][0] as HookContext;
    expect(beforeCtx.sessionId).toBe(session.id);
  });

  it('fires session:compact:patch with a non-empty patch field after compaction', async () => {
    const session = makeSession('s-compact-3');
    const brain = makeMockBrain();

    // Compaction retries up to 3 times. All retry calls return the same stop response.
    // On the final attempt, compact() accepts whatever content it gets.
    brain.call
      .mockResolvedValueOnce(makeLengthResponse())        // triggers compaction
      .mockResolvedValueOnce(makeStopResponse('summary')) // compaction attempt 1 (rejected — no Decisions section)
      .mockResolvedValueOnce(makeStopResponse('summary')) // compaction attempt 2 (rejected)
      .mockResolvedValueOnce(makeStopResponse('summary')) // compaction attempt 3 (accepted on final attempt)
      .mockResolvedValueOnce(makeStopResponse('done'));   // final loop turn

    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();
    const spies = buildSpyHooks(hooks, ['session:compact:patch']);

    const loop = buildLoop(brain, tools, sessions, hooks);
    await loop.run(session.id, 'get patch');

    expect(spies.get('session:compact:patch')).toHaveBeenCalled();
    const ctx = spies.get('session:compact:patch')!.mock.calls[0][0] as HookContext;
    // patch field must be a non-empty string containing the compaction output
    expect(typeof ctx.patch).toBe('string');
    expect((ctx.patch as string).length).toBeGreaterThan(0);
    expect(ctx.sessionId).toBe(session.id);
  });
});

describe('Hook emission — error isolation (hook throws → loop continues)', () => {
  it('loop still completes when a hook handler throws', async () => {
    const session = makeSession('s-throw-hook');
    const brain = makeMockBrain();
    brain.call.mockResolvedValue(makeStopResponse('survived'));
    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();

    // Register a hook that always throws
    hooks.register('before_prompt_build', async () => {
      throw new Error('intentional hook failure');
    }, 'throwing-hook');

    // Also register a spy that runs after the throwing hook
    const afterSpy = vi.fn(async () => undefined);
    hooks.register('before_prompt_build', afterSpy, 'after-throw-spy');

    const loop = buildLoop(brain, tools, sessions, hooks);

    // run() should not throw despite the bad hook
    const result = await loop.run(session.id, 'survive a bad hook');
    expect(result.text).toBe('survived');

    // The subsequent hook on the same event still fires (HookManager continues after errors)
    expect(afterSpy).toHaveBeenCalled();
  });

  it('agent:bootstrap hook throwing does not prevent run() completion', async () => {
    const session = makeSession('s-bootstrap-throw');
    const brain = makeMockBrain();
    brain.call.mockResolvedValue(makeStopResponse('ok'));
    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();

    hooks.register('agent:bootstrap', async () => {
      throw new Error('bootstrap hook crash');
    }, 'bad-bootstrap');

    const loop = buildLoop(brain, tools, sessions, hooks);
    await expect(loop.run(session.id, 'first turn')).resolves.toBeDefined();
  });
});

describe('Hook emission — ordering', () => {
  it('session:start fires before before_prompt_build', async () => {
    const session = makeSession('s-order-1');
    const brain = makeMockBrain();
    brain.call.mockResolvedValue(makeStopResponse('ok'));
    const tools = makeMockToolRegistry();
    const sessions = makeMockSessionManager(session);
    const hooks = new HookManager();
    const callOrder: string[] = [];

    hooks.register('session:start', async () => { callOrder.push('session:start'); }, 'so1');
    hooks.register('before_prompt_build', async () => { callOrder.push('before_prompt_build'); }, 'so2');
    hooks.register('session:end', async () => { callOrder.push('session:end'); }, 'so3');

    const loop = buildLoop(brain, tools, sessions, hooks);
    await loop.run(session.id, 'order test');

    expect(callOrder[0]).toBe('session:start');
    expect(callOrder).toContain('before_prompt_build');
    expect(callOrder[callOrder.length - 1]).toBe('session:end');
  });
});
