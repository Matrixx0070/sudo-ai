/**
 * Built-in tool loader for SUDO-AI v3.
 *
 * Scans the `builtin/` directory for category sub-directories.  Each
 * sub-directory is expected to export one or more functions whose names
 * match the pattern `register*Tools(registry)`.  The loader dynamically
 * imports each `index.js` entry-point and calls every matching export,
 * collecting the totals for observability.
 *
 * Directory layout expected:
 * ```
 * builtin/
 *   coder/index.ts      → export function registerCoderTools(r: ToolRegistry)
 *   system/index.ts     → export async function registerSystemTools(r: ToolRegistry)
 *   browser/index.ts    → export function registerBrowserTools(r: ToolRegistry)
 *   ...
 * ```
 *
 * Errors in any individual module are caught and logged; they do NOT abort
 * the load of other modules so a single bad plugin cannot block the system.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../shared/logger.js';
import { ToolError } from '../shared/errors.js';
import type { ToolDefinition } from './types.js';
import type { ToolRegistry } from './registry.js';

const logger = createLogger('tool-loader');

// ---------------------------------------------------------------------------
// Hot-load state
// ---------------------------------------------------------------------------

/** Names registered via hotLoad — persists per process; enables hot-hot overwrite. */
const hotLoadedNames = new Set<string>();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape expected from a builtin tool module's default export namespace. */
type ToolModuleExports = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether `entry` inside `parentDir` is a directory.
 *
 * @param parentDir - Absolute path of the parent directory.
 * @param entry     - Directory entry name to check.
 * @returns `true` when the entry is a directory.
 */
async function isDirectory(parentDir: string, entry: string): Promise<boolean> {
  try {
    const info = await stat(join(parentDir, entry));
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Call all exported `register*Tools` functions found in a module.
 *
 * @param exports  - The module's export map.
 * @param registry - Registry to pass to each registration function.
 * @param source   - Human-readable label used in log messages.
 * @returns Number of registration functions successfully invoked.
 */
async function invokeRegisterFunctions(
  exports: ToolModuleExports,
  registry: ToolRegistry,
  source: string,
): Promise<number> {
  let invoked = 0;

  for (const [exportName, exportValue] of Object.entries(exports)) {
    if (!/^register.+Tools$/.test(exportName)) continue;
    if (typeof exportValue !== 'function') {
      logger.warn({ source, exportName }, 'Export matches naming convention but is not a function — skipping');
      continue;
    }

    try {
      // Functions may be async (returns Promise) or sync.
      await Promise.resolve(exportValue(registry));
      invoked++;
      logger.debug({ source, exportName }, 'Registration function invoked');
    } catch (err) {
      logger.error({ source, exportName, err }, 'Registration function threw — skipping');
    }
  }

  return invoked;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover and load all built-in tool modules from `builtinDir`.
 * Reads immediate sub-directories, imports each `index.ts`/`index.js`,
 * and calls every exported `register*Tools(registry)` function found.
 * Individual module failures are isolated — all other modules continue.
 *
 * @param registry   - {@link ToolRegistry} instance that receives the tools.
 * @param builtinDir - Absolute path to the `builtin/` directory.
 */
export async function loadBuiltinTools(
  registry: ToolRegistry,
  builtinDir: string,
): Promise<void> {
  if (!builtinDir || typeof builtinDir !== 'string') {
    throw new TypeError('loadBuiltinTools: builtinDir must be a non-empty string');
  }

  logger.info({ builtinDir }, 'Loading built-in tools');

  // 1. Read directory entries.
  let entries: string[];
  try {
    entries = await readdir(builtinDir);
  } catch (err) {
    logger.error({ builtinDir, err }, 'Cannot read builtinDir — no built-in tools loaded');
    return;
  }

  // 2. Filter to sub-directories only (parallel stat calls).
  const dirChecks = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      isDir: await isDirectory(builtinDir, entry),
    })),
  );
  const subdirs = dirChecks.filter((d) => d.isDir).map((d) => d.entry);

  if (subdirs.length === 0) {
    logger.warn({ builtinDir }, 'No sub-directories found in builtinDir — nothing to load');
    return;
  }

  // 3 & 4. Import each sub-directory's index.js and call register functions.
  let totalModulesLoaded = 0;
  let totalModulesFailed = 0;
  let totalFunctionsInvoked = 0;

  for (const subdir of subdirs) {
    // Try .ts first (tsx/development), fall back to .js (compiled/production).
    // If NEITHER exists, the subdir is a subsystem with its own internal
    // layout (e.g. computer-use/cross-platform/) rather than a tool category,
    // and there is no tool module to load. Skip with a debug log instead of
    // letting the import attempt fail loudly on every boot.
    const tsPath = join(builtinDir, subdir, 'index.ts');
    const jsPath = join(builtinDir, subdir, 'index.js');
    let indexPath: string | undefined;
    try {
      await stat(tsPath);
      indexPath = tsPath;
    } catch {
      try {
        await stat(jsPath);
        indexPath = jsPath;
      } catch {
        logger.debug(
          { module: subdir, builtinDir },
          'Subdir has no index.ts/index.js — not a tool category, skipping',
        );
        continue;
      }
    }
    const indexUrl = pathToFileURL(indexPath).href;

    try {
      logger.debug({ module: subdir, path: indexPath }, 'Importing tool module');
      // Use require() when tsx/cjs is registered (Electron), dynamic import() otherwise
      let exports: ToolModuleExports;
      try {
        exports = (await import(indexUrl)) as ToolModuleExports;
      } catch (importErr: unknown) {
        if (importErr instanceof TypeError && String(importErr).includes('Unknown file extension')) {
          // ESM loader can't handle .ts — fall back to CJS require via tsx
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          exports = require(indexPath) as ToolModuleExports;
        } else {
          throw importErr;
        }
      }

      const countBefore = registry.size;
      const invoked = await invokeRegisterFunctions(exports, registry, subdir);
      const registered = registry.size - countBefore;

      totalFunctionsInvoked += invoked;
      totalModulesLoaded++;

      logger.info(
        { module: subdir, invoked, registered },
        'Tool module loaded',
      );
    } catch (err) {
      totalModulesFailed++;
      logger.error(
        { module: subdir, path: indexPath, err },
        'Failed to import tool module — skipping',
      );
    }
  }

  // 5. Summary.
  logger.info(
    {
      totalModulesLoaded,
      totalModulesFailed,
      totalFunctionsInvoked,
      totalToolsRegistered: registry.size,
    },
    'Built-in tool loading complete',
  );
}

// ---------------------------------------------------------------------------
// Hot-load API
// ---------------------------------------------------------------------------

/**
 * Hot-load a single tool module from an absolute file path.
 * Calls every `register*Tools(registry)` export found in the module.
 * Bundled tools cannot be overwritten; previously hot-loaded names can.
 * Returns `[]` on total import failure; partial array on partial success.
 *
 * @param filePath - Absolute path to a `.ts` or `.js`/`.mjs` module.
 * @param registry - Live {@link ToolRegistry} instance to populate.
 * @returns Array of tool names successfully registered in this call.
 */
export async function hotLoad(
  filePath: string,
  registry: ToolRegistry,
): Promise<string[]> {
  if (!filePath || typeof filePath !== 'string') {
    logger.warn({}, 'hotLoad: filePath must be a non-empty string — skipping');
    return [];
  }

  const fileUrl = pathToFileURL(filePath).href;
  logger.info({ filePath }, 'Hot-loading tool module');

  // 1. Import — same tsx fallback as loadBuiltinTools.
  let exports: ToolModuleExports;
  try {
    try {
      exports = (await import(fileUrl)) as ToolModuleExports;
    } catch (importErr: unknown) {
      if (importErr instanceof TypeError && String(importErr).includes('Unknown file extension')) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        exports = require(filePath) as ToolModuleExports;
      } else {
        throw importErr;
      }
    }
  } catch (err) {
    logger.error({ filePath, err }, 'hotLoad: failed to import module — returning []');
    return [];
  }

  // 2. Proxy intercepts register() to enforce bundled-overwrite guard.
  const registeredInThisCall: string[] = [];

  const proxyRegistry = new Proxy(registry, {
    get(target, prop, recv) {
      if (prop === 'register') {
        return (tool: ToolDefinition): void => {
          const toolName = tool?.name ?? '';
          // Collision check: bundled (not previously hot-loaded) tools are protected.
          if (target.get(toolName) !== undefined && !hotLoadedNames.has(toolName)) {
            throw new ToolError(
              `Cannot overwrite bundled tool: ${toolName}`,
              'tool_invalid_definition',
              { toolName },
            );
          }
          target.register(tool);
          hotLoadedNames.add(toolName);
          registeredInThisCall.push(toolName);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  }) as ToolRegistry;

  // 3. Invoke every register*Tools export.
  for (const [exportName, exportValue] of Object.entries(exports)) {
    if (!/^register.+Tools$/.test(exportName)) continue;
    if (typeof exportValue !== 'function') {
      logger.warn({ filePath, exportName }, 'hotLoad: not a function — skipping');
      continue;
    }
    try {
      await Promise.resolve(exportValue(proxyRegistry));
      logger.debug({ filePath, exportName }, 'hotLoad: registrar invoked');
    } catch (err) {
      logger.error({ filePath, exportName, err }, 'hotLoad: registrar threw — skipping');
    }
  }

  logger.info({ filePath, registered: registeredInThisCall }, 'Hot-load complete');
  return registeredInThisCall;
}
