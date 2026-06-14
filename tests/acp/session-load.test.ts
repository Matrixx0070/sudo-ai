/**
 * @file tests/acp/session-load.test.ts
 * @description ACP slice 4 tests — SessionStore round-trip, BrainAcpBackend
 * persistence + loadSession replay, AcpServer session/load handler +
 * capability advert (gap #26).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../src/core/acp/session-store.js';
import {
  BrainAcpBackend,
  type AcpBrain,
} from '../../src/core/acp/brain-backend.js';
import { AcpServer } from '../../src/core/acp/acp-server.js';
import { JsonRpcConnection } from '../../src/core/acp/jsonrpc.js';
import type { SessionUpdate } from '../../src/core/acp/types.js';

// ---------------------------------------------------------------------------
// Stubs + helpers
// ---------------------------------------------------------------------------

function queuedBrain(responses: string[]): AcpBrain & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async *stream() {
      const idx = calls++;
      yield responses[idx] ?? '';
    },
  } as AcpBrain & { calls: number };
}

function collectLines(stream: PassThrough): { messages: unknown[]; lines: string[] } {
  const lines: string[] = [];
  const messages: unknown[] = [];
  stream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lines.push(trimmed);
      try {
        messages.push(JSON.parse(trimmed));
      } catch {
        // ignore — defensive
      }
    }
  });
  return { messages, lines };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'acp-sess-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

describe('SessionStore (gap #26 slice 4)', () => {
  it('save → load round-trips a session record', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const now = new Date().toISOString();
    await store.save({
      version: 1,
      sessionId: 'acp_aaa',
      createdAt: now,
      updatedAt: now,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi back' },
      ],
    });
    const loaded = await store.load('acp_aaa');
    expect(loaded).not.toBeNull();
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[0]?.content).toBe('hello');
  });

  it('load returns null for an unknown sessionId (ENOENT)', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    expect(await store.load('acp_missing')).toBeNull();
  });

  it('load returns null for a malformed JSON body', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    writeFileSync(path.join(tmpDir, 'acp_bad.json'), 'not json {{', 'utf8');
    expect(await store.load('acp_bad')).toBeNull();
  });

  it('load returns null when the stored sessionId does not match the requested id (tampered file)', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    writeFileSync(
      path.join(tmpDir, 'acp_x.json'),
      JSON.stringify({
        version: 1,
        sessionId: 'acp_y',
        createdAt: 'now',
        updatedAt: 'now',
        messages: [],
      }),
      'utf8',
    );
    expect(await store.load('acp_x')).toBeNull();
  });

  it('throws on a malformed sessionId (path traversal attempt)', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    await expect(store.load('../etc/passwd')).rejects.toThrow('invalid sessionId');
    await expect(store.load('a/b')).rejects.toThrow('invalid sessionId');
  });

  it('delete is idempotent on missing files', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    await expect(store.delete('acp_nope')).resolves.toBeUndefined();
  });

  it('save uses tmp + rename for atomicity (no torn-write window)', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const now = new Date().toISOString();
    await store.save({
      version: 1,
      sessionId: 'acp_atomic',
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
    const raw = await readFile(path.join(tmpDir, 'acp_atomic.json'), 'utf8');
    expect(JSON.parse(raw).sessionId).toBe('acp_atomic');
    // No stray .tmp-* artifact left behind.
    const { readdirSync } = await import('node:fs');
    const stragglers = readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
    expect(stragglers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BrainAcpBackend persistence + loadSession
// ---------------------------------------------------------------------------

describe('BrainAcpBackend persistence (gap #26 slice 4)', () => {
  it('supportsLoadSession reflects whether a store was wired', () => {
    const a = new BrainAcpBackend(queuedBrain([]));
    expect(a.supportsLoadSession()).toBe(false);

    const store = new SessionStore({ baseDir: tmpDir });
    const b = new BrainAcpBackend(queuedBrain([]), { sessionStore: store });
    expect(b.supportsLoadSession()).toBe(true);
  });

  it('persists the session history to disk after a prompt turn', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const backend = new BrainAcpBackend(queuedBrain(['Hi there.']), { sessionStore: store });
    const sessionId = backend.createSession({});
    await backend.prompt({ sessionId, text: 'hello', onChunk: () => {}, signal: new AbortController().signal });

    const loaded = await store.load(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi there.' },
    ]);
  });

  it('loadSession returns false when no store wired', async () => {
    const backend = new BrainAcpBackend(queuedBrain([]));
    expect(await backend.loadSession({ sessionId: 'acp_xx' })).toBe(false);
  });

  it('loadSession returns false when the session is unknown to the store', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const backend = new BrainAcpBackend(queuedBrain([]), { sessionStore: store });
    expect(await backend.loadSession({ sessionId: 'acp_missing' })).toBe(false);
  });

  it('loadSession replays user + assistant messages as session/update events', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const sessionId = 'acp_persisted';
    const now = new Date().toISOString();
    await store.save({
      version: 1,
      sessionId,
      createdAt: now,
      updatedAt: now,
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'tool', content: '{"toolCallId":"x","success":true}' },
        { role: 'user', content: 'q2' },
      ],
    });
    const backend = new BrainAcpBackend(queuedBrain([]), { sessionStore: store });
    const captured: SessionUpdate[] = [];
    const ok = await backend.loadSession({ sessionId, emit: (u) => captured.push(u) });
    expect(ok).toBe(true);
    // Tool messages do NOT replay as structured updates this slice.
    const kinds = captured.map((u) => u.sessionUpdate);
    expect(kinds).toEqual(['user_message_chunk', 'agent_message_chunk', 'user_message_chunk']);
  });

  it('persists partial assistant text from a cancelled mid-turn prompt (intentional context survival)', async () => {
    // Verifier LOW 1 — slice 4 intentionally persists whatever the assistant
    // produced before a cancel so a session/load can resume mid-thought. Pin
    // this behavior so a future refactor that swallows partial state is a
    // deliberate spec change.
    const store = new SessionStore({ baseDir: tmpDir });
    const partial = 'half thought before user';
    const brain: AcpBrain = {
      async *stream() {
        yield partial;
        // Yield a second chunk that the cancel will skip.
        yield ' [should not appear]';
      },
    };
    const backend = new BrainAcpBackend(brain, { sessionStore: store });
    const sessionId = backend.createSession({});
    const ac = new AbortController();
    // Abort right after the first chunk lands. We use a microtask trick: the
    // for-await loop's first `args.onChunk` call runs synchronously; abort
    // before the second iteration.
    const stop = await backend.prompt({
      sessionId,
      text: 'go',
      onChunk: () => { ac.abort(); },
      signal: ac.signal,
    });
    expect(stop).toBe('cancelled');
    const loaded = await store.load(sessionId);
    expect(loaded?.messages.map((m) => m.content)).toEqual(['go', partial]);
  });

  it('loadSession installs the history so a subsequent prompt sees it', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const sessionId = 'acp_resume';
    const now = new Date().toISOString();
    await store.save({
      version: 1,
      sessionId,
      createdAt: now,
      updatedAt: now,
      messages: [
        { role: 'user', content: 'remember 42' },
        { role: 'assistant', content: 'noted' },
      ],
    });
    const brain = queuedBrain(['ok']);
    const backend = new BrainAcpBackend(brain, { sessionStore: store });

    await backend.loadSession({ sessionId });
    await backend.prompt({ sessionId, text: 'what number?', onChunk: () => {}, signal: new AbortController().signal });

    // The brain stub stores its last request; we verify by reloading the
    // store, since the brain stub doesn't expose it directly — but we can
    // assert the persisted history grew by 2 (new user + new assistant).
    const after = await store.load(sessionId);
    expect(after?.messages.map((m) => m.content)).toEqual([
      'remember 42',
      'noted',
      'what number?',
      'ok',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AcpServer session/load handler + capability advert
// ---------------------------------------------------------------------------

describe('AcpServer session/load handler (gap #26 slice 4)', () => {
  it('initialize advertises loadSession=true when the backend supports it', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const backend = new BrainAcpBackend(queuedBrain([]), { sessionStore: store });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    const server = new AcpServer(conn, backend);
    server.start();

    const { messages } = collectLines(stdout);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');

    await new Promise((r) => setTimeout(r, 20));
    const init = messages.find((m): m is { result: { agentCapabilities: { loadSession: boolean } } } => {
      const obj = m as { id?: unknown };
      return obj?.id === 1;
    });
    expect(init?.result.agentCapabilities.loadSession).toBe(true);
  });

  it('initialize advertises loadSession=false when no store', async () => {
    const backend = new BrainAcpBackend(queuedBrain([]));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    const server = new AcpServer(conn, backend);
    server.start();

    const { messages } = collectLines(stdout);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');

    await new Promise((r) => setTimeout(r, 20));
    const init = messages.find((m): m is { result: { agentCapabilities: { loadSession: boolean } } } => {
      const obj = m as { id?: unknown };
      return obj?.id === 1;
    });
    expect(init?.result.agentCapabilities.loadSession).toBe(false);
  });

  it('session/load returns MethodNotFound when backend does not support it', async () => {
    const backend = new BrainAcpBackend(queuedBrain([]));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    const server = new AcpServer(conn, backend);
    server.start();

    const { messages } = collectLines(stdout);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'acp_x' } }) + '\n');

    await new Promise((r) => setTimeout(r, 30));
    const err = messages.find((m): m is { id: number; error: { code: number } } => {
      const obj = m as { id?: unknown; error?: unknown };
      return obj?.id === 2 && !!obj?.error;
    });
    expect(err?.error.code).toBe(-32601); // MethodNotFound
  });

  it('session/load emits replay notifications and returns success', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const sessionId = 'acp_replayme';
    const now = new Date().toISOString();
    await store.save({
      version: 1,
      sessionId,
      createdAt: now,
      updatedAt: now,
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ],
    });
    const backend = new BrainAcpBackend(queuedBrain([]), { sessionStore: store });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    const server = new AcpServer(conn, backend);
    server.start();

    const { messages } = collectLines(stdout);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId } }) + '\n');

    await new Promise((r) => setTimeout(r, 30));
    const replays = messages.filter((m): m is { method: string; params: { update: { sessionUpdate: string } } } => {
      const obj = m as { method?: unknown };
      return obj?.method === 'session/update';
    });
    expect(replays.map((m) => m.params.update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
    ]);
    const loadResp = messages.find((m): m is { id: number; result: unknown } => {
      const obj = m as { id?: unknown; result?: unknown };
      return obj?.id === 2 && obj?.result !== undefined;
    });
    expect(loadResp?.result).toBeDefined();
  });

  it('session/load returns InvalidParams for an unknown sessionId', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const backend = new BrainAcpBackend(queuedBrain([]), { sessionStore: store });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    const server = new AcpServer(conn, backend);
    server.start();

    const { messages } = collectLines(stdout);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'acp_unknown' } }) + '\n');

    await new Promise((r) => setTimeout(r, 20));
    const err = messages.find((m): m is { id: number; error: { code: number; message: string } } => {
      const obj = m as { id?: unknown; error?: unknown };
      return obj?.id === 2 && !!obj?.error;
    });
    expect(err?.error.code).toBe(-32602); // InvalidParams
    expect(err?.error.message).toContain('unknown sessionId');
  });

  it('session/load with a malformed sessionId returns InvalidParams', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const backend = new BrainAcpBackend(queuedBrain([]), { sessionStore: store });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    const server = new AcpServer(conn, backend);
    server.start();

    const { messages } = collectLines(stdout);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: '../escape' } }) + '\n');

    await new Promise((r) => setTimeout(r, 20));
    const err = messages.find((m): m is { id: number; error: { code: number; message: string } } => {
      const obj = m as { id?: unknown; error?: unknown };
      return obj?.id === 2 && !!obj?.error;
    });
    expect(err?.error.code).toBe(-32602);
    expect(err?.error.message).toContain('invalid sessionId');
  });

  it('after a successful session/load, session/prompt works against the restored session', async () => {
    const store = new SessionStore({ baseDir: tmpDir });
    const sessionId = 'acp_promptafter';
    const now = new Date().toISOString();
    await store.save({
      version: 1,
      sessionId,
      createdAt: now,
      updatedAt: now,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const backend = new BrainAcpBackend(queuedBrain(['ok']), { sessionStore: store });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    const server = new AcpServer(conn, backend);
    server.start();

    const { messages } = collectLines(stdout);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId } }) + '\n');

    await new Promise((r) => setTimeout(r, 30));

    stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'continue' }] },
      }) + '\n',
    );

    await new Promise((r) => setTimeout(r, 50));
    const promptResp = messages.find((m): m is { id: number; result: { stopReason: string } } => {
      const obj = m as { id?: unknown; result?: unknown };
      return obj?.id === 3 && obj?.result !== undefined;
    });
    expect(promptResp?.result.stopReason).toBe('end_turn');
  });
});
