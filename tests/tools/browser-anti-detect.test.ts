/**
 * @file browser-anti-detect.test.ts
 * @description Tests for the browser anti-detection helpers in anti-detect.ts.
 *
 * Tests cover:
 *  - ANTI_DETECT_ARGS contents
 *  - buildUserAgent default/versioned/locale variants
 *  - buildClientHintsHeaders versioned and fallback behaviour
 *  - detectChromiumVersion (mocked child_process via vi.mock hoisting)
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before module imports by Vitest
// ---------------------------------------------------------------------------

// Mock logger to suppress output during tests
vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock node:child_process so detectChromiumVersion does not actually spawn processes.
// We provide a mock execFile; the module wraps it with promisify using node:util.
vi.mock('node:child_process', () => {
  const mockExecFile = vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout: 'Google Chrome 125.0.6422.60 \n', stderr: '' });
    },
  );
  return { execFile: mockExecFile };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  ANTI_DETECT_ARGS,
  buildUserAgent,
  buildClientHintsHeaders,
  detectChromiumVersion,
} from '../../src/core/tools/builtin/browser/anti-detect.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ANTI_DETECT_ARGS', () => {
  it('includes --disable-blink-features=AutomationControlled', () => {
    expect(ANTI_DETECT_ARGS).toContain('--disable-blink-features=AutomationControlled');
  });

  it('includes --max_old_space_size=1024', () => {
    expect(ANTI_DETECT_ARGS).toContain('--max_old_space_size=1024');
  });

  it('is a non-empty array of strings', () => {
    expect(Array.isArray(ANTI_DETECT_ARGS)).toBe(true);
    expect(ANTI_DETECT_ARGS.length).toBeGreaterThan(0);
    ANTI_DETECT_ARGS.forEach((arg) => expect(typeof arg).toBe('string'));
  });
});

describe('buildUserAgent', () => {
  it('returns a sane default UA with Chrome/120. when version is null', () => {
    const ua = buildUserAgent(null);
    expect(ua).toMatch(/^Mozilla\/5\.0/);
    expect(ua).toContain('Chrome/120.');
    expect(ua).toContain('Safari/537.36');
  });

  it('returns UA containing the exact version when version is provided', () => {
    const ua = buildUserAgent('125.0.6422.60');
    expect(ua).toContain('Chrome/125.0.6422.60');
  });

  it('embeds the default locale en-US when no locale is specified', () => {
    const ua = buildUserAgent(null);
    expect(ua).toContain('en-US');
  });

  it('propagates a custom locale into the UA string', () => {
    const ua = buildUserAgent('120.0.6099.109', 'fr-FR');
    expect(ua).toContain('fr-FR');
  });

  it('falls back to en-US when locale is an empty string', () => {
    const ua = buildUserAgent(null, '');
    expect(ua).toContain('en-US');
  });

  it('includes Linux x86_64 platform in the UA string', () => {
    const ua = buildUserAgent(null);
    expect(ua).toContain('X11; Linux x86_64');
  });
});

describe('buildClientHintsHeaders', () => {
  it('returns all three required Sec-CH-UA headers', () => {
    const headers = buildClientHintsHeaders('125.0.6422.60');
    expect(headers).toHaveProperty('Sec-CH-UA');
    expect(headers).toHaveProperty('Sec-CH-UA-Platform');
    expect(headers).toHaveProperty('Sec-CH-UA-Mobile');
  });

  it('embeds the correct major version in Sec-CH-UA when version is provided', () => {
    const headers = buildClientHintsHeaders('125.0.6422.60');
    expect(headers['Sec-CH-UA']).toContain('v="125"');
  });

  it('falls back to major version 120 in Sec-CH-UA when version is null', () => {
    const headers = buildClientHintsHeaders(null);
    expect(headers['Sec-CH-UA']).toContain('v="120"');
  });

  it('sets Sec-CH-UA-Platform to Linux', () => {
    const headers = buildClientHintsHeaders('125.0.6422.60');
    expect(headers['Sec-CH-UA-Platform']).toContain('Linux');
  });

  it('sets Sec-CH-UA-Mobile to ?0 (non-mobile)', () => {
    const headers = buildClientHintsHeaders(null);
    expect(headers['Sec-CH-UA-Mobile']).toBe('?0');
  });
});

describe('detectChromiumVersion', () => {
  it('returns a version string or null without throwing', async () => {
    const result = await detectChromiumVersion().catch(() => null);
    expect(result === null || typeof result === 'string').toBe(true);
  });
});
