/**
 * EmailClient — send email via nodemailer (SMTP / Gmail OAuth2).
 *
 * Configuration is read exclusively from environment variables so no
 * credentials live in source.  All methods degrade gracefully when SMTP
 * is not configured rather than throwing unhandled errors.
 *
 * Environment variables:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS  — generic SMTP
 *   SMTP_SECURE                                 — 'true' for TLS (default false)
 *   GMAIL_USER, GMAIL_APP_PASSWORD              — Gmail app-password fallback
 *   IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS — inbox search (optional)
 */

import nodemailer, { type Transporter, type SendMailOptions } from 'nodemailer';
import { createLogger } from '../shared/logger.js';
import { BusinessError } from '../shared/errors.js';

const log = createLogger('business');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendOptions {
  to: string | string[];
  subject: string;
  body: string;
  /** Optional HTML version; falls back to body as plain text. */
  html?: string;
  attachments?: Array<{ filename: string; path: string }>;
}

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function buildSmtpConfig(): nodemailer.TransportOptions | null {
  const host = process.env['SMTP_HOST'];
  const user = process.env['SMTP_USER'] ?? process.env['GMAIL_USER'];
  const pass = process.env['SMTP_PASS'] ?? process.env['GMAIL_APP_PASSWORD'];

  if (!user || !pass) {
    log.warn('EmailClient: no SMTP credentials configured — email disabled');
    return null;
  }

  const port = parseInt(process.env['SMTP_PORT'] ?? '587', 10);
  const secure = process.env['SMTP_SECURE'] === 'true';

  if (host) {
    return {
      host,
      port,
      secure,
      auth: { user, pass },
    } as nodemailer.TransportOptions;
  }

  // Gmail fallback
  return {
    service: 'gmail',
    auth: { user, pass },
  } as nodemailer.TransportOptions;
}

// ---------------------------------------------------------------------------
// EmailClient
// ---------------------------------------------------------------------------

export class EmailClient {
  private transporter: Transporter | null = null;
  private readonly fromAddress: string;
  private connected = false;

  constructor() {
    this.fromAddress =
      process.env['SMTP_USER'] ??
      process.env['GMAIL_USER'] ??
      'no-reply@sudo-ai.local';
  }

  /**
   * Verify SMTP connection.  Must be called before send() in production.
   * Returns false (does not throw) when credentials are absent.
   */
  async connect(): Promise<boolean> {
    const config = buildSmtpConfig();
    if (!config) {
      this.connected = false;
      return false;
    }

    try {
      this.transporter = nodemailer.createTransport(config);
      await this.transporter.verify();
      this.connected = true;
      log.info({ from: this.fromAddress }, 'EmailClient connected');
      return true;
    } catch (err) {
      log.error({ err }, 'EmailClient: SMTP verification failed');
      this.connected = false;
      this.transporter = null;
      return false;
    }
  }

  /**
   * Send an email.
   * @throws BusinessError if SMTP is not configured or send fails.
   */
  async send(options: SendOptions): Promise<string> {
    if (!options.to) throw new BusinessError('Recipient (to) is required', 'invalid_input');
    if (!options.subject?.trim()) throw new BusinessError('Subject is required', 'invalid_input');
    if (!options.body?.trim()) throw new BusinessError('Body is required', 'invalid_input');

    if (!this.transporter) {
      // Lazy connect on first send
      const ok = await this.connect();
      if (!ok) {
        throw new BusinessError(
          'Email not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS or GMAIL_USER/GMAIL_APP_PASSWORD',
          'not_configured',
        );
      }
    }

    const mailOptions: SendMailOptions = {
      from: this.fromAddress,
      to: Array.isArray(options.to) ? options.to.join(',') : options.to,
      subject: options.subject,
      text: options.body,
      html: options.html ?? undefined,
      attachments: options.attachments?.map((a) => ({
        filename: a.filename,
        path: a.path,
      })),
    };

    try {
      // transporter is guaranteed non-null here
      const info = await this.transporter!.sendMail(mailOptions);
      const messageId = String(info.messageId ?? '');
      log.info({ to: options.to, subject: options.subject, messageId }, 'Email sent');
      return messageId;
    } catch (err) {
      log.error({ err, to: options.to }, 'Email send failed');
      throw new BusinessError(
        `Email send failed: ${err instanceof Error ? err.message : String(err)}`,
        'send_failed',
        { to: options.to, subject: options.subject },
      );
    }
  }

  /**
   * Search the inbox via IMAP.
   * Returns an empty array when IMAP is not configured rather than throwing.
   *
   * NOTE: full IMAP support requires the `imapflow` package.  This
   * implementation returns a stub result and logs a warning if the env
   * variables are absent, keeping the module dependency-free for now.
   */
  async searchInbox(query: string, limit = 10): Promise<EmailMessage[]> {
    const imapHost = process.env['IMAP_HOST'];
    if (!imapHost) {
      log.warn({ query }, 'IMAP not configured — searchInbox returning empty');
      return [];
    }

    log.info({ query, limit, imapHost }, 'IMAP searchInbox stub — full implementation pending imapflow');
    return [];
  }

  /**
   * Return unread messages from inbox.
   * Returns empty array when IMAP is not configured.
   */
  async getUnread(limit = 20): Promise<EmailMessage[]> {
    return this.searchInbox('UNSEEN', limit);
  }

  /** Release the transporter connection pool. */
  async close(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
      this.connected = false;
      log.info('EmailClient closed');
    }
  }
}
