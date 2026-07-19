/**
 * @file builtin/status.ts
 * @description /status — the shared status card (BO7 / S6).
 *
 * Renders the ONE shared card (see `status-card.ts`) so Telegram, the web
 * SPA/chat and the admin dashboard all show the SAME source of truth: version +
 * commit, time + reference UTC, gateway + system uptime, model + auth profile,
 * tokens + cost, cache % + cached/new tokens, context fill + compactions,
 * session key + duration, execution/think/fast, queue mode + depth.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';
import { collectStatusCard, renderStatusCardText, type StatusSources } from './status-card.js';

const log = createLogger('commands:status');

export const statusCommand: SlashCommand = {
  name: 'status',
  description: 'Show the status card: version, uptime, model, tokens/cost, cache, context, session, queue.',
  usage: '/status',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    log.debug({ peerId: ctx.peerId, channel: ctx.channel }, '/status executed');

    const sources: StatusSources = {
      agentLoop: ctx.agentLoop,
      config: ctx.config,
      mindDb: ctx.db,
      peerQueue: ctx.peerQueue,
      sessionId: ctx.sessionId,
      channel: ctx.channel,
      peerId: ctx.peerId,
    };

    try {
      const card = await collectStatusCard(sources);
      return renderStatusCardText(card);
    } catch (err) {
      log.error({ err: String(err) }, '/status card build failed');
      return 'Status unavailable right now.';
    }
  },
};
