/**
 * @file builtin/help.ts
 * @description /help — lists all registered slash commands with descriptions.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';
import type { CommandRegistry } from '../registry.js';

const log = createLogger('commands:help');

/**
 * Build a /help SlashCommand that reads from the given registry.
 * Injecting the registry avoids circular import issues.
 *
 * @param registry - The CommandRegistry to read commands from.
 */
export function createHelpCommand(registry: CommandRegistry): SlashCommand {
  return {
    name: 'help',
    description: 'List all available slash commands.',
    usage: '/help',

    async execute(_args: string, ctx: CommandContext): Promise<string> {
      log.debug({ peerId: ctx.peerId }, '/help executed');

      const cmds = registry.listAll().sort((a, b) => a.name.localeCompare(b.name));

      if (cmds.length === 0) {
        return 'No commands are currently registered.';
      }

      const lines = cmds.map((cmd) => `/${cmd.name} — ${cmd.description}`);
      return `Available commands (${cmds.length}):\n\n${lines.join('\n')}`;
    },
  };
}
