/**
 * @file launch-args.test.ts
 * @description Unit test for gated Chromium launch args (Phase 6 #11). The
 * security-weakening flags must be OFF by default and only present under
 * SUDO_BROWSER_INSECURE=1.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildLaunchArgs, insecureBrowserEnabled } from '../../src/core/tools/builtin/browser/anti-detect.js';

const KEY = 'SUDO_BROWSER_INSECURE';

describe('buildLaunchArgs gating', () => {
  const prev = process.env[KEY];
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it('default: no-sandbox + anti-automation flags, NO security-weakening flags', () => {
    delete process.env[KEY];
    const args = buildLaunchArgs();
    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(args).not.toContain('--disable-web-security');
    expect(args).not.toContain('--allow-running-insecure-content');
    expect(args).not.toContain('--ignore-certificate-errors');
    expect(insecureBrowserEnabled()).toBe(false);
  });

  it('opt-in: SUDO_BROWSER_INSECURE=1 adds the security-weakening flags', () => {
    process.env[KEY] = '1';
    const args = buildLaunchArgs();
    expect(args).toContain('--disable-web-security');
    expect(args).toContain('--allow-running-insecure-content');
    expect(args).toContain('--ignore-certificate-errors');
    expect(insecureBrowserEnabled()).toBe(true);
  });

  it('passes through extra args (e.g. remote-debugging-port)', () => {
    delete process.env[KEY];
    const args = buildLaunchArgs(['--remote-debugging-port=9222']);
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--no-sandbox');
  });
});
