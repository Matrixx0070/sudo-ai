/**
 * Profile registry (Spec 3) — load/normalize, defaults, name sanitization,
 * unregistered-name conservative fallback.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadBrowserProfiles, getProfileEntry, isRegisteredProfile, defaultProfileName,
  sanitizeProfileName, __resetProfileRegistryForTests,
} from '../../src/core/tools/builtin/browser/profile-registry.js';

function writeCfg(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bp-'));
  const p = join(dir, 'browser-profiles.json5');
  writeFileSync(p, body, 'utf-8');
  return p;
}

beforeEach(() => __resetProfileRegistryForTests());

describe('profile-registry', () => {
  it('falls back to built-in defaults when config is missing', () => {
    const cfg = loadBrowserProfiles('/nonexistent/browser-profiles.json5');
    expect(cfg.defaultProfile).toBe('ephemeral');
    expect(cfg.profiles['personal']?.ownerOnly).toBe(true);
    expect(cfg.profiles['ephemeral']?.ephemeral).toBe(true);
  });

  it('loads + normalizes a real config', () => {
    const p = writeCfg(`{ defaultProfile: 'work', profiles: {
      personal: { trust: 'high', ownerOnly: true, ephemeral: false },
      work: { trust: 'medium' },
      scratch: { ephemeral: true, domainAllowlist: ['example.com'] },
    }}`);
    const cfg = loadBrowserProfiles(p, true);
    expect(cfg.defaultProfile).toBe('work');
    expect(cfg.profiles['personal']?.trust).toBe('high');
    expect(cfg.profiles['work']?.ownerOnly).toBe(false); // default
    expect(cfg.profiles['scratch']?.domainAllowlist).toEqual(['example.com']);
  });

  it('an unregistered name yields a conservative, non-owner, durable entry', () => {
    __resetProfileRegistryForTests();
    loadBrowserProfiles('/nonexistent'); // defaults
    const e = getProfileEntry('some-random-name');
    expect(e.trust).toBe('low');
    expect(e.ownerOnly).toBe(false);
    expect(e.ephemeral).toBe(false);
    expect(isRegisteredProfile('some-random-name')).toBe(false);
    expect(isRegisteredProfile('personal')).toBe(true);
  });

  it('bad defaultProfile falls back to ephemeral or first profile', () => {
    const p = writeCfg(`{ defaultProfile: 'ghost', profiles: { a: { trust: 'low' }, ephemeral: { ephemeral: true } } }`);
    expect(loadBrowserProfiles(p, true).defaultProfile).toBe('ephemeral');
    expect(defaultProfileName()).toBe('ephemeral');
  });

  it('sanitizeProfileName strips path traversal + junk', () => {
    expect(sanitizeProfileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeProfileName('a/b/c')).toBe('c');
    expect(sanitizeProfileName('good-name_1')).toBe('good-name_1');
    expect(sanitizeProfileName('!!!')).toBe('ephemeral'); // empty after strip → safe default
  });
});
