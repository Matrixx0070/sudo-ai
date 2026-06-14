/**
 * Tests for the Modal exec backend (gap #27).
 *
 * The argv/env builders are pure. run() is exercised on the python-missing path
 * AND end-to-end against a REAL python3 with the `modal` package absent — which
 * validates the driver compiles (python parses the whole module first, so a
 * syntax error would surface as a non-127 exit) and that the import-guard returns
 * 127. The live Modal Sandbox round-trip is NOT tested here (needs a Modal
 * account + auth) — that boundary is documented in modal-backend.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  buildModalArgs,
  buildModalDriverEnv,
  resolveModalConfig,
  modalBackend,
  MODAL_DRIVER,
  type ModalBackendConfig,
} from '../../src/core/sandbox/backends/modal-backend.js';
import { DEFAULT_SANDBOX_POLICY } from '../../src/core/sandbox/sandbox-types.js';

const policy = { ...DEFAULT_SANDBOX_POLICY, memoryMB: 512, cpuSeconds: 30 };
const config: ModalBackendConfig = { bin: 'python3', image: '', app: 'sudo-exec' };

describe('buildModalArgs', () => {
  it('runs the fixed driver via `-c` and keeps the command OFF argv', () => {
    const args = buildModalArgs();
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe(MODAL_DRIVER);
    // The command never appears on argv — it travels via SUDO_MODAL_COMMAND env.
    expect(args.join(' ')).not.toContain('echo super-secret-cmd');
  });
});

describe('buildModalDriverEnv', () => {
  it('passes the ulimit-wrapped command via env, plus image/app/memory/timeout', () => {
    const env = buildModalDriverEnv(
      { command: 'echo super-secret-cmd', policy, timeoutMs: 20000 },
      { ...config, image: 'ghcr.io/acme/img:1', app: 'myapp' },
    );
    expect(env['SUDO_MODAL_COMMAND']).toContain('ulimit -SHt 30');
    expect(env['SUDO_MODAL_COMMAND']).toContain('echo super-secret-cmd');
    expect(env['SUDO_MODAL_IMAGE']).toBe('ghcr.io/acme/img:1');
    expect(env['SUDO_MODAL_APP']).toBe('myapp');
    expect(env['SUDO_MODAL_MEMORY_MB']).toBe('512');
    expect(env['SUDO_MODAL_TIMEOUT_S']).toBe('20'); // ceil(20000/1000)
    expect(env['SUDO_MODAL_BLOCK_NETWORK']).toBe('1'); // default policy network='none'
  });

  it('maps policy.network to block_network (none → 1, host → empty)', () => {
    const blocked = buildModalDriverEnv({ command: 'x', policy: { ...policy, network: 'none' }, timeoutMs: 5000 }, config);
    expect(blocked['SUDO_MODAL_BLOCK_NETWORK']).toBe('1');
    const open = buildModalDriverEnv({ command: 'x', policy: { ...policy, network: 'host' }, timeoutMs: 5000 }, config);
    expect(open['SUDO_MODAL_BLOCK_NETWORK']).toBe('');
  });
});

describe('resolveModalConfig', () => {
  afterEach(() => {
    delete process.env['SUDO_MODAL_BIN'];
    delete process.env['SUDO_MODAL_IMAGE'];
    delete process.env['SUDO_MODAL_APP'];
  });

  it('defaults to python3 + empty image + sudo-exec app', () => {
    expect(resolveModalConfig()).toEqual({ bin: 'python3', image: '', app: 'sudo-exec' });
  });

  it('honors env overrides', () => {
    process.env['SUDO_MODAL_BIN'] = '/usr/bin/python3.12';
    process.env['SUDO_MODAL_IMAGE'] = 'debian:12';
    process.env['SUDO_MODAL_APP'] = 'team-app';
    expect(resolveModalConfig()).toEqual({ bin: '/usr/bin/python3.12', image: 'debian:12', app: 'team-app' });
  });
});

describe('modalBackend.run', () => {
  afterEach(() => {
    delete process.env['SUDO_MODAL_BIN'];
  });

  it('returns exitCode 127 when the python binary is missing', async () => {
    process.env['SUDO_MODAL_BIN'] = '/nonexistent/python-xyz';
    const res = await modalBackend.run({ command: 'echo hi', workspaceDir: '/tmp', policy, timeoutMs: 5000 });
    expect(res.exitCode).toBe(127);
    expect(res.stderr).toContain('not found');
  });

  it('driver compiles + import-guard returns 127 when the modal package is absent (real python3)', async () => {
    // No SUDO_MODAL_BIN override → real python3. modal is not installed in this
    // environment, so the driver's `import modal` guard fires. A syntax error in
    // the driver would instead surface as a non-127 SyntaxError exit, so this
    // also pins that the whole driver is valid Python.
    delete process.env['SUDO_MODAL_BIN'];
    const res = await modalBackend.run({ command: 'echo hi', workspaceDir: '/tmp', policy, timeoutMs: 15000 });
    expect(res.exitCode).toBe(127);
    expect(res.stderr.toLowerCase()).toContain('modal');
  });
});
