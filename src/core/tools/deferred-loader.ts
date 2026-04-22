/**
 * Deferred (lazy) tool loader.
 *
 * Allows tool schemas to be registered at startup without immediately loading
 * their full implementation. Tools are loaded on first use, reducing cold-start
 * overhead when many tools are available but only a subset is needed per session.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('tools:deferred');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeferredTool {
  name: string;
  category: string;
  loaded: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loader: () => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema?: any;
}

// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const registry: Map<string, DeferredTool> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a tool for deferred loading.
 *
 * @param name     - Unique tool name used for later retrieval.
 * @param category - Logical grouping label, e.g. 'coder', 'system'.
 * @param loader   - Async factory that resolves to the tool schema / implementation.
 */
export function registerDeferred(
  name: string,
  category: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loader: () => Promise<any>,
): void {
  if (!name || typeof name !== 'string') {
    log.warn({ name }, 'registerDeferred: invalid tool name');
    return;
  }
  if (registry.has(name)) {
    log.warn({ name }, 'registerDeferred: tool already registered — overwriting');
  }
  registry.set(name, { name, category, loaded: false, loader });
  log.debug({ name, category }, 'Deferred tool registered');
}

/**
 * Load and return the schema for a registered deferred tool.
 * On the first call the loader is invoked and its result cached.
 * Subsequent calls return the cached schema without re-invoking the loader.
 *
 * @param name - Tool name as registered with registerDeferred().
 * @returns The loaded schema, or null when the tool is not registered.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadTool(name: string): Promise<any> {
  const tool = registry.get(name);
  if (!tool) {
    log.warn({ name }, 'loadTool: tool not found in registry');
    return null;
  }

  if (!tool.loaded) {
    try {
      tool.schema = await tool.loader();
      tool.loaded = true;
      log.debug({ name }, 'Deferred tool loaded');
    } catch (err) {
      log.error({ name, err }, 'loadTool: loader threw an error');
      throw err;
    }
  }

  return tool.schema;
}

/**
 * Return the names of all registered deferred tools.
 */
export function listDeferred(): string[] {
  return Array.from(registry.keys());
}

/**
 * Return true when a tool is registered AND has not yet been loaded.
 *
 * @param name - Tool name to check.
 */
export function isDeferredTool(name: string): boolean {
  const tool = registry.get(name);
  return tool !== undefined && !tool.loaded;
}

log.debug('deferred-loader module loaded');
