/**
 * @file slim-heartbeat.test.ts
 * @description Gating + prompt tests for the slim heartbeat context
 * (SUDO_SLIM_HEARTBEAT, default ON; system.heartbeat job ONLY).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HEARTBEAT_JOB_NAME,
  isSlimHeartbeatEnabled,
  shouldSlimHeartbeatTurn,
  SLIM_HEARTBEAT_TOOLS,
} from '../../src/core/cron/slim-heartbeat.js';
import { assembleSlimHeartbeatPrompt } from '../../src/core/brain/system-prompt.js';
import { DYNAMIC_BOUNDARY_MARKER } from '../../src/core/brain/prompt-cache-discipline.js';

describe('slim heartbeat gating', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env['SUDO_SLIM_HEARTBEAT'];
    delete process.env['SUDO_SLIM_HEARTBEAT'];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['SUDO_SLIM_HEARTBEAT'];
    else process.env['SUDO_SLIM_HEARTBEAT'] = saved;
  });

  it('is ON by default; only SUDO_SLIM_HEARTBEAT=0 disables', () => {
    expect(isSlimHeartbeatEnabled()).toBe(true);
    process.env['SUDO_SLIM_HEARTBEAT'] = '1';
    expect(isSlimHeartbeatEnabled()).toBe(true);
    process.env['SUDO_SLIM_HEARTBEAT'] = '0';
    expect(isSlimHeartbeatEnabled()).toBe(false);
  });

  it('slims ONLY the system.heartbeat job', () => {
    expect(shouldSlimHeartbeatTurn(HEARTBEAT_JOB_NAME)).toBe(true);
    expect(shouldSlimHeartbeatTurn('system.heartbeat')).toBe(true);
    // Commitments and every other cron agent-turn keep the full loadout.
    expect(shouldSlimHeartbeatTurn('commitment:follow-up-123')).toBe(false);
    expect(shouldSlimHeartbeatTurn('system.self-build')).toBe(false);
    expect(shouldSlimHeartbeatTurn('system.self-build-report')).toBe(false);
    expect(shouldSlimHeartbeatTurn('user-cron-job')).toBe(false);
    expect(shouldSlimHeartbeatTurn('')).toBe(false);
  });

  it('kill-switch restores full context even for the heartbeat job', () => {
    process.env['SUDO_SLIM_HEARTBEAT'] = '0';
    expect(shouldSlimHeartbeatTurn(HEARTBEAT_JOB_NAME)).toBe(false);
  });

  it('allowlist covers the tools HEARTBEAT.md instructs the agent to run', () => {
    expect(SLIM_HEARTBEAT_TOOLS.length).toBeGreaterThan(0);
    // workspace/HEARTBEAT.md sections: system-health, cost-check, task-sweep.
    for (const required of [
      'system.self-diagnostic',
      'automation.cron-health',
      'meta.cost-tracker',
      'meta.task-manager',
    ]) {
      expect(SLIM_HEARTBEAT_TOOLS).toContain(required);
    }
  });
});

describe('assembleSlimHeartbeatPrompt', () => {
  it('is a small prompt with identity + health-check protocol', () => {
    const prompt = assembleSlimHeartbeatPrompt();
    expect(prompt).toContain('You are SUDO');
    expect(prompt).toContain('Heartbeat Protocol');
    expect(prompt).toContain('HEARTBEAT_OK');
    expect(prompt).toContain('Due tasks this tick:');
    // A tiny fraction of the ~100KB+ full prompt.
    expect(prompt.length).toBeLessThan(3_000);
  });

  it('keeps the volatile timestamp below the cache boundary', () => {
    const prompt = assembleSlimHeartbeatPrompt();
    const idx = prompt.indexOf(DYNAMIC_BOUNDARY_MARKER);
    expect(idx).toBeGreaterThan(0);
    const stable = prompt.slice(0, idx);
    const dynamic = prompt.slice(idx);
    expect(stable).not.toMatch(/Current (date|time)/);
    expect(dynamic).toContain('Current date:');
    expect(dynamic).toContain('Current time (UTC):');
  });

  it('stable prefix is byte-identical across calls', () => {
    const a = assembleSlimHeartbeatPrompt();
    const b = assembleSlimHeartbeatPrompt();
    const prefixA = a.slice(0, a.indexOf(DYNAMIC_BOUNDARY_MARKER));
    const prefixB = b.slice(0, b.indexOf(DYNAMIC_BOUNDARY_MARKER));
    expect(prefixA).toBe(prefixB);
  });
});
