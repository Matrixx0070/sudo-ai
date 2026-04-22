/**
 * @file tests/security/signer.test.ts
 * @description Tests for ArtifactSigner — ed25519 sign/verify roundtrip.
 *
 * Wave 10G fixes:
 *  - SUDO_KEY_ROTATION_DB_PATH set per-test for DB isolation.
 *  - vi.resetModules() moved to beforeEach so each test gets a fresh module singleton.
 *  - File path checks updated to wave10-signer-v1.{pub,priv}.
 *  - "keyId mismatch" test updated: must invalidate BOTH keyId and keyVersion to avoid
 *    version-first fallback; expected error changed from 'Key ID mismatch' to 'Key not found'.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Use a real temp dir for key storage in tests
let testKeyDir: string;

beforeEach(() => {
  vi.resetModules();
  testKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-test-'));
  process.env['SUDO_SIGNER_KEY_DIR'] = testKeyDir;
  process.env['SUDO_KEY_ROTATION_DB_PATH'] = path.join(testKeyDir, 'key-rotation.db');
});

afterEach(() => {
  delete process.env['SUDO_SIGNER_KEY_DIR'];
  delete process.env['SUDO_KEY_ROTATION_DB_PATH'];
  // Clean up temp dir
  try { fs.rmSync(testKeyDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
});

describe('ArtifactSigner', () => {
  it('sign + verify roundtrip returns valid=true', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    const payload = { message: 'hello world', version: 42 };
    const artifact = signer.sign(payload, 'generic');
    const result = signer.verify(artifact);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('verify fails when payload is tampered', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    const artifact = signer.sign({ data: 'original' }, 'bench_report');
    // Tamper with payload
    const tampered = { ...artifact, payload: { data: 'tampered' } };
    const result = signer.verify(tampered);

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('verify fails when signature is altered', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    const artifact = signer.sign({ x: 1 }, 'skill');
    const sig = artifact.signature;
    // Flip last hex nibble
    const lastHex = sig.slice(-1);
    const flipped = lastHex === '0' ? '1' : '0';
    const badArtifact = { ...artifact, signature: sig.slice(0, -1) + flipped };

    const result = signer.verify(badArtifact);
    expect(result.valid).toBe(false);
  });

  it('keyId is 8 hex chars', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    const artifact = signer.sign({ test: true }, 'trace_pattern');
    expect(artifact.keyId).toMatch(/^[0-9a-f]{8}$/);
  });

  it('signedAt is a valid ISO-8601 timestamp', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    const artifact = signer.sign({}, 'config_proposal');
    expect(() => new Date(artifact.signedAt)).not.toThrow();
    expect(new Date(artifact.signedAt).toISOString()).toBe(artifact.signedAt);
  });

  it('auto-generates keypair on first use when no files exist', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    // Should not throw even though no keys exist yet
    const artifact = signer.sign({ init: true }, 'generic');
    expect(artifact.signature.length).toBeGreaterThan(0);

    // Key files should now exist — Wave 10G uses versioned names (v1)
    const pubPath = path.join(testKeyDir, 'wave10-signer-v1.pub');
    const privPath = path.join(testKeyDir, 'wave10-signer-v1.priv');
    expect(fs.existsSync(pubPath)).toBe(true);
    expect(fs.existsSync(privPath)).toBe(true);
  });

  it('private key file has mode 0o600', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    signer.sign({}, 'generic'); // trigger generation

    // Wave 10G uses versioned priv file name
    const privPath = path.join(testKeyDir, 'wave10-signer-v1.priv');
    const stat = fs.statSync(privPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('two signers with same key dir share the same keyId', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const s1 = new ArtifactSigner();
    const s2 = new ArtifactSigner();

    const a1 = s1.sign({ data: 1 }, 'generic');
    const a2 = s2.sign({ data: 2 }, 'generic');

    expect(a1.keyId).toBe(a2.keyId);
  });

  it('signer from s1 can verify artifact from s2 with same keys', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const s1 = new ArtifactSigner();
    const s2 = new ArtifactSigner();

    const artifact = s2.sign({ cross: true }, 'skill');
    const result = s1.verify(artifact);

    expect(result.valid).toBe(true);
  });

  it('verify returns keyId and signedAt from artifact even on failure', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();

    const artifact = signer.sign({ x: 1 }, 'generic');
    const badArtifact = { ...artifact, payload: 'hacked' };
    const result = signer.verify(badArtifact);

    expect(result.keyId).toBe(artifact.keyId);
    expect(result.signedAt).toBe(artifact.signedAt);
    expect(result.valid).toBe(false);
  });

  it('verify returns valid=false with error when keyId mismatches', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    const artifact = signer.sign({ y: 2 }, 'generic');
    // Alter BOTH keyId and keyVersion to defeat version-first lookup in Wave 10G verify().
    // verify() checks keyVersion first (line 352-354 in signer.ts); if keyVersion: 9999
    // isn't in DB, it falls back to keyId lookup; 'deadbeef' also won't be in DB → "Key not found".
    const badArtifact = { ...artifact, keyId: 'deadbeef', keyVersion: 9999 };
    const result = signer.verify(badArtifact);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Key not found/i);
  });

  it('accepts all valid artifactType values', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    const types: Array<'skill' | 'bench_report' | 'config_proposal' | 'trace_pattern' | 'generic'> =
      ['skill', 'bench_report', 'config_proposal', 'trace_pattern', 'generic'];

    for (const t of types) {
      const a = signer.sign({ type: t }, t);
      expect(a.artifactType).toBe(t);
      const v = signer.verify(a);
      expect(v.valid).toBe(true);
    }
  });

  it('sign handles null/undefined payload', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    expect(() => signer.sign(null, 'generic')).not.toThrow();
    expect(() => signer.sign(undefined, 'generic')).not.toThrow();
  });

  it('verify with corrupted hex signature returns valid=false not throw', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    const artifact = signer.sign({ z: 3 }, 'generic');
    const badArtifact = { ...artifact, signature: 'not-valid-hex' };
    const result = signer.verify(badArtifact);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  // KR-14: sign() output includes keyVersion field (Wave 10G addition)
  it('sign() output includes keyVersion as a number', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    const artifact = signer.sign({ kr14: true }, 'generic');
    expect(typeof artifact.keyVersion).toBe('number');
    expect(artifact.keyVersion).toBeGreaterThan(0);
    // Verify the artifact is also valid
    const result = signer.verify(artifact);
    expect(result.valid).toBe(true);
  });
});
