/**
 * profile-manager.ts — Profile management for SUDO-AI.
 *
 * Provides isolated profile storage with:
 * - createProfile, deleteProfile, getProfile, listProfiles
 * - activateProfile, getActiveProfile
 * - cloneProfile (deep copies config, env, skills)
 *
 * Profile data stored at DATA_DIR/profiles/<name>/profile.json
 * Kill-switch: SUDO_PROFILES_DISABLE=1
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import type { Profile, ProfileSummary, ProfileCreateOptions, ProfileCloneOptions } from './profile-types.js';
import { PROFILES_KILL_SWITCH } from './profile-types.js';

const log = createLogger('profile-manager');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = DATA_DIR;

/** Resolves the profiles directory — checks env var at call time for testability. */
function getProfilesDir(): string {
  return join(process.env['DATA_DIR'] ?? DEFAULT_DATA_DIR, 'profiles');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if profiles system is disabled via kill-switch.
 */
function isDisabled(): boolean {
  return process.env[PROFILES_KILL_SWITCH] === '1';
}

/**
 * Ensure profiles directory exists.
 */
function ensureProfilesDir(): void {
  try {
    mkdirSync(getProfilesDir(), { recursive: true });
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to create profiles directory');
    throw new Error(`Cannot create profiles directory: ${getProfilesDir()}`);
  }
}

/**
 * Get profile directory path for a given profile name.
 */
function getProfileDir(name: string): string {
  return join(getProfilesDir(), name);
}

/**
 * Get profile file path for a given profile name.
 */
function getProfilePath(name: string): string {
  return join(getProfileDir(name), 'profile.json');
}

/**
 * Validate profile name (alphanumeric, hyphens, underscores, max 64 chars).
 */
function validateProfileName(name: string): { ok: true } | { ok: false; error: string } {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'Profile name is required' };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Profile name cannot be empty' };
  }
  if (trimmed.length > 64) {
    return { ok: false, error: 'Profile name must be ≤64 characters' };
  }
  // Allow alphanumeric, hyphens, underscores only
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { ok: false, error: 'Profile name must contain only letters, numbers, hyphens, and underscores' };
  }
  // Block path traversal
  if (trimmed.includes('/') || trimmed.includes('..')) {
    return { ok: false, error: 'Profile name contains disallowed characters' };
  }
  return { ok: true };
}

/**
 * Generate ISO 8601 timestamp.
 */
function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// ProfileManager class
// ---------------------------------------------------------------------------

export class ProfileManager {
  private activeProfileName: string | null = null;
  private readonly profilesDir: string;

  constructor(profilesDir?: string) {
    this.profilesDir = profilesDir ?? getProfilesDir();
  }

  /**
   * Create a new profile.
   * @param options - Profile creation options
   * @returns The created Profile
   * @throws Error if profile already exists or validation fails
   */
  createProfile(options: ProfileCreateOptions): Profile {
    if (isDisabled()) {
      log.warn('Profile creation blocked by kill-switch');
      throw new Error('Profiles disabled (SUDO_PROFILES_DISABLE=1)');
    }

    const nameValidation = validateProfileName(options.name);
    if (!nameValidation.ok) {
      throw new Error(nameValidation.error);
    }

    const name = options.name.trim();
    const profileDir = getProfileDir(name);
    const profilePath = getProfilePath(name);

    if (existsSync(profilePath)) {
      throw new Error(`Profile '${name}' already exists`);
    }

    ensureProfilesDir();

    const profile: Profile = {
      name,
      displayName: options.displayName ?? name,
      config: options.config ?? {},
      env: options.env ?? {},
      soulMd: options.soulMd,
      skills: options.skills ?? [],
      enabled: true,
      createdAt: now(),
      updatedAt: now(),
    };

    try {
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(profilePath, JSON.stringify(profile, null, 2), { mode: 0o644 });
      log.info({ name, displayName: profile.displayName }, 'Profile created');
    } catch (err: unknown) {
      log.error({ err: err instanceof Error ? err.message : String(err), name }, 'Failed to create profile');
      throw new Error(`Failed to create profile '${name}': ${err instanceof Error ? err.message : String(err)}`);
    }

    return profile;
  }

  /**
   * Delete a profile.
   * @param name - Profile name to delete
   * @returns true if deleted, false if profile didn't exist
   */
  deleteProfile(name: string): boolean {
    if (isDisabled()) {
      log.warn('Profile deletion blocked by kill-switch');
      throw new Error('Profiles disabled (SUDO_PROFILES_DISABLE=1)');
    }

    const nameValidation = validateProfileName(name);
    if (!nameValidation.ok) {
      throw new Error(nameValidation.error);
    }

    const profilePath = getProfilePath(name);

    if (!existsSync(profilePath)) {
      log.debug({ name }, 'Profile delete: profile not found');
      return false;
    }

    try {
      rmSync(getProfileDir(name), { recursive: true, force: true });
      if (this.activeProfileName === name) {
        this.activeProfileName = null;
      }
      log.info({ name }, 'Profile deleted');
      return true;
    } catch (err: unknown) {
      log.error({ err: err instanceof Error ? err.message : String(err), name }, 'Failed to delete profile');
      throw new Error(`Failed to delete profile '${name}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get a profile by name.
   * @param name - Profile name
   * @returns Profile or null if not found
   */
  getProfile(name: string): Profile | null {
    if (isDisabled()) {
      return null;
    }

    const nameValidation = validateProfileName(name);
    if (!nameValidation.ok) {
      return null;
    }

    const profilePath = getProfilePath(name);

    if (!existsSync(profilePath)) {
      return null;
    }

    try {
      const content = readFileSync(profilePath, 'utf8');
      const profile = JSON.parse(content) as Profile;
      return profile;
    } catch (err: unknown) {
      log.error({ err: err instanceof Error ? err.message : String(err), name }, 'Failed to read profile');
      return null;
    }
  }

  /**
   * List all profiles (summary view).
   * @returns Array of ProfileSummary
   */
  listProfiles(): ProfileSummary[] {
    if (isDisabled()) {
      return [];
    }

    ensureProfilesDir();

    const summaries: ProfileSummary[] = [];

    try {
      const entries = readdirSync(getProfilesDir(), { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const name = entry.name;
        const profilePath = getProfilePath(name);

        if (!existsSync(profilePath)) continue;

        try {
          const content = readFileSync(profilePath, 'utf8');
          const profile = JSON.parse(content) as Profile;

          summaries.push({
            name: profile.name,
            enabled: profile.enabled,
            skillCount: profile.skills.length,
            lastActive: profile.updatedAt,
          });
        } catch {
          // Skip corrupted profiles
          log.warn({ name }, 'Skipping corrupted profile during list');
        }
      }

      // Sort by lastActive descending
      summaries.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
    } catch (err: unknown) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to list profiles');
    }

    return summaries;
  }

  /**
   * Activate a profile by name.
   * Sets SUDO_ACTIVE_PROFILE env var and tracks internally.
   * @param name - Profile name to activate
   * @returns true if activated, false if profile doesn't exist
   */
  activateProfile(name: string): boolean {
    if (isDisabled()) {
      log.warn('Profile activation blocked by kill-switch');
      throw new Error('Profiles disabled (SUDO_PROFILES_DISABLE=1)');
    }

    const profile = this.getProfile(name);
    if (!profile) {
      log.debug({ name }, 'Profile activation: profile not found');
      return false;
    }

    this.activeProfileName = name;
    process.env['SUDO_ACTIVE_PROFILE'] = name;
    log.info({ name }, 'Profile activated');
    return true;
  }

  /**
   * Get the currently active profile name.
   * @returns Active profile name or null
   */
  getActiveProfile(): string | null {
    if (isDisabled()) {
      return null;
    }

    // Check env first (may have been set externally)
    const envProfile = process.env['SUDO_ACTIVE_PROFILE'];
    if (envProfile) {
      // Verify profile exists
      if (this.getProfile(envProfile)) {
        this.activeProfileName = envProfile;
        return envProfile;
      }
      // Profile doesn't exist, clear env
      delete process.env['SUDO_ACTIVE_PROFILE'];
    }

    return this.activeProfileName;
  }

  /**
   * Clone an existing profile to a new profile.
   * Deep copies config, env, and skills.
   * @param fromName - Source profile name
   * @param toName - Target profile name
   * @param displayName - Optional new display name
   * @returns The cloned Profile
   * @throws Error if source doesn't exist or target already exists
   */
  cloneProfile(fromName: string, toName: string, displayName?: string): Profile {
    if (isDisabled()) {
      log.warn('Profile cloning blocked by kill-switch');
      throw new Error('Profiles disabled (SUDO_PROFILES_DISABLE=1)');
    }

    const fromValidation = validateProfileName(fromName);
    if (!fromValidation.ok) {
      throw new Error(`Source profile: ${fromValidation.error}`);
    }

    const toValidation = validateProfileName(toName);
    if (!toValidation.ok) {
      throw new Error(`Target profile: ${toValidation.error}`);
    }

    const sourceProfile = this.getProfile(fromName);
    if (!sourceProfile) {
      throw new Error(`Source profile '${fromName}' does not exist`);
    }

    const targetPath = getProfilePath(toName);
    if (existsSync(targetPath)) {
      throw new Error(`Target profile '${toName}' already exists`);
    }

    ensureProfilesDir();

    // Deep clone with new identity
    const cloned: Profile = {
      name: toName,
      displayName: displayName ?? toName,
      config: JSON.parse(JSON.stringify(sourceProfile.config)) as Record<string, unknown>,
      env: JSON.parse(JSON.stringify(sourceProfile.env)) as Record<string, string>,
      soulMd: sourceProfile.soulMd,
      skills: [...sourceProfile.skills],
      enabled: true,
      createdAt: now(),
      updatedAt: now(),
    };

    try {
      const targetDir = getProfileDir(toName);
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(targetPath, JSON.stringify(cloned, null, 2), { mode: 0o644 });
      log.info({ fromName, toName, displayName: cloned.displayName }, 'Profile cloned');
    } catch (err: unknown) {
      log.error({ err: err instanceof Error ? err.message : String(err), fromName, toName }, 'Failed to clone profile');
      throw new Error(`Failed to clone profile: ${err instanceof Error ? err.message : String(err)}`);
    }

    return cloned;
  }

  /**
   * Update a profile's configuration.
   * @param name - Profile name
   * @param updates - Partial profile updates
   * @returns Updated Profile or null if profile doesn't exist
   */
  updateProfile(name: string, updates: Partial<Pick<Profile, 'displayName' | 'config' | 'env' | 'soulMd' | 'skills' | 'enabled'>>): Profile | null {
    if (isDisabled()) {
      return null;
    }

    const profile = this.getProfile(name);
    if (!profile) {
      return null;
    }

    const updated: Profile = {
      ...profile,
      displayName: updates.displayName ?? profile.displayName,
      config: updates.config ?? profile.config,
      env: updates.env ?? profile.env,
      soulMd: updates.soulMd ?? profile.soulMd,
      skills: updates.skills ?? profile.skills,
      enabled: updates.enabled ?? profile.enabled,
      updatedAt: now(),
    };

    try {
      const profilePath = getProfilePath(name);
      writeFileSync(profilePath, JSON.stringify(updated, null, 2), { mode: 0o644 });
      log.info({ name }, 'Profile updated');
      return updated;
    } catch (err: unknown) {
      log.error({ err: err instanceof Error ? err.message : String(err), name }, 'Failed to update profile');
      return null;
    }
  }

  /**
   * Get environment variables for the active profile.
   * @returns Merged env vars (profile overrides base env)
   */
  getActiveProfileEnv(): Record<string, string> {
    if (isDisabled()) {
      return {};
    }

    const activeName = this.getActiveProfile();
    if (!activeName) {
      return {};
    }

    const profile = this.getProfile(activeName);
    if (!profile || !profile.env) {
      return {};
    }

    return { ...profile.env };
  }

  /**
   * Get skills for the active profile.
   * @returns Array of skill IDs
   */
  getActiveProfileSkills(): string[] {
    if (isDisabled()) {
      return [];
    }

    const activeName = this.getActiveProfile();
    if (!activeName) {
      return [];
    }

    const profile = this.getProfile(activeName);
    if (!profile) {
      return [];
    }

    return [...profile.skills];
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const profileManager = new ProfileManager();
