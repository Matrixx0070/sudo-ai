/**
 * fs-list-by-mtime tools registration barrel.
 *
 * Exports `registerFsListByMtimeTools` which is discovered and called
 * automatically by the built-in tool loader (`loader.ts`).
 */

import type { ToolRegistry } from '../../registry.js';
import { createLogger } from '../../../shared/logger.js';
import { fsListByMtimeTool } from './list-by-mtime.js';

const logger = createLogger('fs-list-by-mtime-index');

/**
 * Register all fs-list-by-mtime tools with the given registry.
 *
 * Called automatically by `loadBuiltinTools` — do not call manually unless
 * constructing a custom registry in tests.
 *
 * @param registry - The {@link ToolRegistry} to register tools into.
 */
export function registerFsListByMtimeTools(registry: ToolRegistry): void {
  logger.info({ count: 1 }, 'Registering fs-list-by-mtime tools');
  registry.register(fsListByMtimeTool);
  logger.info({ count: 1 }, 'fs-list-by-mtime tools registered');
}

export { fsListByMtimeTool };
