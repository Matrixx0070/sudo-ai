/**
 * github tools registration barrel.
 *
 * Exports `registerGitHubTools`, discovered and called automatically by the
 * built-in tool loader (`loader.ts`). The group is OPT-IN: when
 * SUDO_GITHUB_TOOLS is not enabled the tools are NOT registered, so the
 * commit/push/PR/merge capability does not exist unless an operator turns it
 * on. See github.ts for the per-tool safety model (merge_pr is gated on
 * CI-green).
 */

import type { ToolRegistry } from '../../registry.js';
import { GITHUB_TOOLS, gitHubToolsEnabled } from './github.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('github-index');

/**
 * Register the github.* tools when SUDO_GITHUB_TOOLS is enabled.
 *
 * Called automatically by `loadBuiltinTools` — do not call manually unless
 * constructing a custom registry in tests.
 *
 * @param registry - The {@link ToolRegistry} to register tools into.
 */
export function registerGitHubTools(registry: ToolRegistry): void {
  if (!gitHubToolsEnabled()) {
    logger.info('github.* tools disabled (set SUDO_GITHUB_TOOLS=1 to enable) — skipping');
    return;
  }
  for (const tool of GITHUB_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: GITHUB_TOOLS.length }, 'github.* tools registered');
}
