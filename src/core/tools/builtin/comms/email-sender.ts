/**
 * comms.email — Send emails via SMTP using nodemailer.
 *
 * Configuration (env vars, in priority order):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS  — explicit SMTP server
 *   GMAIL_USER, GMAIL_APP_PASSWORD               — Gmail shortcut (falls back)
 *
 * Returns: { messageId, accepted } on success.
 */

import nodemailer from 'nodemailer';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { isCommsIdempotencyEnabled, getCommsIdempotencyStore } from '../../../comms/idempotency.js';

const log = createLogger('comms:email');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Attachment {
  filename: string;
  path: string;
}

function buildTransport(): nodemailer.Transporter | null {
  const host = process.env['SMTP_HOST'];
  const port = process.env['SMTP_PORT'];
  const user = process.env['SMTP_USER'];
  const pass = process.env['SMTP_PASS'];

  if (host && user && pass) {
    return nodemailer.createTransport({
      host,
      port: port ? parseInt(port, 10) : 587,
      secure: port === '465',
      auth: { user, pass },
    });
  }

  const gmailUser = process.env['GMAIL_USER'];
  const gmailPass = process.env['GMAIL_APP_PASSWORD'];

  if (gmailUser && gmailPass) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });
  }

  return null;
}

function validateEmail(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const emailTool: ToolDefinition = {
  name: 'comms.email',
  description:
    'Send an email via SMTP. Supports plain-text and HTML bodies, optional file attachments. ' +
    'Reads SMTP credentials from env: SMTP_HOST/PORT/USER/PASS or GMAIL_USER/GMAIL_APP_PASSWORD.',
  category: 'comms',
  timeout: 30_000,
  requiresConfirmation: false,
  parameters: {
    to: {
      type: 'string',
      required: true,
      description: 'Recipient email address (single address).',
    },
    subject: {
      type: 'string',
      required: true,
      description: 'Email subject line.',
    },
    body: {
      type: 'string',
      required: true,
      description: 'Plain-text body of the email.',
    },
    html: {
      type: 'string',
      required: false,
      description: 'Optional HTML body. When provided, both text and HTML parts are sent.',
    },
    attachments: {
      type: 'array',
      required: false,
      description: 'Optional array of file attachments, each with filename and path.',
      items: {
        type: 'object',
        description: 'Single attachment descriptor.',
        properties: {
          filename: { type: 'string', description: 'Display filename for the attachment.' },
          path: { type: 'string', description: 'Absolute path to the file on disk.' },
        },
      },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const to = typeof params['to'] === 'string' ? params['to'].trim() : '';
    const subject = typeof params['subject'] === 'string' ? params['subject'].trim() : '';
    const body = typeof params['body'] === 'string' ? params['body'] : '';

    if (!to) {
      return { success: false, output: 'comms.email: "to" is required.' };
    }
    if (!validateEmail(to)) {
      return { success: false, output: `comms.email: invalid email address: "${to}".` };
    }
    if (!subject) {
      return { success: false, output: 'comms.email: "subject" is required.' };
    }
    if (!body) {
      return { success: false, output: 'comms.email: "body" is required.' };
    }

    const transport = buildTransport();
    if (!transport) {
      log.error({ sessionId: ctx.sessionId }, 'No SMTP credentials configured');
      return {
        success: false,
        output:
          'comms.email: No SMTP configuration found. ' +
          'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS or GMAIL_USER/GMAIL_APP_PASSWORD.',
      };
    }

    const rawAttachments = Array.isArray(params['attachments']) ? params['attachments'] : [];
    const attachments: Attachment[] = rawAttachments
      .filter(
        (a): a is Record<string, unknown> => typeof a === 'object' && a !== null,
      )
      .map((a) => ({
        filename: typeof a['filename'] === 'string' ? a['filename'] : 'attachment',
        path: typeof a['path'] === 'string' ? a['path'] : '',
      }))
      .filter((a) => a.path !== '');

    const html = typeof params['html'] === 'string' ? params['html'] : undefined;

    // Idempotency guard (opt-in): never re-send an identical email to the same
    // recipient on a task re-dispatch within the dedup window.
    const idemOn = isCommsIdempotencyEnabled();
    let idemKey: string | undefined;
    if (idemOn) {
      const claim = getCommsIdempotencyStore().begin({ channel: 'email', recipient: to, body: `${subject}\n${body}` });
      idemKey = claim.key;
      if (claim.duplicate) {
        log.warn({ sessionId: ctx.sessionId, to, key: idemKey }, 'comms.email: duplicate suppressed (idempotency)');
        const priorNote = claim.messageId ? ` Prior message ID: ${claim.messageId}.` : '';
        return {
          success: true,
          output: `comms.email: duplicate suppressed — an identical email to ${to} was already sent within the idempotency window.${priorNote}`,
          data: { to, duplicate: true, messageId: claim.messageId },
        };
      }
    }

    try {
      const info = await transport.sendMail({
        to,
        subject,
        text: body,
        ...(html ? { html } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (idemOn && idemKey) getCommsIdempotencyStore().confirm(idemKey, info.messageId);

      log.info(
        { sessionId: ctx.sessionId, to, messageId: info.messageId, accepted: info.accepted },
        'Email sent',
      );

      return {
        success: true,
        output: `Email sent to ${to}. Message ID: ${info.messageId}`,
        data: {
          messageId: info.messageId,
          accepted: info.accepted,
          rejected: info.rejected,
        },
      };
    } catch (err) {
      if (idemOn && idemKey) getCommsIdempotencyStore().release(idemKey); // allow retry of a genuine failure
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId: ctx.sessionId, to, err }, 'Failed to send email');
      return { success: false, output: `comms.email error: ${msg}` };
    }
  },
};

export default emailTool;
