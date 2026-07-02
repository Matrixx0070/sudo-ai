/**
 * @file index.ts
 * @description Public barrel export for the commands subsystem.
 *
 * Exports types, CommandRegistry, and registerBuiltinCommands().
 * Call registerBuiltinCommands(registry) once at startup after constructing
 * a CommandRegistry.
 */

export type { SlashCommand, CommandContext } from './types.js';
export { CommandRegistry } from './registry.js';
export type { ParsedCommand } from './registry.js';

// Builtin command exports (useful for test-level access)
export { createHelpCommand } from './builtin/help.js';
export { statusCommand } from './builtin/status.js';
export { produceCommand } from './builtin/produce.js';
export { toolsCommand } from './builtin/tools.js';
export { modelCommand } from './builtin/model.js';
export { personaCommand } from './builtin/persona.js';
export { moodCommand } from './builtin/mood.js';
export { budgetCommand } from './builtin/budget.js';
export { healthCommand } from './builtin/health.js';
export { learnCommand } from './builtin/learn.js';
export { compactCommand } from './builtin/compact.js';
export { resetCommand } from './builtin/reset.js';
export { backupCommand } from './builtin/backup.js';
export { cronCommand } from './builtin/cron.js';
export { benchCommand } from './builtin/bench.js';
export { stopCommand } from './builtin/stop.js';
export { steerCommand } from './builtin/steer.js';
export { queueCommand } from './builtin/queue.js';
export { tryDispatchDirective } from './dispatch.js';
export type { DirectiveMessage, DirectiveDispatchOptions } from './dispatch.js';

import { CommandRegistry } from './registry.js';
import { createHelpCommand } from './builtin/help.js';
import { statusCommand } from './builtin/status.js';
import { produceCommand } from './builtin/produce.js';
import { toolsCommand } from './builtin/tools.js';
import { modelCommand } from './builtin/model.js';
import { personaCommand } from './builtin/persona.js';
import { moodCommand } from './builtin/mood.js';
import { budgetCommand } from './builtin/budget.js';
import { healthCommand } from './builtin/health.js';
import { learnCommand } from './builtin/learn.js';
import { compactCommand } from './builtin/compact.js';
import { resetCommand } from './builtin/reset.js';
import { backupCommand } from './builtin/backup.js';
import { cronCommand } from './builtin/cron.js';
import { benchCommand } from './builtin/bench.js';
import { forgeCommand } from './builtin/forge.js';
import { stopCommand } from './builtin/stop.js';
import { steerCommand } from './builtin/steer.js';
import { queueCommand } from './builtin/queue.js';

/**
 * Register all built-in slash commands on the given registry.
 * Must be called once during application startup.
 *
 * /help is constructed last so it can reference the fully populated registry.
 *
 * @param registry - The CommandRegistry to populate.
 */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  registry.register(statusCommand);
  registry.register(produceCommand);
  registry.register(toolsCommand);
  registry.register(modelCommand);
  registry.register(personaCommand);
  registry.register(moodCommand);
  registry.register(budgetCommand);
  registry.register(healthCommand);
  registry.register(learnCommand);
  registry.register(compactCommand);
  registry.register(resetCommand);
  registry.register(backupCommand);
  registry.register(cronCommand);
  registry.register(benchCommand);
  registry.register(forgeCommand);
  registry.register(stopCommand);
  registry.register(steerCommand);
  registry.register(queueCommand);

  // Help must be registered last so it sees all other commands.
  registry.register(createHelpCommand(registry));
}
