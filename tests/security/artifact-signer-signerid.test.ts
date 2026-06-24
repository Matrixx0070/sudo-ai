/**
 * @file artifact-signer-signerid.test.ts
 * @description Regression for the ESM `require` landmine in getSignerId.
 *
 * artifact-signer.ts is an ESM module but getSignerId() used
 * `require('node:os').hostname()`. Under the prod runtime (node --import tsx,
 * pure ESM) `require` is undefined, so importing this module threw at load —
 * which broke `new SecurityGuard()` and silently disabled prompt-injection
 * detection, destructive tool-call blocking, and rate limiting (logged 323×
 * "SecurityGuard failed to initialize — require is not defined" since 2026-06-18).
 *
 * The fix imports `os` properly. NOTE: vitest's transform provides a `require`
 * shim, so this test does NOT reproduce the ESM failure (the prod-runtime proof
 * is `node --import tsx`); it guards the signerId *contract* against regressions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import { ArtifactSigner } from '../../src/core/security/artifact-signer.js';

const SECRET = 'a'.repeat(64);

afterEach(() => {
  delete process.env['SUDO_ARTIFACT_SIGNER_ID'];
});

describe('ArtifactSigner.getSignerId', () => {
  it('defaults signerId to <hostname>:<pid> via node:os', () => {
    delete process.env['SUDO_ARTIFACT_SIGNER_ID'];
    process.env['SUDO_ARTIFACT_SECRET'] = SECRET; // skip filesystem secret seeding
    const s = new ArtifactSigner().signContent('m').signer;
    expect(s).toBe(`${os.hostname()}:${process.pid}`);
  });

  it('respects the SUDO_ARTIFACT_SIGNER_ID env override', () => {
    process.env['SUDO_ARTIFACT_SECRET'] = SECRET;
    process.env['SUDO_ARTIFACT_SIGNER_ID'] = 'fed-node-7';
    expect(new ArtifactSigner().signContent('m').signer).toBe('fed-node-7');
  });

  it('respects an explicit config.signerId', () => {
    process.env['SUDO_ARTIFACT_SECRET'] = SECRET;
    expect(new ArtifactSigner({ signerId: 'cfg-id' }).signContent('m').signer).toBe('cfg-id');
  });
});
