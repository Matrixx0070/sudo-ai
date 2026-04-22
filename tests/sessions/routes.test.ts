/**
 * @file routes.test.ts
 * @description Tests for session REST routes (Wave 5).
 *
 * Uses in-memory better-sqlite3 + Node's http.createServer to test
 * the registerSessionRoutes listener pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { SqliteSessionStore } from '../../src/core/sessions/sqlite-session-store.js';
import { SessionStateMachine } from '../../src/core/sessions/state-machine.js';
import { registerSessionRoutes } from '../../src/core/sessions/routes.js';
import type { SessionRouteDeps } from '../../src/core/sessions/routes.js';

// ---------------------------------------------------------------------------
// DB / Server helpers
// ---------------------------------------------------------------------------

function makeDb(): DB {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      title           TEXT,
      model           TEXT NOT NULL,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      total_cost_usd  REAL    NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role          TEXT    NOT NULL CHECK (role IN ('user','assistant','system','tool')),
      content       TEXT    NOT NULL,
      tool_name     TEXT,
      tool_input    TEXT,
      tool_output   TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL    NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  return db;
}

async function makeServer(deps: SessionRouteDeps): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer();
  registerSessionRoutes(server, deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// HTTP helpers
async function apiGet(url: string, token?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { headers });
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

async function apiPost(
  url: string,
  data: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

async function apiDelete(url: string, token?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { method: 'DELETE', headers });
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

// ---------------------------------------------------------------------------
// Tests — no auth (GATEWAY_TOKEN not set)
// ---------------------------------------------------------------------------

describe('Session Routes — no auth', () => {
  let db: DB;
  let deps: SessionRouteDeps;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    // Ensure GATEWAY_TOKEN is NOT set for these tests
    delete process.env['GATEWAY_TOKEN'];

    db = makeDb();
    deps = {
      store: new SqliteSessionStore(db),
      stateMachine: new SessionStateMachine(db),
    };
    const setup = await makeServer(deps);
    server = setup.server;
    baseUrl = setup.baseUrl;
  });

  afterEach(async () => {
    await closeServer(server);
    db.close();
  });

  it('POST /v1/sessions creates a session and returns 201', async () => {
    const { status, body } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'gpt-4' });
    expect(status).toBe(201);
    const b = body as Record<string, unknown>;
    expect(typeof b['session_id']).toBe('string');
    expect(b['model']).toBe('gpt-4');
    expect(b['status']).toBe('idle');
    expect(b['message_count']).toBe(0);
  });

  it('POST /v1/sessions returns 400 if model is missing', async () => {
    const { status } = await apiPost(`${baseUrl}/v1/sessions`, {});
    expect(status).toBe(400);
  });

  it('GET /v1/sessions returns list of sessions', async () => {
    await apiPost(`${baseUrl}/v1/sessions`, { model: 'claude' });
    await apiPost(`${baseUrl}/v1/sessions`, { model: 'gpt-4' });
    const { status, body } = await apiGet(`${baseUrl}/v1/sessions`);
    expect(status).toBe(200);
    const b = body as { data: unknown[]; count: number };
    expect(b.data.length).toBeGreaterThanOrEqual(2);
    expect(b.count).toBeGreaterThanOrEqual(2);
  });

  it('GET /v1/sessions/:id retrieves session with message_count', async () => {
    const { body: created } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'claude' });
    const id = (created as Record<string, unknown>)['session_id'] as string;

    const { status, body } = await apiGet(`${baseUrl}/v1/sessions/${id}`);
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['session_id']).toBe(id);
    expect((body as Record<string, unknown>)['message_count']).toBe(0);
  });

  it('GET /v1/sessions/:id returns 404 for unknown id', async () => {
    const { status } = await apiGet(`${baseUrl}/v1/sessions/nonexistent`);
    expect(status).toBe(404);
  });

  it('POST /v1/sessions/:id updates title', async () => {
    const { body: created } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'claude' });
    const id = (created as Record<string, unknown>)['session_id'] as string;

    const { status, body } = await apiPost(`${baseUrl}/v1/sessions/${id}`, { title: 'New Title' });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['title']).toBe('New Title');
  });

  it('POST /v1/sessions/:id/archive archives a session (status=archived)', async () => {
    const { body: created } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'claude' });
    const id = (created as Record<string, unknown>)['session_id'] as string;

    const { status, body } = await apiPost(`${baseUrl}/v1/sessions/${id}/archive`, {});
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['status']).toBe('archived');
  });

  it('POST /v1/sessions/:id/archive returns 409 for already-archived session', async () => {
    const { body: created } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'claude' });
    const id = (created as Record<string, unknown>)['session_id'] as string;
    await apiPost(`${baseUrl}/v1/sessions/${id}/archive`, {});
    const { status } = await apiPost(`${baseUrl}/v1/sessions/${id}/archive`, {});
    expect(status).toBe(409);
  });

  it('DELETE /v1/sessions/:id hard-deletes a non-running session', async () => {
    const { body: created } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'claude' });
    const id = (created as Record<string, unknown>)['session_id'] as string;

    const { status, body } = await apiDelete(`${baseUrl}/v1/sessions/${id}`);
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['deleted']).toBe(true);

    // Subsequent GET should 404
    const { status: getStatus } = await apiGet(`${baseUrl}/v1/sessions/${id}`);
    expect(getStatus).toBe(404);
  });

  it('DELETE /v1/sessions/:id returns 409 for a running session', async () => {
    const { body: created } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'claude' });
    const id = (created as Record<string, unknown>)['session_id'] as string;

    // Transition to running via state machine directly
    deps.stateMachine.transition(id, 'running');

    const { status } = await apiDelete(`${baseUrl}/v1/sessions/${id}`);
    expect(status).toBe(409);
  });

  it('POST /v1/sessions/:id/interrupt sets state to idle', async () => {
    const { body: created } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'claude' });
    const id = (created as Record<string, unknown>)['session_id'] as string;

    deps.stateMachine.transition(id, 'running');

    const { status, body } = await apiPost(`${baseUrl}/v1/sessions/${id}/interrupt`, {});
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['status']).toBe('idle');
    expect((body as Record<string, unknown>)['interrupted']).toBe(true);
  });

  it('GET /v1/sessions filters by status query param', async () => {
    const { body: s1 } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'claude' });
    const { body: s2 } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'gpt-4' });
    const id2 = (s2 as Record<string, unknown>)['session_id'] as string;

    // Transition s2 to running
    deps.stateMachine.transition(id2, 'running');

    const { status, body } = await apiGet(`${baseUrl}/v1/sessions?status=running`);
    expect(status).toBe(200);
    const data = (body as { data: Array<Record<string, unknown>> }).data;
    expect(data.every((s) => s['status'] === 'running')).toBe(true);
    expect(data.some((s) => s['session_id'] === id2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — with GATEWAY_TOKEN auth
// ---------------------------------------------------------------------------

describe('Session Routes — with auth', () => {
  let db: DB;
  let deps: SessionRouteDeps;
  let server: Server;
  let baseUrl: string;
  const TOKEN = 'test-secret-token';

  beforeEach(async () => {
    process.env['GATEWAY_TOKEN'] = TOKEN;

    db = makeDb();
    deps = {
      store: new SqliteSessionStore(db),
      stateMachine: new SessionStateMachine(db),
    };
    const setup = await makeServer(deps);
    server = setup.server;
    baseUrl = setup.baseUrl;
  });

  afterEach(async () => {
    delete process.env['GATEWAY_TOKEN'];
    await closeServer(server);
    db.close();
  });

  it('returns 401 when no auth token provided', async () => {
    const { status } = await apiGet(`${baseUrl}/v1/sessions`);
    expect(status).toBe(401);
  });

  it('returns 401 when wrong token provided', async () => {
    const { status } = await apiGet(`${baseUrl}/v1/sessions`, 'wrong-token');
    expect(status).toBe(401);
  });

  it('returns 200 when correct token provided', async () => {
    const { status } = await apiGet(`${baseUrl}/v1/sessions`, TOKEN);
    expect(status).toBe(200);
  });

  it('POST /v1/sessions with auth creates session', async () => {
    const { status } = await apiPost(`${baseUrl}/v1/sessions`, { model: 'claude' }, TOKEN);
    expect(status).toBe(201);
  });
});
