/**
 * @file tests/gateway/federation-public-key.test.ts
 * @description Wave 10H tests for GET /v1/federation/public-key endpoint.
 *
 * Tests:
 *   FPK-1  GET without Authorization header → 401
 *   FPK-2  GET with valid federation bearer + injected artifactSigner → 200 correct shape
 *   FPK-3  GET with SUDO_FED_VERIFY_DISABLE=1 → still 200 (kill-switch does not gate key export)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { registerFederationRoutes, type FederationRoutesDeps } from '../../src/core/gateway/federation-routes.js';
import { PeerRegistry } from '../../src/core/federation/peer-registry.js';
import { AuditChainSync } from '../../src/core/federation/audit-chain-sync.js';
import type { ArtifactSigner } from '../../src/core/security/signer.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INBOUND_TOKEN = 'sk_fpk_inbound_test_456';
const INSTANCE_ID = 'fpk-test-instance';

// ---------------------------------------------------------------------------
// Mock signer
// ---------------------------------------------------------------------------

function makeMockSigner(): ArtifactSigner {
  return {
    getPublicKey: vi.fn().mockReturnValue({
      keyId: 'abcd1234',
      keyVersion: 1,
      algorithm: 'ed25519',
      publicKey: 'abcd1234' + 'a'.repeat(56),
      generatedAt: '2026-04-20T00:00:00.000Z',
    }),
    sign: vi.fn(),
    verify: vi.fn(),
    verifyWithPublicKey: vi.fn(),
    rotate: vi.fn(),
  } as unknown as ArtifactSigner;
}

// ---------------------------------------------------------------------------
// Test server helpers
// ---------------------------------------------------------------------------

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

let testServer: TestServer | undefined;

function makeDepsWithSigner(mockSigner?: ArtifactSigner): FederationRoutesDeps {
  const inboundTokens = JSON.stringify([INBOUND_TOKEN]);
  const peerRegistry = new PeerRegistry(undefined, inboundTokens);
  const db = new Database(':memory:');
  const auditChainSync = new AuditChainSync(db, peerRegistry, INSTANCE_ID);
  return {
    peerRegistry,
    auditChainSync,
    artifactSigner: mockSigner,
  };
}

function startServer(deps: FederationRoutesDeps): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    registerFederationRoutes(server, deps, null);
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

async function doGet(url: string, token?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { method: 'GET', headers });
  return { status: resp.status, json: await resp.json() };
}

afterEach(async () => {
  if (testServer) {
    await testServer.close();
    testServer = undefined;
  }
  delete process.env['SUDO_FED_VERIFY_DISABLE'];
});

// ---------------------------------------------------------------------------
// FPK-1: GET without Authorization header → 401
// ---------------------------------------------------------------------------

describe('FPK-1: GET /v1/federation/public-key — 401 without auth', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const deps = makeDepsWithSigner(makeMockSigner());
    testServer = await startServer(deps);

    const { status, json } = await doGet(`${testServer.baseUrl}/v1/federation/public-key`);

    expect(status).toBe(401);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FPK-2: GET with valid federation bearer + injected artifactSigner → 200 correct shape
// ---------------------------------------------------------------------------

describe('FPK-2: GET /v1/federation/public-key — 200 correct shape', () => {
  it('returns ok:true with keyId, keyVersion, algorithm, publicKey, generatedAt', async () => {
    const mockSigner = makeMockSigner();
    const deps = makeDepsWithSigner(mockSigner);
    testServer = await startServer(deps);

    const { status, json } = await doGet(
      `${testServer.baseUrl}/v1/federation/public-key`,
      INBOUND_TOKEN,
    );

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);

    const data = body.data;
    expect(data).toHaveProperty('keyId', 'abcd1234');
    expect(data).toHaveProperty('keyVersion', 1);
    expect(data).toHaveProperty('algorithm', 'ed25519');
    expect(data).toHaveProperty('publicKey');
    expect(data).toHaveProperty('generatedAt');
    expect(typeof data['publicKey']).toBe('string');
    expect((data['publicKey'] as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FPK-3: GET with SUDO_FED_VERIFY_DISABLE=1 → still 200 (kill-switch does not gate key export)
// ---------------------------------------------------------------------------

describe('FPK-3: GET /v1/federation/public-key — 200 even with SUDO_FED_VERIFY_DISABLE=1', () => {
  it('returns 200 when kill-switch is set (key export is not gated by verify kill-switch)', async () => {
    process.env['SUDO_FED_VERIFY_DISABLE'] = '1';

    const mockSigner = makeMockSigner();
    const deps = makeDepsWithSigner(mockSigner);
    testServer = await startServer(deps);

    const { status, json } = await doGet(
      `${testServer.baseUrl}/v1/federation/public-key`,
      INBOUND_TOKEN,
    );

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty('algorithm', 'ed25519');
  });
});
