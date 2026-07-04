/**
 * Wiring: an OPEN BrainIdleBreaker must short-circuit brain.call() and
 * brain.stream() BEFORE any paid SDK call — that is the property that stops
 * runaway fan-out to a wedged provider. The breaker's open/close/half-open
 * logic is covered in idle-breaker.test.ts; this proves it's actually consulted
 * at the top of both entry points.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock, streamText: streamTextMock };
});

import { Brain } from '../../src/core/brain/brain.js';
import type { BrainIdleBreaker } from '../../src/core/brain/idle-breaker.js';

const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }] };

function openBreaker(brain: Brain): void {
  const breaker = (brain as unknown as { idleBreaker: BrainIdleBreaker }).idleBreaker;
  // Default threshold is 5; drive well past it so it is firmly open.
  for (let i = 0; i < 6; i++) breaker.recordIdleTimeout();
  expect(breaker.shouldBlock()).toBe(true);
}

describe('BrainIdleBreaker wiring into Brain', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
  });
  afterEach(() => {
    delete process.env['SUDO_BRAIN_IDLE_BREAKER_MAX'];
  });

  it('call() short-circuits with llm_idle_circuit_open and never invokes the SDK', async () => {
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;
    openBreaker(brain);

    await expect(brain.call(REQUEST)).rejects.toThrow(/idle circuit open/i);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('stream() short-circuits with llm_idle_circuit_open and never invokes the SDK', async () => {
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;
    openBreaker(brain);

    const gen = brain.stream(REQUEST);
    await expect(gen.next()).rejects.toThrow(/idle circuit open/i);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('a closed breaker does not block (control): the SDK path is reached', async () => {
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;
    // Breaker starts closed. call() should get past the guard and actually try
    // to resolve a model/SDK (which then fails for unrelated reasons here) — the
    // point is it must NOT throw the idle-circuit error.
    generateTextMock.mockRejectedValue(Object.assign(new Error('status 408'), { statusCode: 408 }));
    await expect(brain.call(REQUEST)).rejects.not.toThrow(/idle circuit open/i);
  });
});
