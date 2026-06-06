import { describe, it, expect, beforeEach } from 'vitest';
import { ProfileManager, type AgentProfile, type ProfileConfig } from '../../src/core/agent/profile.js';
import type { ToolDefinition, ToolResult } from '../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    category: 'coder',
    parameters: {},
    execute: async () => ({ success: true, output: 'ok' } as ToolResult),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileManager', () => {
  let manager: ProfileManager;

  beforeEach(() => {
    manager = new ProfileManager();
  });

  it('default profile exists on creation', () => {
    const profiles = manager.listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    const defaultProfile = manager.getDefaultProfile();
    expect(defaultProfile.name).toBe('main');
    expect(defaultProfile.id).toBeTruthy();
  });

  it('create profile with custom name', () => {
    const profile = manager.createProfile({ name: 'work' });
    expect(profile.name).toBe('work');
    expect(profile.id).toBeTruthy();
    expect(profile.homeDir).toContain('data/profiles/');
    expect(profile.memoryNamespace).toBe('work');
  });

  it('get profile by name', () => {
    manager.createProfile({ name: 'research' });
    const found = manager.getProfileByName('research');
    expect(found).toBeDefined();
    expect(found!.name).toBe('research');
  });

  it('get profile by id', () => {
    const created = manager.createProfile({ name: 'dev' });
    const found = manager.getProfile(created.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('dev');
  });

  it('delete profile removes it', () => {
    const profile = manager.createProfile({ name: 'temp' });
    const deleted = manager.deleteProfile(profile.id);
    expect(deleted).toBe(true);
    expect(manager.getProfile(profile.id)).toBeUndefined();
  });

  it('cannot delete default profile', () => {
    const defaultProfile = manager.getDefaultProfile();
    const deleted = manager.deleteProfile(defaultProfile.id);
    expect(deleted).toBe(false);
    expect(manager.getProfile(defaultProfile.id)).toBeDefined();
  });

  it('max profiles limit is enforced', () => {
    const limited = new ProfileManager({ maxProfiles: 2 });
    limited.createProfile({ name: 'extra' }); // default + extra = 2
    expect(() => limited.createProfile({ name: 'overflow' })).toThrow(/max profiles/);
  });

  it('duplicate name throws error', () => {
    manager.createProfile({ name: 'unique' });
    expect(() => manager.createProfile({ name: 'unique' })).toThrow(/already exists/);
  });

  it('tools filtering with allow list', () => {
    const profile = manager.createProfile({
      name: 'restricted',
      tools: { allow: ['fs.read', 'fs.write'] },
    });
    const allTools = [makeTool('fs.read'), makeTool('fs.write'), makeTool('exec')];
    const filtered = manager.getToolsForProfile(profile.id, allTools);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((t) => t.name)).toContain('fs.read');
    expect(filtered.map((t) => t.name)).not.toContain('exec');
  });

  it('tools filtering with deny list', () => {
    const profile = manager.createProfile({
      name: 'safe',
      tools: { deny: ['exec'] },
    });
    const allTools = [makeTool('fs.read'), makeTool('exec')];
    const filtered = manager.getToolsForProfile(profile.id, allTools);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('fs.read');
  });

  it('stats reflect current profile count', () => {
    const stats = manager.getStats();
    expect(stats.totalProfiles).toBe(1); // default only
    manager.createProfile({ name: 'second' });
    const updated = manager.getStats();
    expect(updated.totalProfiles).toBe(2);
  });
});