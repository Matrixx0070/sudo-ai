/**
 * comms.notify — Unified multi-channel notification dispatcher.
 *
 * Dispatches a message to one or more channels simultaneously.
 * If priority is "urgent", ALL configured channels are used regardless of
 * the channels parameter.
 *
 * Supported channels: slack, email, sms, telegram
 * Each channel is attempted independently; partial failures are reported.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { toolFetch } from '../../../security/guarded-fetch.js';
import { withCommsIdempotency } from '../../../comms/idempotency.js';

const log = createLogger('comms:notify');

type Channel = 'slack' | 'email' | 'sms' | 'telegram';
type Priority = 'low' | 'normal' | 'urgent';

interface DeliveryStatus {
  channel: Channel;
  success: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Per-channel dispatch helpers (lightweight, no SDK imports)
// ---------------------------------------------------------------------------

async function dispatchSlack(
  message: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; detail: string }> {
  const token = process.env['SLACK_TOKEN'];
  const channel = process.env['SLACK_DEFAULT_CHANNEL'] ?? '#general';

  if (!token) {
    return { success: false, detail: 'SLACK_TOKEN not set' };
  }

  try {
    const res = await toolFetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel, text: message }),
      signal,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!json['ok']) {
      return { success: false, detail: `Slack error: ${String(json['error'] ?? 'unknown')}` };
    }
    return { success: true, detail: `Posted to ${channel}` };
  } catch (err) {
    return { success: false, detail: `Slack fetch error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function dispatchEmail(
  message: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; detail: string }> {
  // Email dispatch requires nodemailer — delegate via dynamic import to avoid
  // loading nodemailer in environments where it is not needed.
  const to = process.env['NOTIFY_EMAIL_TO'];
  const host = process.env['SMTP_HOST'];
  const user = process.env['SMTP_USER'] ?? process.env['GMAIL_USER'];
  const pass = process.env['SMTP_PASS'] ?? process.env['GMAIL_APP_PASSWORD'];

  if (!to || !user || !pass) {
    return { success: false, detail: 'Email env vars not set (NOTIFY_EMAIL_TO + SMTP or GMAIL)' };
  }

  try {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.default.createTransport(
      host
        ? { host, port: parseInt(process.env['SMTP_PORT'] ?? '587', 10), auth: { user, pass } }
        : { service: 'gmail', auth: { user, pass } },
    );

    // Ignore signal for nodemailer (no native AbortSignal support)
    void signal;

    const info = await transport.sendMail({
      to,
      subject: 'SUDO-AI Notification',
      text: message,
    });
    return { success: true, detail: `Email sent to ${to}, id: ${info.messageId}` };
  } catch (err) {
    return { success: false, detail: `Email error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function dispatchSms(
  message: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; detail: string }> {
  const accountSid = process.env['TWILIO_ACCOUNT_SID'];
  const authToken = process.env['TWILIO_AUTH_TOKEN'];
  const from = process.env['TWILIO_PHONE_NUMBER'];
  const to = process.env['NOTIFY_SMS_TO'];

  if (!accountSid || !authToken || !from || !to) {
    return { success: false, detail: 'Twilio env vars not set (TWILIO_* + NOTIFY_SMS_TO)' };
  }

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

    const res = await toolFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: to, Body: message }).toString(),
      signal,
    });

    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return { success: false, detail: `Twilio error: ${String(json['message'] ?? res.statusText)}` };
    }
    return { success: true, detail: `SMS sent to ${to}, sid: ${String(json['sid'] ?? '')}` };
  } catch (err) {
    return { success: false, detail: `SMS error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function dispatchTelegram(
  message: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; detail: string }> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  // Fall back to the operator's main chat id — prod sets TELEGRAM_CHAT_ID but
  // not TELEGRAM_NOTIFY_CHAT_ID, which left telegram notify dead.
  const chatId = process.env['TELEGRAM_NOTIFY_CHAT_ID'] ?? process.env['TELEGRAM_CHAT_ID'];

  if (!token || !chatId) {
    return { success: false, detail: 'TELEGRAM_BOT_TOKEN or TELEGRAM_NOTIFY_CHAT_ID not set' };
  }

  try {
    const res = await toolFetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message }),
        signal,
      },
    );

    const json = (await res.json()) as Record<string, unknown>;
    if (!json['ok']) {
      return { success: false, detail: `Telegram error: ${String(json['description'] ?? 'unknown')}` };
    }
    return { success: true, detail: `Telegram message sent to chat ${chatId}` };
  } catch (err) {
    return { success: false, detail: `Telegram error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Dispatcher map
// ---------------------------------------------------------------------------

const DISPATCHERS: Record<Channel, (msg: string, signal?: AbortSignal) => Promise<{ success: boolean; detail: string }>> = {
  slack: dispatchSlack,
  email: dispatchEmail,
  sms: dispatchSms,
  telegram: dispatchTelegram,
};

const ALL_CHANNELS: Channel[] = ['slack', 'email', 'sms', 'telegram'];

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const notificationTool: ToolDefinition = {
  name: 'comms.notify',
  description:
    'Send a unified notification across multiple channels simultaneously. ' +
    'Channels: slack, email, sms, telegram. ' +
    'Priority "urgent" sends to ALL configured channels regardless of the channels param. ' +
    'Returns delivery status per channel.',
  category: 'comms',
  timeout: 45_000,
  parameters: {
    message: {
      type: 'string',
      required: true,
      description: 'Notification message text to send.',
    },
    channels: {
      type: 'array',
      required: true,
      description: 'Channels to deliver to: slack, email, sms, telegram.',
      items: {
        type: 'string',
        description: 'Channel name.',
        enum: ['slack', 'email', 'sms', 'telegram'],
      },
    },
    priority: {
      type: 'string',
      required: false,
      default: 'normal',
      enum: ['low', 'normal', 'urgent'],
      description: '"urgent" sends to ALL channels regardless of channels param.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const message = typeof params['message'] === 'string' ? params['message'].trim() : '';
    if (!message) {
      return { success: false, output: 'comms.notify: "message" is required.' };
    }

    const rawChannels = Array.isArray(params['channels']) ? params['channels'] : [];
    const priority: Priority =
      params['priority'] === 'low' || params['priority'] === 'urgent'
        ? (params['priority'] as Priority)
        : 'normal';

    const validChannels: Channel[] = (priority === 'urgent'
      ? ALL_CHANNELS
      : rawChannels.filter(
          (c): c is Channel =>
            typeof c === 'string' && ALL_CHANNELS.includes(c as Channel),
        )
    );

    if (validChannels.length === 0) {
      return {
        success: false,
        output: 'comms.notify: No valid channels specified. Use: slack, email, sms, telegram.',
      };
    }

    log.info(
      { sessionId: ctx.sessionId, channels: validChannels, priority },
      'Dispatching notification',
    );

    const results = await Promise.allSettled(
      validChannels.map(async (ch) => {
        // Guard EACH channel independently (key = notify:<channel> + message) so a
        // re-run turn can't re-deliver to a channel that already got the notice,
        // while a channel that genuinely failed still retries.
        const guard = await withCommsIdempotency(
          { channel: `notify:${ch}`, recipient: ch, body: message },
          () => DISPATCHERS[ch](message, ctx.signal),
        );
        if (guard.duplicate) {
          return { channel: ch, success: true, detail: 'duplicate suppressed (idempotency)' } as DeliveryStatus;
        }
        return { channel: ch, ...guard.result! } as DeliveryStatus;
      }),
    );

    const deliveries: DeliveryStatus[] = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        channel: validChannels[i]!,
        success: false,
        detail: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    const succeeded = deliveries.filter((d) => d.success).length;
    const failed = deliveries.filter((d) => !d.success).length;

    log.info(
      { sessionId: ctx.sessionId, succeeded, failed, deliveries },
      'Notification dispatch complete',
    );

    const summaryLines = deliveries.map(
      (d) => `  [${d.success ? 'OK' : 'FAIL'}] ${d.channel}: ${d.detail}`,
    );

    return {
      success: succeeded > 0,
      output:
        `Notification dispatched to ${validChannels.length} channel(s): ` +
        `${succeeded} succeeded, ${failed} failed.\n` +
        summaryLines.join('\n'),
      data: { deliveries, succeeded, failed, priority },
    };
  },
};

export default notificationTool;
