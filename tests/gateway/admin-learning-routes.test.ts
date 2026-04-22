/**
 * Tests for learning-routes.ts — Wave 10 Builder 2.
 *
 * Covers:
 *   - GET /v1/admin/learning/proposals — list with status filter
 *   - POST /v1/admin/learning/proposals/:id/approve
 *   - POST /v1/admin/learning/proposals/:id/reject
 *   - 401 auth enforcement
 *   - 404 for unknown proposal
 *   - 409 for already-approved
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { registerLearningRoutes } from '../../src/core/gateway/learning-routes.js';
import type { ProposalStoreLike } from '../../src/core/gateway/learning-routes.js';
import type { AgentConfigProposal } from '../../src/core/shared/wave10-types.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock ProposalStore
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<AgentConfigProposal> = {}): AgentConfigProposal {
  return {
    id:           randomUUID(),
    agentId:      'agent-001',
    rationale:    'Improve tool routing',
    delta:        { maxIterations: 200 },
    traceQuality: 0.85,
    traceCount:   12,
    status:       'pending',
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
    ...overrides,
  };
}

function makeStore(proposals: AgentConfigProposal[] = []): ProposalStoreLike {
  const items = [...proposals];
  return {
    list({ status, limit, offset }) {
      const filtered = status ? items.filter(p => p.status === status) : items;
      return { data: filtered.slice(offset, offset + limit), total: filtered.length };
    },
    approve(id: string) {
      const p = items.find(i => i.id === id);
      if (!p) throw new Error(`Not found: ${id}`);
      p.status = 'approved';
      p.updatedAt = new Date().toISOString();
      return p;
    },
    reject(id: string, reason?: string) {
      const p = items.find(i => i.id === id);
      if (!p) throw new Error(`Not found: ${id}`);
      p.status = 'rejected';
      p.updatedAt = new Date().toISOString();
      void reason;
      return p;
    },
    getById(id: string) {
      return items.find(i => i.id === id) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Server helper
// ---------------------------------------------------------------------------

interface TestServer { port: number; close: () => Promise<void> }

async function startServer(store: ProposalStoreLike, token?: string): Promise<TestServer> {
  const server  = http.createServer();
  const tokenBuf = token ? Buffer.from(token, 'utf8') : null;
  registerLearningRoutes(server, { proposalStore: store }, tokenBuf);

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const close = () => new Promise<void>((res, rej) =>
        server.close(e => e ? rej(e) : res()),
      );
      resolve({ port, close });
    });
    server.on('error', reject);
  });
}

async function doRequest(
  port:    number,
  method:  string,
  pathname: string,
  token?:  string,
  body?:   string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests — GET /v1/admin/learning/proposals
// ---------------------------------------------------------------------------

describe('GET /v1/admin/learning/proposals', () => {
  it('returns empty list when no proposals', async () => {
    const store = makeStore();
    const srv   = await startServer(store);
    const { status, body } = await doRequest(srv.port, 'GET', '/v1/admin/learning/proposals');
    expect(status).toBe(200);
    expect((body as { data: unknown[] }).data).toEqual([]);
    expect((body as { total: number }).total).toBe(0);
    await srv.close();
  });

  it('returns proposals list with total', async () => {
    const p1 = makeProposal({ status: 'pending' });
    const p2 = makeProposal({ status: 'approved' });
    const store = makeStore([p1, p2]);
    const srv   = await startServer(store);

    const { status, body } = await doRequest(srv.port, 'GET', '/v1/admin/learning/proposals');
    expect(status).toBe(200);
    expect((body as { data: unknown[]; total: number }).total).toBe(2);
    await srv.close();
  });

  it('filters by status=pending', async () => {
    const p1 = makeProposal({ status: 'pending' });
    const p2 = makeProposal({ status: 'approved' });
    const store = makeStore([p1, p2]);
    const srv   = await startServer(store);

    const { status, body } = await doRequest(srv.port, 'GET', '/v1/admin/learning/proposals?status=pending');
    expect(status).toBe(200);
    const b = body as { data: AgentConfigProposal[] };
    expect(b.data).toHaveLength(1);
    expect(b.data[0]!.status).toBe('pending');
    await srv.close();
  });

  it('returns 400 for invalid status', async () => {
    const store = makeStore();
    const srv   = await startServer(store);
    const { status } = await doRequest(srv.port, 'GET', '/v1/admin/learning/proposals?status=invalid');
    expect(status).toBe(400);
    await srv.close();
  });

  it('applies limit and offset params', async () => {
    const proposals = Array.from({ length: 10 }, () => makeProposal());
    const store     = makeStore(proposals);
    const srv       = await startServer(store);

    const { status, body } = await doRequest(srv.port, 'GET', '/v1/admin/learning/proposals?limit=3&offset=0');
    expect(status).toBe(200);
    expect((body as { data: unknown[] }).data).toHaveLength(3);
    await srv.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — POST approve/reject
// ---------------------------------------------------------------------------

describe('POST /v1/admin/learning/proposals/:id/approve', () => {
  it('approves a pending proposal', async () => {
    const p   = makeProposal({ status: 'pending' });
    const store = makeStore([p]);
    const srv   = await startServer(store);

    const { status, body } = await doRequest(
      srv.port, 'POST', `/v1/admin/learning/proposals/${p.id}/approve`, undefined, '{}',
    );
    expect(status).toBe(200);
    expect((body as { proposal: AgentConfigProposal }).proposal.status).toBe('approved');
    await srv.close();
  });

  it('returns 404 for unknown proposal', async () => {
    const store = makeStore();
    const srv   = await startServer(store);
    const { status } = await doRequest(
      srv.port, 'POST', `/v1/admin/learning/proposals/${randomUUID()}/approve`, undefined, '{}',
    );
    expect(status).toBe(404);
    await srv.close();
  });

  it('returns 409 when already approved', async () => {
    const p   = makeProposal({ status: 'approved' });
    const store = makeStore([p]);
    const srv   = await startServer(store);

    const { status } = await doRequest(
      srv.port, 'POST', `/v1/admin/learning/proposals/${p.id}/approve`, undefined, '{}',
    );
    expect(status).toBe(409);
    await srv.close();
  });
});

describe('POST /v1/admin/learning/proposals/:id/reject', () => {
  it('rejects a pending proposal', async () => {
    const p     = makeProposal({ status: 'pending' });
    const store = makeStore([p]);
    const srv   = await startServer(store);

    const { status, body } = await doRequest(
      srv.port, 'POST', `/v1/admin/learning/proposals/${p.id}/reject`, undefined,
      JSON.stringify({ reason: 'not relevant' }),
    );
    expect(status).toBe(200);
    expect((body as { proposal: AgentConfigProposal }).proposal.status).toBe('rejected');
    await srv.close();
  });

  it('returns 404 for unknown proposal', async () => {
    const store = makeStore();
    const srv   = await startServer(store);
    const { status } = await doRequest(
      srv.port, 'POST', `/v1/admin/learning/proposals/${randomUUID()}/reject`, undefined, '{}',
    );
    expect(status).toBe(404);
    await srv.close();
  });
});

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe('learning-routes — auth enforcement', () => {
  const TOKEN = 'learning-secret-token-32chars!!xy';

  it('returns 401 without token when auth required', async () => {
    const store = makeStore();
    const srv   = await startServer(store, TOKEN);
    const { status } = await doRequest(srv.port, 'GET', '/v1/admin/learning/proposals');
    expect(status).toBe(401);
    await srv.close();
  });

  it('returns 200 with correct token', async () => {
    const store = makeStore();
    const srv   = await startServer(store, TOKEN);
    const { status } = await doRequest(srv.port, 'GET', '/v1/admin/learning/proposals', TOKEN);
    expect(status).toBe(200);
    await srv.close();
  });
});
