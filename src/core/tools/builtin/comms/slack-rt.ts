/**
 * @file tools/builtin/comms/slack-rt.ts
 * @description comms.slack-rt — Real Slack Bot Token tool wrapper.
 *
 * Uses vault-stored token (namespace: slack) or SLACK_BOT_TOKEN env var.
 * Separate from comms.slack which reads from SLACK_TOKEN env var.
 * Provides chat.postMessage via the slack-real-connector.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { slackPostMessage } from '../../../channels/slack-real-connector.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('tool:comms.slack-rt');

export const slackRtTool: ToolDefinition = {
  name: 'comms.slack-rt',
  description:
    'Post a message to a Slack channel via vault-stored Bot Token. ' +
    'Requires SLACK_BOT_TOKEN env var or token in vault (namespace: slack, url: https://slack.com/api). ' +
    'Uses chat.postMessage API. Channel ID (e.g. C01234ABCD) is required.',
  category: 'comms',
  timeout: 20_000,
  parameters: {
    channel_id: {
      type: 'string',
      required: true,
      description: 'Slack channel ID (e.g. C01234ABCD). Channel names not supported.',
    },
    text: {
      type: 'string',
      required: true,
      description: 'Message text (plain text or Slack mrkdwn format).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const channelId = typeof params['channel_id'] === 'string'
      ? params['channel_id'].trim()
      : '';
    const text = typeof params['text'] === 'string' ? params['text'] : '';

    if (!channelId) {
      return { success: false, output: 'comms.slack-rt: "channel_id" is required.' };
    }
    if (!text) {
      return { success: false, output: 'comms.slack-rt: "text" is required.' };
    }

    log.info({ sessionId: ctx.sessionId, channelId }, 'Slack-rt postMessage');
    const result = await slackPostMessage(channelId, text, ctx.signal);

    return {
      success: result.success,
      output: result.output,
      data: result.ts ? { ts: result.ts, channel: result.channel } : undefined,
    };
  },
};

export default slackRtTool;
