/**
 * @file builtin/steer.ts
 * @description /steer — mid-run control over the in-flight turn via the
 * steering channel. Unlike /stop (which only discards the reply while the model
 * keeps running), /steer abort actually stops the loop at its next checkpoint;
 * /steer inject and /steer reprioritize add guidance the running turn picks up.
 *
 * Dispatched queue-bypassing (like other directives) so it reaches a turn that
 * is already executing. Signals for ctx.sessionId — the same session the
 * running turn uses for this peer.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:steer');

const ACTIONS = ['abort', 'inject', 'reprioritize'] as const;
type SteerAction = (typeof ACTIONS)[number];

export const steerCommand: SlashCommand = {
  name: 'steer',
  description: 'Steer the in-flight turn: abort it, or inject/reprioritize guidance mid-run.',
  usage: '/steer <abort|inject|reprioritize> [text]',

  async execute(args: string, ctx: CommandContext): Promise<string> {
    const trimmed = args.trim();
    const spaceIdx = trimmed.indexOf(' ');
    const action = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const payload = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    if (!ctx.steeringChannel) {
      return 'Steering is not available (no steering channel wired).';
    }
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return [
        'Usage: /steer <abort|inject|reprioritize> [text]',
        '- abort: stop the running turn at its next safe checkpoint',
        '- inject <text>: add context to the running turn',
        '- reprioritize <text>: tell the running turn to re-evaluate its plan',
      ].join('\n');
    }
    if ((action === 'inject' || action === 'reprioritize') && !payload) {
      return `/steer ${action} needs text, e.g. "/steer ${action} focus on the failing test first".`;
    }

    try {
      ctx.steeringChannel.signal(ctx.sessionId, {
        action: action as SteerAction,
        payload: payload || undefined,
      });
    } catch (err) {
      log.warn({ sessionId: ctx.sessionId, action, err: String(err) }, '/steer signal failed');
      return `Could not send steering signal: ${String(err)}`;
    }

    log.info({ sessionId: ctx.sessionId, action }, '/steer signalled');
    return action === 'abort'
      ? 'Abort signalled — the running turn will stop at its next checkpoint.'
      : `Steering signalled (${action}) — the running turn will pick it up at its next step.`;
  },
};
