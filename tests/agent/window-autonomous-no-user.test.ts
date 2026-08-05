/**
 * Regression for the 2026-08-04 "all providers unavailable" outage. An
 * autonomous (system-event-seeded) session can contain NO user message at all;
 * once the sliding window filled with assistant/tool traffic, the outbound
 * conversation had no user turn. ollama's glm-5.2:cloud silently sheds that
 * shape (HTTP 200, finish_reason 'load', zero usage) and gemini rejects it as
 * invalid_request — every profile cooled down and the turn died.
 *
 * prepareMessages must synthesize a user instruction when none exists.
 */

import { describe, it, expect, vi } from 'vitest';
import { prepareMessages } from '../../src/core/agent/loop-helpers/prepare-messages.js';

const emit = vi.fn();
const brain = {} as never; // compaction layers don't fire on small histories

describe('sliding window — autonomous session with no user message', () => {
  it('synthesizes a user instruction when the session has none', async () => {
    const session = {
      messages: [
        { role: 'system', content: 'You are an autonomous agent. Mission: write a notebook.' },
        { role: 'assistant', content: 'working', toolCalls: [{ id: 't1', name: 'fs.write', arguments: {} }] },
        { role: 'tool', content: 'ok', toolCallId: 't1', toolName: 'fs.write' },
      ],
    };
    const out = await prepareMessages(brain, session as never, { sessionId: 's' } as never, emit);
    const userMsgs = out.filter((m) => m.role === 'user');
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(String(userMsgs[0]!.content)).toContain('[Autonomous turn]');
  });

  it('does NOT inject when a real user message is present', async () => {
    const session = {
      messages: [
        { role: 'user', content: 'do the thing' },
        { role: 'assistant', content: 'on it' },
      ],
    };
    const out = await prepareMessages(brain, session as never, { sessionId: 's' } as never, emit);
    const userMsgs = out.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.content).toBe('do the thing');
  });
});
