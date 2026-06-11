/**
 * Tests for profile-manager.ts.
 *
 * Tests cover:
 * - createProfile, getProfile, listProfiles, deleteProfile
 * - activateProfile, getActiveProfile
 * - cloneProfile (deep copies config, env, skills)
 * - Kill-switch SUDO_PROFILES_DISABLE=1
 * - Profile isolation (different env vars per profile)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileManager, profileManager } from '../../src/core/profiles/profile-manager.js';
import type { ProfileCreateOptions } from '../../src/core/profiles/profile-types.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testProfilesDir: string;

beforeEach(() => {
  // Create unique temp directory for each test
  testProfilesDir = mkdtempSync(join(tmpdir(), 'sudo-profiles-test-'));

  // Set test DATA_DIR to isolated temp directory
  process.env['DATA_DIR'] = testProfilesDir;
  delete process.env['SUDO_PROFILES_DISABLE'];
  delete process.env['SUDO_ACTIVE_PROFILE'];
});

afterEach(() => {
  // Clean up temp directory
  try {
    rmSync(testProfilesDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
  delete process.env['SUDO_PROFILES_DISABLE'];
  delete process.env['SUDO_ACTIVE_PROFILE'];
});

// ---------------------------------------------------------------------------
// ProfileManager tests
// ---------------------------------------------------------------------------

describe('ProfileManager', () => {
  describe('createProfile', () => {
    it('creates a new profile with minimal options', () => {
      const manager = new ProfileManager();
      const profile = manager.createProfile({ name: 'test-profile' });

      expect(profile.name).toBe('test-profile');
      expect(profile.displayName).toBe('test-profile');
      expect(profile.config).toEqual({});
      expect(profile.env).toEqual({});
      expect(profile.skills).toEqual([]);
      expect(profile.enabled).toBe(true);
      expect(profile.createdAt).toBeDefined();
      expect(profile.updatedAt).toBeDefined();
    });

    it('creates a profile with all options', () => {
      const manager = new ProfileManager();
      const options: ProfileCreateOptions = {
        name: 'full-profile',
        displayName: 'Full Profile',
        config: { maxIterations: 50 },
        env: { CUSTOM_VAR: 'value' },
        soulMd: '# Custom SOUL',
        skills: ['skill-1', 'skill-2'],
      };

      const profile = manager.createProfile(options);

      expect(profile.name).toBe('full-profile');
      expect(profile.displayName).toBe('Full Profile');
      expect(profile.config).toEqual({ maxIterations: 50 });
      expect(profile.env).toEqual({ CUSTOM_VAR: 'value' });
      expect(profile.soulMd).toBe('# Custom SOUL');
      expect(profile.skills).toEqual(['skill-1', 'skill-2']);
    });

    it('throws on duplicate profile name', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'duplicate' });

      expect(() => manager.createProfile({ name: 'duplicate' })).toThrow('already exists');
    });

    it('throws on invalid profile name (path traversal)', () => {
      const manager = new ProfileManager();
      expect(() => manager.createProfile({ name: '../etc/passwd' })).toThrow('letters, numbers, hyphens, and underscores');
    });

    it('throws on empty profile name', () => {
      const manager = new ProfileManager();
      expect(() => manager.createProfile({ name: '' })).toThrow('Profile name is required');
    });

    it('throws when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      expect(() => manager.createProfile({ name: 'blocked' })).toThrow('Profiles disabled');
    });
  });

  describe('getProfile', () => {
    it('returns profile by name', () => {
      const manager = new ProfileManager();
      const created = manager.createProfile({ name: 'get-test', displayName: 'Get Test' });

      const retrieved = manager.getProfile('get-test');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('get-test');
      expect(retrieved!.displayName).toBe('Get Test');
    });

    it('returns null for non-existent profile', () => {
      const manager = new ProfileManager();
      const result = manager.getProfile('non-existent');
      expect(result).toBeNull();
    });

    it('returns null when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      // getProfile returns null when disabled, doesn't throw
      expect(manager.getProfile('blocked-get')).toBeNull();
    });
  });

  describe('listProfiles', () => {
    it('lists all profiles sorted by lastActive', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'alpha' });
      // Small delay to ensure different timestamps
      const delay = (ms: number) => {
        const start = Date.now();
        while (Date.now() - start < ms) {} // Busy wait
      };
      delay(2);
      manager.createProfile({ name: 'beta' });

      const list = manager.listProfiles();

      expect(list.length).toBe(2);
      // beta should be more recent (sorted by updatedAt desc)
      expect(list[0].name).toBe('beta');
      expect(list[1].name).toBe('alpha');
    });

    it('returns empty array when no profiles exist', () => {
      const manager = new ProfileManager();
      expect(manager.listProfiles()).toEqual([]);
    });

    it('returns empty array when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      // listProfiles returns empty array when disabled, doesn't throw
      expect(manager.listProfiles()).toEqual([]);
    });
  });

  describe('deleteProfile', () => {
    it('deletes existing profile', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'to-delete' });

      const result = manager.deleteProfile('to-delete');

      expect(result).toBe(true);
      expect(manager.getProfile('to-delete')).toBeNull();
    });

    it('returns false for non-existent profile', () => {
      const manager = new ProfileManager();
      expect(manager.deleteProfile('non-existent')).toBe(false);
    });

    it('throws when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      expect(() => manager.deleteProfile('blocked')).toThrow('Profiles disabled');
    });
  });

  describe('activateProfile', () => {
    it('activates existing profile', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'activate-me' });

      const result = manager.activateProfile('activate-me');

      expect(result).toBe(true);
      expect(manager.getActiveProfile()).toBe('activate-me');
      expect(process.env['SUDO_ACTIVE_PROFILE']).toBe('activate-me');
    });

    it('returns false for non-existent profile', () => {
      const manager = new ProfileManager();
      expect(manager.activateProfile('non-existent')).toBe(false);
    });

    it('throws when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      expect(() => manager.activateProfile('blocked')).toThrow('Profiles disabled');
    });
  });

  describe('getActiveProfile', () => {
    it('returns active profile name', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'active-profile' });
      manager.activateProfile('active-profile');

      expect(manager.getActiveProfile()).toBe('active-profile');
    });

    it('returns null when no profile is active', () => {
      const manager = new ProfileManager();
      expect(manager.getActiveProfile()).toBeNull();
    });

    it('reads from env if set externally', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'env-set' });
      process.env['SUDO_ACTIVE_PROFILE'] = 'env-set';

      expect(manager.getActiveProfile()).toBe('env-set');
    });

    it('returns null when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      expect(manager.getActiveProfile()).toBeNull();
    });
  });

  describe('cloneProfile', () => {
    it('clones profile with deep copied config, env, skills', () => {
      const manager = new ProfileManager();
      const source = manager.createProfile({
        name: 'source',
        displayName: 'Source Profile',
        config: { original: true },
        env: { SOURCE_VAR: 'source-value' },
        soulMd: '# Source SOUL',
        skills: ['source-skill'],
      });

      const cloned = manager.cloneProfile('source', 'cloned', 'Cloned Profile');

      expect(cloned.name).toBe('cloned');
      expect(cloned.displayName).toBe('Cloned Profile');
      expect(cloned.config).toEqual({ original: true });
      expect(cloned.env).toEqual({ SOURCE_VAR: 'source-value' });
      expect(cloned.soulMd).toBe('# Source SOUL');
      expect(cloned.skills).toEqual(['source-skill']);

      // Verify deep copy - modifying source doesn't affect clone
      source.config.modified = true;
      expect(cloned.config).not.toHaveProperty('modified');
    });

    it('throws if source profile does not exist', () => {
      const manager = new ProfileManager();
      expect(() => manager.cloneProfile('non-existent', 'target')).toThrow('does not exist');
    });

    it('throws if target profile already exists', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'existing-target' });
      manager.createProfile({ name: 'source-for-clone' });

      expect(() => manager.cloneProfile('source-for-clone', 'existing-target')).toThrow('already exists');
    });

    it('throws when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      expect(() => manager.cloneProfile('a', 'b')).toThrow('Profiles disabled');
    });
  });

  describe('profile isolation', () => {
    it('maintains separate env vars per profile', () => {
      const manager = new ProfileManager();

      manager.createProfile({
        name: 'profile-a',
        env: { PROFILE_ID: 'A', SHARED: 'from-a' },
        skills: ['skill-a'],
      });

      manager.createProfile({
        name: 'profile-b',
        env: { PROFILE_ID: 'B', SHARED: 'from-b' },
        skills: ['skill-b'],
      });

      manager.activateProfile('profile-a');
      const envA = manager.getActiveProfileEnv();
      const skillsA = manager.getActiveProfileSkills();

      expect(envA.PROFILE_ID).toBe('A');
      expect(envA.SHARED).toBe('from-a');
      expect(skillsA).toEqual(['skill-a']);

      manager.activateProfile('profile-b');
      const envB = manager.getActiveProfileEnv();
      const skillsB = manager.getActiveProfileSkills();

      expect(envB.PROFILE_ID).toBe('B');
      expect(envB.SHARED).toBe('from-b');
      expect(skillsB).toEqual(['skill-b']);
    });
  });
});
