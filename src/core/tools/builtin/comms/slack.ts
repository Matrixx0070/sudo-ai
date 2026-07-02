/**
 * comms.slack — Slack Web API integration via native fetch.
 *
 * Operations:
 *   send         — Post a message to a channel
 *   read         — Retrieve recent messages from a channel
 *   list-channels — List all public/private channels the bot has access to
 *
 * Env:  SLACK_TOKEN  (Bot User OAuth Token, starts with xoxb-)
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { toolFetch } from '../../../security/guarded-fetch.js';

const log = createLogger('comms:slack');

const SLACK_API = 'https://slack.com/api';

type SlackOperation = 'send' | 'read' | 'list-channels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function slackPost(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await toolFetch(`${SLACK_API}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Slack HTTP ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  if (!json['ok']) {
    throw new Error(`Slack API error: ${String(json['error'] ?? 'unknown_error')}`);
  }
  return json;
}

async function slackGet(
  endpoint: string,
  token: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const res = await toolFetch(`${SLACK_API}/${endpoint}?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Slack HTTP ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  if (!json['ok']) {
    throw new Error(`Slack API error: ${String(json['error'] ?? 'unknown_error')}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const slackTool: ToolDefinition = {
  name: 'comms.slack',
  description:
    'Interact with Slack via the Web API. Operations: send (post message), ' +
    'read (get recent messages), list-channels (list accessible channels). ' +
    'Requires SLACK_TOKEN env var (xoxb- bot token).',
  category: 'comms',
  timeout: 20_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: ['send', 'read', 'list-channels'],
      description: 'Which Slack operation to perform.',
    },
    channel: {
      type: 'string',
      required: false,
      description: 'Channel ID or name (e.g. C01234ABCD or #general). Required for send/read.',
    },
    message: {
      type: 'string',
      required: false,
      description: 'Message text. Required for the "send" operation.',
    },
    limit: {
      type: 'number',
      required: false,
      default: 20,
      description: 'Number of messages to return for "read". Max 200. Defaults to 20.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const token = process.env['SLACK_TOKEN'];
    if (!token) {
      log.error({ sessionId: ctx.sessionId }, 'SLACK_TOKEN not set');
      return { success: false, output: 'comms.slack: SLACK_TOKEN env var is not set.' };
    }

    const operation = typeof params['operation'] === 'string'
      ? (params['operation'] as SlackOperation)
      : null;

    if (!operation || !['send', 'read', 'list-channels'].includes(operation)) {
      return {
        success: false,
        output: 'comms.slack: "operation" must be one of: send, read, list-channels.',
      };
    }

    const channel = typeof params['channel'] === 'string' ? params['channel'].trim() : '';
    const message = typeof params['message'] === 'string' ? params['message'] : '';
    const limit = typeof params['limit'] === 'number'
      ? Math.min(200, Math.max(1, params['limit']))
      : 20;

    try {
      if (operation === 'send') {
        if (!channel) {
          return { success: false, output: 'comms.slack: "channel" is required for send.' };
        }
        if (!message) {
          return { success: false, output: 'comms.slack: "message" is required for send.' };
        }

        const data = await slackPost(
          'chat.postMessage',
          token,
          { channel, text: message },
          ctx.signal,
        );

        const ts = String(data['ts'] ?? '');
        log.info({ sessionId: ctx.sessionId, channel, ts }, 'Slack message sent');

        return {
          success: true,
          output: `Message posted to ${channel}. Timestamp: ${ts}`,
          data: { ts, channel },
        };
      }

      if (operation === 'read') {
        if (!channel) {
          return { success: false, output: 'comms.slack: "channel" is required for read.' };
        }

        const data = await slackGet(
          'conversations.history',
          token,
          { channel, limit: String(limit) },
          ctx.signal,
        );

        const messages = Array.isArray(data['messages']) ? data['messages'] : [];
        log.info({ sessionId: ctx.sessionId, channel, count: messages.length }, 'Slack messages read');

        return {
          success: true,
          output: `Retrieved ${messages.length} message(s) from ${channel}.`,
          data: { channel, messages, count: messages.length },
        };
      }

      // list-channels
      const data = await slackGet(
        'conversations.list',
        token,
        { limit: String(Math.min(limit, 200)), exclude_archived: 'true' },
        ctx.signal,
      );

      const channels = Array.isArray(data['channels']) ? data['channels'] : [];
      const summary = channels.map((c: unknown) => {
        const ch = c as Record<string, unknown>;
        return { id: ch['id'], name: ch['name'], is_private: ch['is_private'] };
      });

      log.info({ sessionId: ctx.sessionId, count: channels.length }, 'Slack channels listed');

      return {
        success: true,
        output: `Found ${channels.length} channel(s).`,
        data: { channels: summary, count: channels.length },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId: ctx.sessionId, operation, err }, 'Slack operation failed');
      return { success: false, output: `comms.slack error: ${msg}` };
    }
  },
};

export default slackTool;
