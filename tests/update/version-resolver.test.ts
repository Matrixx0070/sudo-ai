/**
 * @file version-resolver.test.ts
 * @description Tests for VersionResolver — npm registry + git fallback, semver, checksum.
 *
 * Covers: kill switch, skip version, max version, npm registry fetch, git fallback,
 *         semver comparison, checksum verification, checksum mismatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VersionResolver, compareSemver } from '../../src/core/update/version-resolver.js';
import { BusinessError } from '../../src/core/shared/errors.js';
import type { AutoUpdateConfig } from '../../src/core/update/update-manager-types.js';
import { DEFAULT_UPDATE_CONFIG } from '../../src/core/update/update-manager-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolver(overrides: Partial<AutoUpdateConfig> = {}): VersionResolver {
  return new VersionResolver({ ...DEFAULT_UPDATE_CONFIG, ...overrides });
}

// ---------------------------------------------------------------------------
// Semver comparison
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  it('compares major versions correctly', () => {
    expect(compareSemver('2.0.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('compares minor versions correctly', () => {
    expect(compareSemver('1.2.0', '1.1.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.1.0')).toBeLessThan(0);
  });

  it('compares patch versions correctly', () => {
    expect(compareSemver('1.0.2', '1.0.1')).toBeGreaterThan(0);
    expect(compareSemver('1.0.1', '1.0.2')).toBeLessThan(0);
  });

  it('handles pre-release versions', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.0.0-alpha')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
  });

  it('strips v prefix and build metadata', () => {
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0+abc', '1.0.0')).toBe(0);
    expect(compareSemver('v2.0.0+sha123', '1.9.9')).toBeGreaterThan(0);
  });

  it('treats missing components as 0', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
    expect(compareSemver('2', '1.9.9')).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// VersionResolver — kill switch and gating
// ---------------------------------------------------------------------------

describe('VersionResolver — gating', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('kill switch SUDO_UPDATE_DISABLE=1 returns unavailable', async () => {
    process.env['SUDO_UPDATE_DISABLE'] = '1';
    const resolver = makeResolver();
    const result = await resolver.checkForUpdate('4.0.0');
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('kill_switch');
    }
  });

  it('skip version filter blocks current version', async () => {
    const resolver = makeResolver({ skipVersions: ['4.0.0'] });
    const result = await resolver.checkForUpdate('4.0.0');
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('skip_version');
    }
  });

  it('max version cap blocks updates beyond the limit', async () => {
    const resolver = makeResolver({ maxVersion: '4.0.0' });
    // Mock getRemoteVersion to return a version beyond the cap
    vi.spyOn(resolver, 'getRemoteVersion').mockResolvedValue({
      version: '5.0.0',
      shasum: 'abc',
      sizeBytes: 100,
    });
    const result = await resolver.checkForUpdate('3.0.0');
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('kill_switch');
    }
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// VersionResolver — npm registry
// ---------------------------------------------------------------------------

describe('VersionResolver — npm registry', () => {
  it('detects available update from npm registry', async () => {
    const resolver = makeResolver();
    vi.spyOn(resolver, 'getRemoteVersion').mockResolvedValue({
      version: '5.0.0',
      shasum: 'deadbeef',
      sizeBytes: 50000,
    });

    const result = await resolver.checkForUpdate('4.0.0');
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.newVersion).toBe('5.0.0');
      expect(result.channel).toBe('latest');
      expect(result.checksumSha256).toBe('deadbeef');
    }
    vi.restoreAllMocks();
  });

  it('reports up_to_date when remote version is same or lower', async () => {
    const resolver = makeResolver();
    vi.spyOn(resolver, 'getRemoteVersion').mockResolvedValue({
      version: '4.0.0',
      shasum: '',
      sizeBytes: 0,
    });

    const result = await resolver.checkForUpdate('4.0.0');
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('up_to_date');
    }
    vi.restoreAllMocks();
  });

  it('falls back to git when npm returns null', async () => {
    const resolver = makeResolver();
    vi.spyOn(resolver, 'getRemoteVersion').mockResolvedValue(null);
    vi.spyOn(resolver as any, '_getRemoteGitSha').mockReturnValue('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    vi.spyOn(resolver, 'getCurrentGitSha').mockReturnValue('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const result = await resolver.checkForUpdate('4.0.0');
    // Git fallback: different SHA means update available
    expect(result.available).toBe(true);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// VersionResolver — checksum verification
// ---------------------------------------------------------------------------

describe('VersionResolver — checksum verification', () => {
  it('verifies matching SHA-256 checksum', () => {
    const resolver = makeResolver();
    const testFile = path.join(os.tmpdir(), `checksum-test-${Date.now()}.bin`);
    const content = Buffer.from('hello world');
    fs.writeFileSync(testFile, content);

    const expectedHash = require('crypto').createHash('sha256').update(content).digest('hex');
    expect(() => resolver.verifyChecksum(testFile, expectedHash)).not.toThrow();

    fs.unlinkSync(testFile);
  });

  it('throws BusinessError on checksum mismatch', () => {
    const resolver = makeResolver();
    const testFile = path.join(os.tmpdir(), `checksum-test-${Date.now()}.bin`);
    fs.writeFileSync(testFile, Buffer.from('hello world'));

    expect(() => resolver.verifyChecksum(testFile, 'wronghash')).toThrow();

    try {
      resolver.verifyChecksum(testFile, 'wronghash');
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessError);
      expect((err as BusinessError).code).toBe('business_update_checksum_mismatch');
    }

    fs.unlinkSync(testFile);
  });

  it('skips verification when no checksum provided', () => {
    const resolver = makeResolver();
    const testFile = path.join(os.tmpdir(), `checksum-test-${Date.now()}.bin`);
    fs.writeFileSync(testFile, Buffer.from('hello world'));

    // Empty string checksum → skip verification
    expect(() => resolver.verifyChecksum(testFile, '')).not.toThrow();

    fs.unlinkSync(testFile);
  });
});