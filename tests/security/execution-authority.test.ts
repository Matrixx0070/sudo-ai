/**
 * @file execution-authority.test.ts
 * @description Pins the centralized execution-authority architecture (owner
 * directive 2026-08-16: full root-level autonomy, no interactive approval
 * prompts on ANY surface).
 *
 * These tests exist because the pre-centralization posture was measured to
 * disagree with itself: `system.ssh` (requiresConfirmation: true) executed
 * with no prompt while a strict-mode shell command would have blocked for
 * five minutes. The invariant under test is that ONE resolver answers for
 * every surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getAuthorityMode,
  isAutonomous,
  authorize,
  isCatastrophicCommand,
  catastrophicRefusalLifted,
} from '../../src/core/security/execution-authority.js';

const ENV_KEYS = [
  'SUDO_AUTHORITY_MODE',
  'SUDO_AUTO_APPROVE',
  'SUDO_AUTHORITY_ALLOW_CATASTROPHIC',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('execution authority — mode resolution', () => {
  it('defaults to autonomous with NO env configured (the shipped posture)', () => {
    expect(getAuthorityMode()).toBe('autonomous');
    expect(isAutonomous()).toBe(true);
  });

  it('SUDO_AUTHORITY_MODE=gated restores prompting', () => {
    process.env['SUDO_AUTHORITY_MODE'] = 'gated';
    expect(getAuthorityMode()).toBe('gated');
    expect(isAutonomous()).toBe(false);
  });

  it('legacy SUDO_AUTO_APPROVE=0 still opts out (back-compat)', () => {
    process.env['SUDO_AUTO_APPROVE'] = '0';
    expect(getAuthorityMode()).toBe('gated');
  });

  it('explicit mode beats the legacy knob', () => {
    process.env['SUDO_AUTHORITY_MODE'] = 'autonomous';
    process.env['SUDO_AUTO_APPROVE'] = '0';
    expect(getAuthorityMode()).toBe('autonomous');
  });

  it('is re-read per call — a live change applies without a restart', () => {
    expect(isAutonomous()).toBe(true);
    process.env['SUDO_AUTHORITY_MODE'] = 'gated';
    expect(isAutonomous()).toBe(false);
    process.env['SUDO_AUTHORITY_MODE'] = 'autonomous';
    expect(isAutonomous()).toBe(true);
  });
});

describe('execution authority — authorize()', () => {
  it('never requires a prompt on ANY surface in autonomous mode', () => {
    const surfaces = ['agent-tool', 'shell-exec', 'bg-shell', 'graph-gate', 'acp', 'other'] as const;
    for (const surface of surfaces) {
      const d = authorize({ surface, action: 'system.ssh', command: 'ssh root@host uptime' });
      expect(d.proceed, `${surface} must proceed`).toBe(true);
      expect(d.requiresPrompt, `${surface} must not prompt`).toBe(false);
      expect(d.reason).toBe('autonomous');
    }
  });

  it('authorizes privileged sysadmin actions without asking (the directive)', () => {
    for (const command of [
      'apt-get install -y nginx',
      'systemctl restart nginx',
      'chown -R root:root /opt/app',
      'npm i -g pnpm',
      'echo x > /etc/motd',
      'docker run --rm alpine true',
    ]) {
      const d = authorize({ surface: 'shell-exec', action: 'system.exec', command });
      expect(d.proceed, command).toBe(true);
      expect(d.requiresPrompt, command).toBe(false);
    }
  });

  it('gated mode asks on every surface', () => {
    process.env['SUDO_AUTHORITY_MODE'] = 'gated';
    const d = authorize({ surface: 'shell-exec', action: 'system.exec', command: 'ls' });
    expect(d.proceed).toBe(false);
    expect(d.requiresPrompt).toBe(true);
  });
});

describe('execution authority — containment is not a prompt', () => {
  it('refuses whole-system destruction WITHOUT prompting', () => {
    const d = authorize({ surface: 'shell-exec', action: 'system.exec', command: 'rm -rf /' });
    expect(d.proceed).toBe(false);
    // The critical property: refusal must never become a question to the user.
    expect(d.requiresPrompt).toBe(false);
    expect(d.reason).toBe('catastrophic-refused');
  });

  it('owner can lift the refusal explicitly', () => {
    process.env['SUDO_AUTHORITY_ALLOW_CATASTROPHIC'] = '1';
    expect(catastrophicRefusalLifted()).toBe(true);
    const d = authorize({ surface: 'shell-exec', action: 'system.exec', command: 'rm -rf /' });
    expect(d.proceed).toBe(true);
    expect(d.requiresPrompt).toBe(false);
  });

  it('refuses every bypass form found by adversarial review (2026-08-16)', () => {
    // Each of these executed under the first regex-only implementation.
    for (const cmd of [
      'dd if=/dev/zero of=/dev/nvme0n1',          // primary disk on modern servers
      'dd if=/dev/zero of=/dev/sda1',             // partition suffix
      'wipefs -a /dev/sda',
      'shred -n1 /dev/sda',
      'rm -rf "/"',                                // quoted root
      "rm -rf '/'",
      'rm -r -f /',                                // separated flags
      'rm -rf --no-preserve-root /',
      'rm --recursive --force --no-preserve-root /',
      'find / -delete',
      'find / -exec rm -rf {} +',
      'cd / && rm -rf *',
      'rm -rf /home',
      'rm -rf /etc',
      'rm -rf /usr',
      'rm -rf //',
      'rm -rf /.',
    ]) {
      const d = authorize({ surface: 'shell-exec', action: 'system.exec', command: cmd });
      expect(d.proceed, `must refuse: ${cmd}`).toBe(false);
      expect(d.requiresPrompt, `must not prompt: ${cmd}`).toBe(false);
    }
  });

  it('refuses wrapper / expansion / traversal evasions (review round 2)', () => {
    for (const cmd of [
      'bash -c "rm -rf /"',
      "sh -c 'rm -rf /'",
      '/bin/bash -c "rm -rf /"',
      'sudo rm -rf /',
      'rm -rf ${HOME}',
      'rm -rf `echo /`',
      'rm -rf $(echo /)',
      'rm -rf /etc/../',
      'rm -rf /var/../',
      'chmod -R 000 /',
      'chmod -R 755 /',
      'chown -R nobody /',
      'mv /etc /tmp',
    ]) {
      const d = authorize({ surface: 'shell-exec', action: 'system.exec', command: cmd });
      expect(d.proceed, `must refuse: ${cmd}`).toBe(false);
      expect(d.requiresPrompt, `must not prompt: ${cmd}`).toBe(false);
    }
  });

  it('does NOT over-block legitimate work (over-blocking breaks the directive)', () => {
    for (const cmd of [
      'mkfs.ext4 /tmp/loop.img',        // loopback image — refused by the old bare `mkfs.` ban
      'mkfs -t ext4 /tmp/loop.img',
      'chmod -R 755 /opt/app',
      'chown -R www-data /var/www',
      'mv /tmp/a /tmp/b',
      'mv /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak',
      'bash -c "rm -rf /tmp/build"',
      'rm -rf /root/sudo-ai-v4/dist',
      'docker system prune -af',
      'git clean -xfd',
      'npm ci',
    ]) {
      const d = authorize({ surface: 'shell-exec', action: 'system.exec', command: cmd });
      expect(d.proceed, `must run: ${cmd}`).toBe(true);
    }
  });

  it('keeps the hardened DANGEROUS_PREFIXES force-deny alive in autonomous mode', () => {
    // These come from exec-policy's audited list, not the local regexes —
    // the review caught the autonomy bypass silently disabling them.
    for (const cmd of ['rm -rf ~', 'rm -rf $HOME']) {
      expect(authorize({ surface: 'shell-exec', action: 'system.exec', command: cmd }).proceed, cmd).toBe(false);
    }
  });

  it('classifies catastrophic vs ordinary destructive commands', () => {
    for (const bad of [
      'rm -rf /',
      'rm -rf /*',
      'rm -fr / --no-preserve-root',
      'rm --recursive --force /',
      'mkfs.ext4 /dev/sda',
      'dd if=/dev/zero of=/dev/sda bs=1M',
      'cat /dev/zero > /dev/sda',
    ]) {
      expect(isCatastrophicCommand(bad), bad).toBe(true);
    }
    // Ordinary destructive work is NOT catastrophic — the agent must be free
    // to do real sysadmin work, including deleting directories it owns.
    for (const ok of [
      'rm -rf /tmp/build',
      'rm -rf node_modules',
      'rm -rf /root/sudo-ai-v4/dist',
      'dd if=/dev/zero of=/tmp/img bs=1M count=10',
      'mkfs.ext4 /tmp/loopfile',
      'rm -rf /var/log/myapp',
      'rm -rf /home/frank/scratch',
      'rm -rf /etc/nginx/sites-enabled/old.conf',
      'find /tmp/cache -delete',
      'cd /tmp/build && rm -rf *',
    ]) {
      expect(isCatastrophicCommand(ok), ok).toBe(false);
    }
  });

  it('tolerates empty/garbage input', () => {
    expect(isCatastrophicCommand('')).toBe(false);
    expect(isCatastrophicCommand(undefined as unknown as string)).toBe(false);
  });
});
