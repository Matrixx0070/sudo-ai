/**
 * @file marketplace.ts
 * @description Upgrade 69 — Plugin Marketplace Skeleton.
 *
 * Provides a registry of available plugins with install / uninstall / search
 * capabilities.  This is a skeleton: network fetching and signature
 * verification will be layered on in a future upgrade.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('plugins:marketplace');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketplacePlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  installed: boolean;
  tools?: string[];
  url?: string;
}

type PluginInput = Omit<MarketplacePlugin, 'id' | 'installed'>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const plugins: Map<string, MarketplacePlugin> = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveId(name: string): string {
  return `plugin-${name.toLowerCase().replace(/\s+/g, '-')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a plugin in the marketplace.
 * Re-registering by the same derived id overwrites the existing entry
 * while preserving its `installed` status.
 */
export function registerPlugin(plugin: PluginInput): MarketplacePlugin {
  if (!plugin.name)        throw new TypeError('plugin.name is required');
  if (!plugin.version)     throw new TypeError('plugin.version is required');
  if (!plugin.author)      throw new TypeError('plugin.author is required');
  if (!plugin.description) throw new TypeError('plugin.description is required');
  if (!plugin.category)    throw new TypeError('plugin.category is required');

  const id      = deriveId(plugin.name);
  const existing = plugins.get(id);
  const full: MarketplacePlugin = { ...plugin, id, installed: existing?.installed ?? false };

  plugins.set(id, full);
  log.info({ id, name: plugin.name }, 'Plugin registered');
  return { ...full };
}

/** Mark a plugin as installed. Returns false if the plugin does not exist. */
export function installPlugin(id: string): boolean {
  if (!id) throw new TypeError('id is required');
  const p = plugins.get(id);
  if (!p) { log.warn({ id }, 'installPlugin: unknown plugin'); return false; }
  p.installed = true;
  log.info({ id }, 'Plugin installed');
  return true;
}

/** Mark a plugin as not installed. Returns false if the plugin does not exist. */
export function uninstallPlugin(id: string): boolean {
  if (!id) throw new TypeError('id is required');
  const p = plugins.get(id);
  if (!p) { log.warn({ id }, 'uninstallPlugin: unknown plugin'); return false; }
  p.installed = false;
  log.info({ id }, 'Plugin uninstalled');
  return true;
}

/** All plugins that are currently installed. */
export function getInstalled(): MarketplacePlugin[] {
  return Array.from(plugins.values()).filter(p => p.installed).map(p => ({ ...p }));
}

/** All plugins that are NOT yet installed. */
export function getAvailable(): MarketplacePlugin[] {
  return Array.from(plugins.values()).filter(p => !p.installed).map(p => ({ ...p }));
}

/**
 * Full-text search across name, description, and category.
 * Case-insensitive.
 */
export function searchPlugins(query: string): MarketplacePlugin[] {
  if (typeof query !== 'string') throw new TypeError('query must be a string');
  const q = query.toLowerCase().trim();
  if (!q) return listAllPlugins();

  return Array.from(plugins.values())
    .filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q),
    )
    .map(p => ({ ...p }));
}

/** Return a copy of every registered plugin. */
export function listAllPlugins(): MarketplacePlugin[] {
  return Array.from(plugins.values()).map(p => ({ ...p }));
}
