/**
 * Unit tests for TuiAgentAdapter (src/cli/commands/chat/agent-loop-adapter.ts).
 *
 * Architecture note: the adapter accumulates all chunks into yieldQueue while
 * agentLoop.run() resolves, then flushes the queue in order, and always
 * appends a terminal { type: 'done', usage: { outputTokens: N } }.
 * Tests must therefore collect the full generator output before asserting.
 *
 * Mocking strategy:
 *   - TuiAgentAdapterDeps is passed directly to the constructor.
 *   - agentLoop.run() synchronously calls onEvent(), then returns a resolved Promise.
 *   - sessionManager.getOrCreate() returns a stub session.
 *   - dispatcher events are captured via dispatcher.on().
 *
 * Cancellation design: the adapter builds abortPromise inside stream() via
 * signal.addEventListener('abort', ...). To guarantee the listener is already
 * registered when abort fires, the mock run function fires controller.abort()
 * from within its own execution — at which point the abortPromise listener is
 * already attached. The run then returns a never-resolving promise so the abort
 * wins the race.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { AgentEvent } from '../../../src/core/agent/types.js';
import type { ProviderChunk } from '../../../src/cli/commands/chat/provider.js';
import type { ToolEvent } from '../../../src/cli/commands/chat/dispatcher.js';
import { dispatcher } from '../../../src/cli/commands/chat/dispatcher.js';
import {
  TuiAgentAdapter,
  type TuiAgentAdapterDeps,
} from '../../../src/cli/commands/chat/agent-loop-adapter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Collect all yielded chunks from the adapter's stream() generator.
 */
async function collectChunks(
  adapter: TuiAgentAdapter,
  opts: { sessionId?: string; message?: string; signal?: AbortSignal } = {},
): Promise<ProviderChunk[]> {
  const controller = new AbortController();
  const chunks: ProviderChunk[] = [];
  for await (const chunk of adapter.stream({
    sessionId: opts.sessionId ?? 'test-session',
    message: opts.message ?? 'hello',
    signal: opts.signal ?? controller.signal,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Build a minimal TuiAgentAdapterDeps stub.
 * runFn receives the onEvent callback so tests can fire synthetic events.
 */
function makeAdapter(
  runFn: (
    sessionId: string,
    message: string,
    onEvent?: (event: AgentEvent) => void,
  ) => Promise<{ text: string; attachments: unknown[] }>,
): { adapter: TuiAgentAdapter; deps: TuiAgentAdapterDeps } {
  const deps: TuiAgentAdapterDeps = {
    agentLoop: { run: runFn },
    sessionManager: {
      getOrCreate: async (_channel, _peerId) => ({ id: 'sess-42' }),
    },
  };
  return { adapter: new TuiAgentAdapter(deps), deps };
}

/** Collect dispatcher events during a single test. */
function captureDispatcherEvents(): { events: ToolEvent[]; dispose: () => void } {
  const events: ToolEvent[] = [];
  const dispose = dispatcher.on((e) => events.push(e));
  return { events, dispose };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  // Individual tests dispose their own subscriptions; nothing global here.
});

// ---------------------------------------------------------------------------
// 1. Text chunk mapping
// ---------------------------------------------------------------------------

describe('TuiAgentAdapter — text chunk mapping', () => {
  it('stream-chunk event yields { type: "text", value }', async () => {
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'stream-chunk', chunk: 'hi' });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks).toContainEqual({ type: 'text', value: 'hi' });
  });

  it('message event yields { type: "text", value }', async () => {
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'message', content: 'done' });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks).toContainEqual({ type: 'text', value: 'done' });
  });

  it('preserves order: stream-chunk then message chunks yielded in order', async () => {
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'stream-chunk', chunk: 'first' });
      onEvent?.({ type: 'message', content: 'second' });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    const textValues = chunks
      .filter((c): c is Extract<ProviderChunk, { type: 'text' }> => c.type === 'text')
      .map((c) => c.value);
    expect(textValues).toEqual(['first', 'second']);
  });

  it('always yields a terminal { type: "done" } chunk as the final item', async () => {
    const { adapter } = makeAdapter(async () => ({ text: '', attachments: [] }));
    const chunks = await collectChunks(adapter);
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('done');
  });

  it('outputTokens is ceil(total text length / 4)', async () => {
    // "abcd" = 4 chars → ceil(4/4) = 1
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'stream-chunk', chunk: 'abcd' });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    const doneChunk = chunks.find(
      (c): c is Extract<ProviderChunk, { type: 'done' }> => c.type === 'done',
    );
    expect(doneChunk?.usage?.outputTokens).toBe(1);
  });

  it('outputTokens accumulates across multiple text events', async () => {
    // "hello world" = 11 chars → ceil(11/4) = 3
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'stream-chunk', chunk: 'hello' });
      onEvent?.({ type: 'message', content: ' world' });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    const doneChunk = chunks.find(
      (c): c is Extract<ProviderChunk, { type: 'done' }> => c.type === 'done',
    );
    expect(doneChunk?.usage?.outputTokens).toBe(Math.ceil('hello world'.length / 4));
  });
});

// ---------------------------------------------------------------------------
// 2. AgentEvent 'done' and other dropped types
// ---------------------------------------------------------------------------

describe('TuiAgentAdapter — dropped event types', () => {
  it('AgentEvent "done" is dropped; only adapter terminal done is yielded', async () => {
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'done' });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    // There should be exactly 1 done chunk (the adapter's own terminal done)
    const doneChunks = chunks.filter((c) => c.type === 'done');
    expect(doneChunks).toHaveLength(1);
    // No text chunks
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(0);
  });

  it('rich-response event is dropped — no yield, no dispatch', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({
        type: 'rich-response',
        response: { blocks: [] } as unknown as import('../../../src/core/agent/content-types.js').RichResponse,
      });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    dispose();
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('trace-meta event is dropped', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'trace-meta', skillId: 'test-skill' });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    dispose();
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('compaction event is dropped', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'compaction', summary: 'compacted' });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    dispose();
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Tool call → dispatcher events
// ---------------------------------------------------------------------------

describe('TuiAgentAdapter — tool-call and tool-result dispatch', () => {
  it('tool-call emits tool_start with correct shape — not yielded as chunk', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'tool-call', name: 'bash', args: { cmd: 'ls' }, toolId: 't1' });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    dispose();

    // No text chunk emitted for tool-call
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(0);

    const startEvt = events.find((e) => e.type === 'tool_start');
    expect(startEvt).toBeDefined();
    expect(startEvt).toMatchObject({
      type: 'tool_start',
      toolId: 't1',
      toolName: 'bash',
      args: JSON.stringify({ cmd: 'ls' }),
    });
    expect((startEvt as Extract<typeof startEvt, { type: 'tool_start' }>)?.gerund).toBeTruthy();
  });

  it('tool-result emits tool_end with correct shape — not yielded as chunk', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'tool-call', name: 'bash', args: { cmd: 'ls' }, toolId: 't1' });
      onEvent?.({ type: 'tool-result', name: 'bash', result: 'file.txt', toolId: 't1' });
      return { text: '', attachments: [] };
    });

    const chunks = await collectChunks(adapter);
    dispose();

    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(0);

    const endEvt = events.find((e) => e.type === 'tool_end');
    expect(endEvt).toBeDefined();
    expect(endEvt).toMatchObject({
      type: 'tool_end',
      toolId: 't1',
      resultFull: 'file.txt',
    });
  });

  it('tool-result with non-string result JSON.stringifies the value', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'tool-call', name: 'bash', args: {}, toolId: 't2' });
      onEvent?.({ type: 'tool-result', name: 'bash', result: { lines: 3 }, toolId: 't2' });
      return { text: '', attachments: [] };
    });

    await collectChunks(adapter);
    dispose();

    const endEvt = events.find((e) => e.type === 'tool_end') as
      | Extract<ToolEvent, { type: 'tool_end' }>
      | undefined;
    expect(endEvt?.resultFull).toBe(JSON.stringify({ lines: 3 }));
  });

  it('isDiff is true when result starts with @@', async () => {
    const diffResult = '@@ -1,3 +1,4 @@\n line\n+new\n-old';
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'tool-call', name: 'bash', args: {}, toolId: 't3' });
      onEvent?.({ type: 'tool-result', name: 'bash', result: diffResult, toolId: 't3' });
      return { text: '', attachments: [] };
    });

    await collectChunks(adapter);
    dispose();

    const endEvt = events.find((e) => e.type === 'tool_end') as
      | Extract<ToolEvent, { type: 'tool_end' }>
      | undefined;
    expect(endEvt?.isDiff).toBe(true);
  });

  it('isDiff is true when result contains both \\n- and \\n+ but not @@', async () => {
    const diffResult = 'diff output\n-removed line\n+added line';
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'tool-call', name: 'bash', args: {}, toolId: 't4' });
      onEvent?.({ type: 'tool-result', name: 'bash', result: diffResult, toolId: 't4' });
      return { text: '', attachments: [] };
    });

    await collectChunks(adapter);
    dispose();

    const endEvt = events.find((e) => e.type === 'tool_end') as
      | Extract<ToolEvent, { type: 'tool_end' }>
      | undefined;
    expect(endEvt?.isDiff).toBe(true);
  });

  it('isDiff is false for plain text result', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'tool-call', name: 'bash', args: {}, toolId: 't5' });
      onEvent?.({ type: 'tool-result', name: 'bash', result: 'just output', toolId: 't5' });
      return { text: '', attachments: [] };
    });

    await collectChunks(adapter);
    dispose();

    const endEvt = events.find((e) => e.type === 'tool_end') as
      | Extract<ToolEvent, { type: 'tool_end' }>
      | undefined;
    expect(endEvt?.isDiff).toBe(false);
  });

  it('error event with active toolId emits tool_error via dispatcher', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'tool-call', name: 'bash', args: {}, toolId: 'te1' });
      onEvent?.({ type: 'error', error: 'veto' });
      return { text: '', attachments: [] };
    });

    await collectChunks(adapter);
    dispose();

    const errEvt = events.find((e) => e.type === 'tool_error') as
      | Extract<ToolEvent, { type: 'tool_error' }>
      | undefined;
    expect(errEvt).toBeDefined();
    expect(errEvt?.toolId).toBe('te1');
    expect(errEvt?.error).toBe('veto');
  });

  it('error event with no prior tool-call is silently dropped', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      // No tool-call first — lastActiveToolId is ''
      onEvent?.({ type: 'error', error: 'unexpected' });
      return { text: '', attachments: [] };
    });

    await collectChunks(adapter);
    dispose();

    // No tool_error event should be emitted
    expect(events.filter((e) => e.type === 'tool_error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. elapsedMs tracking
// ---------------------------------------------------------------------------

describe('TuiAgentAdapter — elapsedMs tracking', () => {
  it('tool-result elapsedMs is non-negative when preceded by tool-call', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'tool-call', name: 'bash', args: {}, toolId: 'em1' });
      onEvent?.({ type: 'tool-result', name: 'bash', result: 'ok', toolId: 'em1' });
      return { text: '', attachments: [] };
    });

    await collectChunks(adapter);
    dispose();

    const endEvt = events.find((e) => e.type === 'tool_end') as
      | Extract<ToolEvent, { type: 'tool_end' }>
      | undefined;
    expect(endEvt).toBeDefined();
    expect(endEvt?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('orphan tool-result (no prior tool-call) uses elapsedMs = 0', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      // No tool-call first — startTimes.has(toolId) is false → elapsedMs = 0
      onEvent?.({ type: 'tool-result', name: 'bash', result: 'late', toolId: 'orphan' });
      return { text: '', attachments: [] };
    });

    await collectChunks(adapter);
    dispose();

    const endEvt = events.find((e) => e.type === 'tool_end') as
      | Extract<ToolEvent, { type: 'tool_end' }>
      | undefined;
    expect(endEvt).toBeDefined();
    expect(endEvt?.elapsedMs).toBe(0);
  });

  it('startTimes entry is deleted after tool-result (sequential tool pairs each get valid elapsed)', async () => {
    const { events, dispose } = captureDispatcherEvents();
    const { adapter } = makeAdapter(async (_sid, _msg, onEvent) => {
      onEvent?.({ type: 'tool-call', name: 'bash', args: {}, toolId: 'a1' });
      onEvent?.({ type: 'tool-result', name: 'bash', result: 'r1', toolId: 'a1' });
      onEvent?.({ type: 'tool-call', name: 'bash', args: {}, toolId: 'a2' });
      onEvent?.({ type: 'tool-result', name: 'bash', result: 'r2', toolId: 'a2' });
      return { text: '', attachments: [] };
    });

    await collectChunks(adapter);
    dispose();

    const endEvts = events.filter(
      (e): e is Extract<ToolEvent, { type: 'tool_end' }> => e.type === 'tool_end',
    );
    expect(endEvts).toHaveLength(2);
    endEvts.forEach((e) => expect(e.elapsedMs).toBeGreaterThanOrEqual(0));
  });
});

// ---------------------------------------------------------------------------
// 5. Cancellation via AbortSignal
// ---------------------------------------------------------------------------

describe('TuiAgentAdapter — cancellation', () => {
  it('abort fired during run causes stream to yield done without throwing', async () => {
    /**
     * Pattern: the mock run fires controller.abort() from within the run
     * function itself — at that point the abortPromise listener is already
     * registered inside stream(). The mock then returns a never-resolving
     * promise so the abort wins the Promise.race.
     */
    const controller = new AbortController();

    const { adapter } = makeAdapter((_sid, _msg, _onEvent) => {
      // Fire the abort now — the abortPromise listener is already registered
      // because we are executing synchronously inside stream()'s async body.
      controller.abort();
      // Return a promise that never resolves so the abort wins the race.
      return new Promise<{ text: string; attachments: unknown[] }>(() => {
        // intentionally never resolves
      });
    });

    const chunks: ProviderChunk[] = [];
    // Must not throw
    for await (const chunk of adapter.stream({
      sessionId: 'abort-mid',
      message: 'hi',
      signal: controller.signal,
    })) {
      chunks.push(chunk);
    }

    // After abort, the done chunk is still yielded (queue may be empty, usage 0)
    const doneChunks = chunks.filter((c) => c.type === 'done');
    expect(doneChunks).toHaveLength(1);
  });

  it('abort signal: aborted path does not produce an error text chunk', async () => {
    /**
     * When abort fires (and signal.aborted is true), the catch block in stream()
     * suppresses the error. No error text chunk should appear.
     */
    const controller = new AbortController();

    const { adapter } = makeAdapter((_sid, _msg, _onEvent) => {
      controller.abort();
      return new Promise<{ text: string; attachments: unknown[] }>(() => {
        // intentionally never resolves
      });
    });

    const chunks: ProviderChunk[] = [];
    for await (const chunk of adapter.stream({
      sessionId: 'abort-no-error',
      message: 'hi',
      signal: controller.signal,
    })) {
      chunks.push(chunk);
    }

    // No error text chunk
    const textChunks = chunks.filter(
      (c): c is Extract<ProviderChunk, { type: 'text' }> => c.type === 'text',
    );
    expect(textChunks.filter((c) => c.value.includes('[Error:'))).toHaveLength(0);
    // Only the terminal done
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Run errors surface as text chunk
// ---------------------------------------------------------------------------

describe('TuiAgentAdapter — run errors', () => {
  it('non-abort run error yields an error text chunk before done', async () => {
    const { adapter } = makeAdapter(async () => {
      throw new Error('something broke');
    });

    const chunks = await collectChunks(adapter);
    const textChunks = chunks.filter(
      (c): c is Extract<ProviderChunk, { type: 'text' }> => c.type === 'text',
    );
    expect(textChunks.some((c) => c.value.includes('something broke'))).toBe(true);
    // done is always the last chunk
    expect(chunks[chunks.length - 1]?.type).toBe('done');
  });
});
