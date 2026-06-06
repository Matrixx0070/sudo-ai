/**
 * Tests for ZDR (Zero Data Retention) Mode.
 *
 * Covers:
 * - ZDRModeManager.resolve() — configuration resolution from all sources
 * - isBlocked() — runtime gating of data operations
 * - Repo visibility detection (mocked)
 * - Environment variable overrides
 * - forceEnable() — one-way gate
 * - Singleton getZDRManager()
 * - isZDRBlocked() convenience function
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ZDRModeManager,
  getZDRManager,
  isZDRBlocked,
  detectRepoVisibility,
  getRepoVisibilityOverride,
  type ZDRConfig,
  type RepoVisibility,
} from '../../src/core/privacy/zdr-mode.js';

// ---------------------------------------------------------------------------
// Repo visibility mock
// ---------------------------------------------------------------------------

// Mock execSync for repo visibility detection
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';

const mockedExecSync = vi.mocked(execSync);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ZDRModeManager', () => {
  let manager: ZDRModeManager;

  beforeEach(() => {
    manager = new ZDRModeManager();
    vi.clearAllMocks();
  });

  describe('resolve()', () => {
    it('should default to ZDR disabled', () => {
      const config = manager.resolve();
      expect(config.enabled).toBe(false);
      expect(config.source).toBe('default');
    });

    it('should enable ZDR from CLI flag', () => {
      const config = manager.resolve({ cliFlag: true });
      expect(config.enabled).toBe(true);
      expect(config.source).toBe('cli');
    });

    it('should enable ZDR from JWT claim', () => {
      const config = manager.resolve({ jwtClaim: true });
      expect(config.enabled).toBe(true);
      expect(config.source).toBe('jwt');
    });

    it('should enable ZDR from SUDO_ZDR env', () => {
      process.env['SUDO_ZDR'] = '1';
      try {
        const config = manager.resolve();
        expect(config.enabled).toBe(true);
        expect(config.source).toBe('env');
      } finally {
        delete process.env['SUDO_ZDR'];
      }
    });

    it('should enable ZDR from SUDO_DATA_RETENTION_OPT_OUT env', () => {
      process.env['SUDO_DATA_RETENTION_OPT_OUT'] = '1';
      try {
        const config = manager.resolve();
        expect(config.enabled).toBe(true);
        expect(config.source).toBe('env');
      } finally {
        delete process.env['SUDO_DATA_RETENTION_OPT_OUT'];
      }
    });

    it('should enable ZDR from config file flag', () => {
      const config = manager.resolve({ configFile: true });
      expect(config.enabled).toBe(true);
      expect(config.source).toBe('config');
    });

    it('should prioritize CLI flag over env', () => {
      process.env['SUDO_ZDR'] = '1';
      try {
        const config = manager.resolve({ cliFlag: true });
        expect(config.source).toBe('cli');
      } finally {
        delete process.env['SUDO_ZDR'];
      }
    });

    it('should prioritize JWT over env', () => {
      process.env['SUDO_ZDR'] = '1';
      try {
        const config = manager.resolve({ jwtClaim: true });
        expect(config.source).toBe('jwt');
      } finally {
        delete process.env['SUDO_ZDR'];
      }
    });

    it('should block all data operations when ZDR is enabled', () => {
      const config = manager.resolve({ cliFlag: true });
      expect(config.blockTelemetry).toBe(true);
      expect(config.blockSessionPersistence).toBe(true);
      expect(config.blockMemoryWrites).toBe(true);
      expect(config.blockConsciousnessRecording).toBe(true);
    });

    it('should block telemetry for private repos even without ZDR', () => {
      mockedExecSync.mockReturnValue('git@github.com:user/private-repo.git');
      const config = manager.resolve();
      expect(config.enabled).toBe(false);
      expect(config.blockTelemetry).toBe(true);
      expect(config.isPrivateRepo).toBe(true);
    });

    it('should not block telemetry for public repos without ZDR', () => {
      mockedExecSync.mockReturnValue('https://github.com/user/public-repo.git');
      const config = manager.resolve();
      expect(config.enabled).toBe(false);
      expect(config.blockTelemetry).toBe(false);
      expect(config.isPrivateRepo).toBe(false);
    });

    it('should respect SUDO_REPO_VISIBILITY override', () => {
      process.env['SUDO_REPO_VISIBILITY'] = 'private';
      // Force execSync to fail so we test the override path
      mockedExecSync.mockImplementation(() => { throw new Error('no git'); });
      try {
        const config = manager.resolve();
        expect(config.isPrivateRepo).toBe(true);
        expect(config.blockTelemetry).toBe(true);
      } finally {
        delete process.env['SUDO_REPO_VISIBILITY'];
      }
    });
  });

  describe('isBlocked()', () => {
    it('should block session persistence when ZDR is on', () => {
      manager.resolve({ cliFlag: true });
      expect(manager.isBlocked('session_persistence')).toBe(true);
    });

    it('should block memory writes when ZDR is on', () => {
      manager.resolve({ cliFlag: true });
      expect(manager.isBlocked('memory_write')).toBe(true);
    });

    it('should block telemetry when ZDR is on', () => {
      manager.resolve({ cliFlag: true });
      expect(manager.isBlocked('telemetry')).toBe(true);
    });

    it('should block consciousness recording when ZDR is on', () => {
      manager.resolve({ cliFlag: true });
      expect(manager.isBlocked('consciousness_recording')).toBe(true);
    });

    it('should block trace upload when ZDR is on', () => {
      manager.resolve({ cliFlag: true });
      expect(manager.isBlocked('trace_upload')).toBe(true);
    });

    it('should not block session persistence when ZDR is off and repo is public', () => {
      mockedExecSync.mockReturnValue('https://github.com/user/public-repo.git');
      manager.resolve();
      expect(manager.isBlocked('session_persistence')).toBe(false);
    });

    it('should auto-resolve if isBlocked called before resolve', () => {
      // Should not throw, should auto-resolve with defaults
      expect(manager.isBlocked('telemetry')).toBe(false);
    });
  });

  describe('forceEnable()', () => {
    it('should enable ZDR at runtime', () => {
      manager.resolve();
      expect(manager.isEnabled()).toBe(false);
      manager.forceEnable('cli');
      expect(manager.isEnabled()).toBe(true);
    });

    it('should be a one-way gate — cannot disable once enabled', () => {
      manager.resolve({ cliFlag: true });
      // forceEnable when already enabled should be a no-op
      manager.forceEnable('jwt');
      expect(manager.getConfig().source).toBe('cli'); // original source preserved
    });

    it('should block all operations after force-enable', () => {
      manager.resolve();
      manager.forceEnable('env');
      expect(manager.isBlocked('session_persistence')).toBe(true);
      expect(manager.isBlocked('telemetry')).toBe(true);
    });
  });

  describe('getConfig()', () => {
    it('should return a copy of the config', () => {
      manager.resolve({ cliFlag: true });
      const config1 = manager.getConfig();
      const config2 = manager.getConfig();
      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // different object references
    });
  });

  describe('isTelemetryBlocked()', () => {
    it('should return true when ZDR is on', () => {
      manager.resolve({ cliFlag: true });
      expect(manager.isTelemetryBlocked()).toBe(true);
    });

    it('should return true for private repos even without ZDR', () => {
      mockedExecSync.mockReturnValue('git@github.com:user/private.git');
      manager.resolve();
      expect(manager.isTelemetryBlocked()).toBe(true);
    });

    it('should return false for public repos without ZDR', () => {
      mockedExecSync.mockReturnValue('https://github.com/user/public.git');
      manager.resolve();
      expect(manager.isTelemetryBlocked()).toBe(false);
    });
  });
});

describe('detectRepoVisibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should detect SSH URLs as private', () => {
    mockedExecSync.mockReturnValue('git@github.com:user/repo.git');
    expect(detectRepoVisibility()).toBe('private');
  });

  it('should detect HTTPS URLs with auth tokens as private', () => {
    mockedExecSync.mockReturnValue('https://user:token@github.com/user/repo.git');
    expect(detectRepoVisibility()).toBe('private');
  });

  it('should detect standard HTTPS URLs as public', () => {
    mockedExecSync.mockReturnValue('https://github.com/user/repo.git');
    expect(detectRepoVisibility()).toBe('public');
  });

  it('should return unknown when git command fails', () => {
    mockedExecSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(detectRepoVisibility()).toBe('unknown');
  });
});

describe('getRepoVisibilityOverride', () => {
  afterEach(() => {
    delete process.env['SUDO_REPO_VISIBILITY'];
  });

  it('should return null when env is not set', () => {
    expect(getRepoVisibilityOverride()).toBeNull();
  });

  it('should return public when env is public', () => {
    process.env['SUDO_REPO_VISIBILITY'] = 'public';
    expect(getRepoVisibilityOverride()).toBe('public');
  });

  it('should return private when env is private', () => {
    process.env['SUDO_REPO_VISIBILITY'] = 'private';
    expect(getRepoVisibilityOverride()).toBe('private');
  });

  it('should return null for invalid values', () => {
    process.env['SUDO_REPO_VISIBILITY'] = 'invalid';
    expect(getRepoVisibilityOverride()).toBeNull();
  });
});

describe('isZDRBlocked convenience', () => {
  it('should use global singleton', () => {
    // Reset singleton by creating a fresh manager
    const mgr = getZDRManager();
    mgr.resolve({ cliFlag: true });
    expect(isZDRBlocked('telemetry')).toBe(true);
  });
});