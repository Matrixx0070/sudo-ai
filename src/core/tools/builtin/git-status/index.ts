/**
 * git-status tools registration barrel.
 *
 * Exports `registerGitStatusTools` which is discovered and called automatically
 * by the built-in tool loader (`loader.ts`).
 */

import type { ToolRegistry } from '../../registry.js';
import { gitStatusTool } from './status.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('git-status-index');

const GIT_STATUS_TOOLS = [gitStatusTool] as const;

/**
 * Register all git-status tools with the given registry.
 *
 * Called automatically by `loadBuiltinTools` — do not call manually unless
 * constructing a custom registry in tests.
 *
 * @param registry - The {@link ToolRegistry} to register tools into.
 */
export function registerGitStatusTools(registry: ToolRegistry): void {
  logger.info({ count: GIT_STATUS_TOOLS.length }, 'Registering git-status tools');
  for (const tool of GIT_STATUS_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: GIT_STATUS_TOOLS.length }, 'git-status tools registered');
}
