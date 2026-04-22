/**
 * telegram-push.ts
 * Sends a message to a Telegram chat via Bot API.
 * Fail-open: never throws, always returns structured result.
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 10_000;

export interface TelegramSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Send a message to a Telegram chat.
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from environment.
 * If either is unset, returns {ok: false} without attempting network call.
 *
 * @param text - The message text to send.
 * @param opts - Optional parse_mode override (default: 'MarkdownV2').
 * @returns Structured result — never throws.
 */
export async function sendTelegramMessage(
  text: string,
  opts?: { parseMode?: 'MarkdownV2' | 'HTML' },
): Promise<TelegramSendResult> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CHAT_ID'];

  if (!token || !chatId) {
    return { ok: false, error: 'TELEGRAM_*_not_configured' };
  }

  if (!text || typeof text !== 'string') {
    return { ok: false, error: 'text_must_be_non_empty_string' };
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: opts?.parseMode ?? 'MarkdownV2',
  });

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutHandle);

    if (!response.ok) {
      let detail = '';
      try {
        const payload = (await response.json()) as { description?: string };
        detail = payload.description ?? String(response.status);
      } catch {
        detail = String(response.status);
      }
      return { ok: false, error: `telegram_api_error: ${detail}` };
    }

    return { ok: true };
  } catch (err: unknown) {
    clearTimeout(timeoutHandle);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('AbortError')) {
      return { ok: false, error: 'telegram_request_timeout' };
    }
    return { ok: false, error: `telegram_network_error: ${msg.slice(0, 120)}` };
  }
}
