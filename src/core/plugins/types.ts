/**
 * Type definitions for the SUDO-AI Plugin SDK.
 *
 * A plugin is a self-contained package that extends SUDO-AI with new tools,
 * channels, providers, memory adapters, middleware, or skills.
 * Each plugin ships a `manifest.json` and an ES-module entry point that
 * exports a conforming {@link PluginModule}.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Functional categories a plugin may declare.
 * A plugin may declare multiple capabilities.
 */
export type PluginCapability =
  | 'tools'
  | 'channel'
  | 'provider'
  | 'memory'
  | 'middleware'
  | 'skill';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Schema of the `manifest.json` file that every plugin must ship.
 * Validated by {@link PluginLoader} before the entry point is imported.
 */
export interface PluginManifest {
  /** Globally unique reverse-DNS plugin identifier, e.g. `"ai.sudo.plugin.youtube"`. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /**
   * Semantic version string, e.g. `"1.0.0"`.
   * Must match `/^\d+\.\d+\.\d+$/`.
   */
  version: string;
  /** Short description shown in plugin listings. */
  description: string;
  /** Optional author string or email. */
  author?: string;
  /**
   * Path to the ES-module entry point, relative to the plugin root directory.
   * Typically `"dist/index.js"` or `"index.js"`.
   */
  entryPoint: string;
  /** One or more capability tags. Must contain at least one entry. */
  capabilities: PluginCapability[];
  /**
   * Declared configuration keys that the plugin reads from its context.
   * The manager validates that all `required` keys are present before activation.
   */
  config?: Record<
    string,
    {
      type: string;
      description: string;
      required?: boolean;
      default?: unknown;
    }
  >;
}

// ---------------------------------------------------------------------------
// Plugin context (passed to activate)
// ---------------------------------------------------------------------------

/**
 * Runtime context injected into a plugin on activation.
 * Uses `unknown` to avoid circular imports — plugins cast to the concrete
 * types they need.
 */
export interface PluginContext {
  /** Resolved plugin configuration object (keys from manifest.config). */
  config: unknown;
  /** Scoped pino logger for the plugin. */
  logger: unknown;
  /** The tool registry so plugins can register new tools. */
  toolRegistry: unknown;
}

// ---------------------------------------------------------------------------
// Plugin module (entry-point export contract)
// ---------------------------------------------------------------------------

/**
 * The shape that a plugin's entry-point ES module default export must satisfy.
 */
export interface PluginModule {
  /** Reference back to the manifest (may be the parsed manifest.json). */
  manifest: PluginManifest;
  /**
   * Called by the manager when the plugin is activated.
   * The plugin should register tools / channels / etc. here.
   */
  activate(ctx: PluginContext): Promise<void>;
  /**
   * Optional teardown hook called by the manager on deactivation or uninstall.
   * The plugin should release resources (open handles, intervals, etc.).
   */
  deactivate?(): Promise<void>;
  /**
   * Optionally return tool definitions contributed by this plugin.
   * Used by the manager to enumerate plugin-provided tools.
   */
  getTools?(): unknown[];
}

// ---------------------------------------------------------------------------
// Plugin registry state
// ---------------------------------------------------------------------------

/** Lifecycle state of a registered plugin. */
export type PluginState = 'installed' | 'active' | 'inactive' | 'error';

/**
 * Full registry entry for a plugin, including runtime state and optional
 * reference to the loaded module.
 */
export interface PluginEntry {
  manifest: PluginManifest;
  state: PluginState;
  /** Populated once the entry point has been successfully imported. */
  module?: PluginModule;
  /** Human-readable error message when state === 'error'. */
  error?: string;
  /** ISO 8601 timestamp of when the plugin was loaded. */
  loadedAt?: string;
}
