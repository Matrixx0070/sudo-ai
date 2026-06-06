/**
 * @file tests/config/settings-manager.test.ts
 * @description Tests for SettingsManager.
 *
 * Covers: get/set/delete, scopes, merge, tool allow/deny rules,
 * persistence (TOML save + load), edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SettingsManager } from '../../src/core/config/settings-manager.js';
import type { SettingsScope, SettingsFile } from '../../src/core/config/settings-manager.js';
import { ConfigError } from '../../src/core/shared/errors.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let manager: SettingsManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-ai-settings-test-'));
  manager = new SettingsManager({ rootDir: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeProjectToml(content: string): void {
  fs.writeFileSync(path.join(tmpDir, 'settings.toml'), content, 'utf8');
}

function writeLocalToml(content: string): void {
  fs.writeFileSync(path.join(tmpDir, 'settings.local.toml'), content, 'utf8');
}

function readProjectToml(): string {
  const p = path.join(tmpDir, 'settings.toml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsManager — basic get/set', () => {
  it('getSetting returns undefined for unknown key when no files exist', () => {
    expect(manager.getSetting('nonexistent')).toBeUndefined();
  });

  it('setSetting writes a value that can be read back', () => {
    manager.setSetting('agent.maxIterations', 50, 'project');
    expect(manager.getSetting('agent.maxIterations')).toBe(50);
  });

  it('setSetting in local scope does not appear in project scope', () => {
    manager.setSetting('myKey', 'local-value', 'local');
    expect(manager.getSettingScoped('myKey', 'local')).toBe('local-value');
    expect(manager.getSettingScoped('myKey', 'project')).toBeUndefined();
  });

  it('setSetting overwrites an existing value', () => {
    manager.setSetting('theme', 'dark', 'project');
    manager.setSetting('theme', 'light', 'project');
    expect(manager.getSetting('theme')).toBe('light');
  });

  it('deleteSetting removes a key and returns true', () => {
    manager.setSetting('temp', 123, 'project');
    const deleted = manager.deleteSetting('temp', 'project');
    expect(deleted).toBe(true);
    expect(manager.getSetting('temp')).toBeUndefined();
  });

  it('deleteSetting returns false for non-existent key', () => {
    const deleted = manager.deleteSetting('ghost', 'project');
    expect(deleted).toBe(false);
  });

  it('setSetting with empty key throws ConfigError', () => {
    expect(() => manager.setSetting('', 'val', 'project')).toThrow(ConfigError);
  });
});

describe('SettingsManager — scopes and merge', () => {
  it('local scope overrides project scope on conflict', () => {
    manager.setSetting('model', 'project-model', 'project');
    manager.setSetting('model', 'local-model', 'local');

    expect(manager.getSetting('model')).toBe('local-model');
  });

  it('getProjectSettings returns only project entries', () => {
    manager.setSetting('a', 1, 'project');
    manager.setSetting('b', 2, 'local');

    const proj = manager.getProjectSettings();
    expect(proj['a']).toBe(1);
    expect(proj['b']).toBeUndefined();
  });

  it('getLocalSettings returns only local entries', () => {
    manager.setSetting('a', 1, 'project');
    manager.setSetting('b', 2, 'local');

    const loc = manager.getLocalSettings();
    expect(loc['b']).toBe(2);
    expect(loc['a']).toBeUndefined();
  });

  it('getMergedSettings combines both scopes with local winning', () => {
    manager.setSetting('x', 'proj', 'project');
    manager.setSetting('y', 'proj', 'project');
    manager.setSetting('y', 'local', 'local');
    manager.setSetting('z', 'local', 'local');

    const merged = manager.getMergedSettings();
    expect(merged['x']).toBe('proj');
    expect(merged['y']).toBe('local'); // local overrides
    expect(merged['z']).toBe('local');
  });

  it('mergeSettings returns a SettingsFile with combined tool rules', () => {
    manager.addToolAllow('shell', 'read', 'project');
    manager.addToolAllow('shell', 'write', 'local');
    manager.addToolDeny('browser', 'navigate', 'project');

    const merged = manager.mergeSettings();
    expect(merged.toolAllow['shell']).toContain('read');
    expect(merged.toolAllow['shell']).toContain('write');
    expect(merged.toolDeny['browser']).toContain('navigate');
  });
});

describe('SettingsManager — tool allow/deny rules', () => {
  it('isToolActionAllowed returns true when no rules exist', () => {
    expect(manager.isToolActionAllowed('shell', 'read')).toBe(true);
  });

  it('isToolActionAllowed respects allow rules', () => {
    manager.addToolAllow('shell', 'read', 'project');
    manager.addToolAllow('shell', 'write', 'project');

    expect(manager.isToolActionAllowed('shell', 'read')).toBe(true);
    expect(manager.isToolActionAllowed('shell', 'write')).toBe(true);
    // Action not in allow list → denied (allow-only mode)
    expect(manager.isToolActionAllowed('shell', 'delete')).toBe(false);
  });

  it('isToolActionAllowed denies matched deny rules even if allow exists', () => {
    manager.addToolAllow('shell', '*', 'project');
    manager.addToolDeny('shell', 'rm', 'project');

    expect(manager.isToolActionAllowed('shell', 'read')).toBe(true);
    expect(manager.isToolActionAllowed('shell', 'rm')).toBe(false); // deny wins
  });

  it('isToolActionAllowed supports wildcard patterns', () => {
    manager.addToolDeny('shell', 'destructive:*', 'project');

    expect(manager.isToolActionAllowed('shell', 'destructive:rm')).toBe(false);
    expect(manager.isToolActionAllowed('shell', 'destructive:format')).toBe(false);
    expect(manager.isToolActionAllowed('shell', 'read')).toBe(true); // no deny match
  });

  it('addToolAllow does not duplicate patterns', () => {
    manager.addToolAllow('tool', 'read', 'project');
    manager.addToolAllow('tool', 'read', 'project');

    const rules = manager.getToolRules('tool');
    expect(rules.allow.filter((p) => p === 'read').length).toBe(1);
  });

  it('removeToolAllow removes a pattern', () => {
    manager.addToolAllow('tool', 'read', 'project');
    manager.addToolAllow('tool', 'write', 'project');

    const removed = manager.removeToolAllow('tool', 'read', 'project');
    expect(removed).toBe(true);

    const rules = manager.getToolRules('tool');
    expect(rules.allow).toEqual(['write']);
  });

  it('removeToolAllow returns false for non-existent pattern', () => {
    expect(manager.removeToolAllow('tool', 'ghost', 'project')).toBe(false);
  });

  it('removeToolDeny works similarly', () => {
    manager.addToolDeny('tool', 'rm', 'project');
    expect(manager.removeToolDeny('tool', 'rm', 'project')).toBe(true);
    expect(manager.removeToolDeny('tool', 'rm', 'project')).toBe(false);
  });

  it('local scope deny rules merge with project allow rules', () => {
    manager.addToolAllow('shell', 'read', 'project');
    manager.addToolAllow('shell', 'write', 'project');
    manager.addToolDeny('shell', 'write', 'local'); // local denies what project allows

    // Deny wins
    expect(manager.isToolActionAllowed('shell', 'write')).toBe(false);
    expect(manager.isToolActionAllowed('shell', 'read')).toBe(true);
  });
});

describe('SettingsManager — persistence', () => {
  it('saveSettings writes a TOML file for project scope', () => {
    manager.setSetting('name', 'test-agent', 'project');
    manager.addToolAllow('shell', 'read', 'project');
    manager.saveSettings('project');

    const content = readProjectToml();
    expect(content).toContain('[settings]');
    expect(content).toContain('name = "test-agent"');
    expect(content).toContain('[toolAllow.shell]');
  });

  it('loadSettings reads back persisted project settings', () => {
    manager.setSetting('port', 3000, 'project');
    manager.addToolDeny('browser', 'navigate', 'project');
    manager.saveSettings('project');

    // Create a fresh manager pointing to the same dir
    const loader = new SettingsManager({ rootDir: tmpDir });
    // The settings should be readable after lazy load
    expect(loader.getSetting('port')).toBe(3000);
    expect(loader.isToolActionAllowed('browser', 'navigate')).toBe(false);
  });

  it('loadSettings reads local settings', () => {
    manager.setSetting('theme', 'dark', 'local');
    manager.saveSettings('local');

    const loader = new SettingsManager({ rootDir: tmpDir });
    expect(loader.getSetting('theme')).toBe('dark');
  });

  it('loadSettings merges both scopes from disk', () => {
    manager.setSetting('key1', 'from-project', 'project');
    manager.setSetting('key2', 'from-local', 'local');
    manager.saveSettings('project');
    manager.saveSettings('local');

    const loader = new SettingsManager({ rootDir: tmpDir });
    expect(loader.getSetting('key1')).toBe('from-project');
    expect(loader.getSetting('key2')).toBe('from-local');
  });

  it('loadSettings handles missing files gracefully', () => {
    // No files exist — fresh manager
    const loader = new SettingsManager({ rootDir: tmpDir });
    expect(loader.getSetting('anything')).toBeUndefined();
    expect(loader.getProjectSettings()).toEqual({});
    expect(loader.getLocalSettings()).toEqual({});
  });

  it('loadSettings handles corrupt TOML gracefully', () => {
    writeProjectToml('[[[invalid toml {{{');
    const loader = new SettingsManager({ rootDir: tmpDir });
    // Should not throw, should fall back to empty
    expect(loader.getSetting('anything')).toBeUndefined();
  });

  it('round-trip: complex settings survive save and reload', () => {
    manager.setSetting('agent.name', 'sudo-ai', 'project');
    manager.setSetting('agent.maxIterations', 100, 'project');
    manager.setSetting('agent.debug', true, 'project');
    manager.addToolAllow('shell', 'read', 'project');
    manager.addToolAllow('shell', 'write', 'project');
    manager.addToolDeny('shell', 'destructive:*', 'project');
    manager.saveSettings('project');

    const loader = new SettingsManager({ rootDir: tmpDir });
    expect(loader.getSetting('agent.name')).toBe('sudo-ai');
    expect(loader.getSetting('agent.maxIterations')).toBe(100);
    expect(loader.getSetting('agent.debug')).toBe(true);
    expect(loader.isToolActionAllowed('shell', 'read')).toBe(true);
    expect(loader.isToolActionAllowed('shell', 'destructive:rm')).toBe(false);
  });
});

describe('SettingsManager — getPaths', () => {
  it('returns correct file paths', () => {
    const paths = manager.getPaths();
    expect(paths.project).toBe(path.join(tmpDir, 'settings.toml'));
    expect(paths.local).toBe(path.join(tmpDir, 'settings.local.toml'));
  });

  it('custom filenames are reflected in paths', () => {
    const custom = new SettingsManager({
      rootDir: tmpDir,
      projectFilename: 'custom-settings.toml',
      localFilename: 'custom-settings.local.toml',
    });
    const paths = custom.getPaths();
    expect(paths.project).toBe(path.join(tmpDir, 'custom-settings.toml'));
    expect(paths.local).toBe(path.join(tmpDir, 'custom-settings.local.toml'));
  });
});

describe('SettingsManager — edge cases', () => {
  it('deleting a key from project does not affect local', () => {
    manager.setSetting('k', 'proj', 'project');
    manager.setSetting('k', 'loc', 'local');

    manager.deleteSetting('k', 'project');
    // Now only local remains
    expect(manager.getSetting('k')).toBe('loc');
  });

  it('deleting a key from local exposes project value', () => {
    manager.setSetting('k', 'proj', 'project');
    manager.setSetting('k', 'loc', 'local');

    manager.deleteSetting('k', 'local');
    // Project value is now visible
    expect(manager.getSetting('k')).toBe('proj');
  });

  it('setting various types: string, number, boolean', () => {
    manager.setSetting('str', 'hello', 'project');
    manager.setSetting('num', 42, 'project');
    manager.setSetting('bool', true, 'project');

    expect(manager.getSetting('str')).toBe('hello');
    expect(manager.getSetting('num')).toBe(42);
    expect(manager.getSetting('bool')).toBe(true);
  });

  it('empty tool rules for an unknown tool default to allowed', () => {
    expect(manager.isToolActionAllowed('nonexistent-tool', 'any-action')).toBe(true);
  });

  it('multiple allow patterns with no deny — unmatched action denied', () => {
    manager.addToolAllow('tool', 'read', 'project');
    manager.addToolAllow('tool', 'write', 'project');
    // 'delete' is not in allow list, no deny list → denied because allow exists but doesn't match
    expect(manager.isToolActionAllowed('tool', 'delete')).toBe(false);
  });
});