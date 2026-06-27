/**
 * @file telegram-media.ts
 * @description Pure helpers for turning a Telegram document/file upload into an
 * inbound message. Kept free of grammy/network deps so the empty-content bug fix
 * is unit-testable.
 *
 * Bug it fixes: the `message:document` handler passed the Telegram caption
 * straight through as the message text. A file sent WITHOUT a caption therefore
 * arrived as empty content ("whenever I send any file it isn't received") and,
 * unlike photos, the file was never downloaded. buildDocumentInbound now always
 * produces a non-empty text that names the file and where it was saved, and
 * inlines small text-like files so the agent sees their contents immediately.
 */

import type { MediaAttachment } from './types.js';

/** Only inline files up to this size as a text preview. */
export const DOC_PREVIEW_MAX_BYTES = 256 * 1024;
/** Cap the inlined preview so a big file can't dominate the turn. */
export const DOC_PREVIEW_MAX_CHARS = 8000;

/**
 * Whether a file's bytes are worth inlining as a UTF-8 text preview. Gated by
 * MIME type first, then a generous source/text extension allowlist (Telegram
 * often reports `application/octet-stream` for code files).
 */
export function isTextLikeFile(mimeType: string, filename: string): boolean {
  if (/^text\//i.test(mimeType)) return true;
  if (/(json|xml|csv|yaml|x-yaml|javascript|typescript|x-sh|x-python|markdown|x-www-form-urlencoded)/i.test(mimeType)) {
    return true;
  }
  return /\.(txt|md|markdown|json|jsonl|ndjson|csv|tsv|ya?ml|log|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|html?|css|scss|less|toml|ini|cfg|conf|env|xml|svg|tex|rst|diff|patch)$/i.test(filename);
}

/**
 * Build the inbound `{ text, media }` for a Telegram document. `text` is
 * GUARANTEED non-empty so a caption-less file is never delivered as empty
 * content. When the file was downloaded the path is surfaced (and added as the
 * attachment's `url`); small text-like files also get their contents inlined.
 */
export function buildDocumentInbound(opts: {
  caption: string;
  filename: string;
  mimeType: string;
  savedPath?: string;
  buffer?: Buffer;
}): { text: string; media: MediaAttachment[] } {
  const { caption, filename, mimeType, savedPath, buffer } = opts;

  const media: MediaAttachment[] = [{
    type: 'document',
    mimeType,
    filename,
    ...(savedPath ? { url: savedPath } : {}),
  }];

  let hint: string;
  if (savedPath) {
    if (buffer && isTextLikeFile(mimeType, filename) && buffer.length <= DOC_PREVIEW_MAX_BYTES) {
      const raw = buffer.toString('utf8');
      const body = raw.length > DOC_PREVIEW_MAX_CHARS
        ? `${raw.slice(0, DOC_PREVIEW_MAX_CHARS)}\n…[truncated ${raw.length - DOC_PREVIEW_MAX_CHARS} more chars — read the file at the path above for the rest]`
        : raw;
      hint = `[File received: "${filename}" (${mimeType}), saved at ${savedPath}. Contents below.]\n\n--- ${filename} ---\n${body}`;
    } else {
      hint = `[File received: "${filename}" (${mimeType}), saved at ${savedPath}. Read it from that path to see its contents.]`;
    }
  } else {
    hint = `[A file "${filename}" (${mimeType}) was sent but the download failed — ask the user to resend it.]`;
  }

  const text = caption.trim() ? `${caption.trim()}\n${hint}` : hint;
  return { text, media };
}

/** Telegram Bot API methods used for outbound media attachments. */
export type TelegramSendMethod = 'sendPhoto' | 'sendAnimation' | 'sendVideo' | 'sendAudio' | 'sendDocument';

/**
 * Choose the Telegram send method for an outbound attachment. GIFs arrive typed as
 * 'image' (they animate in an <img> on the web) but Telegram's sendPhoto flattens a
 * GIF to a static photo — they must go via sendAnimation to actually loop. Pure +
 * exported so the mapping is unit-tested without a live bot.
 */
export function pickTelegramSendMethod(type: string, filename?: string): TelegramSendMethod {
  const name = (filename ?? '').toLowerCase();
  if (type === 'image') return name.endsWith('.gif') ? 'sendAnimation' : 'sendPhoto';
  if (type === 'video') return 'sendVideo';
  if (type === 'audio') return 'sendAudio';
  return 'sendDocument';
}
