/**
 * comms.sms — Send SMS via Twilio REST API using native fetch.
 *
 * Env vars required:
 *   TWILIO_ACCOUNT_SID    — Twilio Account SID (starts with AC)
 *   TWILIO_AUTH_TOKEN     — Twilio Auth Token
 *   TWILIO_PHONE_NUMBER   — Your Twilio phone number (E.164 format)
 *
 * Returns: { sid, status } on success.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { isCommsIdempotencyEnabled, getCommsIdempotencyStore } from '../../../comms/idempotency.js';
import { toolFetch } from '../../../security/guarded-fetch.js';

const log = createLogger('comms:sms');

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal E.164 phone number validation (+ followed by 7–15 digits). */
function isValidPhone(number: string): boolean {
  return /^\+\d{7,15}$/.test(number);
}

async function twilioSend(
  accountSid: string,
  authToken: string,
  from: string,
  to: string,
  body: string,
  signal?: AbortSignal,
): Promise<{ sid: string; status: string }> {
  const url = `${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const formBody = new URLSearchParams({ From: from, To: to, Body: body });

  const res = await toolFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody.toString(),
    signal,
  });

  const json = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    const twilioMessage = typeof json['message'] === 'string' ? json['message'] : res.statusText;
    const twilioCode = typeof json['code'] === 'number' ? ` (code ${json['code']})` : '';
    throw new Error(`Twilio HTTP ${res.status}: ${twilioMessage}${twilioCode}`);
  }

  return {
    sid: String(json['sid'] ?? ''),
    status: String(json['status'] ?? 'unknown'),
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const smsTool: ToolDefinition = {
  name: 'comms.sms',
  description:
    'Send an SMS via Twilio REST API. ' +
    'Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER env vars. ' +
    'Phone numbers must be in E.164 format (e.g. +14155551234).',
  category: 'comms',
  timeout: 20_000,
  parameters: {
    to: {
      type: 'string',
      required: true,
      description: 'Recipient phone number in E.164 format (e.g. +14155551234).',
    },
    body: {
      type: 'string',
      required: true,
      description: 'SMS message text (max 1600 characters).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const accountSid = process.env['TWILIO_ACCOUNT_SID'];
    const authToken = process.env['TWILIO_AUTH_TOKEN'];
    const from = process.env['TWILIO_PHONE_NUMBER'];

    if (!accountSid || !authToken || !from) {
      const missing = [
        !accountSid && 'TWILIO_ACCOUNT_SID',
        !authToken && 'TWILIO_AUTH_TOKEN',
        !from && 'TWILIO_PHONE_NUMBER',
      ]
        .filter(Boolean)
        .join(', ');
      log.error({ sessionId: ctx.sessionId, missing }, 'Twilio env vars not set');
      return {
        success: false,
        output: `comms.sms: Missing required env vars: ${missing}.`,
      };
    }

    const to = typeof params['to'] === 'string' ? params['to'].trim() : '';
    const body = typeof params['body'] === 'string' ? params['body'] : '';

    if (!to) {
      return { success: false, output: 'comms.sms: "to" parameter is required.' };
    }
    if (!isValidPhone(to)) {
      return {
        success: false,
        output: `comms.sms: Invalid phone number "${to}". Use E.164 format (e.g. +14155551234).`,
      };
    }
    if (!body) {
      return { success: false, output: 'comms.sms: "body" parameter is required.' };
    }
    if (body.length > 1600) {
      return {
        success: false,
        output: `comms.sms: Message body exceeds 1600 characters (got ${body.length}).`,
      };
    }

    // Idempotency guard (opt-in): never re-send an identical SMS to the same
    // number on a task re-dispatch within the dedup window.
    const idemOn = isCommsIdempotencyEnabled();
    let idemKey: string | undefined;
    if (idemOn) {
      const claim = getCommsIdempotencyStore().begin({ channel: 'sms', recipient: to, body });
      idemKey = claim.key;
      if (claim.duplicate) {
        log.warn({ sessionId: ctx.sessionId, to, key: idemKey }, 'comms.sms: duplicate suppressed (idempotency)');
        const priorNote = claim.messageId ? ` Prior SID: ${claim.messageId}.` : '';
        return {
          success: true,
          output: `comms.sms: duplicate suppressed — an identical SMS to ${to} was already sent within the idempotency window.${priorNote}`,
          data: { to, from, duplicate: true, sid: claim.messageId },
        };
      }
    }

    try {
      const result = await twilioSend(accountSid, authToken, from, to, body, ctx.signal);
      if (idemOn && idemKey) getCommsIdempotencyStore().confirm(idemKey, result.sid);

      log.info(
        { sessionId: ctx.sessionId, to, sid: result.sid, status: result.status },
        'SMS sent',
      );

      return {
        success: true,
        output: `SMS sent to ${to}. SID: ${result.sid}, status: ${result.status}.`,
        data: { sid: result.sid, status: result.status, to, from },
      };
    } catch (err) {
      if (idemOn && idemKey) getCommsIdempotencyStore().release(idemKey); // allow retry of a genuine failure
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId: ctx.sessionId, to, err }, 'Failed to send SMS');
      return { success: false, output: `comms.sms error: ${msg}` };
    }
  },
};

export default smsTool;
