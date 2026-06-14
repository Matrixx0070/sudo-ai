/**
 * @file tests/acp/tools-dispatch.test.ts
 * @description ACP slice 2 tests — tool dispatch loop, permission round-trip,
 * session/update variants, outbound JsonRpcConnection.sendRequest (gap #26).
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  BrainAcpBackend,
  parseToolCalls,
  type AcpBrain,
  type AcpToolHost,
  type ToolMetadata,
} from '../../src/core/acp/brain-backend.js';
import { JsonRpcConnection, AcpRpcError, JsonRpcErrorCode } from '../../src/core/acp/jsonrpc.js';
import type {
  SessionUpdate,
  RequestPermissionParams,
  RequestPermissionResult,
} from '../../src/core/acp/types.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** Brain stub that yields a queued list of responses, one per stream() call. */
function queuedBrain(responses: string[]): AcpBrain & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async *stream() {
      const idx = calls++;
      const text = responses[idx] ?? '';
      yield text;
    },
  } as AcpBrain & { calls: number };
}

function tcBlock(id: string, name: string, args: Record<string, unknown>): string {
  return `<tool_call id="${id}" name="${name}">${JSON.stringify(args)}</tool_call>`;
}

interface RecordedExec {
  toolName: string;
  args: Record<string, unknown>;
}

interface StubHostOptions {
  meta?: ToolMetadata;
  execImpl?: (toolName: string, args: Record<string, unknown>) => Promise<{ success: boolean; output: string }>;
}

function stubHost(opts: StubHostOptions = {}): { host: AcpToolHost; calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  const defaultMeta: ToolMetadata = { title: 'echo', kind: 'other', requiresConfirmation: false };
  const meta = opts.meta ?? defaultMeta;
  return {
    calls,
    host: {
      describe: () => meta,
      execute: async (toolName, args) => {
        calls.push({ toolName, args });
        if (opts.execImpl) return opts.execImpl(toolName, args);
        return { success: true, output: `tool ${toolName} ran` };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// parseToolCalls
// ---------------------------------------------------------------------------

describe('parseToolCalls (gap #26 slice 2)', () => {
  it('parses one well-formed block', () => {
    const t = `Some text${tcBlock('t1', 'foo', { x: 1 })}trailing`;
    const out = parseToolCalls(t);
    expect(out).toHaveLength(1);
    expect(out[0]!.toolCallId).toBe('t1');
    expect(out[0]!.name).toBe('foo');
    expect(out[0]!.args).toEqual({ x: 1 });
  });

  it('parses multiple blocks in order', () => {
    const t = tcBlock('a', 'one', {}) + 'mid' + tcBlock('b', 'two', { k: 'v' });
    const out = parseToolCalls(t);
    expect(out.map((c) => c.toolCallId)).toEqual(['a', 'b']);
  });

  it('skips blocks with malformed JSON args (honest no-op)', () => {
    const t = '<tool_call id="x" name="bad">{notjson}</tool_call>';
    expect(parseToolCalls(t)).toEqual([]);
  });

  it('skips blocks whose args are not a JSON object', () => {
    const t = '<tool_call id="x" name="arr">[1,2,3]</tool_call>';
    expect(parseToolCalls(t)).toEqual([]);
  });

  it('returns an empty list when no markers are present', () => {
    expect(parseToolCalls('plain assistant text')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backend tool-dispatch loop
// ---------------------------------------------------------------------------

describe('BrainAcpBackend tool dispatch (gap #26 slice 2)', () => {
  it('runs a single tool, feeds result back, ends turn on second iteration', async () => {
    const brain = queuedBrain([
      `Working on it${tcBlock('a1', 'echo', { q: 'hi' })}`,
      'Final answer.',
    ]);
    const { host, calls } = stubHost();
    const updates: SessionUpdate[] = [];
    const backend = new BrainAcpBackend(brain, {
      tools: {
        host,
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }),
      },
    });

    const sessionId = backend.createSession({});
    const stop = await backend.prompt({
      sessionId,
      text: 'do the thing',
      onChunk: () => {},
      signal: new AbortController().signal,
      emit: (u) => updates.push(u),
    });

    expect(stop).toBe('end_turn');
    expect(calls).toEqual([{ toolName: 'echo', args: { q: 'hi' } }]);
    // Notification sequence: tool_call(pending) → tool_call_update(in_progress) → tool_call_update(completed)
    const kinds = updates.map((u) => u.sessionUpdate);
    expect(kinds).toEqual(['tool_call', 'tool_call_update', 'tool_call_update']);
    expect((updates[0] as { status: string }).status).toBe('pending');
    expect((updates[1] as { status: string }).status).toBe('in_progress');
    expect((updates[2] as { status: string }).status).toBe('completed');
  });

  it('grants permission via allow_once when the tool requiresConfirmation', async () => {
    const brain = queuedBrain([
      tcBlock('p1', 'write', { path: '/tmp/x' }),
      'done',
    ]);
    const { host, calls } = stubHost({
      meta: { title: 'write', kind: 'edit', requiresConfirmation: true },
    });
    const permCalls: RequestPermissionParams[] = [];
    const backend = new BrainAcpBackend(brain, {
      tools: {
        host,
        requestPermission: async (params) => {
          permCalls.push(params);
          return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
        },
      },
    });
    const sessionId = backend.createSession({});
    await backend.prompt({
      sessionId,
      text: 'go',
      onChunk: () => {},
      signal: new AbortController().signal,
    });
    expect(permCalls).toHaveLength(1);
    expect(permCalls[0]!.toolCall.title).toBe('write');
    expect(permCalls[0]!.options.map((o) => o.optionId)).toContain('allow_once');
    expect(calls).toHaveLength(1);
  });

  it('caches allow_always — second call to the same tool skips the round-trip', async () => {
    const brain = queuedBrain([
      tcBlock('q1', 'edit', {}),
      tcBlock('q2', 'edit', {}),
      'done',
    ]);
    const { host } = stubHost({
      meta: { title: 'edit', kind: 'edit', requiresConfirmation: true },
    });
    let permAsks = 0;
    const backend = new BrainAcpBackend(brain, {
      tools: {
        host,
        requestPermission: async () => {
          permAsks++;
          return { outcome: { outcome: 'selected', optionId: 'allow_always' } };
        },
      },
    });
    const sessionId = backend.createSession({});
    await backend.prompt({ sessionId, text: 'go', onChunk: () => {}, signal: new AbortController().signal });
    await backend.prompt({ sessionId, text: 'again', onChunk: () => {}, signal: new AbortController().signal });
    expect(permAsks).toBe(1); // cached after the first grant
  });

  it('denies via reject_once — synthetic tool_result feeds back into history', async () => {
    const brain = queuedBrain([
      tcBlock('r1', 'rm', { path: '/' }),
      'I will not.',
    ]);
    const { host, calls } = stubHost({
      meta: { title: 'rm', kind: 'delete', requiresConfirmation: true },
    });
    const updates: SessionUpdate[] = [];
    const backend = new BrainAcpBackend(brain, {
      tools: {
        host,
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }),
      },
    });
    const sessionId = backend.createSession({});
    await backend.prompt({
      sessionId,
      text: 'go',
      onChunk: () => {},
      signal: new AbortController().signal,
      emit: (u) => updates.push(u),
    });
    expect(calls).toHaveLength(0); // never dispatched
    const cancelled = updates.find((u) => u.sessionUpdate === 'tool_call_update' && (u as { status?: string }).status === 'cancelled');
    expect(cancelled).toBeDefined();
  });

  it('handles cancellation outcome the same as a reject', async () => {
    const brain = queuedBrain([
      tcBlock('c1', 'write', {}),
      'done',
    ]);
    const { host, calls } = stubHost({
      meta: { title: 'write', kind: 'edit', requiresConfirmation: true },
    });
    const backend = new BrainAcpBackend(brain, {
      tools: {
        host,
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      },
    });
    const sessionId = backend.createSession({});
    await backend.prompt({ sessionId, text: 'go', onChunk: () => {}, signal: new AbortController().signal });
    expect(calls).toHaveLength(0);
  });

  it('returns max_turn_requests when the brain keeps calling tools past the cap', async () => {
    // Brain emits a tool call EVERY iteration — bounded by maxIterations.
    const responses = ['1', '2', '3', '4', '5', '6'].map((id) => tcBlock(id, 'echo', {}));
    const brain = queuedBrain(responses);
    const { host } = stubHost();
    const backend = new BrainAcpBackend(brain, {
      tools: {
        host,
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }),
        maxIterations: 3,
      },
    });
    const sessionId = backend.createSession({});
    const stop = await backend.prompt({ sessionId, text: 'loop', onChunk: () => {}, signal: new AbortController().signal });
    expect(stop).toBe('max_turn_requests');
    // Verifier MED 2: exactly maxIterations stream passes — no extra re-stream after the cap.
    expect(brain.calls).toBe(3);
  });

  it('with maxIterations=1, dispatches the first batch then returns max_turn_requests (pin behavior)', async () => {
    // Verifier MED 1: the model never sees a final text response to the last
    // batch of tool results when maxIterations is 1. Pin this so a future
    // refactor that skips dispatch on the final iter is a deliberate change.
    const brain = queuedBrain([tcBlock('only', 'echo', { q: 'x' })]);
    const { host, calls } = stubHost();
    const backend = new BrainAcpBackend(brain, {
      tools: {
        host,
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }),
        maxIterations: 1,
      },
    });
    const sessionId = backend.createSession({});
    const stop = await backend.prompt({ sessionId, text: 'go', onChunk: () => {}, signal: new AbortController().signal });
    expect(stop).toBe('max_turn_requests');
    expect(calls).toHaveLength(1);
    expect(brain.calls).toBe(1);
  });

  it('marks the tool_call_update failed when execution throws', async () => {
    const brain = queuedBrain([
      tcBlock('e1', 'broken', {}),
      'sorry',
    ]);
    const { host } = stubHost({
      execImpl: async () => {
        throw new Error('boom');
      },
    });
    const updates: SessionUpdate[] = [];
    const backend = new BrainAcpBackend(brain, {
      tools: {
        host,
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }),
      },
    });
    const sessionId = backend.createSession({});
    await backend.prompt({
      sessionId,
      text: 'go',
      onChunk: () => {},
      signal: new AbortController().signal,
      emit: (u) => updates.push(u),
    });
    const failed = updates.find((u) => u.sessionUpdate === 'tool_call_update' && (u as { status?: string }).status === 'failed');
    expect(failed).toBeDefined();
    expect((failed as { rawError?: string }).rawError).toContain('boom');
  });

  it('collapses to slice 1 chat-only when no tools configured', async () => {
    const brain = queuedBrain([tcBlock('x', 'whatever', {})]);
    const backend = new BrainAcpBackend(brain);
    const sessionId = backend.createSession({});
    const stop = await backend.prompt({ sessionId, text: 'hi', onChunk: () => {}, signal: new AbortController().signal });
    expect(stop).toBe('end_turn');
    expect(brain.calls).toBe(1); // never re-streamed; no tool dispatch
  });
});

// ---------------------------------------------------------------------------
// JsonRpcConnection.sendRequest (outbound request half)
// ---------------------------------------------------------------------------

describe('JsonRpcConnection.sendRequest (gap #26 slice 2)', () => {
  it('emits an outbound request and resolves with the matched response', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    conn.start();

    // Capture the outbound line so we can correlate the id.
    const outboundLines: string[] = [];
    stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) outboundLines.push(line.trim());
      }
    });

    const reqPromise = conn.sendRequest<RequestPermissionResult>('session/request_permission', {
      sessionId: 's1',
      toolCall: { toolCallId: 't', title: 'x', kind: 'other' },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    });

    // Wait one microtask for the write to land on stdout.
    await new Promise((r) => setImmediate(r));
    const outbound = JSON.parse(outboundLines[0]!) as { id: string; method: string };
    expect(outbound.method).toBe('session/request_permission');
    expect(outbound.id).toMatch(/^out-/);

    // Simulate the client's response.
    stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: outbound.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      }) + '\n',
    );

    const result = await reqPromise;
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
  });

  it('rejects with AcpRpcError when the peer returns an error envelope', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    conn.start();

    const lines: string[] = [];
    stdout.on('data', (c: Buffer) => {
      for (const l of c.toString('utf8').split('\n')) if (l.trim()) lines.push(l.trim());
    });

    const p = conn.sendRequest('whatever', {});
    await new Promise((r) => setImmediate(r));
    const { id } = JSON.parse(lines[0]!) as { id: string };

    stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: JsonRpcErrorCode.InvalidParams, message: 'no good' },
      }) + '\n',
    );

    await expect(p).rejects.toBeInstanceOf(AcpRpcError);
  });
});
