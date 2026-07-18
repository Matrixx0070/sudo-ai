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
 * OAuth/vault-backed connectors (5):
 *   comms.github-notify — GitHub unread notifications (PAT from vault or GITHUB_TOKEN)
 */

import type { ToolRegistry } from '../../registry.js';
import { emailTool } from './email-sender.js';
import { slackTool } from './slack.js';
import { smsTool } from './sms.js';
import { webhookTool } from './webhook.js';
import { notificationTool } from './notification.js';
import { voiceTool } from './voice.js';
// OAuth/vault-backed connector tools
import { githubNotifyTool } from './github-notify.js';
import { emailSearchTool, emailReadTool, emailReplyTool } from './email-inbox.js';

/** All comms tools in a stable order. */
export const COMMS_TOOLS = [
  emailTool,
  slackTool,
  smsTool,
  webhookTool,
  notificationTool,
  voiceTool,
  // OAuth/vault-backed connectors
  githubNotifyTool,
  // Email inbox (Spec 5) — IMAP search/read + draft-default reply
  emailSearchTool,
  emailReadTool,
  emailReplyTool,
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
  githubNotifyTool,
  emailSearchTool, emailReadTool, emailReplyTool,
};
