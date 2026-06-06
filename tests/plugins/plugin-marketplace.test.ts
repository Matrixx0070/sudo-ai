/**
 * Unit tests for PluginMarketplace.
 *
 * Tests: publish, search, install, uninstall, update, ratings, featured,
 *        trending, blocklist, installFromSource, getInstalled, getAvailable,
 *        getCategories, getStats.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  PluginMarketplace,
  type MarketplacePlugin,
  type MarketplaceSearch,
  type MarketplaceConfig,
} from '../../src/core/plugins/plugin-marketplace.js';
import {
  type PluginManifest,
  type PluginCategory,
  type PluginSourceInfo,
} from '../../src/core/plugins/plugin-manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmpDir(): string {
  const dir = join(tmpdir(), `plugin-marketplace-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: `ai.sudo.plugin.${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'A test plugin for the marketplace',
    author: 'test-author',
    category: 'development',
    hooks: [],
    skills: [],
    mcpServers: [],
    lspServers: [],
    source: { type: 'local', path: '/tmp/test' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PluginMarketplace tests
// ---------------------------------------------------------------------------

describe('PluginMarketplace', () => {
  let dataDir: string;
  let marketplace: PluginMarketplace;

  beforeEach(() => {
    dataDir = mkTmpDir();
    marketplace = new PluginMarketplace({ dataDir, blocklist: [] });
  });

  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  it('publishes a valid plugin to the marketplace', () => {
    const manifest = makeManifest({ name: 'Pub Plugin' });
    const listing = marketplace.publish(manifest);

    expect(listing.id).toBeTruthy();
    expect(listing.manifest.name).toBe('Pub Plugin');
    expect(listing.installed).toBe(false);
    expect(listing.downloads).toBe(0);
    expect(listing.rating).toBe(0);
  });

  it('rejects publishing a plugin with invalid manifest', () => {
    const badManifest = makeManifest({ id: '' });
    expect(() => marketplace.publish(badManifest)).toThrow('Invalid manifest');
  });

  it('rejects publishing a blocklisted plugin', () => {
    const manifest = makeManifest({ id: 'blocked.plugin' });
    marketplace.blocklist('blocked.plugin');
    expect(() => marketplace.publish(manifest)).toThrow('blocklisted');
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  it('searches by text query across name, description, and author', () => {
    marketplace.publish(makeManifest({ name: 'Database Helper', description: 'Helps with databases' }));
    marketplace.publish(makeManifest({ name: 'Security Scanner', description: 'Scans for vulnerabilities', author: 'security-team' }));
    marketplace.publish(makeManifest({ name: 'Math Solver', description: 'Solves equations' }));

    const results = marketplace.search({ query: 'database' });
    expect(results.length).toBe(1);
    expect(results[0].manifest.name).toBe('Database Helper');
  });

  it('searches by author', () => {
    marketplace.publish(makeManifest({ name: 'Plugin A', author: 'alice' }));
    marketplace.publish(makeManifest({ name: 'Plugin B', author: 'bob' }));

    const results = marketplace.search({ author: 'alice' });
    expect(results.length).toBe(1);
    expect(results[0].manifest.author).toBe('alice');
  });

  it('searches by category', () => {
    marketplace.publish(makeManifest({ name: 'Dev Tool', category: 'development' }));
    marketplace.publish(makeManifest({ name: 'Math Tool', category: 'math' }));

    const results = marketplace.search({ category: 'math' });
    expect(results.length).toBe(1);
    expect(results[0].manifest.name).toBe('Math Tool');
  });

  it('searches by source type', () => {
    marketplace.publish(makeManifest({ name: 'Local', source: { type: 'local', path: '/tmp' } }));
    marketplace.publish(makeManifest({ name: 'Remote', source: { type: 'github', repo: 'org/repo' } }));

    const results = marketplace.search({ source: 'github' });
    expect(results.length).toBe(1);
    expect(results[0].manifest.name).toBe('Remote');
  });

  it('sorts results by downloads', () => {
    const a = marketplace.publish(makeManifest({ name: 'Popular' }));
    const b = marketplace.publish(makeManifest({ name: 'Unpopular' }));

    // Simulate downloads
    marketplace.install(a.id);
    marketplace.uninstall(a.id, false);
    marketplace.install(a.id);
    marketplace.uninstall(a.id, false);

    const results = marketplace.search({ sortBy: 'downloads' });
    expect(results[0].manifest.name).toBe('Popular');
  });

  it('paginates results', () => {
    for (let i = 0; i < 5; i++) {
      marketplace.publish(makeManifest({ name: `Plugin ${i}` }));
    }

    const page1 = marketplace.search({ limit: 2, offset: 0 });
    const page2 = marketplace.search({ limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it('excludes blocklisted plugins from search results', () => {
    const manifest = makeManifest({ id: 'bad.plugin', name: 'Bad Plugin' });
    marketplace.publish(manifest);
    marketplace.blocklist('bad.plugin');

    const results = marketplace.search({ query: 'Bad' });
    expect(results.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------

  it('installs a plugin from the marketplace', () => {
    const listing = marketplace.publish(makeManifest({ name: 'Installable' }));
    const result = marketplace.install(listing.id);

    expect(result).not.toBeNull();
    expect(result!.installed).toBe(true);
    expect(result!.downloads).toBe(1);
  });

  it('returns null when installing a non-existent listing', () => {
    const result = marketplace.install('nonexistent');
    expect(result).toBeNull();
  });

  it('refuses to install a blocklisted plugin', () => {
    const listing = marketplace.publish(makeManifest({ id: 'blocked.install' }));
    marketplace.blocklist('blocked.install');

    const result = marketplace.install(listing.id);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Install from source
  // -------------------------------------------------------------------------

  it('installs a plugin from a URL source', () => {
    const manifest = makeManifest({ id: 'url.plugin', name: 'URL Plugin' });
    const source: PluginSourceInfo = { type: 'url', url: 'https://example.com/plugin.tgz' };

    const result = marketplace.installFromSource(manifest, source);
    expect(result.installed).toBe(true);
    expect(result.manifest.id).toBe('url.plugin');
  });

  it('installs a plugin from a GitHub source', () => {
    const manifest = makeManifest({ id: 'github.plugin', name: 'GitHub Plugin' });
    const source: PluginSourceInfo = { type: 'github', repo: 'sudo-ai/example-plugin' };

    const result = marketplace.installFromSource(manifest, source);
    expect(result.installed).toBe(true);
  });

  it('reuses existing listing when installing from source for same plugin', () => {
    const manifest = makeManifest({ id: 'reuse.plugin' });
    marketplace.publish(manifest);

    const source: PluginSourceInfo = { type: 'local', path: '/tmp/test' };
    const result = marketplace.installFromSource(manifest, source);
    expect(result.installed).toBe(true);

    // Should not create a duplicate listing
    const stats = marketplace.getStats();
    const matching = Array.from(marketplace.search({})).filter(
      (p) => p.manifest.id === 'reuse.plugin',
    );
    expect(matching.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Uninstall
  // -------------------------------------------------------------------------

  it('uninstalls a plugin and marks it as not installed', () => {
    const listing = marketplace.publish(makeManifest({ name: 'Uninstallable' }));
    marketplace.install(listing.id);

    const result = marketplace.uninstall(listing.id);
    expect(result).toBe(true);

    const updated = marketplace.get(listing.id);
    expect(updated!.installed).toBe(false);
  });

  it('returns false when uninstalling a non-existent listing', () => {
    expect(marketplace.uninstall('nonexistent')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  it('updates a plugin to a new version', () => {
    const listing = marketplace.publish(makeManifest({ id: 'updatable.plugin', version: '1.0.0' }));

    const newManifest = makeManifest({ id: 'updatable.plugin', version: '2.0.0', name: 'Updated Plugin' });
    const updated = marketplace.update(listing.id, newManifest);

    expect(updated).not.toBeNull();
    expect(updated!.manifest.version).toBe('2.0.0');
    expect(updated!.manifest.name).toBe('Updated Plugin');
  });

  it('rejects updating with a different plugin ID', () => {
    const listing = marketplace.publish(makeManifest({ id: 'original.plugin' }));
    const newManifest = makeManifest({ id: 'different.plugin', version: '2.0.0' });

    expect(() => marketplace.update(listing.id, newManifest)).toThrow('different plugin ID');
  });

  it('returns the same listing when updating to the same version', () => {
    const manifest = makeManifest({ id: 'same.plugin', version: '1.0.0' });
    const listing = marketplace.publish(manifest);

    const result = marketplace.update(listing.id, manifest);
    expect(result!.manifest.version).toBe('1.0.0');
  });

  it('returns null when updating a non-existent listing', () => {
    const result = marketplace.update('nonexistent', makeManifest());
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Ratings
  // -------------------------------------------------------------------------

  it('rates a plugin and updates the average rating', () => {
    const listing = marketplace.publish(makeManifest({ name: 'Ratable' }));

    marketplace.ratePlugin(listing.id, 'user1', 4, 'Good plugin');
    marketplace.ratePlugin(listing.id, 'user2', 5, 'Excellent');

    const updated = marketplace.get(listing.id);
    expect(updated!.rating).toBe(4.5);
    expect(updated!.ratingCount).toBe(2);
  });

  it('rejects ratings outside 1-5 range', () => {
    const listing = marketplace.publish(makeManifest({ name: 'Bad Rate' }));
    expect(() => marketplace.ratePlugin(listing.id, 'user1', 0)).toThrow('1-5 stars');
    expect(() => marketplace.ratePlugin(listing.id, 'user1', 6)).toThrow('1-5 stars');
  });

  // -------------------------------------------------------------------------
  // Featured / Trending
  // -------------------------------------------------------------------------

  it('sets and gets a featured plugin', () => {
    const listing = marketplace.publish(makeManifest({ name: 'Featured' }));
    marketplace.setFeatured(listing.id);

    const featured = marketplace.getFeatured();
    expect(featured).not.toBeNull();
    expect(featured!.manifest.name).toBe('Featured');
  });

  it('replaces the previous featured plugin when setting a new one', () => {
    const a = marketplace.publish(makeManifest({ name: 'First' }));
    const b = marketplace.publish(makeManifest({ name: 'Second' }));

    marketplace.setFeatured(a.id);
    marketplace.setFeatured(b.id);

    const featured = marketplace.getFeatured();
    expect(featured!.manifest.name).toBe('Second');
    expect(marketplace.get(a.id)!.featured).toBe(false);
  });

  it('returns trending plugins sorted by downloads', () => {
    const popular = marketplace.publish(makeManifest({ name: 'Popular' }));
    const unpopular = marketplace.publish(makeManifest({ name: 'Unpopular' }));

    // Boost popular plugin downloads
    marketplace.install(popular.id);
    marketplace.uninstall(popular.id, false);
    marketplace.install(popular.id);
    marketplace.uninstall(popular.id, false);

    const trending = marketplace.getTrending(10);
    expect(trending[0].manifest.name).toBe('Popular');
  });

  // -------------------------------------------------------------------------
  // Blocklist
  // -------------------------------------------------------------------------

  it('adds a plugin to the blocklist', () => {
    const result = marketplace.blocklist('malicious.plugin');
    expect(result).toBe(true);
    expect(marketplace.isBlocklisted('malicious.plugin')).toBe(true);
  });

  it('uninstalls a blocklisted plugin that is currently installed', () => {
    const listing = marketplace.publish(makeManifest({ id: 'to-be-blocked' }));
    marketplace.install(listing.id);

    marketplace.blocklist('to-be-blocked');

    const updated = marketplace.get(listing.id);
    expect(updated!.installed).toBe(false);
  });

  it('removes a plugin from the blocklist', () => {
    marketplace.blocklist('removable.plugin');
    expect(marketplace.isBlocklisted('removable.plugin')).toBe(true);

    marketplace.unblocklist('removable.plugin');
    expect(marketplace.isBlocklisted('removable.plugin')).toBe(false);
  });

  it('returns false when adding an already blocklisted plugin', () => {
    marketplace.blocklist('dup.plugin');
    expect(marketplace.blocklist('dup.plugin')).toBe(false);
  });

  it('returns false when removing a non-blocklisted plugin', () => {
    expect(marketplace.unblocklist('not-blocked')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  it('returns all installed plugins', () => {
    const a = marketplace.publish(makeManifest({ name: 'Installed A' }));
    const b = marketplace.publish(makeManifest({ name: 'Installed B' }));
    marketplace.publish(makeManifest({ name: 'Not Installed' }));

    marketplace.install(a.id);
    marketplace.install(b.id);

    const installed = marketplace.getInstalled();
    expect(installed.length).toBe(2);
  });

  it('returns all available (not installed) plugins', () => {
    const a = marketplace.publish(makeManifest({ name: 'Avail A' }));
    marketplace.publish(makeManifest({ name: 'Avail B' }));

    marketplace.install(a.id);

    const available = marketplace.getAvailable();
    expect(available.length).toBe(1);
  });

  it('returns all valid categories', () => {
    const categories = marketplace.getCategories();
    expect(categories.length).toBe(10);
    expect(categories).toContain('development');
    expect(categories).toContain('security');
  });

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  it('computes marketplace statistics', () => {
    marketplace.publish(makeManifest({ name: 'Dev', category: 'development', source: { type: 'local', path: '/tmp' } }));
    marketplace.publish(makeManifest({ name: 'Sec', category: 'security', source: { type: 'github', repo: 'org/repo' } }));

    const a = marketplace.publish(makeManifest({ name: 'Installed One', category: 'development', source: { type: 'local', path: '/tmp' } }));
    marketplace.install(a.id);

    const stats = marketplace.getStats();
    expect(stats.totalListings).toBe(3);
    expect(stats.totalInstalled).toBe(1);
    expect(stats.byCategory['development']).toBe(2);
    expect(stats.bySource['local']).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  it('persists and reloads marketplace state', () => {
    const manifest = makeManifest({ name: 'Persistent Plugin' });
    marketplace.publish(manifest);

    // Create a new marketplace instance pointing to the same data dir
    const marketplace2 = new PluginMarketplace({ dataDir, blocklist: [] });

    // The listing should be loaded from disk
    const results = marketplace2.search({ query: 'Persistent' });
    expect(results.length).toBe(1);
    expect(results[0].manifest.name).toBe('Persistent Plugin');
  });
});