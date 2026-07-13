/**
 * Tests for the Docker exec backend (gap #27).
 * The argv builder is deterministic (FS access only to resolve/validate extra
 * binds, stubbed here); run() is exercised only on the docker-missing path
 * (no Docker daemon required).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  buildDockerArgs,
  resolveDockerConfig,
  dockerBackend,
  type DockerBackendConfig,
} from '../../src/core/sandbox/backends/docker-backend.js';
import { DEFAULT_SANDBOX_POLICY } from '../../src/core/sandbox/sandbox-types.js';

const policy = { ...DEFAULT_SANDBOX_POLICY, network: 'none' as const, memoryMB: 512, cpuSeconds: 30 };
const config: DockerBackendConfig = { bin: 'docker', image: 'ubuntu:24.04' };
const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/workspace', USER: 'sandbox' };

describe('buildDockerArgs', () => {
  it('builds a docker run argv with workspace mount + isolation + caps', () => {
    const args = buildDockerArgs({ command: 'echo hi', workspaceDir: '/tmp/ws', policy }, env, config);

    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args).toContain('--init');

    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args[args.indexOf('-v') + 1]).toBe('/tmp/ws:/workspace');
    expect(args[args.indexOf('-w') + 1]).toBe('/workspace');
    expect(args[args.indexOf('--memory') + 1]).toBe('512m');
    // --memory-swap == --memory disables swap so the cap is actually enforced.
    expect(args[args.indexOf('--memory-swap') + 1]).toBe('512m');
    expect(args).toContain('--pids-limit');

    // Hardening (Feature 8): drop all caps, forbid privilege escalation,
    // read-only rootfs + writable /tmp tmpfs.
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    expect(args).toContain('--read-only');
    expect(args[args.indexOf('--tmpfs') + 1]).toMatch(/^\/tmp:/);

    // image then `/bin/bash -c <ulimit-wrapped command>`
    const imgIdx = args.indexOf('ubuntu:24.04');
    expect(args[imgIdx + 1]).toBe('/bin/bash');
    expect(args[imgIdx + 2]).toBe('-c');
    expect(args[imgIdx + 3]).toContain('ulimit -SHt 30');
    expect(args[imgIdx + 3]).toContain('echo hi');
  });

  it('forwards env by name only — values never appear on argv', () => {
    const args = buildDockerArgs({ command: 'id', workspaceDir: '/w', policy }, env, config);
    expect(args).toContain('-e');
    expect(args).toContain('PATH');
    expect(args).toContain('HOME');
    expect(args).toContain('USER');
    // The VALUE must not be on the command line.
    expect(args).not.toContain('/usr/bin');
  });

  it('maps policy.network host to --network host', () => {
    const args = buildDockerArgs(
      { command: 'x', workspaceDir: '/w', policy: { ...policy, network: 'host' } },
      env,
      config,
    );
    expect(args[args.indexOf('--network') + 1]).toBe('host');
  });

  it('adds --user when configured (root-drop)', () => {
    const args = buildDockerArgs({ command: 'x', workspaceDir: '/w', policy }, env, { ...config, user: '1000:1000' });
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
  });

  it('omits --read-only when SUDO_DOCKER_READONLY=0', () => {
    process.env['SUDO_DOCKER_READONLY'] = '0';
    try {
      const args = buildDockerArgs({ command: 'x', workspaceDir: '/w', policy }, env, config);
      expect(args).not.toContain('--read-only');
      // caps + no-new-privileges are NOT opt-out — still present.
      expect(args).toContain('--cap-drop');
      expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    } finally {
      delete process.env['SUDO_DOCKER_READONLY'];
    }
  });

  it('rejects a workspaceDir containing ":" (would corrupt the -v mount spec)', () => {
    expect(() =>
      buildDockerArgs({ command: 'x', workspaceDir: '/tmp/a:b', policy }, env, config),
    ).toThrow(/may not contain/);
  });

  it('mounts extra read-only + writable binds for isolation parity with bwrap', () => {
    const idRealpath = (p: string) => p; // skip real FS access in the unit test
    const args = buildDockerArgs(
      {
        command: 'x',
        workspaceDir: '/w',
        policy: { ...policy, extraReadOnlyBinds: ['/opt/python'], extraWritableBinds: ['/srv/data'] },
      },
      env,
      config,
      idRealpath,
    );
    expect(args).toContain('/opt/python:/opt/python:ro');
    expect(args).toContain('/srv/data:/srv/data');
  });

  it('rejects an unsafe (denylisted) extra bind, same as the bwrap runner', () => {
    const idRealpath = (p: string) => p;
    expect(() =>
      buildDockerArgs(
        { command: 'x', workspaceDir: '/w', policy: { ...policy, extraReadOnlyBinds: ['/etc'] } },
        env,
        config,
        idRealpath,
      ),
    ).toThrow(/unsafe/);
  });
});

describe('resolveDockerConfig', () => {
  afterEach(() => {
    delete process.env['SUDO_DOCKER_BIN'];
    delete process.env['SUDO_DOCKER_IMAGE'];
    delete process.env['SUDO_DOCKER_USER'];
  });

  it('defaults to docker + the non-root sudo-ai-sandbox image, no user', () => {
    const c = resolveDockerConfig();
    expect(c.bin).toBe('docker');
    expect(c.image).toBe('sudo-ai-sandbox:latest');
    expect(c.user).toBeUndefined();
  });

  it('honors env overrides', () => {
    process.env['SUDO_DOCKER_BIN'] = 'podman';
    process.env['SUDO_DOCKER_IMAGE'] = 'myimg:bash';
    process.env['SUDO_DOCKER_USER'] = '1000';
    expect(resolveDockerConfig()).toEqual({ bin: 'podman', image: 'myimg:bash', user: '1000' });
  });
});

describe('dockerBackend.run', () => {
  it('returns exitCode 127 honestly when the docker binary is missing', async () => {
    process.env['SUDO_DOCKER_BIN'] = '/nonexistent/docker-xyz';
    try {
      const res = await dockerBackend.run({ command: 'echo hi', workspaceDir: '/tmp', policy, timeoutMs: 5000 });
      expect(res.exitCode).toBe(127);
      expect(res.stderr).toContain('not found');
    } finally {
      delete process.env['SUDO_DOCKER_BIN'];
    }
  });
});
