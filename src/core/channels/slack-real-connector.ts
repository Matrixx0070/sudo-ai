/**
 * @file channels/slack-real-connector.ts
 * @description Real Slack Bot Token connector via vault-stored token.
 *
 * Token source: vault namespace 'slack', mcp_server_url 'https://slack.com/api'.
 * Falls back to SLACK_BOT_TOKEN env var if vault not configured.
 *
 * Operations:
 *   postMessage  — chat.postMessage to a channel
 *
 * Uses raw Node fetch only (zero new deps). Separate from the existing
 * comms/slack.ts tool which reads from SLACK_TOKEN env var.
 *
 * Setup:
 *   POST /v1/vaults/slack/credentials
 *   { type: 'static_bearer', mcp_server_url: 'https://slack.com/api', token: 'xoxb-...' }
 *   OR set SLACK_BOT_TOKEN env var.
 *
 * @module channels/slack-real-connector
 */

import { createLogger } from '../shared/logger.js';
import { CredentialStore } from '../security/vault-credentials.js';
import { resolveEnvSecret } from '../secrets/secret-ref.js';

const log = createLogger('channels:slack-real');

const SLACK_API = 'https://slack.com/api';
const SLACK_VAULT_NS = 'slack';
const SLACK_VAULT_URL = 'https://slack.com/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackPostResult {
  success: boolean;
  ts?: string;
  channel?: string;
  output: string;
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

async function resolveToken(): Promise<string | null> {
  // 1. Vault-first
  try {
    const store = new CredentialStore(SLACK_VAULT_NS);
    const cred = await store.getCredential(SLACK_VAULT_URL);
    if (cred?.token) return cred.token;
    if (cred?.access_token) return cred.access_token;
  } catch {
    // Vault unavailable — fall through to env
  }

  // 2. Env fallback
  const envToken = resolveEnvSecret('SLACK_BOT_TOKEN') ?? resolveEnvSecret('SLACK_TOKEN') ?? undefined;
  if (envToken) return envToken;

  return null;
}

// ---------------------------------------------------------------------------
// Slack API helpers
// ---------------------------------------------------------------------------

async function slackPost(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API}/${endpoint}`, {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Post a message to a Slack channel via chat.postMessage.
 *
 * @param channelId - Slack channel ID (e.g. C01234ABCD). Channel names not supported.
 * @param text      - Message text (plain text or Slack mrkdwn format).
 * @param signal    - Optional AbortSignal for timeout.
 * @returns Post result with timestamp or error.
 */
export async function slackPostMessage(
  channelId: string,
  text: string,
  signal?: AbortSignal,
): Promise<SlackPostResult> {
  if (!channelId || typeof channelId !== 'string') {
    return { success: false, output: 'slack-real: channelId is required' };
  }
  if (!text || typeof text !== 'string') {
    return { success: false, output: 'slack-real: text is required' };
  }

  const token = await resolveToken();
  if (!token) {
    return {
      success: false,
      output: 'Slack not configured — set SLACK_BOT_TOKEN env var or store token in vault (namespace: slack, url: https://slack.com/api)',
    };
  }

  try {
    const data = await slackPost(
      'chat.postMessage',
      token,
      { channel: channelId, text },
      signal,
    );

    const ts = String(data['ts'] ?? '');
    log.info({ channelId, ts }, 'Slack message posted via vault token');

    return {
      success: true,
      ts,
      channel: channelId,
      output: `Message posted to ${channelId}. Timestamp: ${ts}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ channelId, err: msg }, 'Slack postMessage failed');
    return { success: false, output: `slack-real-connector error: ${msg}` };
  }
}
