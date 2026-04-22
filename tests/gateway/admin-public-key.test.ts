/**
 * @file tests/gateway/admin-public-key.test.ts
 * @description Wave 10F tests for GET /v1/admin/public-key endpoint.
 *
 * Tests:
 *   PK-1  200 + correct shape when authenticated (Wave 10G: also asserts keyVersion)
 *   PK-2  401 without Bearer token (when tokenBuf is set)
 *   PK-3  401 with wrong Bearer token
 *
 * Wave 10G QE fix: SUDO_KEY_ROTATION_DB_PATH set per-test for DB isolation so
 * the ArtifactSigner singleton used by admin-routes does not touch the prod DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Key-dir isolation — each test suite gets its own key dir to avoid singleton
// caching the prod keypair.
// ---------------------------------------------------------------------------

let testKeyDir: string;

beforeEach(() => {
  vi.resetModules();
  testKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-pk-test-'));
  process.env['SUDO_SIGNER_KEY_DIR'] = testKeyDir;
  process.env['SUDO_KEY_ROTATION_DB_PATH'] = path.join(testKeyDir, 'key-rotation.db');
});

afterEach(async () => {
  delete process.env['SUDO_SIGNER_KEY_DIR'];
  delete process.env['SUDO_KEY_ROTATION_DB_PATH'];
  try { fs.rmSync(testKeyDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  if (testServer) { await testServer.close(); testServer = undefined; }
});

// ---------------------------------------------------------------------------
// Minimal deps — only the audit/inspection fields required by registerAdminRoutes
// ---------------------------------------------------------------------------

async function buildMinimalDeps() {
  const { } = await import('../../src/core/gateway/admin-routes.js');
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* noop */ },
    },
  };
}

// ---------------------------------------------------------------------------
// Test server helpers
// ---------------------------------------------------------------------------

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

let testServer: TestServer | undefined;

async function startServer(tokenBuf: Buffer | null): Promise<TestServer> {
  // Dynamic import so the server gets a fresh signer singleton with per-test env vars
  const { registerAdminRoutes } = await import('../../src/core/gateway/admin-routes.js');
  const deps = await buildMinimalDeps();
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    registerAdminRoutes(server, deps as Parameters<typeof registerAdminRoutes>[1], tokenBuf);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const close = (): Promise<void> =>
        new Promise((res, rej) => server.close((err) => (err ? rej(err) : res())));
      resolve({ baseUrl, close });
    });
    server.on('error', reject);
  });
}

interface FetchResult { status: number; json<T>(): T }

async function doGet(url: string, token?: string): Promise<FetchResult> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  return { status: res.status, json<T>(): T { return JSON.parse(text) as T; } };
}

// ---------------------------------------------------------------------------
// PK-1: 200 + correct shape when authenticated
// ---------------------------------------------------------------------------

describe('PK-1: GET /v1/admin/public-key — 200 + correct shape', () => {
  it('returns ok:true with keyId, algorithm, publicKey, and keyVersion fields', async () => {
    const TOKEN = 'wave10f-pk-test-token';
    testServer = await startServer(Buffer.from(TOKEN, 'utf8'));

    const result = await doGet(`${testServer.baseUrl}/v1/admin/public-key`, TOKEN);

    expect(result.status).toBe(200);
    const body = result.json<{ ok: boolean; data: Record<string, unknown> }>();
    expect(body.ok).toBe(true);

    const data = body.data;
    expect(data).toHaveProperty('keyId');
    expect(data).toHaveProperty('algorithm', 'ed25519');
    expect(data).toHaveProperty('publicKey');

    // keyId must be exactly 8 hex chars
    expect(typeof data['keyId']).toBe('string');
    expect(data['keyId'] as string).toMatch(/^[0-9a-f]{8}$/);

    // publicKey must be a non-empty hex string
    expect(typeof data['publicKey']).toBe('string');
    expect((data['publicKey'] as string).length).toBeGreaterThan(0);
    expect(data['publicKey'] as string).toMatch(/^[0-9a-f]+$/);

    // publicKey chars [24..32) equal keyId (Wave 10G Decision 3: skip 12-byte DER/SPKI prefix)
    expect((data['publicKey'] as string).slice(24, 32)).toBe(data['keyId'] as string);

    // KR-15 (PK-1): keyVersion must be a positive integer in Wave 10G+
    expect(typeof data['keyVersion']).toBe('number');
    expect(data['keyVersion'] as number).toBeGreaterThan(0);

    // retiring field is optional (absent on fresh install — no prior rotation)
    // If present, it must have the expected shape
    if (data['retiring'] !== undefined) {
      const retiring = data['retiring'] as Record<string, unknown>;
      expect(typeof retiring['keyId']).toBe('string');
      expect(typeof retiring['keyVersion']).toBe('number');
      expect(typeof retiring['publicKey']).toBe('string');
      expect(typeof retiring['retiredAt']).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// PK-2: 401 without Bearer token
// ---------------------------------------------------------------------------

describe('PK-2: GET /v1/admin/public-key — 401 without auth', () => {
  it('returns 401 when no Bearer token is provided and tokenBuf is set', async () => {
    const TOKEN = 'wave10f-pk-required';
    testServer = await startServer(Buffer.from(TOKEN, 'utf8'));

    // No Authorization header
    const result = await doGet(`${testServer.baseUrl}/v1/admin/public-key`);

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PK-3: 401 with wrong Bearer token
// ---------------------------------------------------------------------------

describe('PK-3: GET /v1/admin/public-key — 401 with wrong token', () => {
  it('returns 401 when an incorrect Bearer token is provided', async () => {
    const TOKEN = 'wave10f-pk-correct-token';
    testServer = await startServer(Buffer.from(TOKEN, 'utf8'));

    const result = await doGet(`${testServer.baseUrl}/v1/admin/public-key`, 'wrong-token-here');

    expect(result.status).toBe(401);
  });
});
