/**
 * Tests for yolo-mode.ts — Yolo (auto-approve) mode manager.
 *
 * Covers: default state, enable from env, enable from CLI, shouldAutoApprove
 * for safe and dangerous tools, runtime allow/block mutations, and
 * blocked-takes-priority semantics.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  YoloModeManager,
  isYoloMode,
  shouldAutoApprove,
  getGlobalYoloManager,
} from '../../src/core/agent/yolo-mode.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh manager for each test — avoids singleton pollution. */
function freshManager(): YoloModeManager {
  return new YoloModeManager();
}

// Capture original env so we can restore after env-mutating tests.
const ORIG_YOLO = process.env.SUDO_YOLO;
const ORIG_ALWAYS = process.env.SUDO_ALWAYS_APPROVE;

function saveEnv(): void {
  // no-op — captured above at module load
}

function restoreEnv(): void {
  if (ORIG_YOLO === undefined) {
    delete process.env.SUDO_YOLO;
  } else {
    process.env.SUDO_YOLO = ORIG_YOLO;
  }
  if (ORIG_ALWAYS === undefined) {
    delete process.env.SUDO_ALWAYS_APPROVE;
  } else {
    process.env.SUDO_ALWAYS_APPROVE = ORIG_ALWAYS;
  }
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

describe('YoloModeManager — default state', () => {
  let mgr: YoloModeManager;

  beforeEach(() => {
    mgr = freshManager();
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('is disabled by default', () => {
    mgr.resolve();
    expect(mgr.isEnabled()).toBe(false);
  });

  it('source is "default" when disabled', () => {
    mgr.resolve();
    expect(mgr.source).toBe('default');
  });

  it('shouldAutoApprove returns false when disabled', () => {
    mgr.resolve();
    expect(mgr.shouldAutoApprove('readFile')).toBe(false);
  });

  it('default blocked patterns include rm -rf', () => {
    expect(mgr.blockedToolPatterns).toContain('rm -rf');
  });

  it('default blocked patterns include DROP', () => {
    expect(mgr.blockedToolPatterns).toContain('DROP');
  });

  it('default blocked patterns include format', () => {
    expect(mgr.blockedToolPatterns).toContain('format');
  });

  it('default blocked patterns include shutdown and reboot', () => {
    expect(mgr.blockedToolPatterns).toContain('shutdown');
    expect(mgr.blockedToolPatterns).toContain('reboot');
  });
});

// ---------------------------------------------------------------------------
// Enable from environment
// ---------------------------------------------------------------------------

describe('YoloModeManager — enable from environment', () => {
  let mgr: YoloModeManager;

  beforeEach(() => {
    mgr = freshManager();
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('enables when SUDO_YOLO=1', () => {
    process.env.SUDO_YOLO = '1';
    delete process.env.SUDO_ALWAYS_APPROVE;
    mgr.resolve();
    expect(mgr.isEnabled()).toBe(true);
    expect(mgr.source).toBe('env');
  });

  it('enables when SUDO_ALWAYS_APPROVE=1', () => {
    delete process.env.SUDO_YOLO;
    process.env.SUDO_ALWAYS_APPROVE = '1';
    mgr.resolve();
    expect(mgr.isEnabled()).toBe(true);
    expect(mgr.source).toBe('env');
  });

  it('does NOT enable for SUDO_YOLO=0', () => {
    process.env.SUDO_YOLO = '0';
    delete process.env.SUDO_ALWAYS_APPROVE;
    mgr.resolve();
    expect(mgr.isEnabled()).toBe(false);
  });

  it('does NOT enable when env vars are absent', () => {
    delete process.env.SUDO_YOLO;
    delete process.env.SUDO_ALWAYS_APPROVE;
    mgr.resolve();
    expect(mgr.isEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enable from CLI flag
// ---------------------------------------------------------------------------

describe('YoloModeManager — enable from CLI flag', () => {
  let mgr: YoloModeManager;

  beforeEach(() => {
    mgr = freshManager();
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('enables when cliFlag is true', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.isEnabled()).toBe(true);
    expect(mgr.source).toBe('cli');
  });

  it('CLI flag takes priority over env', () => {
    process.env.SUDO_YOLO = '1';
    mgr.resolve({ cliFlag: true });
    expect(mgr.source).toBe('cli');
  });

  it('does not enable when cliFlag is false/undefined', () => {
    delete process.env.SUDO_YOLO;
    delete process.env.SUDO_ALWAYS_APPROVE;
    mgr.resolve({ cliFlag: false });
    expect(mgr.isEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoApprove — safe tools
// ---------------------------------------------------------------------------

describe('YoloModeManager — shouldAutoApprove for safe tools', () => {
  let mgr: YoloModeManager;

  beforeEach(() => {
    mgr = freshManager();
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('approves readFile when yolo is enabled via CLI', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.shouldAutoApprove('readFile')).toBe(true);
  });

  it('approves bash when yolo is enabled via env', () => {
    process.env.SUDO_YOLO = '1';
    mgr.resolve();
    expect(mgr.shouldAutoApprove('bash')).toBe(true);
  });

  it('approves write when yolo is enabled', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.shouldAutoApprove('write')).toBe(true);
  });

  it('approves npm install when yolo is enabled', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.shouldAutoApprove('npm install')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoApprove — blocked tools (even when yolo is on)
// ---------------------------------------------------------------------------

describe('YoloModeManager — shouldAutoApprove blocked tools', () => {
  let mgr: YoloModeManager;

  beforeEach(() => {
    mgr = freshManager();
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('blocks rm -rf even when yolo is enabled', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.shouldAutoApprove('rm -rf /')).toBe(false);
  });

  it('blocks rm -r even when yolo is enabled', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.shouldAutoApprove('rm -r /tmp')).toBe(false);
  });

  it('blocks format even when yolo is enabled', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.shouldAutoApprove('format C:')).toBe(false);
  });

  it('blocks DROP even when yolo is enabled', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.shouldAutoApprove('DROP TABLE users')).toBe(false);
  });

  it('blocks DELETE FROM even when yolo is enabled', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.shouldAutoApprove('DELETE FROM users')).toBe(false);
  });

  it('blocks shutdown even when yolo is enabled', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.shouldAutoApprove('shutdown now')).toBe(false);
  });

  it('blocks reboot even when yolo is enabled', () => {
    mgr.resolve({ cliFlag: true });
    expect(mgr.shouldAutoApprove('reboot')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// allowTool / blockTool runtime changes
// ---------------------------------------------------------------------------

describe('YoloModeManager — allowTool / blockTool runtime', () => {
  let mgr: YoloModeManager;

  beforeEach(() => {
    mgr = freshManager();
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('allowTool adds a pattern that is then auto-approved', () => {
    mgr.resolve({ cliFlag: true });
    // Remove wildcard, add specific allow
    mgr.allowedToolPatterns = [];
    mgr.allowTool('readFile');
    expect(mgr.shouldAutoApprove('readFile')).toBe(true);
    expect(mgr.shouldAutoApprove('writeFile')).toBe(false);
  });

  it('allowTool does not add duplicates', () => {
    mgr.allowTool('readFile');
    mgr.allowTool('readFile');
    expect(mgr.allowedToolPatterns.filter(p => p === 'readFile').length).toBe(1);
  });

  it('blockTool adds a new blocked pattern', () => {
    mgr.blockTool('dangerousTool');
    expect(mgr.blockedToolPatterns).toContain('dangerousTool');
  });

  it('blockTool does not add duplicates', () => {
    mgr.blockTool('dangerousTool');
    mgr.blockTool('dangerousTool');
    expect(mgr.blockedToolPatterns.filter(p => p === 'dangerousTool').length).toBe(1);
  });

  it('newly blocked tool is rejected even if previously allowed', () => {
    mgr.resolve({ cliFlag: true });
    // 'git push' would normally be allowed by wildcard
    expect(mgr.shouldAutoApprove('git push')).toBe(true);
    mgr.blockTool('git push');
    expect(mgr.shouldAutoApprove('git push')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Blocked takes priority over allowed
// ---------------------------------------------------------------------------

describe('YoloModeManager — blocked takes priority', () => {
  let mgr: YoloModeManager;

  beforeEach(() => {
    mgr = freshManager();
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('blocked pattern overrides wildcard allowed', () => {
    mgr.resolve({ cliFlag: true }); // allowed = ['*']
    // 'rm -rf' is in default blocked patterns
    expect(mgr.shouldAutoApprove('rm -rf /data')).toBe(false);
  });

  it('blocked pattern overrides explicitly allowed pattern', () => {
    mgr.allowedToolPatterns = ['database'];
    mgr.blockedToolPatterns = ['DELETE FROM'];
    mgr.enabled = true;
    // 'database DELETE FROM' matches both, but blocked wins
    expect(mgr.shouldAutoApprove('database DELETE FROM users')).toBe(false);
  });

  it('when both patterns exist but tool only matches allowed, it is approved', () => {
    mgr.allowedToolPatterns = ['read'];
    mgr.blockedToolPatterns = ['rm -rf'];
    mgr.enabled = true;
    expect(mgr.shouldAutoApprove('readFile')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Global helpers
// ---------------------------------------------------------------------------

describe('Global helpers', () => {
  beforeEach(() => {
    restoreEnv();
    // Reset the global singleton to a clean state
    getGlobalYoloManager().enabled = false;
    getGlobalYoloManager().source = 'default';
    getGlobalYoloManager().allowedToolPatterns = [];
    getGlobalYoloManager().blockedToolPatterns = [
      'rm -rf', 'rm -r', 'format', 'DROP', 'DELETE FROM', 'shutdown', 'reboot',
    ];
  });

  afterEach(() => {
    restoreEnv();
    // Reset again after tests
    getGlobalYoloManager().enabled = false;
    getGlobalYoloManager().source = 'default';
    getGlobalYoloManager().allowedToolPatterns = [];
  });

  it('isYoloMode returns false by default', () => {
    expect(isYoloMode()).toBe(false);
  });

  it('shouldAutoApprove returns false by default', () => {
    expect(shouldAutoApprove('readFile')).toBe(false);
  });

  it('getGlobalYoloManager returns the same instance', () => {
    const a = getGlobalYoloManager();
    const b = getGlobalYoloManager();
    expect(a).toBe(b);
  });

  it('global helpers reflect state after resolve', () => {
    process.env.SUDO_YOLO = '1';
    getGlobalYoloManager().resolve();
    expect(isYoloMode()).toBe(true);
    expect(shouldAutoApprove('readFile')).toBe(true);
    expect(shouldAutoApprove('rm -rf /')).toBe(false);
  });
});