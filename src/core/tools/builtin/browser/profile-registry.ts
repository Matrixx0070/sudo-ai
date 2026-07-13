/**
 * @file profile-registry.ts
 * @description Registry of named, durable browser identities (Spec 3). Loads
 * config/browser-profiles.json5 → typed entries with trust level, owner-only,
 * ephemeral, and an optional per-profile domain allowlist. Resolves each profile
 * to a userDataDir at data/browser-profiles/<name>/ created mode 0700.
 *
 * Fail-safe: a missing/unparseable config falls back to the three canonical
 * profiles (personal/work/ephemeral) so the browser stack always works. An
 * UNREGISTERED profile name is still usable as a plain persistent profile with
 * conservative defaults (trust:low, ownerOnly:false, ephemeral:false) — the
 * registry adds identity metadata, it does not gate arbitrary dir names.
 */

import { readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import JSON5 from 'json5';
import { projectPath } from '../../../shared/paths.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('browser:profile-registry');

export type ProfileTrust = 'high' | 'medium' | 'low';

export interface BrowserProfileEntry {
  name: string;
  description?: string;
  trust: ProfileTrust;
  /** Only the owner may launch/drive this profile. */
  ownerOnly: boolean;
  /** Wipe the userDataDir on close (no persistence). */
  ephemeral: boolean;
  /** Optional navigation allowlist (hostname suffixes). Empty = no extra restriction. */
  domainAllowlist: string[];
}

export interface BrowserProfilesConfig {
  defaultProfile: string;
  profiles: Record<string, BrowserProfileEntry>;
}

const PROFILES_ROOT = 'data/browser-profiles';
const CONFIG_PATH = projectPath('config', 'browser-profiles.json5');

/** Canonical fallback used when the config file is missing/unparseable. */
function builtinDefaults(): BrowserProfilesConfig {
  return {
    defaultProfile: 'ephemeral',
    profiles: {
      personal: { name: 'personal', description: "Owner's logins", trust: 'high', ownerOnly: true, ephemeral: false, domainAllowlist: [] },
      work: { name: 'work', description: 'Work accounts', trust: 'medium', ownerOnly: false, ephemeral: false, domainAllowlist: [] },
      ephemeral: { name: 'ephemeral', description: 'Throwaway — wiped on close', trust: 'low', ownerOnly: false, ephemeral: true, domainAllowlist: [] },
    },
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

function normalizeEntry(name: string, raw: unknown): BrowserProfileEntry {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const trust: ProfileTrust = o['trust'] === 'high' || o['trust'] === 'medium' || o['trust'] === 'low' ? o['trust'] : 'low';
  return {
    name,
    ...(typeof o['description'] === 'string' ? { description: o['description'] } : {}),
    trust,
    ownerOnly: o['ownerOnly'] === true,
    ephemeral: o['ephemeral'] === true,
    domainAllowlist: toStringArray(o['domainAllowlist']),
  };
}

let _cache: BrowserProfilesConfig | null = null;

/** Load (and cache) the profile registry. Fail-safe to built-in defaults. */
export function loadBrowserProfiles(path: string = CONFIG_PATH, force = false): BrowserProfilesConfig {
  if (_cache && !force) return _cache;
  if (!existsSync(path)) {
    log.info({ path }, 'no browser-profiles.json5 — using built-in defaults');
    _cache = builtinDefaults();
    return _cache;
  }
  try {
    const raw = JSON5.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const rawProfiles = (raw['profiles'] && typeof raw['profiles'] === 'object') ? raw['profiles'] as Record<string, unknown> : {};
    const profiles: Record<string, BrowserProfileEntry> = {};
    for (const [name, val] of Object.entries(rawProfiles)) {
      profiles[name] = normalizeEntry(name, val);
    }
    if (Object.keys(profiles).length === 0) {
      log.warn({ path }, 'browser-profiles.json5 has no profiles — using built-in defaults');
      _cache = builtinDefaults();
      return _cache;
    }
    const defaultProfile = typeof raw['defaultProfile'] === 'string' && profiles[raw['defaultProfile']]
      ? raw['defaultProfile']
      : (profiles['ephemeral'] ? 'ephemeral' : Object.keys(profiles)[0]!);
    _cache = { defaultProfile, profiles };
    log.info({ profiles: Object.keys(profiles), defaultProfile }, 'browser-profiles.json5 loaded');
    return _cache;
  } catch (err) {
    log.error({ path, err: err instanceof Error ? err.message : String(err) }, 'browser-profiles.json5 parse failed — using built-in defaults');
    _cache = builtinDefaults();
    return _cache;
  }
}

/** Clear the cache (tests / hot-reload). */
export function __resetProfileRegistryForTests(): void { _cache = null; }

/**
 * Look up a profile entry. An unregistered name yields a conservative,
 * non-owner, persistent entry so arbitrary profile dirs still work — the
 * registry adds metadata, it does not restrict which dir names may exist.
 */
export function getProfileEntry(name: string): BrowserProfileEntry {
  const cfg = loadBrowserProfiles();
  const found = cfg.profiles[name];
  if (found) return found;
  return { name, trust: 'low', ownerOnly: false, ephemeral: false, domainAllowlist: [] };
}

/** True only for names explicitly present in the registry. */
export function isRegisteredProfile(name: string): boolean {
  return Boolean(loadBrowserProfiles().profiles[name]);
}

/** The configured default profile name. */
export function defaultProfileName(): string {
  return loadBrowserProfiles().defaultProfile;
}

/** Sanitize a profile name to a safe single path segment (defense-in-depth vs traversal). */
export function sanitizeProfileName(name: string): string {
  const cleaned = basename(String(name)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || 'ephemeral';
}

/** Absolute userDataDir for a profile (does not create it). */
export function profileDir(name: string, profilesRoot: string = PROFILES_ROOT): string {
  return resolve(profilesRoot, sanitizeProfileName(name));
}

/** Ensure the userDataDir exists with owner-only perms (0700). Returns the path. */
export function ensureProfileDir(name: string, profilesRoot: string = PROFILES_ROOT): string {
  const dir = profileDir(name, profilesRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Enforce 0700 even if the dir pre-existed with looser perms (real creds live here).
  try { chmodSync(dir, 0o700); } catch { /* best-effort on platforms without chmod */ }
  return dir;
}
