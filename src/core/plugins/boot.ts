/**
 * @file boot.ts
 * @description Boot-time wiring for the manifest-first plugin SDK.
 *
 * bootPlugins() is the single entry point cli.ts calls when SUDO_PLUGINS=1:
 * it scans the plugins directory, loads every manifest-valid plugin, enables
 * them in dependency order, and bridges each enabled plugin's manifest hook
 * declarations onto the running HookManager via registerPluginHooks().
 *
 * The PluginLoader itself never touches the HookManager — that bridge lives
 * here so the loader stays usable without a hook system (tests, tooling).
 *
 * Failure isolation: a plugin that fails to load or enable is skipped with a
 * warning; it never aborts the boot of other plugins or the host process.
 */

import { existsSync } from 'fs';
import { join } from 'node:path';
import { PluginLoader, type PluginEntry } from './plugin-loader.js';
import { PluginState } from './plugin-manifest.js';
import { registerPluginHooks, unregisterPluginHooks } from './plugin-hooks.js';
import { registerMcpServer } from './mcp-registry.js';
import { buildStdioMcpUrl } from './claude-compat.js';
import type { HookManager } from '../hooks/index.js';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';

const log = createLogger('plugin:boot');

export interface PluginBootResult {
  /** The loader instance — keep it for shutdownPlugins() and runtime queries. */
  loader: PluginLoader;
  /** Plugins whose manifests validated and loaded. */
  loaded: number;
  /** Plugins successfully enabled (activate() ran). */
  enabled: number;
  /** Manifest hooks bridged onto the HookManager. */
  hooksRegistered: number;
  /** Plugin `skills/` dirs appended to SUDO_SKILLS_DIRS. */
  skillRootsAdded: number;
  /** Manifest-declared MCP servers registered into the MCP registry. */
  mcpServersRegistered: number;
}

/**
 * Bridge a plugin manifest's `skills[]` and `mcpServers[]` declarations onto
 * the already-live loaders (Phase 0 of the capability bridge). Previously the
 * manifest validated these and the runtime ignored them.
 *
 * - Skills: the manifest carries skill *metadata*; the markdown lives in the
 *   plugin's own `skills/` dir, which we append to SUDO_SKILLS_DIRS (same
 *   mechanism the Claude/Cursor ingester uses) so the live markdown-loader
 *   picks them up. Runs before the skills loader reads the env at boot.
 * - MCP servers: each declared stdio server is registered at trust tier
 *   `unreviewed` — tracked, NOT auto-connected (same posture as claude-compat).
 *
 * No plugin code executes here; this is pure declaration → registry wiring.
 * Exported for testing.
 */
export function wirePluginManifestCapabilities(
  entry: PluginEntry,
): { skillRootAdded: string | null; mcpRegistered: number } {
  const manifest = entry.manifest;
  let skillRootAdded: string | null = null;
  let mcpRegistered = 0;

  if (manifest.skills?.length) {
    const skillsDir = join(entry.pluginPath, 'skills');
    if (existsSync(skillsDir)) {
      const existing = (process.env['SUDO_SKILLS_DIRS'] ?? '')
        .split(':').map((s) => s.trim()).filter(Boolean);
      if (!existing.includes(skillsDir)) {
        process.env['SUDO_SKILLS_DIRS'] = [...existing, skillsDir].join(':');
        skillRootAdded = skillsDir;
      }
    } else {
      log.warn(
        { id: manifest.id, skillsDir },
        'Plugin declares skills but has no skills/ directory — skipping skill wiring',
      );
    }
  }

  for (const mcp of manifest.mcpServers ?? []) {
    if (!mcp.command) continue;
    if (mcp.env || mcp.cwd) {
      // Phase 0 encodes only command+args into the registry's stdio: URL. env/cwd
      // are accepted by the manifest schema but not yet applied (they land when
      // Phase 1 actually launches the server) — warn so authors aren't surprised.
      log.warn(
        { id: manifest.id, mcpId: mcp.id },
        'Plugin mcpServer declares env/cwd — not applied in Phase 0 (command+args only)',
      );
    }
    try {
      registerMcpServer(
        `${manifest.id}:${mcp.id}`,
        buildStdioMcpUrl(mcp.command, mcp.args),
        `MCP server from plugin ${manifest.id}`,
        'unreviewed',
        'stdio',
      );
      mcpRegistered++;
    } catch (err) {
      log.warn(
        { id: manifest.id, mcpId: mcp.id, err: String(err) },
        'Plugin MCP server registration failed — skipping',
      );
    }
  }

  return { skillRootAdded, mcpRegistered };
}

/**
 * Discover, load, and enable all plugins, bridging their manifest hooks
 * onto the given HookManager.
 *
 * @param hookManager - The running HookManager instance from boot.
 * @param pluginsDir - Plugin root directory. Defaults to `DATA_DIR/plugins`.
 */
export async function bootPlugins(
  hookManager: HookManager,
  pluginsDir: string = dataPath('plugins'),
): Promise<PluginBootResult> {
  const loader = new PluginLoader({ pluginsDir, autoEnable: false });
  const entries = await loader.loadAll();

  let enabled = 0;
  let hooksRegistered = 0;
  let skillRootsAdded = 0;
  let mcpServersRegistered = 0;

  if (entries.length > 0) {
    // Surface dependencies that never loaded (e.g. failed manifest validation)
    // so the operator knows why dependents below will fail to enable.
    const loadedIds = new Set(entries.map((e) => e.manifest.id));
    for (const entry of entries) {
      for (const dep of entry.manifest.dependencies ?? []) {
        if (!loadedIds.has(dep)) {
          log.warn(
            { id: entry.manifest.id, missingDependency: dep },
            'Plugin declares a dependency that did not load — plugin will not enable',
          );
        }
      }
    }

    const order = loader.resolveDependencies(entries.map((e) => e.manifest.id));
    for (const id of order) {
      try {
        await loader.enable(id);
        enabled++;
        const entry = loader.get(id);
        if (entry?.module) {
          // The plugin module's own exports back any function-type hooks.
          const moduleFns = entry.module as unknown as Record<string, (...args: unknown[]) => unknown>;
          hooksRegistered += registerPluginHooks(entry.manifest, hookManager, moduleFns);
        }
        if (entry) {
          // Phase 0: bridge manifest skills[] / mcpServers[] onto the live loaders.
          const caps = wirePluginManifestCapabilities(entry);
          if (caps.skillRootAdded) skillRootsAdded++;
          mcpServersRegistered += caps.mcpRegistered;
        }
      } catch (err) {
        log.warn({ id, err: String(err) }, 'Plugin enable failed during boot — skipping');
      }
    }
  }

  loader.saveState();
  log.info(
    { pluginsDir, loaded: entries.length, enabled, hooksRegistered, skillRootsAdded, mcpServersRegistered },
    'Plugin boot complete',
  );
  return { loader, loaded: entries.length, enabled, hooksRegistered, skillRootsAdded, mcpServersRegistered };
}

/**
 * Graceful teardown: unregister every enabled plugin's hooks from the
 * HookManager, then disable all plugins in reverse dependency order and
 * persist final state.
 */
export async function shutdownPlugins(loader: PluginLoader, hookManager: HookManager): Promise<void> {
  for (const entry of loader.listByState(PluginState.Enabled)) {
    try {
      unregisterPluginHooks(entry.manifest, hookManager);
    } catch (err) {
      log.warn({ id: entry.manifest.id, err: String(err) }, 'Plugin hook unregister failed — continuing');
    }
  }
  await loader.disableAll();
  loader.saveState();
  log.info('Plugin shutdown complete');
}
