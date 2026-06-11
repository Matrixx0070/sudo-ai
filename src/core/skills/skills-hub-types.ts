/**
 * @file skills-hub-types.ts
 * @description Type definitions for SkillsHub registry integration.
 */

import type { SkillTrustTier, Capability } from '../shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Registry types — matches agentskills.io / openjarvis registry schema
// ---------------------------------------------------------------------------

/** A skill entry as returned from the remote registry search API. */
export interface RegistrySkillEntry {
  /** Unique skill identifier (dotted notation, e.g. "io.github.user.skill"). */
  id: string;
  /** Human-readable skill name. */
  name: string;
  /** Display name for UI purposes. */
  displayName: string;
  /** Short description (1-2 sentences). */
  description: string;
  /** Semantic version string. */
  version: string;
  /** Author name or organisation. */
  author: string;
  /** License identifier (e.g. "MIT", "Apache-2.0"). */
  license: string;
  /** Trust tier assigned by registry verification. */
  trustTier: SkillTrustTier;
  /** Capability strings required by this skill. */
  caps: Capability[];
  /** Total download count across all users. */
  downloads: number;
  /** Classification tags for search/filter. */
  tags: string[];
  /** Source repository URL (e.g. GitHub). */
  sourceUrl: string;
  /** Compatible SUDO-AI versions (semver range). */
  compatibility: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last updated timestamp. */
  updatedAt: string;
}

/** Paginated search results from the remote registry. */
export interface RegistrySearchResult {
  /** Total number of matching skills. */
  total: number;
  /** Skills on this page. */
  results: RegistrySkillEntry[];
  /** Current page number (1-based). */
  page: number;
  /** Results per page. */
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Installed skill types — local persistence
// ---------------------------------------------------------------------------

/** Source from which a skill was installed. */
export type SkillInstallSource = 'bundled' | 'registry' | 'import' | 'workspace';

/** A skill installed locally with version tracking. */
export interface InstalledSkill {
  /** Unique skill identifier. */
  id: string;
  /** Human-readable skill name. */
  name: string;
  /** Installed version string. */
  version: string;
  /** ISO-8601 timestamp when skill was installed. */
  installedAt: string;
  /** Source from which this skill was installed. */
  source: SkillInstallSource;
  /** Registry ID if installed from registry (optional). */
  registryId?: string;
  /** Trust tier for capability enforcement. */
  trustTier: SkillTrustTier;
  /** Capability strings this skill requires. */
  caps: Capability[];
  /** Whether the skill is currently enabled. */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Update check types
// ---------------------------------------------------------------------------

/** Result of checking for skill updates. */
export interface SkillUpdateCheck {
  /** Skill name. */
  name: string;
  /** Currently installed version. */
  currentVersion: string;
  /** Latest available version in registry. */
  latestVersion: string;
  /** True if latestVersion differs from currentVersion. */
  hasUpdate: boolean;
  /** True if update contains breaking changes (major version bump). */
  breakingChanges: boolean;
  /** Optional changelog summary. */
  changelog?: string;
}

// ---------------------------------------------------------------------------
// Hub configuration
// ---------------------------------------------------------------------------

/** Configuration options for SkillsHub. */
export interface SkillsHubConfig {
  /** Remote registry base URL (default: from SUDO_SKILLS_REGISTRY_URL env). */
  registryUrl?: string;
  /** Fetch timeout in milliseconds (default: 10000). */
  fetchTimeoutMs?: number;
  /** Maximum retry attempts (default: 3). */
  maxRetries?: number;
  /** Directory for installed skills (default: <DATA_DIR>/installed-skills). */
  installDir?: string;
}
