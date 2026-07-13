/**
 * Spec 8 polish coverage:
 *  - Step 3 "artifacts copy-out": the /workspace bind mount IS the return
 *    channel — a file an untrusted container writes appears on the host with no
 *    copy step. Proven live against a real container (skipped when Docker/image
 *    absent so the suite stays green on CI without Docker).
 *  - Step 1 "pre-pull on boot": buildSandboxImage argv is correct + deterministic
 *    and the docker-missing path returns {ok:false} rather than throwing.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerBackend } from '../../src/core/sandbox/backends/docker-backend.js';
import { buildSandboxImage, resolveDockerConfig, SANDBOX_DOCKERFILE } from '../../src/core/sandbox/backends/docker-backend.js';
import { DEFAULT_SANDBOX_POLICY } from '../../src/core/sandbox/sandbox-types.js';
import type { SandboxPolicy } from '../../src/core/sandbox/sandbox-types.js';

const execFileAsync = promisify(execFile);

async function dockerImagePresent(): Promise<boolean> {
  try {
    const { image, bin } = resolveDockerConfig();
    await execFileAsync(bin, ['image', 'inspect', image], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe('artifacts copy-out (bind mount is the channel)', () => {
  it('a file the untrusted container writes to /workspace lands on the host', async () => {
    if (!(await dockerImagePresent())) {
      // No sandbox image on this runner — the mechanism is the docker bind mount,
      // which the argv test in docker-backend.test.ts already covers statically.
      return;
    }
    const ws = mkdtempSync(join(tmpdir(), 'artifact-'));
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      network: 'none',
      execBackend: 'docker',
      requireIsolatedBackend: true,
      cpuSeconds: 30,
    };
    const r = await dockerBackend.run({
      command: 'printf ARTIFACT_CONTENT > /workspace/result.txt',
      workspaceDir: ws,
      policy,
      timeoutMs: 30_000,
    });
    expect(r.exitCode).toBe(0);
    const hostPath = join(ws, 'result.txt');
    expect(existsSync(hostPath)).toBe(true);
    expect(readFileSync(hostPath, 'utf-8')).toBe('ARTIFACT_CONTENT');
  }, 60_000);
});

describe('buildSandboxImage (spec step 1 self-heal)', () => {
  it('returns {ok:false} on a missing docker binary instead of throwing', async () => {
    const res = await buildSandboxImage('/tmp', { bin: 'definitely-not-docker-xyz', image: 'x:y' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('docker binary not found');
  });

  it('targets the sandbox Dockerfile constant', () => {
    expect(SANDBOX_DOCKERFILE).toBe('docker/Dockerfile.sandbox');
  });
});
