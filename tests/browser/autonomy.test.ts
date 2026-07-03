/**
 * @file autonomy.test.ts
 * @description Unit test for the unattended-mode switch (Phase 3 #6). Confirmation
 * is ON by default (narrow-autonomy posture) and lifted only under
 * SUDO_BROWSER_UNATTENDED=1.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { unattendedEnabled, requiresConfirmationDefault } from '../../src/core/tools/builtin/browser/autonomy.js';

const KEY = 'SUDO_BROWSER_UNATTENDED';

describe('unattended-mode switch', () => {
  const prev = process.env[KEY];
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it('defaults to attended: confirmation required', () => {
    delete process.env[KEY];
    expect(unattendedEnabled()).toBe(false);
    expect(requiresConfirmationDefault()).toBe(true);
  });

  it('SUDO_BROWSER_UNATTENDED=1 lifts confirmation', () => {
    process.env[KEY] = '1';
    expect(unattendedEnabled()).toBe(true);
    expect(requiresConfirmationDefault()).toBe(false);
  });

  it('any non-"1" value keeps confirmation on', () => {
    process.env[KEY] = 'true';
    expect(requiresConfirmationDefault()).toBe(true);
  });
});
