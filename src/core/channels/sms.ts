/**
 * @file sms.ts
 * @description SMS channel adapter: Twilio inbound webhook + REST outbound.
 *
 * Env vars:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   TWILIO_WEBHOOK_PORT (default 3012), TWILIO_WEBHOOK_SECRET
 *   SMS_ALLOWED_NUMBERS (comma-separated E.164)
 *
 * Vault-first: start() calls vault.get('channels', 'TWILIO_AUTH_TOKEN') first,
 * and vault.get('channels', 'TWILIO_WEBHOOK_SECRET') first, both falling back
 * to process.env. This is load-bearing.
 *
 * Security: TWILIO_AUTH_TOKEN is NEVER logged. Only last 4 chars of account SID
 * are logged. Signature validation uses twilio.validateRequest (timing-safe).
 */

import http from 'node:http';
import { URLSearchParams } from 'node:url';
import twilio from 'twilio';
import { createLogger } from '../shared/index.js';
import { ChannelError } from '../shared/index.js';
import { vault } from '../security/vault.js';
import { rateLimiter } from './rate-limit.js';
import type { ChannelAdapter } from './adapter.js';
import type {
  ChannelType,
  MessageHandler,
  SendOptions,
  UnifiedMessage,
} from './types.js';
import type { HookContext, HookEvent } from '../hooks/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HookEmitterLike {
  emit(event: HookEvent, context: HookContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Vault-first secret loader
// ---------------------------------------------------------------------------

async function vaultOrEnv(
  vaultKey: string,
  envKey: string,
  requester: string,
): Promise<string | undefined> {
  try {
    const result = await vault.get('channels', vaultKey, requester);
    if (result) return result.value;
  } catch {
    /* not in vault or vault not configured — fall through to env */
  }
  return process.env[envKey];
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger('channels:sms');

// ---------------------------------------------------------------------------
// SmsAdapter
// ---------------------------------------------------------------------------

export class SmsAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'sms';

  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private _hooks: HookEmitterLike | null = null;
  private _server: http.Server | null = null;
  private _twilioClient: ReturnType<typeof twilio> | null = null;
  private _authToken: string | null = null;
  private _webhookSecret: string | null = null;
  private readonly _allowedNumbers: Set<string>;
  // Replay protection: MessageSid -> expiry timestamp (ms)
  private _seenSids = new Map<string, number>();

  constructor() {
    const rawAllowed = process.env['SMS_ALLOWED_NUMBERS'] ?? '';
    this._allowedNumbers = new Set(
      rawAllowed
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  setHookEmitter(hooks: HookEmitterLike): void {
    this._hooks = hooks;
  }

  private async _safeEmit(
    event: HookEvent,
    context: Omit<HookContext, 'event'>,
  ): Promise<void> {
    if (!this._hooks) return;
    try {
      await this._hooks.emit(event, { event, ...context } as HookContext);
    } catch (err) {
      log.warn({ event, err: String(err) }, 'SMS hook emission failed — continuing');
    }
  }

  /** Returns false if sid was seen within the last 5 minutes (replay). */
  private _recordSid(sid: string): boolean {
    const now = Date.now();
    // Prune expired entries.
    for (const [s, exp] of this._seenSids) {
      if (exp < now) this._seenSids.delete(s);
    }
    if (this._seenSids.has(sid)) return false; // replay
    this._seenSids.set(sid, now + 300_000); // 5 min TTL
    return true;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._isConnected) {
      log.warn('SmsAdapter already connected — skipping start');
      return;
    }

    const accountSid = process.env['TWILIO_ACCOUNT_SID'];
    if (!accountSid) {
      throw new ChannelError(
        'TWILIO_ACCOUNT_SID is required to start SmsAdapter',
        'channel_auth_missing',
        { envKey: 'TWILIO_ACCOUNT_SID' },
      );
    }

    // Vault-first for auth token — NEVER log the token value.
    const authToken = await vaultOrEnv(
      'TWILIO_AUTH_TOKEN',
      'TWILIO_AUTH_TOKEN',
      'sms-adapter',
    );
    if (!authToken) {
      throw new ChannelError(
        'TWILIO_AUTH_TOKEN not found in vault or env',
        'channel_auth_missing',
        { envKey: 'TWILIO_AUTH_TOKEN' },
      );
    }

    // Vault-first for webhook secret.
    const webhookSecret = await vaultOrEnv(
      'TWILIO_WEBHOOK_SECRET',
      'TWILIO_WEBHOOK_SECRET',
      'sms-adapter',
    );

    this._authToken = authToken;
    this._webhookSecret = webhookSecret ?? authToken;

    if (!this._webhookSecret) {
      throw new ChannelError(
        'TWILIO_WEBHOOK_SECRET resolved to empty — refusing to start',
        'channel_auth_missing',
        {},
      );
    }

    // Log only last 4 chars of accountSid — never log authToken.
    const sidTail = accountSid.slice(-4);
    log.info({ sidTail }, 'Initializing Twilio REST client');

    this._twilioClient = twilio(accountSid, authToken);

    const webhookPort = parseInt(
      process.env['TWILIO_WEBHOOK_PORT'] ?? '3012',
      10,
    );

    this._server = http.createServer((req, res) => {
      void this._handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this._server!.once('error', reject);
      this._server!.listen(webhookPort, () => resolve());
    });

    this._isConnected = true;
    log.info({ webhookPort, sidTail }, 'SmsAdapter started — webhook listening');
  }

  async stop(): Promise<void> {
    this._isConnected = false;
    if (this._server) {
      await new Promise<void>((resolve) => {
        this._server!.close(() => resolve());
      });
      this._server = null;
      log.info('SMS webhook server closed');
    }
    this._twilioClient = null;
    this._authToken = null;
    this._webhookSecret = null;
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async send(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    if (!this._twilioClient) {
      throw new ChannelError('SmsAdapter not connected', 'channel_not_connected', { peerId });
    }
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }

    const from = process.env['TWILIO_FROM_NUMBER'];
    if (!from) {
      throw new ChannelError(
        'TWILIO_FROM_NUMBER is required to send SMS',
        'channel_auth_missing',
        {},
      );
    }

    try {
      await this._twilioClient.messages.create({ from, to: peerId, body: text });
      log.debug({ peerId }, 'SMS sent');
      void this._safeEmit('message:sent', {
        channel: 'sms',
        meta: { peerId },
      });
    } catch (err) {
      log.error({ peerId, err: String(err) }, 'SMS send failed');
      throw new ChannelError('Failed to send SMS', 'channel_send_failed', {
        peerId,
        cause: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: HTTP webhook handler
  // ---------------------------------------------------------------------------

  private async _handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    // Read raw body (64 KB cap to prevent memory exhaustion).
    const MAX_BODY = 65_536;
    let rawBody = '';
    try {
      rawBody = await new Promise<string>((resolve, reject) => {
        let totalBytes = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_BODY) {
            req.destroy();
            reject(new Error('body too large'));
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to read SMS webhook body');
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    // Validate Twilio signature.
    const signature = (req.headers['x-twilio-signature'] as string) ?? '';
    const host = req.headers['host'] ?? 'localhost';
    // NOTE (INFO): x-forwarded-proto is trusted as-is here. Operators SHOULD set
    // TWILIO_WEBHOOK_URL to the canonical https:// URL or front this service with
    // a trusted reverse proxy that enforces the header. Without it, a local attacker
    // could forge the proto field to manipulate the signature URL.
    const proto = req.headers['x-forwarded-proto'] ?? 'http';
    const url = `${proto}://${host}${req.url ?? '/'}`;

    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(rawBody)) {
      params[k] = v;
    }

    const secret = this._webhookSecret;
    if (!secret) {
      res.writeHead(500); res.end('Internal Server Error'); return;
    }
    const isValid = twilio.validateRequest(secret, signature, url, params);
    if (!isValid) {
      log.warn({ url }, 'SMS webhook signature validation failed — rejecting');
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const peerId = params['From'] ?? '';
    if (!peerId) {
      log.warn('SMS webhook missing From field');
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    if (this._allowedNumbers.size > 0 && !this._allowedNumbers.has(peerId)) {
      log.debug({ peerId }, 'SMS from non-allowed number — ignored');
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const rl = await rateLimiter.check('sms', peerId);
    if (!rl.allowed) {
      log.warn({ peerId, retryAfterMs: rl.retryAfterMs }, 'SMS rate limit exceeded');
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too Many Requests');
      return;
    }

    const body = params['Body'] ?? '';
    const msgSid = params['MessageSid'] ?? String(Date.now());

    // Replay protection: silently 200 duplicate MessageSids within 5-min window.
    if (!this._recordSid(msgSid)) {
      log.debug({ peerId, msgSid }, 'SMS replay detected — ignoring duplicate');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response></Response>');
      return;
    }

    const unified: UnifiedMessage = {
      id: msgSid,
      channel: 'sms',
      peerId,
      peerName: peerId,
      chatType: 'dm',
      text: body,
      timestamp: new Date(),
    };

    log.debug({ peerId, bodyLen: body.length }, 'Inbound SMS received');

    void this._safeEmit('message:received', {
      channel: 'sms',
      meta: { peerId },
    });

    // Respond 200 immediately before dispatching to avoid Twilio timeout.
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end('<Response></Response>');

    await this._dispatch(unified);
  }

  private async _dispatch(msg: UnifiedMessage): Promise<void> {
    if (!this._handler) {
      log.warn({ peerId: msg.peerId }, 'No handler registered — SMS dropped');
      return;
    }
    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ peerId: msg.peerId, err: String(err) }, 'SMS message handler error');
    }
  }
}
