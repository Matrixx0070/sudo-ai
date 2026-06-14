/**
 * Tests for the ACP NDJSON JSON-RPC 2.0 connection.
 * Drives real newline-delimited framing over PassThrough pipes.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { JsonRpcConnection, AcpRpcError, JsonRpcErrorCode, MAX_LINE_BYTES } from '../../src/core/acp/jsonrpc.js';

function makePair() {
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
  return { input, output, lines, conn };
}

async function waitFor(lines: string[], n: number, ms = 1000): Promise<void> {
  const start = Date.now();
  while (lines.length < n) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${n} lines; got ${lines.length}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('JsonRpcConnection (NDJSON)', () => {
  it('answers a request via the installed request handler', async () => {
    const { input, lines, conn } = makePair();
    conn.onRequest((method, params) => ({ echo: method, p: params }));
    conn.start();

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { a: 1 } }) + '\n');
    await waitFor(lines, 1);

    expect(JSON.parse(lines[0]!)).toEqual({ jsonrpc: '2.0', id: 1, result: { echo: 'ping', p: { a: 1 } } });
  });

  it('routes notifications to the notification handler and never responds', async () => {
    const { input, lines, conn } = makePair();
    const seen: Array<[string, unknown]> = [];
    conn.onNotification((m, p) => { seen.push([m, p]); });
    conn.start();

    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { x: 1 } }) + '\n');
    await new Promise((r) => setTimeout(r, 30));

    expect(seen).toEqual([['note', { x: 1 }]]);
    expect(lines).toHaveLength(0);
  });

  it('returns a -32700 parse error (id null) for malformed JSON', async () => {
    const { input, lines, conn } = makePair();
    conn.start();

    input.write('this is not json\n');
    await waitFor(lines, 1);

    const res = JSON.parse(lines[0]!);
    expect(res.error.code).toBe(JsonRpcErrorCode.ParseError);
    expect(res.id).toBeNull();
  });

  it('returns -32600 invalid request (preserving id) when method is missing', async () => {
    const { input, lines, conn } = makePair();
    conn.start();

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 5 }) + '\n');
    await waitFor(lines, 1);

    const res = JSON.parse(lines[0]!);
    expect(res.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(res.id).toBe(5);
  });

  it('maps a thrown AcpRpcError to its code/message', async () => {
    const { input, lines, conn } = makePair();
    conn.onRequest(() => { throw new AcpRpcError(JsonRpcErrorCode.MethodNotFound, 'nope'); });
    conn.start();

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'x' }) + '\n');
    await waitFor(lines, 1);

    const res = JSON.parse(lines[0]!);
    expect(res.id).toBe(2);
    expect(res.error.code).toBe(JsonRpcErrorCode.MethodNotFound);
    expect(res.error.message).toBe('nope');
  });

  it('maps a generic thrown Error to -32603 internal error', async () => {
    const { input, lines, conn } = makePair();
    conn.onRequest(() => { throw new Error('boom'); });
    conn.start();

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'x' }) + '\n');
    await waitFor(lines, 1);

    const res = JSON.parse(lines[0]!);
    expect(res.error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(res.error.message).toBe('boom');
  });

  it('notify() writes a notification line (no id)', async () => {
    const { lines, conn } = makePair();
    conn.notify('session/update', { a: 1 });
    await waitFor(lines, 1);

    expect(JSON.parse(lines[0]!)).toEqual({ jsonrpc: '2.0', method: 'session/update', params: { a: 1 } });
  });

  it('frames multiple messages in one chunk and handles split chunks', async () => {
    const { input, lines, conn } = makePair();
    conn.onRequest((method) => ({ method }));
    conn.start();

    // Two messages in a single write.
    input.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'a' }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'b' }) + '\n',
    );
    await waitFor(lines, 2);
    expect(lines.map((l) => JSON.parse(l).id).sort()).toEqual([1, 2]);

    // One message split across two writes.
    const msg = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'c' }) + '\n';
    input.write(msg.slice(0, 12));
    await new Promise((r) => setTimeout(r, 10));
    input.write(msg.slice(12));
    await waitFor(lines, 3);
    expect(JSON.parse(lines[2]!).id).toBe(9);
  });

  it('drops an unterminated overlong line with a parse error (OOM guard)', async () => {
    const { input, lines, conn } = makePair();
    conn.start();

    // A single line larger than MAX_LINE_BYTES with no newline terminator.
    input.write('x'.repeat(MAX_LINE_BYTES + 10));
    await waitFor(lines, 1);

    const res = JSON.parse(lines[0]!);
    expect(res.error.code).toBe(JsonRpcErrorCode.ParseError);
    expect(res.id).toBeNull();
  });
});
