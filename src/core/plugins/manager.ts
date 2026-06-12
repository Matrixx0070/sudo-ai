/**
 * PluginManager — lifecycle management for SUDO-AI plugins.
 *
 * Maintains an in-memory registry of PluginEntry objects backed by
 * data/plugins.json for persistence across restarts.
 *
 * Lifecycle: installed -> active -> inactive -> (uninstalled)
 *            installed -> error   (load or activation failure)
 */

import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { SudoError } from '../shared/errors.js';
import { PluginLoader } from './loader.js';
import { loadPluginsJson, savePluginsJson } from './persistence.js';
import type {
  PluginCapability,
  PluginEntry,
  PluginModule,
  PluginContext,
} from './types.js';

const log = createLogger('plugin:manager');

// ---------------------------------------------------------------------------
// PluginManager
// ---------------------------------------------------------------------------

/**
 * Central registry and lifecycle controller for plugins.
 *
 * Inject logger, toolRegistry, and config so the manager can build
 * PluginContext objects without importing those modules directly.
 */
export class PluginManager {
  private readonly entries = new Map<string, PluginEntry>();
  private readonly pluginPaths = new Map<string, string>();
  private readonly loader = new PluginLoader();

  /**
   * @param toolRegistry - The application tool registry (passed to plugin context).
   * @param config       - Full application config (passed to plugin context).
   * @param loggerRef    - Root pino logger instance (passed to plugin context).
   */
  constructor(
    private readonly toolRegistry: unknown,
    private readonly config: unknown,
    private readonly loggerRef: unknown,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Install a plugin from a directory path.
   * Loads the manifest + module, registers the entry as 'installed'.
   * Does NOT activate — call activate() separately.
   *
   * @param pluginPath - Absolute path to the plugin root directory.
   */
  async install(pluginPath: string): Promise<PluginEntry> {
    if (!pluginPath || typeof pluginPath !== 'string') {
      throw new SudoError('install: pluginPath must be a non-empty string', 'plugin_invalid_argument');
    }

    log.info({ pluginPath }, 'Installing plugin');

    let module: PluginModule;
    try {
      module = await this.loader.loadPlugin(pluginPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ pluginPath, err }, 'Plugin load failed during install');
      throw new SudoError(`Plugin install failed: ${msg}`, 'plugin_install_failed', { pluginPath, cause: msg });
    }

    const { id } = module.manifest;
    if (this.entries.has(id)) {
      throw new SudoError(
        `Plugin "${id}" is already installed. Uninstall it first.`,
        'plugin_already_installed',
        { id },
      );
    }

    const entry: PluginEntry = {
      manifest: module.manifest,
      state: 'installed',
      module,
      loadedAt: new Date().toISOString(),
    };

    this.entries.set(id, entry);
    this.pluginPaths.set(id, pluginPath);
    await this.persist();

    log.info({ id, version: module.manifest.version }, 'Plugin installed');
    return entry;
  }

  /**
   * Activate an installed or inactive plugin.
   * Calls plugin.activate(ctx) and transitions state to 'active'.
   */
  async activate(id: string): Promise<void> {
    this.assertId(id);
    const entry = this.requireEntry(id);

    if (entry.state === 'active') {
      log.warn({ id }, 'Plugin is already active — skipping');
      return;
    }
    if (entry.state === 'error') {
      throw new SudoError(
        `Cannot activate plugin "${id}" in error state. Reinstall first.`,
        'plugin_activate_error_state',
        { id },
      );
    }

    if (!entry.module) {
      entry.module = await this.reloadModule(id);
    }

    log.info({ id }, 'Activating plugin');
    const ctx = this.buildContext(id);

    try {
      await entry.module.activate(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.state = 'error';
      entry.error = msg;
      await this.persist();
      log.error({ id, err }, 'Plugin activation failed');
      throw new SudoError(`Plugin "${id}" activation failed: ${msg}`, 'plugin_activation_failed', { id, cause: msg });
    }

    entry.state = 'active';
    delete entry.error;
    await this.persist();
    log.info({ id }, 'Plugin activated');
  }

  /**
   * Deactivate an active plugin.
   * Calls plugin.deactivate() if present and transitions state to 'inactive'.
   */
  async deactivate(id: string): Promise<void> {
    this.assertId(id);
    const entry = this.requireEntry(id);

    if (entry.state !== 'active') {
      log.warn({ id, state: entry.state }, 'Plugin is not active — skipping deactivate');
      return;
    }

    log.info({ id }, 'Deactivating plugin');

    if (entry.module?.deactivate) {
      try {
        await entry.module.deactivate();
      } catch (err) {
        log.warn({ id, err }, 'Plugin deactivate() threw — continuing anyway');
      }
    }

    entry.state = 'inactive';
    await this.persist();
    log.info({ id }, 'Plugin deactivated');
  }

  /**
   * Uninstall a plugin. Deactivates first if active, then removes from registry.
   */
  async uninstall(id: string): Promise<void> {
    this.assertId(id);
    this.requireEntry(id);

    if (this.entries.get(id)?.state === 'active') {
      await this.deactivate(id);
    }

    this.entries.delete(id);
    this.pluginPaths.delete(id);
    await this.persist();
    log.info({ id }, 'Plugin uninstalled');
  }

  /** Return the PluginEntry for a given ID. Throws if not found. */
  getPlugin(id: string): PluginEntry {
    this.assertId(id);
    return this.requireEntry(id);
  }

  /** Return all registered plugin entries. */
  listPlugins(): PluginEntry[] {
    return Array.from(this.entries.values());
  }

  /** Return all plugins that declare the given capability. */
  listByCapability(cap: PluginCapability): PluginEntry[] {
    if (!cap) {
      throw new SudoError('listByCapability: cap must be non-empty', 'plugin_invalid_argument');
    }
    return this.listPlugins().filter((e) => e.manifest.capabilities.includes(cap));
  }

  /**
   * Restore persisted plugin registry from plugins.json.
   * Modules are not loaded here — they are loaded lazily on activate().
   *
   * @param pluginsBaseDir - Base directory for resolving relative plugin paths.
   */
  async loadPersistedState(pluginsBaseDir: string): Promise<void> {
    const state = await loadPluginsJson();
    if (!state) return;

    for (const p of state.plugins) {
      if (!p.id || !p.pluginPath) continue;
      const resolvedPath = path.isAbsolute(p.pluginPath)
        ? p.pluginPath
        : path.join(pluginsBaseDir, p.pluginPath);

      this.pluginPaths.set(p.id, resolvedPath);

      const stub: PluginEntry = {
        manifest: { id: p.id, name: p.id, version: '0.0.0', description: '', entryPoint: '', capabilities: [] },
        state: p.state === 'active' ? 'inactive' : (p.state ?? 'installed'),
        loadedAt: p.loadedAt,
        error: p.error,
      };
      this.entries.set(p.id, stub);
      log.debug({ id: p.id }, 'Restored plugin entry from persisted state');
    }

    log.info({ count: this.entries.size }, 'Persisted plugin state loaded');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private requireEntry(id: string): PluginEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new SudoError(`Plugin "${id}" is not registered`, 'plugin_not_found', { id });
    }
    return entry;
  }

  private assertId(id: string): void {
    if (!id || typeof id !== 'string') {
      throw new SudoError('Plugin id must be a non-empty string', 'plugin_invalid_argument', { id });
    }
  }

  private buildContext(id: string): PluginContext {
    const pluginLog = (this.loggerRef as { child: (b: Record<string, unknown>) => unknown }).child({ plugin: id });
    return { config: this.config, logger: pluginLog, toolRegistry: this.toolRegistry };
  }

  private async reloadModule(id: string): Promise<PluginModule> {
    const pluginPath = this.pluginPaths.get(id);
    if (!pluginPath) {
      throw new SudoError(`No plugin path recorded for "${id}" — cannot reload module`, 'plugin_path_missing', { id });
    }
    return this.loader.loadPlugin(pluginPath);
  }

  private async persist(): Promise<void> {
    const entries = Array.from(this.entries.entries()).map(([id, e]) => ({
      id,
      pluginPath: this.pluginPaths.get(id) ?? '',
      state: e.state,
      loadedAt: e.loadedAt,
      error: e.error,
    }));
    await savePluginsJson(entries);
  }
}
