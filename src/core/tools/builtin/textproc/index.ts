/**
 * textproc tools registration barrel (Spec 10).
 *
 * Exports `registerTextprocTools`, discovered and called automatically by the
 * built-in tool loader (`loader.ts`). Kill-switch: SUDO_TEXTPROC=0 disables
 * the whole module (default ON — pure-additive capability, Spec 8 convention).
 */

import type { ToolRegistry } from '../../registry.js';
import { capabilitiesTool } from './capabilities-tool.js';
import { extractTool } from './extract.js';
import { replaceTool } from './replace.js';
import { analyzeTool } from './analyze.js';
import { getManifest, summaryLine } from './capabilities.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('textproc-index');

const TEXTPROC_TOOLS = [capabilitiesTool, extractTool, replaceTool, analyzeTool] as const;

/**
 * Register all textproc tools with the given registry.
 *
 * Called automatically by `loadBuiltinTools` — do not call manually unless
 * constructing a custom registry in tests.
 *
 * @param registry - The {@link ToolRegistry} to register tools into.
 */
export async function registerTextprocTools(registry: ToolRegistry): Promise<void> {
  if (process.env['SUDO_TEXTPROC'] === '0') {
    logger.info('textproc tools disabled (SUDO_TEXTPROC=0)');
    return;
  }
  logger.info({ count: TEXTPROC_TOOLS.length }, 'Registering textproc tools');
  for (const tool of TEXTPROC_TOOLS) {
    registry.register(tool);
  }
  // Boot coverage summary — one line, from the (possibly cached) manifest.
  try {
    const manifest = await getManifest();
    logger.info({ summary: summaryLine(manifest) }, 'textproc capability summary');
  } catch (err) {
    logger.warn({ err }, 'textproc capability probe failed at boot (tools still registered)');
  }
  logger.info({ count: TEXTPROC_TOOLS.length }, 'textproc tools registered');
}
