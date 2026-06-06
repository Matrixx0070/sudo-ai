/**
 * Plugin SDK — barrel export.
 *
 * Public surface of the SUDO-AI plugin system.
 * Import everything you need from this single entry point.
 */

// Legacy types & loader (original plugin system)
export type {
  PluginCapability,
  PluginManifest as LegacyPluginManifest,
  PluginContext as LegacyPluginContext,
  PluginModule as LegacyPluginModule,
  PluginState as LegacyPluginState,
  PluginEntry as LegacyPluginEntry,
} from './types.js';

export { PluginLoader as LegacyPluginLoader } from './loader.js';
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
  updateServerStatus,
  setServerTrustTier,
  setServerError,
  updateServerTools,
  getServerTools,
  getEnabledServerTools,
  setToolEnabled,
  getServerStatusSummary,
} from './mcp-registry.js';
export type { McpServer, McpTrustTier, McpTransport, McpServerStatus, McpTool, McpServerSummary } from './mcp-registry.js';

// Upgrade 69: Plugin Marketplace (legacy)
export {
  registerPlugin,
  installPlugin,
  uninstallPlugin,
  getInstalled as getInstalledLegacy,
  getAvailable as getAvailableLegacy,
  searchPlugins,
  listAllPlugins,
} from './marketplace.js';
export type { MarketplacePlugin as LegacyMarketplacePlugin } from './marketplace.js';

// ---------------------------------------------------------------------------
// New Plugin System + Marketplace
// ---------------------------------------------------------------------------

// Plugin manifest types and validation
export {
  PLUGIN_CATEGORIES,
  PluginState,
  validateManifest,
} from './plugin-manifest.js';

export type {
  PluginCategory,
  PluginSource,
  PluginSourceInfo,
  PluginHookDecl,
  PluginSkillDecl,
  PluginMcpServerDecl,
  PluginLspServerDecl,
  PluginManifest,
  ManifestValidationResult,
} from './plugin-manifest.js';

// PluginLoader (new)
export { PluginLoader } from './plugin-loader.js';
export type {
  PluginEntry,
  PluginModule as NewPluginModule,
  PluginContext as NewPluginContext,
  PluginLoaderConfig,
} from './plugin-loader.js';

// Plugin Marketplace (new)
export { PluginMarketplace } from './plugin-marketplace.js';
export type {
  MarketplacePlugin,
  PluginRating,
  MarketplaceSearch,
  MarketplaceConfig,
} from './plugin-marketplace.js';

// Plugin Hooks bridge
export {
  registerPluginHooks,
  unregisterPluginHooks,
  getPluginHookCount,
  hasPluginHooks,
} from './plugin-hooks.js';