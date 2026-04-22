/**
 * @file tests/federation/audit-chain-sign.test.ts
 * @description Wave 10H — AuditChainSync outbound signing tests.
 *
 * Tests:
 *   ACS-1  publishEvent with signer injected → captured fetch body has keyId,
 *          keyVersion, signature, signedAt; base fields unchanged.
 *   ACS-2  publishEvent with SUDO_FED_SIGN_DISABLE=1 → no signature fields.
 *   ACS-3  publishEvent with NO signer → no signature fields (backward compat).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AuditChainSync } from '../../src/core/federation/audit-chain-sync.js';
import { PeerRegistry } from '../../src/core/federation/peer-registry.js';
import type { ArtifactSigner } from '../../src/core/security/signer.js';
import type { SignedArtifact } from '../../src/core/shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInMemoryDb(): ReturnType<typeof Database> {
  return new Database(':memory:');
}

function makePeerRegistry(
  peers: Array<{ name: string; url: string; token: string }>,
): PeerRegistry {
  return new PeerRegistry(JSON.stringify(peers), undefined);
}

const INSTANCE_ID = 'test-sign-instance';

const TEST_PEERS = [
  { name: 'peer-sign-a', url: 'https://peer-sign-a.example.com:18900', token: 'tok_a' },
];

/** Create a minimal ArtifactSigner mock that returns deterministic signed artifacts. */
function makeMockSigner(): ArtifactSigner {
  const mockArtifact: SignedArtifact = {
    payload: {},
    signedAt: '2026-04-20T00:00:00.000Z',
    keyId: 'deadbeef',
    keyVersion: 2,
    signature: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' +
               'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    artifactType: 'federation_event',
  };

  return {
    sign: vi.fn().mockReturnValue(mockArtifact),
  } as unknown as ArtifactSigner;
}

/** Extract the parsed JSON body from the first call to the fetch mock. */
async function capturedBody(fetchMock: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  expect(fetchMock).toHaveBeenCalled();
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ACS-1: Signer injected → signature fields present
// ---------------------------------------------------------------------------

describe('AuditChainSync — signing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ACS-1: publishEvent with signer → fetch body contains signature fields', async () => {
    const db = makeInMemoryDb();
    const registry = makePeerRegistry(TEST_PEERS);
    const signer = makeMockSigner();

    const sync = new AuditChainSync(db, registry, INSTANCE_ID, signer);
    sync.publishEvent('federation_event', { action: 'test-payload' });

    // Wait for async fan-out
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    const body = await capturedBody(vi.mocked(fetch));

    // Signature fields must be present
    expect(body['keyId']).toBe('deadbeef');
    expect(body['keyVersion']).toBe(2);
    expect(typeof body['signature']).toBe('string');
    expect((body['signature'] as string).length).toBeGreaterThan(0);
    expect(typeof body['signedAt']).toBe('string');

    // Base FederatedEvent fields must be intact
    expect(body['instanceId']).toBe(INSTANCE_ID);
    expect(body['eventType']).toBe('federation_event');
    expect(body['payload']).toEqual({ action: 'test-payload' });
    expect(typeof body['id']).toBe('string');
    expect(typeof body['ts']).toBe('number');
    expect(typeof body['seq']).toBe('number');

    // Verify signer.sign was called with the payload and correct artifactType
    expect(signer.sign).toHaveBeenCalledWith(
      { action: 'test-payload' },
      'federation_event',
    );
  });

  // -------------------------------------------------------------------------
  // ACS-2: SUDO_FED_SIGN_DISABLE=1 → no signature fields
  // -------------------------------------------------------------------------

  it('ACS-2: publishEvent with SUDO_FED_SIGN_DISABLE=1 → no signature fields', async () => {
    // Save and restore env manually
    const saved = process.env['SUDO_FED_SIGN_DISABLE'];
    process.env['SUDO_FED_SIGN_DISABLE'] = '1';

    try {
      const db = makeInMemoryDb();
      const registry = makePeerRegistry(TEST_PEERS);
      const signer = makeMockSigner();

      const sync = new AuditChainSync(db, registry, INSTANCE_ID, signer);
      sync.publishEvent('federation_event', { action: 'no-sign' });

      await new Promise<void>(resolve => setTimeout(resolve, 50));

      const body = await capturedBody(vi.mocked(fetch));

      // Signature fields must NOT be present
      expect(body['keyId']).toBeUndefined();
      expect(body['signature']).toBeUndefined();
      expect(body['keyVersion']).toBeUndefined();
      expect(body['signedAt']).toBeUndefined();

      // Base fields must still be present
      expect(body['instanceId']).toBe(INSTANCE_ID);
      expect(body['eventType']).toBe('federation_event');

      // signer.sign must NOT have been called
      expect(signer.sign).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) {
        delete process.env['SUDO_FED_SIGN_DISABLE'];
      } else {
        process.env['SUDO_FED_SIGN_DISABLE'] = saved;
      }
    }
  });

  // -------------------------------------------------------------------------
  // ACS-3: No signer in constructor → no signature fields (backward compat)
  // -------------------------------------------------------------------------

  it('ACS-3: publishEvent with no signer → no signature fields (backward compat)', async () => {
    const db = makeInMemoryDb();
    const registry = makePeerRegistry(TEST_PEERS);

    // Construct WITHOUT signer (3-arg form — original API)
    const sync = new AuditChainSync(db, registry, INSTANCE_ID);
    sync.publishEvent('re-anchor', { trigger: 'test' });

    await new Promise<void>(resolve => setTimeout(resolve, 50));

    const body = await capturedBody(vi.mocked(fetch));

    // No signature fields
    expect(body['keyId']).toBeUndefined();
    expect(body['signature']).toBeUndefined();
    expect(body['keyVersion']).toBeUndefined();
    expect(body['signedAt']).toBeUndefined();

    // Base fields intact
    expect(body['instanceId']).toBe(INSTANCE_ID);
    expect(body['eventType']).toBe('re-anchor');
  });
});
