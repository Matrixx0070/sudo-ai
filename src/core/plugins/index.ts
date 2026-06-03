/**
 * Plugin SDK — barrel export.
 *
 * Public surface of the SUDO-AI plugin system.
 * Import everything you need from this single entry point.
 *
 * For plugin authors: import from './plugin-api.js' for the typed SDK.
 */

// Core types
export type {
  PluginCapability,
  PluginManifest,
  PluginContext,
  PluginModule,
  PluginLifecycle,
  PluginState,
  PluginEntry,
  PluginHookEvent,
  PluginHookHandler,
  PluginHookSubscription,
  PluginErrorCode,
  PluginErrorData,
} from './types.js';

// Plugin API (typed SDK for plugin authors)
export * from './plugin-api.js';

// Manager and Loader
export { PluginManager } from './manager.js';
export { PluginLoader } from './loader.js';

// Persistence
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
