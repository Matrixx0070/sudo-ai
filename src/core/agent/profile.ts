/**
 * @file agent/profile.ts
 * @description Per-session profile isolation for SUDO-AI v4.
 *
 * Inspired by Hermes Agent's profile isolation where each profile gets
 * its own home directory, tools, memory, and hooks.
 *
 * Each profile is an isolated agent context with:
 *   - Own memory namespace
 *   - Own tool allow/deny list
 *   - Own hook registry (isolated from global hooks)
 *   - Own session store
 *
 * Profiles can share read-only data (global skills, global knowledge).
 * The default profile is 'main'.
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { HookManager } from '../hooks/index.js';
import type { ToolDefinition, ToolCategory } from '../tools/types.js';

const log = createLogger('agent:profile');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tool profile controls which tools are available. */
export type ToolProfile = 'minimal' | 'coding' | 'full';

/** An isolated agent profile. */
export interface AgentProfile {
  /** Unique profile ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Home directory for this profile (data/profiles/{id}). */
  homeDir: string;
  /** Tool allowlist — if non-empty, only these tools are available. */
  tools: { allow: string[]; deny: string[] };
  /** Memory namespace for this profile. */
  memoryNamespace: string;
  /** Isolated hook manager for this profile. */
  hooks: HookManager;
  /** Creation timestamp. */
  createdAt: string;
}

/** Configuration for creating a new profile. */
export interface ProfileConfig {
  /** Human-readable name for the profile. */
  name: string;
  /** Optional tool allow/deny lists. */
  tools?: { allow?: string[]; deny?: string[] };
  /** Optional memory namespace (defaults to profile name). */
  memoryNamespace?: string;
}

/** Profile manager configuration. */
export interface ProfileIsolationConfig {
  /** Maximum number of profiles. */
  maxProfiles: number;
  /** Name of the default profile. */
  defaultProfile: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ProfileIsolationConfig = {
  maxProfiles: 10,
  defaultProfile: 'main',
};

// ---------------------------------------------------------------------------
// ProfileManager
// ---------------------------------------------------------------------------

export class ProfileManager {
  private readonly config: ProfileIsolationConfig;
  private readonly profiles: Map<string, AgentProfile> = new Map();
  private readonly nameIndex: Map<string, string> = new Map(); // name → id

  constructor(config?: Partial<ProfileIsolationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create default profile
    const defaultId = genId();
    const defaultProfile: AgentProfile = {
      id: defaultId,
      name: this.config.defaultProfile,
      homeDir: `data/profiles/${defaultId}`,
      tools: { allow: [], deny: [] },
      memoryNamespace: this.config.defaultProfile,
      hooks: new HookManager(),
      createdAt: new Date().toISOString(),
    };

    this.profiles.set(defaultId, defaultProfile);
    this.nameIndex.set(this.config.defaultProfile, defaultId);

    log.info(
      { profileId: defaultId, name: this.config.defaultProfile },
      'Default profile created',
    );
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new isolated profile.
   *
   * @param config - Profile configuration.
   * @returns The created AgentProfile.
   * @throws Error if max profiles reached or name already exists.
   */
  createProfile(config: ProfileConfig): AgentProfile {
    if (this.profiles.size >= this.config.maxProfiles) {
      throw new Error(
        `ProfileManager: max profiles reached (${this.config.maxProfiles})`,
      );
    }

    if (this.nameIndex.has(config.name)) {
      throw new Error(`ProfileManager: profile name "${config.name}" already exists`);
    }

    const id = genId();
    const profile: AgentProfile = {
      id,
      name: config.name,
      homeDir: `data/profiles/${id}`,
      tools: {
        allow: config.tools?.allow ?? [],
        deny: config.tools?.deny ?? [],
      },
      memoryNamespace: config.memoryNamespace ?? config.name,
      hooks: new HookManager(),
      createdAt: new Date().toISOString(),
    };

    this.profiles.set(id, profile);
    this.nameIndex.set(config.name, id);

    log.info({ profileId: id, name: config.name }, 'Profile created');
    return profile;
  }

  /**
   * Get a profile by its ID.
   */
  getProfile(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  /**
   * Get a profile by its name.
   */
  getProfileByName(name: string): AgentProfile | undefined {
    const id = this.nameIndex.get(name);
    return id ? this.profiles.get(id) : undefined;
  }

  /**
   * Get the default (main) profile.
   */
  getDefaultProfile(): AgentProfile {
    const id = this.nameIndex.get(this.config.defaultProfile);
    if (!id) throw new Error('ProfileManager: default profile not found');
    return this.profiles.get(id)!;
  }

  /**
   * Delete a profile by ID. Cannot delete the default profile.
   *
   * @returns true if deleted, false if not found or is default.
   */
  deleteProfile(id: string): boolean {
    const profile = this.profiles.get(id);
    if (!profile) return false;

    // Protect default profile
    if (profile.name === this.config.defaultProfile) {
      log.warn({ profileId: id }, 'Cannot delete default profile');
      return false;
    }

    this.profiles.delete(id);
    this.nameIndex.delete(profile.name);

    log.info({ profileId: id, name: profile.name }, 'Profile deleted');
    return true;
  }

  /**
   * List all profiles.
   */
  listProfiles(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  // -------------------------------------------------------------------------
  // Tool filtering
  // -------------------------------------------------------------------------

  /**
   * Get the tools available for a specific profile.
   * Applies allow/deny rules on top of the full registry.
   *
   * @param profileId - Profile ID.
   * @param allTools  - All tools from the registry.
   * @returns Filtered tool definitions.
   */
  getToolsForProfile(
    profileId: string,
    allTools: ToolDefinition[],
  ): ToolDefinition[] {
    const profile = this.profiles.get(profileId);
    if (!profile) return allTools;

    // If allow list is non-empty, only those tools are available
    if (profile.tools.allow.length > 0) {
      const allowSet = new Set(profile.tools.allow);
      return allTools.filter(t => allowSet.has(t.name));
    }

    // Otherwise, exclude denied tools
    if (profile.tools.deny.length > 0) {
      const denySet = new Set(profile.tools.deny);
      return allTools.filter(t => !denySet.has(t.name));
    }

    // No restrictions
    return allTools;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /**
   * Get profile manager statistics.
   */
  getStats(): { totalProfiles: number; activeProfiles: number } {
    return {
      totalProfiles: this.profiles.size,
      activeProfiles: this.profiles.size,
    };
  }
}