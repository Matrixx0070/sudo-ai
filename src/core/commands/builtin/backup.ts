/**
 * @file builtin/backup.ts
 * @description /backup — triggers a system backup via the backup tool.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:backup');

interface RegistryLike {
  isEnabled?: (name: string) => boolean;
  execute?: (
    name: string,
    params: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<{ success: boolean; output: string }>;
}

export const backupCommand: SlashCommand = {
  name: 'backup',
  description: 'Trigger a system backup.',
  usage: '/backup',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    log.info({ peerId: ctx.peerId }, '/backup triggered');

    const registry = ctx.toolRegistry as RegistryLike | null;

    const BACKUP_TOOL = 'system.backup';

    if (!registry?.isEnabled?.(BACKUP_TOOL) || !registry.execute) {
      log.warn({}, `${BACKUP_TOOL} tool not available`);
      return `Backup tool (${BACKUP_TOOL}) is not loaded. Cannot trigger backup.`;
    }

    try {
      const result = await registry.execute(
        BACKUP_TOOL,
        {},
        {
          sessionId: ctx.sessionId,
          workingDir: process.cwd(),
          config: ctx.config,
          logger: log,
        },
      );

      log.info({ success: result.success }, '/backup completed');

      if (result.success) {
        return `Backup completed successfully.\n${result.output}`;
      }
      return `Backup finished with issues:\n${result.output}`;
    } catch (err) {
      log.error({ err }, '/backup: tool execution failed');
      return `Backup failed: ${String(err)}`;
    }
  },
};
