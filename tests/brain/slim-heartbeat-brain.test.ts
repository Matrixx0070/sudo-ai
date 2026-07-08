/**
 * @file slim-heartbeat-brain.test.ts
 * @description Brain.call() system-prompt selection under
 * BrainRequest.promptMode 'slim-heartbeat':
 *
 *  SHB-1  promptMode 'slim-heartbeat' → _callSingleModel receives the minimal
 *         heartbeat prompt (protocol present, full-prompt blocks absent)
 *  SHB-2  no promptMode → the full assembled prompt as before
 *  SHB-3  slim builder throws → fail-open to the full prompt
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const slimThrow = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../src/core/brain/system-prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/brain/system-prompt.js')>();
  return {
    ...actual,
    assembleSlimHeartbeatPrompt: (): string => {
      if (slimThrow.enabled) throw new Error('boom (test)');
      return actual.assembleSlimHeartbeatPrompt();
    },
  };
});

import { Brain } from '../../src/core/brain/brain.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

const PRIMARY = 'ollama/deepseek-v4-pro:cloud'; // === DEFAULT_MODEL for Brain(null)

function profile(id: string, priority = 0): ModelProfile {
  const slash = id.indexOf('/');
  return {
    id,
    provider: id.slice(0, slash) as ModelProfile['provider'],
    modelId: id.slice(slash + 1),
    priority,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveErrors: 0,
    disabled: false,
  };
}

function makeBrain() {
  const brain = new Brain(null);
  (brain as any).failover.getCloudProfiles = vi.fn().mockReturnValue([profile(PRIMARY)]);
  const callSingleModel = vi.fn().mockImplementation(async (p: ModelProfile) => ({
    content: 'HEARTBEAT_OK',
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0 },
    model: p.id,
    finishReason: 'stop' as const,
  }));
  (brain as any)._callSingleModel = callSingleModel;
  (brain as any).failover.getNextProfile = vi.fn().mockReturnValue(profile(PRIMARY));
  (brain as any).failover.recordError = vi.fn();
  (brain as any).failover.recordSuccess = vi.fn();
  return { brain, callSingleModel };
}

/** The systemPrompt is _callSingleModel's 3rd positional argument. */
function capturedSystemPrompt(callSingleModel: ReturnType<typeof vi.fn>): string {
  expect(callSingleModel).toHaveBeenCalled();
  return callSingleModel.mock.calls[0]![2] as string;
}

const MESSAGES = [{ role: 'user' as const, content: '[HEARTBEAT] tick — run due checks' }];

describe('Brain.call promptMode slim-heartbeat', () => {
  beforeEach(() => {
    slimThrow.enabled = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    slimThrow.enabled = false;
  });

  it('SHB-1: slim-heartbeat → minimal prompt, no full-prompt blocks, no RAG', async () => {
    const { brain, callSingleModel } = makeBrain();
    const retrieveContext = vi.fn(async () => 'rag context that must not be fetched');
    brain.setRAGEngine({ retrieveContext } as any);

    await brain.call({ messages: MESSAGES, promptMode: 'slim-heartbeat' });

    const sys = capturedSystemPrompt(callSingleModel);
    expect(sys).toContain('Heartbeat Protocol');
    expect(sys).toContain('HEARTBEAT_OK');
    expect(sys.length).toBeLessThan(3_000);
    // Full-prompt-only blocks must be absent.
    expect(sys).not.toContain('Operating Principles');
    expect(sys).not.toContain('Playbooks');
    expect(sys).not.toContain('TOOL-USE INSTRUCTION');
    // RAG retrieval skipped entirely on slim turns.
    expect(retrieveContext).not.toHaveBeenCalled();
  });

  it('SHB-2: no promptMode → the full assembled prompt', async () => {
    const { brain, callSingleModel } = makeBrain();

    await brain.call({ messages: MESSAGES });

    const sys = capturedSystemPrompt(callSingleModel);
    expect(sys).toContain('Operating Principles');
    expect(sys).not.toContain('Heartbeat Protocol');
  });

  it('SHB-3: slim builder throws → fail-open to the full prompt', async () => {
    slimThrow.enabled = true;
    const { brain, callSingleModel } = makeBrain();

    await brain.call({ messages: MESSAGES, promptMode: 'slim-heartbeat' });

    const sys = capturedSystemPrompt(callSingleModel);
    expect(sys).toContain('Operating Principles');
  });
});
