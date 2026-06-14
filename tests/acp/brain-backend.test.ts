/**
 * Tests for the Brain-backed ACP backend with a stub Brain (no provider keys).
 */

import { describe, it, expect } from 'vitest';
import { BrainAcpBackend, type AcpBrain } from '../../src/core/acp/brain-backend.js';

/** A stub Brain that yields the given chunks and records the last request. */
function stubBrain(chunks: string[]): AcpBrain & { lastRequest?: { messages: Array<{ role: string; content: string }>; model?: string } } {
  const brain = {
    lastRequest: undefined as { messages: Array<{ role: string; content: string }>; model?: string } | undefined,
    async *stream(request: { messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>; model?: string }) {
      brain.lastRequest = request;
      for (const c of chunks) yield c;
    },
  };
  return brain;
}

describe('BrainAcpBackend', () => {
  it('creates a session id', () => {
    const backend = new BrainAcpBackend(stubBrain([]));
    const id = backend.createSession({});
    expect(typeof id).toBe('string');
    expect(id.startsWith('acp_')).toBe(true);
  });

  it('streams chunks via onChunk and returns end_turn', async () => {
    const backend = new BrainAcpBackend(stubBrain(['Hel', 'lo']));
    const sessionId = backend.createSession({});
    const seen: string[] = [];

    const stop = await backend.prompt({
      sessionId,
      text: 'hi',
      onChunk: (c) => seen.push(c),
      signal: new AbortController().signal,
    });

    expect(stop).toBe('end_turn');
    expect(seen).toEqual(['Hel', 'lo']);
  });

  it('carries prior turns into the next prompt request', async () => {
    const brain = stubBrain(['ok']);
    const backend = new BrainAcpBackend(brain);
    const sessionId = backend.createSession({});
    const noop = () => { /* */ };
    const sig = new AbortController().signal;

    await backend.prompt({ sessionId, text: 'first', onChunk: noop, signal: sig });
    await backend.prompt({ sessionId, text: 'second', onChunk: noop, signal: sig });

    const roles = brain.lastRequest!.messages.map((m) => `${m.role}:${m.content}`);
    expect(roles).toEqual(['user:first', 'assistant:ok', 'user:second']);
  });

  it('passes a pinned model through to the Brain request', async () => {
    const brain = stubBrain(['x']);
    const backend = new BrainAcpBackend(brain, 'openai/gpt-4o');
    const sessionId = backend.createSession({});
    await backend.prompt({ sessionId, text: 'hi', onChunk: () => {}, signal: new AbortController().signal });
    expect(brain.lastRequest!.model).toBe('openai/gpt-4o');
  });

  it('returns cancelled when the signal is already aborted', async () => {
    const backend = new BrainAcpBackend(stubBrain(['a', 'b', 'c']));
    const sessionId = backend.createSession({});
    const ctrl = new AbortController();
    ctrl.abort();
    const seen: string[] = [];

    const stop = await backend.prompt({
      sessionId,
      text: 'hi',
      onChunk: (c) => seen.push(c),
      signal: ctrl.signal,
    });

    expect(stop).toBe('cancelled');
    // The abort is checked before forwarding the first chunk.
    expect(seen).toEqual([]);
  });
});
