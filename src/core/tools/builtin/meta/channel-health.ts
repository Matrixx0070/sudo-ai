/**
 * @file channel-health.ts (channel.health)
 * @description Reports gateway channel health (Multi-Channel Gateway, Feature 1
 * — Step 2 "registers a channel.health tool"). Reads the live MessageRouter's
 * per-channel snapshot: connected?, supervisor restarts, last error, last inbound.
 *
 * Only covers router-managed channels. Channels on their own bespoke path
 * (currently Telegram) are not in the gateway registry and report separately.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { getGlobalMessageRouter } from '../../../channels/router.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta.channel-health');

export const channelHealthTool: ToolDefinition = {
  name: 'channel.health',
  description:
    'Report the health of gateway-managed chat channels: whether each is connected, how many ' +
    'times the crash-isolation supervisor has restarted it, its last error, and when it last ' +
    'received a message. Use to check if Discord/Slack/Signal/etc. are up. (Telegram runs its ' +
    'own path and is not listed here.)',
  category: 'meta',
  parameters: {},
  async execute(_params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const router = getGlobalMessageRouter();
    if (!router) {
      return { success: true, output: 'No gateway-managed channels are active (only bespoke channels like Telegram are running).', data: { channels: [] } };
    }
    try {
      const health = router.health();
      if (health.length === 0) {
        return { success: true, output: 'Gateway is up but no channel adapters are registered.', data: { channels: [] } };
      }
      const lines = health.map((h) => {
        const bits = [`${h.connected ? '🟢 connected' : '🔴 down'}`];
        if (h.restarts > 0) bits.push(`restarts=${h.restarts}`);
        if (h.lastError) bits.push(`lastError="${h.lastError.slice(0, 80)}"`);
        if (h.lastMessageAt) bits.push(`lastMsg=${new Date(h.lastMessageAt).toISOString()}`);
        return `  ${h.channel}: ${bits.join(' · ')}`;
      });
      logger.info({ session: ctx.sessionId, count: health.length }, 'channel.health queried');
      return { success: true, output: `Gateway channel health:\n${lines.join('\n')}`, data: { channels: health } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `channel.health failed: ${msg}` };
    }
  },
};
