/**
 * @file tests/security/key-rotation.test.ts
 * @description Wave 10G key rotation tests — KR-1 through KR-13 + KR-5b.
 *
 * Isolation pattern (CRITICAL):
 *  - vi.resetModules() in beforeEach (fresh signer singleton per test).
 *  - Per-test mkdtempSync directories set via SUDO_SIGNER_KEY_DIR + SUDO_KEY_ROTATION_DB_PATH.
 *  - SUDO_KEY_ROTATION_MIN_INTERVAL_MS="0" in beforeEach (override per-test for KR-5).
 *  - afterEach: unset env vars + fs.rmSync tempdir.
 *  - NEVER uses default data/keys/key-rotation.db (prod DB).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

let testKeyDir: string;
let testDbPath: string;

beforeEach(() => {
  vi.resetModules();
  testKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-test-'));
  testDbPath = path.join(testKeyDir, 'key-rotation.db');
  process.env['SUDO_SIGNER_KEY_DIR'] = testKeyDir;
  process.env['SUDO_KEY_ROTATION_DB_PATH'] = testDbPath;
  // Default: allow rapid rotation in tests (idempotency guard disabled)
  process.env['SUDO_KEY_ROTATION_MIN_INTERVAL_MS'] = '0';
  // Clear all kill-switches
  delete process.env['SUDO_KEY_ROTATION_DISABLE'];
  delete process.env['SUDO_DUAL_VERIFY_DISABLE'];
  delete process.env['SUDO_SIGNING_DISABLE'];
});

afterEach(() => {
  delete process.env['SUDO_SIGNER_KEY_DIR'];
  delete process.env['SUDO_KEY_ROTATION_DB_PATH'];
  delete process.env['SUDO_KEY_ROTATION_MIN_INTERVAL_MS'];
  delete process.env['SUDO_KEY_ROTATION_DISABLE'];
  delete process.env['SUDO_DUAL_VERIFY_DISABLE'];
  delete process.env['SUDO_SIGNING_DISABLE'];
  try { fs.rmSync(testKeyDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
});

// ---------------------------------------------------------------------------
// Helper: write legacy wave10-signer.{pub,priv} files into a directory
// ---------------------------------------------------------------------------
function writeLegacyKeys(keyDir: string): { pubHex: string; privHex: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const pubHex = (publicKey as Buffer).toString('hex');
  const privHex = (privateKey as Buffer).toString('hex');
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(path.join(keyDir, 'wave10-signer.pub'), pubHex, { encoding: 'utf8', mode: 0o644 });
  fs.writeFileSync(path.join(keyDir, 'wave10-signer.priv'), privHex, { encoding: 'utf8', mode: 0o600 });
  return { pubHex, privHex };
}

// ---------------------------------------------------------------------------
// Helper: start an admin HTTP server with per-test env (dynamic import required)
// ---------------------------------------------------------------------------
interface AdminTestServer { port: number; close: () => Promise<void> }

async function startAdminHttpServer(token: string): Promise<AdminTestServer> {
  const { registerAdminRoutes } = await import('../../src/core/gateway/admin-routes.js');
  const server = http.createServer();
  registerAdminRoutes(
    server,
    {
      auditTrail: { verifyChain: () => ({ ok: true, rowsChecked: 0 }) },
      inspectionQueue: { query: () => [], updateStatus: () => {} },
    } as Parameters<typeof registerAdminRoutes>[1],
    Buffer.from(token, 'utf8'),
  );
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())) });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// KR-1: Migration — legacy wave10-signer.{pub,priv} promoted to v1 on construction
// ---------------------------------------------------------------------------

describe('KR-1: legacy migration promoted to v1 row', () => {
  it('constructing ArtifactSigner with legacy files creates v1 active row and v1 key files', async () => {
    // Write legacy files before constructing signer
    writeLegacyKeys(testKeyDir);

    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const { KeyRotationStore } = await import('../../src/core/security/key-rotation-store.js');

    new ArtifactSigner(); // constructor triggers migration

    // DB should have v1 active row
    const store = new KeyRotationStore(testDbPath);
    const active = store.getActive();
    expect(active).not.toBeNull();
    expect(active!.key_version).toBe(1);
    expect(active!.status).toBe('active');

    // wave10-signer-v1.{pub,priv} should exist in key dir
    expect(fs.existsSync(path.join(testKeyDir, 'wave10-signer-v1.priv'))).toBe(true);
    expect(fs.existsSync(path.join(testKeyDir, 'wave10-signer-v1.pub'))).toBe(true);

    // Legacy files are KEPT for rollback safety (copies not moves per spec §1 decision 4)
    expect(fs.existsSync(path.join(testKeyDir, 'wave10-signer.pub'))).toBe(true);
    expect(fs.existsSync(path.join(testKeyDir, 'wave10-signer.priv'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// KR-2: rotate() generates v2, returns correct metadata
// ---------------------------------------------------------------------------

describe('KR-2: rotate() generates v2 keypair and returns metadata', () => {
  it('after seeding v1, rotate() returns keyVersion:2 with correct shape', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    // Seed v1 via sign()
    signer.sign({ seed: true }, 'generic');

    // Rotate to v2
    const result = signer.rotate();

    expect(result.keyVersion).toBe(2);
    expect(result.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(result.algorithm).toBe('ed25519');
    expect(typeof result.generatedAt).toBe('string');
    expect(result.retiredKeyVersion).toBe(1);
    expect(typeof result.retiredKeyId).toBe('string');
    expect(result.idempotent).toBe(false);

    // v2.priv must exist
    expect(fs.existsSync(path.join(testKeyDir, 'wave10-signer-v2.priv'))).toBe(true);

    // v1.priv must be deleted (best-effort delete after successful rotation)
    expect(fs.existsSync(path.join(testKeyDir, 'wave10-signer-v1.priv'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KR-3: retiring transition — v1 status becomes 'retiring' after rotate()
// ---------------------------------------------------------------------------

describe('KR-3: v1 status is retiring after rotate()', () => {
  it('after rotate(), v1 row has status=retiring and retired_at approx 24h from now', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const { KeyRotationStore } = await import('../../src/core/security/key-rotation-store.js');
    const signer = new ArtifactSigner();
    signer.sign({ seed: true }, 'generic');
    signer.rotate();

    const store = new KeyRotationStore(testDbPath);
    const v1 = store.getByVersion(1);
    expect(v1).not.toBeNull();
    expect(v1!.status).toBe('retiring');
    expect(v1!.retired_at).not.toBeNull();

    // retired_at should be approximately 24h from now (within 5 second tolerance)
    const retiredAtMs = Date.parse(v1!.retired_at!);
    const expectedMs = Date.now() + 24 * 3600 * 1000;
    expect(Math.abs(retiredAtMs - expectedMs)).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// KR-4: old priv deleted, new priv exists at 0600 after rotate()
// ---------------------------------------------------------------------------

describe('KR-4: priv file transitions after rotate()', () => {
  it('v1.priv deleted, v2.priv exists with mode 0600 after rotate()', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    signer.sign({ seed: true }, 'generic');

    // Confirm v1.priv exists before rotate
    expect(fs.existsSync(path.join(testKeyDir, 'wave10-signer-v1.priv'))).toBe(true);

    signer.rotate();

    // v1.priv must be gone
    expect(fs.existsSync(path.join(testKeyDir, 'wave10-signer-v1.priv'))).toBe(false);

    // v2.priv must exist with strict 0600 permissions
    const v2PrivPath = path.join(testKeyDir, 'wave10-signer-v2.priv');
    expect(fs.existsSync(v2PrivPath)).toBe(true);
    const stat = fs.statSync(v2PrivPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// KR-5: Idempotency — second rotate() within 60s returns idempotent=true
// ---------------------------------------------------------------------------

describe('KR-5: second rotate() within 60s window returns idempotent:true', () => {
  it('with MIN_INTERVAL_MS=60000, second call returns same keyVersion + idempotent:true', async () => {
    process.env['SUDO_KEY_ROTATION_MIN_INTERVAL_MS'] = '60000';

    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const { KeyRotationStore } = await import('../../src/core/security/key-rotation-store.js');
    const signer = new ArtifactSigner();
    signer.sign({ seed: true }, 'generic');

    const r1 = signer.rotate();
    expect(r1.idempotent).toBe(false);
    expect(r1.keyVersion).toBe(2);

    // Second call within window — must be idempotent
    const r2 = signer.rotate();
    expect(r2.idempotent).toBe(true);
    expect(r2.keyVersion).toBe(2);
    expect(r2.keyId).toBe(r1.keyId);

    // DB must NOT have a v3 row
    const store = new KeyRotationStore(testDbPath);
    const v3 = store.getByVersion(3);
    expect(v3).toBeNull();

    // v2 must still be active
    const active = store.getActive();
    expect(active!.key_version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// KR-5b: Two successive rotates with MIN_INTERVAL_MS=0 create v2 then v3
// ---------------------------------------------------------------------------

describe('KR-5b: successive rotate() calls with MIN_INTERVAL_MS=0 create sequential versions', () => {
  it('with MIN_INTERVAL_MS=0, two rotate() calls produce v2 then v3', async () => {
    // MIN_INTERVAL_MS already "0" from beforeEach — confirms no idempotency guard
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const { KeyRotationStore } = await import('../../src/core/security/key-rotation-store.js');
    const signer = new ArtifactSigner();
    signer.sign({ seed: true }, 'generic');

    const r1 = signer.rotate();
    expect(r1.keyVersion).toBe(2);
    expect(r1.idempotent).toBe(false);

    const r2 = signer.rotate();
    expect(r2.keyVersion).toBe(3);
    expect(r2.idempotent).toBe(false);

    // DB: v3 is active, v2 is retiring
    const store = new KeyRotationStore(testDbPath);
    const active = store.getActive();
    expect(active!.key_version).toBe(3);

    const v2 = store.getByVersion(2);
    expect(v2!.status).toBe('retiring');
  });
});

// ---------------------------------------------------------------------------
// KR-6: verify() accepts artifact signed with retiring key (24h window)
// ---------------------------------------------------------------------------

describe('KR-6: verify() accepts artifact signed by retiring key within window', () => {
  it('artifact signed by v1 (now retiring) still verifies valid=true within 24h window', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    // Sign with v1 (before rotation)
    const artifact = signer.sign({ verify_me: true }, 'generic');
    expect(artifact.keyVersion).toBe(1);

    // Rotate to v2 — v1 becomes retiring (24h window)
    signer.rotate();

    // Verify artifact signed by retiring v1 — must still be valid within window
    const result = signer.verify(artifact);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// KR-7: verify() rejects artifact when retiring key's retired_at has passed
// ---------------------------------------------------------------------------

describe('KR-7: verify() rejects artifact when retiring window has expired', () => {
  it('artifact with a manually-expired retiring key fails with error containing "retired"', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    // Seed v1 and sign
    const artifact = signer.sign({ will_expire: true }, 'generic');
    expect(artifact.keyVersion).toBe(1);

    // Rotate — v1 becomes retiring (future 24h window)
    signer.rotate();

    // Manually force-expire v1 by setting retired_at to 2 minutes ago in the DB
    const db = new Database(testDbPath);
    const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE key_rotation_log SET status = 'retired', retired_at = ? WHERE key_version = 1`,
    ).run(twoMinsAgo);
    db.close();

    // Now verify — should reject with 'retired' in error
    const result = signer.verify(artifact);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/retired/i);
  });
});

// ---------------------------------------------------------------------------
// KR-8: verify() rejects artifact with unknown keyVersion
// ---------------------------------------------------------------------------

describe('KR-8: verify() rejects artifact with unknown keyVersion', () => {
  it('artifact with keyVersion:999 not in DB fails with valid=false', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    const realArtifact = signer.sign({ x: 1 }, 'generic');

    // Override both keyVersion and keyId to non-existent values
    const badArtifact = { ...realArtifact, keyVersion: 999, keyId: 'deadbeef' };
    const result = signer.verify(badArtifact);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// KR-9: SUDO_DUAL_VERIFY_DISABLE=1 blocks verification of retiring key
// ---------------------------------------------------------------------------

describe('KR-9: SUDO_DUAL_VERIFY_DISABLE=1 blocks retiring-key verification', () => {
  it('with SUDO_DUAL_VERIFY_DISABLE=1, artifact signed by retiring v1 fails verify', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    // Sign with v1
    const artifact = signer.sign({ dual: false }, 'generic');
    expect(artifact.keyVersion).toBe(1);

    // Rotate — v1 becomes retiring
    signer.rotate();

    // Enable dual-verify kill-switch
    process.env['SUDO_DUAL_VERIFY_DISABLE'] = '1';

    // Verify artifact signed by now-retiring v1 — must fail
    const result = signer.verify(artifact);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/dual verify disabled/i);
  });
});

// ---------------------------------------------------------------------------
// KR-10: sign() after rotate() uses new active key (v2)
// ---------------------------------------------------------------------------

describe('KR-10: sign() after rotate() uses new active key', () => {
  it('artifact signed after rotate() has keyVersion:2 and verifies as valid', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    // Seed v1
    signer.sign({ seed: true }, 'generic');

    // Rotate to v2
    signer.rotate();

    // New sign() should use v2
    const artifact = signer.sign({ post_rotate: true }, 'generic');
    expect(artifact.keyVersion).toBe(2);

    // Verify should be valid
    const result = signer.verify(artifact);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// KR-11: POST /v1/admin/key/rotate → 200 with correct shape
// ---------------------------------------------------------------------------

describe('KR-11: POST /v1/admin/key/rotate — 200 with correct response shape', () => {
  it('returns ok:true with keyId, keyVersion, algorithm, generatedAt, idempotent fields', async () => {
    const TOKEN = 'kr11-rotate-token';
    const srv = await startAdminHttpServer(TOKEN);

    const result = await fetch(`http://127.0.0.1:${srv.port}/v1/admin/key/rotate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    await srv.close();

    expect(result.status).toBe(200);
    const body = await result.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);

    const data = body['data'] as Record<string, unknown>;
    expect(data['keyId']).toMatch(/^[0-9a-f]{8}$/);
    expect(typeof data['keyVersion']).toBe('number');
    expect(data['algorithm']).toBe('ed25519');
    expect(typeof data['generatedAt']).toBe('string');
    expect(typeof data['idempotent']).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// KR-12: POST /v1/admin/key/rotate — 401 without token
// ---------------------------------------------------------------------------

describe('KR-12: POST /v1/admin/key/rotate — 401 without Bearer token', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const TOKEN = 'kr12-rotate-required';
    const srv = await startAdminHttpServer(TOKEN);

    // No Authorization header
    const result = await fetch(`http://127.0.0.1:${srv.port}/v1/admin/key/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    await srv.close();

    expect(result.status).toBe(401);
    const body = await result.json() as Record<string, unknown>;
    expect(body['ok']).toBe(false);
    expect(body['error']).toMatch(/unauthoriz/i);
  });
});

// ---------------------------------------------------------------------------
// KR-13: POST /v1/admin/key/rotate — 503 with SUDO_KEY_ROTATION_DISABLE=1
// ---------------------------------------------------------------------------

describe('KR-13: POST /v1/admin/key/rotate — 503 with kill-switch', () => {
  it('SUDO_KEY_ROTATION_DISABLE=1 returns 503 with disabled error message', async () => {
    process.env['SUDO_KEY_ROTATION_DISABLE'] = '1';
    const TOKEN = 'kr13-disable-token';
    const srv = await startAdminHttpServer(TOKEN);

    const result = await fetch(`http://127.0.0.1:${srv.port}/v1/admin/key/rotate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    await srv.close();

    expect(result.status).toBe(503);
    const body = await result.json() as Record<string, unknown>;
    expect(body['ok']).toBe(false);
    expect(body['error']).toMatch(/disabled/i);
  });
});
