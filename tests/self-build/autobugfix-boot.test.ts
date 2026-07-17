/**
 * F90 — AutoBugFix Modules C+D boot wiring.
 * The active path spawns network pollers (GitHub), so tests cover the
 * dormant-by-default contract and the opt-in gate; module behavior itself is
 * covered by auto-fix-trigger / deployment-hook suites.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
