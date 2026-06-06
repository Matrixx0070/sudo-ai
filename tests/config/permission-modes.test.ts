/**
 * @file tests/config/permission-modes.test.ts
 * @description Tests for PermissionModeManager.
 *
 * Covers: mode get/set, cycle, bypass confirmation, action allowance,
 * persistence (save + load), mode descriptions, edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PermissionModeManager } from '../../src/core/config/permission-modes.js';
import type { PermissionModeType, ActionCategory, PermissionModeConfig } from '../../src/core/config/permission-modes.js';
import { ConfigError } from '../../src/core/shared/errors.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let manager: PermissionModeManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-ai-perm-test-'));
  manager = new PermissionModeManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionModeManager', () => {
  it('starts in default mode', () => {
    expect(manager.getMode()).toBe('default');
  });

  it('setMode changes the current mode', () => {
    manager.setMode('acceptEdits');
    expect(manager.getMode()).toBe('acceptEdits');

    manager.setMode('autoAccept');
    expect(manager.getMode()).toBe('autoAccept');
  });

  it('setMode to bypass throws without confirmation', () => {
    expect(() => manager.setMode('bypass')).toThrow(ConfigError);
    expect(() => manager.setMode('bypass')).toThrow('confirmBypass');
    // Mode should not have changed
    expect(manager.getMode()).toBe('default');
  });

  it('setMode to bypass succeeds with confirmation', () => {
    manager.setMode('bypass', true);
    expect(manager.getMode()).toBe('bypass');
    expect(manager.isBypassConfirmed()).toBe(true);
  });

  it('cycleMode advances through all modes in order', () => {
    expect(manager.getMode()).toBe('default');

    manager.cycleMode();
    expect(manager.getMode()).toBe('acceptEdits');

    manager.cycleMode();
    expect(manager.getMode()).toBe('autoAccept');

    // Cycling into bypass requires confirmation
    expect(() => manager.cycleMode()).toThrow(ConfigError);
  });

  it('cycleMode wraps back to default after bypass', () => {
    manager.setMode('bypass', true);
    expect(manager.getMode()).toBe('bypass');

    manager.cycleMode(); // bypass → default (wraps)
    expect(manager.getMode()).toBe('default');
  });

  it('isActionAllowed is correct for default mode', () => {
    // Default: everything requires prompt
    expect(manager.isActionAllowed('file_edit')).toBe(false);
    expect(manager.isActionAllowed('command_run')).toBe(false);
    expect(manager.isActionAllowed('command_destructive')).toBe(false);
    expect(manager.isActionAllowed('tool_call')).toBe(false);
    expect(manager.isActionAllowed('agent_spawn')).toBe(false);
    expect(manager.isActionAllowed('config_change')).toBe(false);
    // file_read is not in the prompt set for default, so it IS allowed
    expect(manager.isActionAllowed('file_read')).toBe(true);
  });

  it('isActionAllowed is correct for acceptEdits mode', () => {
    manager.setMode('acceptEdits');
    expect(manager.isActionAllowed('file_edit')).toBe(true);   // auto-accepted
    expect(manager.isActionAllowed('command_run')).toBe(false); // needs prompt
    expect(manager.isActionAllowed('command_destructive')).toBe(false);
  });

  it('isActionAllowed is correct for autoAccept mode', () => {
    manager.setMode('autoAccept');
    expect(manager.isActionAllowed('file_edit')).toBe(true);
    expect(manager.isActionAllowed('command_run')).toBe(true);
    expect(manager.isActionAllowed('command_destructive')).toBe(false); // still needs prompt
    expect(manager.isActionAllowed('agent_spawn')).toBe(false);
  });

  it('isActionAllowed is correct for bypass mode', () => {
    manager.setMode('bypass', true);
    // Everything is allowed in bypass
    const allCategories: ActionCategory[] = [
      'file_edit', 'file_read', 'command_run', 'command_destructive',
      'network_request', 'tool_call', 'agent_spawn', 'config_change',
    ];
    for (const cat of allCategories) {
      expect(manager.isActionAllowed(cat)).toBe(true);
    }
  });

  it('getModeDescription returns a non-empty human-readable string', () => {
    const desc = manager.getModeDescription();
    expect(desc).toContain('[Default]');
    expect(desc.length).toBeGreaterThan(10);

    manager.setMode('acceptEdits');
    const desc2 = manager.getModeDescription();
    expect(desc2).toContain('[Accept Edits]');
  });

  it('getModeConfig returns the full configuration for current mode', () => {
    const cfg = manager.getModeConfig();
    expect(cfg.label).toBe('Default');
    expect(cfg.requiresPrompt).toBeInstanceOf(Set);
    expect(cfg.requiresPrompt.has('file_edit')).toBe(true);
  });

  it('getAllModes returns the four modes in order', () => {
    const modes = manager.getAllModes();
    expect(modes).toEqual(['default', 'acceptEdits', 'autoAccept', 'bypass']);
  });

  it('getModeConfigFor returns config for any mode', () => {
    const bypassCfg = manager.getModeConfigFor('bypass');
    expect(bypassCfg.label).toBe('Bypass');
    expect(bypassCfg.requiresPrompt.size).toBe(0);

    const defaultCfg = manager.getModeConfigFor('default');
    expect(defaultCfg.requiresPrompt.size).toBeGreaterThan(0);
  });
});

describe('PermissionModeManager — persistence', () => {
  it('persistMode writes a JSON file to disk', () => {
    manager.setMode('acceptEdits');
    manager.persistMode();

    const persistPath = path.join(tmpDir, 'permission-mode.json');
    expect(fs.existsSync(persistPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    expect(parsed.mode).toBe('acceptEdits');
  });

  it('loadMode reads persisted mode from disk', () => {
    // Write manually
    const persistPath = path.join(tmpDir, 'permission-mode.json');
    fs.writeFileSync(persistPath, JSON.stringify({ mode: 'autoAccept' }), 'utf8');

    const loader = new PermissionModeManager(tmpDir);
    loader.loadMode();
    expect(loader.getMode()).toBe('autoAccept');
  });

  it('loadMode falls back to default when no file exists', () => {
    const loader = new PermissionModeManager(tmpDir);
    loader.loadMode();
    expect(loader.getMode()).toBe('default');
  });

  it('loadMode downgrades bypass to autoAccept for safety', () => {
    const persistPath = path.join(tmpDir, 'permission-mode.json');
    fs.writeFileSync(persistPath, JSON.stringify({ mode: 'bypass' }), 'utf8');

    const loader = new PermissionModeManager(tmpDir);
    loader.loadMode();
    expect(loader.getMode()).toBe('autoAccept'); // downgraded
    expect(loader.isBypassConfirmed()).toBe(false);
  });

  it('loadMode handles corrupt file gracefully', () => {
    const persistPath = path.join(tmpDir, 'permission-mode.json');
    fs.writeFileSync(persistPath, 'not-json-at-all', 'utf8');

    const loader = new PermissionModeManager(tmpDir);
    loader.loadMode();
    expect(loader.getMode()).toBe('default');
  });

  it('loadMode handles invalid mode value gracefully', () => {
    const persistPath = path.join(tmpDir, 'permission-mode.json');
    fs.writeFileSync(persistPath, JSON.stringify({ mode: 'invalidMode' }), 'utf8');

    const loader = new PermissionModeManager(tmpDir);
    loader.loadMode();
    expect(loader.getMode()).toBe('default');
  });

  it('round-trip: persist then load preserves the mode', () => {
    manager.setMode('acceptEdits');
    manager.persistMode();

    const loader = new PermissionModeManager(tmpDir);
    loader.loadMode();
    expect(loader.getMode()).toBe('acceptEdits');
  });
});

describe('PermissionModeManager — edge cases', () => {
  it('re-setting the same mode is idempotent', () => {
    manager.setMode('acceptEdits');
    manager.setMode('acceptEdits');
    expect(manager.getMode()).toBe('acceptEdits');
  });

  it('setMode back from bypass to default resets bypass confirmation', () => {
    manager.setMode('bypass', true);
    expect(manager.isBypassConfirmed()).toBe(true);

    manager.setMode('default');
    expect(manager.getMode()).toBe('default');
    expect(manager.isBypassConfirmed()).toBe(false);
  });

  it('cycling from acceptEdits without bypass confirmation stays safe', () => {
    manager.setMode('acceptEdits');
    // acceptEdits → autoAccept (safe)
    manager.cycleMode();
    expect(manager.getMode()).toBe('autoAccept');

    // autoAccept → bypass (unsafe, throws)
    expect(() => manager.cycleMode()).toThrow(ConfigError);
    expect(manager.getMode()).toBe('autoAccept'); // unchanged
  });
});