/**
 * System tools registration barrel.
 *
 * Exports `registerSystemTools` which is discovered and called automatically
 * by the built-in tool loader (`loader.ts`).  Each tool module exports a
 * single `ToolDefinition` constant that is registered here.
 */

import type { ToolRegistry } from '../../registry.js';
import { processTool } from './process.js';
import { serviceTool } from './service.js';
import { dockerTool } from './docker.js';
import { nginxTool } from './nginx.js';
import { cronTool } from './cron-system.js';
import { diskTool } from './disk.js';
import { networkTool } from './network.js';
import { sshTool } from './ssh.js';
import { backupTool } from './backup.js';
import { monitorTool } from './monitor.js';
import { pm2Tool } from './pm2.js';
import { standingOrdersTool } from './standing-orders.js';
import { apiCallTool } from './api-call.js';
import { execTool } from './shell-exec.js';
import { backupBrainTool } from './backup-brain.js';
import { credentialManagerTool } from './credential-manager.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('system-tools-index');

const SYSTEM_TOOLS = [
  processTool,
  serviceTool,
  dockerTool,
  nginxTool,
  cronTool,
  diskTool,
  networkTool,
  sshTool,
  backupTool,
  monitorTool,
  pm2Tool,
  standingOrdersTool,
  apiCallTool,
  execTool,
  backupBrainTool,
  credentialManagerTool,
] as const;

/**
 * Register all system tools with the given registry.
 *
 * Called automatically by `loadBuiltinTools` — do not call manually unless
 * constructing a custom registry in tests.
 *
 * @param registry - The {@link ToolRegistry} to register tools into.
 */
export async function registerSystemTools(registry: ToolRegistry): Promise<void> {
  logger.info({ count: SYSTEM_TOOLS.length }, 'Registering system tools');
  for (const tool of SYSTEM_TOOLS) {
    registry.register(tool);
  }
  // Background-shell family (gap #10) — opt-in, default OFF. The barrel is
  // dynamic-imported ONLY when the flag is set, so when unset the bg-shell module
  // graph is never even loaded (zero side effects, byte-identical behavior).
  if (process.env['SUDO_BG_SHELL'] === '1') {
    const { BG_SHELL_TOOLS } = await import('./bg-shell/index.js');
    for (const tool of BG_SHELL_TOOLS) registry.register(tool);
    logger.info({ count: BG_SHELL_TOOLS.length }, 'Background-shell tools registered (SUDO_BG_SHELL=1)');
  }
  logger.info({ count: SYSTEM_TOOLS.length }, 'System tools registered');
}
