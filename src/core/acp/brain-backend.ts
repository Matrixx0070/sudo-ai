/**
 * @file acp/brain-backend.ts
 * @description ACP backend that drives sudo-ai's multi-provider Brain.
 *
 * Slice 1 is chat-only: each session/prompt runs ONE streamed Brain completion
 * over the session's running message history. Tools / agent-loop, fs + terminal
 * delegation, session/load, and permission round-trips are follow-up slices.
 *
 * The Brain is duck-typed ({@link AcpBrain}) so this is unit-testable with a
 * stub async generator — no provider keys or boot required in tests.
 */

import { randomUUID } from 'node:crypto';
import type { AcpBackend } from './acp-server.js';
import type { NewSessionParams, StopReason } from './types.js';

/** Minimal slice of Brain.stream() this backend depends on. */
export interface AcpBrain {
  stream(request: {
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
    stream?: boolean;
    model?: string;
  }): AsyncGenerator<string>;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Bound per-session history so a long-lived editor session can't grow memory
 * without limit. FIFO-trims the oldest turns (best-effort context retention).
 */
const MAX_HISTORY_MESSAGES = 400;

export class BrainAcpBackend implements AcpBackend {
  private readonly histories = new Map<string, ChatMessage[]>();
  private readonly brain: AcpBrain;
  private readonly model: string | undefined;

  constructor(brain: AcpBrain, model?: string) {
    this.brain = brain;
    this.model = model;
  }

  createSession(_params: NewSessionParams): string {
    const id = `acp_${randomUUID()}`;
    this.histories.set(id, []);
    return id;
  }

  async prompt(args: {
    sessionId: string;
    text: string;
    onChunk: (text: string) => void;
    signal: AbortSignal;
  }): Promise<StopReason> {
    const history = this.histories.get(args.sessionId) ?? [];
    history.push({ role: 'user', content: args.text });

    const request = {
      messages: history.slice(),
      stream: true as const,
      ...(this.model ? { model: this.model } : {}),
    };

    let assistant = '';
    let cancelled = false;
    // Cancellation is best-effort between chunks — a single in-flight chunk is
    // not interrupted (true mid-request abort needs Brain-level signal support).
    for await (const chunk of this.brain.stream(request)) {
      if (args.signal.aborted) {
        cancelled = true;
        break;
      }
      assistant += chunk;
      args.onChunk(chunk);
    }

    // Persist whatever was produced so session context survives even a cancel.
    if (assistant.length > 0) history.push({ role: 'assistant', content: assistant });
    if (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, history.length - MAX_HISTORY_MESSAGES);
    }
    this.histories.set(args.sessionId, history);

    return cancelled ? 'cancelled' : 'end_turn';
  }
}
