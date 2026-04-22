/**
 * meta.message.send — Send a message to a peer via a named channel.
 *
 * Delegates to the injected channelRouter dependency. Returns a graceful
 * not-initialised message when the router has not been injected.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { getChannelRouter } from './index.js';

const logger = createLogger('meta.message.send');

// ---------------------------------------------------------------------------
// ChannelRouter interface (duck-typed)
// ---------------------------------------------------------------------------

interface SendResult {
  messageId?: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface ChannelRouterLike {
  send(channel: string, peerId: string, text: string): Promise<SendResult>;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const messageSendTool: ToolDefinition = {
  name: 'message.send',
  description:
    'Send a text message to a specific peer on a named delivery channel (e.g. Telegram, Slack, API). ' +
    'Use to proactively reach out to users, send notifications, or reply outside of the current conversation.',
  category: 'meta',
  timeout: 30_000,
  parameters: {
    channel: {
      type: 'string',
      required: true,
      description: 'Delivery channel name (e.g. "telegram", "slack", "api", "email").',
    },
    peerId: {
      type: 'string',
      required: true,
      description: 'Recipient identifier within the channel (e.g. Telegram chat ID, Slack user ID, email address).',
    },
    text: {
      type: 'string',
      required: true,
      description: 'Plain-text or Markdown message body to send.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const channel = params['channel'] as string | undefined;
    const peerId = params['peerId'] as string | undefined;
    const text = params['text'] as string | undefined;

    logger.info({ session: ctx.sessionId, channel, peerId }, 'message.send invoked');

    if (!channel?.trim()) {
      return { success: false, output: 'message.send: "channel" parameter is required and must be non-empty.' };
    }
    if (!peerId?.trim()) {
      return { success: false, output: 'message.send: "peerId" parameter is required and must be non-empty.' };
    }
    if (!text?.trim()) {
      return { success: false, output: 'message.send: "text" parameter is required and must be non-empty.' };
    }

    const channelRouter = getChannelRouter() as ChannelRouterLike | null;
    if (!channelRouter) {
      logger.warn({ session: ctx.sessionId }, 'message.send: channelRouter not initialised');
      return {
        success: false,
        output: 'message.send: channel router has not been initialised. Call injectMetaToolDeps() with a channelRouter before using this tool.',
      };
    }

    try {
      const result = await channelRouter.send(channel, peerId, text);
      logger.info({ session: ctx.sessionId, channel, peerId, messageId: result.messageId }, 'Message sent');

      const idNote = result.messageId ? ` (message ID: ${result.messageId})` : '';
      return {
        success: true,
        output: `Message sent to ${peerId} via ${channel}${idNote}.`,
        data: { channel, peerId, messageId: result.messageId, timestamp: result.timestamp },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ session: ctx.sessionId, channel, peerId, err: msg }, 'message.send error');
      return { success: false, output: `message.send error: ${msg}` };
    }
  },
};
