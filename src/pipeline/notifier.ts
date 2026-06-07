/**
 * @file notifier.ts
 * Sends pipeline status updates to a Telegram chat via the Bot API.
 * All errors are caught internally — notifications are fire-and-forget and
 * NEVER block or throw into the calling pipeline stage.
 *
 * Env vars required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

import { createLogger } from '../core/shared/logger.js';
import { retry } from '../core/shared/utils.js';
import type { NotificationPayload, BatchResult } from './types.js';

const log = createLogger('pipeline:notifier');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4_096; // Telegram hard limit

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to Telegram's hard message length limit.
 */
function truncateMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.slice(0, MAX_MESSAGE_LENGTH - 3) + '...';
}

/**
 * Escape characters that are significant to Telegram's HTML parse mode so that
 * dynamic content (URLs, error messages) cannot produce invalid HTML and
 * trigger a 400 from the Bot API. Per the Telegram Bot API, '&', '<' and '>'
 * must be replaced with the corresponding HTML entities.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Format a NotificationPayload into a human-readable HTML Telegram message.
 */
function formatMessage(payload: NotificationPayload): string {
  const details = payload.details ?? {};

  switch (payload.type) {
    case 'batch_start': {
      const n = typeof details['videoCount'] === 'number' ? details['videoCount'] : '?';
      return `🎬 <b>Batch ${payload.batchId} started</b>\nProducing ${String(n)} videos.`;
    }

    case 'video_complete': {
      const url = typeof details['youtubeUrl'] === 'string' ? details['youtubeUrl'] : '#';
      const safeUrl = escapeHtml(url);
      const cost =
        typeof details['costUsd'] === 'number' ? details['costUsd'].toFixed(4) : '?.????';
      return (
        `✅ <b>Video uploaded</b>\n` +
        `<a href="${safeUrl}">${safeUrl}</a>\n` +
        `Cost: $${cost}`
      );
    }

    case 'video_failed': {
      const errMsg = typeof details['error'] === 'string' ? details['error'] : payload.message;
      return `❌ <b>Video FAILED</b>\n<code>${escapeHtml(errMsg.slice(0, 500))}</code>`;
    }

    case 'batch_complete': {
      const successful = typeof details['successful'] === 'number' ? details['successful'] : 0;
      const total = typeof details['total'] === 'number' ? details['total'] : 0;
      const cost =
        typeof details['costUsd'] === 'number' ? details['costUsd'].toFixed(4) : '?.????';
      return (
        `📊 <b>Batch ${payload.batchId} complete</b>\n` +
        `${String(successful)}/${String(total)} successful\n` +
        `Total cost: $${cost}`
      );
    }

    case 'daily_summary': {
      const total = typeof details['total'] === 'number' ? details['total'] : 0;
      const success = typeof details['success'] === 'number' ? details['success'] : 0;
      const cost =
        typeof details['costUsd'] === 'number' ? details['costUsd'].toFixed(4) : '?.????';
      return (
        `📈 <b>Daily Summary</b>\n` +
        `Videos produced: ${String(total)}\n` +
        `Uploaded: ${String(success)}\n` +
        `Total cost: $${cost}`
      );
    }

    default: {
      return `ℹ️ <b>${escapeHtml(payload.type)}</b>\n${escapeHtml(payload.message)}`;
    }
  }
}

/**
 * Dispatch a single message to Telegram. Retries 3 times on transient errors.
 * Does not throw — all errors are logged and swallowed.
 */
async function dispatch(text: string): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CHAT_ID'];

  if (!token || !chatId) {
    log.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — notification skipped');
    return;
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text: truncateMessage(text),
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });

  try {
    await retry(
      async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        if (!res.ok) {
          const errText = await res.text();
          // 4xx errors (bad request, forbidden) are not worth retrying
          if (res.status >= 400 && res.status < 500) {
            log.error(
              { status: res.status, response: errText.slice(0, 200) },
              'Telegram API client error — not retrying',
            );
            return; // swallow
          }
          throw new Error(`Telegram API HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }

        log.debug('Telegram notification sent');
      },
      3,
      [1_000, 3_000, 7_000],
    );
  } catch (err) {
    // Swallow all errors — notifications must never block the pipeline
    log.error({ err }, 'Telegram notification failed after retries — suppressed');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a structured pipeline status notification to Telegram.
 * Fire-and-forget: errors are caught and logged; this function never throws.
 *
 * @param payload - Notification payload describing the pipeline event.
 */
export async function sendNotification(payload: NotificationPayload): Promise<void> {
  log.info({ type: payload.type, batchId: payload.batchId }, 'Sending notification');

  const text = formatMessage(payload);
  await dispatch(text);
}

/**
 * Aggregate all batch results into a single daily summary and send it.
 * Fire-and-forget: errors are caught and logged; this function never throws.
 *
 * @param batches - Array of completed BatchResult objects from the day.
 */
export async function sendDailySummary(batches: BatchResult[]): Promise<void> {
  log.info({ batchCount: batches.length }, 'Sending daily summary notification');

  const total = batches.reduce((sum, b) => sum + b.videos.length, 0);
  const success = batches.reduce(
    (sum, b) => sum + b.videos.filter((v) => v.status === 'complete').length,
    0,
  );
  const costUsd = batches.reduce((sum, b) => sum + b.totalCostUsd, 0);

  const payload: NotificationPayload = {
    type: 'daily_summary',
    batchId: 'daily',
    message: `Daily summary: ${String(total)} videos, ${String(success)} uploaded`,
    details: { total, success, costUsd },
  };

  const text = formatMessage(payload);
  await dispatch(text);
}
