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
  PluginHookEvent,
  PluginHookHandler,
  PluginHookSubscription,
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
  private readonly hookSubscribers = new Map<PluginHookEvent, Set<{ id: string; handler: PluginHookHandler }>>();
  private readonly pluginRegistrations = new Map<string, Set<() => void>>();

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

    // Emit installation hook
    await this.emitHook('plugin:installed', { id });

    log.info({ id, version: module.manifest.version }, 'Plugin installed');
    return entry;
  }

  /**
   * Activate an installed or inactive plugin.
   * Calls plugin.install(ctx) if present, then plugin.activate(ctx).
   * Transitions state to 'active'.
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
    const ctx = this.getPluginContext(id);

    // Call install hook if present (for plugins that use full lifecycle)
    if (entry.module.install) {
      try {
        await entry.module.install(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        entry.state = 'error';
        entry.error = msg;
        await this.persist();
        log.error({ id, err }, 'Plugin install hook failed');
        throw new SudoError(`Plugin "${id}" install hook failed: ${msg}`, 'plugin_install_failed', { id, cause: msg });
      }
    }

    // Call activate hook if present
    if (entry.module.activate) {
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
    }

    entry.state = 'active';
    delete entry.error;
    await this.persist();

    // Emit activation hook to other plugins
    await this.emitHook('plugin:activated', { id });

    log.info({ id }, 'Plugin activated');
  }

  /**
   * Deactivate an active plugin.
   * Calls plugin.deactivate() if present, runs cleanup functions, transitions to 'inactive'.
   */
  async deactivate(id: string): Promise<void> {
    this.assertId(id);
    const entry = this.requireEntry(id);

    if (entry.state !== 'active') {
      log.warn({ id, state: entry.state }, 'Plugin is not active — skipping deactivate');
      return;
    }

    log.info({ id }, 'Deactivating plugin');

    // Call plugin's own deactivate hook
    if (entry.module?.deactivate) {
      try {
        await entry.module.deactivate();
      } catch (err) {
        log.warn({ id, err }, 'Plugin deactivate() threw — continuing anyway');
      }
    }

    // Run all registration cleanup functions
    const cleanups = this.pluginRegistrations.get(id);
    if (cleanups) {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch (err) {
          log.warn({ id, err }, 'Registration cleanup threw');
        }
      }
      cleanups.clear();
    }

    // Remove hook subscriptions for this plugin
    for (const [, subs] of this.hookSubscribers.entries()) {
      for (const sub of subs) {
        if (sub.id === id) {
          subs.delete(sub);
        }
      }
    }

    entry.state = 'inactive';
    await this.persist();

    // Emit deactivation hook
    await this.emitHook('plugin:deactivated', { id });

    log.info({ id }, 'Plugin deactivated');
  }

  /**
   * Uninstall a plugin. Deactivates first if active, calls uninstall hook, removes from registry.
   */
  async uninstall(id: string): Promise<void> {
    this.assertId(id);
    this.requireEntry(id);

    if (this.entries.get(id)?.state === 'active') {
      await this.deactivate(id);
    }

    const entry = this.entries.get(id);
    if (entry?.module?.uninstall) {
      try {
        await entry.module.uninstall();
      } catch (err) {
        log.warn({ id, err }, 'Plugin uninstall() threw — continuing anyway');
      }
    }

    // Final cleanup of any remaining registrations
    this.pluginRegistrations.delete(id);

    // Remove all hook subscriptions for this plugin
    for (const [, subs] of this.hookSubscribers.entries()) {
      for (const sub of subs) {
        if (sub.id === id) {
          subs.delete(sub);
        }
      }
    }

    this.entries.delete(id);
    this.pluginPaths.delete(id);
    await this.persist();

    // Emit uninstallation hook
    await this.emitHook('plugin:uninstalled', { id });

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

  /** Return only plugins that are currently in 'active' state. */
  listActive(): string[] {
    return Array.from(this.entries.values())
      .filter((e) => e.state === 'active')
      .map((e) => e.manifest.id);
  }

  /**
   * Build a PluginContext for a plugin.
   * Exposed for testing and for use by the plugin-api module.
   *
   * @param id - Plugin ID.
   * @returns Fully wired PluginContext.
   */
  getPluginContext(id: string): PluginContext {
    this.assertId(id);
    const entry = this.requireEntry(id);
    const pluginLog = (this.loggerRef as { child: (b: Record<string, unknown>) => unknown }).child({ plugin: id });

    const logger: import('./types.js').PluginLogger = {
      info: (obj: Record<string, unknown>, msg?: string) => (pluginLog as any).info(obj, msg),
      warn: (obj: Record<string, unknown>, msg?: string) => (pluginLog as any).warn(obj, msg),
      error: (obj: Record<string, unknown>, msg?: string) => (pluginLog as any).error(obj, msg),
      debug: (obj: Record<string, unknown>, msg?: string) => (pluginLog as any).debug(obj, msg),
      child: (bindings: Record<string, unknown>) => (pluginLog as any).child(bindings),
    };

    return {
      pluginId: id,
      config: this.normalizeConfig(entry, id),
      logger,
      registerTool: (toolDef: unknown) => this.createCleanup(id, 'tool', toolDef),
      registerChannel: (channelDef: unknown) => this.createCleanup(id, 'channel', channelDef),
      registerProvider: (providerDef: unknown) => this.createCleanup(id, 'provider', providerDef),
      registerSkill: (skillDef: unknown) => this.createCleanup(id, 'skill', skillDef),
      onHook: (event: PluginHookEvent, handler: PluginHookHandler) => this.subscribeHook(id, event, handler),
    };
  }

  /**
   * Emit a hook event to all subscribed handlers.
   * Called by the core system when lifecycle events occur.
   */
  async emitHook(event: PluginHookEvent, data: unknown): Promise<void> {
    const subscribers = this.hookSubscribers.get(event);
    if (!subscribers || subscribers.size === 0) return;

    const promises: Promise<void>[] = [];
    for (const sub of subscribers) {
      try {
        const result = sub.handler(data);
        if (result instanceof Promise) {
          promises.push(result.catch((err) => {
            log.warn({ pluginId: sub.id, event, err }, 'Hook handler threw');
          }));
        }
      } catch (err) {
        log.warn({ pluginId: sub.id, event, err }, 'Hook handler threw synchronously');
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /**
   * Get cleanup functions for a plugin (called on deactivate/uninstall).
   */
  private getPluginCleanups(id: string): Set<() => void> {
    return this.pluginRegistrations.get(id) ?? new Set();
  }

  /**
   * Create a cleanup function for a plugin registration.
   */
  private createCleanup(pluginId: string, kind: string, def: unknown): () => void {
    if (!this.pluginRegistrations.has(pluginId)) {
      this.pluginRegistrations.set(pluginId, new Set());
    }

    const cleanup = () => {
      log.debug({ pluginId, kind }, 'Plugin registration cleaned up');
    };

    this.pluginRegistrations.get(pluginId)!.add(cleanup);

    // Emit registration hook
    const hookEvent: PluginHookEvent = `${kind}:registered` as PluginHookEvent;
    this.emitHook(hookEvent, { pluginId, kind, def }).catch((err) => {
      log.warn({ pluginId, kind, err }, 'Registration hook failed');
    });

    return cleanup;
  }

  /**
   * Subscribe a plugin to a lifecycle hook.
   */
  private subscribeHook(pluginId: string, event: PluginHookEvent, handler: PluginHookHandler): PluginHookSubscription {
    if (!this.hookSubscribers.has(event)) {
      this.hookSubscribers.set(event, new Set());
    }

    const subscriber = { id: pluginId, handler };
    this.hookSubscribers.get(event)!.add(subscriber);

    return {
      active: true,
      unsubscribe: () => {
        const set = this.hookSubscribers.get(event);
        if (set) {
          set.delete(subscriber);
        }
        (this as any)._subscriptionActive = false;
      },
    };
  }

  /**
   * Normalize plugin config from manifest.config schema.
   */
  private normalizeConfig(entry: PluginEntry, id: string): Record<string, unknown> {
    const configSchema = entry.manifest.config ?? {};
    const appConfig = (this.config as Record<string, unknown>) ?? {};
    const result: Record<string, unknown> = {};

    for (const [key, schema] of Object.entries(configSchema)) {
      const cfg = schema as { required?: boolean; default?: unknown };
      if (key in appConfig) {
        result[key] = appConfig[key];
      } else if (cfg.default !== undefined) {
        result[key] = cfg.default;
      } else if (cfg.required) {
        log.warn({ pluginId: id, key }, 'Required config key missing');
      }
    }

    return result;
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
