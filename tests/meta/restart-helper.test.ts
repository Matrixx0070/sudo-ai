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
  restartCommand,
  resolveRestartCmd,
  scheduleDetachedRestart,
} from '../../src/core/tools/builtin/meta/restart-helper.js';

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
});
