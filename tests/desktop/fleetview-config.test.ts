/**
 * @file tests/desktop/fleetview-config.test.ts
 * @description Tests for the FleetView desktop wrapper env reader + helpers
 * (gap #25 slice 4).
 *
 * No Electron imports — the wrapper's launcher MUST be able to validate env
 * and refuse before any Electron child gets spawned. Symmetric with
 * tests/tui/fleetview-fetcher.test.ts (slice 2) and
 * tests/unit/gateway/fetcher.test.ts (slice 3).
 */

import { describe, it, expect } from 'vitest';
import {
  readConfigFromEnv,
  buildDashboardUrl,
  isAllowedDashboardOrigin,
  type DesktopConfig,
} from '../../src/desktop/fleetview/config.js';

describe('readConfigFromEnv (gap #25 slice 4)', () => {
  it('fails honestly when SUDO_DASHBOARD_TOKEN is missing', () => {
    const res = readConfigFromEnv({});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('SUDO_DASHBOARD_TOKEN');
  });

  it('fails honestly when token is whitespace-only', () => {
    const res = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: '   ' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('SUDO_DASHBOARD_TOKEN');
  });

  it('accepts GATEWAY_TOKEN as a fallback (parity with TUI/gateway)', () => {
    const res = readConfigFromEnv({ GATEWAY_TOKEN: 'fallback-tok' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.token).toBe('fallback-tok');
  });

  it('parses host/port/width/height with sane defaults', () => {
    const res = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.host).toBe('127.0.0.1');
      expect(res.config.port).toBe(18910);
      expect(res.config.width).toBe(1100);
      expect(res.config.height).toBe(750);
    }
  });

  it('rejects an invalid port', () => {
    const res = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't', SUDO_DASHBOARD_PORT: 'abc' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('SUDO_DASHBOARD_PORT');
  });

  it('rejects out-of-range ports', () => {
    const tooHigh = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't', SUDO_DASHBOARD_PORT: '70000' });
    expect(tooHigh.ok).toBe(false);
    const zero = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't', SUDO_DASHBOARD_PORT: '0' });
    expect(zero.ok).toBe(false);
  });

  it('clamps too-small width to the default 1100', () => {
    const res = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't', SUDO_DESKTOP_WIDTH: '50' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.width).toBe(1100);
  });

  it('clamps too-small height to the default 750', () => {
    const res = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't', SUDO_DESKTOP_HEIGHT: '50' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.height).toBe(750);
  });

  it('preserves valid width/height overrides above the minimums', () => {
    const res = readConfigFromEnv({
      SUDO_DASHBOARD_TOKEN: 't',
      SUDO_DESKTOP_WIDTH: '1600',
      SUDO_DESKTOP_HEIGHT: '900',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.width).toBe(1600);
      expect(res.config.height).toBe(900);
    }
  });

  it('falls back to the default 127.0.0.1 host when the env value is empty', () => {
    const res = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't', SUDO_DASHBOARD_HOST: '   ' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.host).toBe('127.0.0.1');
  });
});

describe('buildDashboardUrl (gap #25 slice 4)', () => {
  it('builds an http URL the embedded dashboard HTML expects', () => {
    expect(buildDashboardUrl({ host: '127.0.0.1', port: 18910 })).toBe('http://127.0.0.1:18910/');
  });

  it('honors non-default host/port', () => {
    expect(buildDashboardUrl({ host: 'dash.internal', port: 8080 })).toBe(
      'http://dash.internal:8080/',
    );
  });
});

describe('isAllowedDashboardOrigin (gap #25 slice 4)', () => {
  const cfg: Pick<DesktopConfig, 'host' | 'port'> = { host: '127.0.0.1', port: 18910 };

  it('allows the exact dashboard origin', () => {
    expect(isAllowedDashboardOrigin('http://127.0.0.1:18910/', cfg)).toBe(true);
    expect(isAllowedDashboardOrigin('http://127.0.0.1:18910/api/agents/live', cfg)).toBe(true);
  });

  it('rejects a different host', () => {
    expect(isAllowedDashboardOrigin('http://evil.local:18910/', cfg)).toBe(false);
  });

  it('rejects a different port', () => {
    expect(isAllowedDashboardOrigin('http://127.0.0.1:18911/', cfg)).toBe(false);
  });

  it('rejects non-http(s) schemes (file://, javascript:, data:)', () => {
    expect(isAllowedDashboardOrigin('file:///etc/passwd', cfg)).toBe(false);
    // eslint-disable-next-line no-script-url
    expect(isAllowedDashboardOrigin('javascript:alert(1)', cfg)).toBe(false);
    expect(isAllowedDashboardOrigin('data:text/html,<script>fetch("/")</script>', cfg)).toBe(false);
  });

  it('rejects malformed URLs without throwing', () => {
    expect(isAllowedDashboardOrigin('not a url', cfg)).toBe(false);
    expect(isAllowedDashboardOrigin('', cfg)).toBe(false);
  });

  it('treats the default port correctly for protocol-implicit ports', () => {
    // Defensive: if the dashboard ever exposed itself on port 80 we'd want to
    // accept a portless http URL. This documents the intent for a future
    // operator who needs to host on standard ports.
    const cfg80: Pick<DesktopConfig, 'host' | 'port'> = { host: 'example.local', port: 80 };
    expect(isAllowedDashboardOrigin('http://example.local/', cfg80)).toBe(true);
    const cfg443: Pick<DesktopConfig, 'host' | 'port'> = { host: 'example.local', port: 443 };
    expect(isAllowedDashboardOrigin('https://example.local/', cfg443)).toBe(true);
  });
});
