/**
 * @file skills-hub.ts
 * @description SkillsHub — remote registry search, install, update, and management.
 *
 * Kill-switches:
 *   SUDO_SKILLS_HUB_DISABLE=1 — disables all hub operations
 *   SUDO_SKILLS_INSTALL_DISABLE=1 — disables install/update operations only
 *
 * Registry URL from SUDO_SKILLS_REGISTRY_URL env (default: https://agentskills.io/api/v1)
 */

import { createLogger } from '../shared/logger.js';
import type {
  RegistrySkillEntry,
  RegistrySearchResult,
  InstalledSkill,
  SkillUpdateCheck,
  SkillsHubConfig,
  SkillInstallSource,
} from './skills-hub-types.js';
import type { SkillRegistry } from './registry.js';
import type { SkillTrustTier } from '../shared/wave10-types.js';

const log = createLogger('skills:hub');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRY_URL = 'https://agentskills.io/api/v1';
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const INSTALLED_SKILLS_DIR = 'data/installed-skills';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if hub is disabled via kill-switch. */
function isHubDisabled(): boolean {
  return process.env['SUDO_SKILLS_HUB_DISABLE'] === '1';
}

/** Check if install operations are disabled. */
function isInstallDisabled(): boolean {
  return process.env['SUDO_SKILLS_INSTALL_DISABLE'] === '1';
}

/**
 * Fetch with timeout and exponential backoff retry.
 * @throws Error on timeout, non-200 status, or max retries exceeded.
 */
async function fetchWithRetry(
  url: string,
  timeoutMs: number,
  maxRetries: number,
): Promise<Response> {
  let lastError: Error | null = null;
  let delayMs = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (response.ok) {
        return response;
      }

      log.warn({ url, status: response.status }, 'fetch returned non-OK status');
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn({ url, attempt, maxRetries, err: lastError }, 'fetch failed, will retry');
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2; // exponential backoff
    }
  }

  throw lastError ?? new Error('fetch failed after max retries');
}

/** Ensure installed skills directory exists. */
function ensureInstalledDir(): void {
  try {
    const { mkdirSync } = require('node:fs');
    const { join } = require('node:path');
    mkdirSync(join(process.cwd(), INSTALLED_SKILLS_DIR), { recursive: true });
  } catch (err) {
    log.warn({ err }, 'failed to create installed-skills directory');
  }
}

/** Parse trust tier from registry response. */
function parseTrustTier(raw: string | undefined): SkillTrustTier {
  const valid = new Set(['bundled', 'indexed', 'unreviewed', 'workspace']);
  if (raw && valid.has(raw)) {
    return raw as SkillTrustTier;
  }
  return 'unreviewed'; // default for remote skills
}

// ---------------------------------------------------------------------------
// SkillsHub class
// ---------------------------------------------------------------------------

export class SkillsHub {
  private readonly registryUrl: string;
  private readonly fetchTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly registry: SkillRegistry | null;

  constructor(registry: SkillRegistry | null = null, config: SkillsHubConfig = {}) {
    this.registry = registry;
    this.registryUrl = config.registryUrl ?? process.env['SUDO_SKILLS_REGISTRY_URL'] ?? DEFAULT_REGISTRY_URL;
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    log.info({ registryUrl: this.registryUrl }, 'SkillsHub initialized');
  }

  /**
   * Search the remote registry for skills matching a query.
   * @param query - Search query string (empty returns all).
   * @param page - Page number (1-based, default: 1).
   * @param limit - Results per page (default: 20, max: 100).
   * @returns Paginated search results.
   * @throws Error if hub is disabled or network fails.
   */
  async search(query: string, page = 1, limit = 20): Promise<RegistrySearchResult> {
    if (isHubDisabled()) {
      throw new Error('SkillsHub is disabled via SUDO_SKILLS_HUB_DISABLE=1');
    }

    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const q = encodeURIComponent(query ?? '');
    const url = `${this.registryUrl}/skills/search?q=${q}&page=${safePage}&limit=${safeLimit}`;

    log.debug({ query, page: safePage, limit: safeLimit }, 'searching registry');

    const response = await fetchWithRetry(url, this.fetchTimeoutMs, this.maxRetries);
    const data = await response.json();

    const results: RegistrySkillEntry[] = (data.results ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      displayName: String(r.displayName ?? r.name ?? ''),
      description: String(r.description ?? ''),
      version: String(r.version ?? '0.0.0'),
      author: String(r.author ?? 'unknown'),
      license: String(r.license ?? 'UNKNOWN'),
      trustTier: parseTrustTier(r.trustTier as string | undefined),
      caps: Array.isArray(r.caps) ? (r.caps as string[]) : [],
      downloads: Number(r.downloads ?? 0),
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      sourceUrl: String(r.sourceUrl ?? ''),
      compatibility: String(r.compatibility ?? '*'),
      createdAt: String(r.createdAt ?? ''),
      updatedAt: String(r.updatedAt ?? ''),
    }));

    return {
      total: Number(data.total ?? 0),
      results,
      page: safePage,
      pageSize: results.length,
    };
  }

  /**
   * Install a skill from the remote registry.
   * Downloads SKILL.md and saves to data/installed-skills/.
   * @param name - Skill name or ID to install.
   * @param version - Optional version (default: latest).
   * @returns Installed skill metadata.
   * @throws Error if hub/install is disabled or download fails.
   */
  async install(name: string, version?: string): Promise<InstalledSkill> {
    if (isHubDisabled()) {
      throw new Error('SkillsHub is disabled via SUDO_SKILLS_HUB_DISABLE=1');
    }
    if (isInstallDisabled()) {
      throw new Error('Skill installation is disabled via SUDO_SKILLS_INSTALL_DISABLE=1');
    }

    if (!name || typeof name !== 'string') {
      throw new Error('Skill name is required');
    }

    log.info({ name, version }, 'installing skill from registry');

    // Fetch skill manifest/metadata first
    const versionParam = version ? `?version=${encodeURIComponent(version)}` : '';
    const fetchUrl = `${this.registryUrl}/skills/${encodeURIComponent(name)}/download${versionParam}`;
    const response = await fetchWithRetry(fetchUrl, this.fetchTimeoutMs, this.maxRetries);
    const rawContent = await response.text();

    // Parse minimal frontmatter to extract metadata
    const { meta, body } = this.parseFrontmatter(rawContent);
    const skillName = (meta.name as string) || name;
    const skillVersion = (meta.version as string) || '0.0.0';
    const skillId = (meta.id as string) || name;

    // Save to installed-skills directory
    const { writeFileSync, mkdirSync } = require('node:fs');
    const { join } = require('node:path');
    const skillDir = join(process.cwd(), INSTALLED_SKILLS_DIR, skillName);
    mkdirSync(skillDir, { recursive: true });

    const filePath = join(skillDir, 'SKILL.md');
    writeFileSync(filePath, rawContent, { mode: 0o644 });

    // Register with SkillRegistry if available
    if (this.registry) {
      try {
        this.registry.registerFromImport(
          {
            id: skillId,
            name: skillName,
            version: skillVersion,
            description: (meta.description as string) || '',
            author: (meta.author as string) || 'unknown',
            source: `registry:${name}`,
            scheme: 'openjarvis' as const,
            caps: Array.isArray(meta.caps) ? (meta.caps as string[]) : [],
            tools: [],
            trust: parseTrustTier(meta.trust_tier as string),
            contentHash: require('node:crypto').createHash('sha256').update(rawContent).digest('hex'),
            importedAt: new Date().toISOString(),
          },
          rawContent,
        );
      } catch (err) {
        log.warn({ err, name: skillName }, 'failed to register skill in registry');
      }
    }

    const installed: InstalledSkill = {
      id: skillId,
      name: skillName,
      version: skillVersion,
      installedAt: new Date().toISOString(),
      source: 'registry',
      registryId: skillId,
      trustTier: parseTrustTier(meta.trust_tier as string),
      caps: Array.isArray(meta.caps) ? (meta.caps as string[]) : [],
      enabled: true,
    };

    log.info({ name: skillName, version: skillVersion }, 'skill installed');
    return installed;
  }

  /**
   * Check for and apply updates to installed skills.
   * @param name - Optional skill name (update all if omitted).
   * @returns List of update checks with applied results.
   * @throws Error if hub/install is disabled.
   */
  async update(name?: string): Promise<SkillUpdateCheck[]> {
    if (isHubDisabled()) {
      throw new Error('SkillsHub is disabled via SUDO_SKILLS_HUB_DISABLE=1');
    }
    if (isInstallDisabled()) {
      throw new Error('Skill updates are disabled via SUDO_SKILLS_INSTALL_DISABLE=1');
    }

    const { readFileSync, readdirSync } = require('node:fs');
    const { join } = require('node:path');
    const installedDir = join(process.cwd(), INSTALLED_SKILLS_DIR);

    // Get list of installed skills
    let skillNames: string[] = [];
    try {
      skillNames = readdirSync(installedDir).filter((e: string) => !e.startsWith('.'));
    } catch {
      return []; // no installed skills
    }

    if (name) {
      skillNames = skillNames.filter((n: string) => n === name);
    }

    const results: SkillUpdateCheck[] = [];

    for (const skillName of skillNames) {
      try {
        const skillPath = join(installedDir, skillName, 'SKILL.md');
        const rawContent = readFileSync(skillPath, 'utf8');
        const { meta } = this.parseFrontmatter(rawContent);
        const currentVersion = (meta.version as string) || '0.0.0';

        // Check registry for latest version
        const searchResult = await this.search(skillName, 1, 1);
        if (searchResult.total === 0 || searchResult.results.length === 0) {
          results.push({
            name: skillName,
            currentVersion,
            latestVersion: currentVersion,
            hasUpdate: false,
            breakingChanges: false,
          });
          continue;
        }

        const latest = searchResult.results[0];
        const hasUpdate = latest.version !== currentVersion;
        const breakingChanges = this.isBreakingChange(currentVersion, latest.version);

        if (hasUpdate) {
          log.info({ name: skillName, currentVersion, latestVersion: latest.version }, 'applying skill update');
          await this.install(skillName);
        }

        results.push({
          name: skillName,
          currentVersion,
          latestVersion: latest.version,
          hasUpdate,
          breakingChanges,
          changelog: latest.description,
        });
      } catch (err) {
        log.warn({ err, name: skillName }, 'failed to check skill for updates');
        results.push({
          name: skillName,
          currentVersion: 'unknown',
          latestVersion: 'unknown',
          hasUpdate: false,
          breakingChanges: false,
        });
      }
    }

    return results;
  }

  /**
   * List all installed skills with version metadata.
   * @param source - Optional filter by install source.
   * @returns Array of installed skill metadata.
   */
  list(source?: SkillInstallSource): InstalledSkill[] {
    const { readFileSync, readdirSync, existsSync } = require('node:fs');
    const { join } = require('node:path');
    const installedDir = join(process.cwd(), INSTALLED_SKILLS_DIR);

    if (!existsSync(installedDir)) {
      return [];
    }

    const skills: InstalledSkill[] = [];

    try {
      const skillNames = readdirSync(installedDir).filter((e: string) => !e.startsWith('.'));

      for (const skillName of skillNames) {
        try {
          const skillPath = join(installedDir, skillName, 'SKILL.md');
          if (!existsSync(skillPath)) continue;

          const rawContent = readFileSync(skillPath, 'utf8');
          const { meta } = this.parseFrontmatter(rawContent);

          const trustTierRaw = (meta.trust_tier as string) || 'unreviewed';
          const validTiers = new Set(['bundled', 'indexed', 'unreviewed', 'workspace']);
          const trustTier = validTiers.has(trustTierRaw) ? (trustTierRaw as SkillTrustTier) : 'unreviewed';

          const capsRaw = meta.caps;
          let caps: string[] = [];
          if (Array.isArray(capsRaw)) {
            caps = capsRaw as string[];
          } else if (typeof capsRaw === 'string' && capsRaw.length > 0) {
            caps = capsRaw.split(',').map((c: string) => c.trim()).filter(Boolean);
          }

          const installed: InstalledSkill = {
            id: (meta.id as string) || skillName,
            name: skillName,
            version: (meta.version as string) || '0.0.0',
            installedAt: new Date().toISOString(), // would need metadata file for exact value
            source: (meta.source as SkillInstallSource) || 'import',
            registryId: (meta.registryId as string) || undefined,
            trustTier,
            caps,
            enabled: true,
          };

          if (source && installed.source !== source) {
            continue;
          }

          skills.push(installed);
        } catch (err) {
          log.warn({ err, name: skillName }, 'failed to read installed skill');
        }
      }
    } catch (err) {
      log.warn({ err }, 'failed to list installed skills');
    }

    return skills;
  }

  /**
   * Uninstall a skill by removing its files.
   * @param name - Skill name to remove.
   * @returns True if removed, false if not found.
   */
  remove(name: string): boolean {
    if (isInstallDisabled()) {
      throw new Error('Skill removal is disabled via SUDO_SKILLS_INSTALL_DISABLE=1');
    }

    const { rmSync, existsSync } = require('node:fs');
    const { join } = require('node:path');
    const skillPath = join(process.cwd(), INSTALLED_SKILLS_DIR, name);

    if (!existsSync(skillPath)) {
      return false;
    }

    try {
      rmSync(skillPath, { recursive: true, force: true });
      log.info({ name }, 'skill removed');
      return true;
    } catch (err) {
      log.error({ err, name }, 'failed to remove skill');
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Parse YAML-style frontmatter from skill content. */
  private parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
    const lines = raw.split('\n');
    if (lines[0]?.trimEnd() !== '---') {
      return { meta: {}, body: raw };
    }
    const endIdx = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
    if (endIdx === -1) {
      return { meta: {}, body: raw };
    }

    const meta: Record<string, unknown> = {};
    for (const line of lines.slice(1, endIdx)) {
      const colonAt = line.indexOf(':');
      if (colonAt < 1) continue;
      const key = line.slice(0, colonAt).trim();
      const rawVal = line.slice(colonAt + 1).trim();
      if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        meta[key] = rawVal
          .slice(1, -1)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
      } else {
        meta[key] = rawVal;
      }
    }
    const body = lines.slice(endIdx + 1).join('\n').trimStart();
    return { meta, body };
  }

  /** Check if version change represents a breaking change (major bump). */
  private isBreakingChange(current: string, latest: string): boolean {
    const [currMajor] = current.split('.').map(Number);
    const [latMajor] = latest.split('.').map(Number);
    return (latMajor ?? 0) > (currMajor ?? 0);
  }
}
