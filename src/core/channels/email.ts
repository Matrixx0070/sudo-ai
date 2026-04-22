/**
 * @file email.ts
 * @description Email channel adapter: IMAP inbound (imapflow) + SMTP outbound (nodemailer).
 *
 * Env vars:
 *   EMAIL_IMAP_HOST, EMAIL_IMAP_PORT (default 993), EMAIL_IMAP_USER, EMAIL_IMAP_PASS
 *   EMAIL_SMTP_HOST, EMAIL_SMTP_PORT (default 587), EMAIL_SMTP_USER, EMAIL_SMTP_PASS
 *   EMAIL_SMTP_FROM, EMAIL_ALLOWED_SENDERS (comma-separated)
 *
 * Vault-first: start() calls vault.get('channels', '<key>') first for IMAP_PASS and
 * SMTP_PASS, falling back to process.env. This is load-bearing for Wave 4.
 */

import { ImapFlow } from 'imapflow';
import type { ParsedMail } from 'mailparser';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
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

const log = createLogger('channels:email');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an email address for allowlist/rate-limit keying.
 * Strips plus-tags (e.g. user+tag@example.com → user@example.com) and lowercases.
 * This collapses common sub-addressing aliases into a single canonical form so that
 * a+1@x.com and a+2@x.com share the same rate-limit bucket.
 */
function normalizeEmail(addr: string): string {
  const parts = addr.toLowerCase().split('@');
  if (parts.length !== 2) return addr.toLowerCase();
  return `${parts[0].split('+')[0]}@${parts[1]}`;
}

// ---------------------------------------------------------------------------
// EmailAdapter
// ---------------------------------------------------------------------------

export class EmailAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'email';

  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private _hooks: HookEmitterLike | null = null;
  private _imap: ImapFlow | null = null;
  private _transport: nodemailer.Transporter | null = null;
  private readonly _allowedSenders: Set<string>;

  constructor() {
    const rawAllowed = process.env['EMAIL_ALLOWED_SENDERS'] ?? '';
    this._allowedSenders = new Set(
      rawAllowed
        .split(',')
        .map((s) => normalizeEmail(s.trim()))
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
      log.warn({ event, err: String(err) }, 'Email hook emission failed — continuing');
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._isConnected) {
      log.warn('EmailAdapter already connected — skipping start');
      return;
    }

    const imapUser = process.env['EMAIL_IMAP_USER'];
    if (!imapUser) {
      throw new ChannelError(
        'EMAIL_IMAP_USER is required to start EmailAdapter',
        'channel_auth_missing',
        { envKey: 'EMAIL_IMAP_USER' },
      );
    }

    const imapPass = await vaultOrEnv('EMAIL_IMAP_PASS', 'EMAIL_IMAP_PASS', 'email-adapter');
    if (!imapPass) {
      throw new ChannelError(
        'EMAIL_IMAP_PASS not found in vault or env',
        'channel_auth_missing',
        { envKey: 'EMAIL_IMAP_PASS' },
      );
    }

    const smtpPass = await vaultOrEnv('EMAIL_SMTP_PASS', 'EMAIL_SMTP_PASS', 'email-adapter');

    const imapHost = process.env['EMAIL_IMAP_HOST'] ?? 'localhost';
    const imapPort = parseInt(process.env['EMAIL_IMAP_PORT'] ?? '993', 10);

    const smtpHost = process.env['EMAIL_SMTP_HOST'] ?? 'localhost';
    const smtpPort = parseInt(process.env['EMAIL_SMTP_PORT'] ?? '587', 10);
    const smtpUser = process.env['EMAIL_SMTP_USER'] ?? imapUser;
    const smtpFrom = process.env['EMAIL_SMTP_FROM'] ?? imapUser;

    // Build SMTP transport.
    // requireTLS forces STARTTLS on port 587; secure:true handles port 465 (implicit TLS).
    this._transport = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      requireTLS: smtpPort !== 465,
      auth: {
        user: smtpUser,
        pass: smtpPass ?? '',
      },
    });

    // IMAP TLS enforcement.
    if (imapPort !== 993 && imapPort !== 143) {
      log.warn({ imapPort }, 'IMAP port is not 993 (implicit TLS) or 143 (STARTTLS) — verify TLS config');
    }
    if (imapPort === 143 && process.env['EMAIL_IMAP_ALLOW_INSECURE'] !== '1') {
      throw new ChannelError(
        'IMAP port 143 (plaintext) refused. Set EMAIL_IMAP_ALLOW_INSECURE=1 to override.',
        'channel_auth_missing',
        { imapPort },
      );
    }

    // Build IMAP client.
    this._imap = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: imapPort === 993,
      tls: { rejectUnauthorized: true },
      auth: {
        user: imapUser,
        pass: imapPass,
      },
      logger: false,
    });

    this._imap.on('error', (err: Error) => {
      log.error({ err: String(err) }, 'IMAP connection error');
    });

    try {
      await this._imap.connect();
    } catch (err) {
      throw new ChannelError('Failed to connect to IMAP server', 'channel_start_failed', {
        host: imapHost,
        cause: String(err),
      });
    }

    this._isConnected = true;
    log.info({ imapHost, imapUser }, 'EmailAdapter connected');

    // Start listening in background — not awaited.
    void this._listenIdle(smtpFrom);
  }

  async stop(): Promise<void> {
    this._isConnected = false;
    if (this._imap) {
      try {
        await this._imap.logout();
        log.info('IMAP client logged out');
      } catch (err) {
        log.error({ err: String(err) }, 'IMAP logout error (ignored)');
      } finally {
        this._imap = null;
      }
    }
    if (this._transport) {
      this._transport.close();
      this._transport = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async send(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    if (!this._transport) {
      throw new ChannelError('EmailAdapter transport not initialized', 'channel_not_connected', {
        peerId,
      });
    }
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }

    const from = process.env['EMAIL_SMTP_FROM'];
    if (!from) {
      throw new ChannelError(
        'EMAIL_SMTP_FROM is required to send email',
        'channel_auth_missing',
        {},
      );
    }

    try {
      await this._transport.sendMail({ from, to: peerId, text });
      log.debug({ peerId }, 'Email sent');
      void this._safeEmit('message:sent', {
        channel: 'email',
        meta: { peerId },
      });
    } catch (err) {
      log.error({ peerId, err: String(err) }, 'Email send failed');
      throw new ChannelError('Failed to send email', 'channel_send_failed', {
        peerId,
        cause: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: IMAP IDLE listener
  // ---------------------------------------------------------------------------

  private async _listenIdle(_from: string): Promise<void> {
    const imap = this._imap;
    if (!imap) return;

    try {
      await imap.mailboxOpen('INBOX');

      // Loop: wait for new messages, process each, repeat.
      while (this._isConnected && imap) {
        // idle() resolves when new messages arrive or when stop() is called.
        await imap.idle();
        if (!this._isConnected) break;

        // Fetch unseen messages after IDLE notification.
        for await (const msg of imap.fetch({ seen: false }, { source: true })) {
          try {
            if (!msg.source) continue;
            const parsed: ParsedMail = await simpleParser(msg.source as Buffer);
            const fromAddr = parsed.from?.value?.[0]?.address;
            if (!fromAddr) continue;
            const peerId = fromAddr.toLowerCase();
            // Normalize for allowlist and rate-limit (strips plus-tags).
            // SECURITY NOTE: EMAIL_ALLOWED_SENDERS is only trustworthy when the
            // receiving MTA enforces DKIM/SPF. Without those checks an attacker
            // can spoof the From header and bypass this allowlist.
            const peerKey = normalizeEmail(peerId);

            if (this._allowedSenders.size > 0 && !this._allowedSenders.has(peerKey)) {
              log.debug({ peerId }, 'Email from non-allowed sender — ignored');
              continue;
            }

            const rl = await rateLimiter.check('email', peerKey);
            if (!rl.allowed) {
              log.warn({ peerId, retryAfterMs: rl.retryAfterMs }, 'Email rate limit exceeded');
              continue;
            }

            const unified: UnifiedMessage = {
              id: String(msg.uid ?? Date.now()),
              channel: 'email',
              peerId,
              peerName: parsed.from?.value?.[0]?.name ?? peerId,
              chatType: 'dm',
              text: parsed.text ?? '',
              timestamp: parsed.date ?? new Date(),
            };

            log.debug({ peerId, subject: parsed.subject }, 'Inbound email received');

            void this._safeEmit('message:received', {
              channel: 'email',
              meta: { peerId },
            });

            await this._dispatch(unified);
          } catch (err) {
            log.error({ err: String(err) }, 'Error processing email message');
          }
        }
      }
    } catch (err) {
      if (this._isConnected) {
        log.error({ err: String(err) }, 'IMAP IDLE loop error');
      }
    }
  }

  private async _dispatch(msg: UnifiedMessage): Promise<void> {
    if (!this._handler) {
      log.warn({ peerId: msg.peerId }, 'No handler registered — email dropped');
      return;
    }
    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ peerId: msg.peerId, err: String(err) }, 'Email message handler error');
    }
  }
}
