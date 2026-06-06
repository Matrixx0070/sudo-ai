/**
 * @file sandbox-profiles.test.ts
 * @description Tests for Sandbox ProfileManager.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ProfileManager, type SandboxProfileName, type SandboxProfile } from '../../src/core/sandbox/sandbox-profiles.js';

describe('ProfileManager', () => {
  let pm: ProfileManager;

  beforeEach(() => {
    pm = new ProfileManager();
  });

  it('should start with workspace profile as default', () => {
    expect(pm.getCurrentProfile()).toBe('workspace');
  });

  it('should resolve the workspace profile', () => {
    const profile = pm.resolve('workspace', '/home/user/project');
    expect(profile.enabled).toBe(true);
    expect(profile.profile).toBe('workspace');
  });

  it('should resolve the off profile', () => {
    const profile = pm.resolve('off');
    expect(profile.enabled).toBe(false);
    expect(profile.network).toBe('host');
  });

  it('should resolve the read-only profile', () => {
    const profile = pm.resolve('read-only', '/home/user/project');
    expect(profile.enabled).toBe(true);
    expect(profile.network).toBe('none');
    expect(profile.extraReadOnlyBinds).toBeDefined();
    expect(profile.extraReadOnlyBinds!).toContain('/home/user/project');
  });

  it('should resolve the strict profile', () => {
    const profile = pm.resolve('strict', '/home/user/project');
    expect(profile.enabled).toBe(true);
    expect(profile.network).toBe('none');
    expect(profile.cpuSeconds).toBe(15);
    expect(profile.memoryMB).toBe(256);
    expect(profile.extraReadOnlyBinds).toBeDefined();
    expect(profile.extraReadOnlyBinds!).toContain('/home/user/project');
  });

  it('should fall back to workspace for unknown profiles', () => {
    const profile = pm.resolve('nonexistent' as SandboxProfileName);
    expect(profile.profile).toBe('workspace');
  });

  it('should allow changing the current profile', () => {
    pm.setProfile('strict');
    expect(pm.getCurrentProfile()).toBe('strict');
  });

  it('should throw when setting an invalid profile', () => {
    expect(() => pm.setProfile('invalid' as SandboxProfileName)).toThrow('Unknown sandbox profile');
  });

  it('should list all available profiles', () => {
    const profiles = pm.getAvailableProfiles();
    expect(profiles).toContain('off');
    expect(profiles).toContain('workspace');
    expect(profiles).toContain('read-only');
    expect(profiles).toContain('strict');
    expect(profiles.length).toBe(4);
  });

  it('should get profile definition by name', () => {
    const profile = pm.getProfile('strict');
    expect(profile).toBeDefined();
    expect(profile?.profile).toBe('strict');
    expect(profile?.description).toBeTruthy();
  });

  it('should add workspace as writable bind for workspace profile', () => {
    const profile = pm.resolve('workspace', '/home/user/project');
    expect(profile.extraWritableBinds).toBeDefined();
    expect(profile.extraWritableBinds!).toContain('/home/user/project');
  });

  it('should add workspace as read-only bind for strict profile', () => {
    const profile = pm.resolve('strict', '/home/user/project');
    expect(profile.extraReadOnlyBinds).toBeDefined();
    expect(profile.extraReadOnlyBinds!).toContain('/home/user/project');
  });

  it('should not add binds for off profile', () => {
    const profile = pm.resolve('off', '/home/user/project');
    expect(profile.extraWritableBinds).toBeUndefined();
    expect(profile.extraReadOnlyBinds).toBeUndefined();
  });
});