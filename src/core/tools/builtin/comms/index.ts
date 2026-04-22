/**
 * Communications toolkit — registers all comms tools into the ToolRegistry.
 *
 * Tools provided (original 6):
 *   comms.email   — Send emails via SMTP (nodemailer, Gmail shortcut)
 *   comms.slack   — Slack Web API: send, read, list-channels
 *   comms.sms     — Send SMS via Twilio REST API
 *   comms.webhook — Send/register/list HTTP webhooks
 *   comms.notify  — Unified multi-channel notification dispatcher
 *   comms.voice   — Text-to-speech (TTS) and speech-to-text (STT) via OpenAI
 *
 * Wave 10 connectors (5 new):
 *   comms.gmail        — Gmail OAuth (requires googleapis + vault token)
 *   comms.gcalendar    — Google Calendar OAuth (requires googleapis + vault token)
 *   comms.github-notify — GitHub unread notifications (PAT from vault or GITHUB_TOKEN)
 *   comms.slack-rt     — Slack Bot Token via vault (chat.postMessage)
 *   comms.imessage     — iMessage read-only (macOS only, chat.db)
 */

import type { ToolRegistry } from '../../registry.js';
import { emailTool } from './email-sender.js';
import { slackTool } from './slack.js';
import { smsTool } from './sms.js';
import { webhookTool } from './webhook.js';
import { notificationTool } from './notification.js';
import { voiceTool } from './voice.js';
// Wave 10 connector tools
import { gmailTool } from './gmail.js';
import { gcalendarTool } from './gcalendar.js';
import { githubNotifyTool } from './github-notify.js';
import { slackRtTool } from './slack-rt.js';
import { imessageTool } from './imessage.js';

/** All comms tools in a stable order. */
export const COMMS_TOOLS = [
  emailTool,
  slackTool,
  smsTool,
  webhookTool,
  notificationTool,
  voiceTool,
  // Wave 10 connectors
  gmailTool,
  gcalendarTool,
  githubNotifyTool,
  slackRtTool,
  imessageTool,
] as const;

/**
 * Register all Communications tools into the provided registry.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerCommsTools(registry: ToolRegistry): void {
  registry.registerMany([...COMMS_TOOLS]);
}

// Named re-exports for consumers that import individual tools.
export {
  emailTool, slackTool, smsTool, webhookTool, notificationTool, voiceTool,
  gmailTool, gcalendarTool, githubNotifyTool, slackRtTool, imessageTool,
};
