/**
 * @file plugin-loader.ts
 * @description PluginLoader class for SUDO-AI v4.
 *
 * Discovers, validates, loads, and manages plugins from the .sudo-ai/plugins/
 * directory. Provides sandboxed execution, lifecycle management (load/enable/
 * disable/unload), dependency resolution, and state tracking.
 *
 * Responsibilities:
 *   1. Scan .sudo-ai/plugins/ for plugin subdirectories with manifest.json
 *   2. Validate manifests using validateManifest()
 *   3. Resolve plugin dependencies (topological order)
 *   4. Manage plugin lifecycle: load -> enable -> disable -> unload
 *   5. Track plugin state (uninstalled/installed/enabled/disabled/error)
 *   6. Provide sandboxed execution context for plugin code
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import {
  validateManifest,
  PluginState,
  type PluginManifest,
  type PluginCategory,
  type PluginHookDecl,
  type PluginSkillDecl,
  type PluginMcpServerDecl,
  type PluginLspServerDecl,
  type PluginSourceInfo,
  type ManifestValidationResult,
} from './plugin-manifest.js';
import { SudoError } from '../shared/errors.js';
import { readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'node:path';

const log = createLogger('plugin:loader');

// ---------------------------------------------------------------------------
// Plugin entry (runtime state)
// ---------------------------------------------------------------------------

/**
 * Runtime entry for a tracked plugin.
 * Extends the manifest with current state, load timestamp, and error info.
 */
export interface PluginEntry {
  /** Unique entry ID (nanoid). */
  entryId: string;
  /** The validated plugin manifest. */
  manifest: PluginManifest;
  /** Current lifecycle state. */
  state: PluginState;
  /** Absolute path to the plugin directory on disk. */
  pluginPath: string;
  /** ISO 8601 timestamp of when the plugin was loaded. */
  loadedAt?: string;
  /** Human-readable error message when state === Error. */
  error?: string;
  /** Manifest validation result (cached). */
  validation?: ManifestValidationResult;
  /** Reference to the loaded module (if entry point was imported). */
  module?: PluginModule;
}

/**
 * Shape that a plugin's entry-point ES module default export must satisfy.
 */
export interface PluginModule {
  /** Reference back to the manifest. */
  manifest: PluginManifest;
  /** Called when the plugin is enabled. */
  activate(ctx: PluginContext): Promise<void>;
  /** Called when the plugin is disabled. */
  deactivate?(): Promise<void>;
  /** Optional install hook. */
  install?(ctx: PluginContext): Promise<void>;
  /** Optional uninstall hook. */
  uninstall?(): Promise<void>;
}

/**
 * Runtime context injected into a plugin on activation.
 */
export interface PluginContext {
  /** Plugin ID from manifest. */
  pluginId: string;
  /** Resolved plugin configuration. */
  config: Record<string, unknown>;
  /** Scoped logger for the plugin. */
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    debug(obj: Record<string, unknown>, msg?: string): void;
  };
  /** Register a cleanup function (called on disable/unload). */
  onCleanup(fn: () => void): void;
}

// ---------------------------------------------------------------------------
// Loader configuration
// ---------------------------------------------------------------------------

/** Configuration for the PluginLoader. */
export interface PluginLoaderConfig {
  /** Whether the plugin system is enabled. */
  enabled: boolean;
  /** Root directory for plugin discovery. Defaults to '.sudo-ai/plugins'. */
  pluginsDir: string;
  /** Whether to auto-enable plugins after loading. */
  autoEnable: boolean;
  /** Maximum number of plugins allowed (safety limit). */
  maxPlugins: number;
  /** Timeout for plugin activation in milliseconds. */
  activationTimeout: number;
  /** Whether sandboxed execution is enforced. */
  sandbox: boolean;
}

const DEFAULT_CONFIG: Readonly<PluginLoaderConfig> = {
  enabled: true,
  pluginsDir: '.sudo-ai/plugins',
  autoEnable: false,
  maxPlugins: 100,
  activationTimeout: 30_000,
  sandbox: true,
};

// ---------------------------------------------------------------------------
// PluginLoader
// ---------------------------------------------------------------------------

/**
 * PluginLoader — discovers, loads, and manages SUDO-AI plugins.
 *
 * The loader scans a configured directory for plugin packages, validates
 * their manifests, resolves dependencies, and manages the plugin lifecycle
 * through load / enable / disable / unload transitions.
 *
 * @example
 * ```ts
 * const loader = new PluginLoader();
 * const discovered = await loader.scan();
 * for (const dir of discovered) {
 *   await loader.load(dir);
 * }
 * await loader.enable('ai.sudo.plugin.youtube');
 * ```
 */
export class PluginLoader {
  private readonly config: Readonly<PluginLoaderConfig>;
  private readonly entries: Map<string, PluginEntry> = new Map();
  private readonly cleanupFns: Map<string, Set<() => void>> = new Map();

  constructor(config?: Partial<PluginLoaderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.enabled) {
      try {
        mkdirSync(this.config.pluginsDir, { recursive: true });
      } catch {
        log.warn({ dir: this.config.pluginsDir }, 'Cannot create plugins directory');
      }
    }

    log.info(
      { enabled: this.config.enabled, pluginsDir: this.config.pluginsDir },
      'PluginLoader initialized',
    );
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Scan the plugins directory for subdirectories containing manifest.json.
   *
   * @returns Array of absolute plugin directory paths.
   */
  async scan(): Promise<string[]> {
    const dir = resolve(this.config.pluginsDir);
    if (!existsSync(dir)) {
      log.debug({ dir }, 'Plugins directory does not exist');
      return [];
    }

    let entries: string[];
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.isDirectory())
        .map((d) => join(dir, d.name));
    } catch (err) {
      log.warn({ dir, err }, 'Cannot read plugins directory');
      return [];
    }

    const pluginDirs: string[] = [];
    for (const entry of entries) {
      const manifestPath = join(entry, 'manifest.json');
      try {
        await readFile(manifestPath, 'utf8');
        pluginDirs.push(entry);
      } catch {
        // No manifest.json — skip.
      }
    }

    log.info({ dir, found: pluginDirs.length }, 'Plugin scan complete');
    return pluginDirs;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Load a plugin from a directory path.
   *
   * Steps:
   *  1. Read and parse manifest.json
   *  2. Validate manifest fields
   *  3. Register the plugin entry (state: Installed)
   *  4. Optionally auto-enable
   *
   * @param pluginPath - Absolute path to the plugin root directory.
   * @returns The PluginEntry for the loaded plugin.
   * @throws SudoError on validation or load failure.
   */
  async load(pluginPath: string): Promise<PluginEntry> {
    if (!pluginPath || typeof pluginPath !== 'string') {
      throw new SudoError('load: pluginPath must be a non-empty string', 'plugin_invalid_argument');
    }

    if (this.entries.size >= this.config.maxPlugins) {
      throw new SudoError(
        `Maximum plugin limit reached (${this.config.maxPlugins})`,
        'plugin_limit_reached',
      );
    }

    log.info({ pluginPath }, 'Loading plugin');

    // -- 1. Read manifest -----------------------------------------------------
    const manifestPath = join(pluginPath, 'manifest.json');
    let rawManifest: string;
    try {
      rawManifest = await readFile(manifestPath, 'utf8');
    } catch (err) {
      throw new SudoError(
        `Cannot read manifest.json at ${manifestPath}: ${String(err)}`,
        'plugin_manifest_not_found',
        { pluginPath, manifestPath },
      );
    }

    // -- 2. Parse manifest ----------------------------------------------------
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawManifest);
    } catch (err) {
      throw new SudoError(
        `Invalid JSON in manifest.json at ${manifestPath}: ${String(err)}`,
        'plugin_manifest_parse_error',
        { manifestPath },
      );
    }

    // -- 3. Validate manifest -------------------------------------------------
    const validation = validateManifest(parsed);
    if (!validation.valid) {
      throw new SudoError(
        `Manifest validation failed: ${validation.errors.join('; ')}`,
        'plugin_manifest_invalid',
        { pluginPath, errors: validation.errors },
      );
    }

    const manifest = parsed as PluginManifest;

    // -- 4. Check for duplicate ------------------------------------------------
    if (this.entries.has(manifest.id)) {
      throw new SudoError(
        `Plugin "${manifest.id}" is already loaded. Unload it first.`,
        'plugin_already_installed',
        { id: manifest.id },
      );
    }

    // -- 5. Create entry ------------------------------------------------------
    const entry: PluginEntry = {
      entryId: genId(),
      manifest,
      state: PluginState.Installed,
      pluginPath: resolve(pluginPath),
      loadedAt: new Date().toISOString(),
      validation,
    };

    this.entries.set(manifest.id, entry);
    this.cleanupFns.set(manifest.id, new Set());

    log.info(
      { id: manifest.id, version: manifest.version, category: manifest.category },
      'Plugin loaded',
    );

    // -- 6. Auto-enable if configured -----------------------------------------
    if (this.config.autoEnable) {
      try {
        await this.enable(manifest.id);
      } catch (err) {
        log.warn({ id: manifest.id, err }, 'Auto-enable failed');
      }
    }

    return entry;
  }

  // -------------------------------------------------------------------------
  // Lifecycle: enable / disable / unload
  // -------------------------------------------------------------------------

  /**
   * Enable a plugin (transition from Installed/Disabled -> Enabled).
   *
   * Resolves dependencies first — all dependency plugins must be enabled
   * before this plugin can be enabled.
   *
   * @param id - Plugin ID.
   */
  async enable(id: string): Promise<void> {
    this.assertId(id);
    const entry = this.requireEntry(id);

    if (entry.state === PluginState.Enabled) {
      log.warn({ id }, 'Plugin is already enabled — skipping');
      return;
    }

    if (entry.state === PluginState.Error) {
      throw new SudoError(
        `Cannot enable plugin "${id}" in error state. Reinstall first.`,
        'plugin_enable_error_state',
        { id },
      );
    }

    // -- Resolve dependencies -------------------------------------------------
    const deps = entry.manifest.dependencies ?? [];
    const unresolved = deps.filter((depId) => {
      const dep = this.entries.get(depId);
      return !dep || dep.state !== PluginState.Enabled;
    });

    if (unresolved.length > 0) {
      throw new SudoError(
        `Plugin "${id}" has unresolved dependencies: ${unresolved.join(', ')}`,
        'plugin_unresolved_deps',
        { id, unresolved },
      );
    }

    // -- Import and activate --------------------------------------------------
    try {
      const mod = await this.importModule(entry);
      entry.module = mod;

      const ctx = this.buildContext(entry);
      if (mod.install) {
        await mod.install(ctx);
      }
      await mod.activate(ctx);

      entry.state = PluginState.Enabled;
      delete entry.error;

      log.info({ id }, 'Plugin enabled');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.state = PluginState.Error;
      entry.error = msg;
      log.error({ id, err: msg }, 'Plugin enable failed');
      throw new SudoError(`Plugin "${id}" enable failed: ${msg}`, 'plugin_activation_failed', { id, cause: msg });
    }
  }

  /**
   * Disable a plugin (transition from Enabled -> Disabled).
   *
   * Runs all registered cleanup functions and calls plugin.deactivate().
   *
   * @param id - Plugin ID.
   */
  async disable(id: string): Promise<void> {
    this.assertId(id);
    const entry = this.requireEntry(id);

    if (entry.state !== PluginState.Enabled) {
      log.warn({ id, state: entry.state }, 'Plugin is not enabled — skipping disable');
      return;
    }

    log.info({ id }, 'Disabling plugin');

    // -- Run cleanup functions ------------------------------------------------
    const cleanups = this.cleanupFns.get(id);
    if (cleanups) {
      for (const fn of cleanups) {
        try {
          fn();
        } catch (err) {
          log.warn({ id, err }, 'Cleanup function threw');
        }
      }
      cleanups.clear();
    }

    // -- Call deactivate ------------------------------------------------------
    if (entry.module?.deactivate) {
      try {
        await entry.module.deactivate();
      } catch (err) {
        log.warn({ id, err }, 'Plugin deactivate() threw — continuing');
      }
    }

    entry.state = PluginState.Disabled;
    log.info({ id }, 'Plugin disabled');
  }

  /**
   * Unload a plugin (transition from any -> Uninstalled).
   *
   * Disables the plugin first if enabled, calls uninstall, removes the
   * entry from the registry.
   *
   * @param id - Plugin ID.
   */
  async unload(id: string): Promise<void> {
    this.assertId(id);
    const entry = this.requireEntry(id);

    // Disable first if enabled
    if (entry.state === PluginState.Enabled) {
      await this.disable(id);
    }

    // Call uninstall hook
    if (entry.module?.uninstall) {
      try {
        await entry.module.uninstall();
      } catch (err) {
        log.warn({ id, err }, 'Plugin uninstall() threw — continuing');
      }
    }

    // Clean up remaining references
    this.cleanupFns.delete(id);
    this.entries.delete(id);

    log.info({ id }, 'Plugin unloaded');
  }

  // -------------------------------------------------------------------------
  // Dependency resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve plugin dependencies and return plugins in topological order.
   *
   * Performs a depth-first topological sort over the dependency graph.
   * Throws if a circular dependency is detected.
   *
   * @param pluginIds - Optional list of plugin IDs to resolve. If omitted,
   *                    resolves all loaded plugins.
   * @returns Plugin IDs in dependency-safe order (dependencies first).
   * @throws SudoError on circular dependency.
   */
  resolveDependencies(pluginIds?: string[]): string[] {
    const ids = pluginIds ?? Array.from(this.entries.keys());
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new SudoError(
          `Circular dependency detected involving plugin "${id}"`,
          'plugin_circular_dep',
          { id },
        );
      }

      visiting.add(id);
      const entry = this.entries.get(id);
      if (entry) {
        const deps = entry.manifest.dependencies ?? [];
        for (const depId of deps) {
          visit(depId);
        }
      }
      visiting.delete(id);
      visited.add(id);
      order.push(id);
    };

    for (const id of ids) {
      visit(id);
    }

    log.debug({ order }, 'Dependency resolution complete');
    return order;
  }

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------

  /**
   * Get a plugin entry by ID.
   */
  get(id: string): PluginEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Get all plugin entries.
   */
  list(): PluginEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get all plugins in a specific state.
   */
  listByState(state: PluginState): PluginEntry[] {
    return this.list().filter((e) => e.state === state);
  }

  /**
   * Get all plugins in a specific category.
   */
  listByCategory(category: PluginCategory): PluginEntry[] {
    return this.list().filter((e) => e.manifest.category === category);
  }

  /**
   * Check whether a plugin is currently enabled.
   */
  isEnabled(id: string): boolean {
    return this.entries.get(id)?.state === PluginState.Enabled;
  }

  /**
   * Get the current state of a plugin.
   */
  getState(id: string): PluginState | undefined {
    return this.entries.get(id)?.state;
  }

  /**
   * Get the total number of tracked plugins.
   */
  get size(): number {
    return this.entries.size;
  }

  // -------------------------------------------------------------------------
  // Batch operations
  // -------------------------------------------------------------------------

  /**
   * Load all discoverable plugins from the plugins directory.
   *
   * Skips plugins that fail validation (logs warnings).
   * Resolves dependencies and enables plugins in topological order
   * if autoEnable is true.
   *
   * @returns Array of successfully loaded plugin entries.
   */
  async loadAll(): Promise<PluginEntry[]> {
    const dirs = await this.scan();
    const loaded: PluginEntry[] = [];

    for (const dir of dirs) {
      try {
        const entry = await this.load(dir);
        loaded.push(entry);
      } catch (err) {
        log.warn({ dir, err }, 'Failed to load plugin — skipping');
      }
    }

    // Resolve dependencies and enable in order
    if (this.config.autoEnable && loaded.length > 0) {
      const order = this.resolveDependencies(loaded.map((e) => e.manifest.id));
      for (const id of order) {
        try {
          await this.enable(id);
        } catch (err) {
          log.warn({ id, err }, 'Failed to enable plugin during loadAll');
        }
      }
    }

    log.info({ total: loaded.length }, 'loadAll complete');
    return loaded;
  }

  /**
   * Disable all enabled plugins in reverse dependency order.
   */
  async disableAll(): Promise<void> {
    const enabled = this.listByState(PluginState.Enabled);
    const order = this.resolveDependencies(enabled.map((e) => e.manifest.id));
    // Disable in reverse topological order (dependents first)
    const reversed = [...order].reverse();

    for (const id of reversed) {
      try {
        await this.disable(id);
      } catch (err) {
        log.warn({ id, err }, 'Failed to disable plugin during disableAll');
      }
    }

    log.info('All plugins disabled');
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Save current plugin state to disk for recovery on restart.
   */
  saveState(): void {
    const statePath = join(this.config.pluginsDir, 'plugin-state.json');
    const data = this.list().map((e) => ({
      id: e.manifest.id,
      pluginPath: e.pluginPath,
      state: e.state,
      loadedAt: e.loadedAt,
      error: e.error,
    }));

    try {
      mkdirSync(this.config.pluginsDir, { recursive: true });
      writeFileSync(statePath, JSON.stringify(data, null, 2), 'utf-8');
      log.debug({ path: statePath, count: data.length }, 'Plugin state saved');
    } catch (err) {
      log.warn({ err }, 'Failed to save plugin state');
    }
  }

  /**
   * Load previously saved plugin state from disk.
   * Plugins are registered as Installed (not Enabled); call enable()
   * to activate them.
   *
   * @returns Number of plugins restored.
   */
  async loadState(): Promise<number> {
    const statePath = join(this.config.pluginsDir, 'plugin-state.json');
    if (!existsSync(statePath)) return 0;

    try {
      const raw = readFileSync(statePath, 'utf-8');
      const data = JSON.parse(raw) as Array<{
        id: string;
        pluginPath: string;
        state: string;
        loadedAt?: string;
        error?: string;
      }>;

      let restored = 0;
      for (const item of data) {
        if (!item.id || !item.pluginPath) continue;
        if (this.entries.has(item.id)) continue;

        // Only restore if the plugin directory still exists
        if (!existsSync(item.pluginPath)) {
          log.warn({ id: item.id, path: item.pluginPath }, 'Plugin directory gone — skipping');
          continue;
        }

        try {
          const entry = await this.load(item.pluginPath);
          // Override state to what was persisted (except Error -> Installed)
          if (item.state === PluginState.Enabled) {
            entry.state = PluginState.Installed; // Will need re-enable
          } else if (item.state === PluginState.Disabled) {
            entry.state = PluginState.Disabled;
          }
          entry.loadedAt = item.loadedAt ?? entry.loadedAt;
          if (item.error) entry.error = item.error;
          restored++;
        } catch (err) {
          log.warn({ id: item.id, err }, 'Failed to restore plugin');
        }
      }

      log.info({ restored }, 'Plugin state restored');
      return restored;
    } catch (err) {
      log.warn({ err }, 'Failed to load plugin state');
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private assertId(id: string): void {
    if (!id || typeof id !== 'string') {
      throw new SudoError('Plugin ID must be a non-empty string', 'plugin_invalid_argument', { id });
    }
  }

  private requireEntry(id: string): PluginEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new SudoError(`Plugin "${id}" is not registered`, 'plugin_not_found', { id });
    }
    return entry;
  }

  /**
   * Import the plugin's entry point module.
   * In sandbox mode, validates the import before allowing it.
   */
  private async importModule(entry: PluginEntry): Promise<PluginModule> {
    const entryPoint = entry.manifest.entryPoint ?? 'index.js';
    const entryPointPath = resolve(entry.pluginPath, entryPoint);

    if (this.config.sandbox && !existsSync(entryPointPath)) {
      throw new SudoError(
        `Plugin entry point not found: ${entryPointPath}`,
        'plugin_import_failed',
        { id: entry.manifest.id, entryPointPath },
      );
    }

    let mod: unknown;
    try {
      mod = await import(entryPointPath);
    } catch (err) {
      throw new SudoError(
        `Failed to import plugin entry point ${entryPointPath}: ${String(err)}`,
        'plugin_import_failed',
        { id: entry.manifest.id, entryPointPath },
      );
    }

    // Extract the module from various export shapes
    const candidates = [
      (mod as Record<string, unknown>)['default'],
      (mod as Record<string, unknown>)['plugin'],
      mod,
    ];

    for (const candidate of candidates) {
      if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const obj = candidate as Record<string, unknown>;
        if (typeof obj['activate'] === 'function') {
          if (!obj['manifest']) {
            obj['manifest'] = entry.manifest;
          }
          return obj as unknown as PluginModule;
        }
      }
    }

    throw new SudoError(
      `Plugin entry point does not export a valid PluginModule (missing "activate" function)`,
      'plugin_invalid_module',
      { id: entry.manifest.id },
    );
  }

  /**
   * Build a PluginContext for the given entry.
   */
  private buildContext(entry: PluginEntry): PluginContext {
    const pluginLog = log.child({ plugin: entry.manifest.id });

    return {
      pluginId: entry.manifest.id,
      config: this.resolveConfig(entry),
      logger: {
        info: (obj: Record<string, unknown>, msg?: string) => pluginLog.info(obj, msg),
        warn: (obj: Record<string, unknown>, msg?: string) => pluginLog.warn(obj, msg),
        error: (obj: Record<string, unknown>, msg?: string) => pluginLog.error(obj, msg),
        debug: (obj: Record<string, unknown>, msg?: string) => pluginLog.debug(obj, msg),
      },
      onCleanup: (fn: () => void) => {
        const cleanups = this.cleanupFns.get(entry.manifest.id);
        if (cleanups) cleanups.add(fn);
      },
    };
  }

  /**
   * Resolve plugin configuration from manifest.config schema.
   */
  private resolveConfig(entry: PluginEntry): Record<string, unknown> {
    const configSchema = entry.manifest.config ?? {};
    const result: Record<string, unknown> = {};

    for (const [key, schema] of Object.entries(configSchema)) {
      if (schema.default !== undefined) {
        result[key] = schema.default;
      }
    }

    return result;
  }
}