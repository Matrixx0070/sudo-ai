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
// NOTE: Full definition moved to "Plugin Context (expanded)" section below
// This stub remains for backward compatibility with existing PluginModule
// ---------------------------------------------------------------------------

/**
 * Runtime context injected into a plugin on activation.
 * Uses `unknown` to avoid circular imports — plugins cast to the concrete
 * types they need.
 * @deprecated Use the expanded PluginContext interface instead
 */
export interface PluginContextStub {
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
   * Optional install hook called before activate.
   */
  install?(ctx: PluginContext): Promise<void>;
  /**
   * Optional teardown hook called by the manager on deactivation or uninstall.
   * The plugin should release resources (open handles, intervals, etc.).
   */
  deactivate?(): Promise<void>;
  /**
   * Optional uninstall hook called when plugin is uninstalled.
   */
  uninstall?(): Promise<void>;
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

// ---------------------------------------------------------------------------
// Plugin Lifecycle Hooks
// ---------------------------------------------------------------------------

/**
 * Lifecycle hook event names that plugins can subscribe to.
 */
export type PluginHookEvent =
  | 'plugin:installed'
  | 'plugin:activated'
  | 'plugin:deactivated'
  | 'plugin:uninstalled'
  | 'tool:registered'
  | 'channel:registered'
  | 'provider:registered'
  | 'skill:registered'
  | 'session:start'
  | 'session:end'
  | 'tool:call:before'
  | 'tool:call:after';

/**
 * Handler function for a lifecycle hook.
 */
export type PluginHookHandler = (data: unknown) => void | Promise<void>;

/**
 * Subscription handle returned by onHook, allows cleanup.
 */
export interface PluginHookSubscription {
  /** Call to unsubscribe from the hook. */
  unsubscribe(): void;
  /** Check if subscription is still active. */
  readonly active: boolean;
}

// ---------------------------------------------------------------------------
// Plugin Context (expanded)
// ---------------------------------------------------------------------------

/**
 * Logger interface for plugin context.
 */
export interface PluginLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): PluginLogger;
}

/**
 * Runtime context injected into a plugin on activation.
 * Gives plugins access to core services and registration functions.
 */
export interface PluginContext {
  /** Plugin ID from manifest. */
  pluginId: string;
  /** Resolved plugin configuration object (keys from manifest.config). */
  config: Record<string, unknown>;
  /** Scoped pino logger for the plugin. */
  logger: PluginLogger;
  /** Register a tool from this plugin. Returns cleanup function. */
  registerTool(toolDef: unknown): () => void;
  /** Register a channel from this plugin. Returns cleanup function. */
  registerChannel(channelDef: unknown): () => void;
  /** Register an LLM provider from this plugin. Returns cleanup function. */
  registerProvider(providerDef: unknown): () => void;
  /** Register a skill from this plugin. Returns cleanup function. */
  registerSkill(skillDef: unknown): () => void;
  /** Subscribe to a lifecycle hook. Returns subscription handle. */
  onHook(event: PluginHookEvent, handler: PluginHookHandler): PluginHookSubscription;
}

// ---------------------------------------------------------------------------
// Plugin Lifecycle Interface
// ---------------------------------------------------------------------------

/**
 * Explicit lifecycle methods a plugin may implement.
 * Separated from PluginModule for clarity.
 */
export interface PluginLifecycle {
  /**
   * Called when plugin is activated.
   * Plugin should register tools, channels, providers, skills here.
   */
  install?(ctx: PluginContext): Promise<void>;
  /**
   * Called when plugin is activated.
   * Plugin should register tools, channels, providers, skills here.
   */
  activate?(ctx: PluginContext): Promise<void>;
  /**
   * Called when plugin is deactivated.
   * Plugin should cleanup resources, unsubscribe hooks, release handles.
   */
  deactivate?(): Promise<void>;
  /**
   * Called when plugin is uninstalled.
   * Plugin should remove all registrations and cleanup completely.
   */
  uninstall?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Plugin Error Types
// ---------------------------------------------------------------------------

/**
 * Error codes for plugin-related errors.
 */
export type PluginErrorCode =
  | 'plugin_not_found'
  | 'plugin_already_installed'
  | 'plugin_already_active'
  | 'plugin_not_active'
  | 'plugin_install_failed'
  | 'plugin_activation_failed'
  | 'plugin_deactivation_failed'
  | 'plugin_uninstall_failed'
  | 'plugin_manifest_invalid'
  | 'plugin_manifest_not_found'
  | 'plugin_manifest_parse_error'
  | 'plugin_import_failed'
  | 'plugin_invalid_module'
  | 'plugin_invalid_argument'
  | 'plugin_hook_failed'
  | 'plugin_registration_failed';

/**
 * Base error type for plugin errors.
 */
export interface PluginErrorData {
  code: PluginErrorCode;
  pluginId?: string;
  cause?: string;
  field?: string;
  missingField?: string;
  received?: string;
  value?: unknown;
}
