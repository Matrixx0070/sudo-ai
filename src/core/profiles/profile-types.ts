/**
 * profile-types.ts — Type definitions for the Profile system.
 *
 * Profiles allow isolated configurations with their own:
 * - config overrides
 * - environment variables
 * - skills list
 * - SOUL.md override
 */

// ---------------------------------------------------------------------------
// Profile data structure
// ---------------------------------------------------------------------------

/**
 * Complete profile definition stored at data/profiles/<name>/profile.json
 */
export interface Profile {
  /** Unique profile name (also directory name under data/profiles/) */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Configuration overrides for this profile */
  config: Record<string, unknown>;
  /** Environment variable overrides for this profile */
  env: Record<string, string>;
  /** Optional SOUL.md content override */
  soulMd?: string;
  /** List of enabled skill IDs for this profile */
  skills: string[];
  /** Whether this profile is currently enabled */
  enabled: boolean;
  /** ISO 8601 timestamp of profile creation */
  createdAt: string;
  /** ISO 8601 timestamp of last modification */
  updatedAt: string;
}

/**
 * Summary view returned by listProfiles()
 */
export interface ProfileSummary {
  /** Profile name */
  name: string;
  /** Whether profile is enabled */
  enabled: boolean;
  /** Number of skills enabled */
  skillCount: number;
  /** ISO 8601 timestamp of last activity/modification */
  lastActive: string;
}

/**
 * Options for creating a new profile
 */
export interface ProfileCreateOptions {
  /** Unique profile name (required) */
  name: string;
  /** Optional display name (defaults to name) */
  displayName?: string;
  /** Optional config overrides */
  config?: Record<string, unknown>;
  /** Optional environment variable overrides */
  env?: Record<string, string>;
  /** Optional SOUL.md content */
  soulMd?: string;
  /** Optional list of skills to enable */
  skills?: string[];
  /** Optional profile name to clone from (deep copies config, env, skills) */
  cloneFrom?: string;
}

/**
 * Options for cloning a profile
 */
export interface ProfileCloneOptions {
  /** Source profile name */
  fromName: string;
  /** Target profile name */
  toName: string;
  /** Optional new display name (defaults to toName) */
  displayName?: string;
}

// ---------------------------------------------------------------------------
// Internal storage format
// ---------------------------------------------------------------------------

/**
 * Internal file format for profile.json
 * Matches Profile interface exactly
 */
export type ProfileFile = Profile;

/**
 * Kill-switch environment variable
 * SUDO_PROFILES_DISABLE=1 disables all profile operations
 */
export const PROFILES_KILL_SWITCH = 'SUDO_PROFILES_DISABLE' as const;
