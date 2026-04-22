/**
 * @file channels/gmail-connector.ts
 * @description Gmail OAuth connector via vault-stored refresh token.
 *
 * Token storage: vault namespace 'gmail', mcp_server_url 'https://oauth2.googleapis.com/token'.
 * Token fields stored: refresh_token, client_id, client_secret.
 *
 * Pre-requisites (operator must complete):
 *   1. Create Google Cloud project + OAuth 2.0 client credentials.
 *   2. Complete one-time browser consent to obtain refresh_token.
 *   3. Store in vault:
 *      POST /v1/vaults/gmail/credentials
 *      { type: 'mcp_oauth', mcp_server_url: 'https://oauth2.googleapis.com/token',
 *        access_token: '<initial>', refresh_token: '<refresh>', client_id: '<id>',
 *        client_secret: '<secret>', token_url: 'https://oauth2.googleapis.com/token' }
 *
 *   NO browser consent flow is initiated by this connector.
 *   If vault token is absent → returns {success:false, output:'...'}.
 *
 * @module channels/gmail-connector
 */

import { google } from 'googleapis';
import { createLogger } from '../shared/logger.js';
import { CredentialStore } from '../security/vault-credentials.js';

const log = createLogger('channels:gmail');

const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_VAULT_NS = 'gmail';
const MISSING_CRED_MSG =
  'Google credentials not configured in vault. Store OAuth tokens via POST /v1/vaults/gmail/credentials';
const MAX_RESULTS_CAP = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  from?: string;
  subject?: string;
  date?: string;
}

export interface GmailListResult {
  success: boolean;
  messages?: GmailMessage[];
  count?: number;
  output: string;
}

export interface GmailSendResult {
  success: boolean;
  messageId?: string;
  output: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function buildOAuth2Client(signal?: AbortSignal) {
  const store = new CredentialStore(GMAIL_VAULT_NS);
  const cred = await store.getCredential(GMAIL_TOKEN_URL);
  if (!cred) return null;

  void signal; // signal is used at call sites; checked for abort before API calls

  if (!cred.client_id || !cred.client_secret || !cred.refresh_token) {
    log.warn({ credId: cred.id }, 'gmail credential missing client_id/client_secret/refresh_token');
    return null;
  }

  const auth = new google.auth.OAuth2(cred.client_id, cred.client_secret);
  auth.setCredentials({ refresh_token: cred.refresh_token });
  return auth;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List up to `maxResults` inbox messages.
 *
 * @param maxResults - Maximum messages to return (capped at 20 per spec).
 * @param signal     - Optional AbortSignal.
 * @returns Message list or not-configured error.
 */
export async function listGmailMessages(
  maxResults = 20,
  signal?: AbortSignal,
): Promise<GmailListResult> {
  const auth = await buildOAuth2Client(signal);
  if (!auth) {
    log.warn('gmail vault credential missing — listGmailMessages unavailable');
    return { success: false, output: MISSING_CRED_MSG };
  }

  try {
    const gmail = google.gmail({ version: 'v1', auth });
    const cappedMax = Math.min(maxResults, MAX_RESULTS_CAP);

    const listResp = await gmail.users.messages.list(
      { userId: 'me', maxResults: cappedMax },
      { signal },
    );

    const rawMessages = listResp.data.messages ?? [];
    const messages: GmailMessage[] = [];

    for (const msg of rawMessages) {
      if (!msg.id) continue;
      try {
        const detail = await gmail.users.messages.get(
          {
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          },
          { signal },
        );

        const headers = detail.data.payload?.headers ?? [];
        const getHeader = (name: string) =>
          headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;

        messages.push({
          id: msg.id,
          threadId: detail.data.threadId ?? msg.threadId ?? '',
          snippet: detail.data.snippet ?? '',
          from: getHeader('From'),
          subject: getHeader('Subject'),
          date: getHeader('Date'),
        });
      } catch (err: unknown) {
        log.warn({ msgId: msg.id, err: String(err) }, 'gmail: failed to fetch message detail — skipping');
      }
    }

    const count = messages.length;
    log.info({ count, maxResults: cappedMax }, 'gmail: messages listed');
    return { success: true, messages, count, output: `Listed ${count} messages` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'gmail: listGmailMessages failed');
    return { success: false, output: 'Gmail operation failed. Contact your administrator if this persists.' };
  }
}

/**
 * Send an email via Gmail API.
 *
 * @param to      - Recipient email address.
 * @param subject - Email subject line.
 * @param body    - Plain-text email body.
 * @param signal  - Optional AbortSignal.
 * @returns Send result with message ID or error.
 */
export async function sendGmailMessage(
  to: string,
  subject: string,
  body: string,
  signal?: AbortSignal,
): Promise<GmailSendResult> {
  if (!to || !subject || !body) {
    return {
      success: false,
      output: 'gmail-connector: to, subject, and body are required',
    };
  }

  const auth = await buildOAuth2Client(signal);
  if (!auth) {
    log.warn('gmail vault credential missing — sendGmailMessage unavailable');
    return { success: false, output: MISSING_CRED_MSG };
  }

  try {
    const gmail = google.gmail({ version: 'v1', auth });

    // Build RFC 2822 email string
    const rfc2822 = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=UTF-8',
      'MIME-Version: 1.0',
      '',
      body,
    ].join('\r\n');

    // Base64url-encode (Node 22 native Buffer support)
    const encoded = Buffer.from(rfc2822).toString('base64url');

    const sendResp = await gmail.users.messages.send(
      { userId: 'me', requestBody: { raw: encoded } },
      { signal },
    );

    const messageId = sendResp.data.id ?? undefined;
    log.info({ to, subject: subject.slice(0, 50), messageId }, 'gmail: message sent');
    return { success: true, messageId, output: 'Message sent' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, to }, 'gmail: sendGmailMessage failed');
    return { success: false, output: 'Gmail operation failed. Contact your administrator if this persists.' };
  }
}
