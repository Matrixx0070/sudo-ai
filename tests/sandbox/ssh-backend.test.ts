/**
 * Tests for the SSH exec backend (gap #27).
 * The argv builder is pure; run() is exercised only on the no-host + ssh-missing
 * paths (no real SSH connection required).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  buildSshArgs,
  resolveSshConfig,
  shellQuote,
  sshBackend,
  type SshBackendConfig,
} from '../../src/core/sandbox/backends/ssh-backend.js';
import { DEFAULT_SANDBOX_POLICY } from '../../src/core/sandbox/sandbox-types.js';

const policy = { ...DEFAULT_SANDBOX_POLICY, network: 'none' as const, memoryMB: 512, cpuSeconds: 30 };
const base: SshBackendConfig = { bin: 'ssh', host: 'remote.example', port: 22, strictHostKey: 'accept-new' };

describe('shellQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellQuote('plain')).toBe("'plain'");
  });
  it("escapes embedded single quotes as '\\'' (close/escape/reopen)", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe('buildSshArgs', () => {
  it('emits non-interactive hardening options', () => {
    const args = buildSshArgs({ command: 'echo hi', policy }, base);
    const joined = args.join(' ');
    expect(joined).toContain('BatchMode=yes');
    expect(joined).toContain('StrictHostKeyChecking=accept-new');
    expect(joined).toContain('ConnectTimeout=');
  });

  it('targets host alone with no user, user@host with a user', () => {
    expect(buildSshArgs({ command: 'x', policy }, base)).toContain('remote.example');
    const withUser = buildSshArgs({ command: 'x', policy }, { ...base, user: 'deploy' });
    expect(withUser).toContain('deploy@remote.example');
  });

  it('adds -p only for a non-default port', () => {
    expect(buildSshArgs({ command: 'x', policy }, base)).not.toContain('-p');
    const p = buildSshArgs({ command: 'x', policy }, { ...base, port: 2222 });
    expect(p[p.indexOf('-p') + 1]).toBe('2222');
  });

  it('adds -i for an identity file', () => {
    const args = buildSshArgs({ command: 'x', policy }, { ...base, key: '/home/u/.ssh/id_ed25519' });
    expect(args[args.indexOf('-i') + 1]).toBe('/home/u/.ssh/id_ed25519');
  });

  it('wraps the ulimit-capped command as a single `bash -c` remote argument', () => {
    const args = buildSshArgs({ command: 'echo hi', policy }, base);
    const remote = args[args.length - 1];
    expect(remote.startsWith("bash -c '")).toBe(true);
    expect(remote).toContain('ulimit -SHt 30');
    expect(remote).toContain('echo hi');
  });

  it('cd-s into the remote workdir when configured', () => {
    const args = buildSshArgs({ command: 'echo hi', policy }, { ...base, workdir: '/srv/app' });
    const remote = args[args.length - 1];
    // The cd is embedded inside the outer bash -c quoting, so the workdir's own
    // quotes are escaped (`'\''`) — they decode back to `cd '/srv/app' &&` when
    // bash finally runs the inner string on the remote.
    expect(remote).toContain('/srv/app');
    expect(remote).toContain('cd ');
    expect(remote).toContain('&&');
  });

  it('is injection-safe: single quotes in the command are escaped, not passed through raw', () => {
    const args = buildSshArgs({ command: "echo 'pwned'; rm -rf /", policy }, base);
    const remote = args[args.length - 1];
    // The whole remote command is ONE ssh argument structured as bash -c '...'.
    expect(remote.startsWith("bash -c '")).toBe(true);
    // The attacker's quotes are rewritten as '\'' — they can't terminate our wrapper.
    expect(remote).toContain("'\\''");
  });
});

describe('resolveSshConfig', () => {
  afterEach(() => {
    for (const k of ['SUDO_SSH_BIN', 'SUDO_SSH_HOST', 'SUDO_SSH_USER', 'SUDO_SSH_PORT', 'SUDO_SSH_KEY', 'SUDO_SSH_WORKDIR', 'SUDO_SSH_STRICT_HOST_KEY']) {
      delete process.env[k];
    }
  });

  it('defaults to ssh + port 22 + accept-new, empty host', () => {
    const c = resolveSshConfig();
    expect(c.bin).toBe('ssh');
    expect(c.port).toBe(22);
    expect(c.strictHostKey).toBe('accept-new');
    expect(c.host).toBe('');
  });

  it('honors env overrides', () => {
    process.env['SUDO_SSH_BIN'] = '/usr/bin/ssh';
    process.env['SUDO_SSH_HOST'] = 'h.example';
    process.env['SUDO_SSH_USER'] = 'deploy';
    process.env['SUDO_SSH_PORT'] = '2222';
    process.env['SUDO_SSH_KEY'] = '/k';
    process.env['SUDO_SSH_WORKDIR'] = '/srv';
    process.env['SUDO_SSH_STRICT_HOST_KEY'] = 'yes';
    expect(resolveSshConfig()).toEqual({
      bin: '/usr/bin/ssh', host: 'h.example', user: 'deploy', port: 2222,
      key: '/k', workdir: '/srv', strictHostKey: 'yes',
    });
  });

  it('falls back to port 22 on a non-numeric SUDO_SSH_PORT', () => {
    process.env['SUDO_SSH_PORT'] = 'notaport';
    expect(resolveSshConfig().port).toBe(22);
  });
});

describe('sshBackend.run', () => {
  afterEach(() => {
    delete process.env['SUDO_SSH_HOST'];
    delete process.env['SUDO_SSH_BIN'];
  });

  it('returns exitCode 78 (EX_CONFIG) when SUDO_SSH_HOST is unset', async () => {
    delete process.env['SUDO_SSH_HOST'];
    const res = await sshBackend.run({ command: 'echo hi', workspaceDir: '/tmp', policy, timeoutMs: 5000 });
    expect(res.exitCode).toBe(78);
    expect(res.stderr).toContain('SUDO_SSH_HOST');
  });

  it('returns exitCode 127 honestly when the ssh binary is missing', async () => {
    process.env['SUDO_SSH_HOST'] = 'remote.example';
    process.env['SUDO_SSH_BIN'] = '/nonexistent/ssh-xyz';
    const res = await sshBackend.run({ command: 'echo hi', workspaceDir: '/tmp', policy, timeoutMs: 5000 });
    expect(res.exitCode).toBe(127);
    expect(res.stderr).toContain('not found');
  });

  it('rejects a host that starts with "-" (ssh argument-injection guard) → 78', async () => {
    process.env['SUDO_SSH_HOST'] = '-oProxyCommand=touch /tmp/pwned';
    process.env['SUDO_SSH_BIN'] = '/nonexistent/ssh-xyz'; // never reached — guard fires first
    const res = await sshBackend.run({ command: 'echo hi', workspaceDir: '/tmp', policy, timeoutMs: 5000 });
    expect(res.exitCode).toBe(78);
    expect(res.stderr).toContain('unsafe');
  });
});
