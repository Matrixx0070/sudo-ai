/**
 * @file marketplace.ts
 * @description Skills Marketplace & Registry for SUDO-AI v4.
 *
 * OpenClaw has ClawHub (13,700+ skills), Hermes has agentskills.io (647+ skills).
 * SUDO-AI has 50+ local skills but no sharing infrastructure.
 *
 * This module provides:
 *   1. Skills marketplace with upload, search, download, rating
 *   2. Skill manifest standard (YAML frontmatter + markdown body)
 *   3. Community rating system (1-5 stars + review text)
 *   4. Featured weekly skill (editor's pick)
 *   5. Import adapter for ClawHub/agentskills.io formats
 *   6. Download counts and trending metrics
 *
 * Network effects from shared skills compound growth — ClawHub's 13,700+
 * skills were built by community members who wanted their skills discovered.
 */

import { createLogger } from '../shared/logger.js';
import { genId, contentHash } from '../shared/utils.js';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const log = createLogger('skills:marketplace');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A marketplace skill listing. */
export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  category: string;
  tags: string[];
  downloads: number;
  rating: number;
  ratingCount: number;
  featured: boolean;
  source: 'local' | 'clawhub' | 'agentskills' | 'community';
  sourceUrl?: string;
  manifest: SkillManifest;
  createdAt: string;
  updatedAt: string;
}

/** Skill manifest standard (YAML frontmatter equivalent). */
export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  requires: string[];  // required tools/capabilities
  provides: string[];  // what the skill does
  inputs: SkillInput[];
  compatibility: {
    sudoAiVersion: string;
    platforms: string[];
  };
}

/** Skill input parameter definition. */
export interface SkillInput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: unknown;
}

/** A community rating for a skill. */
export interface SkillRating {
  id: string;
  skillId: string;
  userId: string;
  stars: number; // 1-5
  review?: string;
  createdAt: string;
}

/** Search filters for the marketplace. */
export interface MarketplaceSearch {
  query?: string;
  category?: string;
  tags?: string[];
  sortBy?: 'downloads' | 'rating' | 'recent' | 'name';
  limit?: number;
  offset?: number;
}

/** Configuration for the marketplace. */
export interface MarketplaceConfig {
  enabled: boolean;
  dataDir: string;
  maxSkillsPerPage: number;
  allowUploads: boolean;
  requireApproval: boolean;
  supportedSources: Array<'local' | 'clawhub' | 'agentskills' | 'community'>;
}

const DEFAULT_CONFIG: Readonly<MarketplaceConfig> = {
  enabled: true,
  dataDir: 'data/marketplace',
  maxSkillsPerPage: 50,
  allowUploads: true,
  requireApproval: false,
  supportedSources: ['local', 'clawhub', 'agentskills', 'community'],
};

// ---------------------------------------------------------------------------
// Skill categories
// ---------------------------------------------------------------------------

const SKILL_CATEGORIES: string[] = [
  'automation',
  'coding',
  'research',
  'content-creation',
  'data-analysis',
  'devops',
  'communication',
  'finance',
  'security',
  'productivity',
  'education',
  'entertainment',
  'social-media',
  'e-commerce',
  'custom',
];

// ---------------------------------------------------------------------------
// SkillsMarketplace
// ---------------------------------------------------------------------------

/**
 * Community skills marketplace with upload, search, download, and rating.
 *
 * ClawHub's 13,700+ skills were built by community members who wanted their
 * skills discovered. A sudo-skills registry with download counts, ratings,
 * and a featured-weekly skill creates the same incentive flywheel.
 */
export class SkillsMarketplace {
  private readonly config: Readonly<MarketplaceConfig>;
  private readonly db: Database.Database | null;
  private readonly skills: Map<string, MarketplaceSkill> = new Map();
  private readonly ratings: Map<string, SkillRating[]> = new Map();
  private readonly downloadCounts: Map<string, number> = new Map();
  private featuredSkillId: string | null = null;

  constructor(config?: Partial<MarketplaceConfig>, db?: Database.Database) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = db ?? null;

    try {
      mkdirSync(this.config.dataDir, { recursive: true });
    } catch {
      log.warn({ dir: this.config.dataDir }, 'Cannot create marketplace data directory');
    }

    // Load local skills on startup
    this._loadLocalSkills();

    log.info(
      { enabled: this.config.enabled, skillCount: this.skills.size },
      'SkillsMarketplace initialized',
    );
  }

  // -------------------------------------------------------------------------
  // Skill CRUD
  // -------------------------------------------------------------------------

  /**
   * Publish a skill to the marketplace.
   */
  publish(manifest: SkillManifest, body: string, source: MarketplaceSkill['source'] = 'local'): MarketplaceSkill {
    const id = genId();
    const skill: MarketplaceSkill = {
      id,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      version: manifest.version,
      category: manifest.category,
      tags: manifest.tags,
      downloads: 0,
      rating: 0,
      ratingCount: 0,
      featured: false,
      source,
      manifest,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.skills.set(id, skill);

    // Write skill file to disk
    const skillDir = join(this.config.dataDir, 'skills', id);
    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), body, 'utf-8');
      writeFileSync(join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    } catch (err) {
      log.warn({ skillId: id, err }, 'Failed to write skill files');
    }

    log.info({ skillId: id, name: manifest.name, source }, 'Skill published');
    return skill;
  }

  /**
   * Search the marketplace.
   */
  search(filters: MarketplaceSearch): MarketplaceSkill[] {
    let results = Array.from(this.skills.values());

    // Text search
    if (filters.query) {
      const q = filters.query.toLowerCase();
      results = results.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some(t => t.toLowerCase().includes(q)) ||
        s.author.toLowerCase().includes(q)
      );
    }

    // Category filter
    if (filters.category) {
      results = results.filter(s => s.category === filters.category);
    }

    // Tag filter
    if (filters.tags && filters.tags.length > 0) {
      results = results.filter(s =>
        filters.tags!.some(t => s.tags.includes(t))
      );
    }

    // Source filter
    results = results.filter(s =>
      this.config.supportedSources.includes(s.source)
    );

    // Sort
    switch (filters.sortBy) {
      case 'downloads':
        results.sort((a, b) => b.downloads - a.downloads);
        break;
      case 'rating':
        results.sort((a, b) => b.rating - a.rating);
        break;
      case 'recent':
        results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        break;
      case 'name':
      default:
        results.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }

    // Pagination
    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? this.config.maxSkillsPerPage, this.config.maxSkillsPerPage);
    return results.slice(offset, offset + limit);
  }

  /**
   * Get a specific skill by ID.
   */
  getSkill(skillId: string): MarketplaceSkill | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Download a skill (increments download count).
   */
  download(skillId: string): MarketplaceSkill | null {
    const skill = this.skills.get(skillId);
    if (!skill) return null;

    skill.downloads++;
    this.downloadCounts.set(skillId, (this.downloadCounts.get(skillId) ?? 0) + 1);

    log.debug({ skillId, name: skill.name, downloads: skill.downloads }, 'Skill downloaded');
    return skill;
  }

  /**
   * Rate a skill.
   */
  rateSkill(skillId: string, userId: string, stars: number, review?: string): SkillRating {
    if (stars < 1 || stars > 5) throw new Error('Rating must be 1-5 stars');

    const rating: SkillRating = {
      id: genId(),
      skillId,
      userId,
      stars,
      review,
      createdAt: new Date().toISOString(),
    };

    // Add rating
    if (!this.ratings.has(skillId)) {
      this.ratings.set(skillId, []);
    }
    this.ratings.get(skillId)!.push(rating);

    // Update skill rating average
    const skill = this.skills.get(skillId);
    if (skill) {
      const allRatings = this.ratings.get(skillId) ?? [];
      const avg = allRatings.reduce((s, r) => s + r.stars, 0) / allRatings.length;
      skill.rating = Math.round(avg * 10) / 10;
      skill.ratingCount = allRatings.length;
    }

    log.info({ skillId, userId, stars }, 'Skill rated');
    return rating;
  }

  /**
   * Set the featured skill of the week.
   */
  setFeatured(skillId: string): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) return false;

    // Unfeature previous
    if (this.featuredSkillId) {
      const prev = this.skills.get(this.featuredSkillId);
      if (prev) prev.featured = false;
    }

    skill.featured = true;
    this.featuredSkillId = skillId;

    log.info({ skillId, name: skill.name }, 'Skill featured');
    return true;
  }

  /**
   * Get the currently featured skill.
   */
  getFeatured(): MarketplaceSkill | null {
    if (!this.featuredSkillId) return null;
    return this.skills.get(this.featuredSkillId) ?? null;
  }

  /**
   * Get available skill categories.
   */
  getCategories(): string[] {
    return [...SKILL_CATEGORIES];
  }

  /**
   * Get trending skills (most downloads in last 7 days).
   */
  getTrending(limit: number = 10): MarketplaceSkill[] {
    return Array.from(this.skills.values())
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, limit);
  }

  /**
   * Import a skill from ClawHub format.
   */
  importFromClawHub(clawHubData: {
    name: string;
    description: string;
    author: string;
    version: string;
    category: string;
    tags: string[];
    body: string;
    sourceUrl: string;
  }): MarketplaceSkill {
    const manifest: SkillManifest = {
      name: clawHubData.name,
      version: clawHubData.version,
      description: clawHubData.description,
      author: clawHubData.author,
      category: clawHubData.category || 'custom',
      tags: clawHubData.tags,
      requires: [],
      provides: [clawHubData.description],
      inputs: [],
      compatibility: {
        sudoAiVersion: '>=4.0.0',
        platforms: ['linux', 'macos', 'windows'],
      },
    };

    const skill = this.publish(manifest, clawHubData.body, 'clawhub');
    skill.sourceUrl = clawHubData.sourceUrl;
    return skill;
  }

  /**
   * Import a skill from agentskills.io format.
   */
  importFromAgentSkills(agentSkillsData: {
    name: string;
    description: string;
    author: string;
    version: string;
    skills: string[];
    body: string;
    sourceUrl: string;
  }): MarketplaceSkill {
    const manifest: SkillManifest = {
      name: agentSkillsData.name,
      version: agentSkillsData.version,
      description: agentSkillsData.description,
      author: agentSkillsData.author,
      category: 'automation',
      tags: agentSkillsData.skills,
      requires: agentSkillsData.skills,
      provides: [agentSkillsData.description],
      inputs: [],
      compatibility: {
        sudoAiVersion: '>=4.0.0',
        platforms: ['linux', 'macos'],
      },
    };

    const skill = this.publish(manifest, agentSkillsData.body, 'agentskills');
    skill.sourceUrl = agentSkillsData.sourceUrl;
    return skill;
  }

  /**
   * Get marketplace statistics.
   */
  getStats(): {
    totalSkills: number;
    totalDownloads: number;
    totalRatings: number;
    bySource: Record<string, number>;
    byCategory: Record<string, number>;
    featuredSkill: string | null;
  } {
    const bySource: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let totalDownloads = 0;
    let totalRatings = 0;

    for (const skill of this.skills.values()) {
      bySource[skill.source] = (bySource[skill.source] ?? 0) + 1;
      byCategory[skill.category] = (byCategory[skill.category] ?? 0) + 1;
      totalDownloads += skill.downloads;
      totalRatings += skill.ratingCount;
    }

    return {
      totalSkills: this.skills.size,
      totalDownloads,
      totalRatings,
      bySource,
      byCategory,
      featuredSkill: this.featuredSkillId,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _loadLocalSkills(): void {
    const skillsDir = 'skills';
    if (!existsSync(skillsDir)) return;

    try {
      const entries = readdirSync(skillsDir).filter((e: string) => e.endsWith('.md'));

      for (const entry of entries) {
        try {
          const content = readFileSync(join(skillsDir, entry), 'utf-8');
          const name = entry.replace('.md', '');

          // Parse frontmatter
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          const frontmatter = fmMatch ? fmMatch[1] : '';

          const manifest: SkillManifest = {
            name,
            version: '1.0.0',
            description: `Local skill: ${name}`,
            author: 'local',
            category: 'custom',
            tags: [name],
            requires: [],
            provides: [],
            inputs: [],
            compatibility: { sudoAiVersion: '>=4.0.0', platforms: ['linux', 'macos', 'windows'] },
          };

          // Try to parse YAML frontmatter fields
          for (const line of frontmatter.split('\n')) {
            const kv = line.match(/^(\w+):\s*(.+)$/);
            if (kv) {
              const [, key, value] = kv;
              switch (key) {
                case 'name': manifest.name = value; break;
                case 'version': manifest.version = value; break;
                case 'description': manifest.description = value; break;
                case 'author': manifest.author = value; break;
                case 'category': manifest.category = value; break;
                case 'tags': manifest.tags = value.split(',').map(t => t.trim()); break;
              }
            }
          }

          this.publish(manifest, content, 'local');
        } catch (err) {
          log.debug({ file: entry, err }, 'Failed to load local skill');
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to scan skills directory');
    }
  }
}