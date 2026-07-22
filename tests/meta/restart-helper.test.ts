/**
 * @file tests/meta/restart-helper.test.ts
 * @description Tests for the shared restart helper used by meta.self-modify,
 *   meta.service-control, and meta.self-update.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
    execSync: execSyncMock,
  };
});

import {
  DARWIN_NO_RESTART_MSG,
  restartCommand,
  resolveRestartCmd,
  scheduleDetachedRestart,
} from '../../src/core/tools/builtin/meta/restart-helper.js';

/** Temporarily override process.platform; returns a restore fn. */
function stubPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', original);
}

const PM2_DEFAULT = 'pm2 restart ecosystem.config.cjs --only sudo-ai-v5 --update-env';

describe('restart-helper', () => {
  const savedOverride = process.env['SUDO_RESTART_CMD'];

  beforeEach(() => {
    delete process.env['SUDO_RESTART_CMD'];
    spawnMock.mockReset();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    if (savedOverride === undefined) delete process.env['SUDO_RESTART_CMD'];
    else process.env['SUDO_RESTART_CMD'] = savedOverride;
  });

  describe('restartCommand', () => {
    it('defaults to the pm2 ecosystem form', () => {
      expect(restartCommand()).toBe(PM2_DEFAULT);
    });

    it('honors SUDO_RESTART_CMD override', () => {
      process.env['SUDO_RESTART_CMD'] = 'systemctl restart sudo-ai-v5';
      expect(restartCommand()).toBe('systemctl restart sudo-ai-v5');
    });

    it('ignores whitespace-only override', () => {
      process.env['SUDO_RESTART_CMD'] = '   ';
      expect(restartCommand()).toBe(PM2_DEFAULT);
    });
  });

  describe('resolveRestartCmd', () => {
    it('override wins over pm2 detection', () => {
      process.env['SUDO_RESTART_CMD'] = 'pm2 reload sudo-ai-v5';
      const r = resolveRestartCmd();
      expect(r).toEqual({ cmd: 'pm2 reload sudo-ai-v5', via: 'override' });
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('uses pm2 form when pm2 is on PATH', () => {
      execSyncMock.mockReturnValue('/usr/bin/pm2');
      const r = resolveRestartCmd();
      expect(r.via).toBe('pm2');
      expect(r.cmd).toBe(PM2_DEFAULT);
    });

    it('falls back to systemctl when pm2 is absent', () => {
      execSyncMock.mockImplementation(() => {
        throw new Error('not found');
      });
      const r = resolveRestartCmd();
      expect(r.via).toBe('systemctl');
      expect(r.cmd).toBe('systemctl restart sudo-ai');
    });
  });

  describe('scheduleDetachedRestart', () => {
    it('spawns a detached sh -c "sleep 3; <cmd>" child and unrefs it', () => {
      process.env['SUDO_RESTART_CMD'] = 'echo restart';
      const unref = vi.fn();
      spawnMock.mockReturnValue({ unref });

      const result = scheduleDetachedRestart('unit-test', '/tmp');

      expect(result.scheduled).toBe(true);
      expect(result.cmd).toBe('echo restart');
      expect(spawnMock).toHaveBeenCalledWith(
        'sh',
        ['-c', 'sleep 3; echo restart'],
        expect.objectContaining({ detached: true, stdio: 'ignore', cwd: '/tmp' }),
      );
      expect(unref).toHaveBeenCalled();
    });

    it('reports failure when spawn throws', () => {
      process.env['SUDO_RESTART_CMD'] = 'echo restart';
      spawnMock.mockImplementation(() => {
        throw new Error('EPERM');
      });

      const result = scheduleDetachedRestart('unit-test', '/tmp');

      expect(result.scheduled).toBe(false);
      expect(result.error).toContain('EPERM');
    });
  });

  describe('SUDO_BLOCK_AGENT_RESTART kill-switch', () => {
    const savedBlock = process.env['SUDO_BLOCK_AGENT_RESTART'];

    afterEach(() => {
      if (savedBlock === undefined) delete process.env['SUDO_BLOCK_AGENT_RESTART'];
      else process.env['SUDO_BLOCK_AGENT_RESTART'] = savedBlock;
    });

    it('flag set: blocks the restart, mentions the flag, and spawns nothing', () => {
      process.env['SUDO_BLOCK_AGENT_RESTART'] = '1';
      process.env['SUDO_RESTART_CMD'] = 'echo restart';

      const result = scheduleDetachedRestart('x');

      expect(result.scheduled).toBe(false);
      expect(result.cmd).toBe('');
      expect(result.error).toContain('SUDO_BLOCK_AGENT_RESTART=1');
      expect(spawnMock).not.toHaveBeenCalled();
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('flag unset: schedules a restart exactly as before', () => {
      delete process.env['SUDO_BLOCK_AGENT_RESTART'];
      process.env['SUDO_RESTART_CMD'] = 'echo restart';
      const unref = vi.fn();
      spawnMock.mockReturnValue({ unref });

      const result = scheduleDetachedRestart('x', '/tmp');

      expect(result.scheduled).toBe(true);
      expect(result.cmd).toBe('echo restart');
      expect(spawnMock).toHaveBeenCalledOnce();
    });

    it('flag set to a non-"1" value does not block', () => {
      process.env['SUDO_BLOCK_AGENT_RESTART'] = '0';
      process.env['SUDO_RESTART_CMD'] = 'echo restart';
      const unref = vi.fn();
      spawnMock.mockReturnValue({ unref });

      const result = scheduleDetachedRestart('x', '/tmp');

      expect(result.scheduled).toBe(true);
      expect(spawnMock).toHaveBeenCalledOnce();
    });
  });

  describe('platform branches', () => {
    it('linux without pm2 still falls back to systemctl (unchanged)', () => {
      execSyncMock.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(resolveRestartCmd('linux')).toEqual({
        cmd: 'systemctl restart sudo-ai',
        via: 'systemctl',
      });
    });

    it('darwin without pm2 and without override resolves to manual', () => {
      execSyncMock.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(resolveRestartCmd('darwin')).toEqual({ cmd: '', via: 'manual' });
    });

    it('darwin with pm2 on PATH still uses pm2 (pm2 works on macOS)', () => {
      execSyncMock.mockReturnValue('/opt/homebrew/bin/pm2');
      expect(resolveRestartCmd('darwin')).toEqual({ cmd: PM2_DEFAULT, via: 'pm2' });
    });

    it('darwin honors SUDO_RESTART_CMD override', () => {
      process.env['SUDO_RESTART_CMD'] = 'launchctl kickstart -k gui/501/com.sudo-ai';
      expect(resolveRestartCmd('darwin')).toEqual({
        cmd: 'launchctl kickstart -k gui/501/com.sudo-ai',
        via: 'override',
      });
    });

    it('scheduleDetachedRestart on darwin (no mechanism) returns a clear manual-restart message and spawns nothing', () => {
      const restore = stubPlatform('darwin');
      try {
        execSyncMock.mockImplementation(() => {
          throw new Error('not found');
        });
        const result = scheduleDetachedRestart('unit-test', '/tmp');
        expect(result.scheduled).toBe(false);
        expect(result.error).toBe(DARWIN_NO_RESTART_MSG);
        expect(result.error).toContain('SUDO_RESTART_CMD');
        expect(result.error).toContain('sudo-ai stop && sudo-ai start -d');
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('scheduleDetachedRestart on linux still spawns the systemctl fallback (unchanged)', () => {
      const restore = stubPlatform('linux');
      try {
        execSyncMock.mockImplementation(() => {
          throw new Error('not found');
        });
        const unref = vi.fn();
        spawnMock.mockReturnValue({ unref });
        const result = scheduleDetachedRestart('unit-test', '/tmp');
        expect(result.scheduled).toBe(true);
        expect(result.cmd).toBe('systemctl restart sudo-ai');
        expect(spawnMock).toHaveBeenCalledWith(
          'sh',
          ['-c', 'sleep 3; systemctl restart sudo-ai'],
          expect.objectContaining({ detached: true }),
        );
      } finally {
        restore();
      }
    });
  });
});
