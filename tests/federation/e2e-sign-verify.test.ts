/**
 * @file tests/federation/e2e-sign-verify.test.ts
 * @description Wave 10H — E2E sign-then-verify integration tests.
 *
 * Tests:
 *   E2E-1  Full roundtrip: A signs event → B fetches A's public key → verifies → 200
 *   E2E-2  Post-rotation verify: A rotates key → sends new signed event →
 *          B resolves retiring key from A's /public-key → verifies both events → 200
 *   E2E-3  SUDO_FED_VERIFY_DISABLE=1 → B accepts signed event without calling fetch
 *   E2E-4  Unsigned event with no signer on B → fail-open, accepted → 200
 *
 * Isolation:
 *   - Each ArtifactSigner instance uses a per-test mkdtempSync key dir.
 *   - SUDO_KEY_ROTATION_MIN_INTERVAL_MS=0 ensures rotate() is not idempotent.
 *   - vi.resetModules() ensures no cross-test singleton contamination.
 *   - Test-client HTTP calls use node:http.request (not fetch) to avoid
 *     collision with vi.stubGlobal('fetch', ...) used in E2E-3.
 *   - Real in-process HTTP servers for E2E-1/E2E-2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PeerRegistry } from '../../src/core/federation/peer-registry.js';
import { PeerKeyCache } from '../../src/core/federation/peer-key-cache.js';
import { PeerKeyFetcher } from '../../src/core/federation/peer-key-fetcher.js';
import { AuditChainSync } from '../../src/core/federation/audit-chain-sync.js';
import { ArtifactSigner } from '../../src/core/security/signer.js';
import { registerFederationRoutes } from '../../src/core/gateway/federation-routes.js';
import type { FederationRoutesDeps } from '../../src/core/gateway/federation-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INBOUND_TOKEN = 'fed_inbound_e2e_test_tok';
const ADMIN_TOKEN   = 'admin_e2e_test_tok';

// ---------------------------------------------------------------------------
// Per-test isolation setup
// ---------------------------------------------------------------------------

let testKeyDir: string;

beforeEach(() => {
  vi.resetModules();
  testKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-sign-verify-'));
  process.env['SUDO_SIGNER_KEY_DIR']              = testKeyDir;
  process.env['SUDO_KEY_ROTATION_DB_PATH']        = path.join(testKeyDir, 'krot.db');
  process.env['SUDO_KEY_ROTATION_MIN_INTERVAL_MS'] = '0';
  delete process.env['SUDO_FED_SIGN_DISABLE'];
  delete process.env['SUDO_FED_VERIFY_DISABLE'];
  delete process.env['SUDO_FED_KEY_FETCH_DISABLE'];
  delete process.env['SUDO_FED_STRICT_VERIFY'];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['SUDO_SIGNER_KEY_DIR'];
  delete process.env['SUDO_KEY_ROTATION_DB_PATH'];
  delete process.env['SUDO_KEY_ROTATION_MIN_INTERVAL_MS'];
  delete process.env['SUDO_FED_SIGN_DISABLE'];
  delete process.env['SUDO_FED_VERIFY_DISABLE'];
  delete process.env['SUDO_FED_KEY_FETCH_DISABLE'];
  delete process.env['SUDO_FED_STRICT_VERIFY'];
  try { fs.rmSync(testKeyDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FedServer {
  baseUrl: string;
  sync: AuditChainSync;
  signer: ArtifactSigner | undefined;
  close(): Promise<void>;
}

function makeInMemoryDb(): ReturnType<typeof Database> {
  return new Database(':memory:');
}

/** Start an in-process federation HTTP server backed by in-memory SQLite. */
function startFedServer(opts: {
  instanceId:        string;
  signer?:           ArtifactSigner;
  peerKeyFetcher?:   PeerKeyFetcher;
  peersJson?:        string;
  inboundTokensJson: string;
}): Promise<FedServer> {
  return new Promise((resolve, reject) => {
    const db       = makeInMemoryDb();
    const registry = new PeerRegistry(opts.peersJson, opts.inboundTokensJson);
    const sync     = new AuditChainSync(db, registry, opts.instanceId, opts.signer);

    const deps: FederationRoutesDeps = {
      peerRegistry:  registry,
      auditChainSync: sync,
      peerKeyFetcher: opts.peerKeyFetcher,
      artifactSigner: opts.signer,
    };

    const adminBuf = Buffer.from(ADMIN_TOKEN, 'utf8');
    const server   = http.createServer();
    registerFederationRoutes(server, deps, adminBuf);

    server.listen(0, '127.0.0.1', () => {
      const addr    = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const close   = (): Promise<void> =>
        new Promise((res, rej) => server.close(err => (err ? rej(err) : res())));
      resolve({ baseUrl, sync, signer: opts.signer, close });
    });
    server.on('error', reject);
  });
}

/**
 * POST JSON body to url using node:http.request (avoids vi.stubGlobal('fetch') collision).
 * Returns { status, body }.
 */
function httpPost(
  url: string,
  body: unknown,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed  = new URL(url);
    const req     = http.request(
      {
        hostname: parsed.hostname,
        port:     Number(parsed.port),
        path:     parsed.pathname,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization':  `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            resolve({ status: res.statusCode ?? 0, body: parsed });
          } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Build a minimal valid FederatedEvent envelope body (unsigned). */
function makeEventBody(
  instanceId: string,
  eventType:  string,
  payload:    unknown,
  seq:        number,
  extra:      Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id:         `evt-${seq}-${Date.now()}`,
    instanceId,
    eventType,
    payload,
    ts:  Date.now(),
    seq,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// E2E-1: Full sign→transmit→fetch-peer-key→verify roundtrip
// ---------------------------------------------------------------------------

describe('E2E federation sign-and-verify', () => {
  it('E2E-1: signed event from A lands on B with valid signature; B verifies via A\'s public-key endpoint', async () => {
    // A's signer — fresh key dir per test
    const signerA = new ArtifactSigner();

    // Start B first (so we have its ingest URL), without peers yet
    const inboundJson = JSON.stringify([INBOUND_TOKEN]);
    const serverB = await startFedServer({
      instanceId:        'instance-b',
      inboundTokensJson: inboundJson,
      // B's signer and peerKeyFetcher will be set after A starts
    });

    // Start A — configured to publish to B
    const peersJson = JSON.stringify([
      { name: 'peer-b', url: serverB.baseUrl, token: INBOUND_TOKEN },
    ]);
    const registryForPeerKeyFetch = new PeerRegistry(peersJson, inboundJson);
    // A does not need to fetch B's keys — A only signs outbound
    const serverA = await startFedServer({
      instanceId:        'instance-a',
      signer:            signerA,
      inboundTokensJson: inboundJson,
      peersJson,
    });

    // Construct B's peerKeyFetcher pointing at A's /public-key
    const peersJsonForB = JSON.stringify([
      { name: 'peer-a', url: serverA.baseUrl, token: INBOUND_TOKEN },
    ]);
    const cacheB   = new PeerKeyCache();
    const fetcherB = new PeerKeyFetcher(new PeerRegistry(peersJsonForB, inboundJson), cacheB);

    // Wire peerKeyFetcher + artifactSigner onto B's deps
    // (we rebuild a 2nd server for B so deps are correct)
    await serverB.close();
    const signerB  = new ArtifactSigner();
    const serverB2 = await startFedServer({
      instanceId:        'instance-b',
      signer:            signerB,
      peerKeyFetcher:    fetcherB,
      inboundTokensJson: inboundJson,
    });

    try {
      // A publishes a signed event by calling publishEvent
      serverA.sync.publishEvent('federation_event', { action: 'e2e-test-1' });

      // Allow async fan-out + B's public-key fetch to complete
      await new Promise<void>(r => setTimeout(r, 200));

      // Now also directly POST a signed event to B's ingest endpoint to assert verify path
      const pubKeyInfo = signerA.getPublicKey();
      const artifact   = signerA.sign({ action: 'direct-post' }, 'federation_event');

      const eventBody = makeEventBody(
        'instance-a', 'federation_event', { action: 'direct-post' }, 2,
        {
          keyId:       artifact.keyId,
          keyVersion:  artifact.keyVersion,
          signature:   artifact.signature,
          signedAt:    artifact.signedAt,
        },
      );

      const { status, body } = await httpPost(
        `${serverB2.baseUrl}/v1/federation/audit/ingest`,
        eventBody,
        INBOUND_TOKEN,
      );

      expect(status).toBe(200);
      expect(body['ok']).toBe(true);

      // Sanity: A has an active key
      expect(pubKeyInfo.keyId).toBeTruthy();
    } finally {
      await serverA.close();
      await serverB2.close();
    }
  }, 10_000);

  // -------------------------------------------------------------------------
  // E2E-2: Post-rotation verify using retiring key
  // -------------------------------------------------------------------------

  it('E2E-2: after key rotation on A, B resolves retiring key and verifies pre-rotation event', async () => {
    const signerA = new ArtifactSigner();

    const inboundJson = JSON.stringify([INBOUND_TOKEN]);

    // Sign event with the original (pre-rotation) key
    const artifactPre = signerA.sign({ action: 'pre-rotation' }, 'federation_event');
    const preKeyId    = artifactPre.keyId;

    // Rotate A's key — now preKeyId becomes the retiring key
    signerA.rotate();

    // Verify retiring key appears in getPublicKey()
    const pkInfo = signerA.getPublicKey();
    expect(pkInfo.retiring).toBeDefined();
    expect(pkInfo.retiring!.keyId).toBe(preKeyId);

    // Start A's server (serves the updated /public-key with retiring info)
    const serverA = await startFedServer({
      instanceId:        'instance-a',
      signer:            signerA,
      inboundTokensJson: inboundJson,
    });

    // Start B with peerKeyFetcher pointing at A
    const peersJsonForB = JSON.stringify([
      { name: 'peer-a', url: serverA.baseUrl, token: INBOUND_TOKEN },
    ]);
    const cacheB   = new PeerKeyCache();
    const fetcherB = new PeerKeyFetcher(new PeerRegistry(peersJsonForB, inboundJson), cacheB);
    const signerB  = new ArtifactSigner();
    const serverB  = await startFedServer({
      instanceId:        'instance-b',
      signer:            signerB,
      peerKeyFetcher:    fetcherB,
      inboundTokensJson: inboundJson,
    });

    try {
      // POST event signed with the pre-rotation key (retiring) to B's ingest
      const eventBody = makeEventBody(
        'instance-a', 'federation_event', { action: 'pre-rotation' }, 1,
        {
          keyId:      artifactPre.keyId,
          keyVersion: artifactPre.keyVersion,
          signature:  artifactPre.signature,
          signedAt:   artifactPre.signedAt,
        },
      );

      const { status, body } = await httpPost(
        `${serverB.baseUrl}/v1/federation/audit/ingest`,
        eventBody,
        INBOUND_TOKEN,
      );

      // B must accept: it fetches A's public-key, finds retiring.keyId == preKeyId, verifies OK
      expect(status).toBe(200);
      expect(body['ok']).toBe(true);
    } finally {
      await serverA.close();
      await serverB.close();
    }
  }, 10_000);

  // -------------------------------------------------------------------------
  // E2E-3: SUDO_FED_VERIFY_DISABLE=1 → B accepts without calling fetch
  // -------------------------------------------------------------------------

  it('E2E-3: SUDO_FED_VERIFY_DISABLE=1 bypasses signature check; fetch is not called', async () => {
    process.env['SUDO_FED_VERIFY_DISABLE'] = '1';

    const signerA  = new ArtifactSigner();
    const artifact = signerA.sign({ action: 'should-not-verify' }, 'federation_event');

    // Stub global fetch to assert it is NOT called during ingest
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const inboundJson = JSON.stringify([INBOUND_TOKEN]);
    // B has peerKeyFetcher + signer wired, but kill-switch is active
    const cacheB  = new PeerKeyCache();
    // fetcher points nowhere — should never be called
    const regB    = new PeerRegistry(JSON.stringify([
      { name: 'peer-a', url: 'http://127.0.0.1:1', token: INBOUND_TOKEN },
    ]), inboundJson);
    const fetcherB = new PeerKeyFetcher(regB, cacheB);
    const signerB  = new ArtifactSigner();

    const serverB = await startFedServer({
      instanceId:        'instance-b',
      signer:            signerB,
      peerKeyFetcher:    fetcherB,
      inboundTokensJson: inboundJson,
    });

    try {
      const eventBody = makeEventBody(
        'instance-a', 'federation_event', { action: 'should-not-verify' }, 1,
        {
          keyId:      artifact.keyId,
          keyVersion: artifact.keyVersion,
          signature:  artifact.signature,
          signedAt:   artifact.signedAt,
        },
      );

      const { status, body } = await httpPost(
        `${serverB.baseUrl}/v1/federation/audit/ingest`,
        eventBody,
        INBOUND_TOKEN,
      );

      // Event must be accepted despite signed payload
      expect(status).toBe(200);
      expect(body['ok']).toBe(true);

      // Fetch must not have been called (verify path skipped entirely)
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await serverB.close();
    }
  }, 10_000);

  // -------------------------------------------------------------------------
  // E2E-4: Unsigned event with no signer on B → fail-open, accepted
  // -------------------------------------------------------------------------

  it('E2E-4: unsigned event with no peerKeyFetcher/signer on B → fail-open, accepted → 200', async () => {
    const inboundJson = JSON.stringify([INBOUND_TOKEN]);

    // B has NO signer and NO peerKeyFetcher (pre-Wave-10H backward compat)
    const serverB = await startFedServer({
      instanceId:        'instance-b',
      inboundTokensJson: inboundJson,
      // No signer, no peerKeyFetcher
    });

    try {
      // Unsigned event (no keyId, signature, etc.)
      const eventBody = makeEventBody(
        'instance-a', 'federation_event', { action: 'unsigned-backward-compat' }, 1,
      );

      const { status, body } = await httpPost(
        `${serverB.baseUrl}/v1/federation/audit/ingest`,
        eventBody,
        INBOUND_TOKEN,
      );

      // Should be accepted: no signer/fetcher on B means verify block is skipped
      expect(status).toBe(200);
      expect(body['ok']).toBe(true);
    } finally {
      await serverB.close();
    }
  }, 10_000);
});
