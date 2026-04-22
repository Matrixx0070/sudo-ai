/**
 * @file skill-optimizer-rest.test.ts
 * @description REST endpoint tests for Wave 13 SkillOptimizer admin routes.
 *
 * Tests:
 *   SO-R-1  GET /v1/admin/skills/optimizations returns 200 with data when store present
 *   SO-R-2  GET /v1/admin/skills/optimizations returns 503 when store absent
 *   SO-R-3  POST /v1/admin/skills/optimizations/:id/approve returns 200 on valid id
 *   SO-R-4  POST /v1/admin/skills/optimizations/:id/approve returns 404 on unknown id
 *   SO-R-5  POST /v1/admin/skills/optimizations/:id/reject with reason returns 200
 *   SO-R-6  GET returns 401 when token is wrong
 *   SO-R-7  POST /v1/admin/skills/optimizations/:id/reject returns 503 when store absent
 *
 * Wave 13 Builder 1.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import { SkillOptimizationStore } from '../../src/core/skills/skill-optimization-store.js';
import type { AddressInfo } from 'node:net';
import type { SkillOptimizationProposal } from '../../src/core/shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-optimizer-rest-token';

function makeTokenBuf(): Buffer {
  return Buffer.from(VALID_TOKEN, 'utf8');
}

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${VALID_TOKEN}` };
}

function makeProposal(overrides: Partial<SkillOptimizationProposal> = {}): SkillOptimizationProposal {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    skillId: 'skill-abc',
    skillName: 'test-skill',
    targetField: 'description',
    currentValue: 'old description',
    proposedValue: 'new description',
    evidence: 'test evidence',
    confidence: 0.7,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildBaseDeps(store?: AdminRoutesDeps['skillOptimizationStore']): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
      recordTriple: () => { /* no-op */ },
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* no-op */ },
    },
    skillOptimizationStore: store,
  };
}

async function startServer(deps: AdminRoutesDeps, tokenBuf: Buffer | null = makeTokenBuf()): Promise<{
  baseUrl: string;
  server: http.Server;
}> {
  const server = http.createServer();
  registerAdminRoutes(server, deps, tokenBuf);
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
    server.on('error', reject);
  });
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const serverRefs: http.Server[] = [];
const dbPaths: string[] = [];

afterEach(() => {
  for (const s of serverRefs.splice(0)) {
    s.close();
  }
  for (const p of dbPaths.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

describe('GET /v1/admin/skills/optimizations', () => {
  it('SO-R-1: returns 200 with data array when store present', async () => {
    const dbPath = path.join(os.tmpdir(), `so-rest-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const store = new SkillOptimizationStore(dbPath);
    const p = makeProposal();
    store.save(p);

    const { baseUrl, server } = await startServer(buildBaseDeps(store));
    serverRefs.push(server);

    const res = await fetch(`${baseUrl}/v1/admin/skills/optimizations`, {
      headers: authHeader(),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['ok']).toBe(true);
    expect(Array.isArray(body['data'])).toBe(true);
    expect(typeof body['total']).toBe('number');
    expect(body['total']).toBe(1);
    store.close();
  });

  it('SO-R-2: returns 503 when skillOptimizationStore is absent', async () => {
    const { baseUrl, server } = await startServer(buildBaseDeps(undefined));
    serverRefs.push(server);

    const res = await fetch(`${baseUrl}/v1/admin/skills/optimizations`, {
      headers: authHeader(),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(503);
    expect(body['ok']).toBe(false);
    expect(typeof body['error']).toBe('string');
  });

  it('SO-R-6: returns 401 when token is wrong', async () => {
    const dbPath = path.join(os.tmpdir(), `so-rest-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const store = new SkillOptimizationStore(dbPath);
    const { baseUrl, server } = await startServer(buildBaseDeps(store));
    serverRefs.push(server);

    const res = await fetch(`${baseUrl}/v1/admin/skills/optimizations`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
    store.close();
  });
});

describe('POST /v1/admin/skills/optimizations/:id/approve', () => {
  it('SO-R-3: returns 200 with updated proposal on valid id', async () => {
    const dbPath = path.join(os.tmpdir(), `so-rest-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const store = new SkillOptimizationStore(dbPath);
    const p = makeProposal();
    store.save(p);

    const { baseUrl, server } = await startServer(buildBaseDeps(store));
    serverRefs.push(server);

    const res = await fetch(`${baseUrl}/v1/admin/skills/optimizations/${p.id}/approve`, {
      method: 'POST',
      headers: authHeader(),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['ok']).toBe(true);
    const data = body['data'] as Record<string, unknown>;
    expect(data['status']).toBe('approved');
    store.close();
  });

  it('SO-R-4: returns 404 on unknown id', async () => {
    const dbPath = path.join(os.tmpdir(), `so-rest-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const store = new SkillOptimizationStore(dbPath);

    const { baseUrl, server } = await startServer(buildBaseDeps(store));
    serverRefs.push(server);

    const res = await fetch(`${baseUrl}/v1/admin/skills/optimizations/nonexistent-id/approve`, {
      method: 'POST',
      headers: authHeader(),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body['ok']).toBe(false);
    store.close();
  });
});

describe('POST /v1/admin/skills/optimizations/:id/reject', () => {
  it('SO-R-5: returns 200 with reason on valid id', async () => {
    const dbPath = path.join(os.tmpdir(), `so-rest-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const store = new SkillOptimizationStore(dbPath);
    const p = makeProposal();
    store.save(p);

    const { baseUrl, server } = await startServer(buildBaseDeps(store));
    serverRefs.push(server);

    const res = await fetch(`${baseUrl}/v1/admin/skills/optimizations/${p.id}/reject`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'not relevant' }),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['ok']).toBe(true);
    const data = body['data'] as Record<string, unknown>;
    expect(data['status']).toBe('rejected');
    store.close();
  });

  it('SO-R-7: returns 503 when skillOptimizationStore absent', async () => {
    const { baseUrl, server } = await startServer(buildBaseDeps(undefined));
    serverRefs.push(server);

    const res = await fetch(`${baseUrl}/v1/admin/skills/optimizations/some-id/reject`, {
      method: 'POST',
      headers: authHeader(),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(503);
    expect(body['ok']).toBe(false);
  });
});
