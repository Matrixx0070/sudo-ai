/**
 * @file tools/builtin/comms/imessage.ts
 * @description comms.imessage — iMessage read tool wrapper.
 *
 * macOS only — reads ~/Library/Messages/chat.db (read-only SQLite).
 * On Linux → returns {success: false, output: 'iMessage requires macOS'}.
 * Requires Full Disk Access in macOS System Preferences.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { listIMessageConversations, readIMessageChat } from '../../../channels/imessage-connector.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('tool:comms.imessage');

type IMessageOperation = 'list' | 'read';

export const imessageTool: ToolDefinition = {
  name: 'comms.imessage',
  description:
    'Read iMessage conversations and messages (macOS only, read-only). ' +
    'Operations: list (recent conversations), read (messages in a specific chat). ' +
    'Requires Full Disk Access permission in macOS System Preferences. ' +
    'Returns {success: false} on non-macOS platforms.',
  category: 'comms',
  timeout: 15_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: ['list', 'read'],
      description: '"list" to get recent conversations, "read" to get messages from a specific chat.',
    },
    limit: {
      type: 'number',
      required: false,
      default: 20,
      description: 'Maximum items to return (conversations or messages). Defaults to 20.',
    },
    chat_id: {
      type: 'number',
      required: false,
      description: 'For read: the chat ROWID from a prior list operation.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = typeof params['operation'] === 'string'
      ? params['operation'] as IMessageOperation
      : null;

    if (!operation || !['list', 'read'].includes(operation)) {
      return { success: false, output: 'comms.imessage: operation must be "list" or "read".' };
    }

    const limit = typeof params['limit'] === 'number'
      ? Math.min(100, Math.max(1, params['limit']))
      : 20;

    if (operation === 'list') {
      log.info({ sessionId: ctx.sessionId, limit }, 'iMessage list conversations');
      const result = await listIMessageConversations(limit, ctx.signal);

      if (!result.supported) {
        return { success: false, output: result.output };
      }

      return {
        success: true,
        output: result.output,
        data: result.conversations
          ? { conversations: result.conversations, count: result.count }
          : undefined,
      };
    }

    // read
    const chatId = typeof params['chat_id'] === 'number' ? params['chat_id'] : null;
    if (!chatId || !Number.isInteger(chatId) || chatId <= 0) {
      return { success: false, output: 'comms.imessage: "chat_id" (positive integer) is required for read.' };
    }

    log.info({ sessionId: ctx.sessionId, chatId, limit }, 'iMessage read chat');
    const result = await readIMessageChat(chatId, limit, ctx.signal);

    if (!result.supported) {
      return { success: false, output: result.output };
    }

    return {
      success: true,
      output: result.output,
      data: result.messages
        ? { messages: result.messages, count: result.count }
        : undefined,
    };
  },
};

export default imessageTool;
