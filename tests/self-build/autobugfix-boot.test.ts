/**
 * F90 — AutoBugFix Modules C+D boot wiring.
 * The active path spawns network pollers (GitHub), so tests cover the
 * dormant-by-default contract and the opt-in gate; module behavior itself is
 * covered by auto-fix-trigger / deployment-hook suites.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
// Fail-closed guard: nothing in this file may reach the real gh CLI or git
// (the unmocked escape poisoned full-suite runs on 2026-08-16).
vi.mock('child_process', () => ({
  exec: (_cmd: string, cb: (e: Error | null) => void) =>
    cb(new Error('gh: command not found (mocked test env)')),
}));

import { startAutoBugFix } from '../../src/core/self-build/autobugfix-boot.js';

describe('startAutoBugFix (F90)', () => {
  afterEach(() => {
    delete process.env['SUDO_AUTOBUGFIX'];
  });

  it('returns null (fully dormant) when SUDO_AUTOBUGFIX is unset', async () => {
    delete process.env['SUDO_AUTOBUGFIX'];
    expect(await startAutoBugFix()).toBeNull();
  });

  it('returns null for any non-"1" value', async () => {
    process.env['SUDO_AUTOBUGFIX'] = 'true';
    expect(await startAutoBugFix()).toBeNull();
    process.env['SUDO_AUTOBUGFIX'] = '0';
    expect(await startAutoBugFix()).toBeNull();
  });
});
