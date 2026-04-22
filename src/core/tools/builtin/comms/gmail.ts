/**
 * @file tools/builtin/comms/gmail.ts
 * @description comms.gmail — Gmail tool wrapper for the SUDO-AI tool system.
 *
 * Requires googleapis package (not currently installed).
 * Gracefully returns not-configured message if absent.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { listGmailMessages, sendGmailMessage } from '../../../channels/gmail-connector.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('tool:comms.gmail');

type GmailOperation = 'list' | 'send';

export const gmailTool: ToolDefinition = {
  name: 'comms.gmail',
  description:
    'Interact with Gmail via OAuth. Operations: list (read inbox), send (send email). ' +
    'Requires googleapis package + OAuth token stored in vault (namespace: gmail). ' +
    'Returns not-configured message if googleapis is not installed.',
  category: 'comms',
  timeout: 30_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: ['list', 'send'],
      description: 'Gmail operation: "list" to read inbox, "send" to send an email.',
    },
    max_results: {
      type: 'number',
      required: false,
      default: 20,
      description: 'For list: maximum messages to return (max 20).',
    },
    to: {
      type: 'string',
      required: false,
      description: 'For send: recipient email address.',
    },
    subject: {
      type: 'string',
      required: false,
      description: 'For send: email subject line.',
    },
    body: {
      type: 'string',
      required: false,
      description: 'For send: plain-text email body.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = typeof params['operation'] === 'string'
      ? params['operation'] as GmailOperation
      : null;

    if (!operation || !['list', 'send'].includes(operation)) {
      return { success: false, output: 'comms.gmail: operation must be "list" or "send".' };
    }

    if (operation === 'list') {
      const maxResults = typeof params['max_results'] === 'number'
        ? Math.min(20, Math.max(1, params['max_results']))
        : 20;

      log.info({ sessionId: ctx.sessionId, maxResults }, 'Gmail list operation');
      const result = await listGmailMessages(maxResults, ctx.signal);
      return {
        success: result.success,
        output: result.output,
        data: result.messages ? { messages: result.messages, count: result.count } : undefined,
      };
    }

    // send
    const to = typeof params['to'] === 'string' ? params['to'].trim() : '';
    const subject = typeof params['subject'] === 'string' ? params['subject'] : '';
    const body = typeof params['body'] === 'string' ? params['body'] : '';

    if (!to) return { success: false, output: 'comms.gmail: "to" is required for send.' };
    if (!subject) return { success: false, output: 'comms.gmail: "subject" is required for send.' };
    if (!body) return { success: false, output: 'comms.gmail: "body" is required for send.' };

    log.info({ sessionId: ctx.sessionId, to, subject: subject.slice(0, 50) }, 'Gmail send operation');
    const result = await sendGmailMessage(to, subject, body, ctx.signal);
    return {
      success: result.success,
      output: result.output,
      data: result.messageId ? { messageId: result.messageId } : undefined,
    };
  },
};

export default gmailTool;
