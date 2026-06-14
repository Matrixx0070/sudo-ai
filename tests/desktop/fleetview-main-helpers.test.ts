/**
 * @file tests/desktop/fleetview-main-helpers.test.ts
 * @description Tests for the CommonJS helpers used by the Electron main
 * process (gap #25 slice 4).
 *
 * The Electron main process (main.cjs) is CJS, so it can't require config.ts's
 * ESM exports — main-helpers.cjs holds a parallel copy of the env reader and
 * origin guard. Verifier LOW #3 flagged that this duplicate was untested; this
 * file closes the gap.
 *
 * Loaded via createRequire so the .cjs file is exercised exactly the same way
 * Electron loads it (CommonJS resolution, no transpile).
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const helpers = req('../../src/desktop/fleetview/main-helpers.cjs') as {
  readEnvConfig: (env?: NodeJS.ProcessEnv) => null | {
    host: string;
    port: number;
    token: string;
    width: number;
    height: number;
  };
  isAllowedOrigin: (url: string, cfg: { host: string; port: number }) => boolean;
};

describe('main-helpers.cjs readEnvConfig (gap #25 slice 4)', () => {
  it('returns null when SUDO_DASHBOARD_TOKEN and GATEWAY_TOKEN are both absent', () => {
    expect(helpers.readEnvConfig({})).toBeNull();
  });

  it('returns null when token is whitespace-only', () => {
    expect(helpers.readEnvConfig({ SUDO_DASHBOARD_TOKEN: '   ' })).toBeNull();
  });

  it('accepts GATEWAY_TOKEN as a fallback', () => {
    const cfg = helpers.readEnvConfig({ GATEWAY_TOKEN: 'fb' });
    expect(cfg).not.toBeNull();
    expect(cfg?.token).toBe('fb');
  });

  it('parses defaults for host/port/width/height', () => {
    const cfg = helpers.readEnvConfig({ SUDO_DASHBOARD_TOKEN: 't' });
    expect(cfg).toEqual({
      host: '127.0.0.1',
      port: 18910,
      token: 't',
      width: 1100,
      height: 750,
    });
  });

  it('returns null for an out-of-range port', () => {
    expect(
      helpers.readEnvConfig({ SUDO_DASHBOARD_TOKEN: 't', SUDO_DASHBOARD_PORT: '70000' }),
    ).toBeNull();
    expect(
      helpers.readEnvConfig({ SUDO_DASHBOARD_TOKEN: 't', SUDO_DASHBOARD_PORT: '0' }),
    ).toBeNull();
  });

  it('clamps too-small width/height to defaults', () => {
    const cfg = helpers.readEnvConfig({
      SUDO_DASHBOARD_TOKEN: 't',
      SUDO_DESKTOP_WIDTH: '50',
      SUDO_DESKTOP_HEIGHT: '50',
    });
    expect(cfg?.width).toBe(1100);
    expect(cfg?.height).toBe(750);
  });
});

describe('main-helpers.cjs isAllowedOrigin (gap #25 slice 4)', () => {
  const cfg = { host: '127.0.0.1', port: 18910 };

  it('allows the exact dashboard origin', () => {
    expect(helpers.isAllowedOrigin('http://127.0.0.1:18910/', cfg)).toBe(true);
    expect(helpers.isAllowedOrigin('http://127.0.0.1:18910/api/agents/live', cfg)).toBe(true);
  });

  it('rejects a different host', () => {
    expect(helpers.isAllowedOrigin('http://evil.local:18910/', cfg)).toBe(false);
  });

  it('rejects a different port', () => {
    expect(helpers.isAllowedOrigin('http://127.0.0.1:18911/', cfg)).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(helpers.isAllowedOrigin('file:///etc/passwd', cfg)).toBe(false);
    // eslint-disable-next-line no-script-url
    expect(helpers.isAllowedOrigin('javascript:alert(1)', cfg)).toBe(false);
    expect(helpers.isAllowedOrigin('data:text/html,<x>', cfg)).toBe(false);
  });

  it('rejects malformed URLs without throwing', () => {
    expect(helpers.isAllowedOrigin('not a url', cfg)).toBe(false);
    expect(helpers.isAllowedOrigin('', cfg)).toBe(false);
  });

  it('treats implicit ports correctly for protocol-default ports', () => {
    const cfg80 = { host: 'example.local', port: 80 };
    expect(helpers.isAllowedOrigin('http://example.local/', cfg80)).toBe(true);
    const cfg443 = { host: 'example.local', port: 443 };
    expect(helpers.isAllowedOrigin('https://example.local/', cfg443)).toBe(true);
  });
});
