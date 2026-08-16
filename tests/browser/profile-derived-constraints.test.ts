/**
 * @file profile-derived-constraints.test.ts
 * @description A per-process fork of a profile (`<base>__pid<N>`) must not be a
 * cheaper way to reach the profile it derives from.
 *
 * The hole this closes: `sanitizeProfileName` accepts `personal__pid1234`
 * verbatim (letters, digits and `_` are all allowed), the registry had no entry
 * for it, and `getProfileEntry` returned the permissive fallback — trust 'low',
 * ownerOnly false. So a non-owner naming the fork of the owner-only `personal`
 * profile walked straight past `checkOwnerAllowed` and past the launch
 * chokepoint. Pure fs/registry — no browser needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getProfileEntry,
  baseProfileName,
  isDerivedProfileName,
  sanitizeProfileName,
  loadBrowserProfiles,
  __resetProfileRegistryForTests,
} from '../../src/core/tools/builtin/browser/profile-registry.js';
import { checkOwnerAllowed } from '../../src/core/tools/builtin/browser/safety.js';
import {
  resolveLaunchProfileDir,
  ProfileLockedError,
} from '../../src/core/tools/builtin/browser/profile-lock.js';

const CONFIG = `{
  defaultProfile: 'ephemeral',
  profiles: {
    personal: { trust: 'high', ownerOnly: true,  ephemeral: false, domainAllowlist: ['mail.google.com'] },
    work:     { trust: 'medium', ownerOnly: false, ephemeral: false, domainAllowlist: [] },
    ephemeral:{ trust: 'low', ownerOnly: false, ephemeral: true,  domainAllowlist: [] },
  },
}`;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'derived-constraints-'));
  const path = join(dir, 'browser-profiles.json5');
  writeFileSync(path, CONFIG);
  __resetProfileRegistryForTests();
  loadBrowserProfiles(path, true);
});

describe('derived profile names', () => {
  it('recognises and resolves a fork name to its base', () => {
    expect(isDerivedProfileName('personal__pid1234')).toBe(true);
    expect(isDerivedProfileName('personal')).toBe(false);
    expect(isDerivedProfileName('my__pidgeon')).toBe(false); // needs digits
    expect(baseProfileName('personal__pid1234')).toBe('personal');
    expect(baseProfileName('personal__pid12__pid34')).toBe('personal');
    expect(baseProfileName('work')).toBe('work');
  });

  it('is a name the path sanitiser accepts — which is why inheritance matters', () => {
    expect(sanitizeProfileName('personal__pid1234')).toBe('personal__pid1234');
  });

  it('inherits EVERY constraint of the base profile', () => {
    const base = getProfileEntry('personal');
    const derived = getProfileEntry('personal__pid1234');
    expect(derived.ownerOnly).toBe(base.ownerOnly);
    expect(derived.trust).toBe(base.trust);
    expect(derived.ephemeral).toBe(base.ephemeral);
    expect(derived.domainAllowlist).toEqual(base.domainAllowlist);
    expect(derived.derivedFrom).toBe('personal');
    expect(derived.name).toBe('personal__pid1234');
  });

  it('refuses a derived owner-only profile to a NON-OWNER caller', () => {
    const gate = checkOwnerAllowed(getProfileEntry('personal__pid1234'), false, 's1');
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/owner-only/);
  });

  it('keeps the permissive default for a genuinely unrelated name', () => {
    const e = getProfileEntry('scratch');
    expect(e.ownerOnly).toBe(false);
    expect(e.trust).toBe('low');
    expect(e.derivedFrom).toBeUndefined();
  });

  it('derives from an unregistered base without recursing forever', () => {
    const e = getProfileEntry('scratch__pid7__pid9');
    expect(e.ownerOnly).toBe(false);
    expect(e.derivedFrom).toBe('scratch');
  });
});

describe('resolveLaunchProfileDir with allowFork=false', () => {
  let root: string;
  let profile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nofork-'));
    profile = join(root, 'personal');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
  });

  it('throws instead of creating a second home for a guarded identity', () => {
    // A lock owned by THIS process is unambiguously live.
    symlinkSync(`${hostname()}-${process.pid}`, join(profile, 'SingletonLock'));
    expect(() => resolveLaunchProfileDir(profile, { allowFork: false })).toThrow(ProfileLockedError);
    expect(() => resolveLaunchProfileDir(profile, { allowFork: false })).toThrow(/held by another live process/);
    rmSync(root, { recursive: true, force: true });
  });

  it('still clears a STALE lock and reuses the real dir (never forks around it)', () => {
    symlinkSync(`${hostname()}-4194300`, join(profile, 'SingletonLock')); // dead pid
    const res = resolveLaunchProfileDir(profile, { allowFork: false });
    expect(res).toEqual({ dir: profile, forked: false });
    rmSync(root, { recursive: true, force: true });
  });
});
