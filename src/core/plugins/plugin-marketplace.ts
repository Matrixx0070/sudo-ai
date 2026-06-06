/**
 * @file plugin-marketplace.ts
 * @description Plugin Marketplace for SUDO-AI v4.
 *
 * Community plugin marketplace with search, install, uninstall, update,
 * featured/trending listings, statistics, and blocklist support.
 *
 * Modelled after SkillsMarketplace but extended for the plugin ecosystem:
 *   1. Search with filters (query, category, tags, author, source)
 *   2. Install from marketplace, URL, or GitHub
 *   3. Uninstall with cleanup of plugin files
 *   4. Update to latest version
 *   5. Blocklist for malicious or incompatible plugins
 *   6. Featured and trending plugins
 *   7. Marketplace statistics
 */

import { createLogger } from '../shared/logger.js';
import { genId, contentHash } from '../shared/utils.js';
import {
  type PluginManifest,
  type PluginCategory,
  type PluginSource,
  type PluginSourceInfo,
  PLUGIN_CATEGORIES,
  PluginState,
  validateManifest,
} from './plugin-manifest.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const log = createLogger('plugins:marketplace');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A marketplace plugin listing. */
export interface MarketplacePlugin {
  /** Unique marketplace listing ID. */
  id: string;
  /** The validated plugin manifest. */
  manifest: PluginManifest;
  /** Whether the plugin is currently installed locally. */
  installed: boolean;
  /** Download count. */
  downloads: number;
  /** Community rating (1-5). */
  rating: number;
  /** Number of ratings. */
  ratingCount: number;
  /** Whether this is a featured plugin. */
  featured: boolean;
  /** ISO 8601 timestamp of listing creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
}

/** A community rating for a plugin. */
export interface PluginRating {
  id: string;
  pluginId: string;
  userId: string;
  stars: number;
  review?: string;
  createdAt: string;
}

/** Search filters for the marketplace. */
export interface MarketplaceSearch {
  query?: string;
  category?: PluginCategory;
  tags?: string[];
  author?: string;
  source?: PluginSource;
  sortBy?: 'downloads' | 'rating' | 'recent' | 'name';
  limit?: number;
  offset?: number;
}

/** Marketplace configuration. */
export interface MarketplaceConfig {
  enabled: boolean;
  dataDir: string;
  maxPerPage: number;
  allowUploads: boolean;
  requireApproval: boolean;
  blocklist: string[];
}

const DEFAULT_CONFIG: Readonly<MarketplaceConfig> = {
  enabled: true,
  dataDir: 'data/plugin-marketplace',
  maxPerPage: 50,
  allowUploads: true,
  requireApproval: false,
  blocklist: [],
};

// ---------------------------------------------------------------------------
// PluginMarketplace
// ---------------------------------------------------------------------------

/**
 * Community plugin marketplace with search, install, update, and ratings.
 *
 * Provides the discovery and distribution layer for SUDO-AI plugins,
 * analogous to npm or VS Code Extensions Marketplace.
 *
 * @example
 * ```ts
 * const mp = new PluginMarketplace();
 * const results = mp.search({ query: 'database', category: 'database' });
 * const installed = mp.install(results[0].id);
 * ```
 */
export class PluginMarketplace {
  private readonly config: Readonly<MarketplaceConfig>;
  private readonly listings: Map<string, MarketplacePlugin> = new Map();
  private readonly ratings: Map<string, PluginRating[]> = new Map();
  private readonly downloadCounts: Map<string, number> = new Map();
  private featuredPluginId: string | null = null;

  constructor(config?: Partial<MarketplaceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    try {
      mkdirSync(this.config.dataDir, { recursive: true });
    } catch {
      log.warn({ dir: this.config.dataDir }, 'Cannot create marketplace data directory');
    }

    // Load persisted state on startup
    this._loadState();

    log.info(
      { enabled: this.config.enabled, listingCount: this.listings.size },
      'PluginMarketplace initialized',
    );
  }

  // -------------------------------------------------------------------------
  // Publish / Register
  // -------------------------------------------------------------------------

  /**
   * Publish a plugin to the marketplace.
   *
   * Validates the manifest, checks the blocklist, and creates a listing.
   *
   * @param manifest - The plugin manifest.
   * @param source - Source info for the listing.
   * @returns The created marketplace listing.
   * @throws Error if manifest is invalid or plugin is blocklisted.
   */
  publish(manifest: PluginManifest, source?: PluginSourceInfo): MarketplacePlugin {
    // Validate manifest
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Invalid manifest: ${validation.errors.join('; ')}`);
    }

    // Check blocklist
    if (this.isBlocklisted(manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is blocklisted and cannot be published`);
    }

    const id = genId();
    const listing: MarketplacePlugin = {
      id,
      manifest,
      installed: false,
      downloads: 0,
      rating: 0,
      ratingCount: 0,
      featured: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.listings.set(id, listing);

    // Persist listing to disk
    this._persistListing(listing);

    log.info({ id, name: manifest.name, version: manifest.version }, 'Plugin published to marketplace');
    return listing;
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Search the marketplace with filters.
   *
   * @param filters - Search criteria.
   * @returns Matching plugin listings, sorted and paginated.
   */
  search(filters: MarketplaceSearch): MarketplacePlugin[] {
    let results = Array.from(this.listings.values());

    // Exclude blocklisted
    results = results.filter((p) => !this.isBlocklisted(p.manifest.id));

    // Text search across name, description, author
    if (filters.query) {
      const q = filters.query.toLowerCase();
      results = results.filter(
        (p) =>
          p.manifest.name.toLowerCase().includes(q) ||
          p.manifest.description.toLowerCase().includes(q) ||
          p.manifest.author.toLowerCase().includes(q) ||
          p.manifest.skills.some((s) => s.name.toLowerCase().includes(q)),
      );
    }

    // Category filter
    if (filters.category) {
      results = results.filter((p) => p.manifest.category === filters.category);
    }

    // Author filter
    if (filters.author) {
      const a = filters.author.toLowerCase();
      results = results.filter((p) => p.manifest.author.toLowerCase().includes(a));
    }

    // Source filter
    if (filters.source) {
      results = results.filter((p) => p.manifest.source.type === filters.source);
    }

    // Tag filter
    if (filters.tags && filters.tags.length > 0) {
      results = results.filter((p) =>
        filters.tags!.some(
          (t) =>
            p.manifest.skills.some((s) => s.tags?.includes(t)) ||
            p.manifest.skills.some((s) => s.name.toLowerCase().includes(t.toLowerCase())),
        ),
      );
    }

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
        results.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
        break;
    }

    // Pagination
    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? this.config.maxPerPage, this.config.maxPerPage);
    return results.slice(offset, offset + limit);
  }

  // -------------------------------------------------------------------------
  // Install / Uninstall / Update
  // -------------------------------------------------------------------------

  /**
   * Install a plugin from the marketplace.
   *
   * Marks the plugin as installed and increments download count.
   * Returns the updated listing, or null if not found.
   *
   * @param listingId - Marketplace listing ID.
   * @returns Updated listing, or null.
   */
  install(listingId: string): MarketplacePlugin | null {
    const listing = this.listings.get(listingId);
    if (!listing) {
      log.warn({ listingId }, 'install: listing not found');
      return null;
    }

    if (this.isBlocklisted(listing.manifest.id)) {
      log.warn({ listingId, pluginId: listing.manifest.id }, 'install: plugin is blocklisted');
      return null;
    }

    listing.installed = true;
    listing.downloads++;
    this.downloadCounts.set(listingId, (this.downloadCounts.get(listingId) ?? 0) + 1);
    listing.updatedAt = new Date().toISOString();

    this._persistListing(listing);

    log.info({ listingId, name: listing.manifest.name }, 'Plugin installed from marketplace');
    return listing;
  }

  /**
   * Install a plugin from a URL or GitHub source.
   *
   * Creates a marketplace listing from the provided manifest and source
   * info, then marks it as installed.
   *
   * @param manifest - Plugin manifest from the external source.
   * @param source - Source provenance info.
   * @returns The created and installed listing.
   */
  installFromSource(manifest: PluginManifest, source: PluginSourceInfo): MarketplacePlugin {
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Invalid manifest: ${validation.errors.join('; ')}`);
    }

    if (this.isBlocklisted(manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is blocklisted`);
    }

    // Check if already published
    const existing = Array.from(this.listings.values()).find(
      (p) => p.manifest.id === manifest.id,
    );

    if (existing) {
      existing.installed = true;
      existing.downloads++;
      existing.updatedAt = new Date().toISOString();
      this._persistListing(existing);
      log.info({ pluginId: manifest.id }, 'Plugin from source already in marketplace — installed');
      return existing;
    }

    // Publish then install
    const listing = this.publish(manifest, source);
    listing.installed = true;
    listing.downloads++;
    listing.updatedAt = new Date().toISOString();
    this._persistListing(listing);

    log.info({ pluginId: manifest.id, sourceType: source.type }, 'Plugin installed from source');
    return listing;
  }

  /**
   * Uninstall a plugin from the marketplace.
   *
   * Marks the plugin as not installed. Optionally removes plugin files
   * from the data directory.
   *
   * @param listingId - Marketplace listing ID.
   * @param cleanup - Whether to remove plugin files from disk (default: true).
   * @returns True if the plugin was found and uninstalled.
   */
  uninstall(listingId: string, cleanup: boolean = true): boolean {
    const listing = this.listings.get(listingId);
    if (!listing) {
      log.warn({ listingId }, 'uninstall: listing not found');
      return false;
    }

    listing.installed = false;
    listing.updatedAt = new Date().toISOString();

    if (cleanup) {
      const pluginDir = join(this.config.dataDir, 'plugins', listingId);
      try {
        if (existsSync(pluginDir)) {
          rmSync(pluginDir, { recursive: true, force: true });
          log.debug({ pluginDir }, 'Plugin files cleaned up');
        }
      } catch (err) {
        log.warn({ pluginDir, err }, 'Failed to cleanup plugin files');
      }
    }

    this._persistListing(listing);

    log.info({ listingId, name: listing.manifest.name }, 'Plugin uninstalled');
    return true;
  }

  /**
   * Update a plugin to a new version.
   *
   * Replaces the manifest with the updated version and bumps updatedAt.
   *
   * @param listingId - Marketplace listing ID.
   * @param newManifest - Updated manifest.
   * @returns Updated listing, or null if not found.
   */
  update(listingId: string, newManifest: PluginManifest): MarketplacePlugin | null {
    const listing = this.listings.get(listingId);
    if (!listing) {
      log.warn({ listingId }, 'update: listing not found');
      return null;
    }

    const validation = validateManifest(newManifest);
    if (!validation.valid) {
      throw new Error(`Invalid updated manifest: ${validation.errors.join('; ')}`);
    }

    // Verify the plugin ID matches
    if (newManifest.id !== listing.manifest.id) {
      throw new Error(
        `Updated manifest has different plugin ID: "${newManifest.id}" vs "${listing.manifest.id}"`,
      );
    }

    // Check that version is actually newer
    if (newManifest.version === listing.manifest.version) {
      log.warn({ listingId, version: newManifest.version }, 'update: same version — no change');
      return listing;
    }

    listing.manifest = newManifest;
    listing.updatedAt = new Date().toISOString();
    this._persistListing(listing);

    log.info(
      { listingId, name: newManifest.name, version: newManifest.version },
      'Plugin updated',
    );
    return listing;
  }

  // -------------------------------------------------------------------------
  // Ratings
  // -------------------------------------------------------------------------

  /**
   * Rate a plugin.
   *
   * @param listingId - Marketplace listing ID.
   * @param userId - User ID of the rater.
   * @param stars - Rating from 1 to 5.
   * @param review - Optional review text.
   * @returns The created rating.
   */
  ratePlugin(listingId: string, userId: string, stars: number, review?: string): PluginRating {
    if (stars < 1 || stars > 5) throw new Error('Rating must be 1-5 stars');
    if (!userId) throw new Error('userId is required');

    const listing = this.listings.get(listingId);
    if (!listing) throw new Error(`Listing "${listingId}" not found`);

    const rating: PluginRating = {
      id: genId(),
      pluginId: listingId,
      userId,
      stars,
      review,
      createdAt: new Date().toISOString(),
    };

    if (!this.ratings.has(listingId)) {
      this.ratings.set(listingId, []);
    }
    this.ratings.get(listingId)!.push(rating);

    // Recalculate average rating
    const allRatings = this.ratings.get(listingId) ?? [];
    const avg = allRatings.reduce((s, r) => s + r.stars, 0) / allRatings.length;
    listing.rating = Math.round(avg * 10) / 10;
    listing.ratingCount = allRatings.length;

    log.info({ listingId, userId, stars }, 'Plugin rated');
    return rating;
  }

  // -------------------------------------------------------------------------
  // Featured / Trending
  // -------------------------------------------------------------------------

  /**
   * Set the featured plugin.
   */
  setFeatured(listingId: string): boolean {
    const listing = this.listings.get(listingId);
    if (!listing) return false;

    // Unfeature previous
    if (this.featuredPluginId) {
      const prev = this.listings.get(this.featuredPluginId);
      if (prev) prev.featured = false;
    }

    listing.featured = true;
    this.featuredPluginId = listingId;

    log.info({ listingId, name: listing.manifest.name }, 'Plugin featured');
    return true;
  }

  /**
   * Get the currently featured plugin.
   */
  getFeatured(): MarketplacePlugin | null {
    if (!this.featuredPluginId) return null;
    return this.listings.get(this.featuredPluginId) ?? null;
  }

  /**
   * Get trending plugins (most downloads, limited).
   */
  getTrending(limit: number = 10): MarketplacePlugin[] {
    return Array.from(this.listings.values())
      .filter((p) => !this.isBlocklisted(p.manifest.id))
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Get a specific listing by ID.
   */
  get(listingId: string): MarketplacePlugin | undefined {
    return this.listings.get(listingId);
  }

  /**
   * Get all installed plugins.
   */
  getInstalled(): MarketplacePlugin[] {
    return Array.from(this.listings.values()).filter((p) => p.installed);
  }

  /**
   * Get all available (not installed) plugins.
   */
  getAvailable(): MarketplacePlugin[] {
    return Array.from(this.listings.values()).filter((p) => !p.installed);
  }

  /**
   * Get all valid plugin categories.
   */
  getCategories(): PluginCategory[] {
    return [...PLUGIN_CATEGORIES];
  }

  // -------------------------------------------------------------------------
  // Blocklist
  // -------------------------------------------------------------------------

  /**
   * Check if a plugin ID is on the blocklist.
   */
  isBlocklisted(pluginId: string): boolean {
    return this.config.blocklist.includes(pluginId);
  }

  /**
   * Add a plugin ID to the blocklist.
   * If the plugin is currently installed, it will be uninstalled first.
   */
  blocklist(pluginId: string): boolean {
    if (this.config.blocklist.includes(pluginId)) return false;

    this.config.blocklist.push(pluginId);

    // Uninstall any installed instances of this plugin
    for (const [listingId, listing] of this.listings.entries()) {
      if (listing.manifest.id === pluginId && listing.installed) {
        this.uninstall(listingId, true);
      }
    }

    this._persistBlocklist();
    log.info({ pluginId }, 'Plugin added to blocklist');
    return true;
  }

  /**
   * Remove a plugin ID from the blocklist.
   */
  unblocklist(pluginId: string): boolean {
    const idx = this.config.blocklist.indexOf(pluginId);
    if (idx === -1) return false;

    this.config.blocklist.splice(idx, 1);
    this._persistBlocklist();
    log.info({ pluginId }, 'Plugin removed from blocklist');
    return true;
  }

  /**
   * Get the current blocklist.
   */
  getBlocklist(): string[] {
    return [...this.config.blocklist];
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  /**
   * Get marketplace statistics.
   */
  getStats(): {
    totalListings: number;
    totalInstalled: number;
    totalDownloads: number;
    totalRatings: number;
    byCategory: Record<string, number>;
    bySource: Record<string, number>;
    featuredPlugin: string | null;
  } {
    const byCategory: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let totalInstalled = 0;
    let totalDownloads = 0;
    let totalRatings = 0;

    for (const listing of this.listings.values()) {
      byCategory[listing.manifest.category] = (byCategory[listing.manifest.category] ?? 0) + 1;
      bySource[listing.manifest.source.type] = (bySource[listing.manifest.source.type] ?? 0) + 1;
      if (listing.installed) totalInstalled++;
      totalDownloads += listing.downloads;
      totalRatings += listing.ratingCount;
    }

    return {
      totalListings: this.listings.size,
      totalInstalled,
      totalDownloads,
      totalRatings,
      byCategory,
      bySource,
      featuredPlugin: this.featuredPluginId,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _persistListing(listing: MarketplacePlugin): void {
    const listingDir = join(this.config.dataDir, 'listings', listing.id);
    try {
      mkdirSync(listingDir, { recursive: true });
      writeFileSync(
        join(listingDir, 'listing.json'),
        JSON.stringify(listing, null, 2),
        'utf-8',
      );
    } catch (err) {
      log.warn({ listingId: listing.id, err }, 'Failed to persist listing');
    }
  }

  private _persistBlocklist(): void {
    try {
      mkdirSync(this.config.dataDir, { recursive: true });
      writeFileSync(
        join(this.config.dataDir, 'blocklist.json'),
        JSON.stringify(this.config.blocklist, null, 2),
        'utf-8',
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist blocklist');
    }
  }

  private _loadState(): void {
    // Load listings
    const listingsDir = join(this.config.dataDir, 'listings');
    if (existsSync(listingsDir)) {
      try {
        const dirs = readdirSync(listingsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

        for (const dir of dirs) {
          try {
            const raw = readFileSync(join(listingsDir, dir, 'listing.json'), 'utf-8');
            const listing = JSON.parse(raw) as MarketplacePlugin;
            this.listings.set(listing.id, listing);

            if (listing.featured) {
              this.featuredPluginId = listing.id;
            }
          } catch (err) {
            log.debug({ dir, err }, 'Failed to load listing');
          }
        }
      } catch (err) {
        log.warn({ err }, 'Failed to scan listings directory');
      }
    }

    // Load blocklist
    const blocklistPath = join(this.config.dataDir, 'blocklist.json');
    if (existsSync(blocklistPath)) {
      try {
        const raw = readFileSync(blocklistPath, 'utf-8');
        const list = JSON.parse(raw) as string[];
        for (const id of list) {
          if (!this.config.blocklist.includes(id)) {
            (this.config.blocklist as string[]).push(id);
          }
        }
      } catch (err) {
        log.warn({ err }, 'Failed to load blocklist');
      }
    }
  }
}