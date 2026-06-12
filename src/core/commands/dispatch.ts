/**
 * @file dispatch.ts
 * @description Channel-agnostic slash-directive dispatch.
 *
 * tryDispatchDirective() mirrors the Telegram adapter's command intercept for
 * every other channel: when the inbound text is a slash command, execute it
 * against the CommandRegistry and reply through the channel's own send path,
 * short-circuiting the agent-turn pipeline entirely.
 */

import { createLogger } from '../shared/index.js';
import type { CommandRegistry } from './registry.js';
import type { CommandContext } from './types.js';

const log = createLogger('commands:dispatch');

/** Minimal slice of an inbound channel message needed for dispatch. */
export interface DirectiveMessage {
  channel: string;
  peerId: string;
  text?: string | undefined;
}

export interface DirectiveDispatchOptions {
  registry: CommandRegistry;
  msg: DirectiveMessage;
  /** Builds the CommandContext; returning null falls through to the agent. */
  makeContext: (msg: DirectiveMessage) => Promise<CommandContext | null>;
  /** Sends the command response back on the originating channel. */
  reply: (text: string) => Promise<void>;
}

/**
 * Attempt to handle the message as a slash directive.
 *
 * @returns true when the message was consumed (command executed and a reply
 * was attempted) — the caller must NOT enqueue an agent turn. Returns false
 * when the text is not a command or no context could be built (fail-open:
 * the message proceeds to the normal agent pipeline, matching the Telegram
 * adapter's behaviour). Never throws.
 */
export async function tryDispatchDirective(opts: DirectiveDispatchOptions): Promise<boolean> {
  const text = opts.msg.text ?? '';
  if (!opts.registry.isCommand(text)) return false;

  let ctx: CommandContext | null = null;
  try {
    ctx = await opts.makeContext(opts.msg);
  } catch (err) {
    log.error({ channel: opts.msg.channel, peerId: opts.msg.peerId, err: String(err) }, 'Directive context factory threw — falling through to agent');
    return false;
  }
  if (!ctx) return false;

  let response: string;
  try {
    // CommandRegistry.execute returns error strings instead of throwing,
    // but guard anyway: once we know it's a command, the agent never sees it.
    response = await opts.registry.execute(text, ctx);
  } catch (err) {
    response = `Command failed: ${String(err)}`;
  }

  log.info({ channel: opts.msg.channel, peerId: opts.msg.peerId, command: text.trimStart().split(' ')[0] }, 'Directive dispatched');

  try {
    await opts.reply(response);
  } catch (err) {
    log.error({ channel: opts.msg.channel, peerId: opts.msg.peerId, err: String(err) }, 'Directive reply send failed');
  }
  return true;
}
