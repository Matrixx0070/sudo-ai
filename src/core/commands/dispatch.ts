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
  /**
   * Authorization gate for the shared directive path. Called with the message
   * and the parsed command name (lower-case, no leading slash) once the text is
   * known to be a command. Return `false` to DENY: the directive is NOT
   * executed and the message is consumed silently (it does not become an agent
   * turn), so a non-owner cannot /stop or /reset (or /steer) another peer's
   * session or running turn. Omitted → all directives allowed (prior behaviour).
   */
  authorize?: (msg: DirectiveMessage, command: string) => boolean | Promise<boolean>;
}

/** Parse the command name from directive text: "/Steer abort" → "steer". */
function directiveCommandName(text: string): string {
  return text.trimStart().replace(/^\//, '').split(/\s+/)[0]?.toLowerCase() ?? '';
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
  // Registered commands only: an unregistered slash-shaped message falls
  // through to the agent turn (skill activation can anchor-match it there)
  // instead of dying as an "Unknown command" reply.
  if (!opts.registry.isRegisteredCommand(text)) return false;

  // Authorization gate (shared directive-auth layer). Deny → consume silently:
  // the directive does not run and the message is NOT enqueued as an agent turn,
  // so a non-owner can't steer/stop another peer's session.
  if (opts.authorize) {
    const command = directiveCommandName(text);
    let allowed: boolean;
    try {
      allowed = await opts.authorize(opts.msg, command);
    } catch (err) {
      // Fail CLOSED for a control surface: an authorizer that throws denies.
      log.error({ channel: opts.msg.channel, peerId: opts.msg.peerId, command, err: String(err) }, 'Directive authorize threw — denying');
      allowed = false;
    }
    if (!allowed) {
      log.warn({ channel: opts.msg.channel, peerId: opts.msg.peerId, command }, 'Directive denied — sender not authorized');
      return true; // consumed: not executed, not an agent turn
    }
  }

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
