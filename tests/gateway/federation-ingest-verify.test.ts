/**
 * @file tests/gateway/federation-ingest-verify.test.ts
 * @description Wave 10H tests for verify-on-ingest logic in POST /v1/federation/audit/ingest.
 *
 * Tests:
 *   FIV-1  Unsigned event, no peerKeyFetcher injected → 200 (backward compat)
 *   FIV-2  Unsigned event, SUDO_FED_STRICT_VERIFY=1 + fetcher+signer injected → 400 signature_required
 *   FIV-3  Signed event, valid sig, fetcher returns entry → 200 accepted
 *   FIV-4  Signed event, tampered sig (verifyWithPublicKey returns false after refetch) → 400 signature_invalid
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { registerFederationRoutes, type FederationRoutesDeps } from '../../src/core/gateway/federation-routes.js';
import { PeerRegistry } from '../../src/core/federation/peer-registry.js';
import { AuditChainSync } from '../../src/core/federation/audit-chain-sync.js';
import type { PeerKeyFetcher } from '../../src/core/federation/peer-key-fetcher.js';
import type { PeerKeyEntry } from '../../src/core/federation/peer-key-cache.js';
import type { ArtifactSigner } from '../../src/core/security/signer.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INBOUND_TOKEN = 'sk_fiv_inbound_test_789';
const INSTANCE_ID = 'fiv-test-instance';
const ADMIN_TOKEN_BUF = Buffer.from('fiv-admin-token', 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

let testServer: TestServer | undefined;

function makeBaseDb(): ReturnType<typeof Database> {
  return new Database(':memory:');
}

function makeDeps(opts?: {
  peerKeyFetcher?: PeerKeyFetcher;
  artifactSigner?: ArtifactSigner;
}): FederationRoutesDeps {
  const inboundTokens = JSON.stringify([INBOUND_TOKEN]);
  const peerRegistry = new PeerRegistry(undefined, inboundTokens);
  const db = makeBaseDb();
  const auditChainSync = new AuditChainSync(db, peerRegistry, INSTANCE_ID);
  return {
    peerRegistry,
    auditChainSync,
    peerKeyFetcher: opts?.peerKeyFetcher,
    artifactSigner: opts?.artifactSigner,
  };
}

function startServer(deps: FederationRoutesDeps): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    registerFederationRoutes(server, deps, ADMIN_TOKEN_BUF);
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

async function doPost(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${INBOUND_TOKEN}`,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

function makeValidUnsignedEvent(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `test-fiv-${Date.now()}`,
    instanceId: 'remote-peer-instance',
    eventType: 're-anchor',
    payload: { trigger: 'post-veto' },
    ts: Date.now(),
    seq: Math.ceil(Math.random() * 100000),
    ...overrides,
  };
}

function makeSignedEvent(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...makeValidUnsignedEvent(),
    keyId: 'deadbeef',
    keyVersion: 1,
    signature: 'fakesig0000',
    signedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockKeyEntry(): PeerKeyEntry {
  return {
    keyId: 'deadbeef',
    publicKeyDerHex: 'deadbeef' + '0'.repeat(56),
    peerName: 'peer-remote',
    fetchedAt: Date.now(),
  };
}

afterEach(async () => {
  if (testServer) {
    await testServer.close();
    testServer = undefined;
  }
  delete process.env['SUDO_FED_VERIFY_DISABLE'];
  delete process.env['SUDO_FED_STRICT_VERIFY'];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// FIV-1: Unsigned event, no peerKeyFetcher → 200 (backward compat legacy ingest path)
// ---------------------------------------------------------------------------

describe('FIV-1: unsigned event with no peerKeyFetcher → 200 accepted', () => {
  it('accepts unsigned events when peerKeyFetcher is not injected (backward compat)', async () => {
    const deps = makeDeps(); // no peerKeyFetcher, no artifactSigner
    testServer = await startServer(deps);

    const { status, json } = await doPost(
      `${testServer.baseUrl}/v1/federation/audit/ingest`,
      makeValidUnsignedEvent(),
    );

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { id: string; seq: number } };
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIV-2: Unsigned event, SUDO_FED_STRICT_VERIFY=1, peerKeyFetcher+signer injected → 400 signature_required
// ---------------------------------------------------------------------------

describe('FIV-2: unsigned event in strict mode → 400 signature_required', () => {
  it('rejects unsigned events when SUDO_FED_STRICT_VERIFY=1 and verify deps present', async () => {
    process.env['SUDO_FED_STRICT_VERIFY'] = '1';

    const mockFetcher = {
      fetchForKeyId: vi.fn().mockResolvedValue(null),
      refetchForKeyId: vi.fn().mockResolvedValue(null),
    } as unknown as PeerKeyFetcher;

    const mockSigner = {
      verifyWithPublicKey: vi.fn().mockReturnValue(false),
      getPublicKey: vi.fn(),
    } as unknown as ArtifactSigner;

    const deps = makeDeps({ peerKeyFetcher: mockFetcher, artifactSigner: mockSigner });
    testServer = await startServer(deps);

    // Send event with no signature fields
    const { status, json } = await doPost(
      `${testServer.baseUrl}/v1/federation/audit/ingest`,
      makeValidUnsignedEvent(), // no keyId/signature/signedAt/keyVersion
    );

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('signature_required');
  });
});

// ---------------------------------------------------------------------------
// FIV-3: Signed event, valid sig, fetcher returns entry → 200 accepted
// ---------------------------------------------------------------------------

describe('FIV-3: signed event with valid sig → 200 accepted', () => {
  it('accepts signed events when fetchForKeyId returns entry and verifyWithPublicKey is true', async () => {
    const keyEntry = makeMockKeyEntry();

    const mockFetcher = {
      fetchForKeyId: vi.fn().mockResolvedValue(keyEntry),
      refetchForKeyId: vi.fn().mockResolvedValue(keyEntry),
    } as unknown as PeerKeyFetcher;

    const mockSigner = {
      verifyWithPublicKey: vi.fn().mockReturnValue(true),
      getPublicKey: vi.fn(),
    } as unknown as ArtifactSigner;

    const deps = makeDeps({ peerKeyFetcher: mockFetcher, artifactSigner: mockSigner });
    testServer = await startServer(deps);

    const event = makeSignedEvent({ keyId: keyEntry.keyId });

    const { status, json } = await doPost(
      `${testServer.baseUrl}/v1/federation/audit/ingest`,
      event,
    );

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { id: string } };
    expect(body.ok).toBe(true);

    // Verify the fetcher was called with the correct keyId
    expect(mockFetcher.fetchForKeyId).toHaveBeenCalledWith(keyEntry.keyId);
    // Verify the signer was used
    expect(mockSigner.verifyWithPublicKey).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FIV-4: Signed event, tampered sig (verifyWithPublicKey returns false even after refetch) → 400 signature_invalid
// ---------------------------------------------------------------------------

describe('FIV-4: signed event with tampered sig → 400 signature_invalid', () => {
  it('rejects events when verifyWithPublicKey returns false even after refetch (hard reject)', async () => {
    const keyEntry = makeMockKeyEntry();

    const mockFetcher = {
      fetchForKeyId: vi.fn().mockResolvedValue(keyEntry),
      refetchForKeyId: vi.fn().mockResolvedValue(keyEntry),
    } as unknown as PeerKeyFetcher;

    // Always returns false — simulates tampered/invalid signature
    const mockSigner = {
      verifyWithPublicKey: vi.fn().mockReturnValue(false),
      getPublicKey: vi.fn(),
    } as unknown as ArtifactSigner;

    const deps = makeDeps({ peerKeyFetcher: mockFetcher, artifactSigner: mockSigner });
    testServer = await startServer(deps);

    const event = makeSignedEvent({ keyId: keyEntry.keyId });

    const { status, json } = await doPost(
      `${testServer.baseUrl}/v1/federation/audit/ingest`,
      event,
    );

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('signature_invalid');

    // Both initial fetch and refetch must have been attempted
    expect(mockFetcher.fetchForKeyId).toHaveBeenCalledWith(keyEntry.keyId);
    expect(mockFetcher.refetchForKeyId).toHaveBeenCalledWith(keyEntry.keyId);
    // verifyWithPublicKey called twice (initial + after refetch)
    expect(mockSigner.verifyWithPublicKey).toHaveBeenCalledTimes(2);
  });
});
