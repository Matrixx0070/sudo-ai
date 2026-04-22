/**
 * PhoneCallManager — outbound/inbound call orchestration via Twilio REST API.
 *
 * Uses raw fetch only — no Twilio SDK dependency.
 * Reads TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER from env.
 * Gracefully unavailable when credentials are missing.
 *
 * Call state machine: initiated → ringing → answered → active → completed
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('voice:phone-call');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CallState = 'initiated' | 'ringing' | 'answered' | 'active' | 'completed' | 'failed';

export interface CallRecord {
  sid: string;
  to: string;
  from: string;
  state: CallState;
  startedAt: Date;
  endedAt?: Date;
  durationSec?: number;
}

export interface IncomingCallPayload {
  callSid: string;
  from: string;
  to: string;
  callStatus: string;
  transcriptionText?: string;
}

export type IncomingCallHandler = (payload: IncomingCallPayload) => Promise<string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Twilio REST API base URL for the given account SID. */
function twilioApiUrl(accountSid: string, resource: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/${resource}.json`;
}

/** Build Basic Auth header from Twilio credentials. */
function basicAuth(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

/** Generate minimal TwiML that speaks a message, records, and transcribes. */
function buildTwiML(message: string, actionUrl?: string): string {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const recordAction = actionUrl ? ` action="${actionUrl}"` : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say voice="Polly.Joanna">${escaped}</Say>`,
    `  <Record maxLength="30" transcribe="true"${recordAction} />`,
    '</Response>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// PhoneCallManager
// ---------------------------------------------------------------------------

export class PhoneCallManager {
  private readonly accountSid: string | undefined;
  private readonly authToken: string | undefined;
  private readonly fromNumber: string | undefined;
  readonly available: boolean;

  private readonly callHistory: CallRecord[] = [];
  private incomingHandler: IncomingCallHandler | null = null;

  constructor() {
    this.accountSid = process.env['TWILIO_ACCOUNT_SID'];
    this.authToken = process.env['TWILIO_AUTH_TOKEN'];
    this.fromNumber = process.env['TWILIO_PHONE_NUMBER'];

    this.available = Boolean(this.accountSid && this.authToken && this.fromNumber);

    if (this.available) {
      log.info({ from: this.fromNumber }, 'PhoneCallManager ready');
    } else {
      log.warn('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER not set — phone calls unavailable');
    }
  }

  // -------------------------------------------------------------------------
  // Outbound calls
  // -------------------------------------------------------------------------

  /**
   * Initiate an outbound call to `to` and speak `message` via TwiML.
   *
   * @param to      - E.164 destination number e.g. "+14155552671".
   * @param message - Text to say via TTS on connect.
   * @param twimlUrl - Optional override URL for TwiML. Defaults to inline TwiML.
   * @returns The created CallRecord.
   */
  async makeCall(to: string, message: string, twimlUrl?: string): Promise<CallRecord> {
    this._requireAvailable();

    if (!to || !/^\+\d{7,15}$/.test(to)) {
      throw new TypeError(`PhoneCallManager.makeCall: invalid E.164 number "${to}"`);
    }
    if (!message) {
      throw new TypeError('PhoneCallManager.makeCall: message must not be empty');
    }

    log.info({ to, messageLen: message.length }, 'Initiating outbound call');

    const body = new URLSearchParams({
      To: to,
      From: this.fromNumber!,
      ...(twimlUrl
        ? { Url: twimlUrl }
        : { Twiml: buildTwiML(message) }),
    });

    let resp: Response;
    try {
      resp = await fetch(twilioApiUrl(this.accountSid!, 'Calls'), {
        method: 'POST',
        headers: {
          Authorization: basicAuth(this.accountSid!, this.authToken!),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
    } catch (err) {
      log.error({ err, to }, 'Twilio makeCall network error');
      throw new Error(`Twilio makeCall network error: ${String(err)}`);
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      log.error({ status: resp.status, body: errBody, to }, 'Twilio makeCall API error');
      throw new Error(`Twilio makeCall error ${resp.status}: ${errBody}`);
    }

    const json = await resp.json() as { sid: string; status: string };

    const record: CallRecord = {
      sid: json.sid,
      to,
      from: this.fromNumber!,
      state: this._mapTwilioStatus(json.status),
      startedAt: new Date(),
    };

    this.callHistory.unshift(record);
    if (this.callHistory.length > 200) this.callHistory.length = 200;

    log.info({ sid: record.sid, to, state: record.state }, 'Outbound call initiated');
    return record;
  }

  // -------------------------------------------------------------------------
  // Incoming calls
  // -------------------------------------------------------------------------

  /**
   * Register a handler for incoming call webhook payloads.
   * The handler returns TwiML XML to send back to Twilio.
   *
   * @param handler - Async function that receives the payload and returns TwiML.
   */
  onIncomingCall(handler: IncomingCallHandler): void {
    this.incomingHandler = handler;
    log.info('Incoming call handler registered');
  }

  /**
   * Process a raw incoming Twilio webhook POST body (application/x-www-form-urlencoded).
   * Returns TwiML XML string to send as HTTP response.
   *
   * @param rawBody - URL-encoded body string from Twilio webhook.
   * @returns TwiML XML string.
   */
  async handleIncomingWebhook(rawBody: string): Promise<string> {
    if (!rawBody) {
      log.warn('handleIncomingWebhook: empty body');
      return buildTwiML('Sorry, there was an error processing your call.');
    }

    const params = new URLSearchParams(rawBody);
    const payload: IncomingCallPayload = {
      callSid: params.get('CallSid') ?? '',
      from: params.get('From') ?? '',
      to: params.get('To') ?? '',
      callStatus: params.get('CallStatus') ?? '',
      transcriptionText: params.get('TranscriptionText') ?? undefined,
    };

    log.info({ callSid: payload.callSid, from: payload.from, status: payload.callStatus }, 'Incoming call webhook received');

    const record: CallRecord = {
      sid: payload.callSid,
      to: payload.to,
      from: payload.from,
      state: this._mapTwilioStatus(payload.callStatus),
      startedAt: new Date(),
    };
    this.callHistory.unshift(record);
    if (this.callHistory.length > 200) this.callHistory.length = 200;

    if (!this.incomingHandler) {
      log.warn('No incoming call handler registered — returning default TwiML');
      return buildTwiML('Hello, this is SUDO-AI. No handler is registered. Goodbye.');
    }

    try {
      return await this.incomingHandler(payload);
    } catch (err) {
      log.error({ err, callSid: payload.callSid }, 'Incoming call handler threw');
      return buildTwiML('An error occurred. Please try again later.');
    }
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /**
   * Return recent call records (newest first).
   *
   * @param limit - Max records to return (default 50).
   */
  getCallHistory(limit = 50): CallRecord[] {
    return this.callHistory.slice(0, Math.max(1, limit));
  }

  // -------------------------------------------------------------------------
  // TwiML helpers (public for use in webhook handlers)
  // -------------------------------------------------------------------------

  /** Generate a TwiML response string directly. */
  generateTwiML(message: string, actionUrl?: string): string {
    return buildTwiML(message, actionUrl);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _requireAvailable(): void {
    if (!this.available) {
      throw new Error('PhoneCallManager: Twilio credentials not configured');
    }
  }

  private _mapTwilioStatus(status: string): CallState {
    switch (status?.toLowerCase()) {
      case 'queued':
      case 'initiated': return 'initiated';
      case 'ringing': return 'ringing';
      case 'in-progress': return 'active';
      case 'answered': return 'answered';
      case 'completed': return 'completed';
      case 'busy':
      case 'no-answer':
      case 'canceled':
      case 'failed': return 'failed';
      default: return 'initiated';
    }
  }
}
