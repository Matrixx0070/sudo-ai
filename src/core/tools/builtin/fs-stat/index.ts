/**
 * fs-stat tools registration barrel.
 *
 * Exports `registerFsStatTools` which is discovered and called automatically
 * by the built-in tool loader (`loader.ts`).
 */

import type { ToolRegistry } from '../../registry.js';
import { fsStatTool } from './stat.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('fs-stat-index');

const FS_STAT_TOOLS = [fsStatTool] as const;

/**
 * Register all fs-stat tools with the given registry.
 *
 * Called automatically by `loadBuiltinTools` — do not call manually unless
 * constructing a custom registry in tests.
 *
 * @param registry - The {@link ToolRegistry} to register tools into.
 */
export function registerFsStatTools(registry: ToolRegistry): void {
  logger.info({ count: FS_STAT_TOOLS.length }, 'Registering fs-stat tools');
  for (const tool of FS_STAT_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: FS_STAT_TOOLS.length }, 'fs-stat tools registered');
}
