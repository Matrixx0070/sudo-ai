/**
 * Plugin state persistence helpers.
 *
 * Reads and writes data/plugins.json which stores the installed plugin
 * registry across process restarts.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('plugin:persistence');

/** Absolute path to the plugin state file. */
export const PLUGINS_JSON = path.join(DATA_DIR, 'plugins.json');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface PersistedEntry {
  id: string;
  pluginPath: string;
  state: 'installed' | 'active' | 'inactive' | 'error';
  loadedAt?: string;
  error?: string;
}

export interface PluginsJson {
  version: 1;
  plugins: PersistedEntry[];
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Load and parse plugins.json.
 * Returns null if the file does not exist or is malformed.
 */
export async function loadPluginsJson(): Promise<PluginsJson | null> {
  let raw: string;
  try {
    raw = await readFile(PLUGINS_JSON, 'utf8');
  } catch {
    log.debug('plugins.json not found — returning null');
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>)['plugins'])
    ) {
      return parsed as PluginsJson;
    }
    log.warn('plugins.json has unexpected shape — returning null');
    return null;
  } catch (err) {
    log.warn({ err }, 'plugins.json is malformed JSON — returning null');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write the plugin registry state to plugins.json atomically.
 * Non-fatal: logs errors but does not throw so in-memory state stays consistent.
 */
export async function savePluginsJson(plugins: PersistedEntry[]): Promise<void> {
  const state: PluginsJson = { version: 1, plugins };
  const json = JSON.stringify(state, null, 2);

  try {
    await mkdir(path.dirname(PLUGINS_JSON), { recursive: true });
    await writeFile(PLUGINS_JSON, json, 'utf8');
    log.debug({ count: plugins.length }, 'Plugin state persisted');
  } catch (err) {
    log.error({ err }, 'Failed to persist plugin state — in-memory state preserved');
  }
}
