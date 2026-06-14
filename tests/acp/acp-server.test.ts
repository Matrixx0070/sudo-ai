/**
 * Tests for the ACP agent server — drives the protocol over NDJSON PassThrough
 * pipes with a stub backend (no Brain boot).
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { JsonRpcConnection } from '../../src/core/acp/jsonrpc.js';
import { AcpServer, type AcpBackend } from '../../src/core/acp/acp-server.js';
import type { StopReason } from '../../src/core/acp/types.js';

function harness(backend: AcpBackend) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() !== '') lines.push(line);
    }
  });
  const conn = new JsonRpcConnection(input, output);
  const server = new AcpServer(conn, backend, { agentName: 'sudo-ai', agentVersion: '9.9.9' });
  server.start();
  const send = (msg: unknown): void => { input.write(JSON.stringify(msg) + '\n'); };
  return { input, lines, send };
}

const all = (lines: string[]) => lines.map((l) => JSON.parse(l));

async function waitForId(lines: string[], id: number, ms = 1000): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const found = all(lines).find((m) => m.id === id);
    if (found) return found;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for response id=${id}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const echoBackend: AcpBackend = {
  createSession: () => 'sess_1',
  prompt: async ({ text, onChunk }) => {
    onChunk('Hello ');
    onChunk(text);
    return 'end_turn';
  },
};

describe('AcpServer', () => {
  it('completes the initialize handshake', async () => {
    const { send, lines } = harness(echoBackend);
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } });
    const res = await waitForId(lines, 0);
    const result = res.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(1);
    expect((result.agentInfo as Record<string, unknown>).name).toBe('sudo-ai');
    expect(result.authMethods).toEqual([]);
    expect((result.agentCapabilities as Record<string, unknown>).loadSession).toBe(false);
  });

  it('negotiates protocolVersion down to the agent max', async () => {
    const { send, lines } = harness(echoBackend);
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 99 } });
    const res = await waitForId(lines, 0);
    expect((res.result as Record<string, unknown>).protocolVersion).toBe(1);
  });

  it('rejects session methods before initialize (-32600)', async () => {
    const { send, lines } = harness(echoBackend);
    send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} });
    const res = await waitForId(lines, 1);
    expect((res.error as Record<string, unknown>).code).toBe(-32600);
  });

  it('runs a full initialize → session/new → session/prompt streaming flow', async () => {
    const { send, lines } = harness(echoBackend);
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } });
    await waitForId(lines, 0);

    send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } });
    const newRes = await waitForId(lines, 1);
    const sessionId = (newRes.result as Record<string, unknown>).sessionId as string;
    expect(sessionId).toBe('sess_1');

    send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'world' }] } });
    const promptRes = await waitForId(lines, 2);
    expect((promptRes.result as Record<string, unknown>).stopReason).toBe('end_turn');

    // The two streamed agent_message_chunk notifications should have arrived.
    const updates = all(lines).filter((m) => m.method === 'session/update');
    expect(updates).toHaveLength(2);
    const texts = updates.map((u) => (u.params as { update: { content: { text: string } } }).update.content.text);
    expect(texts).toEqual(['Hello ', 'world']);
    for (const u of updates) {
      const p = u.params as { sessionId: string; update: { sessionUpdate: string } };
      expect(p.sessionId).toBe(sessionId);
      expect(p.update.sessionUpdate).toBe('agent_message_chunk');
    }
  });

  it('rejects a second initialize (-32600)', async () => {
    const { send, lines } = harness(echoBackend);
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } });
    await waitForId(lines, 0);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    const res = await waitForId(lines, 1);
    expect((res.error as Record<string, unknown>).code).toBe(-32600);
  });

  it('rejects a concurrent prompt on the same session (-32602)', async () => {
    const blockingBackend: AcpBackend = {
      createSession: () => 'sess_b',
      prompt: ({ signal }) =>
        new Promise<StopReason>((resolve) => {
          signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
        }),
    };
    const { send, lines } = harness(blockingBackend);
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } });
    await waitForId(lines, 0);
    send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} });
    const sid = ((await waitForId(lines, 1)).result as { sessionId: string }).sessionId;

    // First prompt stays in-flight (resolves only on abort).
    send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'one' }] } });
    await new Promise((r) => setTimeout(r, 20));
    // Second, concurrent prompt on the same session is rejected.
    send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'two' }] } });
    const res = await waitForId(lines, 3);
    expect((res.error as Record<string, unknown>).code).toBe(-32602);
    expect((res.error as Record<string, string>).message).toContain('already in flight');
  });

  it('returns -32601 for an unknown method', async () => {
    const { send, lines } = harness(echoBackend);
    send({ jsonrpc: '2.0', id: 7, method: 'totally/unknown' });
    const res = await waitForId(lines, 7);
    expect((res.error as Record<string, unknown>).code).toBe(-32601);
  });

  it('rejects session/prompt for an unknown sessionId (-32602)', async () => {
    const { send, lines } = harness(echoBackend);
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } });
    await waitForId(lines, 0);

    send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'ghost', prompt: [] } });
    const res = await waitForId(lines, 3);
    expect((res.error as Record<string, unknown>).code).toBe(-32602);
  });

  it('session/cancel aborts an in-flight prompt and yields stopReason cancelled', async () => {
    const cancelBackend: AcpBackend = {
      createSession: () => 'sess_c',
      prompt: ({ signal }) =>
        new Promise<StopReason>((resolve) => {
          if (signal.aborted) return resolve('cancelled');
          signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
        }),
    };
    const { send, lines } = harness(cancelBackend);
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } });
    await waitForId(lines, 0);
    send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} });
    const sid = (await waitForId(lines, 1)).result as { sessionId: string };

    send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid.sessionId, prompt: [{ type: 'text', text: 'hi' }] } });
    // Give the prompt a moment to register its controller, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid.sessionId } });

    const res = await waitForId(lines, 2);
    expect((res.result as Record<string, unknown>).stopReason).toBe('cancelled');
  });
});
