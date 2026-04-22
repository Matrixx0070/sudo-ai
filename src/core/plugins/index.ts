/**
 * Plugin SDK — barrel export.
 *
 * Public surface of the SUDO-AI plugin system.
 * Import everything you need from this single entry point.
 */

export type {
  PluginCapability,
  PluginManifest,
  PluginContext,
  PluginModule,
  PluginState,
  PluginEntry,
} from './types.js';

export { PluginLoader } from './loader.js';
export { PluginManager } from './manager.js';
export { loadPluginsJson, savePluginsJson, PLUGINS_JSON } from './persistence.js';
export type { PersistedEntry, PluginsJson } from './persistence.js';

// Upgrade 43: MCP Server Registry
export {
  registerMcpServer,
  removeMcpServer,
  listMcpServers,
  getMcpServer,
  connectMcpServer,
  disconnectMcpServer,
  getConnectedServers,
} from './mcp-registry.js';
export type { McpServer } from './mcp-registry.js';

// Upgrade 69: Plugin Marketplace
export {
  registerPlugin,
  installPlugin,
  uninstallPlugin,
  getInstalled,
  getAvailable,
  searchPlugins,
  listAllPlugins,
} from './marketplace.js';
export type { MarketplacePlugin } from './marketplace.js';
