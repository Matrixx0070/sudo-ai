/**
 * @file registry.ts
 * @description CommandRegistry — central store for all SUDO-AI slash commands.
 *
 * Responsibilities:
 *  - Register SlashCommand instances by name.
 *  - Parse incoming text messages for slash command syntax.
 *  - Dispatch to the correct handler and return the response string.
 */

import { createLogger } from '../shared/index.js';
import { PipelineError } from '../shared/index.js';
import type { SlashCommand, CommandContext } from './types.js';

const log = createLogger('commands:registry');

// ---------------------------------------------------------------------------
// Parse result shape
// ---------------------------------------------------------------------------

/** Result of parsing a potential slash command string. */
export interface ParsedCommand {
  /** Command name without the leading slash. */
  name: string;
  /** Everything after the command name, trimmed. May be empty. */
  args: string;
}

// ---------------------------------------------------------------------------
// CommandRegistry
// ---------------------------------------------------------------------------

/** Central registry for slash commands. */
export class CommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a slash command.
   * Overwrites an existing registration with the same name and logs a warning.
   *
   * @param cmd - The SlashCommand to register.
   * @throws PipelineError if cmd.name is missing or cmd.execute is not a function.
   */
  register(cmd: SlashCommand): void {
    if (!cmd?.name || typeof cmd.name !== 'string') {
      throw new PipelineError('CommandRegistry: command must have a non-empty name', 'pipeline_invalid_args');
    }
    if (typeof cmd.execute !== 'function') {
      throw new PipelineError(
        `CommandRegistry: command "${cmd.name}" must have an execute function`,
        'pipeline_invalid_args',
        { name: cmd.name },
      );
    }
    if (this.commands.has(cmd.name)) {
      // Same-reference re-register is a true no-op: a command can arrive via more
      // than one registration path that imports the SAME SlashCommand object (an
      // ES-module singleton). The registry already maps the name to that exact
      // object, so re-setting it changes nothing; skip it so the registry is
      // idempotent-by-design for these duplicates. Only a genuinely DIVERGENT
      // re-register (different object, same name) falls through to last-wins.
      if (this.commands.get(cmd.name) === cmd) return;
      // Benign last-wins re-register (core + plugin command sets can overlap);
      // routine, not an error. debug, not warn.
      log.debug({ name: cmd.name }, 'slash command re-registered (overwriting prior definition)');
    }
    this.commands.set(cmd.name, cmd);
    log.info({ name: cmd.name }, 'Slash command registered');
  }

  /**
   * Retrieve a registered command by name.
   *
   * @param name - Command name without the leading slash.
   * @returns The SlashCommand or undefined if not found.
   */
  get(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  /** Return all registered commands as a snapshot array. */
  listAll(): SlashCommand[] {
    return [...this.commands.values()];
  }

  // -------------------------------------------------------------------------
  // Detection and parsing
  // -------------------------------------------------------------------------

  /**
   * Returns true if the text starts with a slash (i.e. looks like a command).
   *
   * @param text - Raw message text.
   */
  isCommand(text: string): boolean {
    return typeof text === 'string' && text.trimStart().startsWith('/');
  }

  /**
   * Parse a slash command string into its name and arguments.
   * E.g. '/produce AI ethics' → { name: 'produce', args: 'AI ethics' }
   *
   * @param text - Raw message text starting with '/'.
   * @returns Parsed name and args. Name will be lowercase.
   */
  parse(text: string): ParsedCommand {
    const trimmed = text.trimStart();
    const withoutSlash = trimmed.slice(1); // drop leading /
    const spaceIndex = withoutSlash.indexOf(' ');
    if (spaceIndex === -1) {
      return { name: withoutSlash.toLowerCase(), args: '' };
    }
    return {
      name: withoutSlash.slice(0, spaceIndex).toLowerCase(),
      args: withoutSlash.slice(spaceIndex + 1).trim(),
    };
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Parse and execute a slash command string.
   * Returns an error message string (not a thrown error) when the command is
   * unknown or execution fails, so it can be sent back to the user safely.
   *
   * @param text - Raw message text starting with '/'.
   * @param ctx  - Runtime context.
   * @returns Response string for the user.
   */
  async execute(text: string, ctx: CommandContext): Promise<string> {
    if (!this.isCommand(text)) {
      return 'Not a slash command.';
    }

    const { name, args } = this.parse(text);
    const cmd = this.commands.get(name);

    if (!cmd) {
      log.warn({ name }, 'Unknown slash command received');
      return `Unknown command: /${name}\nType /help to see available commands.`;
    }

    log.info({ name, args: args.slice(0, 80), peerId: ctx.peerId }, 'Executing slash command');

    try {
      const result = await cmd.execute(args, ctx);
      log.info({ name }, 'Slash command completed successfully');
      return result;
    } catch (err) {
      log.error({ name, err }, 'Slash command execution failed');
      return `Command /${name} failed: ${String(err)}`;
    }
  }
}
