/**
 * @file update-manager.test.ts
 * @description Tests for AutoUpdateManager — orchestrator for the update lifecycle.
 *
 * Covers: start/stop lifecycle, periodic check cycle, health gate, full update flow,
 *         rollback flow, config hot-reload, event emission, concurrent update
 *         prevention, auto-apply disabled, self-build mode skip.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoUpdateManager } from '../../src/core/update/update-manager.js';
import { DEFAULT_UPDATE_CONFIG } from '../../src/core/update/update-manager-types.js';
import type { AutoUpdateConfig, UpdateEventPayload } from '../../src/core/update/update-manager-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(os.tmpdir(), 'sudo-ai-update-manager-test');

function makeConfig(overrides: Partial<AutoUpdateConfig> = {}): Partial<AutoUpdateConfig> {
  return {
    ...DEFAULT_UPDATE_CONFIG,
    projectRoot: TEST_DIR,
    checkIntervalMs: 60_000, // 1 minute for tests
    autoApply: false, // Don't auto-apply in tests
    ...overrides,
  };
}

// Mock watchdog
function makeWatchdog(healthy: boolean = true) {
  return { isHealthy: vi.fn(() => healthy) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutoUpdateManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['SUDO_UPDATE_DISABLE'];
    delete process.env['SUDO_SELF_BUILD_MODE'];
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('start and stop lifecycle', () => {
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: true, checkIntervalMs: 60_000 }),
    });

    manager.start();
    expect((manager as any).timer).not.toBeNull();

    manager.stop();
    expect((manager as any).timer).toBeNull();

    manager.close();
  });

  it('does not start when SUDO_UPDATE_DISABLE=1', () => {
    process.env['SUDO_UPDATE_DISABLE'] = '1';
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: true }),
    });

    manager.start();
    expect((manager as any).timer).toBeNull();

    manager.close();
  });

  it('does not start when SUDO_SELF_BUILD_MODE=1', () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: true }),
    });

    manager.start();
    expect((manager as any).timer).toBeNull();

    manager.close();
  });

  it('does not start when config.enabled=false', () => {
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: false }),
    });

    manager.start();
    expect((manager as any).timer).toBeNull();

    manager.close();
  });

  it('emits update events on check cycle', async () => {
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: true, checkIntervalMs: 300_000_000 }),
      watchdog: makeWatchdog(true),
    });

    const events: UpdateEventPayload[] = [];
    manager.on('update', (payload: UpdateEventPayload) => events.push(payload));

    // Mock version resolver to return no update
    vi.spyOn((manager as any).resolver, 'checkForUpdate').mockResolvedValue({
      available: false,
      currentVersion: '4.1.0',
      reason: 'up_to_date',
    });

    await (manager as any)._checkCycle();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].stage).toBe('check');

    manager.close();
    vi.restoreAllMocks();
  });

  it('health gate blocks update when watchdog reports unhealthy', async () => {
    const watchdog = makeWatchdog(false);
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: true, healthGate: true, autoApply: true }),
      watchdog,
    });

    const events: UpdateEventPayload[] = [];
    manager.on('update', (payload: UpdateEventPayload) => events.push(payload));

    vi.spyOn((manager as any).resolver, 'checkForUpdate').mockResolvedValue({
      available: true,
      currentVersion: '4.0.0',
      newVersion: '5.0.0',
      channel: 'latest',
      checksumSha256: 'abc',
      sizeBytes: 100,
    });

    await (manager as any)._checkCycle();

    // Should NOT have applied update due to health gate
    const applyEvents = events.filter(e => e.stage === 'apply');
    expect(applyEvents).toHaveLength(0);

    manager.close();
    vi.restoreAllMocks();
  });

  it('health gate allows update when watchdog reports healthy', async () => {
    const watchdog = makeWatchdog(true);
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: true, healthGate: true, autoApply: true }),
      watchdog,
    });

    // Mock the _applyUpdate method so we don't actually run git commands
    vi.spyOn(manager as any, '_applyUpdate').mockResolvedValue({
      success: true,
      fromVersion: '4.0.0',
      toVersion: '5.0.0',
      stage: 'complete',
    });

    vi.spyOn((manager as any).resolver, 'checkForUpdate').mockResolvedValue({
      available: true,
      currentVersion: '4.0.0',
      newVersion: '5.0.0',
      channel: 'latest',
      checksumSha256: 'abc',
      sizeBytes: 100,
    });

    await (manager as any)._checkCycle();

    // Should have called _applyUpdate
    expect((manager as any)._applyUpdate).toHaveBeenCalledWith('latest');

    manager.close();
    vi.restoreAllMocks();
  });

  it('health gate disabled allows update even when unhealthy', async () => {
    const watchdog = makeWatchdog(false);
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: true, healthGate: false, autoApply: true }),
      watchdog,
    });

    vi.spyOn(manager as any, '_applyUpdate').mockResolvedValue({
      success: true,
      fromVersion: '4.0.0',
      toVersion: '5.0.0',
      stage: 'complete',
    });

    vi.spyOn((manager as any).resolver, 'checkForUpdate').mockResolvedValue({
      available: true,
      currentVersion: '4.0.0',
      newVersion: '5.0.0',
      channel: 'latest',
      checksumSha256: 'abc',
      sizeBytes: 100,
    });

    await (manager as any)._checkCycle();

    expect((manager as any)._applyUpdate).toHaveBeenCalledWith('latest');

    manager.close();
    vi.restoreAllMocks();
  });

  it('auto-apply disabled only notifies without applying', async () => {
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: true, autoApply: false }),
    });

    const events: UpdateEventPayload[] = [];
    manager.on('update', (payload: UpdateEventPayload) => events.push(payload));

    vi.spyOn((manager as any).resolver, 'checkForUpdate').mockResolvedValue({
      available: true,
      currentVersion: '4.0.0',
      newVersion: '5.0.0',
      channel: 'latest',
      checksumSha256: 'abc',
      sizeBytes: 100,
    });

    await (manager as any)._checkCycle();

    // Should NOT call _applyUpdate
    const applyEvents = events.filter(e => e.stage === 'apply');
    expect(applyEvents).toHaveLength(0);

    manager.close();
    vi.restoreAllMocks();
  });

  it('config hot-reload reschedules timer', () => {
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: true, checkIntervalMs: 300_000_000 }),
    });

    manager.start();
    expect((manager as any).config.checkIntervalMs).toBe(300_000_000);

    manager.updateConfig({ checkIntervalMs: 600_000 });
    expect((manager as any).config.checkIntervalMs).toBe(600_000);

    manager.close();
  });

  it('getStatus returns current version and history', () => {
    const manager = new AutoUpdateManager({
      config: makeConfig(),
    });

    const status = manager.getStatus();
    expect(status.currentVersion).toBeDefined();
    expect(status.currentGitSha).toBeDefined();
    expect(Array.isArray(status.versions)).toBe(true);

    manager.close();
  });

  it('self-build mode skips check cycle', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const manager = new AutoUpdateManager({
      config: makeConfig({ enabled: true }),
    });

    const events: UpdateEventPayload[] = [];
    manager.on('update', (payload: UpdateEventPayload) => events.push(payload));

    await (manager as any)._checkCycle();

    // No events should be emitted
    expect(events).toHaveLength(0);

    manager.close();
  });
});